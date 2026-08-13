use super::controls::is_labeled_control_edge;
use super::{
    ApiNodeKind, BoundaryMember, ConeDir, ControlRef, ControlRole, EdgeBoundaryMember, GraphEdge,
    GraphNode, GroupExpansionBoundaryTrunk, MAX_FULL_GROUP_MEMBERS, MAX_SUBGRAPH_EDGE_BITS,
    MAX_SUBGRAPH_EDGES, MAX_SUBGRAPH_NODES, NodeRef, ProjectedEdgeKey, Subgraph,
};
use crate::graph::{
    Edge, Graph, NodeId, NodeKind, is_infrastructure_cell, is_register_type,
    is_transparent_data_buffer, strip_bit_suffix,
};
use crate::grouping::{GroupId, GroupKind, GroupingProjection};
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
