use crate::graph::{Edge, Graph, NodeId, NodeKind, is_data_pin, strip_bit_suffix};
use crate::netlist::PortDirection;
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiNodeKind {
    Cell,
    Port,
    Const,
}

#[derive(Debug, Clone, Serialize)]
pub struct NodeRef {
    pub id: u32,
    pub kind: ApiNodeKind,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    #[serde(flatten)]
    pub node: NodeRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_root: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_boundary: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub from: u32,
    pub to: u32,
    pub from_port: String,
    pub to_port: String,
    pub net_name: String,
    pub bits: Vec<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Subgraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EndpointBit {
    pub bit: usize,
    pub node_id: u32,
    pub depth: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct InputBit {
    pub bit: usize,
    pub node_id: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegisterGroup {
    pub name: String,
    pub width: usize,
    pub cell_type: String,
    pub clock: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    pub worst_depth: u32,
    pub bits: Vec<EndpointBit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputGroup {
    pub name: String,
    pub width: usize,
    pub worst_depth: u32,
    pub bits: Vec<EndpointBit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InputGroup {
    pub name: String,
    pub width: usize,
    pub bits: Vec<InputBit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EndpointsResponse {
    pub registers: Vec<RegisterGroup>,
    pub outputs: Vec<OutputGroup>,
    pub inputs: Vec<InputGroup>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PathEntry {
    pub depth: u32,
    pub startpoint: NodeRef,
    pub endpoint: NodeRef,
    pub endpoint_port: String,
    pub nodes: Vec<NodeRef>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PathsResponse {
    pub paths: Vec<PathEntry>,
    pub comb_loops: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FanoutDriver {
    pub driver: NodeRef,
    pub port: String,
    pub net_name: String,
    pub fanout: usize,
    pub endpoints: usize,
    pub control: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FanoutResponse {
    pub drivers: Vec<FanoutDriver>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceMapResponse {
    pub files: Vec<String>,
    pub by_line: BTreeMap<String, Vec<u32>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub num_cells: usize,
    pub cells_by_type: BTreeMap<String, usize>,
    pub num_register_bits: usize,
    pub num_register_groups: usize,
    pub num_inputs: usize,
    pub num_outputs: usize,
    pub max_depth: u32,
}

#[derive(Debug, Clone)]
pub struct Analysis {
    pub node_depth: Vec<Option<u32>>,
    pub best_pred: Vec<Option<usize>>,
    pub comb_loops: Vec<NodeId>,
    pub endpoints: EndpointsResponse,
    endpoint_targets: Vec<EndpointTarget>,
    source_map: SourceMapResponse,
    stats: Stats,
    warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct EndpointTarget {
    endpoint: NodeId,
    endpoint_port: String,
    edge: Option<usize>,
    depth: u32,
}

impl Analysis {
    pub fn new(graph: &Graph, source_files: Vec<String>) -> Self {
        let comb_loops = find_comb_loops(graph);
        let loop_set: HashSet<NodeId> = comb_loops.iter().copied().collect();
        let (node_depth, best_pred) = compute_depths(graph, &loop_set);
        let (endpoints, endpoint_targets) = discover_endpoints(graph, &node_depth);
        let source_map = build_source_map(graph, source_files);
        let stats = build_stats(graph, &endpoints);
        let warnings = build_warnings(graph, &comb_loops);
        Self {
            node_depth,
            best_pred,
            comb_loops,
            endpoints,
            endpoint_targets,
            source_map,
            stats,
            warnings,
        }
    }

    pub fn endpoints(&self) -> EndpointsResponse {
        self.endpoints.clone()
    }

    pub fn stats(&self) -> Stats {
        self.stats.clone()
    }

    pub fn warnings(&self) -> Vec<String> {
        self.warnings.clone()
    }

    pub fn source_map(&self) -> SourceMapResponse {
        self.source_map.clone()
    }

    pub fn paths(&self, graph: &Graph, limit: usize, to: Option<NodeId>) -> PathsResponse {
        let mut targets: Vec<&EndpointTarget> = self
            .endpoint_targets
            .iter()
            .filter(|target| to.is_none_or(|id| target.endpoint == id))
            .collect();
        targets.sort_by_key(|target| {
            (
                Reverse(target.depth),
                target.endpoint,
                target.endpoint_port.clone(),
            )
        });
        targets.truncate(limit);
        let paths = targets
            .into_iter()
            .map(|target| self.path_for_target(graph, target))
            .collect();
        PathsResponse {
            paths,
            comb_loops: self
                .comb_loops
                .iter()
                .map(|id| graph.node_ref_name(*id))
                .collect(),
        }
    }

    pub fn cone(&self, graph: &Graph, root: NodeId, options: ConeOptions) -> Option<Subgraph> {
        graph.nodes.get(root as usize)?;
        let cap = options.max_nodes.clamp(1, 2000);
        let mut seen: HashSet<NodeId> = HashSet::new();
        let mut distances: HashMap<NodeId, u32> = HashMap::new();
        let mut boundary_nodes: HashSet<NodeId> = HashSet::new();
        let mut edge_set: HashSet<usize> = HashSet::new();
        let mut queue = VecDeque::new();
        let mut truncated = false;

        seen.insert(root);
        distances.insert(root, 0);
        queue.push_back(root);

        while let Some(id) = queue.pop_front() {
            let depth = distances.get(&id).copied().unwrap_or_default();
            if depth > 0 && graph.is_boundary(id) {
                boundary_nodes.insert(id);
                continue;
            }
            if depth >= options.max_depth {
                if has_visible_neighbor(
                    graph,
                    id,
                    options.dir,
                    options.hide_control,
                    options.hide_const,
                ) {
                    boundary_nodes.insert(id);
                    truncated = true;
                }
                continue;
            }
            let edge_ids = match options.dir {
                ConeDir::Fanin => &graph.incoming[id as usize],
                ConeDir::Fanout => &graph.outgoing[id as usize],
            };
            for edge_idx in edge_ids {
                let edge = &graph.edges[*edge_idx];
                if should_hide_edge(graph, edge, options.hide_control, options.hide_const) {
                    continue;
                }
                let next = match options.dir {
                    ConeDir::Fanin => edge.from,
                    ConeDir::Fanout => edge.to,
                };
                if !seen.contains(&next) {
                    if seen.len() >= cap {
                        truncated = true;
                        continue;
                    }
                    seen.insert(next);
                    distances.insert(next, depth + 1);
                    queue.push_back(next);
                }
                edge_set.insert(*edge_idx);
            }
        }

        Some(self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            Some(root),
            &boundary_nodes,
            truncated,
        ))
    }

    pub fn full_netlist(&self, graph: &Graph, max_nodes: usize) -> Subgraph {
        let cap = max_nodes.clamp(1, 2000);
        let mut seen = HashSet::new();
        for node in graph.nodes.iter().take(cap) {
            seen.insert(node.id);
        }
        let edge_set: HashSet<usize> = graph
            .edges
            .iter()
            .enumerate()
            .filter(|(_, edge)| seen.contains(&edge.from) && seen.contains(&edge.to))
            .map(|(idx, _)| idx)
            .collect();
        self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            None,
            &HashSet::new(),
            graph.nodes.len() > cap,
        )
    }

    pub fn fanout(&self, graph: &Graph, limit: usize) -> FanoutResponse {
        #[derive(Default)]
        struct Acc {
            fanout: usize,
            endpoints: HashSet<NodeId>,
            control: usize,
        }

        let mut groups: HashMap<(NodeId, String, String), Acc> = HashMap::new();
        for edge in &graph.edges {
            let Some(node) = graph.nodes.get(edge.from as usize) else {
                continue;
            };
            if matches!(node.kind, NodeKind::Const) {
                continue;
            }
            let key = (edge.from, edge.from_port.clone(), edge.net_name.clone());
            let acc = groups.entry(key).or_default();
            acc.fanout += 1;
            if edge.control {
                acc.control += 1;
            }
            if is_direct_endpoint(graph, edge.to) {
                acc.endpoints.insert(edge.to);
            }
        }

        let mut drivers: Vec<FanoutDriver> = groups
            .into_iter()
            .map(|((driver_id, port, net_name), acc)| FanoutDriver {
                driver: node_ref(graph, driver_id),
                port,
                net_name,
                fanout: acc.fanout,
                endpoints: acc.endpoints.len(),
                control: acc.control * 2 > acc.fanout,
            })
            .collect();
        drivers.sort_by_key(|driver| {
            (
                Reverse(driver.fanout),
                Reverse(driver.endpoints),
                driver.driver.name.clone(),
            )
        });
        drivers.truncate(limit);
        FanoutResponse { drivers }
    }

    fn path_for_target(&self, graph: &Graph, target: &EndpointTarget) -> PathEntry {
        let mut node_ids = vec![target.endpoint];
        if let Some(mut edge_idx) = target.edge {
            let mut current = graph.edges[edge_idx].from;
            node_ids.push(current);
            while graph.is_comb(current) {
                let Some(pred_edge) = self.best_pred[current as usize] else {
                    break;
                };
                edge_idx = pred_edge;
                current = graph.edges[edge_idx].from;
                node_ids.push(current);
            }
        }
        node_ids.reverse();
        let nodes: Vec<NodeRef> = node_ids.iter().map(|id| node_ref(graph, *id)).collect();
        let startpoint = nodes
            .first()
            .cloned()
            .unwrap_or_else(|| node_ref(graph, target.endpoint));
        let endpoint = node_ref(graph, target.endpoint);
        PathEntry {
            depth: target.depth,
            startpoint,
            endpoint,
            endpoint_port: target.endpoint_port.clone(),
            nodes,
        }
    }

    fn subgraph_from_sets(
        &self,
        graph: &Graph,
        seen: &HashSet<NodeId>,
        edge_set: &HashSet<usize>,
        root: Option<NodeId>,
        boundary_nodes: &HashSet<NodeId>,
        truncated: bool,
    ) -> Subgraph {
        let mut node_ids: Vec<NodeId> = seen.iter().copied().collect();
        node_ids.sort_unstable();
        let nodes = node_ids
            .into_iter()
            .map(|id| {
                let node = &graph.nodes[id as usize];
                let boundary = root != Some(id) && boundary_nodes.contains(&id);
                GraphNode {
                    node: node_ref(graph, id),
                    is_root: (root == Some(id)).then_some(true),
                    is_boundary: boundary.then_some(true),
                    depth: graph
                        .is_comb(id)
                        .then(|| self.node_depth[id as usize])
                        .flatten(),
                    params: node.params.clone(),
                }
            })
            .collect();
        let mut edges: Vec<&Edge> = edge_set
            .iter()
            .filter_map(|idx| graph.edges.get(*idx))
            .filter(|edge| seen.contains(&edge.from) && seen.contains(&edge.to))
            .collect();
        edges.sort_by_key(|edge| {
            (
                edge.from,
                edge.to,
                edge.from_port.clone(),
                edge.to_port.clone(),
            )
        });
        Subgraph {
            nodes,
            edges: merge_edges(edges),
            truncated,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ConeDir {
    Fanin,
    Fanout,
}

#[derive(Debug, Clone, Copy)]
pub struct ConeOptions {
    pub dir: ConeDir,
    pub max_depth: u32,
    pub max_nodes: usize,
    pub hide_control: bool,
    pub hide_const: bool,
}

impl ConeDir {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "fanin" => Some(Self::Fanin),
            "fanout" => Some(Self::Fanout),
            _ => None,
        }
    }
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
        cell_type: node.cell_type.clone(),
        seq: (node.kind == NodeKind::Cell && node.seq).then_some(node.seq),
        src: node.src.clone(),
    }
}

fn find_comb_loops(graph: &Graph) -> Vec<NodeId> {
    struct Tarjan<'a> {
        graph: &'a Graph,
        index: usize,
        indices: Vec<Option<usize>>,
        lowlink: Vec<usize>,
        stack: Vec<NodeId>,
        on_stack: Vec<bool>,
        loops: HashSet<NodeId>,
    }

    impl<'a> Tarjan<'a> {
        fn strongconnect(&mut self, node: NodeId) {
            self.indices[node as usize] = Some(self.index);
            self.lowlink[node as usize] = self.index;
            self.index += 1;
            self.stack.push(node);
            self.on_stack[node as usize] = true;

            for edge_idx in &self.graph.outgoing[node as usize] {
                let next = self.graph.edges[*edge_idx].to;
                if !self.graph.is_comb(next) {
                    continue;
                }
                if self.indices[next as usize].is_none() {
                    self.strongconnect(next);
                    self.lowlink[node as usize] =
                        self.lowlink[node as usize].min(self.lowlink[next as usize]);
                } else if self.on_stack[next as usize] {
                    self.lowlink[node as usize] =
                        self.lowlink[node as usize].min(self.indices[next as usize].unwrap_or(0));
                }
            }

            if self.lowlink[node as usize] == self.indices[node as usize].unwrap_or(usize::MAX) {
                let mut component = Vec::new();
                while let Some(member) = self.stack.pop() {
                    self.on_stack[member as usize] = false;
                    component.push(member);
                    if member == node {
                        break;
                    }
                }
                let self_loop = component.len() == 1
                    && self.graph.outgoing[component[0] as usize]
                        .iter()
                        .any(|edge_idx| self.graph.edges[*edge_idx].to == component[0]);
                if component.len() > 1 || self_loop {
                    self.loops.extend(component);
                }
            }
        }
    }

    let mut tarjan = Tarjan {
        graph,
        index: 0,
        indices: vec![None; graph.nodes.len()],
        lowlink: vec![0; graph.nodes.len()],
        stack: Vec::new(),
        on_stack: vec![false; graph.nodes.len()],
        loops: HashSet::new(),
    };
    for node in &graph.nodes {
        if graph.is_comb(node.id) && tarjan.indices[node.id as usize].is_none() {
            tarjan.strongconnect(node.id);
        }
    }
    let mut loops: Vec<NodeId> = tarjan.loops.into_iter().collect();
    loops.sort_unstable();
    loops
}

fn compute_depths(
    graph: &Graph,
    loop_set: &HashSet<NodeId>,
) -> (Vec<Option<u32>>, Vec<Option<usize>>) {
    let mut indegree = vec![0usize; graph.nodes.len()];
    for edge in &graph.edges {
        if graph.is_comb(edge.from)
            && graph.is_comb(edge.to)
            && !loop_set.contains(&edge.from)
            && !loop_set.contains(&edge.to)
        {
            indegree[edge.to as usize] += 1;
        }
    }

    let mut queue = VecDeque::new();
    for node in &graph.nodes {
        if graph.is_comb(node.id) && !loop_set.contains(&node.id) && indegree[node.id as usize] == 0
        {
            queue.push_back(node.id);
        }
    }

    let mut depth = vec![None; graph.nodes.len()];
    let mut best_pred = vec![None; graph.nodes.len()];

    while let Some(id) = queue.pop_front() {
        let mut best: Option<(u32, usize)> = None;
        for edge_idx in &graph.incoming[id as usize] {
            let edge = &graph.edges[*edge_idx];
            if loop_set.contains(&edge.from) {
                continue;
            }
            let base = if graph.is_comb(edge.from) {
                depth[edge.from as usize].unwrap_or(0)
            } else {
                0
            };
            let candidate = base + 1;
            if best.is_none_or(|(current, _)| candidate > current) {
                best = Some((candidate, *edge_idx));
            }
        }
        let (node_depth, pred) = best.unwrap_or((1, usize::MAX));
        depth[id as usize] = Some(node_depth);
        if pred != usize::MAX {
            best_pred[id as usize] = Some(pred);
        }

        for edge_idx in &graph.outgoing[id as usize] {
            let next = graph.edges[*edge_idx].to;
            if graph.is_comb(next) && !loop_set.contains(&next) {
                indegree[next as usize] = indegree[next as usize].saturating_sub(1);
                if indegree[next as usize] == 0 {
                    queue.push_back(next);
                }
            }
        }
    }

    (depth, best_pred)
}

fn discover_endpoints(
    graph: &Graph,
    node_depth: &[Option<u32>],
) -> (EndpointsResponse, Vec<EndpointTarget>) {
    let mut targets = Vec::new();
    let mut register_map: BTreeMap<String, RegisterGroup> = BTreeMap::new();

    for node in &graph.nodes {
        if node.kind != NodeKind::Cell || !node.seq || node.blackbox {
            continue;
        }
        let Some(info) = graph.cell_info.get(&node.id) else {
            continue;
        };
        let q_width = info.q_bits.len().max(1);
        let group_name = info
            .q_bits
            .iter()
            .find_map(|bit| bit.net())
            .and_then(|net| graph.net_names.get(&net))
            .map(|name| strip_bit_suffix(name).to_owned())
            .unwrap_or_else(|| node.name.clone());
        let cell_type = node.cell_type.clone().unwrap_or_default();
        let mut bits = Vec::new();
        for bit_idx in 0..q_width {
            let display_bit = info
                .q_bits
                .get(bit_idx)
                .and_then(|bit| bit.net())
                .and_then(|net| graph.net_names.get(&net))
                .and_then(|name| bit_index_from_name(name))
                .unwrap_or(bit_idx);
            let edge = info
                .d_bits
                .get(bit_idx)
                .and_then(|d_bit| find_matching_input_edge(graph, node.id, "D", d_bit))
                .or_else(|| find_nth_data_edge(graph, node.id, bit_idx));
            let depth = edge.map_or(0, |idx| edge_depth(graph, node_depth, idx));
            bits.push(EndpointBit {
                bit: display_bit,
                node_id: node.id,
                depth,
            });
            targets.push(EndpointTarget {
                endpoint: node.id,
                endpoint_port: "D".to_owned(),
                edge,
                depth,
            });
        }
        let entry = register_map
            .entry(group_name.clone())
            .or_insert(RegisterGroup {
                name: group_name,
                width: 0,
                cell_type,
                clock: info.clock_net.clone(),
                src: node.src.clone(),
                worst_depth: 0,
                bits: Vec::new(),
            });
        entry.width += bits.len();
        entry.worst_depth = entry
            .worst_depth
            .max(bits.iter().map(|bit| bit.depth).max().unwrap_or_default());
        entry.bits.extend(bits);
        entry.bits.sort_by_key(|bit| bit.bit);
    }

    let mut outputs = Vec::new();
    let mut inputs = Vec::new();
    let mut port_groups: BTreeMap<String, Vec<&crate::graph::Node>> = BTreeMap::new();
    for node in &graph.nodes {
        if node.kind == NodeKind::PortBit
            && let Some(port) = &node.port
        {
            port_groups.entry(port.clone()).or_default().push(node);
        }
    }
    for (name, mut nodes) in port_groups {
        nodes.sort_by_key(|node| node.port_bit.unwrap_or_default());
        let Some(dir) = nodes.first().and_then(|node| node.port_dir) else {
            continue;
        };
        if matches!(dir, PortDirection::Input | PortDirection::Inout) {
            inputs.push(InputGroup {
                name: name.clone(),
                width: nodes.len(),
                bits: nodes
                    .iter()
                    .map(|node| InputBit {
                        bit: node.port_bit.unwrap_or_default(),
                        node_id: node.id,
                    })
                    .collect(),
            });
        }
        if matches!(dir, PortDirection::Output | PortDirection::Inout) {
            let bits: Vec<EndpointBit> = nodes
                .iter()
                .map(|node| {
                    let edge = best_endpoint_edge(graph, node_depth, node.id, None);
                    let depth = edge.map_or(0, |idx| edge_depth(graph, node_depth, idx));
                    targets.push(EndpointTarget {
                        endpoint: node.id,
                        endpoint_port: name.clone(),
                        edge,
                        depth,
                    });
                    EndpointBit {
                        bit: node.port_bit.unwrap_or_default(),
                        node_id: node.id,
                        depth,
                    }
                })
                .collect();
            outputs.push(OutputGroup {
                name,
                width: bits.len(),
                worst_depth: bits.iter().map(|bit| bit.depth).max().unwrap_or_default(),
                bits,
            });
        }
    }

    for node in &graph.nodes {
        if node.kind != NodeKind::Cell || !node.blackbox {
            continue;
        }
        for edge_idx in &graph.incoming[node.id as usize] {
            let edge = &graph.edges[*edge_idx];
            if is_data_pin(&edge.to_port) {
                targets.push(EndpointTarget {
                    endpoint: node.id,
                    endpoint_port: edge.to_port.clone(),
                    edge: Some(*edge_idx),
                    depth: edge_depth(graph, node_depth, *edge_idx),
                });
            }
        }
    }

    (
        EndpointsResponse {
            registers: register_map.into_values().collect(),
            outputs,
            inputs,
        },
        targets,
    )
}

fn find_matching_input_edge(
    graph: &Graph,
    node_id: NodeId,
    port: &str,
    bit: &crate::netlist::YosysBit,
) -> Option<usize> {
    graph.incoming[node_id as usize]
        .iter()
        .copied()
        .find(|idx| {
            let edge = &graph.edges[*idx];
            edge.to_port == port && edge.bit == bit.net()
        })
}

fn find_nth_data_edge(graph: &Graph, node_id: NodeId, nth: usize) -> Option<usize> {
    graph.incoming[node_id as usize]
        .iter()
        .copied()
        .filter(|idx| is_data_pin(&graph.edges[*idx].to_port))
        .nth(nth)
}

fn best_endpoint_edge(
    graph: &Graph,
    node_depth: &[Option<u32>],
    node_id: NodeId,
    port: Option<&str>,
) -> Option<usize> {
    graph.incoming[node_id as usize]
        .iter()
        .copied()
        .filter(|idx| port.is_none_or(|name| graph.edges[*idx].to_port == name))
        .max_by_key(|idx| edge_depth(graph, node_depth, *idx))
}

fn edge_depth(graph: &Graph, node_depth: &[Option<u32>], edge_idx: usize) -> u32 {
    let pred = graph.edges[edge_idx].from;
    if graph.is_comb(pred) {
        node_depth[pred as usize].unwrap_or(0)
    } else {
        0
    }
}

fn is_direct_endpoint(graph: &Graph, node_id: NodeId) -> bool {
    graph.nodes.get(node_id as usize).is_some_and(|node| {
        node.seq
            || (node.kind == NodeKind::PortBit
                && matches!(
                    node.port_dir,
                    Some(PortDirection::Output | PortDirection::Inout)
                ))
    })
}

fn should_hide_edge(graph: &Graph, edge: &Edge, hide_control: bool, hide_const: bool) -> bool {
    (hide_control && edge.control)
        || (hide_const
            && graph
                .nodes
                .get(edge.from as usize)
                .is_some_and(|node| node.kind == NodeKind::Const))
}

fn has_visible_neighbor(
    graph: &Graph,
    id: NodeId,
    dir: ConeDir,
    hide_control: bool,
    hide_const: bool,
) -> bool {
    let edges = match dir {
        ConeDir::Fanin => &graph.incoming[id as usize],
        ConeDir::Fanout => &graph.outgoing[id as usize],
    };
    edges
        .iter()
        .any(|idx| !should_hide_edge(graph, &graph.edges[*idx], hide_control, hide_const))
}

fn merge_edges(edges: Vec<&Edge>) -> Vec<GraphEdge> {
    let mut merged: BTreeMap<(NodeId, NodeId, String, String), GraphEdge> = BTreeMap::new();
    for edge in edges {
        let key = (
            edge.from,
            edge.to,
            edge.from_port.clone(),
            edge.to_port.clone(),
        );
        let entry = merged.entry(key).or_insert_with(|| GraphEdge {
            from: edge.from,
            to: edge.to,
            from_port: edge.from_port.clone(),
            to_port: edge.to_port.clone(),
            net_name: edge.net_name.clone(),
            bits: Vec::new(),
            control: edge.control.then_some(true),
        });
        if let Some(bit) = edge.bit {
            entry.bits.push(bit);
            entry.bits.sort_unstable();
            entry.bits.dedup();
        }
        if edge.control {
            entry.control = Some(true);
        }
    }
    merged.into_values().collect()
}

fn build_stats(graph: &Graph, endpoints: &EndpointsResponse) -> Stats {
    let mut cells_by_type = BTreeMap::new();
    for node in &graph.nodes {
        if node.kind == NodeKind::Cell {
            *cells_by_type
                .entry(node.cell_type.clone().unwrap_or_default())
                .or_insert(0) += 1;
        }
    }
    let num_register_bits = endpoints.registers.iter().map(|group| group.width).sum();
    let num_inputs = endpoints.inputs.iter().map(|group| group.width).sum();
    let num_outputs = endpoints.outputs.iter().map(|group| group.width).sum();
    let max_depth = endpoints
        .registers
        .iter()
        .map(|group| group.worst_depth)
        .chain(endpoints.outputs.iter().map(|group| group.worst_depth))
        .max()
        .unwrap_or_default();
    Stats {
        num_cells: cells_by_type.values().sum(),
        cells_by_type,
        num_register_bits,
        num_register_groups: endpoints.registers.len(),
        num_inputs,
        num_outputs,
        max_depth,
    }
}

fn build_warnings(graph: &Graph, comb_loops: &[NodeId]) -> Vec<String> {
    let mut warnings = Vec::new();
    if !comb_loops.is_empty() {
        let names = comb_loops
            .iter()
            .map(|id| graph.node_ref_name(*id))
            .collect::<Vec<_>>()
            .join(", ");
        warnings.push(format!("combinational loop detected: {names}"));
    }
    for id in &graph.blackboxes {
        let node = &graph.nodes[*id as usize];
        warnings.push(format!(
            "blackbox boundary: {} ({})",
            node.name,
            node.cell_type.clone().unwrap_or_default()
        ));
    }
    warnings
}

fn build_source_map(graph: &Graph, files: Vec<String>) -> SourceMapResponse {
    let mut by_line: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for node in &graph.nodes {
        let Some(src) = &node.src else {
            continue;
        };
        for loc in src.split('|') {
            if let Some((file, start, end)) = parse_src_loc(loc) {
                let capped_end = end.min(start + 199);
                for line in start..=capped_end {
                    by_line
                        .entry(format!("{file}:{line}"))
                        .or_default()
                        .push(node.id);
                }
            }
        }
    }
    for ids in by_line.values_mut() {
        ids.sort_unstable();
        ids.dedup();
    }
    SourceMapResponse { files, by_line }
}

fn parse_src_loc(loc: &str) -> Option<(String, usize, usize)> {
    let trimmed = loc.trim();
    let (file, rest) = trimmed.rsplit_once(':')?;
    let (start, end) = rest.split_once('-').map_or((rest, rest), |(a, b)| (a, b));
    let start_line: usize = start.split('.').next()?.parse().ok()?;
    let end_line: usize = end.split('.').next()?.parse().ok()?;
    let file_name = std::path::Path::new(file)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(file)
        .to_owned();
    Some((file_name, start_line, end_line.max(start_line)))
}

fn bit_index_from_name(name: &str) -> Option<usize> {
    name.rsplit_once('[')?.1.strip_suffix(']')?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Graph;
    use crate::netlist::{parse_str, select_top};

    fn fixture(name: &str) -> (Graph, Analysis) {
        let json = std::fs::read_to_string(format!("tests/fixtures/{name}")).unwrap();
        let netlist = parse_str(&json).unwrap();
        let (top, module) = select_top(&netlist, None).unwrap();
        let graph = Graph::from_netlist(&netlist, top, module).unwrap();
        let analysis = Analysis::new(&graph, vec!["fixture.sv".to_owned()]);
        (graph, analysis)
    }

    #[test]
    fn depth_dp_counts_three_and_levels() {
        let (_graph, analysis) = fixture("and_chain_rtl.json");
        assert_eq!(analysis.stats.max_depth, 3);
        let paths = analysis.paths(&_graph, 5, None);
        assert_eq!(paths.paths[0].depth, 3);
    }

    #[test]
    fn register_grouping_uses_q_net() {
        let (_graph, analysis) = fixture("reg_mux_rtl.json");
        let q = analysis
            .endpoints
            .registers
            .iter()
            .find(|group| group.name == "q")
            .unwrap();
        assert_eq!(q.width, 8);
        assert_eq!(q.worst_depth, 1);
    }

    #[test]
    fn detects_combinational_loop_fixture() {
        let (graph, analysis) = fixture("comb_loop_rtl.json");
        assert_eq!(analysis.comb_loops.len(), 2);
        let names: Vec<_> = analysis
            .comb_loops
            .iter()
            .map(|id| graph.node_ref_name(*id))
            .collect();
        assert!(names.iter().any(|name| name.contains("$not")));
    }
}
