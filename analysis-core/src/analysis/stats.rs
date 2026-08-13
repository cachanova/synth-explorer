use super::api::{is_register_node, node_ref};
use super::depth::{DelayBreakdownPs, edge_depth};
use super::endpoints::EndpointTarget;
use super::paths::classify_path;
use super::{
    CellCategoryCounts, DelayBreakdown, DepthSummary, EndpointsResponse, PathClass, Stats,
};
use crate::graph::{Graph, NodeId, NodeKind, is_infrastructure_cell};
use crate::netlist::PortDirection;
use std::collections::BTreeMap;

pub(super) fn build_stats(
    graph: &Graph,
    endpoints: &EndpointsResponse,
    endpoint_targets: &[EndpointTarget],
    node_depth: &[Option<u32>],
    estimated_max_delay_ps: Option<f64>,
    estimated_max_delay_breakdown: Option<DelayBreakdownPs>,
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
    let retained_max_depth = endpoint_targets
        .iter()
        .map(|target| target.depth)
        .max()
        .unwrap_or_default();
    let boundary_max_depth = graph
        .nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Cell && node.seq && !is_register_node(node))
        .flat_map(|node| graph.incoming[node.id as usize].iter())
        .filter(|edge_idx| !graph.edges[**edge_idx].control)
        .map(|edge_idx| edge_depth(graph, node_depth, *edge_idx))
        .max()
        .unwrap_or_default();
    let max_depth = retained_max_depth.max(boundary_max_depth);
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
        estimated_delay_ns: estimated_max_delay_ps.map(|ps| ps / 1000.0),
        estimated_delay_breakdown: estimated_max_delay_breakdown.map(DelayBreakdown::from_ps),
    }
}

pub(super) fn update_max(slot: &mut Option<u32>, value: u32) {
    *slot = Some(slot.map_or(value, |current| current.max(value)));
}

pub(super) fn is_carry_or_special(cell_type: &str) -> bool {
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

pub(super) fn build_warnings(graph: &Graph, comb_loops: &[NodeId]) -> Vec<String> {
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
