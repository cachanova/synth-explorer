//! Bit-parallel structural grouping. Register vectors come straight from the
//! endpoint analysis; combinational cells are grouped by bounded partition
//! refinement plus a final 1:1 bit-correspondence check so that only true
//! bit-parallel structures collapse (carry chains and shared-bit fanin never
//! group). Every step is deterministic for a given graph and register list.

use crate::analysis::RegisterGroup;
use crate::graph::{Graph, NodeId, NodeKind, strip_bit_suffix};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub type GroupId = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupKind {
    Register,
    Comb,
    Port,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub kind: GroupKind,
    /// Sorted, always at least two distinct nodes.
    pub members: Vec<NodeId>,
    /// `"sum[17:0]"` for contiguous bit indices, `"sum ×18"` otherwise.
    pub label: String,
    pub cell_type: String,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct GroupPartition {
    pub groups: Vec<Group>,
    pub group_of: HashMap<NodeId, GroupId>,
}

/// Refinement stops once the class count is stable, but never runs more than
/// this many rounds so pathological structures (long chains) stay near-linear.
const MAX_REFINEMENT_ROUNDS: usize = 8;

impl GroupPartition {
    /// Deterministic estimate of retained allocation for cache weighting.
    pub fn estimated_heap_bytes(&self) -> usize {
        let mut bytes =
            self.groups
                .capacity()
                .saturating_mul(std::mem::size_of::<Group>())
                .saturating_add(self.group_of.capacity().saturating_mul(
                    std::mem::size_of::<NodeId>() + std::mem::size_of::<GroupId>(),
                ));
        for group in &self.groups {
            bytes = bytes
                .saturating_add(group.label.capacity())
                .saturating_add(group.cell_type.capacity())
                .saturating_add(
                    group
                        .members
                        .capacity()
                        .saturating_mul(std::mem::size_of::<NodeId>()),
                );
        }
        bytes
    }

    /// Near-linear: bounded partition refinement (max 8 rounds) + 1:1 check.
    /// Register groups seed from the endpoint analysis; each refinement round
    /// costs O(edges) and hashes full signatures to class ids, so no all-pairs
    /// comparison ever happens.
    pub fn build(graph: &Graph, registers: &[RegisterGroup]) -> GroupPartition {
        let mut partition = GroupPartition::default();
        seed_register_groups(&mut partition, registers);

        let comb: Vec<NodeId> = graph
            .nodes
            .iter()
            .filter(|node| graph.is_comb(node.id))
            .map(|node| node.id)
            .collect();
        let mut interner = Interner::default();
        let classes = refine_comb_classes(graph, &partition.group_of, &comb, &mut interner);

        let mut members_by_class: BTreeMap<u32, Vec<NodeId>> = BTreeMap::new();
        for &id in &comb {
            members_by_class
                .entry(classes[id as usize])
                .or_default()
                .push(id);
        }
        let mut candidates: Vec<Vec<NodeId>> = members_by_class
            .into_values()
            .filter(|members| members.len() >= 2)
            .collect();
        candidates.sort_by_key(|members| members[0]);

        for members in candidates {
            if !bit_correspondence_holds(
                graph,
                &partition.group_of,
                &classes,
                &mut interner,
                &members,
            ) {
                continue;
            }
            let group_id = partition.groups.len() as GroupId;
            let cell_type = graph.nodes[members[0] as usize]
                .cell_type
                .clone()
                .unwrap_or_default();
            let label = comb_label(graph, &members, &cell_type);
            for &member in &members {
                partition.group_of.insert(member, group_id);
            }
            partition.groups.push(Group {
                kind: GroupKind::Comb,
                members,
                label,
                cell_type,
            });
        }
        // Ports seed last so register and comb group ids stay stable; port
        // grouping is by name only and never affects comb refinement.
        seed_port_groups(&mut partition, graph);
        partition
    }
}

/// Register vectors are trusted from the endpoint analysis; only groups that
/// actually span at least two cells collapse anything (a single multi-bit
/// `$dff` already renders as one node).
fn seed_register_groups(partition: &mut GroupPartition, registers: &[RegisterGroup]) {
    for register in registers {
        if register.width < 2 {
            continue;
        }
        let members: BTreeSet<NodeId> = register.bits.iter().map(|bit| bit.node_id).collect();
        if members.len() < 2 || members.iter().any(|id| partition.group_of.contains_key(id)) {
            continue;
        }
        let group_id = partition.groups.len() as GroupId;
        for &member in &members {
            partition.group_of.insert(member, group_id);
        }
        partition.groups.push(Group {
            kind: GroupKind::Register,
            members: members.into_iter().collect(),
            label: register_label(register),
            cell_type: register.cell_type.clone(),
        });
    }
}

/// Port bits of one named vector (`data[7:0]`) collapse into a single bus port
/// node, mirroring register vectors. Grouping is purely by port name, so any
/// bits of the port present in the subgraph render as one node; a scalar port
/// (single bit) stays ungrouped. Runs after registers so a port bit already
/// claimed by another group (never expected) is left alone.
fn seed_port_groups(partition: &mut GroupPartition, graph: &Graph) {
    let mut by_port: BTreeMap<&str, Vec<NodeId>> = BTreeMap::new();
    for node in &graph.nodes {
        if node.kind != NodeKind::PortBit {
            continue;
        }
        let Some(port) = node.port.as_deref() else {
            continue;
        };
        if partition.group_of.contains_key(&node.id) {
            continue;
        }
        by_port.entry(port).or_default().push(node.id);
    }
    for (port, mut members) in by_port {
        if members.len() < 2 {
            continue;
        }
        members.sort_unstable();
        let group_id = partition.groups.len() as GroupId;
        let label = port_label(graph, port, &members);
        for &member in &members {
            partition.group_of.insert(member, group_id);
        }
        partition.groups.push(Group {
            kind: GroupKind::Port,
            members,
            label,
            cell_type: String::new(),
        });
    }
}

/// `"data[7:0]"` when the grouped port bits form one contiguous run, otherwise
/// `"data ×N"`.
fn port_label(graph: &Graph, port: &str, members: &[NodeId]) -> String {
    let bits: BTreeSet<usize> = members
        .iter()
        .filter_map(|&id| graph.nodes[id as usize].port_bit)
        .collect();
    if bits.len() == members.len()
        && let (Some(&lo), Some(&hi)) = (bits.first(), bits.last())
        && hi - lo + 1 == bits.len()
    {
        return format!("{port}[{hi}:{lo}]");
    }
    format!("{port} ×{}", members.len())
}

/// Neighbor identity as seen by a refinement signature. Grouped registers
/// count as their group from round 0; port bits collapse per port name so a
/// vector fed by distinct bits of one port refines together; every other
/// non-comb node is its own anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum NeighborClass {
    Register(GroupId),
    Comb(u32),
    Port(u32),
    Const(u32),
    Anchor(NodeId),
}

#[derive(PartialEq, Eq, Hash)]
struct Signature {
    class: u32,
    incoming: Vec<(NeighborClass, u32, u32)>,
    outgoing: Vec<(NeighborClass, u32, u32)>,
}

/// Deterministic string-to-id mapping for port and const names, so signature
/// keys stay compact instead of cloning strings every round.
#[derive(Default)]
struct Interner(HashMap<String, u32>);

impl Interner {
    fn id(&mut self, value: &str) -> u32 {
        if let Some(&id) = self.0.get(value) {
            return id;
        }
        let id = self.0.len() as u32;
        self.0.insert(value.to_owned(), id);
        id
    }
}

fn neighbor_class(
    graph: &Graph,
    register_of: &HashMap<NodeId, GroupId>,
    classes: &[u32],
    interner: &mut Interner,
    id: NodeId,
) -> NeighborClass {
    let node = &graph.nodes[id as usize];
    match node.kind {
        NodeKind::Cell if graph.is_comb(id) => NeighborClass::Comb(classes[id as usize]),
        NodeKind::Cell => register_of
            .get(&id)
            .map_or(NeighborClass::Anchor(id), |&group| {
                NeighborClass::Register(group)
            }),
        NodeKind::PortBit => {
            NeighborClass::Port(interner.id(node.port.as_deref().unwrap_or(&node.name)))
        }
        NodeKind::Const => NeighborClass::Const(interner.id(&node.name)),
    }
}

fn signature(
    graph: &Graph,
    register_of: &HashMap<NodeId, GroupId>,
    classes: &[u32],
    interner: &mut Interner,
    id: NodeId,
) -> Signature {
    let mut incoming = Vec::with_capacity(graph.incoming[id as usize].len());
    for &edge_idx in &graph.incoming[id as usize] {
        let edge = &graph.edges[edge_idx];
        if edge.control {
            continue;
        }
        incoming.push((
            neighbor_class(graph, register_of, classes, interner, edge.from),
            interner.id(&edge.from_port),
            interner.id(&edge.to_port),
        ));
    }
    incoming.sort_unstable();
    let mut outgoing = Vec::with_capacity(graph.outgoing[id as usize].len());
    for &edge_idx in &graph.outgoing[id as usize] {
        let edge = &graph.edges[edge_idx];
        if edge.control {
            continue;
        }
        outgoing.push((
            neighbor_class(graph, register_of, classes, interner, edge.to),
            interner.id(&edge.from_port),
            interner.id(&edge.to_port),
        ));
    }
    outgoing.sort_unstable();
    Signature {
        class: classes[id as usize],
        incoming,
        outgoing,
    }
}

/// Signatures only ever split classes (the previous class is part of the
/// signature), so an unchanged class count means the partition converged.
fn refine_comb_classes(
    graph: &Graph,
    register_of: &HashMap<NodeId, GroupId>,
    comb: &[NodeId],
    interner: &mut Interner,
) -> Vec<u32> {
    let mut classes = vec![0u32; graph.nodes.len()];
    let mut count;
    {
        let mut type_ids: HashMap<&str, u32> = HashMap::new();
        for &id in comb {
            let cell_type = graph.nodes[id as usize].cell_type.as_deref().unwrap_or("");
            let next = type_ids.len() as u32;
            classes[id as usize] = *type_ids.entry(cell_type).or_insert(next);
        }
        count = type_ids.len();
    }
    for _ in 0..MAX_REFINEMENT_ROUNDS {
        let mut signature_ids: HashMap<Signature, u32> = HashMap::new();
        let mut next = vec![0u32; graph.nodes.len()];
        for &id in comb {
            let signature = signature(graph, register_of, &classes, interner, id);
            let candidate = signature_ids.len() as u32;
            next[id as usize] = *signature_ids.entry(signature).or_insert(candidate);
        }
        let new_count = signature_ids.len();
        classes = next;
        if new_count == count {
            break;
        }
        count = new_count;
    }
    classes
}

/// Final 1:1 bit-correspondence check. Per direction and adjacent class each
/// member must touch exactly one distinct neighbor node, and across members
/// those picks must be either all distinct (a true bit correspondence) or all
/// the same node (a shared broadcast such as a mux select). Any edge inside
/// the candidate class itself — carry chains, shift structures — is fatal.
/// State is bounded by the class's member and edge counts.
fn bit_correspondence_holds(
    graph: &Graph,
    register_of: &HashMap<NodeId, GroupId>,
    classes: &[u32],
    interner: &mut Interner,
    members: &[NodeId],
) -> bool {
    let own = NeighborClass::Comb(classes[members[0] as usize]);
    let mut picks: BTreeMap<(bool, NeighborClass), Vec<NodeId>> = BTreeMap::new();
    for &member in members {
        let mut local: BTreeMap<(bool, NeighborClass), BTreeSet<NodeId>> = BTreeMap::new();
        for (is_incoming, edge_indices) in [
            (true, &graph.incoming[member as usize]),
            (false, &graph.outgoing[member as usize]),
        ] {
            for &edge_idx in edge_indices {
                let edge = &graph.edges[edge_idx];
                if edge.control {
                    continue;
                }
                let neighbor = if is_incoming { edge.from } else { edge.to };
                let class = neighbor_class(graph, register_of, classes, interner, neighbor);
                if class == own {
                    return false;
                }
                local
                    .entry((is_incoming, class))
                    .or_default()
                    .insert(neighbor);
            }
        }
        for (key, neighbors) in local {
            if neighbors.len() != 1 {
                return false;
            }
            picks
                .entry(key)
                .or_default()
                .extend(neighbors.into_iter().next());
        }
    }
    picks.values().all(|chosen| {
        if chosen.len() != members.len() {
            return false;
        }
        let distinct: BTreeSet<NodeId> = chosen.iter().copied().collect();
        distinct.len() == 1 || distinct.len() == chosen.len()
    })
}

/// `"name[hi:lo]"` when the group's bit indices are one contiguous run with
/// no duplicates, otherwise `"name ×N"`.
fn register_label(register: &RegisterGroup) -> String {
    let bits: BTreeSet<usize> = register.bits.iter().map(|bit| bit.bit).collect();
    if bits.len() == register.bits.len()
        && let (Some(&lo), Some(&hi)) = (bits.first(), bits.last())
        && hi - lo + 1 == bits.len()
    {
        return format!("{}[{hi}:{lo}]", register.name);
    }
    format!("{} ×{}", register.name, register.bits.len())
}

/// Label from the dominant visible driven-net stem: `"stem[hi:lo]"` when every
/// member drives one distinct bit of a contiguous run, `"stem ×N"` when the
/// stem exists but the bits do not line up, `"{cell_type} ×{N}"` when every
/// driven net is hidden.
fn comb_label(graph: &Graph, members: &[NodeId], cell_type: &str) -> String {
    let mut members_by_stem: BTreeMap<&str, BTreeSet<NodeId>> = BTreeMap::new();
    let mut bits_by_stem: BTreeMap<&str, BTreeSet<Option<usize>>> = BTreeMap::new();
    for &member in members {
        for &edge_idx in &graph.outgoing[member as usize] {
            let edge = &graph.edges[edge_idx];
            if edge.control {
                continue;
            }
            let name = edge.net_name.as_str();
            if name.is_empty() || name.starts_with('$') {
                continue;
            }
            let stem = strip_bit_suffix(name);
            members_by_stem.entry(stem).or_default().insert(member);
            bits_by_stem
                .entry(stem)
                .or_default()
                .insert(bit_index(name));
        }
    }
    let mut dominant: Option<(&str, usize)> = None;
    for (stem, stem_members) in &members_by_stem {
        if dominant.is_none_or(|(_, count)| stem_members.len() > count) {
            dominant = Some((stem, stem_members.len()));
        }
    }
    let Some((stem, covered)) = dominant else {
        return format!("{cell_type} ×{}", members.len());
    };
    if covered == members.len()
        && let Some(indices) = bits_by_stem[stem]
            .iter()
            .copied()
            .collect::<Option<BTreeSet<usize>>>()
        && indices.len() == members.len()
        && let (Some(&lo), Some(&hi)) = (indices.first(), indices.last())
        && hi - lo + 1 == indices.len()
    {
        return format!("{stem}[{hi}:{lo}]");
    }
    format!("{stem} ×{}", members.len())
}

fn bit_index(name: &str) -> Option<usize> {
    name.rsplit_once('[')?.1.strip_suffix(']')?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::{Analysis, EndpointBit};
    use crate::graph::{CellInfo, Edge, Node};
    use crate::netlist::{PortDirection, YosysBit};
    use std::collections::HashSet;

    fn port_bit(id: NodeId, port: &str, bit: usize, width: usize, dir: PortDirection) -> Node {
        Node {
            id,
            kind: NodeKind::PortBit,
            name: if width > 1 {
                format!("{port}[{bit}]")
            } else {
                port.to_owned()
            },
            raw_name: port.to_owned(),
            cell_type: None,
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: Some(port.to_owned()),
            port_bit: Some(bit),
            port_dir: Some(dir),
            const_value: None,
        }
    }

    fn comb_cell(id: NodeId, cell_type: &str) -> Node {
        Node {
            id,
            kind: NodeKind::Cell,
            name: format!("n{id}"),
            raw_name: format!("n{id}"),
            cell_type: Some(cell_type.to_owned()),
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: None,
            port_bit: None,
            port_dir: None,
            const_value: None,
        }
    }

    fn dff_cell(id: NodeId, name: &str) -> Node {
        Node {
            id,
            kind: NodeKind::Cell,
            name: name.to_owned(),
            raw_name: name.to_owned(),
            cell_type: Some("$_DFF_P_".to_owned()),
            seq: true,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: None,
            port_bit: None,
            port_dir: None,
            const_value: None,
        }
    }

    fn graph_from_nodes(top: &str, nodes: Vec<Node>) -> Graph {
        let count = nodes.len();
        Graph {
            nodes,
            edges: Vec::new(),
            outgoing: vec![Vec::new(); count],
            incoming: vec![Vec::new(); count],
            top: top.to_owned(),
            net_names: HashMap::new(),
            net_aliases: HashMap::new(),
            cell_info: HashMap::new(),
            blackboxes: Vec::new(),
            signal_fanout: HashMap::new(),
        }
    }

    fn link(
        graph: &mut Graph,
        from: NodeId,
        to: NodeId,
        from_port: &str,
        to_port: &str,
        net: &str,
    ) {
        let idx = graph.edges.len();
        graph.edges.push(Edge {
            from,
            to,
            from_port: from_port.to_owned(),
            to_port: to_port.to_owned(),
            bit: Some(idx as u32),
            net_name: net.to_owned(),
            control: false,
        });
        graph.outgoing[from as usize].push(idx);
        graph.incoming[to as usize].push(idx);
    }

    fn register_group(name: &str, members: &[(usize, NodeId)]) -> RegisterGroup {
        RegisterGroup {
            name: name.to_owned(),
            width: members.len(),
            cell_type: "$_DFF_P_".to_owned(),
            clock: None,
            src: None,
            worst_depth: 0,
            bits: members
                .iter()
                .map(|&(bit, node_id)| EndpointBit {
                    bit,
                    node_id,
                    depth: 0,
                })
                .collect(),
            output_aliases: Vec::new(),
        }
    }

    /// Gates-mode register bank: one single-bit DFF cell per register bit,
    /// grouped by the endpoint analysis through shared Q-net alias stems.
    fn register_bank_graph(groups: usize, width: usize) -> Graph {
        let mut nodes = vec![port_bit(0, "in", 0, 1, PortDirection::Input)];
        let mut net_aliases = HashMap::new();
        let mut cell_info = HashMap::new();
        for group in 0..groups {
            for bit in 0..width {
                let id = (1 + group * width + bit) as NodeId;
                nodes.push(dff_cell(id, &format!("q{group}[{bit}]")));
                let q_net = (1_000_000 + group * width + bit) as u32;
                net_aliases.insert(q_net, vec![format!("q{group}[{bit}]")]);
                cell_info.insert(
                    id,
                    CellInfo {
                        q_bits: vec![YosysBit::Net(q_net)],
                        d_bits: vec![YosysBit::Net(id)],
                        clock_net: None,
                        output_ports: HashSet::from(["Q".to_owned()]),
                        input_ports: HashSet::from(["D".to_owned()]),
                    },
                );
            }
        }
        let count = nodes.len();
        let mut graph = graph_from_nodes("register_bank", nodes);
        graph.net_aliases = net_aliases;
        graph.cell_info = cell_info;
        for id in 1..count as NodeId {
            link(&mut graph, 0, id, "in", "D", &format!("d[{id}]"));
        }
        graph
    }

    /// Eight 2:1 mux bits: `A` from `a[i]`, `B` from `b[i]`, a shared select
    /// `s`, each driving one bit of an eight-bit register group `q`.
    fn mux_row_graph() -> (Graph, Vec<RegisterGroup>) {
        let width: usize = 8;
        let mut nodes = Vec::new();
        for i in 0..width {
            nodes.push(port_bit(i as NodeId, "a", i, width, PortDirection::Input));
        }
        for i in 0..width {
            nodes.push(port_bit(
                (width + i) as NodeId,
                "b",
                i,
                width,
                PortDirection::Input,
            ));
        }
        nodes.push(port_bit(16, "s", 0, 1, PortDirection::Input));
        for i in 0..width {
            nodes.push(comb_cell((17 + i) as NodeId, "$_MUX_"));
        }
        for i in 0..width {
            nodes.push(dff_cell((25 + i) as NodeId, &format!("q[{i}]")));
        }
        let mut graph = graph_from_nodes("mux_row", nodes);
        for i in 0..width as NodeId {
            link(&mut graph, i, 17 + i, "a", "A", &format!("a[{i}]"));
            link(&mut graph, 8 + i, 17 + i, "b", "B", &format!("b[{i}]"));
            link(&mut graph, 16, 17 + i, "s", "S", "s");
            link(
                &mut graph,
                17 + i,
                25 + i,
                "Y",
                "D",
                &format!("next_q[{i}]"),
            );
        }
        let bits: Vec<(usize, NodeId)> = (0..width).map(|i| (i, (25 + i) as NodeId)).collect();
        (graph, vec![register_group("q", &bits)])
    }

    /// Ripple chain: cell `i` consumes `a[i]` plus the previous cell's carry
    /// and drives `sum[i]` plus the next cell's carry input.
    fn carry_chain_graph(length: usize) -> Graph {
        let mut nodes = Vec::new();
        for i in 0..length {
            nodes.push(port_bit(i as NodeId, "a", i, length, PortDirection::Input));
        }
        for i in 0..length {
            nodes.push(comb_cell((length + i) as NodeId, "$_AND_"));
        }
        for i in 0..length {
            nodes.push(port_bit(
                (2 * length + i) as NodeId,
                "sum",
                i,
                length,
                PortDirection::Output,
            ));
        }
        let mut graph = graph_from_nodes("carry_chain", nodes);
        for i in 0..length {
            let cell = (length + i) as NodeId;
            link(&mut graph, i as NodeId, cell, "a", "A", &format!("a[{i}]"));
            if i + 1 < length {
                link(&mut graph, cell, cell + 1, "Y", "B", &format!("carry[{i}]"));
            }
            link(
                &mut graph,
                cell,
                (2 * length + i) as NodeId,
                "Y",
                "sum",
                &format!("sum[{i}]"),
            );
        }
        graph
    }

    /// Eight parallel cells fed by `a[i]`; the first four drive `x`, the last
    /// four drive `y`, so refinement must split them into two vectors.
    fn divergent_sink_graph() -> Graph {
        let mut nodes = Vec::new();
        for i in 0..8 {
            nodes.push(port_bit(i as NodeId, "a", i, 8, PortDirection::Input));
        }
        for i in 0..8 {
            nodes.push(comb_cell((8 + i) as NodeId, "$_AND_"));
        }
        for i in 0..4 {
            nodes.push(port_bit(
                (16 + i) as NodeId,
                "x",
                i,
                4,
                PortDirection::Output,
            ));
        }
        for i in 0..4 {
            nodes.push(port_bit(
                (20 + i) as NodeId,
                "y",
                i,
                4,
                PortDirection::Output,
            ));
        }
        let mut graph = graph_from_nodes("divergent", nodes);
        for i in 0..8u32 {
            link(&mut graph, i, 8 + i, "a", "A", &format!("a[{i}]"));
        }
        for i in 0..4u32 {
            link(&mut graph, 8 + i, 16 + i, "Y", "x", &format!("x[{i}]"));
            link(&mut graph, 12 + i, 20 + i, "Y", "y", &format!("y[{i}]"));
        }
        graph
    }

    #[test]
    fn register_bank_seeds_one_group_per_register_vector() {
        let graph = register_bank_graph(2, 8);
        let analysis = Analysis::new(&graph, vec!["bank.sv".to_owned()]);
        let registers = analysis.endpoints().registers;
        assert_eq!(registers.len(), 2);

        let partition = GroupPartition::build(&graph, &registers);

        assert_eq!(partition.groups.len(), 2);
        for (idx, group) in partition.groups.iter().enumerate() {
            assert_eq!(group.kind, GroupKind::Register);
            assert_eq!(group.members.len(), 8);
            assert!(group.members.windows(2).all(|pair| pair[0] < pair[1]));
            assert_eq!(group.label, format!("q{idx}[7:0]"));
            assert_eq!(group.cell_type, "$_DFF_P_");
        }
        assert_eq!(partition.group_of.len(), 16);
        assert_eq!(partition.group_of[&1], 0);
        assert_eq!(partition.group_of[&16], 1);
    }

    #[test]
    fn multibit_ports_group_into_one_bus_node_while_scalars_stay() {
        // Two 4-bit input buses, one scalar input, and a 4-bit output bus.
        let mut nodes = Vec::new();
        for bit in 0..4 {
            nodes.push(port_bit(bit as NodeId, "a", bit, 4, PortDirection::Input));
        }
        for bit in 0..4 {
            nodes.push(port_bit(4 + bit as NodeId, "b", bit, 4, PortDirection::Input));
        }
        nodes.push(port_bit(8, "sel", 0, 1, PortDirection::Input));
        for bit in 0..4 {
            nodes.push(port_bit(9 + bit as NodeId, "y", bit, 4, PortDirection::Output));
        }
        let graph = graph_from_nodes("top", nodes);

        let partition = GroupPartition::build(&graph, &[]);

        // a, b, y each collapse; the scalar `sel` does not.
        assert_eq!(partition.groups.len(), 3);
        for group in &partition.groups {
            assert_eq!(group.kind, GroupKind::Port);
            assert_eq!(group.members.len(), 4);
            assert!(group.cell_type.is_empty());
        }
        let labels: BTreeSet<&str> = partition.groups.iter().map(|g| g.label.as_str()).collect();
        assert_eq!(
            labels,
            ["a[3:0]", "b[3:0]", "y[3:0]"].into_iter().collect()
        );
        assert_eq!(partition.group_of.len(), 12);
        assert!(!partition.group_of.contains_key(&8));
    }

    #[test]
    fn bit_parallel_mux_row_groups_with_shared_select() {
        let (graph, registers) = mux_row_graph();

        let partition = GroupPartition::build(&graph, &registers);

        // register(q) + comb(next_q) + two input buses (a, b); scalar `s` stays.
        assert_eq!(partition.groups.len(), 4);
        let register = &partition.groups[0];
        assert_eq!(register.kind, GroupKind::Register);
        assert_eq!(register.members, (25..33).collect::<Vec<NodeId>>());
        assert_eq!(register.label, "q[7:0]");
        let comb = &partition.groups[1];
        assert_eq!(comb.kind, GroupKind::Comb);
        assert_eq!(comb.members, (17..25).collect::<Vec<NodeId>>());
        assert_eq!(comb.label, "next_q[7:0]");
        assert_eq!(comb.cell_type, "$_MUX_");
        let ports: Vec<(&str, &[NodeId])> = partition.groups[2..]
            .iter()
            .map(|g| {
                assert_eq!(g.kind, GroupKind::Port);
                (g.label.as_str(), g.members.as_slice())
            })
            .collect();
        assert_eq!(
            ports,
            vec![
                ("a[7:0]", (0..8).collect::<Vec<NodeId>>().as_slice()),
                ("b[7:0]", (8..16).collect::<Vec<NodeId>>().as_slice()),
            ]
        );
        assert_eq!(partition.group_of.len(), 32);
        assert_eq!(partition.group_of[&30], 0);
        assert_eq!(partition.group_of[&20], 1);
        assert!(!partition.group_of.contains_key(&16));
    }

    #[test]
    fn carry_chain_refuses_to_group() {
        // Deeper than the refinement round budget, so the middle cells still
        // share a class after eight rounds and only the 1:1 check rejects them.
        let graph = carry_chain_graph(24);

        let partition = GroupPartition::build(&graph, &[]);

        // Only the a/sum ports group; no carry cell (ids 24..48) ever joins one.
        assert!(partition.groups.iter().all(|g| g.kind == GroupKind::Port));
        assert!((24..48).all(|id| !partition.group_of.contains_key(&id)));
    }

    #[test]
    fn structurally_different_cones_and_narrow_registers_stay_singletons() {
        let mut nodes = vec![
            port_bit(0, "a", 0, 1, PortDirection::Input),
            port_bit(1, "b", 0, 1, PortDirection::Input),
            port_bit(2, "c", 0, 1, PortDirection::Input),
        ];
        for i in 0..3 {
            nodes.push(comb_cell(3 + i, "$_AND_"));
        }
        for i in 0..3u32 {
            nodes.push(dff_cell(6 + i, &format!("s{i}")));
        }
        let mut graph = graph_from_nodes("fsm", nodes);
        link(&mut graph, 0, 3, "a", "A", "a");
        link(&mut graph, 0, 4, "a", "A", "a");
        link(&mut graph, 1, 4, "b", "B", "b");
        link(&mut graph, 0, 5, "a", "A", "a");
        link(&mut graph, 1, 5, "b", "B", "b");
        link(&mut graph, 2, 5, "c", "C", "c");
        for i in 0..3u32 {
            link(&mut graph, 3 + i, 6 + i, "Y", "D", &format!("s{i}_next"));
        }

        // Width-1 register groups never seed a group.
        let narrow = vec![
            register_group("s0", &[(0, 6)]),
            register_group("s1", &[(0, 7)]),
            register_group("s2", &[(0, 8)]),
        ];
        let partition = GroupPartition::build(&graph, &narrow);
        assert!(partition.groups.is_empty());
        assert!(partition.group_of.is_empty());

        // A multi-bit register held in one cell has no second member to merge.
        let single_cell = vec![register_group("s_wide", &[(0, 6), (1, 6)])];
        let partition = GroupPartition::build(&graph, &single_cell);
        assert!(partition.groups.is_empty());
    }

    #[test]
    fn divergent_sink_shapes_split_into_two_groups() {
        let graph = divergent_sink_graph();

        let partition = GroupPartition::build(&graph, &[]);

        // Two comb vectors split by sink shape, plus the a/x/y bus ports.
        assert_eq!(partition.groups.len(), 5);
        let x = &partition.groups[0];
        assert_eq!(x.kind, GroupKind::Comb);
        assert_eq!(x.members, vec![8, 9, 10, 11]);
        assert_eq!(x.label, "x[3:0]");
        let y = &partition.groups[1];
        assert_eq!(y.members, vec![12, 13, 14, 15]);
        assert_eq!(y.label, "y[3:0]");
        assert!(partition.groups[2..]
            .iter()
            .all(|g| g.kind == GroupKind::Port));
    }

    #[test]
    fn partition_is_deterministic_across_runs() {
        let (graph, registers) = mux_row_graph();
        let first = GroupPartition::build(&graph, &registers);
        let second = GroupPartition::build(&graph, &registers);
        assert_eq!(first, second);

        let divergent = divergent_sink_graph();
        let first = GroupPartition::build(&divergent, &[]);
        let second = GroupPartition::build(&divergent, &[]);
        assert_eq!(first, second);
    }
}
