use crate::graph::{
    Edge, Graph, NodeId, NodeKind, cell_depth_weight, is_addressable_sequential_type,
    is_infrastructure_cell, is_register_type, is_transparent_data_buffer, strip_bit_suffix,
};
use crate::netlist::{PortDirection, YosysModule};
use serde::Serialize;
use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

const PATH_NODE_CAP: usize = 512;
const PATH_RECONSTRUCTION_NODE_BUDGET: usize = 65_536;
pub const MAX_SUBGRAPH_NODES: usize = 2_000;
pub const MAX_SUBGRAPH_EDGES: usize = 10_000;
pub(crate) const SOURCE_ROOT_COLLECTION_CAP: usize = MAX_SUBGRAPH_NODES + 1;

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
    pub register: Option<bool>,
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
    pub fanout: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_low: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub synchronous: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
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
    pub truncated: bool,
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

    pub fn extend_lines(&mut self, lines: impl IntoIterator<Item = String>) {
        self.lines.extend(lines);
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

struct DepthComputation {
    node_depth: Vec<Option<u32>>,
    best_pred: Vec<Option<usize>>,
    node_startpoint: Vec<Option<NodeId>>,
}

#[derive(Debug, Clone)]
pub struct Analysis {
    pub node_depth: Vec<Option<u32>>,
    pub best_pred: Vec<Option<usize>>,
    pub comb_loops: Vec<NodeId>,
    pub endpoints: EndpointsResponse,
    endpoint_targets: Vec<EndpointTarget>,
    source_map: SourceMapResponse,
    synthetic_src: HashMap<NodeId, BTreeSet<String>>,
    stats: Stats,
    warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct EndpointTarget {
    endpoint: NodeId,
    endpoint_port: String,
    edge: Option<usize>,
    startpoint: NodeId,
    depth: u32,
    group: String,
    kind: EndpointKind,
    bit: usize,
}

type PathGroupKey = (String, EndpointKind, PathClass, u32, String, Vec<String>);

impl Analysis {
    pub fn new(graph: &Graph, source_files: Vec<String>) -> Self {
        let comb_loops = find_comb_loops(graph);
        let loop_set: HashSet<NodeId> = comb_loops.iter().copied().collect();
        let DepthComputation {
            node_depth,
            best_pred,
            node_startpoint,
        } = compute_depths(graph, &loop_set);
        let (endpoints, endpoint_targets) =
            discover_endpoints(graph, &node_depth, &node_startpoint);
        let source_map = build_source_map(graph, source_files);
        let stats = build_stats(graph, &endpoints, &endpoint_targets);
        let warnings = build_warnings(graph, &comb_loops);
        Self {
            node_depth,
            best_pred,
            comb_loops,
            endpoints,
            endpoint_targets,
            source_map,
            synthetic_src: HashMap::new(),
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

    pub fn extend_source_roots(&mut self, roots_by_line: BTreeMap<String, Vec<NodeId>>) {
        for (line, mut roots) in roots_by_line {
            roots.sort_unstable();
            roots.dedup();
            roots.truncate(SOURCE_ROOT_COLLECTION_CAP);
            for root in &roots {
                self.synthetic_src
                    .entry(*root)
                    .or_default()
                    .insert(line.clone());
            }
            let ids = self.source_map.by_line.entry(line).or_default();
            ids.extend(roots);
            ids.sort_unstable();
            ids.dedup();
        }
    }

    pub fn node_ref(&self, graph: &Graph, id: NodeId) -> NodeRef {
        let mut reference = node_ref(graph, id);
        let Some(synthetic) = self.synthetic_src.get(&id) else {
            return reference;
        };
        let mut sources: BTreeSet<String> = reference
            .src
            .as_deref()
            .into_iter()
            .flat_map(|src| src.split('|'))
            .map(str::to_owned)
            .collect();
        sources.extend(synthetic.iter().cloned());
        reference.src =
            (!sources.is_empty()).then(|| sources.into_iter().collect::<Vec<_>>().join("|"));
        reference
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
        let mut ids = BTreeSet::new();
        for line in start_line..=end_line {
            if let Some(line_ids) = self.source_map.by_line.get(&format!("{file}:{line}")) {
                for id in line_ids {
                    ids.insert(*id);
                    if ids.len() == SOURCE_ROOT_COLLECTION_CAP {
                        return Some(ids.into_iter().collect());
                    }
                }
            }
        }
        Some(ids.into_iter().collect())
    }

    pub fn paths(&self, graph: &Graph, limit: usize, to: Option<NodeId>) -> PathsResponse {
        const TARGETS_PER_GROUP_CAP: usize = 64;
        let candidate_cap = limit.max(1).saturating_mul(16).min(8000);
        let mut total_targets = 0;
        let mut grouped_targets: HashMap<(EndpointKind, &str), Vec<&EndpointTarget>> =
            HashMap::new();
        for target in self
            .endpoint_targets
            .iter()
            .filter(|target| to.is_none_or(|id| target.endpoint == id))
        {
            total_targets += 1;
            let group = grouped_targets
                .entry((target.kind, target.group.as_str()))
                .or_default();
            if group.len() < TARGETS_PER_GROUP_CAP {
                group.push(target);
                continue;
            }
            let worst = group
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| compare_target_rank(a, b))
                .map(|(index, _)| index)
                .expect("a capped target group is not empty");
            if compare_target_rank(target, group[worst]) == Ordering::Less {
                group[worst] = target;
            }
        }

        let mut target_groups: Vec<((EndpointKind, &str), Vec<&EndpointTarget>)> =
            grouped_targets.into_iter().collect();
        for (_, targets) in &mut target_groups {
            targets.sort_by(|a, b| compare_target_rank(a, b));
        }
        target_groups.sort_by(|(a_key, a), (b_key, b)| {
            Reverse(a[0].depth)
                .cmp(&Reverse(b[0].depth))
                .then_with(|| a_key.cmp(b_key))
        });

        // Give every deepest logical endpoint a representative before spending
        // the bounded budget on additional bit/route variants. Extra targets
        // are selected round-robin so a single wide vector cannot crowd out
        // other groups.
        let represented_groups = target_groups.len().min(candidate_cap);
        let mut candidates = Vec::with_capacity(candidate_cap);
        for (_, targets) in target_groups.iter().take(represented_groups) {
            candidates.push(targets[0]);
        }
        let mut bit_index = 1;
        while candidates.len() < candidate_cap {
            let mut added = false;
            for (_, targets) in target_groups.iter().take(represented_groups) {
                let Some(target) = targets.get(bit_index) else {
                    continue;
                };
                candidates.push(*target);
                added = true;
                if candidates.len() == candidate_cap {
                    break;
                }
            }
            if !added {
                break;
            }
            bit_index += 1;
        }

        let alias_lookup = build_alias_lookup(&self.endpoints);
        let mut grouped: BTreeMap<PathGroupKey, PathEntry> = BTreeMap::new();
        let mut route_clipped = false;
        let mut reconstruction_budget = PATH_RECONSTRUCTION_NODE_BUDGET;
        let mut reconstructed_candidates = 0;
        for target in &candidates {
            if reconstruction_budget < 2 {
                route_clipped = true;
                break;
            }
            let per_path_cap = PATH_NODE_CAP.min(reconstruction_budget);
            let (path, clipped, consumed_nodes) =
                self.path_for_target(graph, target, per_path_cap, &alias_lookup);
            reconstruction_budget = reconstruction_budget.saturating_sub(consumed_nodes);
            reconstructed_candidates += 1;
            route_clipped |= clipped;
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
                path.endpoint_port.clone(),
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
        let grouped_count = paths.len();
        paths.truncate(limit);
        PathsResponse {
            paths,
            comb_loops: self
                .comb_loops
                .iter()
                .map(|id| graph.node_ref_name(*id))
                .collect(),
            truncated: route_clipped
                || reconstructed_candidates < candidates.len()
                || candidates.len() < total_targets
                || grouped_count > limit,
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

        let cap = options.max_nodes.clamp(1, MAX_SUBGRAPH_NODES);
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
                        if !included_roots.contains(&id)
                            && graph.is_boundary(id)
                            && !is_addressable_sequential_node(graph, id)
                        {
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
                    if traversal.dir == ConeDir::Fanin
                        && is_addressable_sequential_node(graph, frame.id)
                        && !included_roots.contains(&frame.id)
                        && !is_depth_input_edge(graph, edge)
                    {
                        continue;
                    }
                    if traversal.dir == ConeDir::Fanout
                        && is_addressable_sequential_node(graph, frame.id)
                        && !included_roots.contains(&frame.id)
                        && !is_depth_output_edge(graph, edge)
                    {
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
                    let stop_at_state_input = traversal.dir == ConeDir::Fanout
                        && is_addressable_sequential_node(graph, next)
                        && !is_depth_input_edge(graph, edge);
                    let stop_at_fixed_state_output = traversal.dir == ConeDir::Fanin
                        && is_addressable_sequential_node(graph, next)
                        && !is_depth_output_edge(graph, edge);
                    if stop_at_state_input || stop_at_fixed_state_output {
                        boundary_nodes.insert(next);
                    } else if traversal.seen.insert(next) {
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
        let cap = max_nodes.clamp(1, MAX_SUBGRAPH_NODES);
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
                driver: self.node_ref(graph, driver_id),
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

    fn path_for_target(
        &self,
        graph: &Graph,
        target: &EndpointTarget,
        node_cap: usize,
        alias_lookup: &RegisterAliasLookup<'_>,
    ) -> (PathEntry, bool, usize) {
        debug_assert!(node_cap >= 2);
        let mut node_ids = vec![target.endpoint];
        let mut clipped = false;
        if let Some(edge_idx) = target.edge {
            let mut downstream_edge = edge_idx;
            let mut current = graph.edges[edge_idx].from;
            loop {
                if node_ids.len() >= node_cap {
                    clipped = true;
                    break;
                }
                node_ids.push(current);
                if !is_depth_node(graph, current)
                    || !is_depth_output_edge(graph, &graph.edges[downstream_edge])
                {
                    break;
                }
                let Some(pred_edge) = self.best_pred[current as usize] else {
                    break;
                };
                downstream_edge = pred_edge;
                current = graph.edges[pred_edge].from;
            }
        }
        let consumed_nodes = node_ids.len();
        if clipped && node_ids.last().copied() != Some(target.startpoint) {
            *node_ids
                .last_mut()
                .expect("an endpoint path always contains its endpoint") = target.startpoint;
        }
        node_ids.reverse();
        let nodes: Vec<NodeRef> = node_ids
            .iter()
            .filter(|id| {
                **id == target.startpoint
                    || **id == target.endpoint
                    || graph.nodes[**id as usize]
                        .cell_type
                        .as_deref()
                        .is_none_or(|cell_type| !is_infrastructure_cell(cell_type))
            })
            .map(|id| self.node_ref(graph, *id))
            .collect();
        let startpoint = self.node_ref(graph, target.startpoint);
        let endpoint = self.node_ref(graph, target.endpoint);
        let class = classify_path(&startpoint, target.kind);
        let output_aliases = if target.kind == EndpointKind::Register {
            aliases_for_register_bit(alias_lookup, &target.group, target.bit)
        } else {
            Vec::new()
        };
        (
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
            },
            clipped,
            consumed_nodes,
        )
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
                    node: self.node_ref(graph, id),
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
        edges.sort_by(|a, b| compare_raw_edges(a, b));
        let (edges, edges_truncated) = merge_edges(edges);
        let subgraph = Subgraph {
            nodes,
            edges,
            truncated: projection.truncated || edges_truncated,
        };
        let projected = if projection.show_infrastructure {
            subgraph
        } else {
            collapse_infrastructure(graph, subgraph)
        };
        cap_subgraph_edges(projected)
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

fn compare_target_rank(a: &EndpointTarget, b: &EndpointTarget) -> Ordering {
    Reverse(a.depth)
        .cmp(&Reverse(b.depth))
        .then_with(|| a.bit.cmp(&b.bit))
        .then_with(|| a.endpoint.cmp(&b.endpoint))
        .then_with(|| a.endpoint_port.cmp(&b.endpoint_port))
}

fn classify_path(startpoint: &NodeRef, endpoint_kind: EndpointKind) -> PathClass {
    let starts_at_register = startpoint.register == Some(true);
    let starts_at_input = startpoint.kind == ApiNodeKind::Port;
    match (starts_at_register, starts_at_input, endpoint_kind) {
        (true, _, EndpointKind::Register) => PathClass::RegisterToRegister,
        (_, true, EndpointKind::Register) => PathClass::InputToRegister,
        (true, _, EndpointKind::Output) => PathClass::RegisterToOutput,
        (_, true, EndpointKind::Output) => PathClass::InputToOutput,
        _ => PathClass::Other,
    }
}

type RegisterAliasLookup<'a> =
    HashMap<(&'a str, usize), Vec<(&'a OutputAlias, &'a OutputAliasBit)>>;

fn build_alias_lookup(endpoints: &EndpointsResponse) -> RegisterAliasLookup<'_> {
    let mut lookup: RegisterAliasLookup<'_> = HashMap::new();
    for group in &endpoints.registers {
        for alias in &group.output_aliases {
            for bit in &alias.bits {
                lookup
                    .entry((group.name.as_str(), bit.register_bit))
                    .or_default()
                    .push((alias, bit));
            }
        }
    }
    lookup
}

fn aliases_for_register_bit(
    lookup: &RegisterAliasLookup<'_>,
    register_group: &str,
    register_bit: usize,
) -> Vec<OutputAlias> {
    let Some(entries) = lookup.get(&(register_group, register_bit)) else {
        return Vec::new();
    };
    let mut aliases: BTreeMap<(&str, usize), Vec<OutputAliasBit>> = BTreeMap::new();
    for (alias, bit) in entries {
        aliases
            .entry((alias.name.as_str(), alias.width))
            .or_default()
            .push((*bit).clone());
    }
    aliases
        .into_iter()
        .map(|((name, width), mut bits)| {
            bits.sort_by_key(|bit| (bit.register_bit, bit.output_bit));
            bits.dedup_by_key(|bit| (bit.register_bit, bit.output_bit));
            OutputAlias {
                name: name.to_owned(),
                width,
                bits,
            }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
        register: (node.kind == NodeKind::Cell && node.seq).then_some(is_register_node(node)),
        src: node.src.clone(),
    }
}

fn is_register_node(node: &crate::graph::Node) -> bool {
    node.kind == NodeKind::Cell
        && node.seq
        && !node.blackbox
        && node.cell_type.as_deref().is_some_and(is_register_type)
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

fn compute_depths(graph: &Graph, loop_set: &HashSet<NodeId>) -> DepthComputation {
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
    let mut startpoint = vec![None; graph.nodes.len()];

    while let Some(id) = queue.pop_front() {
        let weight = graph.nodes[id as usize]
            .cell_type
            .as_deref()
            .map(cell_depth_weight)
            .unwrap_or(1);
        let mut best: Option<(u32, usize, NodeId)> = None;
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
        }
        let (node_depth, pred, origin) = best.unwrap_or((weight, usize::MAX, id));
        depth[id as usize] = Some(node_depth);
        startpoint[id as usize] = Some(origin);
        if pred != usize::MAX {
            best_pred[id as usize] = Some(pred);
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

    DepthComputation {
        node_depth: depth,
        best_pred,
        node_startpoint: startpoint,
    }
}

fn is_addressable_sequential_node(graph: &Graph, id: NodeId) -> bool {
    graph.nodes.get(id as usize).is_some_and(|node| {
        node.cell_type
            .as_deref()
            .is_some_and(is_addressable_sequential_type)
    })
}

fn is_depth_node(graph: &Graph, id: NodeId) -> bool {
    graph.is_comb(id) || is_addressable_sequential_node(graph, id)
}

fn is_depth_input_edge(graph: &Graph, edge: &Edge) -> bool {
    if !is_addressable_sequential_node(graph, edge.to) {
        return true;
    }
    edge.to_port
        .strip_prefix('A')
        .is_some_and(|suffix| suffix.chars().all(|ch| ch.is_ascii_digit()))
}

fn is_depth_output_edge(graph: &Graph, edge: &Edge) -> bool {
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

fn discover_endpoints(
    graph: &Graph,
    node_depth: &[Option<u32>],
    node_startpoint: &[Option<NodeId>],
) -> (EndpointsResponse, Vec<EndpointTarget>) {
    let mut targets = Vec::new();
    let mut register_map: BTreeMap<String, RegisterGroup> = BTreeMap::new();
    let mut register_bits: HashMap<(NodeId, Option<u32>), (String, usize)> = HashMap::new();

    for node in &graph.nodes {
        if !is_register_node(node) {
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
        let data_edges = endpoint_data_edges(graph, node.id, info, q_width);
        for (bit_idx, edge) in data_edges.into_iter().enumerate() {
            let display_bit = info
                .q_bits
                .get(bit_idx)
                .and_then(|bit| bit.net())
                .and_then(|net| register_q_name(graph, net))
                .and_then(bit_index_from_name)
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
        for edge_idx in &graph.incoming[node.id as usize] {
            let edge = &graph.edges[*edge_idx];
            if !edge.control
                && (!is_addressable_sequential_node(graph, node.id)
                    || !is_depth_input_edge(graph, edge))
            {
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

fn endpoint_data_edges(
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

fn endpoint_startpoint_id(
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
    if is_depth_node(graph, pred) && is_depth_output_edge(graph, &graph.edges[edge_idx]) {
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
        "E" | "EN" | "CE" | "G" | "GE" => ControlRole::Enable,
        _ => ControlRole::Other,
    }
}

fn is_labeled_control_edge(graph: &Graph, edge: &Edge) -> bool {
    if !edge.control {
        return false;
    }
    match control_role(&edge.to_port) {
        ControlRole::Clock | ControlRole::Reset | ControlRole::Set => true,
        ControlRole::Enable => graph.signal_fanout(edge) >= 8,
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
        let node = &graph.nodes[node_id as usize];
        let cell_type = node.cell_type.as_deref();
        let active_low =
            control_active_low(cell_type, &node.params, role, &edge.to_port, &edge.net_name);
        let generated = matches!(
            role,
            ControlRole::Clock | ControlRole::Reset | ControlRole::Set
        )
        .then(|| !is_simple_control_source(graph, edge.from));
        let fanout = graph.signal_fanout(edge);
        let synchronous = control_synchronous(cell_type, role);
        controls.push(ControlRef {
            role,
            pin: edge.to_port.clone(),
            net_name: edge.net_name.clone(),
            driver_id: edge.from,
            fanout,
            active_low,
            synchronous,
            src: graph.nodes[edge.from as usize].src.clone(),
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

fn control_synchronous(cell_type: Option<&str>, role: ControlRole) -> Option<bool> {
    if !matches!(role, ControlRole::Reset | ControlRole::Set) {
        return None;
    }
    let upper = cell_type?.to_ascii_uppercase();
    if upper.starts_with("$_SDFF")
        || matches!(
            upper.as_str(),
            "$SDFF" | "$SDFFE" | "$SDFFCE" | "FDRE" | "FDRE_1" | "FDSE" | "FDSE_1"
        )
    {
        return Some(true);
    }
    if upper.starts_with("$_DFF_")
        || upper.starts_with("$_DFFE_")
        || upper.starts_with("$_DFFSR_")
        || upper.starts_with("$_DFFSRE_")
        || upper.starts_with("$_ALDFF_")
        || upper.starts_with("$_ALDFFE_")
        || upper.starts_with("$_DLATCH")
        || matches!(
            upper.as_str(),
            "$ADFF"
                | "$ADFFE"
                | "$ALDFF"
                | "$ALDFFE"
                | "$DFFSR"
                | "$DFFSRE"
                | "$ADLATCH"
                | "$DLATCHSR"
                | "FDCE"
                | "FDCE_1"
                | "FDPE"
                | "FDPE_1"
                | "FDCPE"
                | "LDCE"
                | "LDPE"
                | "LDCPE"
        )
    {
        return Some(false);
    }
    None
}

fn control_active_low(
    cell_type: Option<&str>,
    params: &BTreeMap<String, String>,
    role: ControlRole,
    pin: &str,
    net_name: &str,
) -> Option<bool> {
    if let Some(cell_type) = cell_type
        && let Some(encoded) = hard_cell_control_active_low(cell_type, role)
    {
        return Some(encoded);
    }
    if let Some(polarity) = parameter_control_active_low(params, role, pin) {
        return Some(polarity);
    }
    if let Some(polarity) = fixed_primitive_control_active_low(cell_type?, role, pin) {
        return Some(polarity);
    }
    let net = net_name.to_ascii_lowercase();
    (matches!(
        role,
        ControlRole::Reset | ControlRole::Set | ControlRole::Enable
    ) && (net.ends_with("_n") || net.ends_with("_b") || pin.to_ascii_uppercase().ends_with('N')))
    .then_some(true)
}

fn parameter_control_active_low(
    params: &BTreeMap<String, String>,
    role: ControlRole,
    pin: &str,
) -> Option<bool> {
    let upper_pin = pin.to_ascii_uppercase();
    let inverted_key = format!("IS_{upper_pin}_INVERTED");
    if let Some(inverted) = binary_parameter_bool(params.get(&inverted_key)) {
        return Some(inverted);
    }
    let key = match (role, upper_pin.as_str()) {
        (ControlRole::Reset, "ARST") => "ARST_POLARITY",
        (ControlRole::Reset, "SRST") => "SRST_POLARITY",
        (ControlRole::Reset, "CLR") => "CLR_POLARITY",
        (ControlRole::Set, "SET" | "PRE") => "SET_POLARITY",
        (ControlRole::Enable, _) => "EN_POLARITY",
        _ => return None,
    };
    binary_parameter_bool(params.get(key)).map(|active_high| !active_high)
}

fn binary_parameter_bool(value: Option<&String>) -> Option<bool> {
    match value.map(String::as_str) {
        Some("0") => Some(false),
        Some("1") => Some(true),
        _ => None,
    }
}

fn fixed_primitive_control_active_low(
    cell_type: &str,
    role: ControlRole,
    pin: &str,
) -> Option<bool> {
    let cell = cell_type.to_ascii_uppercase();
    let pin = pin.to_ascii_uppercase();
    if role == ControlRole::Clock && pin == "C" {
        if matches!(cell.as_str(), "FDRE_1" | "FDSE_1" | "FDCE_1" | "FDPE_1") {
            return Some(true);
        }
        if matches!(
            cell.as_str(),
            "FDRE" | "FDSE" | "FDCE" | "FDPE" | "FDCPE" | "FDR" | "FDS" | "FDC" | "FDP"
        ) {
            return Some(false);
        }
    }
    let fixed_active_high = matches!(
        (cell.as_str(), role, pin.as_str()),
        (
            "FDRE" | "FDRE_1" | "FDCE" | "FDCE_1" | "FDCPE" | "FDR" | "FDC",
            ControlRole::Reset,
            "R" | "CLR"
        ) | (
            "FDSE" | "FDSE_1" | "FDPE" | "FDPE_1" | "FDCPE" | "FDS" | "FDP",
            ControlRole::Set,
            "S" | "PRE"
        ) | ("LDCE" | "LDCPE", ControlRole::Reset, "CLR")
            | ("LDPE" | "LDCPE", ControlRole::Set, "PRE")
            | (
                "FDRE"
                    | "FDRE_1"
                    | "FDCE"
                    | "FDCE_1"
                    | "FDSE"
                    | "FDSE_1"
                    | "FDPE"
                    | "FDPE_1"
                    | "FDCPE"
                    | "LDCE"
                    | "LDPE"
                    | "LDCPE",
                ControlRole::Enable,
                "CE" | "G" | "GE"
            )
    ) || (cell.starts_with("SB_DFF")
        && ((matches!(role, ControlRole::Reset | ControlRole::Set)
            && matches!(pin.as_str(), "R" | "S"))
            || (role == ControlRole::Enable && pin == "E")));
    fixed_active_high.then_some(false)
}

fn hard_cell_control_active_low(cell_type: &str, role: ControlRole) -> Option<bool> {
    let upper = cell_type.to_ascii_uppercase();
    let inner = upper.strip_prefix("$_")?.strip_suffix('_')?;
    let (family, flags) = inner.split_once('_')?;
    let flags = flags.as_bytes();
    let polarity = match (family, role) {
        (_, ControlRole::Clock) => flags.first(),
        ("DFF", ControlRole::Reset)
        | ("DFFE", ControlRole::Reset)
        | ("SDFF", ControlRole::Reset)
        | ("SDFFE", ControlRole::Reset)
        | ("SDFFCE", ControlRole::Reset)
        | ("DLATCH", ControlRole::Reset) => flags.get(1),
        ("DFFSR" | "DFFSRE" | "DLATCHSR", ControlRole::Set) => flags.get(1),
        ("DFFSR" | "DFFSRE" | "DLATCHSR", ControlRole::Reset) => flags.get(2),
        ("DFFE", ControlRole::Enable) if flags.len() == 2 => flags.get(1),
        ("DFFE", ControlRole::Enable) => flags.get(3),
        ("SDFFE" | "SDFFCE" | "DFFSRE", ControlRole::Enable) => flags.last(),
        ("DLATCH", ControlRole::Enable) => flags.first(),
        _ => None,
    }?;
    match polarity {
        b'N' => Some(true),
        b'P' => Some(false),
        _ => None,
    }
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

fn merge_edges(edges: Vec<&Edge>) -> (Vec<GraphEdge>, bool) {
    let mut merged: BTreeMap<(NodeId, NodeId, String, String), GraphEdge> = BTreeMap::new();
    let mut truncated = false;
    for edge in edges {
        let key = (
            edge.from,
            edge.to,
            edge.from_port.clone(),
            edge.to_port.clone(),
        );
        if !merged.contains_key(&key) && merged.len() == MAX_SUBGRAPH_EDGES {
            truncated = true;
            break;
        }
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
        }
        if edge.control {
            entry.control = Some(true);
        }
    }
    (
        merged
            .into_values()
            .map(|mut edge| {
                edge.bits.sort_unstable();
                edge.bits.dedup();
                edge
            })
            .collect(),
        truncated,
    )
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

    let mut merged: BTreeMap<(NodeId, NodeId, String, String, String, bool), GraphEdge> =
        BTreeMap::new();
    let mut truncated = subgraph.truncated;
    let mut projection_work = 0usize;
    'sources: for edge in subgraph
        .edges
        .iter()
        .filter(|edge| !hidden.contains(&edge.from))
    {
        projection_work += 1;
        if projection_work > MAX_SUBGRAPH_EDGES {
            truncated = true;
            break;
        }
        let mut queue = VecDeque::from([(edge.clone(), HashSet::new())]);
        while let Some((current, mut visited)) = queue.pop_front() {
            if !hidden.contains(&current.to) {
                let key = (
                    current.from,
                    current.to,
                    current.from_port.clone(),
                    current.to_port.clone(),
                    current.net_name.clone(),
                    current.control == Some(true),
                );
                if !merged.contains_key(&key) && merged.len() == MAX_SUBGRAPH_EDGES {
                    truncated = true;
                    break 'sources;
                }
                let entry = merged.entry(key).or_insert_with(|| GraphEdge {
                    bits: Vec::new(),
                    ..current.clone()
                });
                entry.bits.extend(current.bits);
                continue;
            }
            if !visited.insert(current.to) {
                continue;
            }
            for next in outgoing.get(&current.to).into_iter().flatten() {
                projection_work += 1;
                if projection_work > MAX_SUBGRAPH_EDGES {
                    truncated = true;
                    break 'sources;
                }
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

    Subgraph {
        nodes: subgraph
            .nodes
            .into_iter()
            .filter(|node| !hidden.contains(&node.node.id))
            .collect(),
        edges: merged
            .into_values()
            .map(|mut edge| {
                edge.bits.sort_unstable();
                edge.bits.dedup();
                edge
            })
            .collect(),
        truncated,
    }
}

fn compare_raw_edges(a: &Edge, b: &Edge) -> Ordering {
    (
        a.from,
        a.to,
        a.from_port.as_str(),
        a.to_port.as_str(),
        a.net_name.as_str(),
        a.control,
        a.bit,
    )
        .cmp(&(
            b.from,
            b.to,
            b.from_port.as_str(),
            b.to_port.as_str(),
            b.net_name.as_str(),
            b.control,
            b.bit,
        ))
}

fn compare_graph_edges(a: &GraphEdge, b: &GraphEdge) -> Ordering {
    (
        a.from,
        a.to,
        a.from_port.as_str(),
        a.to_port.as_str(),
        a.net_name.as_str(),
        a.control,
        a.bits.as_slice(),
    )
        .cmp(&(
            b.from,
            b.to,
            b.from_port.as_str(),
            b.to_port.as_str(),
            b.net_name.as_str(),
            b.control,
            b.bits.as_slice(),
        ))
}

fn cap_subgraph_edges(mut subgraph: Subgraph) -> Subgraph {
    subgraph.edges.sort_by(compare_graph_edges);
    if subgraph.edges.len() > MAX_SUBGRAPH_EDGES {
        subgraph.edges.truncate(MAX_SUBGRAPH_EDGES);
        subgraph.truncated = true;
    }
    subgraph
}

fn build_stats(
    graph: &Graph,
    endpoints: &EndpointsResponse,
    endpoint_targets: &[EndpointTarget],
) -> Stats {
    let mut cells_by_type = BTreeMap::new();
    let mut cell_categories = CellCategoryCounts::default();
    for node in &graph.nodes {
        if node.kind == NodeKind::Cell {
            let cell_type = node.cell_type.clone().unwrap_or_default();
            *cells_by_type.entry(cell_type.clone()).or_insert(0) += 1;
            if is_register_node(node) {
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
        let startpoint = node_ref(graph, target.startpoint);
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
            | "SRL16E"
            | "SRLC32E"
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
            let ids = by_line.entry(format!("{file}:{line}")).or_default();
            if ids.len() < SOURCE_ROOT_COLLECTION_CAP && ids.last() != Some(&node.id) {
                ids.push(node.id);
            }
        });
    }
    for ids in by_line.values_mut() {
        ids.sort_unstable();
        ids.dedup();
        ids.truncate(SOURCE_ROOT_COLLECTION_CAP);
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
    use crate::graph::{CellInfo, Edge, Graph, Node, NodeKind};
    use crate::netlist::{PortDirection, YosysBit, parse_str, select_top};
    use std::time::Instant;

    type EdgeSignature = (
        NodeId,
        NodeId,
        String,
        String,
        String,
        Vec<u32>,
        Option<bool>,
    );

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

        let paths = analysis.paths(&graph, 1, None);
        assert!(paths.truncated);
        assert_eq!(paths.paths.len(), 1);
        let path = &paths.paths[0];
        assert_eq!(path.nodes.len(), PATH_NODE_CAP);
        assert_eq!(path.startpoint.id, 0);
        assert_eq!(path.endpoint.id, (depth + 1) as NodeId);
        assert_eq!(
            path.nodes.first().map(|node| node.id),
            Some(path.startpoint.id)
        );
        assert_eq!(
            path.nodes.last().map(|node| node.id),
            Some(path.endpoint.id)
        );
    }

    #[test]
    fn path_sampling_represents_deepest_logical_groups_before_extra_bits() {
        let graph = register_bank_graph(30, 64);
        let analysis = Analysis::new(&graph, vec!["register_bank.sv".to_owned()]);

        let paths = analysis.paths(&graph, 25, None);
        let groups: HashSet<_> = paths
            .paths
            .iter()
            .map(|path| path.endpoint_group.as_str())
            .collect();
        assert_eq!(paths.paths.len(), 25);
        assert_eq!(groups.len(), 25);
        assert!(paths.truncated);
    }

    #[test]
    fn wide_register_endpoint_discovery_is_near_linear() {
        let width = 20_000;
        let graph = register_bank_graph(1, width);
        let started = Instant::now();
        let analysis = Analysis::new(&graph, vec!["wide_register.sv".to_owned()]);

        assert!(started.elapsed().as_secs() < 5);
        assert_eq!(analysis.endpoints.registers.len(), 1);
        assert_eq!(analysis.endpoints.registers[0].bits.len(), width);
        assert_eq!(
            analysis.endpoints.registers[0].bits[width - 1].bit,
            width - 1
        );
    }

    #[test]
    fn wide_bus_edges_merge_once_and_remain_deterministic() {
        let width = 20_000u32;
        let edges: Vec<Edge> = (0..width)
            .rev()
            .map(|bit| Edge {
                from: 0,
                to: 1,
                from_port: "Y".to_owned(),
                to_port: "D".to_owned(),
                bit: Some(bit),
                net_name: "wide_bus".to_owned(),
                control: false,
            })
            .collect();
        let started = Instant::now();
        let (merged, truncated) = merge_edges(edges.iter().collect());

        assert!(started.elapsed().as_secs() < 5);
        assert!(!truncated);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].bits.len(), width as usize);
        assert_eq!(merged[0].bits.first(), Some(&0));
        assert_eq!(merged[0].bits.last(), Some(&(width - 1)));
    }

    #[test]
    fn dense_subgraphs_enforce_the_merged_edge_cap_deterministically() {
        let graph = dense_dag_graph(150);
        let analysis = Analysis::new(&graph, vec!["dense.sv".to_owned()]);

        let first = analysis.full_netlist(&graph, MAX_SUBGRAPH_NODES, true);
        let second = analysis.full_netlist(&graph, MAX_SUBGRAPH_NODES, true);

        assert_eq!(first.edges.len(), MAX_SUBGRAPH_EDGES);
        assert!(first.truncated);
        assert_eq!(edge_signature(&first), edge_signature(&second));
    }

    #[test]
    fn infrastructure_projection_caps_intermediate_work_and_output() {
        let (graph, subgraph) = branching_infrastructure_subgraph(100, 101);

        let first = cap_subgraph_edges(collapse_infrastructure(&graph, subgraph.clone()));
        let second = cap_subgraph_edges(collapse_infrastructure(&graph, subgraph));

        assert!(first.truncated);
        assert!(first.edges.len() <= MAX_SUBGRAPH_EDGES);
        assert_eq!(edge_signature(&first), edge_signature(&second));
    }

    #[test]
    fn path_reconstruction_obeys_the_shared_node_budget() {
        let graph = deep_register_bank_graph(400, 256);
        let analysis = Analysis::new(&graph, vec!["deep_bank.sv".to_owned()]);

        let paths = analysis.paths(&graph, 500, None);
        let reconstructed_nodes: usize = paths.paths.iter().map(|path| path.nodes.len()).sum();
        let groups: HashSet<_> = paths
            .paths
            .iter()
            .map(|path| path.endpoint_group.as_str())
            .collect();

        assert!(paths.truncated);
        assert!(paths.paths.len() < 400);
        assert_eq!(groups.len(), paths.paths.len());
        assert!(reconstructed_nodes <= PATH_RECONSTRUCTION_NODE_BUDGET);
    }

    #[test]
    fn source_range_roots_use_a_sentinel_and_propagate_truncation() {
        let graph = sourced_node_graph(SOURCE_ROOT_COLLECTION_CAP + 500);
        let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);
        let roots = analysis.source_nodes_range("source.sv", 1, 1).unwrap();

        assert_eq!(roots.len(), SOURCE_ROOT_COLLECTION_CAP);
        assert_eq!(roots.first(), Some(&0));
        assert_eq!(roots.last(), Some(&(MAX_SUBGRAPH_NODES as NodeId)));

        let envelope = analysis
            .envelope(
                &graph,
                &roots,
                ConeOptions {
                    dir: ConeDir::Fanin,
                    max_depth: 64,
                    max_nodes: 400,
                    hide_control: true,
                    hide_const: true,
                    show_infrastructure: true,
                },
            )
            .unwrap();
        assert_eq!(envelope.nodes.len(), 400);
        assert!(envelope.truncated);
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
            signal_fanout: HashMap::new(),
        }
    }

    fn register_bank_graph(groups: usize, width: usize) -> Graph {
        let mut nodes = Vec::with_capacity(groups + 1);
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

        let mut edges = Vec::with_capacity(groups * width);
        let mut outgoing = vec![Vec::new(); groups + 1];
        let mut incoming = vec![Vec::new(); groups + 1];
        let mut net_aliases = HashMap::new();
        let mut cell_info = HashMap::new();
        let d_bits: Vec<YosysBit> = (0..width)
            .map(|bit| YosysBit::Net((bit + 1) as u32))
            .collect();

        for group in 0..groups {
            let id = (group + 1) as NodeId;
            nodes.push(Node {
                id,
                kind: NodeKind::Cell,
                name: format!("q{group}"),
                raw_name: format!("q{group}"),
                cell_type: Some("$dff".to_owned()),
                seq: true,
                blackbox: false,
                src: None,
                params: BTreeMap::new(),
                port: None,
                port_bit: None,
                port_dir: None,
                const_value: None,
            });

            let q_bits: Vec<YosysBit> = (0..width)
                .map(|bit| {
                    let net = 1_000_000 + group * width + bit;
                    net_aliases.insert(net as u32, vec![format!("q{group}[{bit}]")]);
                    YosysBit::Net(net as u32)
                })
                .collect();
            for bit in 0..width {
                let edge_idx = edges.len();
                edges.push(Edge {
                    from: 0,
                    to: id,
                    from_port: "in".to_owned(),
                    to_port: "D".to_owned(),
                    bit: Some((bit + 1) as u32),
                    net_name: format!("d[{bit}]"),
                    control: false,
                });
                outgoing[0].push(edge_idx);
                incoming[id as usize].push(edge_idx);
            }
            cell_info.insert(
                id,
                CellInfo {
                    q_bits,
                    d_bits: d_bits.clone(),
                    clock_net: None,
                    output_ports: HashSet::from(["Q".to_owned()]),
                    input_ports: HashSet::from(["D".to_owned()]),
                },
            );
        }

        Graph {
            nodes,
            edges,
            outgoing,
            incoming,
            top: "register_bank".to_owned(),
            net_names: HashMap::new(),
            net_aliases,
            cell_info,
            blackboxes: Vec::new(),
            signal_fanout: HashMap::new(),
        }
    }

    fn dense_dag_graph(node_count: usize) -> Graph {
        let nodes = (0..node_count)
            .map(|id| combinational_node(id as NodeId, "$and", None))
            .collect();
        let mut edges = Vec::new();
        let mut outgoing = vec![Vec::new(); node_count];
        let mut incoming = vec![Vec::new(); node_count];
        let mut from = 0;
        while from < node_count {
            let mut to = from + 1;
            while to < node_count {
                let edge_idx = edges.len();
                edges.push(Edge {
                    from: from as NodeId,
                    to: to as NodeId,
                    from_port: "Y".to_owned(),
                    to_port: "A".to_owned(),
                    bit: Some(edge_idx as u32),
                    net_name: format!("n{from}_{to}"),
                    control: false,
                });
                outgoing[from].push(edge_idx);
                incoming[to].push(edge_idx);
                to += 1;
            }
            from += 1;
        }
        graph_from_parts("dense", nodes, edges, outgoing, incoming)
    }

    fn branching_infrastructure_subgraph(
        hidden_count: usize,
        sink_count: usize,
    ) -> (Graph, Subgraph) {
        let node_count = 1 + hidden_count + sink_count;
        let mut nodes = Vec::with_capacity(node_count);
        nodes.push(combinational_node(0, "$and", None));
        for id in 1..=hidden_count {
            nodes.push(combinational_node(id as NodeId, "OBUF", None));
        }
        for id in (hidden_count + 1)..node_count {
            nodes.push(combinational_node(id as NodeId, "$and", None));
        }
        let graph = graph_from_parts(
            "projection",
            nodes,
            Vec::new(),
            vec![Vec::new(); node_count],
            vec![Vec::new(); node_count],
        );
        let projected_nodes = graph
            .nodes
            .iter()
            .map(|node| GraphNode {
                node: node_ref(&graph, node.id),
                is_root: None,
                is_boundary: None,
                depth: None,
                params: BTreeMap::new(),
                controls: Vec::new(),
            })
            .collect();
        let mut edges = Vec::new();
        for hidden in 1..=hidden_count {
            edges.push(GraphEdge {
                from: 0,
                to: hidden as NodeId,
                from_port: "Y".to_owned(),
                to_port: "I".to_owned(),
                net_name: format!("to_hidden_{hidden}"),
                bits: vec![hidden as u32],
                control: None,
            });
            for sink in 0..sink_count {
                let sink_id = (hidden_count + 1 + sink) as NodeId;
                edges.push(GraphEdge {
                    from: hidden as NodeId,
                    to: sink_id,
                    from_port: "O".to_owned(),
                    to_port: "A".to_owned(),
                    net_name: format!("h{hidden}_s{sink}"),
                    bits: vec![(hidden * sink_count + sink) as u32],
                    control: None,
                });
            }
        }
        (
            graph,
            Subgraph {
                nodes: projected_nodes,
                edges,
                truncated: false,
            },
        )
    }

    fn deep_register_bank_graph(groups: usize, depth: usize) -> Graph {
        let node_count = 1 + depth + groups;
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
        for id in 1..=depth {
            nodes.push(combinational_node(id as NodeId, "$and", None));
        }
        for group in 0..groups {
            let id = (depth + 1 + group) as NodeId;
            nodes.push(Node {
                id,
                kind: NodeKind::Cell,
                name: format!("q{group}"),
                raw_name: format!("q{group}"),
                cell_type: Some("$dff".to_owned()),
                seq: true,
                blackbox: false,
                src: None,
                params: BTreeMap::new(),
                port: None,
                port_bit: None,
                port_dir: None,
                const_value: None,
            });
        }

        let mut edges = Vec::new();
        let mut outgoing = vec![Vec::new(); node_count];
        let mut incoming = vec![Vec::new(); node_count];
        for step in 0..depth {
            add_test_edge(
                &mut edges,
                &mut outgoing,
                &mut incoming,
                step as NodeId,
                (step + 1) as NodeId,
                step as u32,
            );
        }
        let mut net_aliases = HashMap::new();
        let mut cell_info = HashMap::new();
        for group in 0..groups {
            let id = (depth + 1 + group) as NodeId;
            let data_net = depth.saturating_sub(1) as u32;
            add_test_edge(
                &mut edges,
                &mut outgoing,
                &mut incoming,
                depth as NodeId,
                id,
                data_net,
            );
            let q_net = 1_000_000 + group as u32;
            net_aliases.insert(q_net, vec![format!("q{group}[0]")]);
            cell_info.insert(
                id,
                CellInfo {
                    q_bits: vec![YosysBit::Net(q_net)],
                    d_bits: vec![YosysBit::Net(data_net)],
                    clock_net: None,
                    output_ports: HashSet::from(["Q".to_owned()]),
                    input_ports: HashSet::from(["D".to_owned()]),
                },
            );
        }
        let mut graph = graph_from_parts("deep_bank", nodes, edges, outgoing, incoming);
        graph.net_aliases = net_aliases;
        graph.cell_info = cell_info;
        graph
    }

    fn sourced_node_graph(node_count: usize) -> Graph {
        let nodes = (0..node_count)
            .map(|id| combinational_node(id as NodeId, "$and", Some("source.sv:1")))
            .collect();
        graph_from_parts(
            "sourced",
            nodes,
            Vec::new(),
            vec![Vec::new(); node_count],
            vec![Vec::new(); node_count],
        )
    }

    fn combinational_node(id: NodeId, cell_type: &str, src: Option<&str>) -> Node {
        Node {
            id,
            kind: NodeKind::Cell,
            name: format!("n{id}"),
            raw_name: format!("n{id}"),
            cell_type: Some(cell_type.to_owned()),
            seq: false,
            blackbox: false,
            src: src.map(str::to_owned),
            params: BTreeMap::new(),
            port: None,
            port_bit: None,
            port_dir: None,
            const_value: None,
        }
    }

    fn add_test_edge(
        edges: &mut Vec<Edge>,
        outgoing: &mut [Vec<usize>],
        incoming: &mut [Vec<usize>],
        from: NodeId,
        to: NodeId,
        bit: u32,
    ) {
        let edge_idx = edges.len();
        edges.push(Edge {
            from,
            to,
            from_port: "Y".to_owned(),
            to_port: if to as usize + 1 == outgoing.len() {
                "D".to_owned()
            } else {
                "A".to_owned()
            },
            bit: Some(bit),
            net_name: format!("n{bit}"),
            control: false,
        });
        outgoing[from as usize].push(edge_idx);
        incoming[to as usize].push(edge_idx);
    }

    fn graph_from_parts(
        top: &str,
        nodes: Vec<Node>,
        edges: Vec<Edge>,
        outgoing: Vec<Vec<usize>>,
        incoming: Vec<Vec<usize>>,
    ) -> Graph {
        Graph {
            nodes,
            edges,
            outgoing,
            incoming,
            top: top.to_owned(),
            net_names: HashMap::new(),
            net_aliases: HashMap::new(),
            cell_info: HashMap::new(),
            blackboxes: Vec::new(),
            signal_fanout: HashMap::new(),
        }
    }

    fn edge_signature(subgraph: &Subgraph) -> Vec<EdgeSignature> {
        subgraph
            .edges
            .iter()
            .map(|edge| {
                (
                    edge.from,
                    edge.to,
                    edge.from_port.clone(),
                    edge.to_port.clone(),
                    edge.net_name.clone(),
                    edge.bits.clone(),
                    edge.control,
                )
            })
            .collect()
    }
}
