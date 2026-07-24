//! Tiered source attribution for selected mapped-graph nodes.
//!
//! Builds the mapped side of a correlation: walks a selection's
//! neighborhood in the final graph to find the boundary nets around it,
//! then hands the resulting cuts to `rtl_correlate` for RTL-snapshot
//! attribution. Registers and combinational logic use different cut
//! shapes (see `rtl_correlate::correlate`).

use crate::graph::{Graph, NodeId, NodeKind};
use crate::source::coordinates::source_columns_are_authoritative;
use crate::source::types::{SourceNodeTiersResponse, SourceTierSpan};
use rtl_correlate::correlate::{CorrelationIndex, CorrelationLimits, MappedCut};
use rtl_correlate::src_attr::SrcSpan;
use std::collections::{BTreeSet, HashSet, VecDeque};

/// Mapped-graph nodes visited per query before truncating.
const MAPPED_VISIT_CAP: usize = 20_000;
/// Boundary names collected per cut before truncating.
const MAPPED_FRONTIER_CAP: usize = 2_048;
/// Selected nodes considered per query; the UI selects a handful.
const SELECTION_CAP: usize = 256;

pub(crate) fn source_tiers_for_nodes(
    graph: &Graph,
    index: &CorrelationIndex,
    ids: &[u32],
) -> SourceNodeTiersResponse {
    let mut response = SourceNodeTiersResponse::default();
    let limits = CorrelationLimits::default();
    let mut exact = BTreeSet::new();
    let mut contributing = BTreeSet::new();

    let mut selected: Vec<NodeId> = Vec::new();
    for &id in ids.iter().take(SELECTION_CAP) {
        if (id as usize) < graph.nodes.len() {
            selected.push(id);
        }
    }
    response.truncated |= ids.len() > SELECTION_CAP;
    let selected_set: HashSet<NodeId> = selected.iter().copied().collect();

    let mut comb_nodes = Vec::new();
    for &id in &selected {
        let node = &graph.nodes[id as usize];
        match node.kind {
            NodeKind::Const => {}
            _ if node.seq => {
                // Registers attribute individually: each has its own Q
                // boundary and D-side statement set.
                let cut = register_cut(graph, id, &mut response);
                merge(
                    index.attribute(&cut, &limits),
                    &mut exact,
                    &mut contributing,
                    &mut response,
                );
            }
            _ => comb_nodes.push(id),
        }
    }

    if !comb_nodes.is_empty() {
        let cut = combinational_cut(graph, index, &comb_nodes, &selected_set, &mut response);
        merge(
            index.attribute(&cut, &limits),
            &mut exact,
            &mut contributing,
            &mut response,
        );
    }

    // The dim tier never repeats what the strong tier already shows.
    let contributing = contributing.difference(&exact).cloned().collect();
    response.exact = render_spans(exact);
    response.contributing = render_spans(contributing);
    response
}

/// A register's cut: its Q nets as outputs. The RTL D-cone supplies
/// statements and conditions, so no mapped-side input walk is needed.
fn register_cut(graph: &Graph, id: NodeId, response: &mut SourceNodeTiersResponse) -> MappedCut {
    let node = &graph.nodes[id as usize];
    // Findings rule: with `abc -dff`, flops are rebuilt under $abc$ names
    // and flop-net boundary matching is unreliable.
    if node.raw_name.starts_with("$abc$") {
        response.approximate = true;
    }
    let mut outputs = BTreeSet::new();
    for &edge_index in &graph.outgoing[id as usize] {
        let edge = &graph.edges[edge_index];
        collect_net_names(graph, edge.bit, &edge.net_name, &mut outputs);
    }
    // Fall back to the node's own name: an endpoint register may drive
    // nothing in a pruned subgraph view.
    if outputs.is_empty() {
        outputs.insert(node.name.clone());
    }
    MappedCut {
        outputs: outputs.into_iter().collect(),
        inputs: Vec::new(),
        truncated: false,
        selected_is_sequential: true,
    }
}

/// A combinational selection's cut: walk outward from the selection to the
/// nearest resolvable boundary nets. Fan-in stops at boundaries (they
/// become the cut's inputs); unresolvable nets are walked through, growing
/// the enclosed region to the minimal one the RTL snapshot can name.
/// Forward expansion through unresolvable output nets yields a superset
/// and flags the result approximate.
fn combinational_cut(
    graph: &Graph,
    index: &CorrelationIndex,
    nodes: &[NodeId],
    selected: &HashSet<NodeId>,
    response: &mut SourceNodeTiersResponse,
) -> MappedCut {
    let mut outputs = BTreeSet::new();
    let mut inputs = BTreeSet::new();
    let mut truncated = false;
    let mut budget = MAPPED_VISIT_CAP;

    // Outputs: nets driven toward non-selected consumers; unresolvable
    // driven nets expand forward to the nearest resolvable frontier.
    let mut forward: VecDeque<NodeId> = VecDeque::new();
    let mut forward_seen: HashSet<NodeId> = nodes.iter().copied().collect();
    for &id in nodes {
        forward.push_back(id);
    }
    while let Some(id) = forward.pop_front() {
        if budget == 0 {
            truncated = true;
            break;
        }
        budget -= 1;
        let expanding = !selected.contains(&id);
        for &edge_index in &graph.outgoing[id as usize] {
            let edge = &graph.edges[edge_index];
            if selected.contains(&edge.to) && !expanding {
                continue;
            }
            let mut names = BTreeSet::new();
            collect_net_names(graph, edge.bit, &edge.net_name, &mut names);
            if names.iter().any(|name| index.is_boundary(name)) {
                if outputs.len() < MAPPED_FRONTIER_CAP {
                    outputs.extend(names);
                } else {
                    truncated = true;
                }
                continue;
            }
            // Unresolvable output net: expand through its consumer.
            let consumer = &graph.nodes[edge.to as usize];
            if consumer.seq || consumer.kind != NodeKind::Cell {
                continue;
            }
            response.approximate = true;
            if forward_seen.insert(edge.to) {
                forward.push_back(edge.to);
            }
        }
    }

    // Inputs: fan-in boundary frontier.
    let mut backward: VecDeque<NodeId> = nodes.iter().copied().collect();
    let mut backward_seen: HashSet<NodeId> = nodes.iter().copied().collect();
    while let Some(id) = backward.pop_front() {
        if budget == 0 {
            truncated = true;
            break;
        }
        budget -= 1;
        for &edge_index in &graph.incoming[id as usize] {
            let edge = &graph.edges[edge_index];
            let driver = &graph.nodes[edge.from as usize];
            let mut names = BTreeSet::new();
            collect_net_names(graph, edge.bit, &edge.net_name, &mut names);
            let is_boundary = names.iter().any(|name| index.is_boundary(name))
                || driver.seq
                || driver.kind != NodeKind::Cell;
            if is_boundary {
                if inputs.len() < MAPPED_FRONTIER_CAP {
                    inputs.extend(names);
                } else {
                    truncated = true;
                }
                continue;
            }
            if backward_seen.insert(edge.from) {
                backward.push_back(edge.from);
            }
        }
    }

    MappedCut {
        outputs: outputs.into_iter().collect(),
        inputs: inputs.into_iter().collect(),
        truncated,
        selected_is_sequential: false,
    }
}

/// Candidate names for one net bit: the edge's own name plus the graph's
/// canonical name and aliases for the bit.
fn collect_net_names(
    graph: &Graph,
    bit: Option<u32>,
    edge_name: &str,
    into: &mut BTreeSet<String>,
) {
    if !edge_name.is_empty() {
        into.insert(edge_name.to_owned());
    }
    let Some(bit) = bit else { return };
    if let Some(name) = graph.net_names.get(&bit) {
        into.insert(name.clone());
    }
    if let Some(aliases) = graph.net_aliases.get(&bit) {
        into.extend(aliases.iter().cloned());
    }
}

fn merge(
    attribution: rtl_correlate::correlate::Attribution,
    exact: &mut BTreeSet<SrcSpan>,
    contributing: &mut BTreeSet<SrcSpan>,
    response: &mut SourceNodeTiersResponse,
) {
    exact.extend(attribution.exact);
    // The product's two-tier contract folds register gating conditions into
    // the contributing tier.
    contributing.extend(attribution.conditions);
    contributing.extend(attribution.contributing);
    response.approximate |= attribution.approximate;
    response.truncated |= attribution.truncated;
}

fn render_spans(spans: BTreeSet<SrcSpan>) -> Vec<SourceTierSpan> {
    spans
        .into_iter()
        .map(|span| {
            let columns = source_columns_are_authoritative(&span.file);
            SourceTierSpan {
                start_column: span.start_column.filter(|_| columns),
                end_column: span.end_column.filter(|_| columns),
                file: span.file,
                start_line: span.start_line,
                end_line: span.end_line,
            }
        })
        .collect()
}
