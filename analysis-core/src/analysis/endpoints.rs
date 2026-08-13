use super::api::is_register_node;
use super::depth::{direct_register_driver, edge_depth, is_depth_node, is_depth_output_edge};
use super::{
    BoundaryEndpoint, EndpointBit, EndpointKind, EndpointsResponse, InputBit, InputGroup,
    MAX_BOUNDARY_ENDPOINT_BITS, MAX_BOUNDARY_ENDPOINTS, OutputAlias, OutputAliasBit, OutputGroup,
    RegisterGroup,
};
use crate::graph::{Graph, NodeId, NodeKind, is_transparent_data_buffer, strip_bit_suffix};
use crate::netlist::PortDirection;
use crate::source::coordinates::parse_src_loc;
use deepsize::DeepSizeOf;
use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, DeepSizeOf)]
pub(super) struct EndpointTarget {
    pub(super) endpoint: NodeId,
    pub(super) endpoint_port: String,
    pub(super) edge: Option<usize>,
    pub(super) startpoint: NodeId,
    pub(super) depth: u32,
    pub(super) group: String,
    pub(super) kind: EndpointKind,
    pub(super) bit: usize,
}

pub(super) fn discover_endpoints(
    graph: &Graph,
    node_depth: &[Option<u32>],
    node_startpoint: &[Option<NodeId>],
    source_files: &[String],
) -> (EndpointsResponse, Vec<EndpointTarget>, bool) {
    let design_files: HashSet<&str> = source_files.iter().map(String::as_str).collect();
    let mut targets = Vec::new();
    let mut register_map: BTreeMap<String, RegisterGroup> = BTreeMap::new();
    let mut register_bits: HashMap<(NodeId, Option<u32>), (String, usize)> = HashMap::new();
    let mut boundaries = Vec::new();
    let mut boundary_bit_count = 0;
    let mut boundary_target_count = 0;
    let mut boundaries_truncated = false;
    let mut endpoint_targets_truncated = false;

    for node in &graph.nodes {
        if !is_register_node(node) {
            continue;
        }
        let Some(info) = graph.cell_info.get(&node.id) else {
            continue;
        };
        let q_width = info.q_bits.len().max(1);
        let group_name = register_group_name(graph, node, info, &design_files);
        let cell_type = node.cell_type.clone().unwrap_or_default();
        let mut bits = Vec::new();
        let data_edges = endpoint_data_edges(graph, node.id, info, q_width);
        for (bit_idx, edge) in data_edges.into_iter().enumerate() {
            let display_bit = info
                .q_bits
                .get(bit_idx)
                .and_then(|bit| bit.net())
                .and_then(|net| register_q_name(graph, net))
                .and_then(bit_index_from_name)
                .or_else(|| bit_index_from_name(&node.name))
                .unwrap_or(bit_idx);
            let depth = edge.map_or(0, |idx| edge_depth(graph, node_depth, idx));
            bits.push(EndpointBit {
                bit: display_bit,
                node_id: node.id,
                depth,
            });
            register_bits.insert(
                (node.id, info.q_bits.get(bit_idx).and_then(|bit| bit.net())),
                (group_name.clone(), display_bit),
            );
            targets.push(EndpointTarget {
                endpoint: node.id,
                endpoint_port: "D".to_owned(),
                edge,
                startpoint: endpoint_startpoint_id(graph, node_startpoint, node.id, edge),
                depth,
                group: group_name.clone(),
                kind: EndpointKind::Register,
                bit: display_bit,
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
                output_aliases: Vec::new(),
            });
        entry.width += bits.len();
        entry.worst_depth = entry
            .worst_depth
            .max(bits.iter().map(|bit| bit.depth).max().unwrap_or_default());
        entry.bits.extend(bits);
    }
    for register in register_map.values_mut() {
        register.bits.sort_by_key(|bit| bit.bit);
    }

    let mut outputs = Vec::new();
    let mut inputs = Vec::new();
    let mut output_aliases: BTreeMap<(String, String, usize), Vec<OutputAliasBit>> =
        BTreeMap::new();
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
            let output_width = nodes.len();
            let mut bits = Vec::new();
            for node in nodes {
                let output_bit = node.port_bit.unwrap_or_default();
                if let Some((register_node, register_net)) = direct_register_driver(graph, node.id)
                    && let Some((group_name, register_bit)) = register_bits
                        .get(&(register_node, register_net))
                        .or_else(|| register_bits.get(&(register_node, None)))
                {
                    output_aliases
                        .entry((group_name.clone(), name.clone(), output_width))
                        .or_default()
                        .push(OutputAliasBit {
                            output_bit,
                            register_bit: *register_bit,
                        });
                    continue;
                }

                let edge = best_endpoint_edge(graph, node_depth, node.id, None);
                let depth = edge.map_or(0, |idx| edge_depth(graph, node_depth, idx));
                targets.push(EndpointTarget {
                    endpoint: node.id,
                    endpoint_port: name.clone(),
                    edge,
                    startpoint: endpoint_startpoint_id(graph, node_startpoint, node.id, edge),
                    depth,
                    group: name.clone(),
                    kind: EndpointKind::Output,
                    bit: output_bit,
                });
                bits.push(EndpointBit {
                    bit: output_bit,
                    node_id: node.id,
                    depth,
                });
            }
            if !bits.is_empty() {
                outputs.push(OutputGroup {
                    name,
                    width: output_width,
                    worst_depth: bits.iter().map(|bit| bit.depth).max().unwrap_or_default(),
                    bits,
                });
            }
        }
    }

    for ((register_name, output_name, width), mut bits) in output_aliases {
        bits.sort_by_key(|bit| (bit.register_bit, bit.output_bit));
        if let Some(register) = register_map.get_mut(&register_name) {
            register.output_aliases.push(OutputAlias {
                name: output_name,
                width,
                bits,
            });
            register.output_aliases.sort_by(|a, b| a.name.cmp(&b.name));
        }
    }

    for node in &graph.nodes {
        if node.kind != NodeKind::Cell || !node.seq || is_register_node(node) {
            continue;
        }
        let mut port_indices: HashMap<&str, usize> = HashMap::new();
        let mut seen_port_bits: HashMap<(&str, u32), (usize, usize)> = HashMap::new();
        for edge_idx in &graph.incoming[node.id as usize] {
            let edge = &graph.edges[*edge_idx];
            if edge.control {
                continue;
            }
            let depth = edge_depth(graph, node_depth, *edge_idx);
            let endpoint_index = if let Some(index) = port_indices.get(edge.to_port.as_str()) {
                Some(*index)
            } else if boundaries.len() < MAX_BOUNDARY_ENDPOINTS {
                let index = boundaries.len();
                boundaries.push(BoundaryEndpoint {
                    name: node.name.clone(),
                    node_id: node.id,
                    cell_type: node.cell_type.clone().unwrap_or_default(),
                    port: edge.to_port.clone(),
                    width: 0,
                    src: node.src.clone(),
                    worst_depth: 0,
                    bits: Vec::new(),
                    bits_truncated: false,
                });
                port_indices.insert(edge.to_port.as_str(), index);
                Some(index)
            } else {
                boundaries_truncated = true;
                None
            };

            let port_bit = edge.to_port_bit as usize;
            if let Some(index) = endpoint_index {
                boundaries[index].width = boundaries[index].width.max(port_bit + 1);
                boundaries[index].worst_depth = boundaries[index].worst_depth.max(depth);
                let key = (edge.to_port.as_str(), edge.to_port_bit);
                match seen_port_bits.entry(key) {
                    std::collections::hash_map::Entry::Occupied(stored) => {
                        let (stored_endpoint, stored_bit) = *stored.get();
                        boundaries[stored_endpoint].bits[stored_bit].depth =
                            boundaries[stored_endpoint].bits[stored_bit]
                                .depth
                                .max(depth);
                    }
                    std::collections::hash_map::Entry::Vacant(slot) => {
                        if boundary_bit_count < MAX_BOUNDARY_ENDPOINT_BITS {
                            let stored_bit = boundaries[index].bits.len();
                            boundaries[index].bits.push(EndpointBit {
                                bit: port_bit,
                                node_id: node.id,
                                depth,
                            });
                            slot.insert((index, stored_bit));
                            boundary_bit_count += 1;
                        } else {
                            boundaries[index].bits_truncated = true;
                            boundaries_truncated = true;
                        }
                    }
                }
            }

            if endpoint_index.is_none() || boundary_target_count >= MAX_BOUNDARY_ENDPOINT_BITS {
                endpoint_targets_truncated = true;
                continue;
            }
            targets.push(EndpointTarget {
                endpoint: node.id,
                endpoint_port: edge.to_port.clone(),
                edge: Some(*edge_idx),
                startpoint: endpoint_startpoint_id(
                    graph,
                    node_startpoint,
                    node.id,
                    Some(*edge_idx),
                ),
                depth,
                group: node.name.clone(),
                kind: EndpointKind::Blackbox,
                bit: port_bit,
            });
            boundary_target_count += 1;
        }
    }

    for endpoint in &mut boundaries {
        endpoint
            .bits
            .sort_by_key(|bit| (bit.bit, Reverse(bit.depth)));
        endpoint.bits.dedup_by_key(|bit| bit.bit);
    }
    boundaries.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.node_id.cmp(&b.node_id))
            .then_with(|| a.port.cmp(&b.port))
    });

    (
        EndpointsResponse {
            registers: register_map.into_values().collect(),
            outputs,
            inputs,
            boundaries,
            boundaries_truncated,
        },
        targets,
        endpoint_targets_truncated,
    )
}

pub(super) fn endpoint_data_edges(
    graph: &Graph,
    node_id: NodeId,
    info: &crate::graph::CellInfo,
    width: usize,
) -> Vec<Option<usize>> {
    let mut data_edges = Vec::new();
    let mut d_edges = Vec::new();
    let mut d_edges_by_net = HashMap::new();
    for edge_idx in &graph.incoming[node_id as usize] {
        let edge = &graph.edges[*edge_idx];
        if edge.control {
            continue;
        }
        data_edges.push(*edge_idx);
        if edge.to_port == "D" {
            d_edges.push(*edge_idx);
            if let Some(bit) = edge.bit {
                d_edges_by_net.entry(bit).or_insert(*edge_idx);
            }
        }
    }

    (0..width)
        .map(|bit_idx| {
            info.d_bits
                .get(bit_idx)
                .and_then(|bit| bit.net())
                .and_then(|bit| d_edges_by_net.get(&bit).copied())
                .or_else(|| d_edges.get(bit_idx).copied())
                .or_else(|| data_edges.get(bit_idx).copied())
        })
        .collect()
}

pub(super) fn endpoint_startpoint_id(
    graph: &Graph,
    node_startpoint: &[Option<NodeId>],
    endpoint: NodeId,
    edge: Option<usize>,
) -> NodeId {
    let Some(edge_idx) = edge else {
        return endpoint;
    };
    let current = graph.edges[edge_idx].from;
    if is_depth_node(graph, current) && is_depth_output_edge(graph, &graph.edges[edge_idx]) {
        node_startpoint[current as usize].unwrap_or(current)
    } else {
        current
    }
}

pub(super) fn best_endpoint_edge(
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

pub(super) fn is_direct_endpoint(graph: &Graph, node_id: NodeId) -> bool {
    graph.nodes.get(node_id as usize).is_some_and(|node| {
        node.seq
            || (node.kind == NodeKind::PortBit
                && matches!(
                    node.port_dir,
                    Some(PortDirection::Output | PortDirection::Inout)
                ))
    })
}
pub(super) fn register_q_name(graph: &Graph, net: u32) -> Option<&str> {
    best_net_alias(graph, net, false)
}

pub(super) fn visible_net_name(graph: &Graph, net: u32) -> Option<&str> {
    best_net_alias(graph, net, true)
}

pub(super) fn best_net_alias(graph: &Graph, net: u32, require_visible: bool) -> Option<&str> {
    let aliases = graph.net_aliases.get(&net)?;
    let mut best: Option<&str> = None;
    for candidate in aliases {
        let raw_candidate = candidate.as_str();
        let candidate = raw_candidate
            .strip_prefix("$iopadmap$")
            .filter(|name| !name.is_empty())
            .unwrap_or(raw_candidate);
        if require_visible && is_hidden_name(candidate) {
            continue;
        }
        let candidate_depth = bracket_depth(candidate);
        let replace = best.is_none_or(|current| {
            let current_depth = bracket_depth(current);
            candidate_depth > current_depth
                || (candidate_depth == current_depth && candidate.len() < current.len())
        });
        if replace {
            best = Some(candidate);
        }
    }
    best.or_else(|| {
        graph
            .net_names
            .get(&net)
            .map(String::as_str)
            .filter(|name| !require_visible || !is_hidden_name(name))
    })
}

pub(super) fn is_hidden_name(name: &str) -> bool {
    name.starts_with('$')
}

/// Recover a collision-free vector identity from a Yosys generated bit name
/// such as `$memory$rdreg[0]$q[7]`. Keep the exact hidden stem for grouping;
/// presentation code may prettify it without weakening identity.
pub(super) fn hidden_vector_group_name(name: &str) -> Option<String> {
    if !is_hidden_name(name) {
        return None;
    }
    let stem = strip_bit_suffix(name);
    if stem == name {
        return None;
    }
    Some(stem.to_owned())
}

/// Displayed endpoint-group name for a register cell. ABC restructuring and
/// library techmaps (for example xilinx `ff_map.v`) can destroy every RTL name
/// on a flip-flop, so after today's Q-net name the chain falls back through
/// visible Q- and D-net aliases, an output port reached through transparent
/// buffers, a visible instance name, and a design-file src label before a
/// deterministic per-node label. Register rows therefore never render as
/// identical bare cell-type entries.
pub(super) fn register_group_name(
    graph: &Graph,
    node: &crate::graph::Node,
    info: &crate::graph::CellInfo,
    design_files: &HashSet<&str>,
) -> String {
    let q_name = info
        .q_bits
        .iter()
        .find_map(|bit| bit.net())
        .and_then(|net| register_q_name(graph, net));
    if let Some(name) = q_name
        && !is_hidden_name(name)
    {
        return strip_bit_suffix(name).to_owned();
    }
    for bits in [&info.q_bits, &info.d_bits] {
        if let Some(name) = bits
            .iter()
            .filter_map(|bit| bit.net())
            .find_map(|net| visible_net_name(graph, net))
        {
            return strip_bit_suffix(name).to_owned();
        }
    }
    if let Some(group_name) = q_name.and_then(hidden_vector_group_name) {
        return group_name;
    }
    if let Some(port) = forwarded_output_port(graph, node.id) {
        return port;
    }
    if !is_hidden_name(&node.name) {
        return node.name.clone();
    }
    if let Some(group_name) = hidden_vector_group_name(&node.name) {
        return group_name;
    }
    let cell_type = node.cell_type.as_deref().unwrap_or_default();
    if let Some(label) = node
        .src
        .as_deref()
        .and_then(|src| design_src_label(src, design_files))
    {
        return format!("{cell_type} @ {label}");
    }
    format!("{cell_type}·{}", node.id)
}

/// Follow a register's outputs forward through unconditional data buffers to
/// a top-level output port, mirroring `direct_register_driver`.
pub(super) fn forwarded_output_port(graph: &Graph, register: NodeId) -> Option<String> {
    let mut queue: VecDeque<NodeId> = VecDeque::from([register]);
    let mut visited: HashSet<NodeId> = HashSet::from([register]);
    while let Some(id) = queue.pop_front() {
        for edge_idx in &graph.outgoing[id as usize] {
            let edge = &graph.edges[*edge_idx];
            let Some(sink) = graph.nodes.get(edge.to as usize) else {
                continue;
            };
            if sink.kind == NodeKind::PortBit
                && matches!(
                    sink.port_dir,
                    Some(PortDirection::Output | PortDirection::Inout)
                )
                && let Some(port) = &sink.port
            {
                return Some(port.clone());
            }
            if sink.kind == NodeKind::Cell
                && sink
                    .cell_type
                    .as_deref()
                    .is_some_and(is_transparent_data_buffer)
                && visited.insert(sink.id)
            {
                queue.push_back(sink.id);
            }
        }
    }
    None
}

/// First src fragment that points at a submitted design file, as `file:line`.
/// Library techmap sources (for example `ff_map.v`) are never design files and
/// would mislabel the endpoint.
pub(super) fn design_src_label(src: &str, design_files: &HashSet<&str>) -> Option<String> {
    src.split('|').find_map(|loc| {
        let (file, start_line, _) = parse_src_loc(loc)?;
        design_files
            .contains(file.as_str())
            .then(|| format!("{file}:{start_line}"))
    })
}

pub(super) fn bracket_depth(name: &str) -> usize {
    name.as_bytes().iter().filter(|byte| **byte == b'[').count()
}

pub(super) fn bit_index_from_name(name: &str) -> Option<usize> {
    name.rsplit_once('[')?.1.strip_suffix(']')?.parse().ok()
}
