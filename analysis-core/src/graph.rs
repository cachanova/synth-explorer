//! Netlist-to-graph construction and structural cell classification.

use crate::netlist::{
    PortDirection, YosysBit, YosysCell, YosysModule, YosysNetlist, attr_truthy,
    binary_string_to_u64, module_blackboxes,
};
use deepsize::DeepSizeOf;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

pub type NodeId = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, DeepSizeOf)]
pub enum NodeKind {
    Cell,
    PortBit,
    Const,
}

#[derive(Debug, Clone, DeepSizeOf)]
pub struct Node {
    pub id: NodeId,
    pub kind: NodeKind,
    pub name: String,
    pub raw_name: String,
    pub cell_type: Option<String>,
    pub seq: bool,
    pub blackbox: bool,
    pub src: Option<String>,
    pub params: BTreeMap<String, String>,
    pub port: Option<String>,
    pub port_bit: Option<usize>,
    pub port_dir: Option<PortDirection>,
    pub const_value: Option<String>,
}

#[derive(Debug, Clone, DeepSizeOf)]
pub struct Edge {
    pub from: NodeId,
    pub to: NodeId,
    pub from_port: String,
    pub to_port: String,
    pub to_port_bit: u32,
    pub bit: Option<u32>,
    pub net_name: String,
    pub control: bool,
}

#[derive(Debug, Clone, DeepSizeOf)]
pub struct CellInfo {
    pub q_bits: Vec<YosysBit>,
    pub d_bits: Vec<YosysBit>,
    pub clock_net: Option<String>,
    pub output_ports: HashSet<String>,
    pub input_ports: HashSet<String>,
}

#[derive(Debug, Clone, DeepSizeOf)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub outgoing: Vec<Vec<usize>>,
    pub incoming: Vec<Vec<usize>>,
    pub top: String,
    pub net_names: HashMap<u32, String>,
    pub net_aliases: HashMap<u32, Vec<String>>,
    pub cell_info: HashMap<NodeId, CellInfo>,
    pub blackboxes: Vec<NodeId>,
    pub(crate) signal_fanout: HashMap<(NodeId, String, Option<u32>), usize>,
    /// Per-node: whether the node belongs to the clock distribution network.
    /// See [`clock_network_nodes`].
    pub(crate) clock_network: Vec<bool>,
}

#[derive(Debug, thiserror::Error)]
pub enum GraphError {
    #[error("node count exceeds u32 id space")]
    TooManyNodes,
    #[error("cell port width exceeds u32 index space")]
    TooManyPortBits,
}

impl Graph {
    pub fn from_netlist(
        netlist: &YosysNetlist,
        top_name: &str,
        module: &YosysModule,
    ) -> Result<Self, GraphError> {
        let (net_names, net_aliases) = net_name_maps(module);
        let blackbox_modules = module_blackboxes(netlist);
        let module_names: HashSet<&str> = netlist.modules.keys().map(String::as_str).collect();

        let mut builder = GraphBuilder {
            nodes: Vec::new(),
            edges: Vec::new(),
            outgoing: Vec::new(),
            incoming: Vec::new(),
            net_names,
            cell_info: HashMap::new(),
            blackboxes: Vec::new(),
        };

        let mut port_nodes: HashMap<(String, usize), NodeId> = HashMap::new();
        let mut const_nodes: HashMap<String, NodeId> = HashMap::new();
        let mut cell_nodes: HashMap<String, NodeId> = HashMap::new();

        for (port_name, port) in &module.ports {
            for (idx, _bit) in port.bits.iter().enumerate() {
                // A port node represents the interface signal, even when Yosys
                // aliases it directly to another port's bit (`assign y = a`).
                // Using the canonical net name here would make output `y` appear
                // as another node named `a` and erase the top-level identity.
                let name = bit_name(port_name, idx, port.bits.len());
                let id = builder.add_node(Node {
                    id: 0,
                    kind: NodeKind::PortBit,
                    name,
                    raw_name: port_name.clone(),
                    cell_type: None,
                    seq: false,
                    blackbox: false,
                    src: None,
                    params: BTreeMap::new(),
                    port: Some(port_name.clone()),
                    port_bit: Some(idx),
                    port_dir: Some(port.direction),
                    const_value: None,
                })?;
                port_nodes.insert((port_name.clone(), idx), id);
            }
        }

        for (cell_name, cell) in &module.cells {
            let vendor_class = vendor_primitive_class(&cell.cell_type);
            let seq_kind = is_sequential_type_with_vendor(&cell.cell_type, vendor_class);
            let blackbox =
                is_blackbox_cell_with_vendor(cell, &blackbox_modules, &module_names, vendor_class);
            let seq = seq_kind || blackbox;
            let id = builder.add_node(Node {
                id: 0,
                kind: NodeKind::Cell,
                name: clean_cell_name(cell_name),
                raw_name: cell_name.clone(),
                cell_type: Some(cell.cell_type.clone()),
                seq,
                blackbox,
                src: cell.attributes.get("src").cloned(),
                params: trim_params(&cell.parameters),
                port: None,
                port_bit: None,
                port_dir: None,
                const_value: None,
            })?;
            cell_nodes.insert(cell_name.clone(), id);
            if blackbox {
                builder.blackboxes.push(id);
            }
        }

        let mut drivers: HashMap<YosysBit, Vec<(NodeId, String)>> = HashMap::new();

        for (port_name, port) in &module.ports {
            for (idx, bit) in port.bits.iter().enumerate() {
                if matches!(port.direction, PortDirection::Input | PortDirection::Inout)
                    && let Some(id) = port_nodes.get(&(port_name.clone(), idx))
                {
                    drivers
                        .entry(bit.clone())
                        .or_default()
                        .push((*id, port_name.clone()));
                }
            }
        }

        for (cell_name, cell) in &module.cells {
            let Some(&node_id) = cell_nodes.get(cell_name) else {
                continue;
            };
            let output_ports = output_ports(cell);
            let input_ports = input_ports(cell);
            let mut info = CellInfo {
                q_bits: cell.connections.get("Q").cloned().unwrap_or_default(),
                d_bits: cell.connections.get("D").cloned().unwrap_or_default(),
                clock_net: None,
                output_ports: output_ports.clone(),
                input_ports: input_ports.clone(),
            };
            // Endpoint metadata calls this field `clock`, but for latches it
            // is the transparent gate. Never substitute an async reset/set
            // merely because the primitive has no edge-triggered clock.
            for control_pin in ["CLK", "C", "G", "E", "EN", "GE"] {
                if let Some(bits) = cell.connections.get(control_pin) {
                    if !is_control_pin_for_cell(&cell.cell_type, control_pin) {
                        continue;
                    }
                    if info.clock_net.is_none() {
                        info.clock_net = bits
                            .iter()
                            .find_map(|bit| bit.net())
                            .and_then(|net| builder.net_names.get(&net).cloned());
                    }
                    if info.clock_net.is_some() {
                        break;
                    }
                }
            }
            if builder.nodes[node_id as usize].seq && info.q_bits.is_empty() {
                let mut ports: Vec<_> = output_ports.iter().collect();
                ports.sort();
                for port in ports {
                    if let Some(bits) = cell.connections.get(port) {
                        info.q_bits.extend(bits.clone());
                    }
                }
            }
            if builder.nodes[node_id as usize].seq && info.d_bits.is_empty() {
                let mut ports: Vec<_> = input_ports.iter().collect();
                ports.sort();
                for port in ports {
                    if is_control_pin_for_cell(&cell.cell_type, port) {
                        continue;
                    }
                    if let Some(bits) = cell.connections.get(port) {
                        info.d_bits.extend(bits.clone());
                    }
                }
            }
            if builder.nodes[node_id as usize].seq
                && is_register_type(&cell.cell_type)
                && let Some(name) = info
                    .q_bits
                    .iter()
                    .find_map(|bit| bit.net())
                    .and_then(|net| builder.net_names.get(&net).cloned())
            {
                // A one-bit cell represents exactly this Q net, so keep its
                // index. A word-level cell still represents the whole vector.
                builder.nodes[node_id as usize].name = if info.q_bits.len() == 1 {
                    name
                } else {
                    strip_bit_suffix(&name).to_owned()
                };
            }
            let mut sorted_output_ports: Vec<_> = output_ports.iter().collect();
            sorted_output_ports.sort();
            for output_port in sorted_output_ports {
                if let Some(bits) = cell.connections.get(output_port) {
                    for bit in bits {
                        drivers
                            .entry(bit.clone())
                            .or_default()
                            .push((node_id, output_port.clone()));
                    }
                }
            }
            builder.cell_info.insert(node_id, info);
        }

        for (cell_name, cell) in &module.cells {
            let Some(&sink_id) = cell_nodes.get(cell_name) else {
                continue;
            };
            let input_ports = input_ports(cell);
            let mut sorted_input_ports: Vec<_> = input_ports.iter().collect();
            sorted_input_ports.sort();
            for input_port in sorted_input_ports {
                let Some(bits) = cell.connections.get(input_port) else {
                    continue;
                };
                for (port_bit, bit) in bits.iter().enumerate() {
                    if bit.is_unconnected() {
                        continue;
                    }
                    let port_bit =
                        u32::try_from(port_bit).map_err(|_| GraphError::TooManyPortBits)?;
                    let control = is_control_pin_for_cell(&cell.cell_type, input_port);
                    let net_name = bit_to_name(bit, &builder.net_names);
                    for (driver_id, driver_port) in
                        resolve_drivers(bit, &drivers, &mut builder, &mut const_nodes)?
                    {
                        builder.add_edge(Edge {
                            from: driver_id,
                            to: sink_id,
                            from_port: driver_port,
                            to_port: input_port.clone(),
                            to_port_bit: port_bit,
                            bit: bit.net(),
                            net_name: net_name.clone(),
                            control,
                        });
                    }
                }
            }
        }

        for (port_name, port) in &module.ports {
            if !matches!(port.direction, PortDirection::Output | PortDirection::Inout) {
                continue;
            }
            for (idx, bit) in port.bits.iter().enumerate() {
                let Some(&sink_id) = port_nodes.get(&(port_name.clone(), idx)) else {
                    continue;
                };
                let net_name = bit_to_name(bit, &builder.net_names);
                let port_bit = u32::try_from(idx).map_err(|_| GraphError::TooManyPortBits)?;
                for (driver_id, driver_port) in
                    resolve_drivers(bit, &drivers, &mut builder, &mut const_nodes)?
                {
                    if driver_id == sink_id {
                        continue;
                    }
                    builder.add_edge(Edge {
                        from: driver_id,
                        to: sink_id,
                        from_port: driver_port,
                        to_port: port_name.clone(),
                        to_port_bit: port_bit,
                        bit: bit.net(),
                        net_name: net_name.clone(),
                        control: false,
                    });
                }
            }
        }

        let signal_fanout = build_signal_fanout(&builder.edges);
        let clock_network = clock_network_nodes(
            &builder.nodes,
            &builder.edges,
            &builder.outgoing,
            &builder.incoming,
        );
        Ok(Self {
            nodes: builder.nodes,
            edges: builder.edges,
            outgoing: builder.outgoing,
            incoming: builder.incoming,
            top: top_name.to_owned(),
            net_names: builder.net_names,
            net_aliases,
            cell_info: builder.cell_info,
            blackboxes: builder.blackboxes,
            signal_fanout,
            clock_network,
        })
    }

    pub fn node_ref_name(&self, id: NodeId) -> String {
        self.nodes
            .get(id as usize)
            .map(|node| node.name.clone())
            .unwrap_or_else(|| format!("node_{id}"))
    }

    pub fn is_boundary(&self, id: NodeId) -> bool {
        self.nodes.get(id as usize).is_some_and(|node| {
            node.seq || matches!(node.kind, NodeKind::PortBit | NodeKind::Const)
        })
    }

    pub fn is_comb(&self, id: NodeId) -> bool {
        self.nodes
            .get(id as usize)
            .is_some_and(|node| matches!(node.kind, NodeKind::Cell) && !node.seq)
    }

    /// Whether this node distributes a clock rather than data — see
    /// [`clock_network_nodes`].
    pub fn is_clock_network(&self, id: NodeId) -> bool {
        self.clock_network
            .get(id as usize)
            .copied()
            .unwrap_or(false)
    }

    /// Number of sink pins driven by this exact output port and net bit.
    /// Keeping this precomputed avoids quadratic scans for high-fanout controls.
    pub fn signal_fanout(&self, edge: &Edge) -> usize {
        self.signal_fanout
            .get(&(edge.from, edge.from_port.clone(), edge.bit))
            .copied()
            .unwrap_or(1)
    }
}

/// An edge that lands on a storage cell's clock (or latch gate) pin.
fn is_clock_pin_edge(nodes: &[Node], edge: &Edge) -> bool {
    nodes.get(edge.to as usize).is_some_and(|sink| {
        sink.kind == NodeKind::Cell
            && sink.seq
            && sink
                .cell_type
                .as_deref()
                .is_some_and(|cell_type| is_clock_pin_for_cell(cell_type, &edge.to_port))
    })
}

/// Nodes that distribute a clock rather than data — with `synth_xilinx`
/// defaults, `clk` → `IBUF` → `BUFG` → every `FDRE`'s `C` pin.
///
/// A clock is not data. Walking this chain as ordinary combinational logic
/// charges a buffer delay per stage plus a register setup at the end, which is
/// how a shallow sequential design reports its own clock tree as the critical
/// path.
///
/// The rule is about where a signal *goes*, not what drives it: an `IBUF` on a
/// data port stays a data-path node, and a buffer whose output also reaches a
/// data pin is not clock-only. A node qualifies when it drives at least one
/// sink and every sink is either a clock pin or another clock-only node.
///
/// Computed as a reverse worklist fixpoint: linear in edges, and a cyclic
/// buffer ring — which is not a clock tree — is never marked, so it stays
/// visible to combinational-loop detection.
fn clock_network_nodes(
    nodes: &[Node],
    edges: &[Edge],
    outgoing: &[Vec<usize>],
    incoming: &[Vec<usize>],
) -> Vec<bool> {
    // Sinks that are not yet known to be clock-only. A node with none left is
    // part of the clock network.
    let mut pending: Vec<usize> = outgoing
        .iter()
        .map(|out| {
            out.iter()
                .filter(|idx| !is_clock_pin_edge(nodes, &edges[**idx]))
                .count()
        })
        .collect();

    let mut clock_only = vec![false; nodes.len()];
    let mut queue: VecDeque<NodeId> = VecDeque::new();
    for (id, out) in outgoing.iter().enumerate() {
        // A node driving nothing is dangling, not a clock.
        if !out.is_empty() && pending[id] == 0 {
            clock_only[id] = true;
            queue.push_back(id as NodeId);
        }
    }

    while let Some(id) = queue.pop_front() {
        for edge_idx in &incoming[id as usize] {
            let edge = &edges[*edge_idx];
            // Already excluded from the driver's count.
            if is_clock_pin_edge(nodes, edge) {
                continue;
            }
            let from = edge.from as usize;
            pending[from] = pending[from].saturating_sub(1);
            if pending[from] == 0 && !clock_only[from] && !outgoing[from].is_empty() {
                clock_only[from] = true;
                queue.push_back(edge.from);
            }
        }
    }
    clock_only
}

fn build_signal_fanout(edges: &[Edge]) -> HashMap<(NodeId, String, Option<u32>), usize> {
    let mut counts = HashMap::new();
    for edge in edges {
        *counts
            .entry((edge.from, edge.from_port.clone(), edge.bit))
            .or_default() += 1;
    }
    counts
}

struct GraphBuilder {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    outgoing: Vec<Vec<usize>>,
    incoming: Vec<Vec<usize>>,
    net_names: HashMap<u32, String>,
    cell_info: HashMap<NodeId, CellInfo>,
    blackboxes: Vec<NodeId>,
}

impl GraphBuilder {
    fn add_node(&mut self, mut node: Node) -> Result<NodeId, GraphError> {
        let id = NodeId::try_from(self.nodes.len()).map_err(|_| GraphError::TooManyNodes)?;
        node.id = id;
        self.nodes.push(node);
        self.outgoing.push(Vec::new());
        self.incoming.push(Vec::new());
        Ok(id)
    }

    fn add_edge(&mut self, edge: Edge) {
        let idx = self.edges.len();
        self.outgoing[edge.from as usize].push(idx);
        self.incoming[edge.to as usize].push(idx);
        self.edges.push(edge);
    }

    fn const_node(
        &mut self,
        value: &str,
        const_nodes: &mut HashMap<String, NodeId>,
    ) -> Result<NodeId, GraphError> {
        if let Some(id) = const_nodes.get(value) {
            return Ok(*id);
        }
        let name = match value {
            "0" => "1'b0".to_owned(),
            "1" => "1'b1".to_owned(),
            "x" | "X" => "1'bx".to_owned(),
            "z" | "Z" => "1'bz".to_owned(),
            other => format!("1'b{other}"),
        };
        let id = self.add_node(Node {
            id: 0,
            kind: NodeKind::Const,
            name: name.clone(),
            raw_name: value.to_owned(),
            cell_type: None,
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: None,
            port_bit: None,
            port_dir: None,
            const_value: Some(name),
        })?;
        const_nodes.insert(value.to_owned(), id);
        Ok(id)
    }
}

fn resolve_drivers(
    bit: &YosysBit,
    drivers: &HashMap<YosysBit, Vec<(NodeId, String)>>,
    builder: &mut GraphBuilder,
    const_nodes: &mut HashMap<String, NodeId>,
) -> Result<Vec<(NodeId, String)>, GraphError> {
    if let Some(value) = bit.const_value() {
        return Ok(vec![(
            builder.const_node(value, const_nodes)?,
            "CONST".to_owned(),
        )]);
    }
    Ok(drivers.get(bit).cloned().unwrap_or_default())
}

pub fn is_control_pin(port: &str) -> bool {
    matches!(
        port.to_ascii_uppercase().as_str(),
        "CLK" | "EN" | "ARST" | "SRST" | "CLR" | "PRE" | "CE" | "RST" | "LSR" | "SR" | "SET"
    )
}

pub fn is_control_pin_for_cell(cell_type: &str, port: &str) -> bool {
    if is_control_pin(port) || is_clock_pin_for_cell(cell_type, port) {
        return true;
    }
    let upper_port = port.to_ascii_uppercase();
    if matches!(upper_port.as_str(), "C" | "E" | "R" | "S") {
        return is_sequential_type(cell_type);
    }
    if matches!(upper_port.as_str(), "G" | "GE") {
        return is_latch_type(cell_type);
    }
    upper_port == "T"
        && matches!(
            cell_type.to_ascii_uppercase().as_str(),
            "OBUFT" | "IOBUF" | "SB_IO"
        )
}

/// Level-sensitive storage: yosys `$dlatch`/`$adlatch`/`$_DLATCH_*` and the
/// Xilinx `LD*` primitives.
pub fn is_latch_type(cell_type: &str) -> bool {
    let upper = cell_type.to_ascii_uppercase();
    upper.contains("LATCH") || matches!(upper.as_str(), "LDCE" | "LDPE" | "LDCPE")
}

/// The pin that clocks a storage cell: a register's clock, or a latch's
/// transparent gate. A signal that reaches only these pins is a clock, not
/// data.
///
/// Deliberately narrower than [`is_control_pin_for_cell`]. A clock *enable*
/// (`FDRE`'s `CE`, `$dffe`'s `EN`) and a reset (`R`/`S`) are control pins, but
/// they are still setup-constrained data paths that must keep their timing.
/// Only the pin that actually clocks the cell belongs to the clock network.
pub fn is_clock_pin_for_cell(cell_type: &str, port: &str) -> bool {
    let upper = port.to_ascii_uppercase();
    // Unambiguous on any cell, including a user blackbox. `$mem` spells its
    // ports `RD_CLK`/`WR_CLK`, while vendor RAMs use WCLK/RCLK, CLKA/CLKB, or
    // compound names such as CLKARDCLK.
    if upper.starts_with("CLK") || upper.ends_with("CLK") {
        return true;
    }
    // On a blackbox, a port named `C`/`E`/`G` is just as likely to be data, so
    // only a recognized storage primitive gets the short spellings.
    if !is_sequential_type(cell_type) {
        return false;
    }
    match upper.as_str() {
        // Xilinx `FD*`/`LD*` and yosys `$_DFF_*` spell the clock `C`.
        "C" => true,
        // A latch's gate is clock-like: `$dlatch` calls it `EN`, `$_DLATCH_*`
        // calls it `E`, and Xilinx `LD*` call it `G`. `$dffe`/`$_DFFE_*` use
        // those same spellings for a clock *enable*, which is data — hence the
        // latch-only test.
        "G" | "E" | "EN" => is_latch_type(cell_type),
        _ => false,
    }
}
fn output_ports(cell: &YosysCell) -> HashSet<String> {
    let mut ports: HashSet<String> = cell
        .port_directions
        .iter()
        .filter(|(_, dir)| matches!(dir, PortDirection::Output | PortDirection::Inout))
        .map(|(name, _)| name.clone())
        .collect();
    if ports.is_empty() {
        for name in cell.connections.keys() {
            let upper = name.to_ascii_uppercase();
            if matches!(upper.as_str(), "Y" | "Q" | "O" | "OUT")
                || upper.starts_with('Q')
                || upper.starts_with("Y")
            {
                ports.insert(name.clone());
            }
        }
    }
    ports
}

fn input_ports(cell: &YosysCell) -> HashSet<String> {
    let output = output_ports(cell);
    let mut inputs: HashSet<String> = cell
        .port_directions
        .iter()
        .filter(|(_, dir)| matches!(dir, PortDirection::Input | PortDirection::Inout))
        .map(|(name, _)| name.clone())
        .collect();
    if inputs.is_empty() {
        inputs = cell
            .connections
            .keys()
            .filter(|name| !output.contains(*name))
            .cloned()
            .collect();
    }
    inputs
}

fn net_name_maps(module: &YosysModule) -> (HashMap<u32, String>, HashMap<u32, Vec<String>>) {
    let mut names: HashMap<u32, (bool, usize, String)> = HashMap::new();
    let mut aliases: HashMap<u32, Vec<String>> = HashMap::new();
    for (raw_name, netname) in &module.netnames {
        let base = clean_net_name(raw_name);
        for (idx, bit) in netname.bits.iter().enumerate() {
            let Some(net) = bit.net() else {
                continue;
            };
            let display = bit_name(&base, idx, netname.bits.len());
            let score = (netname.hide_name != 0, display.len(), display.clone());
            let replace = names
                .get(&net)
                .is_none_or(|current| better_net_score(&score, current));
            if replace {
                names.insert(net, score);
            }
            aliases.entry(net).or_default().push(display);
        }
    }
    for names in aliases.values_mut() {
        names.sort();
        names.dedup();
    }
    let best = names
        .into_iter()
        .map(|(net, (_, _, name))| (net, name))
        .collect();
    (best, aliases)
}

fn better_net_score(candidate: &(bool, usize, String), current: &(bool, usize, String)) -> bool {
    (candidate.0, candidate.1, candidate.2.as_str()) < (current.0, current.1, current.2.as_str())
}

fn bit_name(base: &str, idx: usize, width: usize) -> String {
    if width <= 1 {
        base.to_owned()
    } else {
        format!("{base}[{idx}]")
    }
}

fn has_bit_suffix(value: &str) -> bool {
    value.rsplit_once('[').is_some_and(|(_, tail)| {
        tail.strip_suffix(']')
            .is_some_and(|inner| inner.parse::<usize>().is_ok())
    })
}

pub fn strip_bit_suffix(value: &str) -> &str {
    if has_bit_suffix(value) {
        value.rsplit_once('[').map_or(value, |(prefix, _)| prefix)
    } else {
        value
    }
}

fn clean_net_name(name: &str) -> String {
    name.trim_start_matches('\\').replace('\\', "")
}

fn clean_cell_name(name: &str) -> String {
    let clean = clean_net_name(name);
    if let Some(rest) = clean.strip_prefix("$procdff$") {
        return format!("ff_{rest}");
    }
    clean
}

fn bit_to_name(bit: &YosysBit, names: &HashMap<u32, String>) -> String {
    match bit {
        YosysBit::Net(net) => names
            .get(net)
            .cloned()
            .unwrap_or_else(|| format!("net_{net}")),
        YosysBit::Const(value) => match value.as_str() {
            "0" => "1'b0".to_owned(),
            "1" => "1'b1".to_owned(),
            "x" | "X" => "1'bx".to_owned(),
            "z" | "Z" => "1'bz".to_owned(),
            other => format!("1'b{other}"),
        },
    }
}

fn trim_params(params: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (key, value) in params {
        let upper = key.to_ascii_uppercase();
        if upper == "LUT" {
            out.insert(key.clone(), value.clone());
        } else if upper == "WIDTH"
            || upper.ends_with("_WIDTH")
            || upper.ends_with("_POLARITY")
            || (upper.starts_with("IS_") && upper.ends_with("_INVERTED"))
        {
            let formatted = binary_string_to_u64(value)
                .map(|num| num.to_string())
                .unwrap_or_else(|| value.clone());
            out.insert(key.clone(), formatted);
        }
    }
    out
}

pub fn is_sequential_type(cell_type: &str) -> bool {
    is_sequential_type_with_vendor(cell_type, vendor_primitive_class(cell_type))
}

fn is_sequential_type_with_vendor(
    cell_type: &str,
    vendor_class: Option<VendorPrimitiveClass>,
) -> bool {
    let upper = cell_type.to_ascii_uppercase();
    cell_type.starts_with("$dff")
        || cell_type.starts_with("$sdff")
        || cell_type.starts_with("$adff")
        || cell_type.starts_with("$aldff")
        || cell_type.starts_with("$dffe")
        || cell_type.starts_with("$dlatch")
        || cell_type.starts_with("$adlatch")
        || cell_type == "$ff"
        || cell_type == "$sr"
        || is_memory_type(cell_type)
        || upper.starts_with("$_DFF")
        || upper.starts_with("$_SDFF")
        || upper.starts_with("$_ALDFF")
        || upper.starts_with("$_DLATCH")
        || upper.starts_with("$_SR_")
        || upper == "$_FF_"
        || matches!(vendor_class, Some(VendorPrimitiveClass::Sequential))
}

/// True only for edge-triggered/latch storage whose output is a register value.
/// Stateful memories and addressable shift-register LUTs remain traversal
/// boundaries, but must not be presented as ordinary registers or registered
/// top-level-output aliases.
pub fn is_register_type(cell_type: &str) -> bool {
    is_sequential_type(cell_type)
        && !is_memory_type(cell_type)
        && !is_addressable_sequential_type(cell_type)
}

/// Stateful memory cells emitted by the generic and supported FPGA flows.
/// Keep this aligned with the frontend's memory-symbol vocabulary: these are
/// traversal boundaries, but they are neither black boxes nor register bits.
pub fn is_memory_type(cell_type: &str) -> bool {
    let bytes = cell_type.as_bytes();
    let starts_with_ignore_ascii_case = |prefix: &[u8]| {
        bytes
            .get(..prefix.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
    };
    let equals_any = |known: &[&[u8]]| known.iter().any(|name| bytes.eq_ignore_ascii_case(name));
    let xilinx_lutram = || {
        equals_any(&[
            b"RAM16X1D",
            b"RAM16X1D_1",
            b"RAM16X1S",
            b"RAM16X1S_1",
            b"RAM16X2S",
            b"RAM16X4S",
            b"RAM16X8S",
            b"RAM32M",
            b"RAM32M16",
            b"RAM32X1D",
            b"RAM32X1D_1",
            b"RAM32X1S",
            b"RAM32X1S_1",
            b"RAM32X2S",
            b"RAM32X4S",
            b"RAM32X8S",
            b"RAM32X16DR8",
            b"RAM64M",
            b"RAM64M8",
            b"RAM64X1D",
            b"RAM64X1D_1",
            b"RAM64X1S",
            b"RAM64X1S_1",
            b"RAM64X2S",
            b"RAM64X8SW",
            b"RAM128X1D",
            b"RAM128X1S",
            b"RAM128X1S_1",
            b"RAM256X1D",
            b"RAM256X1S",
            b"RAM512X1S",
        ])
    };
    let xilinx_block_ram = || {
        equals_any(&[
            b"RAMB4_S1",
            b"RAMB4_S1_S1",
            b"RAMB4_S1_S2",
            b"RAMB4_S1_S4",
            b"RAMB4_S1_S8",
            b"RAMB4_S1_S16",
            b"RAMB4_S2",
            b"RAMB4_S2_S2",
            b"RAMB4_S2_S4",
            b"RAMB4_S2_S8",
            b"RAMB4_S2_S16",
            b"RAMB4_S4",
            b"RAMB4_S4_S4",
            b"RAMB4_S4_S8",
            b"RAMB4_S4_S16",
            b"RAMB4_S8",
            b"RAMB4_S8_S8",
            b"RAMB4_S8_S16",
            b"RAMB4_S16",
            b"RAMB4_S16_S16",
            b"RAMB8BWER",
            b"RAMB16",
            b"RAMB16BWER",
            b"RAMB16BWE_S18",
            b"RAMB16BWE_S18_S9",
            b"RAMB16BWE_S18_S18",
            b"RAMB16BWE_S36",
            b"RAMB16BWE_S36_S9",
            b"RAMB16BWE_S36_S18",
            b"RAMB16BWE_S36_S36",
            b"RAMB16_S1",
            b"RAMB16_S1_S1",
            b"RAMB16_S1_S2",
            b"RAMB16_S1_S4",
            b"RAMB16_S1_S9",
            b"RAMB16_S1_S18",
            b"RAMB16_S1_S36",
            b"RAMB16_S2",
            b"RAMB16_S2_S2",
            b"RAMB16_S2_S4",
            b"RAMB16_S2_S9",
            b"RAMB16_S2_S18",
            b"RAMB16_S2_S36",
            b"RAMB16_S4",
            b"RAMB16_S4_S4",
            b"RAMB16_S4_S9",
            b"RAMB16_S4_S18",
            b"RAMB16_S4_S36",
            b"RAMB16_S9",
            b"RAMB16_S9_S9",
            b"RAMB16_S9_S18",
            b"RAMB16_S9_S36",
            b"RAMB16_S18",
            b"RAMB16_S18_S18",
            b"RAMB16_S18_S36",
            b"RAMB16_S36",
            b"RAMB16_S36_S36",
            b"RAMB18",
            b"RAMB18E1",
            b"RAMB18E2",
            b"RAMB18SDP",
            b"RAMB32_S64_ECC",
            b"RAMB36",
            b"RAMB36E1",
            b"RAMB36E2",
            b"RAMB36SDP",
        ])
    };
    let xilinx_ram = xilinx_lutram()
        || xilinx_block_ram()
        || equals_any(&[
            b"RAMD32",
            b"RAMD32E",
            b"RAMD32X1",
            b"RAMD64",
            b"RAMD64E",
            b"RAMD64X1",
            b"RAMS32",
            b"RAMS32E",
            b"RAMS32X1",
            b"RAMS64",
            b"RAMS64E",
            b"RAMS64X1",
        ]);
    (starts_with_ignore_ascii_case(b"$mem"))
        || xilinx_ram
        || equals_any(&[b"URAM288", b"URAM288_BASE"])
        || cell_type.eq_ignore_ascii_case("DP16KD")
        || cell_type.eq_ignore_ascii_case("TRELLIS_DPR16X4")
        || cell_type.eq_ignore_ascii_case("SPRAM")
        || cell_type.eq_ignore_ascii_case("SPRAM256KA")
        || equals_any(&[
            b"SB_RAM40_4K",
            b"SB_RAM40_4KNR",
            b"SB_RAM40_4KNW",
            b"SB_RAM40_4KNRNW",
            b"SB_SPRAM256KA",
        ])
        || cell_type.eq_ignore_ascii_case("SRL16E")
        || cell_type.eq_ignore_ascii_case("SRLC32E")
}

/// Stateful primitives whose output also has a combinational address path.
/// SRL D is a storage input, while A0..A4 select the current Q value.
pub fn is_addressable_sequential_type(cell_type: &str) -> bool {
    matches!(
        cell_type.to_ascii_uppercase().as_str(),
        "SRL16E" | "SRLC32E"
    )
}

pub fn is_blackbox_cell(
    cell: &YosysCell,
    blackbox_modules: &HashSet<String>,
    module_names: &HashSet<&str>,
) -> bool {
    is_blackbox_cell_with_vendor(
        cell,
        blackbox_modules,
        module_names,
        vendor_primitive_class(&cell.cell_type),
    )
}

fn is_blackbox_cell_with_vendor(
    cell: &YosysCell,
    blackbox_modules: &HashSet<String>,
    module_names: &HashSet<&str>,
    vendor_class: Option<VendorPrimitiveClass>,
) -> bool {
    let confirmed_primitive = is_memory_type(&cell.cell_type) || vendor_class.is_some();
    // Yosys carries `blackbox` from FPGA simulation-library declarations onto
    // otherwise confirmed primitive instances. Exact supported primitive
    // grammar must win here; arbitrary attributed cells remain blackboxes.
    if attr_truthy(&cell.attributes, "blackbox") && !confirmed_primitive {
        return true;
    }
    if confirmed_primitive {
        return false;
    }
    if blackbox_modules.contains(&cell.cell_type) {
        return true;
    }
    if module_names.contains(cell.cell_type.as_str()) {
        return false;
    }
    !cell.cell_type.starts_with('$')
}

pub fn cell_depth_weight(cell_type: &str) -> u32 {
    match vendor_primitive_class(cell_type) {
        Some(VendorPrimitiveClass::Combinational { depth_weight }) => depth_weight,
        Some(VendorPrimitiveClass::Sequential) | None => 1,
    }
}

/// Cells that are useful implementation accounting detail but add no logical
/// depth. Analysis views may collapse these into the net they buffer while the
/// raw implementation statistics continue to count them.
pub fn is_infrastructure_cell(cell_type: &str) -> bool {
    matches!(
        vendor_primitive_class(cell_type),
        Some(VendorPrimitiveClass::Combinational { depth_weight: 0 })
    )
}

/// Unconditional one-input buffers that preserve a data bit exactly. This is
/// deliberately narrower than `is_infrastructure_cell`: tri-state and
/// bidirectional IO primitives must not make an output look like a direct
/// register alias.
pub fn is_transparent_data_buffer(cell_type: &str) -> bool {
    matches!(
        cell_type.to_ascii_uppercase().as_str(),
        "IBUF" | "OBUF" | "BUFG" | "BUFH" | "SB_GB" | "$_BUF_"
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VendorPrimitiveClass {
    Combinational { depth_weight: u32 },
    Sequential,
}

// Primitive classification shared by the Yosys Xilinx, iCE40, and ECP5 flows.
// Anything not listed here remains a blackbox boundary when it is a non-$ cell.
fn vendor_primitive_class(cell_type: &str) -> Option<VendorPrimitiveClass> {
    let upper = cell_type.to_ascii_uppercase();
    if upper.starts_with("SB_DFF") {
        return Some(VendorPrimitiveClass::Sequential);
    }
    match upper.as_str() {
        "FDRE" | "FDRE_1" | "FDSE" | "FDSE_1" | "FDCE" | "FDCE_1" | "FDPE" | "FDPE_1" | "FDCPE"
        | "FDR" | "FDS" | "FDC" | "FDP" | "LDCE" | "LDPE" | "LDCPE" | "TRELLIS_FF" | "SRL16E"
        | "SRLC32E" => Some(VendorPrimitiveClass::Sequential),
        "LUT1" | "LUT2" | "LUT3" | "LUT4" | "LUT5" | "LUT6" | "LUT6_2" | "SB_LUT4" | "PFUMX"
        | "L6MUX21" | "CCU2C" | "CARRY4" | "CARRY8" | "MUXF7" | "MUXF8" | "MUXF9" | "INV"
        | "SB_CARRY" | "XORCY" | "MUXCY" => {
            Some(VendorPrimitiveClass::Combinational { depth_weight: 1 })
        }
        "IBUF" | "OBUF" | "OBUFT" | "IOBUF" | "BUFG" | "BUFGCE" | "BUFGCTRL" | "BUFH" | "SB_GB"
        | "$_BUF_" => Some(VendorPrimitiveClass::Combinational { depth_weight: 0 }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_pin_that_clocks_a_cell_is_a_clock_pin() {
        // The register clock: Xilinx spells it `C`, yosys `$dff`/`$_DFF_*` `CLK`.
        assert!(is_clock_pin_for_cell("FDRE", "C"));
        assert!(is_clock_pin_for_cell("FDRE", "c"));
        assert!(is_clock_pin_for_cell("$dff", "CLK"));
        assert!(is_clock_pin_for_cell("$_DFF_P_", "C"));
        // Memory primitives use both generic and vendor-specific spellings.
        for pin in [
            "RD_CLK",
            "WR_CLK",
            "WCLK",
            "RCLK",
            "CLKA",
            "CLKB",
            "CLKARDCLK",
        ] {
            assert!(is_clock_pin_for_cell("RAM32M", pin), "RAM32M.{pin}");
        }

        // A clock *enable* and a reset are control pins, but they are real
        // setup-constrained data paths: timing them is correct, so they must
        // not be mistaken for the clock network.
        for pin in ["D", "CE", "R", "S", "Q"] {
            assert!(!is_clock_pin_for_cell("FDRE", pin), "FDRE.{pin}");
        }
        assert!(!is_clock_pin_for_cell("$dffe", "EN"));
        assert!(!is_clock_pin_for_cell("$_DFFE_PP_", "E"));

        // A latch is transparent while its gate is asserted, and the gate is
        // clock-like. `$dffe` and `$dlatch` share the `EN`/`E` spelling, so the
        // gate reading is latch-only.
        assert!(is_clock_pin_for_cell("$dlatch", "EN"));
        assert!(is_clock_pin_for_cell("$_DLATCH_P_", "E"));
        assert!(is_clock_pin_for_cell("LDCE", "G"));
        // `GE` is a gate *enable*, which is data.
        assert!(!is_clock_pin_for_cell("LDCE", "GE"));

        // On a blackbox, a port named `C`/`E`/`G` is just as likely to be data,
        // so only the unambiguous spelling counts.
        assert!(is_clock_pin_for_cell("my_ip_core", "CLK"));
        assert!(!is_clock_pin_for_cell("my_ip_core", "C"));
        assert!(!is_clock_pin_for_cell("LUT3", "I0"));
    }

    #[test]
    fn latch_types_are_recognized_across_spellings() {
        for latch in [
            "$dlatch",
            "$adlatch",
            "$_DLATCH_P_",
            "LDCE",
            "LDPE",
            "LDCPE",
        ] {
            assert!(is_latch_type(latch), "{latch}");
        }
        for not_latch in ["FDRE", "$dff", "$dffe", "LUT6"] {
            assert!(!is_latch_type(not_latch), "{not_latch}");
        }
    }

    #[test]
    fn memory_types_cover_supported_primitives_without_claiming_named_blackboxes() {
        for memory in [
            "$mem_v2",
            "RAM64M",
            "RAM64X1S_1",
            "RAM64X8SW",
            "RAM32X16DR8",
            "RAMD32",
            "RAMD64X1",
            "RAMS64E",
            "RAMS32X1",
            "RAMB4_S8_S8",
            "RAMB8BWER",
            "RAMB16BWE_S18_S9",
            "RAMB36E2",
            "URAM288",
            "URAM288_BASE",
            "DP16KD",
            "TRELLIS_DPR16X4",
            "SB_RAM40_4K",
            "SB_RAM40_4KNRNW",
            "SB_SPRAM256KA",
            "SRLC32E",
        ] {
            assert!(is_memory_type(memory), "{memory}");
        }
        for blackbox in [
            "RAM_CONTROLLER",
            "RAMDISK",
            "RAMBUS",
            "RAM64_CONTROLLER",
            "RAM64CONTROLLER",
            "RAM64X1CACHE",
            "RAMB36CONTROLLER",
            "RAMB4_S36",
            "RAMB16BWE_S1",
            "RAMB16_S36_S1",
            "RAMD32CACHE",
            "URAM_CACHE",
            "URAM288CACHE",
            "SPRAM_CONTROLLER",
            "TRELLIS_DPR_CONTROLLER",
            "SB_RAM_WRAPPER",
            "SB_RAM40_CONTROLLER",
            "memory_wrapper",
            "my_ram",
        ] {
            assert!(!is_memory_type(blackbox), "{blackbox}");
        }
    }

    #[test]
    fn numbered_user_blackboxes_do_not_match_primitive_grammar() {
        let cell = YosysCell {
            cell_type: "RAM64_CONTROLLER".to_owned(),
            hide_name: 0,
            parameters: BTreeMap::new(),
            attributes: BTreeMap::new(),
            port_directions: BTreeMap::new(),
            connections: BTreeMap::new(),
        };

        assert!(is_blackbox_cell(
            &cell,
            &HashSet::from(["RAM64_CONTROLLER".to_owned()]),
            &HashSet::from(["RAM64_CONTROLLER"]),
        ));

        let mut library_primitive = cell;
        library_primitive.cell_type = "RAM64M".to_owned();
        library_primitive
            .attributes
            .insert("blackbox".to_owned(), "1".to_owned());
        assert!(!is_blackbox_cell(
            &library_primitive,
            &HashSet::from(["RAM64M".to_owned()]),
            &HashSet::from(["RAM64M"]),
        ));
    }
}
