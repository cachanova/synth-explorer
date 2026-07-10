use crate::netlist::{
    PortDirection, YosysBit, YosysCell, YosysModule, YosysNetlist, attr_truthy,
    binary_string_to_u64, module_blackboxes,
};
use std::collections::{BTreeMap, HashMap, HashSet};

pub type NodeId = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Cell,
    PortBit,
    Const,
}

#[derive(Debug, Clone)]
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

#[derive(Debug, Clone)]
pub struct Edge {
    pub from: NodeId,
    pub to: NodeId,
    pub from_port: String,
    pub to_port: String,
    pub bit: Option<u32>,
    pub net_name: String,
    pub control: bool,
}

#[derive(Debug, Clone)]
pub struct CellInfo {
    pub q_bits: Vec<YosysBit>,
    pub d_bits: Vec<YosysBit>,
    pub clock_net: Option<String>,
    pub output_ports: HashSet<String>,
    pub input_ports: HashSet<String>,
}

#[derive(Debug, Clone)]
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
}

#[derive(Debug, thiserror::Error)]
pub enum GraphError {
    #[error("node count exceeds u32 id space")]
    TooManyNodes,
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
            for (idx, bit) in port.bits.iter().enumerate() {
                let name = bit
                    .net()
                    .and_then(|net| builder.net_names.get(&net).cloned())
                    .unwrap_or_else(|| bit_name(port_name, idx, port.bits.len()));
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
            let seq_kind = is_sequential_type(&cell.cell_type);
            let blackbox = is_blackbox_cell(cell, &blackbox_modules, &module_names);
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
            for control_pin in CONTROL_PINS {
                if let Some(bits) = cell.connections.get(*control_pin) {
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
                for port in &output_ports {
                    if let Some(bits) = cell.connections.get(port) {
                        info.q_bits.extend(bits.clone());
                    }
                }
            }
            if builder.nodes[node_id as usize].seq && info.d_bits.is_empty() {
                for port in &input_ports {
                    if is_control_pin(port) {
                        continue;
                    }
                    if let Some(bits) = cell.connections.get(port) {
                        info.d_bits.extend(bits.clone());
                    }
                }
            }
            if builder.nodes[node_id as usize].seq
                && let Some(name) = info
                    .q_bits
                    .iter()
                    .find_map(|bit| bit.net())
                    .and_then(|net| builder.net_names.get(&net).cloned())
            {
                builder.nodes[node_id as usize].name = strip_bit_suffix(&name).to_owned();
            }
            for output_port in &output_ports {
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
            for input_port in input_ports(cell) {
                let Some(bits) = cell.connections.get(&input_port) else {
                    continue;
                };
                for bit in bits {
                    let control = is_control_pin(&input_port);
                    let net_name = bit_to_name(bit, &builder.net_names);
                    for (driver_id, driver_port) in
                        resolve_drivers(bit, &drivers, &mut builder, &mut const_nodes)?
                    {
                        builder.add_edge(Edge {
                            from: driver_id,
                            to: sink_id,
                            from_port: driver_port,
                            to_port: input_port.clone(),
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
                        bit: bit.net(),
                        net_name: net_name.clone(),
                        control: false,
                    });
                }
            }
        }

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

pub const CONTROL_PINS: &[&str] = &[
    "CLK", "C", "E", "EN", "R", "S", "ARST", "SRST", "CLR", "PRE", "CE", "RST", "LSR", "SR",
];

pub fn is_control_pin(port: &str) -> bool {
    CONTROL_PINS
        .iter()
        .any(|pin| pin.eq_ignore_ascii_case(port))
}

pub fn is_data_pin(port: &str) -> bool {
    !is_control_pin(port)
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
        } else if upper == "WIDTH" || upper.ends_with("_WIDTH") {
            let formatted = binary_string_to_u64(value)
                .map(|num| num.to_string())
                .unwrap_or_else(|| value.clone());
            out.insert(key.clone(), formatted);
        }
    }
    out
}

pub fn is_sequential_type(cell_type: &str) -> bool {
    let upper = cell_type.to_ascii_uppercase();
    cell_type.starts_with("$dff")
        || cell_type.starts_with("$sdff")
        || cell_type.starts_with("$adff")
        || cell_type.starts_with("$aldff")
        || cell_type.starts_with("$dffe")
        || cell_type == "$ff"
        || cell_type.starts_with("$mem")
        || upper.starts_with("$_DFF")
        || upper.starts_with("$_SDFF")
        || upper.starts_with("$_ALDFF")
        || upper == "$_FF_"
        || matches!(
            vendor_primitive_class(cell_type),
            Some(VendorPrimitiveClass::Sequential)
        )
}

pub fn is_blackbox_cell(
    cell: &YosysCell,
    blackbox_modules: &HashSet<String>,
    module_names: &HashSet<&str>,
) -> bool {
    if attr_truthy(&cell.attributes, "blackbox") {
        return true;
    }
    if vendor_primitive_class(&cell.cell_type).is_some() {
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
        "FDRE" | "FDSE" | "FDCE" | "FDPE" | "FDR" | "FDS" | "FDC" | "FDP" | "TRELLIS_FF"
        | "SRL16E" | "SRLC32E" => Some(VendorPrimitiveClass::Sequential),
        "LUT1" | "LUT2" | "LUT3" | "LUT4" | "LUT5" | "LUT6" | "SB_LUT4" | "PFUMX" | "L6MUX21"
        | "CCU2C" | "CARRY4" | "CARRY8" | "MUXF7" | "MUXF8" | "MUXF9" | "INV" | "SB_CARRY"
        | "XORCY" | "MUXCY" => Some(VendorPrimitiveClass::Combinational { depth_weight: 1 }),
        "IBUF" | "OBUF" | "OBUFT" | "IOBUF" | "BUFG" | "BUFGCE" | "BUFGCTRL" | "BUFH" | "SB_GB"
        | "$_BUF_" => Some(VendorPrimitiveClass::Combinational { depth_weight: 0 }),
        _ => None,
    }
}
