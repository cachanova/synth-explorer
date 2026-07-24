//! Deterministic bit-parallel grouping for schematic projections. Logical
//! memories claim their mapped primitives before remaining register vectors;
//! parallel addressable-memory lanes and combinational cells are grouped by bounded partition
//! refinement plus a final 1:1 bit-correspondence check so that only true
//! bit-parallel structures collapse (carry chains and shared-bit fanin never
//! group). Logical memories seed from the provenance netlist. Every step is
//! deterministic for a given graph, register list, and memory list.

use crate::analysis::RegisterGroup;
use crate::graph::{
    Graph, NodeId, NodeKind, is_addressable_sequential_type, is_memory_type, strip_bit_suffix,
};
use crate::netlist::YosysNetlist;
use deepsize::DeepSizeOf;
use rtl_correlate::NetlistDialect;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

pub type GroupId = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, DeepSizeOf)]
#[serde(rename_all = "lowercase")]
pub enum GroupKind {
    Register,
    Memory,
    Comb,
    Port,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryArray {
    pub name: String,
    pub width: usize,
    pub depth: usize,
    pub members: Vec<NodeId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, DeepSizeOf)]
pub struct Group {
    pub kind: GroupKind,
    /// Sorted distinct nodes. Structural-vector groups contain at least two;
    /// a logical-memory group may wrap one physical primitive so its RTL shape
    /// and identity survive mapping.
    pub members: Vec<NodeId>,
    /// `"sum[17:0]"` for contiguous bit indices, `"sum ×18"` otherwise.
    pub label: String,
    pub cell_type: String,
}

#[derive(Debug, Default, Clone, PartialEq, DeepSizeOf)]
pub struct GroupPartition {
    pub groups: Vec<Group>,
    pub group_of: HashMap<NodeId, GroupId>,
}

/// Borrowed view of the canonical partition with independently selectable
/// structural-vector and memory groups. Group ids never change when a
/// presentation policy changes, so synthetic ids remain stable across toggles.
#[derive(Clone, Copy)]
pub struct GroupingProjection<'a> {
    pub partition: &'a GroupPartition,
    pub vectors: bool,
    pub memories: bool,
    /// Canonical group ids rendered as their physical members for a local,
    /// reversible expansion. The partition itself remains unchanged, keeping
    /// every synthetic id stable when the group is collapsed again.
    pub expanded_groups: &'a [GroupId],
}

impl<'a> GroupingProjection<'a> {
    pub fn from_flags(
        partition: &'a GroupPartition,
        vectors: bool,
        memories: bool,
    ) -> Option<Self> {
        (vectors || memories).then_some(Self {
            partition,
            vectors,
            memories,
            expanded_groups: &[],
        })
    }

    pub fn from_flags_with_expanded(
        partition: &'a GroupPartition,
        vectors: bool,
        memories: bool,
        expanded_groups: &'a [GroupId],
    ) -> Option<Self> {
        (vectors || memories).then_some(Self {
            partition,
            vectors,
            memories,
            expanded_groups,
        })
    }

    pub fn all(partition: &'a GroupPartition) -> Self {
        Self {
            partition,
            vectors: true,
            memories: true,
            expanded_groups: &[],
        }
    }

    pub fn group_id(self, id: NodeId) -> Option<GroupId> {
        let group_id = *self.partition.group_of.get(&id)?;
        if self.expanded_groups.contains(&group_id) {
            return None;
        }
        let group = self.partition.groups.get(group_id as usize)?;
        let enabled = match group.kind {
            GroupKind::Memory => self.memories,
            GroupKind::Register | GroupKind::Comb | GroupKind::Port => self.vectors,
        };
        enabled.then_some(group_id)
    }

    pub fn group(self, id: NodeId) -> Option<(GroupId, &'a Group)> {
        let group_id = self.group_id(id)?;
        Some((group_id, &self.partition.groups[group_id as usize]))
    }
}

/// Refinement stops once the class count is stable, but never runs more than
/// this many rounds so pathological structures (long chains) stay near-linear.
const MAX_REFINEMENT_ROUNDS: usize = 8;

impl GroupPartition {
    /// Near-linear: bounded partition refinement (max 8 rounds) + 1:1 check.
    /// Memory and register groups seed from provenance, strict lane evidence,
    /// and endpoint analysis; each refinement round costs O(edges) and hashes
    /// full signatures to class ids, so no all-pairs comparison ever happens.
    pub fn build(
        graph: &Graph,
        registers: &[RegisterGroup],
        memories: Vec<MemoryArray>,
    ) -> GroupPartition {
        let mut partition = GroupPartition::default();
        seed_memory_groups(&mut partition, graph, memories);
        seed_memory_input_mirror_register_groups(&mut partition, graph);
        seed_register_groups(&mut partition, registers);

        let mut comb = Vec::new();
        let mut structural_memories = Vec::new();
        for node in &graph.nodes {
            if graph.is_comb(node.id) {
                comb.push(node.id);
            } else if node.kind == NodeKind::Cell
                && !node.blackbox
                && node
                    .cell_type
                    .as_deref()
                    .is_some_and(is_addressable_sequential_type)
                && !partition.group_of.contains_key(&node.id)
            {
                structural_memories.push(node.id);
            }
        }
        // Refine combinational wrappers and addressable-memory lanes together.
        // Their classes can be mutually dependent (for example LUT -> SRL), so
        // two separate refinement passes would leave each side as unique
        // anchors and miss the parallel vector.
        let mut refined_cells = Vec::with_capacity(comb.len() + structural_memories.len());
        refined_cells.extend_from_slice(&comb);
        refined_cells.extend_from_slice(&structural_memories);
        let refined_mask = candidate_mask(graph, &refined_cells);
        let mut interner = Interner::default();
        let classes = refine_cell_classes(
            graph,
            &partition.group_of,
            &refined_cells,
            &refined_mask,
            &mut interner,
        );
        seed_structural_memory_groups(
            &mut partition,
            graph,
            &structural_memories,
            &classes,
            &refined_mask,
            &mut interner,
        );

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
                &refined_mask,
                &mut interner,
                &members,
                false,
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

/// Resolve logical RTL memories from the provenance netlist to the physical
/// memory primitives in the final flattened graph. Yosys keeps the logical
/// memory path as the prefix of mapped cells (`memory.0.0`, `u.fifo.0.3`), so
/// the closest path match associates each primitive with exactly one array.
pub fn memory_arrays_from_source(
    graph: &Graph,
    source_netlist: &YosysNetlist,
    source_top: &str,
    registers: &[RegisterGroup],
) -> Vec<MemoryArray> {
    #[derive(Debug)]
    struct LogicalMemory {
        name: String,
        width: usize,
        depth: usize,
    }

    fn clean_name(name: &str) -> String {
        name.trim_start_matches('\\').replace('\\', "")
    }

    let mut logical = Vec::new();
    let mut source_memory_cell_paths = HashSet::new();
    let mut pending = vec![(source_top.to_owned(), String::new())];
    let mut seen = BTreeSet::new();
    while let Some((module_name, scope)) = pending.pop() {
        if !seen.insert((module_name.clone(), scope.clone())) {
            continue;
        }
        let Some(module) = source_netlist.modules.get(&module_name) else {
            continue;
        };
        for (memory_name, memory) in &module.memories {
            let memory_name = clean_name(memory_name);
            let name = if scope.is_empty() {
                memory_name
            } else {
                format!("{scope}.{memory_name}")
            };
            logical.push(LogicalMemory {
                name,
                width: memory.width,
                depth: memory.size,
            });
        }
        for (cell_name, cell) in &module.cells {
            let child_module = source_netlist.modules.contains_key(&cell.cell_type);
            let explicit_memory = is_memory_type(&cell.cell_type);
            if !child_module && !explicit_memory {
                continue;
            }
            let cell_name = clean_name(cell_name);
            let cell_path = if scope.is_empty() {
                cell_name
            } else {
                format!("{scope}.{cell_name}")
            };
            if explicit_memory {
                source_memory_cell_paths.insert(cell_path.clone());
            }
            if child_module {
                pending.push((cell.cell_type.clone(), cell_path));
            }
        }
    }

    logical.sort_by(|left, right| left.name.cmp(&right.name));
    if logical.is_empty() {
        return Vec::new();
    }
    // Escaped identifiers may contain the same `.` used as our flattened
    // hierarchy separator. Treat duplicate normalized paths as ambiguous
    // rather than assigning their primitives to whichever entry wins.
    let mut logical_by_name: HashMap<&str, Option<usize>> = HashMap::new();
    for (index, memory) in logical.iter().enumerate() {
        logical_by_name
            .entry(memory.name.as_str())
            .and_modify(|matched| *matched = None)
            .or_insert(Some(index));
    }
    let mut members = vec![Vec::new(); logical.len()];
    for node in &graph.nodes {
        if node.kind != NodeKind::Cell
            || node.blackbox
            || !node.cell_type.as_deref().is_some_and(is_memory_type)
        {
            continue;
        }
        let raw_name = clean_name(&node.raw_name);
        // An exact source-cell path names an explicitly instantiated primitive,
        // not an implementation fragment generated for the nearby RTL memory.
        if source_memory_cell_paths.contains(&raw_name) {
            continue;
        }
        let mut candidate = raw_name.as_str();
        let mut matched = None;
        let mut ambiguous = false;
        match logical_by_name.get(candidate).copied() {
            Some(Some(index)) => matched = Some(index),
            Some(None) => ambiguous = true,
            None => {}
        }
        // Yosys appends numeric implementation coordinates to the logical
        // memory path (`memory.0.0`). Only peel those generated suffixes: an
        // arbitrary hierarchy ancestor must never claim a primitive.
        while matched.is_none() && !ambiguous {
            let Some((prefix, suffix)) = candidate.rsplit_once('.') else {
                break;
            };
            if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
                break;
            }
            candidate = prefix;
            match logical_by_name.get(candidate).copied() {
                Some(Some(index)) => matched = Some(index),
                Some(None) => ambiguous = true,
                None => {}
            }
        }
        if matched.is_none() && !ambiguous {
            // Vivado commonly maps `foo` to `foo_reg...`. Candidates run
            // rightmost-first so a logical `foo_regbank` wins over the
            // shorter `foo`. The Vivado rules apply regardless of the
            // active tool, preserving the historic cross-dialect leniency.
            for base in NetlistDialect::Vivado.register_base_candidates(&raw_name) {
                match logical_by_name.get(base).copied() {
                    Some(Some(index)) => {
                        matched = Some(index);
                        break;
                    }
                    Some(None) => break,
                    None => {}
                }
            }
        }
        if let Some(index) = matched {
            members[index].push(node.id);
        }
    }

    // Generic gate mapping lowers a memory to auto-named DFFs. Endpoint
    // analysis recovers stable row aliases such as `memory[7]`; reconnect
    // those rows to their source logical array.
    for register in registers {
        let mut candidate = register.name.as_str();
        let mut matched = None;
        let mut ambiguous = false;
        match logical_by_name.get(candidate).copied() {
            Some(Some(index)) => matched = Some(index),
            Some(None) => ambiguous = true,
            None => {}
        }
        while matched.is_none() && !ambiguous {
            let parent = strip_bit_suffix(candidate);
            if parent == candidate {
                break;
            }
            candidate = parent;
            match logical_by_name.get(candidate).copied() {
                Some(Some(index)) => matched = Some(index),
                Some(None) => ambiguous = true,
                None => {}
            }
        }
        if let Some(index) = matched {
            members[index].extend(register.bits.iter().map(|bit| bit.node_id));
        }
    }

    logical
        .into_iter()
        .zip(members)
        .filter_map(|(memory, mut members)| {
            members.sort_unstable();
            members.dedup();
            (!members.is_empty()).then_some(MemoryArray {
                name: memory.name,
                width: memory.width,
                depth: memory.depth,
                members,
            })
        })
        .collect()
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

/// Group parallel lanes of addressable shift-register primitives even when
/// `proc` has already lowered their RTL array out of the provenance netlist.
/// These cells are stateful, so they are deliberately ineligible for ordinary
/// register and combinational grouping. A group is admitted only when bounded
/// refinement finds matching topology and at least one adjacent class has a
/// distinct one-to-one lane correspondence across every member.
fn seed_structural_memory_groups(
    partition: &mut GroupPartition,
    graph: &Graph,
    cells: &[NodeId],
    classes: &[u32],
    refined: &[bool],
    interner: &mut Interner,
) {
    if cells.len() < 2 {
        return;
    }
    let mut members_by_class: BTreeMap<u32, Vec<NodeId>> = BTreeMap::new();
    for &id in cells {
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
        if !storage_contracts_match(graph, interner, &members)
            || !bit_correspondence_holds(
                graph,
                &partition.group_of,
                classes,
                refined,
                interner,
                &members,
                true,
            )
        {
            continue;
        }
        let cell_type = graph.nodes[members[0] as usize]
            .cell_type
            .clone()
            .unwrap_or_default();
        let label = structural_memory_label(graph, &members, &cell_type);
        let group_id = partition.groups.len() as GroupId;
        for &member in &members {
            partition.group_of.insert(member, group_id);
        }
        partition.groups.push(Group {
            kind: GroupKind::Memory,
            members,
            label,
            cell_type,
        });
    }
}

fn is_scalar_address_port(port: &str) -> bool {
    ["A0", "A1", "A2", "A3", "A4"]
        .iter()
        .any(|address| port.eq_ignore_ascii_case(address))
}

fn is_addressable_memory_address_edge(graph: &Graph, edge_idx: usize) -> bool {
    let edge = &graph.edges[edge_idx];
    let target = &graph.nodes[edge.to as usize];
    if !target.seq {
        return false;
    }
    match target.cell_type.as_deref() {
        Some(cell_type) if cell_type.eq_ignore_ascii_case("SRL16E") => {
            is_scalar_address_port(&edge.to_port)
        }
        Some(cell_type) if cell_type.eq_ignore_ascii_case("SRLC32E") => {
            edge.to_port.eq_ignore_ascii_case("A") || is_scalar_address_port(&edge.to_port)
        }
        _ => false,
    }
}

fn starts_with_ignore_ascii_case(value: &str, prefix: &str) -> bool {
    value
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

fn ends_with_ignore_ascii_case(value: &str, suffix: &str) -> bool {
    value
        .len()
        .checked_sub(suffix.len())
        .and_then(|start| value.get(start..))
        .is_some_and(|tail| tail.eq_ignore_ascii_case(suffix))
}

fn is_storage_polarity_parameter(key: &str) -> bool {
    ends_with_ignore_ascii_case(key, "_POLARITY")
        || (starts_with_ignore_ascii_case(key, "IS_")
            && ends_with_ignore_ascii_case(key, "_INVERTED"))
}

/// A stacked memory vector has one shared storage contract. Exact source-node,
/// output-port, and net-bit identity keeps lanes with different clocks,
/// enables, or address buses separate. Retained clock/control polarity
/// parameters must also agree. Generic vector refinement deliberately ignores
/// these broadcast signals so it can focus on the one-to-one data lanes.
fn storage_contracts_match(graph: &Graph, interner: &mut Interner, members: &[NodeId]) -> bool {
    fn signature(
        graph: &Graph,
        interner: &mut Interner,
        member: NodeId,
    ) -> Vec<(u32, NodeId, u32, Option<u32>, u32)> {
        let mut controls = graph.incoming[member as usize]
            .iter()
            .filter_map(|&edge_idx| {
                let edge = &graph.edges[edge_idx];
                (edge.control || is_addressable_memory_address_edge(graph, edge_idx)).then(|| {
                    (
                        interner.id(&edge.to_port),
                        edge.from,
                        interner.id(&edge.from_port),
                        edge.bit,
                        edge.to_port_bit,
                    )
                })
            })
            .collect::<Vec<_>>();
        controls.sort_unstable();
        controls
    }

    fn polarity_parameters_match(graph: &Graph, left: NodeId, right: NodeId) -> bool {
        let parameters = |member: NodeId| {
            graph.nodes[member as usize]
                .params
                .iter()
                .filter(|(key, _)| is_storage_polarity_parameter(key))
        };
        parameters(left).eq(parameters(right))
    }

    let Some((&first, rest)) = members.split_first() else {
        return false;
    };
    let expected = signature(graph, interner, first);
    rest.iter().all(|&member| {
        signature(graph, interner, member) == expected
            && polarity_parameters_match(graph, first, member)
    })
}

fn seed_memory_groups(partition: &mut GroupPartition, graph: &Graph, memories: Vec<MemoryArray>) {
    for mut memory in memories {
        memory
            .members
            .retain(|id| !partition.group_of.contains_key(id));
        let members = memory.members;
        if members.is_empty() {
            continue;
        }
        let cell_types: BTreeSet<&str> = members
            .iter()
            .filter_map(|id| graph.nodes[*id as usize].cell_type.as_deref())
            .collect();
        let cell_type =
            if cell_types.len() == 1 && cell_types.first().copied().is_some_and(is_memory_type) {
                cell_types.first().copied().unwrap_or("$mem").to_owned()
            } else {
                "$mem".to_owned()
            };
        let group_id = partition.groups.len() as GroupId;
        for &member in &members {
            partition.group_of.insert(member, group_id);
        }
        partition.groups.push(Group {
            kind: GroupKind::Memory,
            members,
            label: format!("{} [{}×{}]", memory.name, memory.depth, memory.width),
            cell_type,
        });
    }
}

/// iCE40 RAM mapping inserts one `SB_DFF` per write-data bit, but generated Q
/// aliases describe them as internal RDATA signals and split the bank during
/// endpoint-name grouping. The shared data nets are authoritative: DFF D pins
/// that mirror every bit of one `SB_RAM*` WDATA input form one structural
/// register vector. The wrapper's auxiliary DFF uses another net and remains
/// separate.
fn seed_memory_input_mirror_register_groups(
    partition: &mut GroupPartition,
    graph: &Graph,
) -> usize {
    fn starts_with_ignore_ascii_case(value: &str, prefix: &[u8]) -> bool {
        value
            .as_bytes()
            .get(..prefix.len())
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(prefix))
    }

    let mut memory_bits: BTreeMap<NodeId, BTreeMap<u32, u32>> = BTreeMap::new();
    let mut examined_edges = 0;
    for edge in &graph.edges {
        examined_edges += 1;
        if edge.control || !edge.to_port.eq_ignore_ascii_case("WDATA") {
            continue;
        }
        let Some(net) = edge.bit else {
            continue;
        };
        let Some(target_type) = graph.nodes[edge.to as usize].cell_type.as_deref() else {
            continue;
        };
        if is_memory_type(target_type) && starts_with_ignore_ascii_case(target_type, b"SB_RAM") {
            memory_bits
                .entry(edge.to)
                .or_default()
                .insert(net, edge.to_port_bit);
        }
    }
    if memory_bits.is_empty() {
        return examined_edges;
    }

    let memory_by_raw_name: HashMap<&str, NodeId> = memory_bits
        .keys()
        .map(|&id| (graph.nodes[id as usize].raw_name.as_str(), id))
        .collect();
    let mut sinks_by_memory: BTreeMap<NodeId, BTreeMap<u32, Option<NodeId>>> = BTreeMap::new();
    for edge in &graph.edges {
        examined_edges += 1;
        if edge.control || !edge.to_port.eq_ignore_ascii_case("D") {
            continue;
        }
        let Some(net) = edge.bit else {
            continue;
        };
        let target = &graph.nodes[edge.to as usize];
        let Some(target_type) = target.cell_type.as_deref() else {
            continue;
        };
        if !starts_with_ignore_ascii_case(target_type, b"SB_DFF") {
            continue;
        }
        let Some((memory_raw_name, _)) = target.raw_name.rsplit_once("_RDATA") else {
            continue;
        };
        let Some(&memory) = memory_by_raw_name.get(memory_raw_name) else {
            continue;
        };
        let Some(&bit) = memory_bits
            .get(&memory)
            .and_then(|bit_by_net| bit_by_net.get(&net))
        else {
            continue;
        };
        sinks_by_memory
            .entry(memory)
            .or_default()
            .entry(bit)
            .and_modify(|sink| {
                if *sink != Some(edge.to) {
                    *sink = None;
                }
            })
            .or_insert(Some(edge.to));
    }

    for (memory, bit_by_net) in memory_bits {
        let sinks_by_bit = sinks_by_memory.remove(&memory).unwrap_or_default();
        let physical_bits: BTreeSet<u32> = bit_by_net.values().copied().collect();
        if sinks_by_bit.len() < 2
            || sinks_by_bit.len() != physical_bits.len()
            || sinks_by_bit.values().any(Option::is_none)
        {
            continue;
        }
        let members: BTreeSet<NodeId> = sinks_by_bit.values().flatten().copied().collect();
        if members.len() != sinks_by_bit.len()
            || members.iter().any(|id| partition.group_of.contains_key(id))
        {
            continue;
        }
        let cell_types: BTreeSet<&str> = members
            .iter()
            .filter_map(|id| graph.nodes[*id as usize].cell_type.as_deref())
            .collect();
        if cell_types.len() != 1 {
            continue;
        }
        let group_id = partition.groups.len() as GroupId;
        for &member in &members {
            partition.group_of.insert(member, group_id);
        }
        let bits: Vec<u32> = sinks_by_bit.keys().copied().collect();
        let contiguous = bits
            .first()
            .copied()
            .is_some_and(|low| bits.iter().copied().eq(low..low + bits.len() as u32));
        let suffix = if contiguous {
            format!("[{}:{}]", bits.last().copied().unwrap_or(0), bits[0])
        } else {
            format!(" ×{}", bits.len())
        };
        partition.groups.push(Group {
            kind: GroupKind::Register,
            members: members.into_iter().collect(),
            label: format!("{}.WDATA{suffix}", graph.nodes[memory as usize].name),
            cell_type: cell_types.first().copied().unwrap_or("SB_DFF").to_owned(),
        });
    }
    examined_edges
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
    Group(GroupId),
    Refined(u32),
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
    group_of: &HashMap<NodeId, GroupId>,
    classes: &[u32],
    refined: &[bool],
    interner: &mut Interner,
    id: NodeId,
) -> NeighborClass {
    let node = &graph.nodes[id as usize];
    match node.kind {
        NodeKind::Cell if refined[id as usize] => NeighborClass::Refined(classes[id as usize]),
        NodeKind::Cell => group_of
            .get(&id)
            .map_or(NeighborClass::Anchor(id), |&group| {
                NeighborClass::Group(group)
            }),
        NodeKind::PortBit => {
            NeighborClass::Port(interner.id(node.port.as_deref().unwrap_or(&node.name)))
        }
        NodeKind::Const => NeighborClass::Const(interner.id(&node.name)),
    }
}

fn signature(
    graph: &Graph,
    group_of: &HashMap<NodeId, GroupId>,
    classes: &[u32],
    refined: &[bool],
    interner: &mut Interner,
    id: NodeId,
) -> Signature {
    let mut incoming = Vec::with_capacity(graph.incoming[id as usize].len());
    for &edge_idx in &graph.incoming[id as usize] {
        let edge = &graph.edges[edge_idx];
        if edge.control || is_addressable_memory_address_edge(graph, edge_idx) {
            continue;
        }
        incoming.push((
            neighbor_class(graph, group_of, classes, refined, interner, edge.from),
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
            neighbor_class(graph, group_of, classes, refined, interner, edge.to),
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
fn candidate_mask(graph: &Graph, cells: &[NodeId]) -> Vec<bool> {
    let mut mask = vec![false; graph.nodes.len()];
    for &id in cells {
        mask[id as usize] = true;
    }
    mask
}

fn refine_cell_classes(
    graph: &Graph,
    group_of: &HashMap<NodeId, GroupId>,
    cells: &[NodeId],
    refined: &[bool],
    interner: &mut Interner,
) -> Vec<u32> {
    let mut classes = vec![0u32; graph.nodes.len()];
    let mut count;
    {
        let mut type_ids: HashMap<&str, u32> = HashMap::new();
        for &id in cells {
            let cell_type = graph.nodes[id as usize].cell_type.as_deref().unwrap_or("");
            let next = type_ids.len() as u32;
            classes[id as usize] = *type_ids.entry(cell_type).or_insert(next);
        }
        count = type_ids.len();
    }
    for _ in 0..MAX_REFINEMENT_ROUNDS {
        let mut signature_ids: HashMap<Signature, u32> = HashMap::new();
        let mut next = vec![0u32; graph.nodes.len()];
        for &id in cells {
            let signature = signature(graph, group_of, &classes, refined, interner, id);
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
    group_of: &HashMap<NodeId, GroupId>,
    classes: &[u32],
    refined: &[bool],
    interner: &mut Interner,
    members: &[NodeId],
    require_distinct_lane: bool,
) -> bool {
    let own = NeighborClass::Refined(classes[members[0] as usize]);
    let mut picks: BTreeMap<(bool, NeighborClass), Vec<NodeId>> = BTreeMap::new();
    for &member in members {
        let mut local: BTreeMap<(bool, NeighborClass), BTreeSet<NodeId>> = BTreeMap::new();
        for (is_incoming, edge_indices) in [
            (true, &graph.incoming[member as usize]),
            (false, &graph.outgoing[member as usize]),
        ] {
            for &edge_idx in edge_indices {
                let edge = &graph.edges[edge_idx];
                if edge.control || is_addressable_memory_address_edge(graph, edge_idx) {
                    continue;
                }
                let neighbor = if is_incoming { edge.from } else { edge.to };
                let class = neighbor_class(graph, group_of, classes, refined, interner, neighbor);
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
    let mut has_distinct_lane = false;
    let valid = picks.values().all(|chosen| {
        if chosen.len() != members.len() {
            return false;
        }
        let distinct: BTreeSet<NodeId> = chosen.iter().copied().collect();
        if distinct.len() == chosen.len() {
            has_distinct_lane = true;
            true
        } else {
            distinct.len() == 1
        }
    });
    valid && (!require_distinct_lane || has_distinct_lane)
}

fn structural_memory_label(graph: &Graph, members: &[NodeId], cell_type: &str) -> String {
    let vector_label = comb_label(graph, members, cell_type);
    let vector_stem = vector_label
        .rsplit_once('[')
        .filter(|(_, suffix)| suffix.ends_with(']') && suffix.contains(':'))
        .map(|(stem, _)| stem)
        .unwrap_or(cell_type);
    let depth = match cell_type.to_ascii_uppercase().as_str() {
        "SRL16E" => 16,
        "SRLC32E" => 32,
        _ => return vector_label,
    };
    format!("{vector_stem} [{depth}×{}]", members.len())
}

/// `"name[hi:lo]"` when the group's bit indices are one contiguous run with
/// no duplicates, otherwise `"name ×N"`.
fn register_label(register: &RegisterGroup) -> String {
    let name = if register.name.starts_with('$') {
        register.name.trim_start_matches('$').replace('$', ".")
    } else {
        register.name.clone()
    };
    let bits: BTreeSet<usize> = register.bits.iter().map(|bit| bit.bit).collect();
    if bits.len() == register.bits.len()
        && let (Some(&lo), Some(&hi)) = (bits.first(), bits.last())
        && hi - lo + 1 == bits.len()
    {
        return format!("{name}[{hi}:{lo}]");
    }
    format!("{name} ×{}", register.bits.len())
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
    use crate::netlist::{PortDirection, YosysBit, parse_value};
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
            clock_network: Vec::new(),
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
            to_port_bit: 0,
            bit: Some(from),
            net_name: net.to_owned(),
            control: false,
        });
        graph.outgoing[from as usize].push(idx);
        graph.incoming[to as usize].push(idx);
    }

    fn control_link(
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
            to_port_bit: 0,
            bit: Some(from),
            net_name: net.to_owned(),
            control: true,
        });
        graph.outgoing[from as usize].push(idx);
        graph.incoming[to as usize].push(idx);
    }

    fn append_input(graph: &mut Graph, name: &str) -> NodeId {
        let id = graph.nodes.len() as NodeId;
        graph
            .nodes
            .push(port_bit(id, name, 0, 1, PortDirection::Input));
        graph.outgoing.push(Vec::new());
        graph.incoming.push(Vec::new());
        id
    }

    fn has_memory_group(graph: &Graph) -> bool {
        GroupPartition::build(graph, &[], Vec::new())
            .groups
            .iter()
            .any(|group| group.kind == GroupKind::Memory)
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

    /// One addressable shift-register primitive per data-bus lane. Clock,
    /// enable, and address controls are intentionally omitted: grouping must
    /// be proven by the distinct D/Q lane correspondence, not shared controls.
    fn srl_vector_graph(cell_type: &str, width: usize) -> Graph {
        let mut nodes = Vec::new();
        for bit in 0..width {
            nodes.push(port_bit(
                bit as NodeId,
                "data_in",
                bit,
                width,
                PortDirection::Input,
            ));
        }
        for bit in 0..width {
            let id = (width + bit) as NodeId;
            let mut srl = comb_cell(id, cell_type);
            srl.seq = true;
            srl.name = format!("$auto$srl${bit}");
            srl.raw_name = srl.name.clone();
            nodes.push(srl);
        }
        for bit in 0..width {
            nodes.push(port_bit(
                (2 * width + bit) as NodeId,
                "data_out",
                bit,
                width,
                PortDirection::Output,
            ));
        }
        let mut graph = graph_from_nodes("srl_vector", nodes);
        for bit in 0..width as NodeId {
            link(
                &mut graph,
                bit,
                width as NodeId + bit,
                "data_in",
                "D",
                &format!("data_in[{bit}]"),
            );
            link(
                &mut graph,
                width as NodeId + bit,
                2 * width as NodeId + bit,
                "Q",
                "data_out",
                &format!("data_out[{bit}]"),
            );
        }
        graph
    }

    fn wrapped_srl_vector_graph(width: usize) -> Graph {
        let mut nodes = Vec::new();
        for bit in 0..width {
            nodes.push(port_bit(
                bit as NodeId,
                "data_in",
                bit,
                width,
                PortDirection::Input,
            ));
        }
        for bit in 0..width {
            nodes.push(comb_cell((width + bit) as NodeId, "LUT1"));
        }
        for bit in 0..width {
            let mut srl = comb_cell((2 * width + bit) as NodeId, "SRL16E");
            srl.seq = true;
            nodes.push(srl);
        }
        for bit in 0..width {
            nodes.push(port_bit(
                (3 * width + bit) as NodeId,
                "data_out",
                bit,
                width,
                PortDirection::Output,
            ));
        }
        let mut graph = graph_from_nodes("wrapped_srl_vector", nodes);
        for bit in 0..width as NodeId {
            link(
                &mut graph,
                bit,
                width as NodeId + bit,
                "data_in",
                "I0",
                &format!("data_in[{bit}]"),
            );
            link(
                &mut graph,
                width as NodeId + bit,
                2 * width as NodeId + bit,
                "O",
                "D",
                &format!("wrapped_data[{bit}]"),
            );
            link(
                &mut graph,
                2 * width as NodeId + bit,
                3 * width as NodeId + bit,
                "Q",
                "data_out",
                &format!("data_out[{bit}]"),
            );
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
        let registers = &analysis.endpoints().registers;
        assert_eq!(registers.len(), 2);

        let partition = GroupPartition::build(&graph, registers, Vec::new());

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
    fn parallel_srl_lanes_form_one_memory_vector_without_source_memory() {
        for (cell_type, depth) in [("SRL16E", 16), ("SRLC32E", 32)] {
            let graph = srl_vector_graph(cell_type, 8);

            let partition = GroupPartition::build(&graph, &[], Vec::new());
            let memories: Vec<&Group> = partition
                .groups
                .iter()
                .filter(|group| group.kind == GroupKind::Memory)
                .collect();

            assert_eq!(memories.len(), 1, "{cell_type}");
            assert_eq!(memories[0].members, (8..16).collect::<Vec<_>>());
            assert_eq!(memories[0].label, format!("data_out [{depth}×8]"));
            assert_eq!(memories[0].cell_type, cell_type);
        }
    }

    #[test]
    fn unconnected_srl_primitives_do_not_form_a_memory_vector() {
        let mut first = comb_cell(0, "SRL16E");
        first.seq = true;
        let mut second = comb_cell(1, "SRL16E");
        second.seq = true;
        let graph = graph_from_nodes("standalone_srls", vec![first, second]);

        let partition = GroupPartition::build(&graph, &[], Vec::new());

        assert!(
            partition
                .groups
                .iter()
                .all(|group| group.kind != GroupKind::Memory)
        );
    }

    #[test]
    fn srl_lanes_with_different_clocks_do_not_form_a_memory_vector() {
        let mut graph = srl_vector_graph("SRL16E", 2);
        let clk0 = append_input(&mut graph, "clk0");
        let clk1 = append_input(&mut graph, "clk1");
        let en = append_input(&mut graph, "en");
        control_link(&mut graph, clk0, 2, "clk0", "CLK", "clk0");
        control_link(&mut graph, clk1, 3, "clk1", "CLK", "clk1");
        control_link(&mut graph, en, 2, "en", "CE", "en");
        control_link(&mut graph, en, 3, "en", "CE", "en");

        assert!(!has_memory_group(&graph));
    }

    #[test]
    fn srl_lanes_with_different_enables_do_not_form_a_memory_vector() {
        let mut graph = srl_vector_graph("SRL16E", 2);
        let clk = append_input(&mut graph, "clk");
        let en0 = append_input(&mut graph, "en0");
        let en1 = append_input(&mut graph, "en1");
        control_link(&mut graph, clk, 2, "clk", "CLK", "clk");
        control_link(&mut graph, clk, 3, "clk", "CLK", "clk");
        control_link(&mut graph, en0, 2, "en0", "CE", "en0");
        control_link(&mut graph, en1, 3, "en1", "CE", "en1");

        assert!(!has_memory_group(&graph));
    }

    #[test]
    fn srl_lanes_with_different_clock_polarities_do_not_form_a_memory_vector() {
        let mut graph = srl_vector_graph("SRL16E", 2);
        let clk = append_input(&mut graph, "clk");
        let en = append_input(&mut graph, "en");
        for member in [2, 3] {
            control_link(&mut graph, clk, member, "clk", "CLK", "clk");
            control_link(&mut graph, en, member, "en", "CE", "en");
        }
        graph.nodes[2]
            .params
            .insert("IS_CLK_INVERTED".to_owned(), "0".to_owned());
        graph.nodes[3]
            .params
            .insert("IS_CLK_INVERTED".to_owned(), "1".to_owned());

        assert!(!has_memory_group(&graph));
    }

    #[test]
    fn srl_lanes_with_independent_addresses_do_not_form_a_memory_vector() {
        for (cell_type, address_width, vector_port) in [("SRL16E", 4, false), ("SRLC32E", 5, true)]
        {
            let mut graph = srl_vector_graph(cell_type, 2);
            let clk = append_input(&mut graph, "clk");
            let en = append_input(&mut graph, "en");
            for member in [2, 3] {
                control_link(&mut graph, clk, member, "clk", "CLK", "clk");
                control_link(&mut graph, en, member, "en", "CE", "en");
            }
            for address_bit in 0..address_width {
                for lane in 0..2 {
                    let name = format!("a{address_bit}_{lane}");
                    let address = append_input(&mut graph, "address");
                    let to_port = if vector_port {
                        "A".to_owned()
                    } else {
                        format!("A{address_bit}")
                    };
                    link(&mut graph, address, 2 + lane, &name, &to_port, &name);
                    graph.edges.last_mut().unwrap().to_port_bit = address_bit;
                }
            }

            assert!(!has_memory_group(&graph), "{cell_type}");
        }
    }

    #[test]
    fn srl_lanes_with_shared_address_bus_form_a_memory_vector() {
        for (cell_type, address_width, vector_port) in [("SRL16E", 4, false), ("SRLC32E", 5, true)]
        {
            let mut graph = srl_vector_graph(cell_type, 2);
            let clk = append_input(&mut graph, "clk");
            let en = append_input(&mut graph, "en");
            for member in [2, 3] {
                control_link(&mut graph, clk, member, "clk", "CLK", "clk");
                control_link(&mut graph, en, member, "en", "CE", "en");
            }
            for address_bit in 0..address_width {
                let name = format!("address[{address_bit}]");
                let address = append_input(&mut graph, "address");
                for member in [2, 3] {
                    let to_port = if vector_port {
                        "A".to_owned()
                    } else {
                        format!("A{address_bit}")
                    };
                    link(&mut graph, address, member, "address", &to_port, &name);
                    graph.edges.last_mut().unwrap().to_port_bit = address_bit;
                }
            }

            assert!(has_memory_group(&graph), "{cell_type}");
        }
    }

    #[test]
    fn parallel_srl_lanes_group_through_equivalent_comb_wrappers() {
        let graph = wrapped_srl_vector_graph(8);

        let partition = GroupPartition::build(&graph, &[], Vec::new());
        let memories: Vec<_> = partition
            .groups
            .iter()
            .filter(|group| group.kind == GroupKind::Memory)
            .collect();

        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].members, (16..24).collect::<Vec<_>>());
        assert_eq!(memories[0].label, "data_out [16×8]");
    }

    #[test]
    fn generated_memory_read_register_bits_form_distinct_vectors() {
        let width = 8;
        let mut graph = register_bank_graph(2, width);
        for group in 0..2 {
            for bit in 0..width {
                let id = (1 + group * width + bit) as NodeId;
                let name = format!("$memory$rdreg[{group}]$q[{bit}]");
                graph.nodes[id as usize].name = name.clone();
                graph.nodes[id as usize].raw_name = name.clone();
                let q_net = (1_000_000 + group * width + bit) as u32;
                graph
                    .net_aliases
                    .insert(q_net, vec![format!("$abc$net_{q_net}")]);
            }
        }

        let analysis = Analysis::new(&graph, vec!["bank.sv".to_owned()]);
        let registers = &analysis.endpoints().registers;
        assert_eq!(registers.len(), 2);
        assert_eq!(registers[0].name, "$memory$rdreg[0]$q");
        assert_eq!(registers[1].name, "$memory$rdreg[1]$q");

        let partition = GroupPartition::build(&graph, registers, Vec::new());
        assert_eq!(partition.groups.len(), 2);
        assert_eq!(partition.groups[0].label, "memory.rdreg[0].q[7:0]");
        assert_eq!(partition.groups[1].label, "memory.rdreg[1].q[7:0]");
        assert!(
            partition
                .groups
                .iter()
                .all(|group| group.members.len() == width)
        );
    }

    #[test]
    fn visible_register_alias_wins_over_deeper_generated_alias() {
        let width = 8;
        let mut graph = register_bank_graph(1, width);
        for bit in 0..width {
            let id = (1 + bit) as NodeId;
            let hidden = format!("$memory$rdreg[0]$q[{bit}]");
            graph.nodes[id as usize].name = hidden.clone();
            graph.nodes[id as usize].raw_name = hidden.clone();
            let q_net = (1_000_000 + bit) as u32;
            graph
                .net_aliases
                .insert(q_net, vec![hidden, format!("status_q[{bit}]")]);
        }

        let analysis = Analysis::new(&graph, vec!["bank.sv".to_owned()]);
        let registers = &analysis.endpoints().registers;
        assert_eq!(registers.len(), 1);
        assert_eq!(registers[0].name, "status_q");

        let partition = GroupPartition::build(&graph, registers, Vec::new());
        assert_eq!(partition.groups.len(), 1);
        assert_eq!(partition.groups[0].label, "status_q[7:0]");
    }

    #[test]
    fn logical_memory_claims_dff_mapped_rows_before_register_grouping() {
        let graph = graph_from_nodes(
            "top",
            (0..4)
                .map(|id| dff_cell(id, &format!("$auto$ff${id}")))
                .collect(),
        );
        let registers = vec![
            register_group("memory[0]", &[(0, 0), (1, 1)]),
            register_group("memory[1]", &[(0, 2), (1, 3)]),
        ];
        let source_netlist = parse_value(serde_json::json!({
            "modules": { "top": {
                "attributes": { "top": "1" },
                "memories": {
                    "memory": { "width": 2, "start_offset": 0, "size": 2 }
                }
            } }
        }))
        .unwrap();

        let memories = memory_arrays_from_source(&graph, &source_netlist, "top", &registers);
        let partition = GroupPartition::build(&graph, &registers, memories);

        assert_eq!(partition.groups.len(), 1);
        assert_eq!(partition.groups[0].kind, GroupKind::Memory);
        assert_eq!(partition.groups[0].members, vec![0, 1, 2, 3]);
        assert_eq!(partition.groups[0].label, "memory [2×2]");
        assert_eq!(partition.groups[0].cell_type, "$mem");
    }

    #[test]
    fn scalar_width_memory_matches_an_exact_register_alias() {
        let graph = graph_from_nodes(
            "top",
            (0..2)
                .map(|id| dff_cell(id, &format!("$auto$ff${id}")))
                .collect(),
        );
        let registers = vec![register_group("memory", &[(0, 0), (1, 1)])];
        let source_netlist = parse_value(serde_json::json!({
            "modules": { "top": {
                "attributes": { "top": "1" },
                "memories": {
                    "memory": { "width": 1, "start_offset": 0, "size": 2 }
                }
            } }
        }))
        .unwrap();

        let memories = memory_arrays_from_source(&graph, &source_netlist, "top", &registers);
        let partition = GroupPartition::build(&graph, &registers, memories);

        assert_eq!(partition.groups.len(), 1);
        assert_eq!(partition.groups[0].kind, GroupKind::Memory);
        assert_eq!(partition.groups[0].label, "memory [2×1]");
        assert_eq!(partition.groups[0].members, vec![0, 1]);
    }

    #[test]
    fn singleton_physical_memory_keeps_its_logical_shape() {
        let mut memory = comb_cell(0, "SB_RAM40_4K");
        memory.seq = true;
        memory.name = "memory.0.0".to_owned();
        memory.raw_name = "memory.0.0".to_owned();
        let graph = graph_from_nodes("top", vec![memory]);
        let source_netlist = parse_value(serde_json::json!({
            "modules": { "top": {
                "attributes": { "top": "1" },
                "memories": {
                    "memory": { "width": 16, "start_offset": 0, "size": 64 }
                }
            } }
        }))
        .unwrap();

        let memories = memory_arrays_from_source(&graph, &source_netlist, "top", &[]);
        let partition = GroupPartition::build(&graph, &[], memories);

        assert_eq!(partition.groups.len(), 1);
        assert_eq!(partition.groups[0].kind, GroupKind::Memory);
        assert_eq!(partition.groups[0].members, vec![0]);
        assert_eq!(partition.groups[0].label, "memory [64×16]");
        assert_eq!(partition.groups[0].cell_type, "SB_RAM40_4K");
    }

    #[test]
    fn ecp5_lutram_slices_stack_at_shallow_fifo_regression_depths() {
        for (depth, primitive_count) in [(16, 4), (64, 16)] {
            let nodes = (0..primitive_count)
                .map(|id| {
                    let mut node = comb_cell(id, "TRELLIS_DPR16X4");
                    node.seq = true;
                    node.name = format!("memory.0.{id}");
                    node.raw_name = node.name.clone();
                    node
                })
                .collect();
            let graph = graph_from_nodes("top", nodes);
            let source_netlist = parse_value(serde_json::json!({
                "modules": { "top": {
                    "attributes": { "top": "1" },
                    "memories": {
                        "memory": { "width": 16, "start_offset": 0, "size": depth }
                    }
                } }
            }))
            .unwrap();

            let memories = memory_arrays_from_source(&graph, &source_netlist, "top", &[]);
            let partition = GroupPartition::build(&graph, &[], memories);

            assert_eq!(partition.groups.len(), 1, "depth {depth}");
            assert_eq!(partition.groups[0].kind, GroupKind::Memory, "depth {depth}");
            assert_eq!(
                partition.groups[0].members.len(),
                primitive_count as usize,
                "depth {depth}",
            );
            assert_eq!(partition.groups[0].label, format!("memory [{depth}×16]"),);
            assert_eq!(partition.groups[0].cell_type, "TRELLIS_DPR16X4");
        }
    }

    #[test]
    fn ice40_ram_data_mirror_dffs_form_one_vector_without_the_auxiliary_dff() {
        let mut memory = comb_cell(0, "SB_RAM40_4K");
        memory.seq = true;
        memory.name = "memory.0.0".to_owned();
        memory.raw_name = "memory.0.0".to_owned();
        let mut nodes = vec![memory];
        for bit in 0..16 {
            let mut dff = dff_cell(1 + bit, &format!("memory.0.0_RDATA_{bit}"));
            dff.cell_type = Some("SB_DFF".to_owned());
            nodes.push(dff);
        }
        let mut auxiliary = dff_cell(17, "memory.0.0_RDATA_aux");
        auxiliary.cell_type = Some("SB_DFF".to_owned());
        nodes.push(auxiliary);
        for bit in 0..16 {
            nodes.push(port_bit(
                18 + bit,
                "push_data",
                bit as usize,
                16,
                PortDirection::Input,
            ));
        }
        let mut graph = graph_from_nodes("top", nodes);
        for bit in 0..16 {
            for (to, to_port, to_port_bit) in [(0, "WDATA", bit), (1 + bit, "D", 0)] {
                let edge_index = graph.edges.len();
                graph.edges.push(Edge {
                    from: 18 + bit,
                    to,
                    from_port: "push_data".to_owned(),
                    to_port: to_port.to_owned(),
                    to_port_bit,
                    bit: Some(100 + bit),
                    net_name: format!("push_data[{bit}]"),
                    control: false,
                });
                graph.outgoing[(18 + bit) as usize].push(edge_index);
                graph.incoming[to as usize].push(edge_index);
            }
        }

        let partition = GroupPartition::build(&graph, &[], Vec::new());

        let register = partition
            .groups
            .iter()
            .find(|group| group.kind == GroupKind::Register)
            .unwrap();
        assert_eq!(register.members, (1..=16).collect::<Vec<_>>());
        assert_eq!(register.label, "memory.0.0.WDATA[15:0]");
        assert_eq!(register.cell_type, "SB_DFF");
        assert!(!partition.group_of.contains_key(&17));
    }

    #[test]
    fn ice40_shared_write_bus_forms_one_mirror_vector_per_ram() {
        const MEMORIES: u32 = 64;
        const WIDTH: u32 = 16;
        let dff_base = MEMORIES;
        let port_base = dff_base + MEMORIES * WIDTH;
        let mut nodes = Vec::new();
        for memory_index in 0..MEMORIES {
            let mut memory = comb_cell(memory_index, "SB_RAM40_4K");
            memory.seq = true;
            memory.name = format!("memory.0.{memory_index}");
            memory.raw_name = memory.name.clone();
            nodes.push(memory);
        }
        for memory_index in 0..MEMORIES {
            for bit in 0..WIDTH {
                let id = dff_base + memory_index * WIDTH + bit;
                let mut dff =
                    dff_cell(id, &format!("memory.0.{memory_index}_RDATA_{bit}_SB_DFF_Q"));
                dff.cell_type = Some("SB_DFF".to_owned());
                nodes.push(dff);
            }
        }
        for bit in 0..WIDTH {
            nodes.push(port_bit(
                port_base + bit,
                "push_data",
                bit as usize,
                WIDTH as usize,
                PortDirection::Input,
            ));
        }
        let mut graph = graph_from_nodes("top", nodes);
        for memory_index in 0..MEMORIES {
            for bit in 0..WIDTH {
                let dff = dff_base + memory_index * WIDTH + bit;
                for (to, to_port, to_port_bit) in [(memory_index, "WDATA", bit), (dff, "D", 0)] {
                    let edge_index = graph.edges.len();
                    graph.edges.push(Edge {
                        from: port_base + bit,
                        to,
                        from_port: "push_data".to_owned(),
                        to_port: to_port.to_owned(),
                        to_port_bit,
                        bit: Some(10_000 + bit),
                        net_name: format!("push_data[{bit}]"),
                        control: false,
                    });
                    graph.outgoing[(port_base + bit) as usize].push(edge_index);
                    graph.incoming[to as usize].push(edge_index);
                }
            }
        }

        let mut partition = GroupPartition::default();
        let examined_edges = seed_memory_input_mirror_register_groups(&mut partition, &graph);
        let register_groups: Vec<&Group> = partition
            .groups
            .iter()
            .filter(|group| group.kind == GroupKind::Register)
            .collect();

        assert_eq!(register_groups.len(), MEMORIES as usize);
        assert!(
            register_groups
                .iter()
                .all(|group| group.members.len() == WIDTH as usize)
        );
        assert_eq!(register_groups[0].label, "memory.0.0.WDATA[15:0]");
        assert_eq!(
            register_groups.last().unwrap().label,
            "memory.0.63.WDATA[15:0]",
        );
        assert_eq!(examined_edges, graph.edges.len() * 2);
    }

    #[test]
    fn ambiguous_escaped_and_hierarchical_memory_paths_do_not_merge() {
        let graph = graph_from_nodes(
            "top",
            (0..4)
                .map(|id| dff_cell(id, &format!("$auto$ff${id}")))
                .collect(),
        );
        let registers = vec![register_group(
            "u.memory[0]",
            &[(0, 0), (1, 1), (2, 2), (3, 3)],
        )];
        let source_netlist = parse_value(serde_json::json!({
            "modules": {
                "top": {
                    "attributes": { "top": "1" },
                    "memories": {
                        "\\u.memory": { "width": 2, "start_offset": 0, "size": 2 }
                    },
                    "cells": { "u": { "type": "child" } }
                },
                "child": {
                    "memories": {
                        "memory": { "width": 2, "start_offset": 0, "size": 2 }
                    }
                }
            }
        }))
        .unwrap();

        let memories = memory_arrays_from_source(&graph, &source_netlist, "top", &registers);

        assert!(memories.is_empty());
    }

    #[test]
    fn ambiguous_physical_reg_prefix_does_not_fall_back_to_shorter_memory() {
        let graph = graph_from_nodes(
            "top",
            (0..2)
                .map(|id| {
                    let mut node = comb_cell(id, "$mem_v2");
                    node.name = format!("u.foo_reg_reg_{id}");
                    node.raw_name = node.name.clone();
                    node
                })
                .collect(),
        );
        let source_netlist = parse_value(serde_json::json!({
            "modules": {
                "top": {
                    "attributes": { "top": "1" },
                    "memories": {
                        "\\u.foo": { "width": 1, "start_offset": 0, "size": 2 },
                        "\\u.foo_reg": { "width": 1, "start_offset": 0, "size": 2 }
                    },
                    "cells": { "u": { "type": "child" } }
                },
                "child": {
                    "memories": {
                        "foo_reg": { "width": 1, "start_offset": 0, "size": 2 }
                    }
                }
            }
        }))
        .unwrap();

        let memories = memory_arrays_from_source(&graph, &source_netlist, "top", &[]);

        assert!(memories.is_empty());
    }

    #[test]
    fn named_regulator_primitive_does_not_match_a_shorter_memory() {
        let graph = graph_from_nodes(
            "top",
            (0..2)
                .map(|id| {
                    let mut node = comb_cell(id, "$mem_v2");
                    node.name = format!("foo_regulator_reg_{id}");
                    node.raw_name = node.name.clone();
                    node
                })
                .collect(),
        );
        let source_netlist = parse_value(serde_json::json!({
            "modules": { "top": {
                "attributes": { "top": "1" },
                "memories": {
                    "foo": { "width": 1, "start_offset": 0, "size": 2 }
                }
            } }
        }))
        .unwrap();

        let memories = memory_arrays_from_source(&graph, &source_netlist, "top", &[]);

        assert!(memories.is_empty());
    }

    #[test]
    fn explicit_source_ram_cell_is_not_claimed_by_an_inferred_memory() {
        for cell_name in ["foo_reg_0", "\\foo.0"] {
            let mut physical = comb_cell(0, "RAM64M");
            physical.seq = true;
            physical.name = cell_name.trim_start_matches('\\').to_owned();
            physical.raw_name = cell_name.to_owned();
            let graph = graph_from_nodes("top", vec![physical]);
            let source_netlist = parse_value(serde_json::json!({
                "modules": { "top": {
                    "attributes": { "top": "1" },
                    "memories": {
                        "foo": { "width": 1, "start_offset": 0, "size": 64 }
                    },
                    "cells": {
                        cell_name: { "type": "RAM64M" }
                    }
                } }
            }))
            .unwrap();

            let memories = memory_arrays_from_source(&graph, &source_netlist, "top", &[]);

            assert!(memories.is_empty(), "{cell_name}");
        }
    }

    #[test]
    fn multibit_ports_group_into_one_bus_node_while_scalars_stay() {
        // Two 4-bit input buses, one scalar input, and a 4-bit output bus.
        let mut nodes = Vec::new();
        for bit in 0..4 {
            nodes.push(port_bit(bit as NodeId, "a", bit, 4, PortDirection::Input));
        }
        for bit in 0..4 {
            nodes.push(port_bit(
                4 + bit as NodeId,
                "b",
                bit,
                4,
                PortDirection::Input,
            ));
        }
        nodes.push(port_bit(8, "sel", 0, 1, PortDirection::Input));
        for bit in 0..4 {
            nodes.push(port_bit(
                9 + bit as NodeId,
                "y",
                bit,
                4,
                PortDirection::Output,
            ));
        }
        let graph = graph_from_nodes("top", nodes);

        let partition = GroupPartition::build(&graph, &[], Vec::new());

        // a, b, y each collapse; the scalar `sel` does not.
        assert_eq!(partition.groups.len(), 3);
        for group in &partition.groups {
            assert_eq!(group.kind, GroupKind::Port);
            assert_eq!(group.members.len(), 4);
            assert!(group.cell_type.is_empty());
        }
        let labels: BTreeSet<&str> = partition.groups.iter().map(|g| g.label.as_str()).collect();
        assert_eq!(labels, ["a[3:0]", "b[3:0]", "y[3:0]"].into_iter().collect());
        assert_eq!(partition.group_of.len(), 12);
        assert!(!partition.group_of.contains_key(&8));
    }

    #[test]
    fn bit_parallel_mux_row_groups_with_shared_select() {
        let (graph, registers) = mux_row_graph();

        let partition = GroupPartition::build(&graph, &registers, Vec::new());

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

        let partition = GroupPartition::build(&graph, &[], Vec::new());

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
        let partition = GroupPartition::build(&graph, &narrow, Vec::new());
        assert!(partition.groups.is_empty());
        assert!(partition.group_of.is_empty());

        // A multi-bit register held in one cell has no second member to merge.
        let single_cell = vec![register_group("s_wide", &[(0, 6), (1, 6)])];
        let partition = GroupPartition::build(&graph, &single_cell, Vec::new());
        assert!(partition.groups.is_empty());
    }

    #[test]
    fn divergent_sink_shapes_split_into_two_groups() {
        let graph = divergent_sink_graph();

        let partition = GroupPartition::build(&graph, &[], Vec::new());

        // Two comb vectors split by sink shape, plus the a/x/y bus ports.
        assert_eq!(partition.groups.len(), 5);
        let x = &partition.groups[0];
        assert_eq!(x.kind, GroupKind::Comb);
        assert_eq!(x.members, vec![8, 9, 10, 11]);
        assert_eq!(x.label, "x[3:0]");
        let y = &partition.groups[1];
        assert_eq!(y.members, vec![12, 13, 14, 15]);
        assert_eq!(y.label, "y[3:0]");
        assert!(
            partition.groups[2..]
                .iter()
                .all(|g| g.kind == GroupKind::Port)
        );
    }

    #[test]
    fn partition_is_deterministic_across_runs() {
        let (graph, registers) = mux_row_graph();
        let first = GroupPartition::build(&graph, &registers, Vec::new());
        let second = GroupPartition::build(&graph, &registers, Vec::new());
        assert_eq!(first, second);

        let divergent = divergent_sink_graph();
        let first = GroupPartition::build(&divergent, &[], Vec::new());
        let second = GroupPartition::build(&divergent, &[], Vec::new());
        assert_eq!(first, second);
    }

    #[test]
    fn projection_can_expand_one_group_without_disabling_the_others() {
        let (graph, registers) = mux_row_graph();
        let partition = GroupPartition::build(&graph, &registers, Vec::new());
        let first_group = 0;
        let member = partition.groups[first_group].members[0];

        let collapsed = GroupingProjection::all(&partition);
        assert_eq!(collapsed.group_id(member), Some(first_group as GroupId));

        let expanded_groups = [first_group as GroupId];
        let expanded =
            GroupingProjection::from_flags_with_expanded(&partition, true, true, &expanded_groups)
                .expect("grouping remains enabled");
        assert_eq!(expanded.group_id(member), None);
        if let Some(other) = partition
            .groups
            .get(1)
            .and_then(|group| group.members.first())
        {
            assert_eq!(expanded.group_id(*other), Some(1));
        }
    }
}
