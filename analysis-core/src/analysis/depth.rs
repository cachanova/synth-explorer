use super::{ApiNodeKind, DelayBreakdown, EndpointKind, NodeRef};
use crate::delay_model::DelayModel;
use crate::graph::{
    Edge, Graph, NodeId, NodeKind, cell_depth_weight, is_addressable_sequential_type,
    is_register_type, is_transparent_data_buffer,
};
use crate::netlist::PortDirection;
use std::collections::{HashSet, VecDeque};

/// Picosecond accumulator used while walking the delay-critical path.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct DelayBreakdownPs {
    pub(super) launch: f64,
    pub(super) logic: f64,
    pub(super) net: f64,
    pub(super) setup: f64,
}

impl DelayBreakdown {
    pub(super) fn from_ps(ps: DelayBreakdownPs) -> Self {
        Self {
            launch_ns: ps.launch / 1000.0,
            logic_ns: ps.logic / 1000.0,
            net_ns: ps.net / 1000.0,
            setup_ns: ps.setup / 1000.0,
        }
    }
}
pub(super) struct DepthComputation {
    pub(super) node_depth: Vec<Option<u32>>,
    pub(super) best_pred: Vec<Option<usize>>,
    pub(super) delay_pred: Vec<Option<usize>>,
    pub(super) node_startpoint: Vec<Option<NodeId>>,
    pub(super) delay_startpoint: Vec<Option<NodeId>>,
    /// Estimated worst-case combinational delay (picoseconds) over all paths —
    /// a rough pre-place-and-route figure from the fanout-aware delay model.
    pub(super) estimated_max_delay_ps: Option<f64>,
    /// The critical path's delay split into launch/logic/net/setup (picoseconds).
    pub(super) estimated_max_delay_breakdown: Option<DelayBreakdownPs>,
    /// Domain of the same delay-critical path. Kept with the overview result so
    /// callers do not have to infer it from the bounded, depth-sorted path list.
    pub(super) estimated_max_delay_starts_at_register: Option<bool>,
    pub(super) estimated_max_delay_endpoint_kind: Option<EndpointKind>,
    /// Per-node arrival time (picoseconds) at each comb node's output, for
    /// reconstructing a specific path's estimated delay.
    pub(super) node_delay: Vec<f64>,
    /// Arrival following the structural predecessor, for costing depth paths.
    pub(super) depth_path_delay: Vec<f64>,
}
pub fn node_ref(graph: &Graph, id: NodeId) -> NodeRef {
    let node = &graph.nodes[id as usize];
    let kind = match node.kind {
        NodeKind::Cell => ApiNodeKind::Cell,
        NodeKind::PortBit => ApiNodeKind::Port,
        NodeKind::Const => ApiNodeKind::Const,
    };
    NodeRef {
        id,
        kind,
        name: node.name.clone(),
        port_direction: node.port_dir,
        cell_type: node.cell_type.clone(),
        seq: (node.kind == NodeKind::Cell && node.seq).then_some(node.seq),
        register: (node.kind == NodeKind::Cell && node.seq).then_some(is_register_node(node)),
        src: node.src.clone(),
    }
}

pub(super) fn is_register_node(node: &crate::graph::Node) -> bool {
    node.kind == NodeKind::Cell
        && node.seq
        && !node.blackbox
        && node.cell_type.as_deref().is_some_and(is_register_type)
}

pub(super) fn find_comb_loops(graph: &Graph) -> Vec<NodeId> {
    struct Frame {
        node: NodeId,
        next_edge: usize,
    }

    let mut index = 0;
    let mut indices = vec![None; graph.nodes.len()];
    let mut lowlink = vec![0; graph.nodes.len()];
    let mut stack = Vec::new();
    let mut on_stack = vec![false; graph.nodes.len()];
    let mut loops = HashSet::new();

    for start in &graph.nodes {
        if !is_depth_node(graph, start.id) || indices[start.id as usize].is_some() {
            continue;
        }

        indices[start.id as usize] = Some(index);
        lowlink[start.id as usize] = index;
        index += 1;
        stack.push(start.id);
        on_stack[start.id as usize] = true;
        let mut frames = vec![Frame {
            node: start.id,
            next_edge: 0,
        }];

        while let Some(frame) = frames.last_mut() {
            let node = frame.node;
            if frame.next_edge < graph.outgoing[node as usize].len() {
                let edge_idx = graph.outgoing[node as usize][frame.next_edge];
                frame.next_edge += 1;
                let next = graph.edges[edge_idx].to;
                if !is_depth_node(graph, next)
                    || !is_depth_output_edge(graph, &graph.edges[edge_idx])
                    || !is_depth_input_edge(graph, &graph.edges[edge_idx])
                {
                    continue;
                }
                if indices[next as usize].is_none() {
                    indices[next as usize] = Some(index);
                    lowlink[next as usize] = index;
                    index += 1;
                    stack.push(next);
                    on_stack[next as usize] = true;
                    frames.push(Frame {
                        node: next,
                        next_edge: 0,
                    });
                } else if on_stack[next as usize] {
                    lowlink[node as usize] =
                        lowlink[node as usize].min(indices[next as usize].unwrap_or(0));
                }
                continue;
            }

            let node = frames.pop().map(|frame| frame.node).unwrap_or(node);
            if lowlink[node as usize] == indices[node as usize].unwrap_or(usize::MAX) {
                let mut component = Vec::new();
                while let Some(member) = stack.pop() {
                    on_stack[member as usize] = false;
                    component.push(member);
                    if member == node {
                        break;
                    }
                }
                let self_loop = component.len() == 1
                    && graph.outgoing[component[0] as usize]
                        .iter()
                        .any(|edge_idx| {
                            let edge = &graph.edges[*edge_idx];
                            edge.to == component[0]
                                && is_depth_output_edge(graph, edge)
                                && is_depth_input_edge(graph, edge)
                        });
                if component.len() > 1 || self_loop {
                    loops.extend(component);
                }
            }
            if let Some(parent) = frames.last() {
                lowlink[parent.node as usize] =
                    lowlink[parent.node as usize].min(lowlink[node as usize]);
            }
        }
    }
    let mut loops: Vec<NodeId> = loops.into_iter().collect();
    loops.sort_unstable();
    loops
}

pub(super) fn compute_depths(
    graph: &Graph,
    loop_set: &HashSet<NodeId>,
    model: &DelayModel,
) -> DepthComputation {
    let mut indegree = vec![0usize; graph.nodes.len()];
    for edge in &graph.edges {
        if is_depth_node(graph, edge.from)
            && is_depth_node(graph, edge.to)
            && is_depth_output_edge(graph, edge)
            && is_depth_input_edge(graph, edge)
            && !loop_set.contains(&edge.from)
            && !loop_set.contains(&edge.to)
        {
            indegree[edge.to as usize] += 1;
        }
    }

    let mut queue = VecDeque::new();
    for node in &graph.nodes {
        if is_depth_node(graph, node.id)
            && !loop_set.contains(&node.id)
            && indegree[node.id as usize] == 0
        {
            queue.push_back(node.id);
        }
    }

    let mut depth = vec![None; graph.nodes.len()];
    let mut best_pred = vec![None; graph.nodes.len()];
    let mut delay_pred = vec![None; graph.nodes.len()];
    let mut startpoint = vec![None; graph.nodes.len()];
    let mut delay_startpoint = vec![None; graph.nodes.len()];
    // Parallel delay-weighted longest path (picoseconds); see delay_model.
    let mut node_delay = vec![0.0f64; graph.nodes.len()];
    let mut depth_path_delay = vec![0.0f64; graph.nodes.len()];
    // Breakdown of that arrival (launch/logic/net) along the delay-max path.
    let mut node_breakdown = vec![DelayBreakdownPs::default(); graph.nodes.len()];

    while let Some(id) = queue.pop_front() {
        let cell = graph.nodes[id as usize].cell_type.as_deref();
        let weight = cell.map(cell_depth_weight).unwrap_or(1);
        let mut best: Option<(u32, usize, NodeId)> = None;
        let mut best_delay: Option<(f64, usize, NodeId)> = None;
        let mut best_bd = DelayBreakdownPs::default();
        for edge_idx in &graph.incoming[id as usize] {
            let edge = &graph.edges[*edge_idx];
            if loop_set.contains(&edge.from) || !is_depth_input_edge(graph, edge) {
                continue;
            }
            let follows_depth =
                is_depth_node(graph, edge.from) && is_depth_output_edge(graph, edge);
            let base = if follows_depth {
                depth[edge.from as usize].unwrap_or(0)
            } else {
                0
            };
            let candidate = base + weight;
            let origin = if follows_depth {
                startpoint[edge.from as usize].unwrap_or(edge.from)
            } else {
                edge.from
            };
            if best.is_none_or(|(current, _, _)| candidate > current) {
                best = Some((candidate, *edge_idx, origin));
            }
            // A path either continues from an upstream comb node's arrival time
            // or is launched here by a register (clk-to-Q) / input (zero).
            let (base_delay, base_bd) = if follows_depth {
                (
                    node_delay[edge.from as usize],
                    node_breakdown[edge.from as usize],
                )
            } else {
                let launch = model.launch_ps(graph.nodes[edge.from as usize].seq);
                (
                    launch,
                    DelayBreakdownPs {
                        launch,
                        ..Default::default()
                    },
                )
            };
            let delay_origin = if follows_depth {
                delay_startpoint[edge.from as usize].unwrap_or(edge.from)
            } else {
                edge.from
            };
            // The sink is `id`; a connection into a carry chain is dedicated.
            let net = model.net_delay_to_ps(
                graph.nodes[id as usize].cell_type.as_deref(),
                fanout_of(graph, edge.from),
            );
            let candidate_delay = base_delay + net;
            if best_delay.is_none_or(|(current, _, _)| candidate_delay > current) {
                best_delay = Some((candidate_delay, *edge_idx, delay_origin));
                best_bd = base_bd;
                best_bd.net += net;
            }
        }
        let (node_depth, pred, origin) = best.unwrap_or((weight, usize::MAX, id));
        depth[id as usize] = Some(node_depth);
        startpoint[id as usize] = Some(origin);
        let cell_ps = cell
            .map(|cell_type| model.cell_delay_ps(cell_type))
            .unwrap_or(model.cell_ps);
        let depth_base = if pred == usize::MAX {
            0.0
        } else {
            let edge = &graph.edges[pred];
            let follows_depth =
                is_depth_node(graph, edge.from) && is_depth_output_edge(graph, edge);
            let base = if follows_depth {
                depth_path_delay[edge.from as usize]
            } else {
                model.launch_ps(graph.nodes[edge.from as usize].seq)
            };
            base + model.net_delay_to_ps(cell, fanout_of(graph, edge.from))
        };
        depth_path_delay[id as usize] = depth_base + cell_ps;
        let (best_delay, delay_edge, delay_origin) = best_delay.unwrap_or((0.0, usize::MAX, id));
        node_delay[id as usize] = best_delay + cell_ps;
        best_bd.logic += cell_ps;
        node_breakdown[id as usize] = best_bd;
        delay_startpoint[id as usize] = Some(delay_origin);
        if pred != usize::MAX {
            best_pred[id as usize] = Some(pred);
        }
        if delay_edge != usize::MAX {
            delay_pred[id as usize] = Some(delay_edge);
        }

        for edge_idx in &graph.outgoing[id as usize] {
            let edge = &graph.edges[*edge_idx];
            let next = edge.to;
            if is_depth_node(graph, next)
                && is_depth_output_edge(graph, edge)
                && is_depth_input_edge(graph, edge)
                && !loop_set.contains(&next)
            {
                indegree[next as usize] = indegree[next as usize].saturating_sub(1);
                if indegree[next as usize] == 0 {
                    queue.push_back(next);
                }
            }
        }
    }

    // Worst arrival at a data sink, plus the driver's output net and the
    // capturing register's setup — the estimated critical path. Every timing
    // path ends at a data sink; scoring the sinks rather than every node keeps
    // the clock tree and dangling logic out of the estimate.
    let mut best_arrival: Option<(f64, bool)> = None;
    let mut best_arrival_bd: Option<DelayBreakdownPs> = None;
    let mut best_arrival_starts_at_register = None;
    let mut best_arrival_endpoint_kind = None;
    for edge in &graph.edges {
        if !is_data_sink_edge(graph, edge) || loop_set.contains(&edge.from) {
            continue;
        }
        let from = edge.from;
        let (base_delay, base_bd) =
            if is_depth_node(graph, from) && is_depth_output_edge(graph, edge) {
                // Unreached (or clock-network) driver: no data arrival to score.
                if depth[from as usize].is_none() {
                    continue;
                }
                (node_delay[from as usize], node_breakdown[from as usize])
            } else if graph.nodes[from as usize].kind == NodeKind::Const {
                // A constant tied to a data pin is not a timing path.
                continue;
            } else {
                // A register drives the sink directly: it launches its own path
                // (clk-to-Q) with zero logic levels. A top-level input starts at
                // zero. Without this a purely register-to-register design — no
                // combinational cells at all — would report no estimate.
                let launch = model.launch_ps(graph.nodes[from as usize].seq);
                (
                    launch,
                    DelayBreakdownPs {
                        launch,
                        ..Default::default()
                    },
                )
            };
        let net = model.net_delay_ps(fanout_of(graph, from));
        let arrival = base_delay + net;
        let endpoint_is_register = graph.nodes[edge.to as usize].seq;
        let candidate = arrival
            + if endpoint_is_register {
                model.ff_setup_ps
            } else {
                0.0
            };
        if best_arrival.is_none_or(|(current, _)| candidate > current) {
            best_arrival = Some((candidate, endpoint_is_register));
            let mut bd = base_bd;
            bd.net += net;
            best_arrival_bd = Some(bd);
            let origin = if is_depth_node(graph, from) && is_depth_output_edge(graph, edge) {
                startpoint[from as usize].unwrap_or(from)
            } else {
                from
            };
            best_arrival_starts_at_register = Some(
                graph
                    .nodes
                    .get(origin as usize)
                    .is_some_and(|node| node.seq),
            );
            best_arrival_endpoint_kind = Some(match graph.nodes[edge.to as usize].kind {
                NodeKind::PortBit => EndpointKind::Output,
                NodeKind::Cell => EndpointKind::Register,
                NodeKind::Const => unreachable!("a constant cannot be a data sink"),
            });
        }
    }
    let estimated_max_delay_ps = best_arrival.map(|(delay, _)| delay);
    let estimated_max_delay_breakdown = best_arrival_bd.map(|mut bd| {
        bd.setup = if best_arrival.is_some_and(|(_, register)| register) {
            model.ff_setup_ps
        } else {
            0.0
        };
        bd
    });

    DepthComputation {
        node_depth: depth,
        best_pred,
        delay_pred,
        node_startpoint: startpoint,
        delay_startpoint,
        estimated_max_delay_ps,
        estimated_max_delay_breakdown,
        estimated_max_delay_starts_at_register: best_arrival_starts_at_register,
        estimated_max_delay_endpoint_kind: best_arrival_endpoint_kind,
        node_delay,
        depth_path_delay,
    }
}

/// Number of sinks a node's output drives — the fanout used by the net-delay
/// estimate.
pub(super) fn fanout_of(graph: &Graph, id: NodeId) -> u32 {
    graph.outgoing[id as usize].len() as u32
}

pub(super) fn is_addressable_sequential_node(graph: &Graph, id: NodeId) -> bool {
    graph.nodes.get(id as usize).is_some_and(|node| {
        node.cell_type
            .as_deref()
            .is_some_and(is_addressable_sequential_type)
    })
}

pub(super) fn is_depth_node(graph: &Graph, id: NodeId) -> bool {
    // The clock network reaches nothing but register clock pins. It is not
    // data, so it carries neither logical depth nor a data arrival time.
    if graph.is_clock_network(id) {
        return false;
    }
    graph.is_comb(id) || is_addressable_sequential_node(graph, id)
}

/// Whether an edge lands on a sink that *closes* a timing path: a storage
/// cell's data pin (which imposes setup) or a top-level output port.
///
/// Combinational fanout does not close a path — it continues into the next
/// cell, which is scored on its own. Neither does a control pin, matching the
/// endpoints the rest of the analysis reports (see `endpoint_data_edges`).
/// Without this test every combinational node is an endpoint "just because it
/// exists", which is what charges a register setup onto a clock buffer.
pub(super) fn is_data_sink_edge(graph: &Graph, edge: &Edge) -> bool {
    if edge.control {
        return false;
    }
    let Some(sink) = graph.nodes.get(edge.to as usize) else {
        return false;
    };
    match sink.kind {
        NodeKind::PortBit => {
            matches!(
                sink.port_dir,
                Some(PortDirection::Output | PortDirection::Inout)
            )
            // A directly-registered output is reported as an alias of the
            // register group rather than as an endpoint of its own (see
            // `discover_endpoints`), so it closes no path here either — the
            // driving register's own `D` endpoint already carries its timing.
            // Scoring it as well would put a figure in the overview that no
            // reported path can explain.
            && direct_register_driver(graph, sink.id).is_none()
        }
        // An addressable sequential's `A*` select pins feed its output
        // combinationally, so they continue the path rather than ending it.
        NodeKind::Cell => {
            sink.seq
                && (!is_addressable_sequential_node(graph, edge.to)
                    || !is_depth_input_edge(graph, edge))
        }
        NodeKind::Const => false,
    }
}

pub(super) fn is_depth_input_edge(graph: &Graph, edge: &Edge) -> bool {
    if !is_addressable_sequential_node(graph, edge.to) {
        return true;
    }
    edge.to_port
        .strip_prefix('A')
        .is_some_and(|suffix| suffix.chars().all(|ch| ch.is_ascii_digit()))
}

pub(super) fn is_depth_output_edge(graph: &Graph, edge: &Edge) -> bool {
    if !is_addressable_sequential_node(graph, edge.from) {
        return true;
    }
    let fixed_tap = graph.nodes[edge.from as usize]
        .cell_type
        .as_deref()
        .is_some_and(|cell_type| cell_type.eq_ignore_ascii_case("SRLC32E"))
        && edge.from_port.eq_ignore_ascii_case("Q31");
    !fixed_tap
}
pub(super) fn edge_depth(graph: &Graph, node_depth: &[Option<u32>], edge_idx: usize) -> u32 {
    let pred = graph.edges[edge_idx].from;
    if is_depth_node(graph, pred) && is_depth_output_edge(graph, &graph.edges[edge_idx]) {
        node_depth[pred as usize].unwrap_or(0)
    } else {
        0
    }
}

/// Follow a top-level output backwards through unconditional, zero-depth data
/// buffers. Returns the driving register and the register-side net bit only
/// when there is exactly one data predecessor at every step.
pub(super) fn direct_register_driver(
    graph: &Graph,
    output: NodeId,
) -> Option<(NodeId, Option<u32>)> {
    let mut current = output;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        let mut incoming = graph.incoming[current as usize]
            .iter()
            .copied()
            .filter(|idx| !graph.edges[*idx].control);
        let edge_idx = incoming.next()?;
        if incoming.next().is_some() {
            return None;
        }
        let edge = &graph.edges[edge_idx];
        let driver = graph.nodes.get(edge.from as usize)?;
        if is_register_node(driver) {
            return Some((driver.id, edge.bit));
        }
        let transparent = driver
            .cell_type
            .as_deref()
            .is_some_and(is_transparent_data_buffer);
        if driver.kind != NodeKind::Cell || !transparent {
            return None;
        }
        current = driver.id;
    }
    None
}
