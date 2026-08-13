use super::controls::{is_labeled_control_edge, node_controls};
use super::depth::{is_addressable_sequential_node, is_depth_input_edge, is_depth_output_edge};
use super::{
    Analysis, ApiNodeKind, BoundaryMember, ConeDir, ConeOptions, ControlRef, ControlRole,
    EdgeBoundaryMember, FULL_NETLIST_CONTEXT_NODE_BUDGET, FullNetlistOptions, GraphEdge, GraphNode,
    GroupExpansion, GroupExpansionBoundaryTrunk, GroupExpansionOptions, MAX_FULL_GROUP_MEMBERS,
    MAX_FULL_NETLIST_EDGE_VISITS, MAX_GROUP_EXPANSION_EDGE_VISITS, MAX_GROUP_EXPANSION_NODES,
    MAX_SUBGRAPH_EDGE_BITS, MAX_SUBGRAPH_EDGES, MAX_SUBGRAPH_NODES, NodeRef, ProjectedEdgeKey,
    Subgraph,
};
use crate::graph::{
    Edge, Graph, NodeId, NodeKind, is_infrastructure_cell, is_register_type,
    is_transparent_data_buffer, strip_bit_suffix,
};
use crate::grouping::{GroupId, GroupKind, GroupPartition, GroupingProjection};
use crate::netlist::PortDirection;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, Default)]
pub(super) struct BoundaryElectricalProvenance {
    pub(super) source_bits: Option<Vec<u32>>,
    pub(super) target_bits: Option<Vec<u32>>,
}

/// Private projection state whose provenance entries are index-aligned with
/// `subgraph.edges`. Public ungrouped responses discard the sidecar unchanged;
/// grouped quotient projection consumes it before returning a `Subgraph`.
#[derive(Debug, Clone)]
pub(super) struct ProjectedSubgraph {
    pub(super) subgraph: Subgraph,
    pub(super) boundary_electrical: Vec<Option<Box<BoundaryElectricalProvenance>>>,
}

impl ProjectedSubgraph {
    fn new(
        subgraph: Subgraph,
        boundary_electrical: Vec<Option<Box<BoundaryElectricalProvenance>>>,
    ) -> Self {
        assert_eq!(
            subgraph.edges.len(),
            boundary_electrical.len(),
            "every projected edge must have one provenance sidecar slot"
        );
        Self {
            subgraph,
            boundary_electrical,
        }
    }

    pub(super) fn into_public(self) -> Subgraph {
        self.subgraph
    }
}

impl From<Subgraph> for ProjectedSubgraph {
    fn from(subgraph: Subgraph) -> Self {
        let boundary_electrical = (0..subgraph.edges.len()).map(|_| None).collect();
        Self::new(subgraph, boundary_electrical)
    }
}

impl std::ops::Deref for ProjectedSubgraph {
    type Target = Subgraph;

    fn deref(&self) -> &Self::Target {
        &self.subgraph
    }
}
pub(super) struct SubgraphProjection<'a> {
    pub(super) roots: &'a HashSet<NodeId>,
    pub(super) protected_nodes: &'a HashSet<NodeId>,
    pub(super) boundary_nodes: &'a HashSet<NodeId>,
    pub(super) truncated: bool,
    pub(super) hidden_control_ports: Option<&'a HashSet<NodeId>>,
    pub(super) show_infrastructure: bool,
    pub(super) max_control_edge_visits: Option<usize>,
}
pub(super) struct Traversal {
    pub(super) dir: ConeDir,
    pub(super) seen: HashSet<NodeId>,
    pub(super) queue: VecDeque<TraversalFrame>,
}

#[derive(Clone, Copy, Default)]
pub(super) struct SubgraphWorkLimits {
    pub(super) expand_output_register_inputs: bool,
    pub(super) max_raw_nodes: Option<usize>,
    pub(super) max_raw_edges: Option<usize>,
    pub(super) max_examined_edges: Option<usize>,
}

impl SubgraphWorkLimits {
    pub(super) fn for_public_projection() -> Self {
        Self {
            max_raw_nodes: Some(MAX_SUBGRAPH_NODES),
            max_raw_edges: Some(MAX_SUBGRAPH_EDGES),
            max_examined_edges: Some(MAX_SUBGRAPH_EDGES),
            ..Self::default()
        }
    }

    pub(super) fn for_source_selection(expand_output_register_inputs: bool) -> Self {
        Self {
            expand_output_register_inputs,
            max_raw_nodes: Some(MAX_SUBGRAPH_NODES),
            max_raw_edges: Some(MAX_SUBGRAPH_EDGES),
            max_examined_edges: Some(MAX_SUBGRAPH_EDGES),
        }
    }
}

pub(super) struct TraversalFrame {
    pub(super) id: NodeId,
    pub(super) depth: u32,
    pub(super) next_edge: usize,
}
/// The rendering unit a raw node belongs to: its group's synthetic id
/// (`base + group_id`, where `base = graph.nodes.len()`) when grouped, else the
/// node's own id. Synthetic ids never collide with real ids because real ids
/// are `< base`. With no partition every node is its own unit.
pub(super) fn unit_id(grouping: Option<GroupingProjection<'_>>, base: u32, id: NodeId) -> u32 {
    match grouping.and_then(|projection| projection.group_id(id)) {
        Some(group_id) => base + group_id,
        None => id,
    }
}

/// Bound raw roots before traversal while preserving distinct projected units.
/// Ungrouped roots consume at most half the displayed-unit budget; enabled
/// groups may contribute a stratified representative sample without paying
/// additional displayed units. The remaining budgets stay available for
/// fanin/fanout context.
pub(super) fn bounded_projection_roots(
    roots: &[NodeId],
    grouping: Option<GroupingProjection<'_>>,
    base: u32,
    max_units: usize,
    max_raw_roots: usize,
) -> (Vec<NodeId>, bool) {
    struct Bucket {
        grouped: bool,
        members: Vec<NodeId>,
    }

    let mut buckets = Vec::<Bucket>::new();
    let mut bucket_of = HashMap::<u32, usize>::new();
    let mut unique = HashSet::new();
    for &root in roots {
        if !unique.insert(root) {
            continue;
        }
        let unit = unit_id(grouping, base, root);
        let grouped = unit != root;
        let next = buckets.len();
        let index = *bucket_of.entry(unit).or_insert_with(|| {
            buckets.push(Bucket {
                grouped,
                members: Vec::new(),
            });
            next
        });
        buckets[index].members.push(root);
    }

    let max_root_units = max_units.saturating_div(2).max(1);
    let admitted_bucket_count = buckets.len().min(max_root_units).min(max_raw_roots);
    let admitted_bucket_indices: Vec<usize> = (0..admitted_bucket_count)
        .map(|sample_index| {
            if admitted_bucket_count <= 1 {
                0
            } else {
                sample_index * (buckets.len() - 1) / (admitted_bucket_count - 1)
            }
        })
        .collect();
    let mut bounded = Vec::with_capacity(max_raw_roots.min(roots.len()));
    let mut bounded_seen = HashSet::new();
    for &bucket_index in &admitted_bucket_indices {
        let bucket = &buckets[bucket_index];
        bounded.push(bucket.members[0]);
        bounded_seen.insert(bucket.members[0]);
    }

    let grouped_bucket_indices: Vec<usize> = admitted_bucket_indices
        .iter()
        .copied()
        .filter(|&bucket_index| buckets[bucket_index].grouped)
        .collect();
    let sample_limits: Vec<usize> = grouped_bucket_indices
        .iter()
        .map(|&bucket_index| {
            buckets[bucket_index]
                .members
                .len()
                .min(MAX_FULL_GROUP_MEMBERS)
        })
        .collect();
    let group_sample_budget = grouped_bucket_indices
        .len()
        .saturating_add(max_raw_roots.saturating_sub(bounded.len()));
    let sample_counts = waterfilled_sample_counts(&sample_limits, group_sample_budget);
    let max_sample = sample_counts.iter().copied().max().unwrap_or(0);
    let mut sample_index = 1usize;
    while sample_index < max_sample {
        let mut advanced = false;
        for (index, &bucket_index) in grouped_bucket_indices.iter().enumerate() {
            let bucket = &buckets[bucket_index];
            if bounded.len() >= max_raw_roots {
                continue;
            }
            let target = sample_counts[index];
            if sample_index >= target {
                continue;
            }
            let member_index = sample_index * (bucket.members.len() - 1) / (target - 1);
            let member = bucket.members[member_index];
            bounded.push(member);
            bounded_seen.insert(member);
            advanced = true;
        }
        if bounded.len() >= max_raw_roots || !advanced {
            break;
        }
        sample_index += 1;
    }

    let truncated = admitted_bucket_count < buckets.len()
        || admitted_bucket_indices.iter().any(|&bucket_index| {
            let bucket = &buckets[bucket_index];
            bucket
                .members
                .iter()
                .any(|member| !bounded_seen.contains(member))
        });
    (bounded, truncated)
}

/// Allocate a shared sample budget one position per bucket per round. Each
/// returned count is bounded by its corresponding limit. Callers then
/// stratify against that actual count so a globally capped bucket still spans
/// its entire canonical membership instead of prefix-sampling it.
pub(super) fn waterfilled_sample_counts(limits: &[usize], budget: usize) -> Vec<usize> {
    let mut counts = vec![0usize; limits.len()];
    let mut remaining = budget;
    while remaining > 0 {
        let mut advanced = false;
        for (index, &limit) in limits.iter().enumerate() {
            if counts[index] >= limit || remaining == 0 {
                continue;
            }
            counts[index] += 1;
            remaining -= 1;
            advanced = true;
        }
        if !advanced {
            break;
        }
    }
    counts
}

/// Collapse a per-bit subgraph into its group quotient: every group's member
/// nodes become one synthetic node, edges are re-merged across the resulting
/// unit ids, and intra-group edges vanish. Ungrouped nodes pass through
/// unchanged; a singleton logical-memory group still becomes a synthetic node
/// so its source-level shape remains visible.
/// Runs after infrastructure collapse and edge capping, so synthetic ids are
/// never indexed back into `graph.nodes`.
pub(super) fn quotient_subgraph(
    graph: &Graph,
    projected: impl Into<ProjectedSubgraph>,
    grouping: GroupingProjection<'_>,
) -> Subgraph {
    const MAX_MERGED_SRC_FRAGMENTS: usize = 8;
    let base = graph.nodes.len() as u32;
    let ProjectedSubgraph {
        mut subgraph,
        boundary_electrical,
    } = projected.into();

    struct GroupAcc {
        members: Vec<u32>,
        is_root: bool,
        is_boundary: bool,
        depth: Option<u32>,
        controls: Vec<ControlRef>,
        src_fragments: Vec<String>,
        src_truncated: bool,
    }

    let mut group_accs: BTreeMap<GroupId, GroupAcc> = BTreeMap::new();
    let mut nodes: Vec<GraphNode> = Vec::new();
    for node in std::mem::take(&mut subgraph.nodes) {
        let Some(group_id) = grouping.group_id(node.node.id) else {
            nodes.push(node);
            continue;
        };
        let acc = group_accs.entry(group_id).or_insert_with(|| GroupAcc {
            members: Vec::new(),
            is_root: false,
            is_boundary: false,
            depth: None,
            controls: Vec::new(),
            src_fragments: Vec::new(),
            src_truncated: false,
        });
        acc.members.push(node.node.id);
        acc.is_root |= node.is_root == Some(true);
        acc.is_boundary |= node.is_boundary == Some(true);
        if let Some(depth) = node.depth {
            acc.depth = Some(acc.depth.map_or(depth, |current| current.max(depth)));
        }
        if let Some(src) = node.node.src.as_deref() {
            for fragment in src.split('|') {
                if fragment.is_empty() || acc.src_fragments.iter().any(|kept| kept == fragment) {
                    continue;
                }
                if acc.src_fragments.len() == MAX_MERGED_SRC_FRAGMENTS {
                    acc.src_truncated = true;
                    break;
                } else {
                    acc.src_fragments.push(fragment.to_owned());
                }
            }
        }
        for control in node.controls {
            if !acc.controls.iter().any(|kept| {
                kept.role == control.role
                    && kept.pin == control.pin
                    && kept.net_name == control.net_name
                    && kept.driver_id == control.driver_id
                    && kept.active_low == control.active_low
                    && kept.synchronous == control.synchronous
                    && kept.generated == control.generated
            }) {
                acc.controls.push(control);
            }
        }
    }

    let mut src_truncated = false;
    for (group_id, acc) in group_accs {
        let group = &grouping.partition.groups[group_id as usize];
        let mut members = acc.members;
        members.sort_unstable();
        let register = matches!(group.kind, GroupKind::Register);
        let sequential = matches!(group.kind, GroupKind::Register | GroupKind::Memory);
        let src_fragments = acc.src_fragments;
        src_truncated |= acc.src_truncated;
        let is_root = acc.is_root;
        let is_port = matches!(group.kind, GroupKind::Port);
        let mut boundary_members = if is_port {
            members
                .iter()
                .filter_map(|&member| {
                    let bit = graph.nodes[member as usize].port_bit?;
                    Some(BoundaryMember {
                        member,
                        bit: u32::try_from(bit).expect("validated graph port slots fit in u32"),
                    })
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        boundary_members.sort_by_key(|entry| (entry.bit, entry.member));
        nodes.push(GraphNode {
            node: NodeRef {
                id: base + group_id,
                kind: if is_port {
                    ApiNodeKind::Port
                } else {
                    ApiNodeKind::Cell
                },
                name: group.label.clone(),
                // Port groups contain bits from one named top-level port, whose
                // declaration supplies one direction for every member.
                port_direction: is_port
                    .then_some(())
                    .and_then(|()| group.members.first())
                    .and_then(|id| graph.nodes[*id as usize].port_dir),
                cell_type: (!is_port).then(|| group.cell_type.clone()),
                seq: sequential.then_some(true),
                register: sequential.then(|| register && is_register_type(&group.cell_type)),
                src: (!src_fragments.is_empty()).then(|| src_fragments.join("|")),
            },
            is_root: is_root.then_some(true),
            is_boundary: (!is_root && acc.is_boundary).then_some(true),
            depth: acc.depth,
            params: BTreeMap::new(),
            controls: compact_group_controls(acc.controls),
            width: Some(members.len() as u32),
            member_count: Some(group.members.len() as u32),
            members: Some(members),
            boundary_members,
        });
    }
    nodes.sort_by_key(|node| node.node.id);

    // Re-merge edges across unit ids: intra-group edges (same unit both ends)
    // vanish; parallel bus edges collapse to one carrying every bit.
    struct MergedEdge {
        edge: GraphEdge,
        source_boundary_members: BTreeMap<u32, BTreeSet<u32>>,
        target_boundary_members: BTreeMap<u32, BTreeSet<u32>>,
    }

    let mut merged: BTreeMap<(u32, u32, String, String), MergedEdge> = BTreeMap::new();
    for (edge, provenance) in std::mem::take(&mut subgraph.edges)
        .into_iter()
        .zip(boundary_electrical)
    {
        let from = unit_id(Some(grouping), base, edge.from);
        let to = unit_id(Some(grouping), base, edge.to);
        if from == to {
            continue;
        }
        let key = (from, to, edge.from_port.clone(), edge.to_port.clone());
        let entry = merged.entry(key).or_insert_with(|| MergedEdge {
            edge: GraphEdge {
                from,
                to,
                from_port: edge.from_port.clone(),
                to_port: edge.to_port.clone(),
                // A bus edge carries the vector net, not one bit's `name[k]`.
                net_name: strip_bit_suffix(&edge.net_name).to_owned(),
                bits: Vec::new(),
                control: edge.control,
                source_boundary_members: Vec::new(),
                target_boundary_members: Vec::new(),
            },
            source_boundary_members: BTreeMap::new(),
            target_boundary_members: BTreeMap::new(),
        });
        entry.edge.bits.extend_from_slice(&edge.bits);
        if grouping
            .group(edge.from)
            .is_some_and(|(_, group)| matches!(group.kind, GroupKind::Port))
        {
            entry
                .source_boundary_members
                .entry(edge.from)
                .or_default()
                .extend(
                    provenance
                        .as_deref()
                        .and_then(|provenance| provenance.source_bits.as_deref())
                        .unwrap_or(&edge.bits)
                        .iter()
                        .copied(),
                );
        }
        if grouping
            .group(edge.to)
            .is_some_and(|(_, group)| matches!(group.kind, GroupKind::Port))
        {
            entry
                .target_boundary_members
                .entry(edge.to)
                .or_default()
                .extend(
                    provenance
                        .as_deref()
                        .and_then(|provenance| provenance.target_bits.as_deref())
                        .unwrap_or(&edge.bits)
                        .iter()
                        .copied(),
                );
        }
        if edge.control == Some(true) {
            entry.edge.control = Some(true);
        }
    }
    let edges = merged
        .into_values()
        .map(|mut merged| {
            merged.edge.bits.sort_unstable();
            merged.edge.bits.dedup();
            merged.edge.source_boundary_members = merged
                .source_boundary_members
                .into_iter()
                .map(|(member, net_bits)| EdgeBoundaryMember {
                    member,
                    net_bits: net_bits.into_iter().collect(),
                })
                .collect();
            merged.edge.source_boundary_members.sort_by_key(|entry| {
                (
                    graph.nodes[entry.member as usize]
                        .port_bit
                        .unwrap_or_default(),
                    entry.member,
                )
            });
            merged.edge.target_boundary_members = merged
                .target_boundary_members
                .into_iter()
                .map(|(member, net_bits)| EdgeBoundaryMember {
                    member,
                    net_bits: net_bits.into_iter().collect(),
                })
                .collect();
            merged.edge.target_boundary_members.sort_by_key(|entry| {
                (
                    graph.nodes[entry.member as usize]
                        .port_bit
                        .unwrap_or_default(),
                    entry.member,
                )
            });
            merged.edge
        })
        .collect();

    Subgraph {
        nodes,
        edges,
        truncated: subgraph.truncated || src_truncated,
    }
}

pub(super) fn group_expansion_boundary_trunks(
    expanded: &Subgraph,
    compact_group_id: NodeId,
    members: &HashSet<NodeId>,
) -> Vec<GroupExpansionBoundaryTrunk> {
    let mut by_compact_edge: HashMap<ProjectedEdgeKey, HashSet<ProjectedEdgeKey>> = HashMap::new();
    for edge in &expanded.edges {
        let from_member = members.contains(&edge.from);
        let to_member = members.contains(&edge.to);
        if from_member == to_member {
            continue;
        }
        let compact_edge = ProjectedEdgeKey {
            from: if from_member {
                compact_group_id
            } else {
                edge.from
            },
            to: if to_member { compact_group_id } else { edge.to },
            from_port: edge.from_port.clone(),
            to_port: edge.to_port.clone(),
        };
        by_compact_edge
            .entry(compact_edge)
            .or_default()
            .insert(projected_edge_key(edge));
    }

    let mut trunks = by_compact_edge
        .into_iter()
        .map(|(compact_edge, expanded_edges)| {
            let mut expanded_edges = expanded_edges.into_iter().collect::<Vec<_>>();
            expanded_edges.sort();
            GroupExpansionBoundaryTrunk {
                compact_edge,
                expanded_edges,
            }
        })
        .collect::<Vec<_>>();
    trunks.sort_by(|left, right| left.compact_edge.cmp(&right.compact_edge));
    trunks
}

pub(super) fn projected_edge_key(edge: &GraphEdge) -> ProjectedEdgeKey {
    ProjectedEdgeKey {
        from: edge.from,
        to: edge.to,
        from_port: edge.from_port.clone(),
        to_port: edge.to_port.clone(),
    }
}

/// Collapse repeated per-member control metadata into one row per compatible
/// role/pin/polarity. Grouped memories can contain hundreds of row-enable
/// nets; retaining every label would make one schematic node thousands of
/// pixels tall even though all edges already share the same logical pin.
pub(super) fn compact_group_controls(controls: Vec<ControlRef>) -> Vec<ControlRef> {
    type ControlKey = (
        ControlRole,
        String,
        Option<bool>,
        Option<bool>,
        Option<bool>,
    );
    let mut groups: BTreeMap<ControlKey, Vec<ControlRef>> = BTreeMap::new();
    for control in controls {
        groups
            .entry((
                control.role,
                control.pin.clone(),
                control.active_low,
                control.synchronous,
                control.generated,
            ))
            .or_default()
            .push(control);
    }

    groups
        .into_values()
        .map(|mut controls| {
            controls.sort_by(|a, b| {
                a.net_name
                    .cmp(&b.net_name)
                    .then_with(|| a.driver_id.cmp(&b.driver_id))
            });
            let mut representative = controls.remove(0);
            if controls.is_empty() {
                return representative;
            }
            let mut driver_ids: BTreeSet<NodeId> = BTreeSet::from([representative.driver_id]);
            let mut fanout = representative.fanout;
            let shared_src = representative.src.clone();
            let mut same_src = true;
            for control in &controls {
                driver_ids.insert(control.driver_id);
                fanout = fanout.saturating_add(control.fanout);
                same_src &= control.src == shared_src;
            }
            representative.net_count = Some((controls.len() + 1) as u32);
            representative.driver_ids = driver_ids.into_iter().collect();
            representative.fanout = fanout;
            if !same_src {
                representative.src = None;
            }
            representative
        })
        .collect()
}
pub(super) fn should_hide_edge(
    graph: &Graph,
    edge: &Edge,
    hide_control: bool,
    hide_const: bool,
) -> bool {
    (hide_control && is_labeled_control_edge(graph, edge))
        || (hide_const
            && graph
                .nodes
                .get(edge.from as usize)
                .is_some_and(|node| node.kind == NodeKind::Const))
}

pub(super) fn has_visible_neighbor(
    graph: &Graph,
    id: NodeId,
    dir: ConeDir,
    hide_control: bool,
    hide_const: bool,
    examined_edges: &mut usize,
    max_examined_edges: Option<usize>,
) -> Result<bool, ()> {
    let edges = match dir {
        ConeDir::Fanin => &graph.incoming[id as usize],
        ConeDir::Fanout => &graph.outgoing[id as usize],
    };
    for idx in edges {
        if let Some(limit) = max_examined_edges {
            if *examined_edges >= limit {
                return Err(());
            }
            *examined_edges += 1;
        }
        if !should_hide_edge(graph, &graph.edges[*idx], hide_control, hide_const) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn merge_edges(
    edges: Vec<&Edge>,
    is_labeled_control: impl Fn(&Edge) -> bool,
) -> (Vec<GraphEdge>, bool) {
    let mut merged: BTreeMap<(NodeId, NodeId, String, String), GraphEdge> = BTreeMap::new();
    let mut kept_bit_keys: HashSet<(NodeId, NodeId, &str, &str, u32)> = HashSet::new();
    let mut truncated = false;
    let mut kept_bits = 0usize;
    for edge in edges {
        let labeled_control = is_labeled_control(edge);
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
            control: labeled_control.then_some(true),
            source_boundary_members: Vec::new(),
            target_boundary_members: Vec::new(),
        });
        if let Some(bit) = edge.bit {
            let bit_key = (
                edge.from,
                edge.to,
                edge.from_port.as_str(),
                edge.to_port.as_str(),
                bit,
            );
            if kept_bit_keys.contains(&bit_key) {
                // Duplicate raw occurrences carry no additional payload.
            } else if kept_bits < MAX_SUBGRAPH_EDGE_BITS {
                kept_bit_keys.insert(bit_key);
                entry.bits.push(bit);
                kept_bits += 1;
            } else {
                truncated = true;
            }
        }
        if labeled_control {
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

pub(super) fn collapse_infrastructure(graph: &Graph, subgraph: Subgraph) -> ProjectedSubgraph {
    #[derive(Clone, Copy)]
    struct ProjectionFrame<'a> {
        edge: &'a GraphEdge,
        bits: &'a [u32],
        control: bool,
    }

    struct CollapsedEdge {
        edge: GraphEdge,
        boundary_electrical: Option<Box<BoundaryElectricalProvenance>>,
    }

    let hidden: HashSet<NodeId> = subgraph
        .nodes
        .iter()
        .filter_map(|node| {
            let cell_type = graph.nodes[node.node.id as usize].cell_type.as_deref()?;
            if !is_infrastructure_cell(cell_type) {
                return None;
            }
            // Cone roots are normally kept even when infrastructure, so an
            // explicitly requested node never vanishes. But a transparent data
            // buffer (IBUF/OBUF/BUFG) that a source line happens to map to must
            // still collapse when infrastructure is hidden — it bridges cleanly
            // to the real net, and leaving it visible is exactly the "IBUF shows
            // with infrastructure off" bug.
            if node.is_root == Some(true) && !is_transparent_data_buffer(cell_type) {
                return None;
            }
            Some(node.node.id)
        })
        .collect();
    if hidden.is_empty() {
        return subgraph.into();
    }

    let mut outgoing: HashMap<NodeId, Vec<&GraphEdge>> = HashMap::new();
    for edge in &subgraph.edges {
        outgoing.entry(edge.from).or_default().push(edge);
    }

    let mut merged: BTreeMap<(NodeId, NodeId, String, String, String, bool), CollapsedEdge> =
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
        let mut queue = VecDeque::from([ProjectionFrame {
            edge,
            bits: &edge.bits,
            control: edge.control == Some(true),
        }]);
        let mut seen: HashSet<(NodeId, bool, usize, usize)> = HashSet::new();
        while let Some(current) = queue.pop_front() {
            if !hidden.contains(&current.edge.to) {
                let key = (
                    edge.from,
                    current.edge.to,
                    edge.from_port.clone(),
                    current.edge.to_port.clone(),
                    current.edge.net_name.clone(),
                    current.control,
                );
                if !merged.contains_key(&key) && merged.len() == MAX_SUBGRAPH_EDGES {
                    truncated = true;
                    break 'sources;
                }
                let entry = merged.entry(key).or_insert_with(|| CollapsedEdge {
                    edge: GraphEdge {
                        from: edge.from,
                        to: current.edge.to,
                        from_port: edge.from_port.clone(),
                        to_port: current.edge.to_port.clone(),
                        net_name: current.edge.net_name.clone(),
                        bits: Vec::new(),
                        control: current.control.then_some(true),
                        source_boundary_members: Vec::new(),
                        target_boundary_members: Vec::new(),
                    },
                    boundary_electrical: None,
                });
                entry.edge.bits.extend_from_slice(current.bits);
                if graph.nodes[edge.from as usize].kind == NodeKind::PortBit {
                    entry
                        .boundary_electrical
                        .get_or_insert_with(Default::default)
                        .source_bits
                        .get_or_insert_with(Vec::new)
                        .extend_from_slice(&edge.bits);
                }
                if graph.nodes[current.edge.to as usize].kind == NodeKind::PortBit {
                    entry
                        .boundary_electrical
                        .get_or_insert_with(Default::default)
                        .target_bits
                        .get_or_insert_with(Vec::new)
                        .extend_from_slice(&current.edge.bits);
                }
                continue;
            }
            if !seen.insert((
                current.edge.to,
                current.control,
                current.bits.as_ptr() as usize,
                current.bits.len(),
            )) {
                continue;
            }
            for next in outgoing.get(&current.edge.to).into_iter().flatten() {
                projection_work += 1;
                if projection_work > MAX_SUBGRAPH_EDGES {
                    truncated = true;
                    break 'sources;
                }
                queue.push_back(ProjectionFrame {
                    edge: next,
                    bits: if next.bits.is_empty() {
                        current.bits
                    } else {
                        &next.bits
                    },
                    control: current.control || next.control == Some(true),
                });
            }
        }
    }

    let mut edges = Vec::with_capacity(merged.len());
    let mut boundary_electrical = Vec::with_capacity(merged.len());
    for mut collapsed in merged.into_values() {
        collapsed.edge.bits.sort_unstable();
        collapsed.edge.bits.dedup();
        if let Some(provenance) = collapsed.boundary_electrical.as_deref_mut() {
            if let Some(bits) = &mut provenance.source_bits {
                bits.sort_unstable();
                bits.dedup();
            }
            if let Some(bits) = &mut provenance.target_bits {
                bits.sort_unstable();
                bits.dedup();
            }
        }
        edges.push(collapsed.edge);
        boundary_electrical.push(collapsed.boundary_electrical);
    }

    ProjectedSubgraph::new(
        Subgraph {
            nodes: subgraph
                .nodes
                .into_iter()
                .filter(|node| !hidden.contains(&node.node.id))
                .collect(),
            edges,
            truncated,
        },
        boundary_electrical,
    )
}

pub(super) fn compare_raw_edges(a: &Edge, b: &Edge) -> Ordering {
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

pub(super) fn compare_graph_edges(a: &GraphEdge, b: &GraphEdge) -> Ordering {
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

pub(super) fn cap_subgraph_edges(projected: ProjectedSubgraph) -> ProjectedSubgraph {
    let ProjectedSubgraph {
        mut subgraph,
        boundary_electrical,
    } = projected;
    let mut edges_with_provenance = std::mem::take(&mut subgraph.edges)
        .into_iter()
        .zip(boundary_electrical)
        .collect::<Vec<_>>();
    edges_with_provenance.sort_by(|(left, _), (right, _)| compare_graph_edges(left, right));
    if edges_with_provenance.len() > MAX_SUBGRAPH_EDGES {
        edges_with_provenance.truncate(MAX_SUBGRAPH_EDGES);
        subgraph.truncated = true;
    }
    let mut remaining_bits = MAX_SUBGRAPH_EDGE_BITS;
    for (edge, _) in &mut edges_with_provenance {
        if edge.bits.len() > remaining_bits {
            edge.bits.truncate(remaining_bits);
            subgraph.truncated = true;
        }
        remaining_bits = remaining_bits.saturating_sub(edge.bits.len());
    }
    let (edges, boundary_electrical) = edges_with_provenance.into_iter().unzip();
    subgraph.edges = edges;
    ProjectedSubgraph::new(subgraph, boundary_electrical)
}

impl Analysis {
    pub fn multi_root_cone(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions<'_>,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(
            graph,
            roots,
            &[options.dir],
            options,
            grouping,
            SubgraphWorkLimits::for_public_projection(),
        )
    }

    pub(super) fn multi_root_source_cone(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions,
        grouping: Option<GroupingProjection<'_>>,
        expand_output_register_inputs: bool,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(
            graph,
            roots,
            &[options.dir],
            options,
            grouping,
            SubgraphWorkLimits::for_source_selection(expand_output_register_inputs),
        )
    }

    pub(super) fn multi_root_source_envelope(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        options: ConeOptions,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Option<Subgraph> {
        self.multi_root_subgraph(
            graph,
            roots,
            &[ConeDir::Fanin, ConeDir::Fanout],
            options,
            grouping,
            SubgraphWorkLimits::for_source_selection(false),
        )
    }

    pub(super) fn multi_root_subgraph(
        &self,
        graph: &Graph,
        roots: &[NodeId],
        directions: &[ConeDir],
        options: ConeOptions<'_>,
        grouping: Option<GroupingProjection<'_>>,
        work_limits: SubgraphWorkLimits,
    ) -> Option<Subgraph> {
        if roots
            .iter()
            .any(|root| graph.nodes.get(*root as usize).is_none())
        {
            return None;
        }

        // With grouping the node budget counts distinct group-or-singleton
        // units, not member bits, so a wide bus costs one unit. `seen_units`
        // tracks the paid units; without grouping it mirrors `seen` exactly.
        let base = graph.nodes.len() as u32;
        let cap = options.max_nodes.clamp(1, MAX_SUBGRAPH_NODES);
        let raw_root_cap = work_limits
            .max_raw_nodes
            .unwrap_or(MAX_SUBGRAPH_NODES)
            .saturating_div(2)
            .max(1);
        let (bounded_roots, roots_truncated) =
            bounded_projection_roots(roots, grouping, base, cap, raw_root_cap);
        let mut seen: HashSet<NodeId> = HashSet::new();
        let mut seen_units: HashSet<u32> = HashSet::new();
        let mut unique_roots: HashSet<NodeId> = HashSet::new();
        let mut included_root_ids = Vec::new();
        let mut boundary_nodes: HashSet<NodeId> = HashSet::new();
        let mut edge_set: HashSet<usize> = HashSet::new();
        let mut raw_edges_per_connection: HashMap<(NodeId, NodeId, String, String), usize> =
            HashMap::new();
        let mut expanded_register_inputs: HashSet<NodeId> = HashSet::new();
        let mut examined_edges = 0usize;
        let mut truncated = roots_truncated;

        for root in &bounded_roots {
            if unique_roots.insert(*root) {
                if work_limits
                    .max_raw_nodes
                    .is_some_and(|limit| seen.len() >= limit)
                {
                    truncated = true;
                    continue;
                }
                let unit = unit_id(grouping, base, *root);
                if !seen_units.contains(&unit) && seen_units.len() >= cap {
                    truncated = true;
                    continue;
                }
                seen_units.insert(unit);
                seen.insert(*root);
                included_root_ids.push(*root);
            }
        }

        let included_roots = seen.clone();
        let mut output_register_frontier: HashSet<NodeId> =
            if work_limits.expand_output_register_inputs {
                included_roots
                    .iter()
                    .copied()
                    .filter(|id| {
                        let node = &graph.nodes[*id as usize];
                        (node.kind == NodeKind::PortBit
                            && matches!(
                                node.port_dir,
                                Some(PortDirection::Output | PortDirection::Inout)
                            ))
                            || node
                                .cell_type
                                .as_deref()
                                .is_some_and(is_transparent_data_buffer)
                    })
                    .collect()
            } else {
                HashSet::new()
            };
        let mut traversals: Vec<Traversal> = directions
            .iter()
            .map(|dir| Traversal {
                dir: *dir,
                seen: included_roots.clone(),
                queue: included_root_ids
                    .iter()
                    .copied()
                    .map(|root| TraversalFrame {
                        id: root,
                        depth: 0,
                        next_edge: 0,
                    })
                    .collect(),
            })
            .collect();

        'walk: loop {
            let mut advanced = false;
            for traversal in &mut traversals {
                'frames: while let Some(mut frame) = traversal.queue.pop_front() {
                    if frame.next_edge == 0
                        && !included_roots.contains(&frame.id)
                        && graph.is_boundary(frame.id)
                        && !expanded_register_inputs.contains(&frame.id)
                        && !is_addressable_sequential_node(graph, frame.id)
                    {
                        boundary_nodes.insert(frame.id);
                        continue;
                    }
                    if frame.next_edge == 0 && frame.depth >= options.max_depth {
                        let visible = match has_visible_neighbor(
                            graph,
                            frame.id,
                            traversal.dir,
                            options.hide_control,
                            options.hide_const,
                            &mut examined_edges,
                            work_limits.max_examined_edges,
                        ) {
                            Ok(visible) => visible,
                            Err(()) => {
                                truncated = true;
                                break 'walk;
                            }
                        };
                        if visible {
                            boundary_nodes.insert(frame.id);
                            truncated = true;
                        }
                        continue;
                    }

                    let edge_ids = match traversal.dir {
                        ConeDir::Fanin => &graph.incoming[frame.id as usize],
                        ConeDir::Fanout => &graph.outgoing[frame.id as usize],
                    };
                    let Some(edge_idx) = edge_ids.get(frame.next_edge).copied() else {
                        continue 'frames;
                    };
                    frame.next_edge += 1;
                    let edge = &graph.edges[edge_idx];
                    if let Some(limit) = work_limits.max_examined_edges {
                        if examined_edges >= limit {
                            truncated = true;
                            break 'walk;
                        }
                        examined_edges += 1;
                    }
                    advanced = true;
                    let frame_id = frame.id;
                    let next_depth = frame.depth + 1;
                    if frame.next_edge < edge_ids.len() {
                        traversal.queue.push_back(frame);
                    }
                    let mut selected_root_pin = false;
                    if included_roots.len() == 1
                        && included_roots.contains(&frame_id)
                        && let Some(root_port) = options.root_port
                    {
                        let edge_port = match traversal.dir {
                            ConeDir::Fanin => edge.to_port.as_str(),
                            ConeDir::Fanout => edge.from_port.as_str(),
                        };
                        if edge_port != root_port
                            || options.root_port_bit.is_some_and(|bit| {
                                traversal.dir == ConeDir::Fanin && edge.to_port_bit != bit
                            })
                            || options.root_port_bits.is_some_and(|bits| {
                                traversal.dir == ConeDir::Fanin && !bits.contains(&edge.to_port_bit)
                            })
                        {
                            break 'frames;
                        }
                        selected_root_pin = true;
                    }
                    if !selected_root_pin
                        && should_hide_edge(graph, edge, options.hide_control, options.hide_const)
                    {
                        break 'frames;
                    }
                    if traversal.dir == ConeDir::Fanin
                        && is_addressable_sequential_node(graph, frame_id)
                        && !included_roots.contains(&frame_id)
                        && !is_depth_input_edge(graph, edge)
                    {
                        break 'frames;
                    }
                    if traversal.dir == ConeDir::Fanout
                        && is_addressable_sequential_node(graph, frame_id)
                        && !included_roots.contains(&frame_id)
                        && !is_depth_output_edge(graph, edge)
                    {
                        break 'frames;
                    }
                    if !edge_set.contains(&edge_idx) {
                        let key = (
                            edge.from,
                            edge.to,
                            edge.from_port.clone(),
                            edge.to_port.clone(),
                        );
                        let count = raw_edges_per_connection.entry(key).or_default();
                        if *count >= MAX_FULL_GROUP_MEMBERS {
                            truncated = true;
                            break 'frames;
                        }
                        if work_limits
                            .max_raw_edges
                            .is_some_and(|limit| edge_set.len() >= limit)
                        {
                            truncated = true;
                            break 'walk;
                        }
                        *count += 1;
                    }
                    let next = match traversal.dir {
                        ConeDir::Fanin => edge.from,
                        ConeDir::Fanout => edge.to,
                    };
                    if !seen.contains(&next) {
                        if work_limits
                            .max_raw_nodes
                            .is_some_and(|limit| seen.len() >= limit)
                        {
                            truncated = true;
                            break 'walk;
                        }
                        let unit = unit_id(grouping, base, next);
                        if !seen_units.contains(&unit) && seen_units.len() >= cap {
                            truncated = true;
                            break;
                        }
                        seen_units.insert(unit);
                        seen.insert(next);
                    }
                    if work_limits.expand_output_register_inputs
                        && traversal.dir == ConeDir::Fanin
                        && output_register_frontier.contains(&frame_id)
                    {
                        if graph.nodes[next as usize]
                            .cell_type
                            .as_deref()
                            .is_some_and(is_register_type)
                        {
                            expanded_register_inputs.insert(next);
                        } else if graph.nodes[next as usize]
                            .cell_type
                            .as_deref()
                            .is_some_and(is_transparent_data_buffer)
                        {
                            output_register_frontier.insert(next);
                        }
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
                        traversal.queue.push_back(TraversalFrame {
                            id: next,
                            depth: next_depth,
                            next_edge: 0,
                        });
                    }
                    edge_set.insert(edge_idx);
                    break 'frames;
                }
            }
            if !advanced {
                break;
            }
        }

        // A focused data cone stops at sequential boundaries, but visible
        // registers still need their clock/reset/enable wiring when controls
        // are enabled. Attach one control hop without opening a second data
        // traversal through the boundary.
        if !options.hide_control {
            let mut sequential_nodes: Vec<NodeId> = seen
                .iter()
                .copied()
                .filter(|id| {
                    graph.nodes[*id as usize].seq
                        && !(options.root_port.is_some() && included_roots.contains(id))
                })
                .collect();
            sequential_nodes.sort_unstable();
            'controls: for id in sequential_nodes {
                for edge_idx in graph.incoming[id as usize].iter().copied() {
                    if edge_set.contains(&edge_idx) {
                        continue;
                    }
                    if let Some(limit) = work_limits.max_examined_edges
                        && examined_edges >= limit
                    {
                        truncated = true;
                        break 'controls;
                    }
                    examined_edges += 1;
                    let edge = &graph.edges[edge_idx];
                    if !is_labeled_control_edge(graph, edge)
                        || should_hide_edge(graph, edge, false, options.hide_const)
                    {
                        continue;
                    }
                    let key = (
                        edge.from,
                        edge.to,
                        edge.from_port.clone(),
                        edge.to_port.clone(),
                    );
                    if raw_edges_per_connection.get(&key).copied().unwrap_or(0)
                        >= MAX_FULL_GROUP_MEMBERS
                    {
                        truncated = true;
                        continue;
                    }
                    if work_limits
                        .max_raw_edges
                        .is_some_and(|limit| edge_set.len() >= limit)
                    {
                        truncated = true;
                        break 'controls;
                    }
                    if !seen.contains(&edge.from) {
                        if work_limits
                            .max_raw_nodes
                            .is_some_and(|limit| seen.len() >= limit)
                        {
                            truncated = true;
                            continue;
                        }
                        let unit = unit_id(grouping, base, edge.from);
                        if !seen_units.contains(&unit) && seen_units.len() >= cap {
                            truncated = true;
                            continue;
                        }
                        seen_units.insert(unit);
                        seen.insert(edge.from);
                    }
                    *raw_edges_per_connection.entry(key).or_default() += 1;
                    edge_set.insert(edge_idx);
                }
            }
        }

        let hidden_control_ports = options
            .hide_control
            .then_some(&self.pure_hidden_control_ports);
        let subgraph = self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &included_roots,
                protected_nodes: &included_roots,
                boundary_nodes: &boundary_nodes,
                truncated,
                hidden_control_ports,
                show_infrastructure: options.show_infrastructure,
                max_control_edge_visits: work_limits
                    .max_examined_edges
                    .map(|limit| limit.saturating_sub(examined_edges)),
            },
        );
        Some(match grouping {
            Some(partition) => quotient_subgraph(graph, subgraph, partition),
            None => subgraph.into_public(),
        })
    }

    pub fn full_netlist(
        &self,
        graph: &Graph,
        options: FullNetlistOptions<'_>,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Subgraph {
        if !options.priority_roots.is_empty() {
            return self.context_netlist(graph, options, grouping);
        }
        let base = graph.nodes.len() as u32;
        let cap = options.max_nodes.clamp(1, MAX_SUBGRAPH_NODES);
        let mut seen_units: HashSet<u32> = HashSet::new();

        // A group's members can be non-contiguous, so a full projection scans
        // all nodes. Selection context takes the bounded adjacency path above.
        let mut seen = HashSet::new();
        let mut truncated = false;
        let hidden_control_ports = options
            .hide_control
            .then_some(&self.pure_hidden_control_ports);
        let mut selected_groups: Vec<(GroupId, &crate::grouping::Group)> = Vec::new();
        let mut selected_group_ids = HashSet::new();

        // Logical memories are the highest-value grouping boundary and their
        // mapped DFFs may sort after thousands of helper cells. Reserve one raw
        // representative per memory, but never its whole membership, before
        // admitting other graph units.
        if let Some(projection) = grouping.filter(|projection| projection.memories) {
            for (group_id, group) in projection.partition.groups.iter().enumerate() {
                if group.kind != GroupKind::Memory {
                    continue;
                }
                if seen_units.len() >= cap || seen.len() >= MAX_SUBGRAPH_NODES {
                    truncated = true;
                    continue;
                }
                let unit = base + group_id as u32;
                seen_units.insert(unit);
                if let Some(&first) = group.members.first() {
                    seen.insert(first);
                    selected_group_ids.insert(group_id as GroupId);
                    selected_groups.push((group_id as GroupId, group));
                }
            }
        }

        // First admit distinct display units in graph order. A wide group pays
        // for one representative here, so it cannot consume the raw-node cap
        // before connected singleton/group units have a chance to appear.
        for node in &graph.nodes {
            if options.hide_const && node.kind == NodeKind::Const {
                continue;
            }
            if hidden_control_ports.is_some_and(|ports| ports.contains(&node.id)) {
                continue;
            }
            let unit = unit_id(grouping, base, node.id);
            if seen_units.contains(&unit) {
                continue;
            } else if seen_units.len() < cap && seen.len() < MAX_SUBGRAPH_NODES {
                seen_units.insert(unit);
                seen.insert(node.id);
                if let Some((group_id, group)) =
                    grouping.and_then(|projection| projection.group(node.id))
                    && selected_group_ids.insert(group_id)
                {
                    selected_groups.push((group_id, group));
                }
            } else {
                truncated = true;
            }
        }

        // Distribute additional group representatives round-robin. Evenly
        // spaced indices keep large DFF-backed memories and buses from sampling
        // only their earliest rows/bits, and every selected unit receives one
        // member before any unit receives a second.
        let sample_limits: Vec<usize> = selected_groups
            .iter()
            .map(|(_, group)| group.members.len().min(MAX_FULL_GROUP_MEMBERS))
            .collect();
        let group_sample_budget = selected_groups
            .len()
            .saturating_add(MAX_SUBGRAPH_NODES.saturating_sub(seen.len()));
        let sample_counts = waterfilled_sample_counts(&sample_limits, group_sample_budget);
        let max_sample = sample_counts.iter().copied().max().unwrap_or(0);
        let mut sample_index = 1usize;
        while sample_index < max_sample {
            let mut advanced = false;
            for (index, (_, group)) in selected_groups.iter().enumerate() {
                let target = sample_counts[index];
                if sample_index >= target {
                    continue;
                }
                if seen.len() >= MAX_SUBGRAPH_NODES {
                    truncated = true;
                    break;
                }
                let member_index = sample_index * (group.members.len() - 1) / (target - 1);
                seen.insert(group.members[member_index]);
                advanced = true;
            }
            if seen.len() >= MAX_SUBGRAPH_NODES || !advanced {
                break;
            }
            sample_index += 1;
        }
        truncated |= selected_groups
            .iter()
            .any(|(_, group)| group.members.iter().any(|member| !seen.contains(member)));
        let mut edge_set = HashSet::new();
        let mut raw_edges_per_connection: HashMap<(NodeId, NodeId, String, String), usize> =
            HashMap::new();
        let mut examined_edges = 0usize;
        let mut edge_frontiers: VecDeque<(NodeId, usize)> = graph
            .nodes
            .iter()
            .filter(|node| seen.contains(&node.id) && !graph.outgoing[node.id as usize].is_empty())
            .map(|node| (node.id, 0))
            .collect();
        while let Some((id, next_edge)) = edge_frontiers.pop_front() {
            if examined_edges >= MAX_FULL_NETLIST_EDGE_VISITS {
                truncated = true;
                break;
            }
            let outgoing = &graph.outgoing[id as usize];
            let Some(&idx) = outgoing.get(next_edge) else {
                continue;
            };
            if next_edge + 1 < outgoing.len() {
                edge_frontiers.push_back((id, next_edge + 1));
            }
            examined_edges += 1;
            let edge = &graph.edges[idx];
            if !seen.contains(&edge.to)
                || (options.hide_control && is_labeled_control_edge(graph, edge))
            {
                continue;
            }
            let key = (
                edge.from,
                edge.to,
                edge.from_port.clone(),
                edge.to_port.clone(),
            );
            let count = raw_edges_per_connection.entry(key).or_default();
            if *count >= MAX_FULL_GROUP_MEMBERS {
                truncated = true;
                continue;
            }
            if edge_set.len() >= MAX_SUBGRAPH_EDGES {
                truncated = true;
                break;
            }
            *count += 1;
            edge_set.insert(idx);
        }
        let empty = HashSet::new();
        let subgraph = self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &empty,
                protected_nodes: &empty,
                boundary_nodes: &empty,
                truncated,
                hidden_control_ports,
                show_infrastructure: options.show_infrastructure,
                max_control_edge_visits: Some(
                    MAX_FULL_NETLIST_EDGE_VISITS.saturating_sub(examined_edges),
                ),
            },
        );
        match grouping {
            Some(partition) => quotient_subgraph(graph, subgraph, partition),
            None => subgraph.into_public(),
        }
    }

    /// Bounded undirected context around relevant roots. Unlike a full-netlist
    /// projection this walks only admitted adjacency, so changing selections
    /// does not rescan every graph node and edge or fill spare capacity with an
    /// arbitrary disconnected prefix.
    fn context_netlist(
        &self,
        graph: &Graph,
        options: FullNetlistOptions<'_>,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Subgraph {
        let base = graph.nodes.len() as u32;
        let cap = options.max_nodes.clamp(1, MAX_SUBGRAPH_NODES);
        let (priority_roots, roots_truncated) = bounded_projection_roots(
            options.priority_roots,
            grouping,
            base,
            cap,
            MAX_SUBGRAPH_NODES / 2,
        );
        let protected_nodes: HashSet<NodeId> = priority_roots.iter().copied().collect();
        let mut seen_units = HashSet::new();
        let mut seen = HashSet::new();
        let mut queued = HashSet::new();
        let mut queue = VecDeque::new();
        let mut edge_set = HashSet::new();
        let mut raw_edges_per_connection: HashMap<(NodeId, NodeId, String, String), usize> =
            HashMap::new();
        let mut examined_edges = 0usize;
        let mut truncated = roots_truncated;

        let admit = |id: NodeId,
                     seen_units: &mut HashSet<u32>,
                     seen: &mut HashSet<NodeId>,
                     queued: &mut HashSet<NodeId>,
                     queue: &mut VecDeque<(NodeId, usize)>,
                     truncated: &mut bool| {
            if seen.contains(&id) {
                return true;
            }
            let unit = unit_id(grouping, base, id);
            if (!seen_units.contains(&unit) && seen_units.len() >= cap)
                || seen.len() >= MAX_SUBGRAPH_NODES
            {
                return false;
            }
            seen_units.insert(unit);
            seen.insert(id);
            if queued.len() < FULL_NETLIST_CONTEXT_NODE_BUDGET && queued.insert(id) {
                queue.push_back((id, 0));
            } else if !queued.contains(&id) {
                *truncated = true;
            }
            true
        };

        for root in &priority_roots {
            if graph.nodes.get(*root as usize).is_none()
                || (options.hide_const && graph.nodes[*root as usize].kind == NodeKind::Const)
            {
                continue;
            }
            if !admit(
                *root,
                &mut seen_units,
                &mut seen,
                &mut queued,
                &mut queue,
                &mut truncated,
            ) {
                truncated = true;
                break;
            }
        }

        'context: while let Some((id, next_edge)) = queue.pop_front() {
            let incoming_len = graph.incoming[id as usize].len();
            let edge_idx = if next_edge < incoming_len {
                graph.incoming[id as usize].get(next_edge).copied()
            } else {
                graph.outgoing[id as usize]
                    .get(next_edge - incoming_len)
                    .copied()
            };
            let Some(edge_idx) = edge_idx else {
                continue;
            };
            queue.push_back((id, next_edge + 1));
            if examined_edges >= MAX_FULL_NETLIST_EDGE_VISITS {
                truncated = true;
                break 'context;
            }
            examined_edges += 1;
            let edge = &graph.edges[edge_idx];
            if options.hide_control && is_labeled_control_edge(graph, edge) {
                continue;
            }
            let neighbor = if edge.from == id { edge.to } else { edge.from };
            if options.hide_const && graph.nodes[neighbor as usize].kind == NodeKind::Const {
                continue;
            }
            if !admit(
                neighbor,
                &mut seen_units,
                &mut seen,
                &mut queued,
                &mut queue,
                &mut truncated,
            ) {
                truncated = true;
                continue;
            }
            if seen.contains(&edge.from) && seen.contains(&edge.to) {
                if !edge_set.contains(&edge_idx) {
                    let key = (
                        edge.from,
                        edge.to,
                        edge.from_port.clone(),
                        edge.to_port.clone(),
                    );
                    let count = raw_edges_per_connection.entry(key).or_default();
                    if *count >= MAX_FULL_GROUP_MEMBERS {
                        truncated = true;
                        continue;
                    }
                    if edge_set.len() >= MAX_SUBGRAPH_EDGES {
                        truncated = true;
                        break 'context;
                    }
                    *count += 1;
                }
                edge_set.insert(edge_idx);
            }
        }

        let hidden_control_ports = options
            .hide_control
            .then_some(&self.pure_hidden_control_ports);
        let empty = HashSet::new();
        let subgraph = self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &empty,
                protected_nodes: &protected_nodes,
                boundary_nodes: &empty,
                truncated,
                hidden_control_ports,
                show_infrastructure: options.show_infrastructure,
                max_control_edge_visits: Some(
                    MAX_FULL_NETLIST_EDGE_VISITS.saturating_sub(examined_edges),
                ),
            },
        );
        match grouping {
            Some(partition) => quotient_subgraph(graph, subgraph, partition),
            None => subgraph.into_public(),
        }
    }

    /// Expand one quotient node without disabling grouping elsewhere. Every
    /// physical member is admitted before one-hop context, so an expansion is
    /// complete whenever the canonical group fits under the renderer cap.
    pub fn expand_group(
        &self,
        graph: &Graph,
        partition: &GroupPartition,
        group_id: GroupId,
        options: GroupExpansionOptions,
        grouping: Option<GroupingProjection<'_>>,
    ) -> Option<GroupExpansion> {
        let group = partition.groups.get(group_id as usize)?;
        let cap = options.max_nodes.clamp(1, MAX_GROUP_EXPANSION_NODES);
        let members: Vec<NodeId> = group.members.iter().take(cap).copied().collect();
        let mut truncated = group.members.len() > members.len();

        let mut seen: HashSet<NodeId> = members.iter().copied().collect();
        let mut edge_set = HashSet::new();
        let mut examined_edges = 0usize;

        'members: for &member in &members {
            let incident = graph.incoming[member as usize]
                .iter()
                .chain(&graph.outgoing[member as usize]);
            for &edge_index in incident {
                if examined_edges >= MAX_GROUP_EXPANSION_EDGE_VISITS {
                    truncated = true;
                    break 'members;
                }
                examined_edges += 1;
                let edge = &graph.edges[edge_index];
                if options.hide_control && is_labeled_control_edge(graph, edge) {
                    continue;
                }
                let neighbor = if edge.from == member {
                    edge.to
                } else {
                    edge.from
                };
                if options.hide_const && graph.nodes[neighbor as usize].kind == NodeKind::Const {
                    continue;
                }
                if !seen.contains(&neighbor) {
                    if seen.len() >= cap {
                        truncated = true;
                        continue;
                    }
                    seen.insert(neighbor);
                }
                if edge_set.len() < MAX_SUBGRAPH_EDGES {
                    edge_set.insert(edge_index);
                } else {
                    truncated = true;
                }
            }
        }

        let empty = HashSet::new();
        let hidden_control_ports = options
            .hide_control
            .then_some(&self.pure_hidden_control_ports);
        let raw = self.subgraph_from_sets(
            graph,
            &seen,
            &edge_set,
            SubgraphProjection {
                roots: &empty,
                protected_nodes: &empty,
                boundary_nodes: &empty,
                truncated,
                hidden_control_ports,
                show_infrastructure: false,
                max_control_edge_visits: Some(MAX_FULL_NETLIST_EDGE_VISITS),
            },
        );
        let (graph, boundary_trunks) = match grouping {
            Some(expanded_projection) => {
                let expanded_graph = quotient_subgraph(graph, raw, expanded_projection);
                let compact_group_id = graph.nodes.len() as u32 + group_id;
                let member_set = members.iter().copied().collect();
                let boundary_trunks =
                    group_expansion_boundary_trunks(&expanded_graph, compact_group_id, &member_set);
                (expanded_graph, boundary_trunks)
            }
            None => (raw.into_public(), Vec::new()),
        };
        Some(GroupExpansion {
            graph,
            members,
            boundary_trunks,
        })
    }

    fn subgraph_from_sets(
        &self,
        graph: &Graph,
        seen: &HashSet<NodeId>,
        edge_set: &HashSet<usize>,
        projection: SubgraphProjection<'_>,
    ) -> ProjectedSubgraph {
        let mut node_ids: Vec<NodeId> = seen
            .iter()
            .copied()
            .filter(|id| {
                projection.protected_nodes.contains(id)
                    || !projection
                        .hidden_control_ports
                        .is_some_and(|ports| ports.contains(id))
            })
            .collect();
        node_ids.sort_unstable();
        let visible_node_ids: HashSet<NodeId> = node_ids.iter().copied().collect();
        let mut control_edge_visits = 0usize;
        let mut controls_truncated = false;
        let nodes = node_ids
            .into_iter()
            .map(|id| {
                let node = &graph.nodes[id as usize];
                let boundary =
                    !projection.roots.contains(&id) && projection.boundary_nodes.contains(&id);
                let (controls, truncated) = node_controls(
                    graph,
                    id,
                    &mut control_edge_visits,
                    projection.max_control_edge_visits,
                );
                controls_truncated |= truncated;
                GraphNode {
                    node: self.node_ref(graph, id),
                    is_root: projection.roots.contains(&id).then_some(true),
                    is_boundary: boundary.then_some(true),
                    depth: graph
                        .is_comb(id)
                        .then(|| self.node_depth[id as usize])
                        .flatten(),
                    params: node.params.clone(),
                    controls,
                    width: None,
                    member_count: None,
                    members: None,
                    boundary_members: Vec::new(),
                }
            })
            .collect();
        let mut edges: Vec<&Edge> = edge_set
            .iter()
            .filter_map(|idx| graph.edges.get(*idx))
            .filter(|edge| {
                visible_node_ids.contains(&edge.from) && visible_node_ids.contains(&edge.to)
            })
            .collect();
        edges.sort_by(|a, b| compare_raw_edges(a, b));
        let (edges, edges_truncated) =
            merge_edges(edges, |edge| is_labeled_control_edge(graph, edge));
        let subgraph = Subgraph {
            nodes,
            edges,
            truncated: projection.truncated || edges_truncated || controls_truncated,
        };
        let projected = if projection.show_infrastructure {
            subgraph.into()
        } else {
            collapse_infrastructure(graph, subgraph)
        };
        cap_subgraph_edges(projected)
    }
}
