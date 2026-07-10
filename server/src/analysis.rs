use crate::graph::{
    Edge, Graph, NodeId, NodeKind, cell_depth_weight, is_infrastructure_cell,
    is_transparent_data_buffer, strip_bit_suffix,
};
use crate::netlist::{PortDirection, YosysModule};
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub controls: Vec<ControlRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlRole {
    Clock,
    Reset,
    Set,
    Enable,
    Other,
}

#[derive(Debug, Clone, Serialize)]
pub struct ControlRef {
    pub role: ControlRole,
    pub pin: String,
    pub net_name: String,
    pub driver_id: NodeId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_low: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated: Option<bool>,
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
    pub output_aliases: Vec<OutputAlias>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputAliasBit {
    pub output_bit: usize,
    pub register_bit: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputAlias {
    pub name: String,
    pub width: usize,
    pub bits: Vec<OutputAliasBit>,
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
    pub class: PathClass,
    pub endpoint_group: String,
    pub endpoint_kind: EndpointKind,
    pub bits: Vec<usize>,
    pub output_aliases: Vec<OutputAlias>,
    pub startpoint: NodeRef,
    pub endpoint: NodeRef,
    pub endpoint_port: String,
    pub nodes: Vec<NodeRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointKind {
    Register,
    Output,
    Blackbox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PathClass {
    InputToRegister,
    RegisterToRegister,
    RegisterToOutput,
    InputToOutput,
    Other,
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

#[derive(Debug, Clone)]
pub struct SourceLineIndex {
    files: HashSet<String>,
    lines: HashSet<String>,
}

impl SourceLineIndex {
    pub fn from_module(module: &YosysModule, files: Vec<String>) -> Self {
        let mut lines = HashSet::new();
        for cell in module.cells.values() {
            let Some(src) = cell.attributes.get("src") else {
                continue;
            };
            insert_src_lines(src, |file, line| {
                lines.insert(format!("{file}:{line}"));
            });
        }
        Self {
            files: files.into_iter().collect(),
            lines,
        }
    }

    pub fn contains_range(&self, file: &str, start_line: usize, end_line: usize) -> Option<bool> {
        if !self.files.contains(file) {
            return None;
        }
        Some((start_line..=end_line).any(|line| self.lines.contains(&format!("{file}:{line}"))))
    }
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
    pub depths: DepthSummary,
    pub cell_categories: CellCategoryCounts,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DepthSummary {
    pub input_to_register: Option<u32>,
    pub register_to_register: Option<u32>,
    pub register_to_output: Option<u32>,
    pub input_to_output: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct CellCategoryCounts {
    pub logic: usize,
    pub registers: usize,
    pub carry_special: usize,
    pub infrastructure: usize,
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
    group: String,
    kind: EndpointKind,
    bit: usize,
}

impl Analysis {
    pub fn new(graph: &Graph, source_files: Vec<String>) -> Self {
        let comb_loops = find_comb_loops(graph);
        let loop_set: HashSet<NodeId> = comb_loops.iter().copied().collect();
        let (node_depth, best_pred) = compute_depths(graph, &loop_set);
        let (endpoints, endpoint_targets) = discover_endpoints(graph, &node_depth);
        let source_map = build_source_map(graph, source_files);
        let stats = build_stats(graph, &endpoints, &endpoint_targets, &best_pred);
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

    pub fn source_nodes(&self, file: &str, line: usize) -> Option<&[NodeId]> {
        if !self.source_map.files.iter().any(|name| name == file) {
            return None;
        }
        let key = format!("{file}:{line}");
        Some(
            self.source_map
                .by_line
                .get(&key)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        )
    }

    pub fn source_nodes_range(
        &self,
        file: &str,
        start_line: usize,
        end_line: usize,
    ) -> Option<Vec<NodeId>> {
        if !self.source_map.files.iter().any(|name| name == file) {
            return None;
        }
        let mut ids = Vec::new();
        for line in start_line..=end_line {
            if let Some(line_ids) = self.source_map.by_line.get(&format!("{file}:{line}")) {
                ids.extend(line_ids.iter().copied());
            }
        }
        ids.sort_unstable();
        ids.dedup();
        Some(ids)
    }

    pub fn paths(&self, graph: &Graph, limit: usize, to: Option<NodeId>) -> PathsResponse {
        let targets: Vec<&EndpointTarget> = self
            .endpoint_targets
            .iter()
            .filter(|target| to.is_none_or(|id| target.endpoint == id))
            .collect();
        let mut grouped: BTreeMap<(String, EndpointKind, PathClass, u32, Vec<String>), PathEntry> =
            BTreeMap::new();
        for target in targets {
            let path = self.path_for_target(graph, target);
            let signature = path
                .nodes
                .iter()
                .map(path_node_signature)
                .collect::<Vec<_>>();
            let key = (
                path.endpoint_group.clone(),
                path.endpoint_kind,
                path.class,
                path.depth,
                signature,
            );
            if let Some(existing) = grouped.get_mut(&key) {
                existing.bits.extend(path.bits);
                existing.bits.sort_unstable();
                existing.bits.dedup();
                merge_output_aliases(&mut existing.output_aliases, path.output_aliases);
            } else {
                grouped.insert(key, path);
            }
        }
        let mut paths: Vec<PathEntry> = grouped.into_values().collect();
        paths.sort_by_key(|path| {
            (
                Reverse(path.depth),
                path.endpoint_group.clone(),
                path.bits.first().copied().unwrap_or_default(),
            )
        });
        paths.truncate(limit);
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
        self.multi_root_cone(graph, &[root], options)
    }

    pub fn multi_root_cone(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(graph, roots, &[options.dir], options)
    }

    pub fn envelope(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(graph, roots, &[ConeDir::Fanin, ConeDir::Fanout], options)
    }

    fn multi_root_subgraph(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        directions: &[ConeDir],
        options: ConeOptions,
    ) -> Option<Subgraph> {
        if roots
            .iter()
            .any(|root| graph.nodes.get(*root as usize).is_none())
        {
            return None;
        }

        let cap = options.max_nodes.clamp(1, 2000);
        let mut seen: HashSet<NodeId> = HashSet::new();
        let mut unique_roots: HashSet<NodeId> = HashSet::new();
        let mut included_root_ids = Vec::new();
        let mut boundary_nodes: HashSet<NodeId> = HashSet::new();
        let mut edge_set: HashSet<usize> = HashSet::new();
        let mut truncated = false;

        for root in roots {
            if unique_roots.insert(*root) {
                if seen.len() >= cap {
                    truncated = true;
                    continue;
                }
                seen.insert(*root);
                included_root_ids.push(*root);
            }
        }

        let included_roots = seen.clone();
        let mut traversals: Vec<Traversal> = directions
            .iter()
            .map(|dir| Traversal {
                dir: *dir,
                seen: included_roots.clone(),
                queue: included_root_ids
                    .iter()
                    .copied()
                    .map(|root| (root, 0))
                    .collect(),
                current: None,
            })
            .collect();

        loop {
            let mut advanced = false;
            for traversal in &mut traversals {
                loop {
                    if traversal.current.is_none() {
                        let Some((id, depth)) = traversal.queue.pop_front() else {
                            break;
                        };
                        if !included_roots.contains(&id) && graph.is_boundary(id) {
                            boundary_nodes.insert(id);
                            continue;
                        }
                        if depth >= options.max_depth {
                            if has_visible_neighbor(
                                graph,
                                id,
                                traversal.dir,
                                options.hide_control,
                                options.hide_const,
                            ) {
                                boundary_nodes.insert(id);
                                truncated = true;
                            }
                            continue;
                        }
                        traversal.current = Some(TraversalFrame {
                            id,
                            depth,
                            next_edge: 0,
                        });
                    }

                    let frame = traversal.current.as_mut().expect("frame was initialized");
                    let edge_ids = match traversal.dir {
                        ConeDir::Fanin => &graph.incoming[frame.id as usize],
                        ConeDir::Fanout => &graph.outgoing[frame.id as usize],
                    };
                    let Some(edge_idx) = edge_ids.get(frame.next_edge).copied() else {
                        traversal.current = None;
                        continue;
                    };
                    frame.next_edge += 1;
                    let edge = &graph.edges[edge_idx];
                    if should_hide_edge(graph, edge, options.hide_control, options.hide_const) {
                        continue;
                    }

                    advanced = true;
                    let next = match traversal.dir {
                        ConeDir::Fanin => edge.from,
                        ConeDir::Fanout => edge.to,
                    };
                    if !seen.contains(&next) {
                        if seen.len() >= cap {
                            truncated = true;
                            break;
                        }
                        seen.insert(next);
                    }
                    if traversal.seen.insert(next) {
                        traversal.queue.push_back((next, frame.depth + 1));
                    }
                    edge_set.insert(edge_idx);
                    break;
                }
            }
            if !advanced {
                break;
            }
        }

        Some(self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &included_roots,
                boundary_nodes: &boundary_nodes,
                truncated,
                show_infrastructure: options.show_infrastructure,
            },
        ))
    }

    pub fn full_netlist(
        &self,
        graph: &Graph,
        max_nodes: usize,
        show_infrastructure: bool,
    ) -> Subgraph {
        let cap = max_nodes.clamp(1, 2000);
        let mut seen = HashSet::new();
        for node in graph.nodes.iter().take(cap) {
            seen.insert(node.id);
        }
        let edge_set: HashSet<usize> = graph
            .edges
            .iter()
            .enumerate()
            .filter(|(_, edge)| {
                seen.contains(&edge.from)
                    && seen.contains(&edge.to)
                    && !is_labeled_control_edge(graph, edge)
            })
            .map(|(idx, _)| idx)
            .collect();
        let empty = HashSet::new();
        self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &empty,
                boundary_nodes: &empty,
                truncated: graph.nodes.len() > cap,
                show_infrastructure,
            },
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
        let nodes: Vec<NodeRef> = node_ids
            .iter()
            .filter(|id| {
                graph.nodes[**id as usize]
                    .cell_type
                    .as_deref()
                    .is_none_or(|cell_type| !is_infrastructure_cell(cell_type))
            })
            .map(|id| node_ref(graph, *id))
            .collect();
        let startpoint = nodes
            .first()
            .cloned()
            .unwrap_or_else(|| node_ref(graph, target.endpoint));
        let endpoint = node_ref(graph, target.endpoint);
        let class = classify_path(&startpoint, target.kind);
        let output_aliases = self
            .endpoints
            .registers
            .iter()
            .find(|group| target.kind == EndpointKind::Register && group.name == target.group)
            .map(|group| aliases_for_register_bit(&group.output_aliases, target.bit))
            .unwrap_or_default();
        PathEntry {
            depth: target.depth,
            class,
            endpoint_group: target.group.clone(),
            endpoint_kind: target.kind,
            bits: vec![target.bit],
            output_aliases,
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
        projection: SubgraphProjection<'_>,
    ) -> Subgraph {
        let mut node_ids: Vec<NodeId> = seen.iter().copied().collect();
        node_ids.sort_unstable();
        let nodes = node_ids
            .into_iter()
            .map(|id| {
                let node = &graph.nodes[id as usize];
                let boundary =
                    !projection.roots.contains(&id) && projection.boundary_nodes.contains(&id);
                GraphNode {
                    node: node_ref(graph, id),
                    is_root: projection.roots.contains(&id).then_some(true),
                    is_boundary: boundary.then_some(true),
                    depth: graph
                        .is_comb(id)
                        .then(|| self.node_depth[id as usize])
                        .flatten(),
                    params: node.params.clone(),
                    controls: node_controls(graph, id),
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
        let subgraph = Subgraph {
            nodes,
            edges: merge_edges(edges),
            truncated: projection.truncated,
        };
        if projection.show_infrastructure {
            subgraph
        } else {
            collapse_infrastructure(graph, subgraph)
        }
    }
}

struct SubgraphProjection<'a> {
    roots: &'a HashSet<NodeId>,
    boundary_nodes: &'a HashSet<NodeId>,
    truncated: bool,
    show_infrastructure: bool,
}

fn path_node_signature(node: &NodeRef) -> String {
    match node.kind {
        ApiNodeKind::Cell => format!(
            "cell:{}:{}",
            node.cell_type.as_deref().unwrap_or("?"),
            node.seq == Some(true)
        ),
        ApiNodeKind::Port => "port".to_owned(),
        ApiNodeKind::Const => "const".to_owned(),
    }
}

fn classify_path(startpoint: &NodeRef, endpoint_kind: EndpointKind) -> PathClass {
    let starts_at_register = startpoint.seq == Some(true) && startpoint.kind == ApiNodeKind::Cell;
    let starts_at_input = startpoint.kind == ApiNodeKind::Port;
    match (starts_at_register, starts_at_input, endpoint_kind) {
        (true, _, EndpointKind::Register) => PathClass::RegisterToRegister,
        (_, true, EndpointKind::Register) => PathClass::InputToRegister,
        (true, _, EndpointKind::Output) => PathClass::RegisterToOutput,
        (_, true, EndpointKind::Output) => PathClass::InputToOutput,
        _ => PathClass::Other,
    }
}

fn aliases_for_register_bit(aliases: &[OutputAlias], register_bit: usize) -> Vec<OutputAlias> {
    aliases
        .iter()
        .filter_map(|alias| {
            let bits: Vec<OutputAliasBit> = alias
                .bits
                .iter()
                .filter(|bit| bit.register_bit == register_bit)
                .cloned()
                .collect();
            (!bits.is_empty()).then(|| OutputAlias {
                name: alias.name.clone(),
                width: alias.width,
                bits,
            })
        })
        .collect()
}

fn merge_output_aliases(existing: &mut Vec<OutputAlias>, incoming: Vec<OutputAlias>) {
    for alias in incoming {
        if let Some(current) = existing
            .iter_mut()
            .find(|current| current.name == alias.name)
        {
            current.bits.extend(alias.bits);
            current
                .bits
                .sort_by_key(|bit| (bit.register_bit, bit.output_bit));
            current
                .bits
                .dedup_by_key(|bit| (bit.register_bit, bit.output_bit));
        } else {
            existing.push(alias);
        }
    }
    existing.sort_by(|a, b| a.name.cmp(&b.name));
}

struct Traversal {
    dir: ConeDir,
    seen: HashSet<NodeId>,
    queue: VecDeque<(NodeId, u32)>,
    current: Option<TraversalFrame>,
}

struct TraversalFrame {
    id: NodeId,
    depth: u32,
    next_edge: usize,
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
    pub show_infrastructure: bool,
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
        if !graph.is_comb(start.id) || indices[start.id as usize].is_some() {
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
                if !graph.is_comb(next) {
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
                        .any(|edge_idx| graph.edges[*edge_idx].to == component[0]);
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
        let weight = graph.nodes[id as usize]
            .cell_type
            .as_deref()
            .map(cell_depth_weight)
            .unwrap_or(1);
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
            let candidate = base + weight;
            if best.is_none_or(|(current, _)| candidate > current) {
                best = Some((candidate, *edge_idx));
            }
        }
        let (node_depth, pred) = best.unwrap_or((weight, usize::MAX));
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
    let mut register_bits: HashMap<(NodeId, Option<u32>), (String, usize)> = HashMap::new();

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
            .and_then(|net| register_q_name(graph, net))
            .map(|name| strip_bit_suffix(name).to_owned())
            .unwrap_or_else(|| node.name.clone());
        let cell_type = node.cell_type.clone().unwrap_or_default();
        let mut bits = Vec::new();
        for bit_idx in 0..q_width {
            let display_bit = info
                .q_bits
                .get(bit_idx)
                .and_then(|bit| bit.net())
                .and_then(|net| register_q_name(graph, net))
                .and_then(bit_index_from_name)
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
            register_bits.insert(
                (node.id, info.q_bits.get(bit_idx).and_then(|bit| bit.net())),
                (group_name.clone(), display_bit),
            );
            targets.push(EndpointTarget {
                endpoint: node.id,
                endpoint_port: "D".to_owned(),
                edge,
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
        entry.bits.sort_by_key(|bit| bit.bit);
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
        if node.kind != NodeKind::Cell || !node.blackbox {
            continue;
        }
        for edge_idx in &graph.incoming[node.id as usize] {
            let edge = &graph.edges[*edge_idx];
            if !edge.control {
                targets.push(EndpointTarget {
                    endpoint: node.id,
                    endpoint_port: edge.to_port.clone(),
                    edge: Some(*edge_idx),
                    depth: edge_depth(graph, node_depth, *edge_idx),
                    group: node.name.clone(),
                    kind: EndpointKind::Blackbox,
                    bit: 0,
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
        .filter(|idx| !graph.edges[*idx].control)
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

/// Follow a top-level output backwards through unconditional, zero-depth data
/// buffers. Returns the driving register and the register-side net bit only
/// when there is exactly one data predecessor at every step.
fn direct_register_driver(graph: &Graph, output: NodeId) -> Option<(NodeId, Option<u32>)> {
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
        if driver.kind == NodeKind::Cell && driver.seq && !driver.blackbox {
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

fn control_role(pin: &str) -> ControlRole {
    match pin.to_ascii_uppercase().as_str() {
        "CLK" | "C" => ControlRole::Clock,
        "R" | "RST" | "ARST" | "SRST" | "CLR" | "LSR" => ControlRole::Reset,
        "S" | "SET" | "PRE" | "SR" => ControlRole::Set,
        "E" | "EN" | "CE" => ControlRole::Enable,
        _ => ControlRole::Other,
    }
}

fn is_labeled_control_edge(graph: &Graph, edge: &Edge) -> bool {
    if !edge.control {
        return false;
    }
    match control_role(&edge.to_port) {
        ControlRole::Clock | ControlRole::Reset | ControlRole::Set => true,
        ControlRole::Enable => {
            graph.outgoing[edge.from as usize]
                .iter()
                .filter(|idx| {
                    let candidate = &graph.edges[**idx];
                    candidate.control && control_role(&candidate.to_port) == ControlRole::Enable
                })
                .count()
                >= 8
        }
        ControlRole::Other => false,
    }
}

fn node_controls(graph: &Graph, node_id: NodeId) -> Vec<ControlRef> {
    let mut controls = Vec::new();
    for edge_idx in &graph.incoming[node_id as usize] {
        let edge = &graph.edges[*edge_idx];
        if !is_labeled_control_edge(graph, edge) {
            continue;
        }
        let role = control_role(&edge.to_port);
        let net = edge.net_name.to_ascii_lowercase();
        let active_low =
            (matches!(
                role,
                ControlRole::Reset | ControlRole::Set | ControlRole::Enable
            ) && (net.ends_with("_n") || net.ends_with("_b") || edge.to_port.ends_with('N')))
            .then_some(true);
        let generated =
            (role == ControlRole::Clock).then(|| !is_simple_control_source(graph, edge.from));
        controls.push(ControlRef {
            role,
            pin: edge.to_port.clone(),
            net_name: edge.net_name.clone(),
            driver_id: edge.from,
            active_low,
            generated,
        });
    }
    controls.sort_by_key(|control| {
        (
            match control.role {
                ControlRole::Clock => 0,
                ControlRole::Reset => 1,
                ControlRole::Set => 2,
                ControlRole::Enable => 3,
                ControlRole::Other => 4,
            },
            control.net_name.clone(),
        )
    });
    controls.dedup_by(|a, b| {
        a.role == b.role && a.net_name == b.net_name && a.driver_id == b.driver_id
    });
    controls
}

fn is_simple_control_source(graph: &Graph, start: NodeId) -> bool {
    let mut current = start;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        let node = &graph.nodes[current as usize];
        if node.kind == NodeKind::PortBit
            && matches!(
                node.port_dir,
                Some(PortDirection::Input | PortDirection::Inout)
            )
        {
            return true;
        }
        let transparent = node
            .cell_type
            .as_deref()
            .is_some_and(is_infrastructure_cell);
        if node.kind != NodeKind::Cell || !transparent {
            return false;
        }
        let mut incoming = graph.incoming[current as usize]
            .iter()
            .map(|idx| graph.edges[*idx].from);
        let Some(next) = incoming.next() else {
            return false;
        };
        if incoming.next().is_some() {
            return false;
        }
        current = next;
    }
    false
}

fn should_hide_edge(graph: &Graph, edge: &Edge, hide_control: bool, hide_const: bool) -> bool {
    (hide_control && is_labeled_control_edge(graph, edge))
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

fn collapse_infrastructure(graph: &Graph, subgraph: Subgraph) -> Subgraph {
    let hidden: HashSet<NodeId> = subgraph
        .nodes
        .iter()
        .filter(|node| node.is_root != Some(true))
        .filter_map(|node| {
            let cell_type = graph.nodes[node.node.id as usize].cell_type.as_deref()?;
            is_infrastructure_cell(cell_type).then_some(node.node.id)
        })
        .collect();
    if hidden.is_empty() {
        return subgraph;
    }

    let mut outgoing: HashMap<NodeId, Vec<&GraphEdge>> = HashMap::new();
    for edge in &subgraph.edges {
        outgoing.entry(edge.from).or_default().push(edge);
    }

    let mut projected = Vec::new();
    for edge in subgraph
        .edges
        .iter()
        .filter(|edge| !hidden.contains(&edge.from))
    {
        let mut queue = VecDeque::from([(edge.clone(), HashSet::new())]);
        while let Some((current, mut visited)) = queue.pop_front() {
            if !hidden.contains(&current.to) {
                projected.push(current);
                continue;
            }
            if !visited.insert(current.to) {
                continue;
            }
            for next in outgoing.get(&current.to).into_iter().flatten() {
                let mut combined = GraphEdge {
                    from: current.from,
                    to: next.to,
                    from_port: current.from_port.clone(),
                    to_port: next.to_port.clone(),
                    net_name: next.net_name.clone(),
                    bits: next.bits.clone(),
                    control: (current.control == Some(true) || next.control == Some(true))
                        .then_some(true),
                };
                if combined.bits.is_empty() {
                    combined.bits = current.bits.clone();
                }
                queue.push_back((combined, visited.clone()));
            }
        }
    }

    let mut merged: BTreeMap<(NodeId, NodeId, String, String, String, bool), GraphEdge> =
        BTreeMap::new();
    for edge in projected {
        let key = (
            edge.from,
            edge.to,
            edge.from_port.clone(),
            edge.to_port.clone(),
            edge.net_name.clone(),
            edge.control == Some(true),
        );
        let entry = merged.entry(key).or_insert_with(|| GraphEdge {
            bits: Vec::new(),
            ..edge.clone()
        });
        entry.bits.extend(edge.bits);
        entry.bits.sort_unstable();
        entry.bits.dedup();
    }

    Subgraph {
        nodes: subgraph
            .nodes
            .into_iter()
            .filter(|node| !hidden.contains(&node.node.id))
            .collect(),
        edges: merged.into_values().collect(),
        truncated: subgraph.truncated,
    }
}

fn build_stats(
    graph: &Graph,
    endpoints: &EndpointsResponse,
    endpoint_targets: &[EndpointTarget],
    best_pred: &[Option<usize>],
) -> Stats {
    let mut cells_by_type = BTreeMap::new();
    let mut cell_categories = CellCategoryCounts::default();
    for node in &graph.nodes {
        if node.kind == NodeKind::Cell {
            let cell_type = node.cell_type.clone().unwrap_or_default();
            *cells_by_type.entry(cell_type.clone()).or_insert(0) += 1;
            if node.seq && !node.blackbox {
                cell_categories.registers += 1;
            } else if is_infrastructure_cell(&cell_type) {
                cell_categories.infrastructure += 1;
            } else if is_carry_or_special(&cell_type) {
                cell_categories.carry_special += 1;
            } else {
                cell_categories.logic += 1;
            }
        }
    }
    let num_register_bits = endpoints.registers.iter().map(|group| group.width).sum();
    let num_inputs = endpoints.inputs.iter().map(|group| group.width).sum();
    let num_outputs = graph
        .nodes
        .iter()
        .filter(|node| {
            node.kind == NodeKind::PortBit
                && matches!(
                    node.port_dir,
                    Some(PortDirection::Output | PortDirection::Inout)
                )
        })
        .count();
    let max_depth = endpoint_targets
        .iter()
        .map(|target| target.depth)
        .max()
        .unwrap_or_default();
    let mut depths = DepthSummary::default();
    for target in endpoint_targets {
        let startpoint = node_ref(graph, target_startpoint_id(graph, best_pred, target));
        match classify_path(&startpoint, target.kind) {
            PathClass::InputToRegister => update_max(&mut depths.input_to_register, target.depth),
            PathClass::RegisterToRegister => {
                update_max(&mut depths.register_to_register, target.depth)
            }
            PathClass::RegisterToOutput => update_max(&mut depths.register_to_output, target.depth),
            PathClass::InputToOutput => update_max(&mut depths.input_to_output, target.depth),
            PathClass::Other => {}
        }
    }
    Stats {
        num_cells: cells_by_type.values().sum(),
        cells_by_type,
        num_register_bits,
        num_register_groups: endpoints.registers.len(),
        num_inputs,
        num_outputs,
        max_depth,
        depths,
        cell_categories,
    }
}

fn target_startpoint_id(
    graph: &Graph,
    best_pred: &[Option<usize>],
    target: &EndpointTarget,
) -> NodeId {
    let Some(edge_idx) = target.edge else {
        return target.endpoint;
    };
    let mut current = graph.edges[edge_idx].from;
    while graph.is_comb(current) {
        let Some(pred_edge) = best_pred[current as usize] else {
            break;
        };
        current = graph.edges[pred_edge].from;
    }
    current
}

fn update_max(slot: &mut Option<u32>, value: u32) {
    *slot = Some(slot.map_or(value, |current| current.max(value)));
}

fn is_carry_or_special(cell_type: &str) -> bool {
    matches!(
        cell_type.to_ascii_uppercase().as_str(),
        "CCU2C"
            | "CARRY4"
            | "CARRY8"
            | "SB_CARRY"
            | "XORCY"
            | "MUXCY"
            | "MUXF7"
            | "MUXF8"
            | "MUXF9"
            | "PFUMX"
            | "L6MUX21"
    )
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
        insert_src_lines(src, |file, line| {
            by_line
                .entry(format!("{file}:{line}"))
                .or_default()
                .push(node.id);
        });
    }
    for ids in by_line.values_mut() {
        ids.sort_unstable();
        ids.dedup();
    }
    SourceMapResponse { files, by_line }
}

fn insert_src_lines(mut src: &str, mut insert: impl FnMut(&str, usize)) {
    while !src.is_empty() {
        let (loc, rest) = src
            .split_once('|')
            .map_or((src, ""), |(loc, rest)| (loc, rest));
        if let Some((file, start, end)) = parse_src_loc(loc) {
            for line in start..=end.min(start + 199) {
                insert(&file, line);
            }
        }
        src = rest;
    }
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

fn register_q_name(graph: &Graph, net: u32) -> Option<&str> {
    let aliases = graph.net_aliases.get(&net)?;
    let mut best: Option<&str> = None;
    for candidate in aliases {
        let raw_candidate = candidate.as_str();
        let candidate = raw_candidate
            .strip_prefix("$iopadmap$")
            .filter(|name| !name.is_empty())
            .unwrap_or(raw_candidate);
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
    best.or_else(|| graph.net_names.get(&net).map(String::as_str))
}

fn bracket_depth(name: &str) -> usize {
    name.as_bytes().iter().filter(|byte| **byte == b'[').count()
}

fn bit_index_from_name(name: &str) -> Option<usize> {
    name.rsplit_once('[')?.1.strip_suffix(']')?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Edge, Graph, Node, NodeKind};
    use crate::netlist::{PortDirection, parse_str, select_top};
    use std::time::Instant;

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
        let alias = q
            .output_aliases
            .iter()
            .find(|alias| alias.name == "q")
            .expect("direct top-level registered output should be grouped with q");
        assert_eq!(alias.bits.len(), 8);
        assert!(
            analysis
                .endpoints
                .outputs
                .iter()
                .all(|output| output.name != "q")
        );
        assert_eq!(analysis.stats.depths.input_to_register, Some(1));
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

    #[test]
    fn analysis_handles_deep_comb_chain_without_recursive_scc_stack() {
        let depth = 200_000usize;
        let graph = deep_chain_graph(depth);
        let started = Instant::now();
        let analysis = Analysis::new(&graph, vec!["deep_chain.sv".to_owned()]);
        assert!(started.elapsed().as_secs() < 10);
        assert!(analysis.comb_loops.is_empty());
        assert_eq!(analysis.stats.max_depth, depth as u32);
    }

    fn deep_chain_graph(depth: usize) -> Graph {
        let node_count = depth + 2;
        let mut nodes = Vec::with_capacity(node_count);
        nodes.push(Node {
            id: 0,
            kind: NodeKind::PortBit,
            name: "in".to_owned(),
            raw_name: "in".to_owned(),
            cell_type: None,
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: Some("in".to_owned()),
            port_bit: Some(0),
            port_dir: Some(PortDirection::Input),
            const_value: None,
        });
        for idx in 0..depth {
            let id = (idx + 1) as NodeId;
            nodes.push(Node {
                id,
                kind: NodeKind::Cell,
                name: format!("buf_{idx}"),
                raw_name: format!("buf_{idx}"),
                cell_type: Some("$buf".to_owned()),
                seq: false,
                blackbox: false,
                src: None,
                params: BTreeMap::new(),
                port: None,
                port_bit: None,
                port_dir: None,
                const_value: None,
            });
        }
        let output_id = (depth + 1) as NodeId;
        nodes.push(Node {
            id: output_id,
            kind: NodeKind::PortBit,
            name: "out".to_owned(),
            raw_name: "out".to_owned(),
            cell_type: None,
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: Some("out".to_owned()),
            port_bit: Some(0),
            port_dir: Some(PortDirection::Output),
            const_value: None,
        });

        let mut edges = Vec::with_capacity(depth + 1);
        let mut outgoing = vec![Vec::new(); node_count];
        let mut incoming = vec![Vec::new(); node_count];
        for idx in 0..=depth {
            let from = idx as NodeId;
            let to = (idx + 1) as NodeId;
            let edge_idx = edges.len();
            edges.push(Edge {
                from,
                to,
                from_port: if idx == 0 { "in" } else { "Y" }.to_owned(),
                to_port: if idx == depth { "out" } else { "A" }.to_owned(),
                bit: Some(idx as u32),
                net_name: format!("n{idx}"),
                control: false,
            });
            outgoing[from as usize].push(edge_idx);
            incoming[to as usize].push(edge_idx);
        }

        Graph {
            nodes,
            edges,
            outgoing,
            incoming,
            top: "deep_chain".to_owned(),
            net_names: HashMap::new(),
            net_aliases: HashMap::new(),
            cell_info: HashMap::new(),
            blackboxes: Vec::new(),
        }
    }
}
