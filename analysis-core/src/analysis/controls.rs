use super::{ControlRef, ControlRole};
use crate::graph::{Edge, Graph, NodeId, NodeKind, is_infrastructure_cell, is_latch_type};
use crate::netlist::PortDirection;
use std::collections::{BTreeMap, HashSet};

pub(super) fn control_role(pin: &str) -> ControlRole {
    let upper = pin.to_ascii_uppercase();
    if upper.starts_with("CLK") || upper.ends_with("CLK") {
        return ControlRole::Clock;
    }
    match upper.as_str() {
        "CLK" | "C" => ControlRole::Clock,
        "R" | "RST" | "ARST" | "SRST" | "CLR" | "LSR" => ControlRole::Reset,
        "S" | "SET" | "PRE" | "SR" => ControlRole::Set,
        "E" | "EN" | "CE" | "G" | "GE" => ControlRole::Enable,
        _ => ControlRole::Other,
    }
}

pub(super) fn is_labeled_control_edge(graph: &Graph, edge: &Edge) -> bool {
    if !edge.control {
        return false;
    }
    match control_role(&edge.to_port) {
        ControlRole::Clock | ControlRole::Reset | ControlRole::Set => true,
        ControlRole::Enable => {
            // A decoded/muxed enable is part of the dataflow feeding a
            // register. Only a direct, high-fanout enable input is global
            // control infrastructure. A latch's enable is its clock-like
            // transparent gate, so preserve its existing control semantics.
            let target_is_latch = graph.nodes[edge.to as usize]
                .cell_type
                .as_deref()
                .is_some_and(is_latch_type);
            graph.signal_fanout(edge) >= 8
                && (target_is_latch || is_simple_control_source(graph, edge.from))
        }
        ControlRole::Other => false,
    }
}

const CONTROL_VIS_UNKNOWN: u8 = 0;
const CONTROL_VIS_VISITING: u8 = 1;
const CONTROL_VIS_HIDDEN: u8 = 2;
const CONTROL_VIS_VISIBLE: u8 = 3;

#[derive(Clone, Copy)]
struct ControlVisibilityFrame {
    id: NodeId,
    next_edge: usize,
    reaches_hidden_control: bool,
}

/// Precompute top-level inputs whose complete routing disappears with
/// `hide_control`. Infrastructure cells are transparent so vendor input
/// buffers do not leave disconnected `clk`/`rst` ports on the schematic.
///
/// The iterative memoized walk visits each shared infrastructure path once.
/// Cycles are conservatively visible: ambiguous cyclic routing must not hide a
/// user-facing port, and the traversal remains stack-safe for deep buffers.
pub(super) fn pure_hidden_control_ports(graph: &Graph) -> HashSet<NodeId> {
    let mut memo = vec![CONTROL_VIS_UNKNOWN; graph.nodes.len()];
    let mut hidden_ports = HashSet::new();

    for port in &graph.nodes {
        if port.kind != NodeKind::PortBit || port.port_dir != Some(PortDirection::Input) {
            continue;
        }
        if memo[port.id as usize] == CONTROL_VIS_UNKNOWN {
            memo[port.id as usize] = CONTROL_VIS_VISITING;
            let mut stack = vec![ControlVisibilityFrame {
                id: port.id,
                next_edge: 0,
                reaches_hidden_control: false,
            }];
            while let Some(frame) = stack.last_mut() {
                let outgoing = &graph.outgoing[frame.id as usize];
                let Some(&edge_index) = outgoing.get(frame.next_edge) else {
                    let result = frame.reaches_hidden_control;
                    memo[frame.id as usize] = if result {
                        CONTROL_VIS_HIDDEN
                    } else {
                        CONTROL_VIS_VISIBLE
                    };
                    stack.pop();
                    continue;
                };
                let edge = &graph.edges[edge_index];
                if is_labeled_control_edge(graph, edge) {
                    frame.reaches_hidden_control = true;
                    frame.next_edge += 1;
                    continue;
                }
                let next = &graph.nodes[edge.to as usize];
                if next.kind != NodeKind::Cell
                    || !next
                        .cell_type
                        .as_deref()
                        .is_some_and(is_infrastructure_cell)
                {
                    memo[frame.id as usize] = CONTROL_VIS_VISIBLE;
                    stack.pop();
                    continue;
                }
                match memo[edge.to as usize] {
                    CONTROL_VIS_UNKNOWN => {
                        memo[edge.to as usize] = CONTROL_VIS_VISITING;
                        stack.push(ControlVisibilityFrame {
                            id: edge.to,
                            next_edge: 0,
                            reaches_hidden_control: false,
                        });
                    }
                    CONTROL_VIS_HIDDEN => {
                        frame.reaches_hidden_control = true;
                        frame.next_edge += 1;
                    }
                    CONTROL_VIS_VISITING | CONTROL_VIS_VISIBLE => {
                        memo[frame.id as usize] = CONTROL_VIS_VISIBLE;
                        stack.pop();
                    }
                    _ => unreachable!("control visibility memo uses known states"),
                }
            }
        }
        if memo[port.id as usize] == CONTROL_VIS_HIDDEN {
            hidden_ports.insert(port.id);
        }
    }
    hidden_ports
}

pub(super) fn node_controls(
    graph: &Graph,
    node_id: NodeId,
    examined_edges: &mut usize,
    max_examined_edges: Option<usize>,
) -> (Vec<ControlRef>, bool) {
    let mut controls = Vec::new();
    let mut truncated = false;
    for edge_idx in &graph.incoming[node_id as usize] {
        if let Some(limit) = max_examined_edges {
            if *examined_edges >= limit {
                truncated = true;
                break;
            }
            *examined_edges += 1;
        }
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
            driver_ids: Vec::new(),
            net_count: None,
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
    (controls, truncated)
}

pub(super) fn control_synchronous(cell_type: Option<&str>, role: ControlRole) -> Option<bool> {
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

pub(super) fn control_active_low(
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

pub(super) fn parameter_control_active_low(
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

pub(super) fn binary_parameter_bool(value: Option<&String>) -> Option<bool> {
    match value.map(String::as_str) {
        Some("0") => Some(false),
        Some("1") => Some(true),
        _ => None,
    }
}

pub(super) fn fixed_primitive_control_active_low(
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

pub(super) fn hard_cell_control_active_low(cell_type: &str, role: ControlRole) -> Option<bool> {
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

pub(super) fn is_simple_control_source(graph: &Graph, start: NodeId) -> bool {
    let mut current = start;
    let mut visited = HashSet::new();
    loop {
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
        // Direct input ports and ordinary logic return above without ever
        // allocating the cycle guard. Only transparent infrastructure chains
        // need visited-node tracking.
        if !visited.insert(current) {
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
}
