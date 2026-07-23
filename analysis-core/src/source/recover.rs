//! Source-range recovery from provenance-preserving synthesis artifacts.

use crate::graph::{Graph, NodeId, NodeKind, strip_bit_suffix};
use crate::netlist::{PortDirection, YosysNetlist};
use crate::source::coordinates::{ParsedSourceSpan, parse_src_span};
use crate::source::{
    SOURCE_RANGE_ASSOCIATION_CAP, SOURCE_RANGE_INDEX_CAP, SOURCE_ROOT_COLLECTION_CAP,
    SourceProbeDirection, SourceProbeHint, SourceProbeHintKind, SourceRangeMapping,
};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

const SOURCE_DECLARATION_CAP: usize = SOURCE_RANGE_ASSOCIATION_CAP / 2;
const SOURCE_DECLARATION_ROOT_LOOKUP_CAP: usize = SOURCE_RANGE_ASSOCIATION_CAP;

#[derive(Debug, Default)]
pub(crate) struct SourceProvenance {
    pub ranges: Vec<SourceRangeMapping>,
    pub truncated: bool,
    /// Resolved procedural-assignment targets per `(file, statement line)`.
    /// Lines whose targets could not be fully resolved carry no entry so line
    /// probes fall back to whole-block attribution.
    pub procedural_targets: HashMap<(String, usize), Vec<NodeId>>,
    pub probe_hints: Vec<SourceProbeHint>,
}

#[derive(Debug, Default)]
struct RangeProvenance {
    roots: BTreeSet<NodeId>,
    signal_bits: BTreeSet<u32>,
    approximate_signal_bits: BTreeSet<u32>,
    mapping_incomplete: bool,
}

#[derive(Debug, Default)]
struct SignalRootIndex {
    fanin: HashMap<String, Vec<NodeId>>,
    fanout: HashMap<String, Vec<NodeId>>,
    fanin_incomplete: HashSet<String>,
    fanout_incomplete: HashSet<String>,
    bits: HashMap<String, Vec<u32>>,
    bits_incomplete: HashSet<String>,
}

impl SignalRootIndex {
    fn for_direction(
        &self,
        direction: SourceProbeDirection,
    ) -> (&HashMap<String, Vec<NodeId>>, &HashSet<String>) {
        match direction {
            SourceProbeDirection::Fanin => (&self.fanin, &self.fanin_incomplete),
            SourceProbeDirection::Fanout => (&self.fanout, &self.fanout_incomplete),
        }
    }
}

/// Recover source provenance and directional probe intent across the pre-flatten
/// source netlist and submitted source. Named net declarations use authoritative
/// Yosys `src` attributes; assignments still need the lightweight source scanner.
/// Both paths resolve source signal names in the selected top's live elaborated
/// hierarchy through exact flattened scopes, final net aliases, and graph
/// incidence. Scanner recovery skips conditional preprocessor branches rather
/// than risking a false mapping from inactive source.
pub(crate) fn recover_source_provenance(
    graph: &Graph,
    source_netlist: &YosysNetlist,
    files: impl IntoIterator<Item = (String, String)>,
) -> SourceProvenance {
    let files = files.into_iter().collect::<Vec<_>>();
    let design_files = files
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<HashSet<_>>();
    let module_scopes = module_scopes(source_netlist, &graph.top);
    let (declarations, mut declarations_truncated) = netname_declarations(
        source_netlist,
        &design_files,
        &module_scopes.elaborated,
        SOURCE_DECLARATION_CAP,
    );
    let declaration_bit_names = declaration_bit_names(&declarations, &module_scopes.elaborated);
    let roots_by_name = roots_by_signal_name(graph, &declaration_bit_names);
    let mut ranges: BTreeMap<ParsedSourceSpan, RangeProvenance> = BTreeMap::new();
    let mut association_count = 0usize;
    let mut signal_bit_association_count = 0usize;
    let mut procedural: BTreeMap<(String, usize), BTreeSet<NodeId>> = BTreeMap::new();
    let mut unusable_lines: HashSet<(String, usize)> = HashSet::new();
    let mut target_count = 0usize;
    let mut probe_hints = Vec::new();
    let mut probe_hints_truncated = false;
    let mut ranges_truncated = false;
    let ports_by_module = ports_by_source_module(source_netlist);

    for (file, source) in files {
        if has_conditional_preprocessor(&source) {
            continue;
        }
        let scanned = scan_assignments(&source);
        for assignment in scanned.continuous {
            let Some(scopes) = module_scopes.source.get(&assignment.module) else {
                continue;
            };
            let mut roots = BTreeSet::new();
            let mut mapping_incomplete = false;
            for identifier in assignment.lhs_identifiers {
                for scope in scopes {
                    let qualified = if scope.is_empty() {
                        identifier.clone()
                    } else {
                        format!("{scope}.{identifier}")
                    };
                    mapping_incomplete |= roots_by_name.fanin_incomplete.contains(&qualified);
                    if let Some(ids) = roots_by_name.fanin.get(qualified.as_str()) {
                        for id in ids {
                            mapping_incomplete |= insert_bounded_root(&mut roots, *id);
                        }
                    }
                }
            }
            if !roots.is_empty() {
                let omitted = push_probe_hint(
                    &mut probe_hints,
                    SourceProbeHint {
                        file: file.clone(),
                        start_line: assignment.start_line,
                        start_column: Some(assignment.start_column),
                        end_line: assignment.end_line,
                        end_column: Some(assignment.end_column),
                        direction: SourceProbeDirection::Fanin,
                        kind: SourceProbeHintKind::Signal,
                    },
                );
                mapping_incomplete |= omitted;
                probe_hints_truncated |= omitted;
            }
            let Some(range) = bounded_range_entry(
                &mut ranges,
                (
                    file.clone(),
                    assignment.start_line,
                    Some(assignment.start_column),
                    assignment.end_line,
                    Some(assignment.end_column),
                ),
                &mut ranges_truncated,
            ) else {
                continue;
            };
            merge_range_roots(range, roots, mapping_incomplete, &mut association_count);
        }
        for declaration in scan_port_declarations(&source, &ports_by_module) {
            let Some(scopes) = module_scopes.source.get(&declaration.module) else {
                continue;
            };
            let mut roots = BTreeSet::new();
            let mut mapping_incomplete = false;
            let directions: &[SourceProbeDirection] = match declaration.direction {
                PortDirection::Input => &[SourceProbeDirection::Fanout],
                PortDirection::Output => &[SourceProbeDirection::Fanin],
                PortDirection::Inout => {
                    &[SourceProbeDirection::Fanin, SourceProbeDirection::Fanout]
                }
            };
            for direction in directions {
                let (direction_roots, incomplete) = roots_by_name.for_direction(*direction);
                for scope in scopes {
                    let qualified = if scope.is_empty() {
                        declaration.identifier.clone()
                    } else {
                        format!("{scope}.{}", declaration.identifier)
                    };
                    mapping_incomplete |= incomplete.contains(&qualified);
                    if let Some(ids) = direction_roots.get(qualified.as_str()) {
                        for id in ids {
                            mapping_incomplete |= insert_bounded_root(&mut roots, *id);
                        }
                    }
                }
            }
            if !roots.is_empty() {
                let hints = directions
                    .iter()
                    .map(|direction| SourceProbeHint {
                        file: file.clone(),
                        start_line: declaration.line,
                        start_column: Some(declaration.start_column),
                        end_line: declaration.line,
                        end_column: Some(declaration.end_column),
                        direction: *direction,
                        kind: if declaration.direction == PortDirection::Output {
                            SourceProbeHintKind::OutputPort
                        } else {
                            SourceProbeHintKind::Signal
                        },
                    })
                    .collect();
                let omitted = push_probe_hint_group(&mut probe_hints, hints);
                mapping_incomplete |= omitted;
                probe_hints_truncated |= omitted;
            }
            let Some(range) = bounded_range_entry(
                &mut ranges,
                (
                    file.clone(),
                    declaration.line,
                    Some(declaration.start_column),
                    declaration.line,
                    Some(declaration.end_column),
                ),
                &mut ranges_truncated,
            ) else {
                continue;
            };
            merge_range_roots(range, roots, mapping_incomplete, &mut association_count);
        }
        for assignment in &scanned.procedural {
            let Some(scopes) = module_scopes.source.get(&assignment.module) else {
                continue;
            };
            let mut roots = BTreeSet::new();
            let mut unusable = false;
            for identifier in &assignment.lhs_identifiers {
                for scope in scopes {
                    let qualified = if scope.is_empty() {
                        identifier.clone()
                    } else {
                        format!("{scope}.{identifier}")
                    };
                    unusable |= roots_by_name.fanin_incomplete.contains(&qualified);
                    if let Some(ids) = roots_by_name.fanin.get(qualified.as_str()) {
                        for id in ids {
                            unusable |= insert_bounded_root(&mut roots, *id);
                        }
                    }
                }
            }
            if roots.is_empty() {
                continue;
            }
            let Some(range) = bounded_range_entry(
                &mut ranges,
                (
                    file.clone(),
                    assignment.line,
                    Some(assignment.start_column),
                    assignment.end_line,
                    Some(assignment.end_column),
                ),
                &mut ranges_truncated,
            ) else {
                continue;
            };
            merge_range_roots(
                range,
                roots.iter().copied(),
                unusable,
                &mut association_count,
            );
            let key = (file.clone(), assignment.line);
            if unusable {
                unusable_lines.insert(key);
                continue;
            }
            let targets = procedural.entry(key.clone()).or_default();
            for root in roots {
                if targets.contains(&root) {
                    continue;
                }
                if targets.len() == SOURCE_ROOT_COLLECTION_CAP
                    || target_count == SOURCE_RANGE_ASSOCIATION_CAP
                {
                    unusable_lines.insert(key.clone());
                    break;
                }
                targets.insert(root);
                target_count += 1;
            }
        }
        for assignment in &scanned.procedural {
            let key = (file.clone(), assignment.line);
            if procedural.contains_key(&key) && !unusable_lines.contains(&key) {
                probe_hints_truncated |= push_probe_hint(
                    &mut probe_hints,
                    SourceProbeHint {
                        file: file.clone(),
                        start_line: assignment.line,
                        start_column: Some(assignment.start_column),
                        end_line: assignment.end_line,
                        end_column: Some(assignment.end_column),
                        direction: SourceProbeDirection::Fanin,
                        kind: SourceProbeHintKind::Procedural,
                    },
                );
            }
        }
        let resolved_lines: BTreeSet<usize> = scanned
            .procedural
            .iter()
            .filter_map(|assignment| {
                procedural
                    .contains_key(&(file.clone(), assignment.line))
                    .then_some(assignment.line)
            })
            .collect();
        let unusable_file_lines: BTreeSet<usize> = scanned
            .procedural
            .iter()
            .filter_map(|assignment| {
                unusable_lines
                    .contains(&(file.clone(), assignment.line))
                    .then_some(assignment.line)
            })
            .collect();
        for block in scanned.blocks {
            let has_resolved_target = resolved_lines
                .range(block.start_line..=block.end_line)
                .next()
                .is_some();
            let has_unusable_target = unusable_file_lines
                .range(block.start_line..=block.end_line)
                .next()
                .is_some();
            if has_resolved_target && !has_unusable_target {
                probe_hints_truncated |= push_probe_hint(
                    &mut probe_hints,
                    SourceProbeHint {
                        file: file.clone(),
                        start_line: block.start_line,
                        start_column: None,
                        end_line: block.end_line,
                        end_column: None,
                        direction: SourceProbeDirection::Fanin,
                        kind: SourceProbeHintKind::Block,
                    },
                );
            }
        }
    }

    let mut declaration_root_lookups = 0usize;
    let mut declaration_bit_lookups = 0usize;
    let mut declaration_hint_ranges = HashSet::new();
    for declaration in declarations {
        let Some(scopes) = module_scopes.elaborated.get(&declaration.module) else {
            continue;
        };
        let remaining_lookups =
            SOURCE_DECLARATION_ROOT_LOOKUP_CAP.saturating_sub(declaration_root_lookups);
        let remaining_bit_lookups =
            SOURCE_DECLARATION_ROOT_LOOKUP_CAP.saturating_sub(declaration_bit_lookups);
        let scope_limit = scopes
            .len()
            .min(remaining_lookups / 2)
            .min(remaining_bit_lookups);
        if scope_limit == 0 {
            declarations_truncated = true;
            break;
        }
        let mapping_partial = scope_limit < scopes.len();
        declaration_root_lookups += scope_limit * 2;
        declaration_bit_lookups += scope_limit;
        let mut roots = BTreeSet::new();
        let mut signal_bits = BTreeSet::new();
        let mut mapping_incomplete = mapping_partial;
        for direction in [SourceProbeDirection::Fanin, SourceProbeDirection::Fanout] {
            let (direction_roots, incomplete) = roots_by_name.for_direction(direction);
            for scope in &scopes[..scope_limit] {
                let qualified = if scope.is_empty() {
                    declaration.identifier.clone()
                } else {
                    format!("{scope}.{}", declaration.identifier)
                };
                mapping_incomplete |= incomplete.contains(&qualified);
                if let Some(ids) = direction_roots.get(qualified.as_str()) {
                    for id in ids {
                        mapping_incomplete |= insert_bounded_root(&mut roots, *id);
                    }
                }
            }
        }
        for scope in &scopes[..scope_limit] {
            let qualified = if scope.is_empty() {
                declaration.identifier.clone()
            } else {
                format!("{scope}.{}", declaration.identifier)
            };
            mapping_incomplete |= roots_by_name.bits_incomplete.contains(&qualified);
            if let Some(bits) = roots_by_name.bits.get(qualified.as_str()) {
                for bit in bits {
                    mapping_incomplete |= insert_bounded_root(&mut signal_bits, *bit);
                }
            }
        }
        let hint_range = (
            declaration.file.clone(),
            declaration.start_line,
            declaration.start_column,
            declaration.end_line,
            declaration.end_column,
        );
        if !roots.is_empty() && declaration_hint_ranges.insert(hint_range) {
            let hints = [SourceProbeDirection::Fanin, SourceProbeDirection::Fanout]
                .into_iter()
                .map(|direction| SourceProbeHint {
                    file: declaration.file.clone(),
                    start_line: declaration.start_line,
                    start_column: declaration.start_column,
                    end_line: declaration.end_line,
                    end_column: declaration.end_column,
                    direction,
                    kind: SourceProbeHintKind::Signal,
                })
                .collect();
            let omitted = push_probe_hint_group(&mut probe_hints, hints);
            mapping_incomplete |= omitted;
            probe_hints_truncated |= omitted;
        }
        let Some(range) = bounded_range_entry(
            &mut ranges,
            (
                declaration.file,
                declaration.start_line,
                declaration.start_column,
                declaration.end_line,
                declaration.end_column,
            ),
            &mut ranges_truncated,
        ) else {
            continue;
        };
        merge_range_roots(range, roots, mapping_incomplete, &mut association_count);
        merge_range_signal_bits(range, signal_bits, &mut signal_bit_association_count);
        if mapping_partial {
            declarations_truncated = true;
            break;
        }
    }

    let vhdl_wire_ranges_truncated = merge_vhdl_wire_line_provenance(
        graph,
        source_netlist,
        &design_files,
        &mut ranges,
        &mut signal_bit_association_count,
    );

    let ranges = ranges
        .into_iter()
        .map(
            |((file, start_line, start_column, end_line, end_column), range)| SourceRangeMapping {
                file,
                start_line,
                end_line,
                start_column,
                end_column,
                node_ids: range.roots.into_iter().collect(),
                signal_bits: range.signal_bits.into_iter().collect(),
                approximate_signal_bits: range.approximate_signal_bits.into_iter().collect(),
                mapping_incomplete: range.mapping_incomplete,
            },
        )
        .collect::<Vec<_>>();
    let truncated = declarations_truncated
        || probe_hints_truncated
        || ranges_truncated
        || vhdl_wire_ranges_truncated
        || ranges.iter().any(|range| range.mapping_incomplete);
    let procedural_targets = procedural
        .into_iter()
        .filter(|(key, _)| !unusable_lines.contains(key))
        .map(|(key, roots)| (key, roots.into_iter().collect()))
        .collect();
    SourceProvenance {
        ranges,
        truncated,
        procedural_targets,
        probe_hints,
    }
}

fn push_probe_hint(probe_hints: &mut Vec<SourceProbeHint>, hint: SourceProbeHint) -> bool {
    if probe_hints.len() >= SOURCE_RANGE_ASSOCIATION_CAP {
        return true;
    }
    probe_hints.push(hint);
    false
}

fn push_probe_hint_group(
    probe_hints: &mut Vec<SourceProbeHint>,
    hints: Vec<SourceProbeHint>,
) -> bool {
    if probe_hints.len().saturating_add(hints.len()) > SOURCE_RANGE_ASSOCIATION_CAP {
        return true;
    }
    probe_hints.extend(hints);
    false
}

fn bounded_range_entry<'a>(
    ranges: &'a mut BTreeMap<ParsedSourceSpan, RangeProvenance>,
    location: ParsedSourceSpan,
    truncated: &mut bool,
) -> Option<&'a mut RangeProvenance> {
    if !ranges.contains_key(&location) && ranges.len() >= SOURCE_RANGE_INDEX_CAP {
        *truncated = true;
        return None;
    }
    Some(ranges.entry(location).or_default())
}

fn merge_range_roots(
    range: &mut RangeProvenance,
    roots: impl IntoIterator<Item = NodeId>,
    mapping_incomplete: bool,
    association_count: &mut usize,
) {
    range.mapping_incomplete |= mapping_incomplete;
    for root in roots {
        if range.roots.contains(&root) {
            continue;
        }
        if range.roots.len() == SOURCE_ROOT_COLLECTION_CAP
            || *association_count == SOURCE_RANGE_ASSOCIATION_CAP
        {
            range.mapping_incomplete = true;
            continue;
        }
        range.roots.insert(root);
        *association_count += 1;
    }
}

fn merge_range_signal_bits(
    range: &mut RangeProvenance,
    bits: impl IntoIterator<Item = u32>,
    association_count: &mut usize,
) -> bool {
    let mut truncated = false;
    for bit in bits {
        if range.signal_bits.contains(&bit) {
            continue;
        }
        if range.signal_bits.len() == SOURCE_ROOT_COLLECTION_CAP
            || *association_count == SOURCE_RANGE_ASSOCIATION_CAP
        {
            range.mapping_incomplete = true;
            truncated = true;
            continue;
        }
        range.signal_bits.insert(bit);
        *association_count += 1;
    }
    truncated
}

fn merge_range_approximate_signal_bits(
    range: &mut RangeProvenance,
    bits: impl IntoIterator<Item = u32>,
    association_count: &mut usize,
) -> bool {
    let mut truncated = false;
    for bit in bits {
        if range.approximate_signal_bits.contains(&bit) {
            continue;
        }
        if range.approximate_signal_bits.len() == SOURCE_ROOT_COLLECTION_CAP
            || *association_count == SOURCE_RANGE_ASSOCIATION_CAP
        {
            range.mapping_incomplete = true;
            truncated = true;
            continue;
        }
        range.approximate_signal_bits.insert(bit);
        *association_count += 1;
    }
    truncated
}

/// GHDL's translated Verilog gives public net names generated-file locations,
/// while nodes in the final graph may retain original VHDL spans through Yosys.
/// Associate surviving final wire bits with those spans across flattened
/// hierarchy. VHDL columns are deliberately discarded: translation only
/// guarantees line-level reverse provenance in the submitted source.
fn merge_vhdl_wire_line_provenance(
    graph: &Graph,
    source_netlist: &YosysNetlist,
    design_files: &HashSet<String>,
    ranges: &mut BTreeMap<ParsedSourceSpan, RangeProvenance>,
    association_count: &mut usize,
) -> bool {
    let vhdl_files = design_files
        .iter()
        .filter(|file| {
            std::path::Path::new(file)
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("vhd") || extension.eq_ignore_ascii_case("vhdl")
                })
        })
        .cloned()
        .collect::<HashSet<_>>();
    if vhdl_files.is_empty() {
        return false;
    }
    let mut truncated = false;

    // ABC can remove every original source attribute from the final graph. Keep
    // a bounded, line-only envelope of the VHDL locations in the pre-ABC
    // netlist so those otherwise unmapped wires still have an honest coarse
    // reverse mapping.
    let mut coarse_envelopes = BTreeMap::<String, (usize, usize)>::new();
    let mut source_cell_visits = 0usize;
    let mut source_fragment_visits = 0usize;
    'source_modules: for module in source_netlist.modules.values() {
        for cell in module.cells.values() {
            if source_cell_visits == SOURCE_DECLARATION_CAP {
                truncated = true;
                break 'source_modules;
            }
            source_cell_visits += 1;
            let Some(src) = cell.attributes.get("src") else {
                continue;
            };
            for fragment in src.split('|') {
                if source_fragment_visits == SOURCE_RANGE_ASSOCIATION_CAP {
                    truncated = true;
                    break 'source_modules;
                }
                source_fragment_visits += 1;
                let Some((file, start_line, _, end_line, _)) = parse_src_span(fragment) else {
                    continue;
                };
                if !vhdl_files.contains(&file) {
                    continue;
                }
                coarse_envelopes
                    .entry(file)
                    .and_modify(|(minimum, maximum)| {
                        *minimum = (*minimum).min(start_line);
                        *maximum = (*maximum).max(end_line);
                    })
                    .or_insert((start_line, end_line));
            }
        }
    }
    let coarse_locations = coarse_envelopes
        .into_iter()
        .map(|(file, (start_line, end_line))| (file, start_line, None, end_line, None))
        .collect::<BTreeSet<_>>();

    let mut node_bits = BTreeMap::<NodeId, BTreeSet<u32>>::new();
    let mut bit_nodes = BTreeMap::<u32, BTreeSet<NodeId>>::new();
    for edge in graph.edges.iter().take(SOURCE_RANGE_ASSOCIATION_CAP) {
        let Some(bit) = edge.bit else {
            continue;
        };
        for node in [edge.from, edge.to] {
            node_bits.entry(node).or_default().insert(bit);
            bit_nodes.entry(bit).or_default().insert(node);
        }
    }
    truncated |= graph.edges.len() > SOURCE_RANGE_ASSOCIATION_CAP;
    let mut bit_ranges = BTreeMap::<u32, BTreeSet<ParsedSourceSpan>>::new();
    let mut work_visits = 0usize;

    'seeds: for (node_visits, node) in graph.nodes.iter().enumerate() {
        if node_visits == SOURCE_DECLARATION_CAP {
            truncated = true;
            break;
        }
        let Some(src) = node.src.as_deref() else {
            continue;
        };
        let mut line_ranges = BTreeSet::new();
        for fragment in src.split('|') {
            let Some((file, start_line, _, end_line, _)) = parse_src_span(fragment) else {
                continue;
            };
            if !vhdl_files.contains(&file) {
                continue;
            }
            let line_range = (file, start_line, None, end_line, None);
            if line_ranges.contains(&line_range) {
                continue;
            }
            if line_ranges.len() == SOURCE_DECLARATION_CAP {
                truncated = true;
                break;
            }
            line_ranges.insert(line_range);
        }
        if line_ranges.is_empty() {
            continue;
        }
        let Some(incident_bits) = node_bits.get(&node.id) else {
            continue;
        };
        for bit in incident_bits {
            for line_range in &line_ranges {
                if work_visits == SOURCE_RANGE_ASSOCIATION_CAP {
                    truncated = true;
                    break 'seeds;
                }
                work_visits += 1;
                let locations = bit_ranges.entry(*bit).or_default();
                if !locations.contains(line_range) {
                    if locations.len() == SOURCE_ROOT_COLLECTION_CAP {
                        truncated = true;
                        continue;
                    }
                    locations.insert(line_range.clone());
                }
            }
        }
    }

    // ABC removes source attributes from the combinational cells it creates.
    // Carry line-level provenance from attributed boundary wires across only
    // those source-less combinational regions. Sequential and source-bearing
    // nodes remain boundaries, preventing propagation through unrelated logic.
    let mut pending = VecDeque::new();
    let mut queued = HashSet::new();
    let mut queue_visits = 0usize;
    'queue_seeds: for bit in bit_ranges.keys() {
        if let Some(nodes) = bit_nodes.get(bit) {
            for node in nodes {
                if queue_visits == SOURCE_RANGE_ASSOCIATION_CAP {
                    truncated = true;
                    break 'queue_seeds;
                }
                queue_visits += 1;
                if queued.insert(*node) {
                    pending.push_back(*node);
                }
            }
        }
    }
    'propagate: while let Some(node_id) = pending.pop_front() {
        queued.remove(&node_id);
        let node = &graph.nodes[node_id as usize];
        if node.kind != NodeKind::Cell || node.seq || node.src.is_some() {
            continue;
        }
        let Some(incident_bits) = node_bits.get(&node_id) else {
            continue;
        };
        let mut locations = BTreeSet::new();
        for bit in incident_bits {
            if let Some(bit_locations) = bit_ranges.get(bit) {
                for location in bit_locations {
                    if locations.contains(location) {
                        continue;
                    }
                    if locations.len() == SOURCE_ROOT_COLLECTION_CAP {
                        truncated = true;
                        break;
                    }
                    locations.insert(location.clone());
                }
            }
        }
        for bit in incident_bits {
            for location in &locations {
                if work_visits == SOURCE_RANGE_ASSOCIATION_CAP {
                    truncated = true;
                    break 'propagate;
                }
                work_visits += 1;
                let bit_locations = bit_ranges.entry(*bit).or_default();
                if bit_locations.contains(location) {
                    continue;
                }
                if bit_locations.len() == SOURCE_ROOT_COLLECTION_CAP {
                    truncated = true;
                    continue;
                }
                bit_locations.insert(location.clone());
                if let Some(neighbors) = bit_nodes.get(bit) {
                    for neighbor in neighbors {
                        if queue_visits == SOURCE_RANGE_ASSOCIATION_CAP {
                            truncated = true;
                            break 'propagate;
                        }
                        queue_visits += 1;
                        if queued.insert(*neighbor) {
                            pending.push_back(*neighbor);
                        }
                    }
                }
            }
        }
    }

    // When the final graph has no attributed seed at all, associate its indexed
    // bits with the pre-ABC envelope as reverse-only approximate associations.
    // They never enter the exact source-to-schematic direct-bit path.
    let mut coarse_work_visits = 0usize;
    let mut coarse_bits = BTreeSet::new();
    'coarse: for bit in bit_nodes.keys() {
        if bit_ranges.contains_key(bit) {
            continue;
        }
        for location in &coarse_locations {
            if coarse_work_visits == SOURCE_RANGE_ASSOCIATION_CAP {
                truncated = true;
                break 'coarse;
            }
            coarse_work_visits += 1;
            let locations = bit_ranges.entry(*bit).or_default();
            if locations.len() == SOURCE_ROOT_COLLECTION_CAP {
                truncated = true;
                continue;
            }
            locations.insert(location.clone());
            coarse_bits.insert(*bit);
        }
    }

    let mut fallback_range_count = 0usize;
    for (bit, locations) in bit_ranges {
        for location in locations {
            if !ranges.contains_key(&location) {
                if fallback_range_count == SOURCE_DECLARATION_CAP {
                    truncated = true;
                    continue;
                }
                fallback_range_count += 1;
            }
            let approximate = coarse_bits.contains(&bit) && coarse_locations.contains(&location);
            let Some(range) = bounded_range_entry(ranges, location, &mut truncated) else {
                continue;
            };
            if approximate {
                truncated |= merge_range_approximate_signal_bits(range, [bit], association_count);
            } else {
                truncated |= merge_range_signal_bits(range, [bit], association_count);
            }
        }
    }
    truncated
}

#[derive(Debug, Default)]
struct ModuleScopes {
    source: HashMap<String, Vec<String>>,
    elaborated: HashMap<String, Vec<String>>,
}

fn module_scopes(source_netlist: &YosysNetlist, selected_top: &str) -> ModuleScopes {
    let mut scopes = ModuleScopes::default();
    let mut pending = vec![(selected_top.to_owned(), String::new())];
    let mut seen = HashSet::new();
    while let Some((module_name, scope)) = pending.pop() {
        if !seen.insert((module_name.clone(), scope.clone())) {
            continue;
        }
        let Some(module) = source_netlist.modules.get(&module_name) else {
            continue;
        };
        let source_module_name = module
            .attributes
            .get("hdlname")
            .map_or_else(|| normalize_name(&module_name), |name| normalize_name(name));
        scopes
            .source
            .entry(source_module_name)
            .or_default()
            .push(scope.clone());
        scopes
            .elaborated
            .entry(module_name.clone())
            .or_default()
            .push(scope.clone());
        for (cell_name, cell) in &module.cells {
            let Some((child_name, _)) = source_netlist.modules.get_key_value(&cell.cell_type)
            else {
                continue;
            };
            let cell_name = normalize_name(cell_name);
            let child_scope = if scope.is_empty() {
                cell_name
            } else {
                format!("{scope}.{cell_name}")
            };
            pending.push((child_name.clone(), child_scope));
        }
    }
    for index in [&mut scopes.source, &mut scopes.elaborated] {
        for prefixes in index.values_mut() {
            prefixes.sort();
            prefixes.dedup();
        }
    }
    scopes
}

fn declaration_bit_names(
    declarations: &[NetnameDeclaration],
    scopes_by_module: &HashMap<String, Vec<String>>,
) -> HashSet<String> {
    let mut names = HashSet::new();
    let mut lookups = 0usize;
    for declaration in declarations {
        let Some(scopes) = scopes_by_module.get(&declaration.module) else {
            continue;
        };
        for scope in scopes {
            if lookups == SOURCE_DECLARATION_ROOT_LOOKUP_CAP {
                return names;
            }
            names.insert(if scope.is_empty() {
                declaration.identifier.clone()
            } else {
                format!("{scope}.{}", declaration.identifier)
            });
            lookups += 1;
        }
    }
    names
}

fn roots_by_signal_name(graph: &Graph, declaration_bit_names: &HashSet<String>) -> SignalRootIndex {
    let mut fanin: HashMap<String, BTreeSet<NodeId>> = HashMap::new();
    let mut fanout: HashMap<String, BTreeSet<NodeId>> = HashMap::new();
    let mut fanin_incomplete = HashSet::new();
    let mut fanout_incomplete = HashSet::new();
    let mut bits: HashMap<String, BTreeSet<u32>> = HashMap::new();
    let mut bits_incomplete = HashSet::new();
    let mut bit_association_count = 0usize;
    for node in &graph.nodes {
        if node.kind != NodeKind::PortBit {
            continue;
        }
        let names = node.port.iter().chain(std::iter::once(&node.name));
        if !graph.incoming[node.id as usize].is_empty() {
            for name in names.clone() {
                insert_root_name(&mut fanin, &mut fanin_incomplete, name, node.id);
            }
        }
        if !graph.outgoing[node.id as usize].is_empty() {
            for name in names {
                insert_root_name(&mut fanout, &mut fanout_incomplete, name, node.id);
            }
        }
    }

    let mut drivers: HashMap<u32, BTreeSet<NodeId>> = HashMap::new();
    let mut incomplete_drivers = HashSet::new();
    for edge in &graph.edges {
        let Some(bit) = edge.bit else {
            continue;
        };
        if insert_bounded_root(drivers.entry(bit).or_default(), edge.from) {
            incomplete_drivers.insert(bit);
        }
    }
    for (bit, aliases) in &graph.net_aliases {
        for alias in aliases {
            insert_signal_bit(
                &mut bits,
                &mut bits_incomplete,
                declaration_bit_names,
                &mut bit_association_count,
                alias,
                *bit,
            );
        }
        let Some(nodes) = drivers.get(bit) else {
            continue;
        };
        for alias in aliases {
            if incomplete_drivers.contains(bit) {
                mark_root_name_incomplete(&mut fanin_incomplete, alias);
                mark_root_name_incomplete(&mut fanout_incomplete, alias);
            }
            for node in nodes {
                insert_root_name(&mut fanin, &mut fanin_incomplete, alias, *node);
                insert_root_name(&mut fanout, &mut fanout_incomplete, alias, *node);
            }
        }
    }

    SignalRootIndex {
        fanin: sorted_root_map(fanin),
        fanout: sorted_root_map(fanout),
        fanin_incomplete,
        fanout_incomplete,
        bits: bits
            .into_iter()
            .map(|(name, bits)| (name, bits.into_iter().collect()))
            .collect(),
        bits_incomplete,
    }
}

fn insert_signal_bit(
    bits: &mut HashMap<String, BTreeSet<u32>>,
    incomplete: &mut HashSet<String>,
    requested_names: &HashSet<String>,
    association_count: &mut usize,
    raw_name: &str,
    bit: u32,
) {
    let name = normalize_name(raw_name);
    let base = strip_bit_suffix(&name).to_owned();
    for key in [name, base] {
        if !requested_names.contains(&key) {
            continue;
        }
        let values = bits.entry(key.clone()).or_default();
        if values.contains(&bit) {
            continue;
        }
        if *association_count == SOURCE_RANGE_ASSOCIATION_CAP || insert_bounded_root(values, bit) {
            incomplete.insert(key);
            continue;
        }
        *association_count += 1;
    }
}

fn sorted_root_map(roots: HashMap<String, BTreeSet<NodeId>>) -> HashMap<String, Vec<NodeId>> {
    roots
        .into_iter()
        .map(|(name, ids)| (name, ids.into_iter().collect()))
        .collect()
}

fn insert_root_name(
    roots: &mut HashMap<String, BTreeSet<NodeId>>,
    incomplete: &mut HashSet<String>,
    raw_name: &str,
    node: NodeId,
) {
    let name = normalize_name(raw_name);
    let base = strip_bit_suffix(&name).to_owned();
    if insert_bounded_root(roots.entry(name.clone()).or_default(), node) {
        incomplete.insert(name);
    }
    if insert_bounded_root(roots.entry(base.clone()).or_default(), node) {
        incomplete.insert(base);
    }
}

fn mark_root_name_incomplete(incomplete: &mut HashSet<String>, raw_name: &str) {
    let name = normalize_name(raw_name);
    incomplete.insert(name.clone());
    incomplete.insert(strip_bit_suffix(&name).to_owned());
}

fn insert_bounded_root(roots: &mut BTreeSet<NodeId>, node: NodeId) -> bool {
    roots.insert(node);
    if roots.len() > SOURCE_ROOT_COLLECTION_CAP {
        roots.pop_last();
        true
    } else {
        false
    }
}

fn normalize_name(raw_name: &str) -> String {
    raw_name.trim_start_matches('\\').replace('\\', "")
}

fn ports_by_source_module(
    source_netlist: &YosysNetlist,
) -> HashMap<String, HashMap<String, PortDirection>> {
    let mut modules = HashMap::<String, HashMap<String, PortDirection>>::new();
    for (module_name, module) in &source_netlist.modules {
        let source_name = module
            .attributes
            .get("hdlname")
            .map_or_else(|| normalize_name(module_name), |name| normalize_name(name));
        let ports = modules.entry(source_name).or_default();
        for (name, port) in &module.ports {
            ports.insert(normalize_name(name), port.direction);
        }
    }
    modules
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct NetnameDeclaration {
    module: String,
    identifier: String,
    file: String,
    start_line: usize,
    start_column: Option<usize>,
    end_line: usize,
    end_column: Option<usize>,
}

/// Read user-visible internal declaration locations from the pre-flatten
/// netlist. Hidden Yosys temporaries and module ports have separate provenance
/// paths and must not turn expression or port spans into internal declarations.
fn netname_declarations(
    source_netlist: &YosysNetlist,
    design_files: &HashSet<String>,
    reachable_modules: &HashMap<String, Vec<String>>,
    declaration_cap: usize,
) -> (Vec<NetnameDeclaration>, bool) {
    let mut declarations = BTreeSet::new();
    let mut truncated = false;
    'modules: for (module_name, module) in &source_netlist.modules {
        if !reachable_modules.contains_key(module_name) {
            continue;
        }
        let ports = module
            .ports
            .keys()
            .map(|name| normalize_name(name))
            .collect::<HashSet<_>>();
        for (raw_name, netname) in &module.netnames {
            if netname.hide_name != 0 {
                continue;
            }
            let identifier = strip_bit_suffix(&normalize_name(raw_name)).to_owned();
            if ports.contains(&identifier) {
                continue;
            }
            let Some(src) = netname.attributes.get("src") else {
                continue;
            };
            for location in src.split('|') {
                let Some((file, start_line, start_column, end_line, end_column)) =
                    parse_src_span(location)
                else {
                    continue;
                };
                if design_files.contains(&file) {
                    let declaration = NetnameDeclaration {
                        module: module_name.clone(),
                        identifier: identifier.clone(),
                        file,
                        start_line,
                        start_column,
                        end_line,
                        end_column,
                    };
                    if declarations.contains(&declaration) {
                        continue;
                    }
                    if declarations.len() == declaration_cap {
                        truncated = true;
                        break 'modules;
                    }
                    declarations.insert(declaration);
                }
            }
        }
    }
    (declarations.into_iter().collect(), truncated)
}

#[derive(Debug, PartialEq, Eq)]
struct PortDeclaration {
    module: String,
    line: usize,
    start_column: usize,
    end_column: usize,
    identifier: String,
    direction: PortDirection,
}

/// Locate port names on their declaration lines while taking direction from
/// the elaborated source netlist. Intersecting source tokens with real module
/// ports avoids mistaking widths, types, and parameters for signal names.
fn scan_port_declarations(
    source: &str,
    ports_by_module: &HashMap<String, HashMap<String, PortDirection>>,
) -> Vec<PortDeclaration> {
    let sanitized = sanitize_verilog(source);
    let mut declarations = Vec::new();
    let mut current_module: Option<String> = None;
    let mut in_header = false;
    let mut body_direction: Option<PortDirection> = None;

    for (line_index, line) in sanitized.lines().enumerate() {
        let token_spans = identifier_spans(line);
        let tokens = token_spans
            .iter()
            .map(|token| token.identifier.clone())
            .collect::<Vec<_>>();
        if let Some(module_index) = tokens.iter().position(|token| token == "module") {
            current_module = tokens[module_index + 1..]
                .iter()
                .find(|token| !matches!(token.as_str(), "automatic" | "static"))
                .cloned();
            in_header = current_module.is_some();
            body_direction = None;
        }
        if let Some(module) = current_module.as_ref()
            && let Some(ports) = ports_by_module.get(module)
        {
            if !in_header {
                body_direction = tokens
                    .iter()
                    .find_map(|token| match token.as_str() {
                        "input" => Some(PortDirection::Input),
                        "output" => Some(PortDirection::Output),
                        "inout" => Some(PortDirection::Inout),
                        _ => None,
                    })
                    .or(body_direction);
            }
            for token in &token_spans {
                let Some(direction) = ports.get(&token.identifier) else {
                    continue;
                };
                if in_header || body_direction == Some(*direction) {
                    declarations.push(PortDeclaration {
                        module: module.clone(),
                        line: line_index + 1,
                        start_column: token.start_column,
                        end_column: token.end_column,
                        identifier: token.identifier.clone(),
                        direction: *direction,
                    });
                }
            }
        }
        if line.contains(';') {
            if in_header {
                in_header = false;
            } else {
                body_direction = None;
            }
        }
        if tokens.iter().any(|token| token == "endmodule") {
            current_module = None;
            in_header = false;
            body_direction = None;
        }
    }
    declarations.sort_by(|left, right| {
        left.module
            .cmp(&right.module)
            .then_with(|| left.line.cmp(&right.line))
            .then_with(|| left.identifier.cmp(&right.identifier))
            .then_with(|| {
                port_direction_order(left.direction).cmp(&port_direction_order(right.direction))
            })
    });
    declarations.dedup();
    declarations
}

fn port_direction_order(direction: PortDirection) -> u8 {
    match direction {
        PortDirection::Input => 0,
        PortDirection::Output => 1,
        PortDirection::Inout => 2,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ContinuousAssignment {
    module: String,
    start_line: usize,
    start_column: usize,
    end_line: usize,
    end_column: usize,
    lhs_identifiers: Vec<String>,
}

/// A `<lhs> <=` or leading `<lhs> =` statement inside an `always` region.
/// Yosys attributes procedural cells to whole blocks; these parsed targets let
/// line probes narrow block attribution to the assigned signal.
#[derive(Debug, PartialEq, Eq)]
struct ProceduralAssignment {
    module: String,
    line: usize,
    start_column: usize,
    end_line: usize,
    end_column: usize,
    lhs_identifiers: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct ProceduralBlock {
    start_line: usize,
    end_line: usize,
}

#[derive(Debug)]
struct PendingProceduralBlock {
    start_line: usize,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ScannedAssignments {
    continuous: Vec<ContinuousAssignment>,
    procedural: Vec<ProceduralAssignment>,
    blocks: Vec<ProceduralBlock>,
}

fn scan_assignments(source: &str) -> ScannedAssignments {
    let sanitized = sanitize_verilog(source);
    let bytes = sanitized.as_bytes();
    let newlines: Vec<usize> = bytes
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (*byte == b'\n').then_some(index))
        .collect();
    let mut scanned = ScannedAssignments::default();
    let mut index = 0;
    let mut current_module: Option<String> = None;
    let mut nesting = 0usize;
    let mut in_always = false;
    let mut always_begin_depth = 0usize;
    let mut always_has_begin = false;
    let mut always_case_depth = 0usize;
    let mut always_if_depth = 0usize;
    let mut always_nested_begin_depth = 0usize;
    let mut current_block: Option<PendingProceduralBlock> = None;

    while index < bytes.len() {
        if !is_identifier_start(bytes[index]) {
            update_nesting(bytes[index], &mut nesting);
            index += 1;
            continue;
        }
        let token_start = index;
        index += 1;
        while index < bytes.len() && is_identifier_continue(bytes[index]) {
            index += 1;
        }
        let token = &sanitized[token_start..index];
        if token == "module" {
            let mut cursor = index;
            let mut module_name = None;
            while cursor < bytes.len() {
                if is_identifier_start(bytes[cursor]) {
                    let start = cursor;
                    cursor += 1;
                    while cursor < bytes.len() && is_identifier_continue(bytes[cursor]) {
                        cursor += 1;
                    }
                    let candidate = &sanitized[start..cursor];
                    if !matches!(candidate, "automatic" | "static") {
                        module_name = Some(candidate.to_owned());
                        break;
                    }
                } else {
                    update_nesting(bytes[cursor], &mut nesting);
                    cursor += 1;
                }
            }
            current_module = module_name;
            in_always = false;
            current_block = None;
            always_case_depth = 0;
            always_if_depth = 0;
            always_nested_begin_depth = 0;
            index = cursor;
            continue;
        }
        if token == "endmodule" {
            current_module = None;
            in_always = false;
            current_block = None;
            always_case_depth = 0;
            always_if_depth = 0;
            always_nested_begin_depth = 0;
            continue;
        }
        if matches!(
            token,
            "always" | "always_ff" | "always_comb" | "always_latch"
        ) {
            in_always = current_module.is_some();
            always_begin_depth = 0;
            always_has_begin = false;
            always_case_depth = 0;
            always_if_depth = 0;
            always_nested_begin_depth = 0;
            current_block = in_always.then(|| PendingProceduralBlock {
                start_line: line_at(token_start, &newlines),
            });
            continue;
        }
        if in_always && matches!(token, "case" | "casex" | "casez") {
            always_case_depth += 1;
            continue;
        }
        if in_always && token == "endcase" {
            always_case_depth = always_case_depth.saturating_sub(1);
            if !always_has_begin
                && always_case_depth == 0
                && always_if_depth == 0
                && always_nested_begin_depth == 0
            {
                in_always = false;
                always_if_depth = 0;
                if let Some(block) = current_block.take() {
                    scanned.blocks.push(ProceduralBlock {
                        start_line: block.start_line,
                        end_line: line_at(token_start, &newlines),
                    });
                }
            }
            continue;
        }
        if in_always && token == "if" && !always_has_begin && always_case_depth == 0 {
            always_if_depth += 1;
            continue;
        }
        if token == "begin" {
            if in_always {
                if always_has_begin {
                    always_begin_depth += 1;
                } else if always_case_depth == 0 && always_if_depth == 0 {
                    always_has_begin = true;
                    always_begin_depth = 1;
                } else {
                    always_nested_begin_depth += 1;
                }
            }
            continue;
        }
        if token == "end" {
            if in_always && always_has_begin {
                always_begin_depth = always_begin_depth.saturating_sub(1);
                if always_has_begin && always_begin_depth == 0 {
                    in_always = false;
                    if let Some(block) = current_block.take() {
                        scanned.blocks.push(ProceduralBlock {
                            start_line: block.start_line,
                            end_line: line_at(token_start, &newlines),
                        });
                    }
                }
            } else if in_always && always_nested_begin_depth > 0 {
                always_nested_begin_depth = always_nested_begin_depth.saturating_sub(1);
                if always_nested_begin_depth == 0 && always_case_depth == 0 {
                    let next = next_identifier(&sanitized, index);
                    if next.as_deref() != Some("else") {
                        always_if_depth = always_if_depth.saturating_sub(1);
                    }
                    if always_if_depth == 0 {
                        in_always = false;
                        if let Some(block) = current_block.take() {
                            scanned.blocks.push(ProceduralBlock {
                                start_line: block.start_line,
                                end_line: line_at(token_start, &newlines),
                            });
                        }
                    }
                }
            }
            continue;
        }
        let explicit_assign = token == "assign";
        let wire_alias = matches!(token, "wire" | "tri" | "wand" | "wor");
        if !explicit_assign && !wire_alias {
            if in_always && nesting == 0 && !is_statement_keyword(token) {
                let statement_end = bytes[index..]
                    .iter()
                    .position(|byte| *byte == b';')
                    .map_or(bytes.len(), |offset| index + offset);
                if always_case_depth > 0
                    && let Some(colon) = case_item_colon(&sanitized[token_start..statement_end])
                {
                    let after_colon = token_start + colon + 1;
                    advance_nesting(&bytes[index..after_colon], &mut nesting);
                    index = after_colon;
                    continue;
                }
                if let Some(lhs_identifiers) =
                    procedural_assignment_lhs(&sanitized[token_start..statement_end])
                {
                    scanned.procedural.push(ProceduralAssignment {
                        module: current_module
                            .clone()
                            .expect("always tracking requires a module"),
                        line: line_at(token_start, &newlines),
                        start_column: column_at(token_start, &newlines),
                        end_line: line_at(statement_end, &newlines),
                        end_column: column_at(statement_end, &newlines),
                        lhs_identifiers,
                    });
                    advance_nesting(&bytes[index..statement_end], &mut nesting);
                    index = statement_end.saturating_add(1);
                    if !always_has_begin {
                        if always_case_depth == 0
                            && always_nested_begin_depth == 0
                            && always_if_depth > 0
                        {
                            let next = next_identifier(&sanitized, statement_end + 1);
                            if next.as_deref() != Some("else") {
                                always_if_depth = always_if_depth.saturating_sub(1);
                            }
                        }
                        if always_case_depth == 0
                            && always_nested_begin_depth == 0
                            && always_if_depth == 0
                        {
                            in_always = false;
                            if let Some(block) = current_block.take() {
                                scanned.blocks.push(ProceduralBlock {
                                    start_line: block.start_line,
                                    end_line: line_at(statement_end, &newlines),
                                });
                            }
                        }
                    }
                }
            }
            continue;
        }
        let Some(module) = current_module.clone() else {
            continue;
        };

        let statement_end = bytes[index..]
            .iter()
            .position(|byte| *byte == b';')
            .map_or(bytes.len(), |offset| index + offset);
        let statement = &sanitized[index..statement_end];
        let mut lhs_identifiers = if wire_alias {
            initialized_declaration_lhs(statement)
        } else if let Some(equals) = statement.find('=') {
            assignment_lhs_identifiers(&statement[..equals])
        } else {
            Vec::new()
        };
        if explicit_assign {
            lhs_identifiers.sort();
            lhs_identifiers.dedup();
        }
        advance_nesting(&bytes[index..statement_end], &mut nesting);
        if lhs_identifiers.is_empty() {
            index = statement_end.saturating_add(1);
            continue;
        }
        let start_line = line_at(token_start, &newlines);
        let end_line = line_at(statement_end, &newlines);
        scanned.continuous.push(ContinuousAssignment {
            module,
            start_line,
            start_column: column_at(token_start, &newlines),
            end_line,
            end_column: column_at(statement_end, &newlines),
            lhs_identifiers,
        });
        index = statement_end.saturating_add(1);
    }
    scanned
}

/// Return the case-item separator in a fragment that starts at a possible case
/// label and extends through the first statement semicolon. Colons nested in a
/// select or concatenation are ignored. A colon after the fragment's only
/// assignment operator belongs to an RHS conditional expression instead.
fn case_item_colon(fragment: &str) -> Option<usize> {
    let bytes = fragment.as_bytes();
    let mut nesting = 0usize;
    let mut colon = None;
    let mut assignment_before_colon = false;
    let mut previous = 0u8;

    for (offset, byte) in bytes.iter().enumerate() {
        match byte {
            b'(' | b'[' | b'{' => nesting += 1,
            b')' | b']' | b'}' => nesting = nesting.saturating_sub(1),
            b':' if nesting == 0 && colon.is_none() => colon = Some(offset),
            // Only assignments *before* the first top-level colon matter: a real
            // case-item label is a constant expression and cannot contain one, so
            // a leading `=`/`<=` means this is an ordinary statement whose colon
            // belongs to a ternary RHS (`x = c ? a : b`), not a case separator.
            // An operator after the colon is irrelevant (and a relational `<=` in
            // a ternary else-branch must not be mistaken for a nonblocking one).
            b'<' if nesting == 0
                && colon.is_none()
                && previous != b'<'
                && bytes.get(offset + 1) == Some(&b'=') =>
            {
                assignment_before_colon = true;
            }
            b'=' if nesting == 0
                && colon.is_none()
                && !matches!(previous, b'=' | b'!' | b'<' | b'>')
                && bytes.get(offset + 1) != Some(&b'=') =>
            {
                assignment_before_colon = true;
            }
            _ => {}
        }
        previous = *byte;
    }

    colon.filter(|_| !assignment_before_colon)
}

/// Keywords that can open a procedural statement without being an assignment
/// LHS. Scanning past them prevents `if (rst) idx <= 0;` from attributing
/// condition identifiers to the assignment target set.
fn is_statement_keyword(token: &str) -> bool {
    matches!(
        token,
        "if" | "else"
            | "case"
            | "casex"
            | "casez"
            | "endcase"
            | "default"
            | "for"
            | "foreach"
            | "while"
            | "repeat"
            | "forever"
            | "do"
            | "unique"
            | "unique0"
            | "priority"
            | "posedge"
            | "negedge"
            | "edge"
            | "or"
            | "iff"
            | "fork"
            | "join"
            | "join_any"
            | "join_none"
            | "disable"
            | "wait"
            | "return"
            | "break"
            | "continue"
            | "assert"
            | "assume"
            | "cover"
            | "initial"
            | "final"
            | "function"
            | "endfunction"
            | "task"
            | "endtask"
            | "generate"
            | "endgenerate"
            | "localparam"
            | "parameter"
            | "genvar"
            | "typedef"
            | "reg"
            | "logic"
            | "integer"
            | "int"
            | "bit"
            | "byte"
            | "shortint"
            | "longint"
            | "real"
            | "realtime"
            | "time"
            | "signed"
            | "unsigned"
            | "var"
            | "automatic"
            | "static"
            | "const"
    )
}

/// LHS identifiers of an assignment statement, or `None` when the statement is
/// not an assignment. A top-level `=` (not a comparison) is a blocking
/// assignment and supports indexed or concatenated LHS forms; a top-level `<=`
/// marks a nonblocking assignment.
fn procedural_assignment_lhs(statement: &str) -> Option<Vec<String>> {
    let bytes = statement.as_bytes();
    let mut nesting = 0usize;
    let mut previous = 0u8;
    for (offset, byte) in bytes.iter().enumerate() {
        match byte {
            b'(' | b'[' | b'{' => nesting += 1,
            b')' | b']' | b'}' => nesting = nesting.saturating_sub(1),
            b'<' if nesting == 0 && previous != b'<' && bytes.get(offset + 1) == Some(&b'=') => {
                let lhs = assignment_lhs_identifiers(&statement[..offset]);
                return (!lhs.is_empty()).then_some(lhs);
            }
            b'=' if nesting == 0
                && !matches!(previous, b'=' | b'!' | b'<' | b'>')
                && bytes.get(offset + 1) != Some(&b'=') =>
            {
                let lhs = assignment_lhs_identifiers(&statement[..offset]);
                return (!lhs.is_empty()).then_some(lhs);
            }
            _ => {}
        }
        previous = *byte;
    }
    None
}

fn assignment_lhs_identifiers(lhs: &str) -> Vec<String> {
    let mut sanitized = lhs.as_bytes().to_vec();
    let mut bracket_depth = 0usize;
    for byte in &mut sanitized {
        match *byte {
            b'[' => {
                bracket_depth += 1;
                *byte = b' ';
            }
            b']' => {
                bracket_depth = bracket_depth.saturating_sub(1);
                *byte = b' ';
            }
            _ if bracket_depth > 0 => *byte = b' ',
            _ => {}
        }
    }
    let sanitized = std::str::from_utf8(&sanitized).expect("sanitized LHS remains UTF-8");
    let assignment_lhs = sanitized
        .rsplit_once(':')
        .map_or(sanitized, |(_, assignment_lhs)| assignment_lhs);
    identifiers(assignment_lhs)
}

fn update_nesting(byte: u8, nesting: &mut usize) {
    match byte {
        b'(' | b'[' | b'{' => *nesting += 1,
        b')' | b']' | b'}' => *nesting = nesting.saturating_sub(1),
        _ => {}
    }
}

fn advance_nesting(skipped: &[u8], nesting: &mut usize) {
    for byte in skipped {
        update_nesting(*byte, nesting);
    }
}

fn has_conditional_preprocessor(source: &str) -> bool {
    source.lines().any(|line| {
        matches!(
            line.split_whitespace().next(),
            Some("`ifdef" | "`ifndef" | "`elsif" | "`else")
        )
    })
}

fn line_at(offset: usize, newlines: &[usize]) -> usize {
    newlines.partition_point(|newline| *newline < offset) + 1
}

fn column_at(offset: usize, newlines: &[usize]) -> usize {
    let line_index = newlines.partition_point(|newline| *newline < offset);
    let line_start = line_index
        .checked_sub(1)
        .map_or(0, |previous| newlines[previous] + 1);
    offset - line_start + 1
}

fn next_identifier(source: &str, mut offset: usize) -> Option<String> {
    let bytes = source.as_bytes();
    while offset < bytes.len() && !is_identifier_start(bytes[offset]) {
        offset += 1;
    }
    let start = offset;
    while offset < bytes.len() && is_identifier_continue(bytes[offset]) {
        offset += 1;
    }
    (offset > start).then(|| source[start..offset].to_owned())
}

fn identifiers(fragment: &str) -> Vec<String> {
    identifier_spans(fragment)
        .into_iter()
        .map(|token| token.identifier)
        .collect()
}

struct IdentifierSpan {
    identifier: String,
    start_column: usize,
    end_column: usize,
}

fn identifier_spans(fragment: &str) -> Vec<IdentifierSpan> {
    let bytes = fragment.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\' {
            let start = index + 1;
            index = start;
            while index < bytes.len() && !bytes[index].is_ascii_whitespace() {
                index += 1;
            }
            if index > start {
                out.push(IdentifierSpan {
                    identifier: fragment[start..index].to_owned(),
                    start_column: start,
                    end_column: index,
                });
            }
            continue;
        }
        if !is_identifier_start(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        while index < bytes.len() && is_identifier_continue(bytes[index]) {
            index += 1;
        }
        out.push(IdentifierSpan {
            identifier: fragment[start..index].to_owned(),
            start_column: start + 1,
            end_column: index,
        });
    }
    out
}

fn initialized_declaration_lhs(statement: &str) -> Vec<String> {
    let bytes = statement.as_bytes();
    let mut starts = vec![0usize];
    let mut nesting = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b'(' | b'[' | b'{' => nesting += 1,
            b')' | b']' | b'}' => nesting = nesting.saturating_sub(1),
            b',' if nesting == 0 => starts.push(index + 1),
            _ => {}
        }
    }
    starts
        .iter()
        .enumerate()
        .filter_map(|(index, start)| {
            let end = starts
                .get(index + 1)
                .map_or(statement.len(), |next| next.saturating_sub(1));
            let declarator = &statement[*start..end];
            let equals = declarator.find('=')?;
            identifiers(&declarator[..equals]).into_iter().next_back()
        })
        .collect()
}

fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || matches!(byte, b'_' | b'$')
}

fn is_identifier_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$')
}

fn sanitize_verilog(source: &str) -> String {
    #[derive(Clone, Copy)]
    enum State {
        Code,
        LineComment,
        BlockComment,
        String,
    }

    let bytes = source.as_bytes();
    let mut out = bytes.to_vec();
    let mut state = State::Code;
    let mut index = 0;
    while index < bytes.len() {
        match state {
            State::Code if bytes[index..].starts_with(b"//") => {
                out[index] = b' ';
                if index + 1 < out.len() {
                    out[index + 1] = b' ';
                }
                state = State::LineComment;
                index += 2;
            }
            State::Code if bytes[index..].starts_with(b"/*") => {
                out[index] = b' ';
                if index + 1 < out.len() {
                    out[index + 1] = b' ';
                }
                state = State::BlockComment;
                index += 2;
            }
            State::Code if bytes[index] == b'"' => {
                out[index] = b' ';
                state = State::String;
                index += 1;
            }
            State::Code => index += 1,
            State::LineComment if bytes[index] == b'\n' => {
                state = State::Code;
                index += 1;
            }
            State::LineComment => {
                out[index] = b' ';
                index += 1;
            }
            State::BlockComment if bytes[index..].starts_with(b"*/") => {
                out[index] = b' ';
                if index + 1 < out.len() {
                    out[index + 1] = b' ';
                }
                state = State::Code;
                index += 2;
            }
            State::BlockComment => {
                if bytes[index] != b'\n' {
                    out[index] = b' ';
                }
                index += 1;
            }
            State::String if bytes[index] == b'\\' => {
                out[index] = b' ';
                if index + 1 < out.len() {
                    if bytes[index + 1] != b'\n' {
                        out[index + 1] = b' ';
                    }
                    index += 2;
                } else {
                    index += 1;
                }
            }
            State::String if bytes[index] == b'"' => {
                out[index] = b' ';
                state = State::Code;
                index += 1;
            }
            State::String => {
                if bytes[index] != b'\n' {
                    out[index] = b' ';
                }
                index += 1;
            }
        }
    }
    String::from_utf8(out).expect("sanitized Verilog remains UTF-8")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::{SourceSelectionOptions, SourceSelectionStatus};
    use crate::delay_model::DelayProfile;
    use crate::design::AnalysisDesign;
    use crate::netlist::{parse_str, parse_value, select_top};
    use crate::source::types::SourceSelectionRange;
    use serde_json::json;

    fn statement_start_column(source: &str, line: usize, token: &str) -> usize {
        source
            .lines()
            .nth(line - 1)
            .and_then(|text| text.find(token))
            .map(|column| column + 1)
            .expect("test statement token exists")
    }

    fn statement_end_column(source: &str, line: usize) -> usize {
        source
            .lines()
            .nth(line - 1)
            .and_then(|text| text.find(';'))
            .map(|column| column + 1)
            .expect("test statement terminator exists")
    }

    #[test]
    fn probe_hint_budget_rejects_overflow_without_exceeding_the_cap() {
        let hint = SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 1,
            start_column: Some(1),
            end_line: 1,
            end_column: Some(3),
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::Signal,
        };
        let mut hints = vec![hint.clone(); SOURCE_RANGE_ASSOCIATION_CAP];

        assert!(push_probe_hint(&mut hints, hint));
        assert_eq!(hints.len(), SOURCE_RANGE_ASSOCIATION_CAP);
    }

    #[test]
    fn bidirectional_probe_hints_are_retained_atomically() {
        let hint = SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 1,
            start_column: Some(1),
            end_line: 1,
            end_column: Some(3),
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::Signal,
        };
        let mut hints = vec![hint.clone(); SOURCE_RANGE_ASSOCIATION_CAP - 1];
        let pair = vec![
            hint.clone(),
            SourceProbeHint {
                direction: SourceProbeDirection::Fanout,
                ..hint
            },
        ];

        assert!(push_probe_hint_group(&mut hints, pair));
        assert_eq!(hints.len(), SOURCE_RANGE_ASSOCIATION_CAP - 1);
    }

    #[test]
    fn recovered_range_count_is_hard_capped() {
        let mut ranges = BTreeMap::new();
        let mut truncated = false;
        for line in 1..=SOURCE_RANGE_INDEX_CAP {
            assert!(
                bounded_range_entry(
                    &mut ranges,
                    ("top.sv".to_owned(), line, Some(1), line, Some(2)),
                    &mut truncated,
                )
                .is_some()
            );
        }
        assert!(
            bounded_range_entry(
                &mut ranges,
                (
                    "top.sv".to_owned(),
                    SOURCE_RANGE_INDEX_CAP + 1,
                    Some(1),
                    SOURCE_RANGE_INDEX_CAP + 1,
                    Some(2),
                ),
                &mut truncated,
            )
            .is_none()
        );

        assert_eq!(ranges.len(), SOURCE_RANGE_INDEX_CAP);
        assert!(truncated);
    }

    #[test]
    fn custom_typed_netname_declaration_recovers_bidirectional_graph_roots() {
        let netlist = parse_value(json!({
            "modules": {
                "top": {
                    "attributes": {"top": "1"},
                    "ports": {
                        "a": {"direction": "input", "bits": [2]},
                        "y": {"direction": "output", "bits": [3]}
                    },
                    "cells": {
                        "$not$top.sv:4$1": {
                            "type": "$not",
                            "port_directions": {"A": "input", "Y": "output"},
                            "connections": {"A": [2], "Y": [3]},
                            "attributes": {"src": "top.sv:4.21-4.23"}
                        }
                    },
                    "netnames": {
                        "a": {"bits": [2]},
                        "optimized_away": {
                            "bits": [4],
                            "attributes": {
                                "src": "top.sv:2.9-2.23",
                                "wiretype": "\\state_t"
                            }
                        },
                        "next_value": {
                            "bits": [3],
                            "attributes": {
                                "src": "top.sv:3.13-3.23",
                                "wiretype": "\\state_t"
                            }
                        },
                        "y": {"bits": [3]}
                    }
                }
            }
        }))
        .unwrap();
        let (top, module) = select_top(&netlist, None).unwrap();
        let graph = Graph::from_netlist(&netlist, top, module).unwrap();
        let source = r#"module top(input logic a, output logic y);
state_t optimized_away;
state_t next_value;
assign next_value = ~a;
assign y = next_value;
endmodule
"#;

        let provenance =
            recover_source_provenance(&graph, &netlist, [("top.sv".to_owned(), source.to_owned())]);
        let declaration = provenance
            .ranges
            .iter()
            .find(|range| range.file == "top.sv" && range.start_line == 3)
            .expect("internal declaration should have source provenance");

        assert!(!declaration.node_ids.is_empty());
        assert!(!declaration.mapping_incomplete);
        assert_eq!(
            provenance
                .probe_hints
                .iter()
                .filter(|hint| hint.file == "top.sv" && hint.start_line == 3)
                .map(|hint| hint.direction)
                .collect::<Vec<_>>(),
            vec![SourceProbeDirection::Fanin, SourceProbeDirection::Fanout]
        );

        let design = AnalysisDesign::from_netlists(
            &netlist,
            &netlist,
            vec![("top.sv".to_owned(), source.to_owned())],
            "gates",
            DelayProfile::Generic,
            false,
        )
        .unwrap();
        let selection = design
            .analysis
            .source_selection(
                &design.graph,
                &design.grouping,
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 3,
                    end_line: 3,
                    start_column: None,
                    end_column: None,
                },
                SourceSelectionOptions {
                    max_nodes: 400,
                    hide_control: true,
                    hide_const: true,
                    group_vectors: false,
                    group_memories: false,
                },
            )
            .unwrap();
        assert_eq!(selection.status, SourceSelectionStatus::Mapped);
        assert!(!selection.direct_ids.is_empty());
        assert_eq!(selection.graph.nodes.len(), 3);

        let optimized = design
            .analysis
            .source_selection(
                &design.graph,
                &design.grouping,
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 2,
                    end_line: 2,
                    start_column: None,
                    end_column: None,
                },
                SourceSelectionOptions {
                    max_nodes: 400,
                    hide_control: true,
                    hide_const: true,
                    group_vectors: false,
                    group_memories: false,
                },
            )
            .unwrap();
        assert_eq!(optimized.status, SourceSelectionStatus::OptimizedOrAbsorbed);
        assert!(optimized.direct_ids.is_empty());
    }

    #[test]
    fn same_line_declarations_select_distinct_signal_bits_by_column() {
        let netlist = parse_value(json!({
            "modules": {
                "top": {
                    "attributes": {"top": "1"},
                    "ports": {
                        "a": {"direction": "input", "bits": [2]},
                        "y": {"direction": "output", "bits": [3]},
                        "z": {"direction": "output", "bits": [5]}
                    },
                    "cells": {
                        "$not$next": {
                            "type": "$not",
                            "port_directions": {"A": "input", "Y": "output"},
                            "connections": {"A": [2], "Y": [3]},
                            "attributes": {"src": "top.sv:3.21-3.23"}
                        },
                        "$not$other": {
                            "type": "$not",
                            "port_directions": {"A": "input", "Y": "output"},
                            "connections": {"A": [2], "Y": [5]},
                            "attributes": {"src": "top.sv:3.46-3.48"}
                        }
                    },
                    "netnames": {
                        "a": {"bits": [2]},
                        "next_value": {
                            "bits": [3],
                            "attributes": {"src": "top.sv:2.7-2.16"}
                        },
                        "other_value": {
                            "bits": [5],
                            "attributes": {"src": "top.sv:2.25-2.35"}
                        },
                        "y": {"bits": [3]},
                        "z": {"bits": [5]}
                    }
                }
            }
        }))
        .unwrap();
        let source = "module top(input logic a, output logic y, output logic z);\nlogic next_value; logic other_value;\nassign next_value = ~a; assign other_value = ~a;\nassign y = next_value; assign z = other_value;\nendmodule\n";
        let (fixture_top, fixture_module) = select_top(&netlist, None).unwrap();
        let fixture_graph = Graph::from_netlist(&netlist, fixture_top, fixture_module).unwrap();
        let provenance = recover_source_provenance(
            &fixture_graph,
            &netlist,
            [("top.sv".to_owned(), source.to_owned())],
        );
        let declaration_hints = provenance
            .probe_hints
            .iter()
            .filter(|hint| hint.start_line == 2 && hint.kind == SourceProbeHintKind::Signal)
            .map(|hint| (hint.start_column, hint.end_column, hint.direction))
            .collect::<BTreeSet<_>>();
        assert_eq!(declaration_hints.len(), 4);
        let assignment_ranges = provenance
            .ranges
            .into_iter()
            .filter(|range| range.start_line == 3 && range.start_column.is_some())
            .collect::<Vec<_>>();
        assert_eq!(assignment_ranges.len(), 2);
        assert_ne!(assignment_ranges[0].node_ids, assignment_ranges[1].node_ids);
        let design = AnalysisDesign::from_netlists(
            &netlist,
            &netlist,
            vec![("top.sv".to_owned(), source.to_owned())],
            "gates",
            DelayProfile::Generic,
            false,
        )
        .unwrap();
        let select = |line, column| {
            design
                .analysis
                .source_selection(
                    &design.graph,
                    &design.grouping,
                    SourceSelectionRange {
                        file: "top.sv",
                        start_line: line,
                        end_line: line,
                        start_column: Some(column),
                        end_column: Some(column),
                    },
                    SourceSelectionOptions {
                        max_nodes: 400,
                        hide_control: true,
                        hide_const: true,
                        group_vectors: false,
                        group_memories: false,
                    },
                )
                .unwrap()
        };

        let next = select(2, 10);
        let other = select(2, 30);
        assert_eq!(next.status, SourceSelectionStatus::Mapped);
        assert_eq!(other.status, SourceSelectionStatus::Mapped);
        assert_eq!(next.direct_bits, vec![3]);
        assert_eq!(other.direct_bits, vec![5]);
        assert_ne!(next.direct_ids, other.direct_ids);
        assert!(next.graph.edges.iter().any(|edge| edge.bits.contains(&3)));
        assert!(other.graph.edges.iter().any(|edge| edge.bits.contains(&5)));
        let whitespace = select(2, 20);
        assert_eq!(whitespace.status, SourceSelectionStatus::Unmapped);
        assert!(whitespace.direct_ids.is_empty());
        assert!(whitespace.direct_bits.is_empty());

        let first_assign = select(3, statement_start_column(source, 3, "next_value"));
        let second_assign = select(3, statement_start_column(source, 3, "other_value"));
        assert_ne!(first_assign.direct_ids, second_assign.direct_ids);

        let output_y = select(1, statement_start_column(source, 1, "y"));
        let output_z = select(1, statement_start_column(source, 1, "z"));
        assert_ne!(output_y.direct_ids, output_z.direct_ids);
        assert!(
            output_y
                .graph
                .edges
                .iter()
                .any(|edge| edge.bits.contains(&3))
        );
        assert!(
            output_z
                .graph
                .edges
                .iter()
                .any(|edge| edge.bits.contains(&5))
        );

        let procedural_source = "module top(input logic a, output logic y, output logic z);\nlogic next_value; logic other_value;\nalways_comb begin next_value = ~a; other_value = ~a; end\nassign y = next_value; assign z = other_value;\nendmodule\n";
        let mut procedural_netlist = netlist.clone();
        for cell in procedural_netlist
            .modules
            .get_mut("top")
            .expect("fixture has top module")
            .cells
            .values_mut()
        {
            cell.attributes
                .insert("src".to_owned(), "top.sv:3.1-3.60".to_owned());
        }
        let (procedural_top, procedural_module) = select_top(&procedural_netlist, None).unwrap();
        let procedural_graph =
            Graph::from_netlist(&procedural_netlist, procedural_top, procedural_module).unwrap();
        let procedural_ranges = recover_source_provenance(
            &procedural_graph,
            &procedural_netlist,
            [("top.sv".to_owned(), procedural_source.to_owned())],
        )
        .ranges
        .into_iter()
        .filter(|range| range.start_line == 3 && range.start_column.is_some())
        .collect::<Vec<_>>();
        assert_eq!(procedural_ranges.len(), 2);
        assert_ne!(procedural_ranges[0].node_ids, procedural_ranges[1].node_ids);
        let procedural = AnalysisDesign::from_netlists(
            &procedural_netlist,
            &procedural_netlist,
            vec![("top.sv".to_owned(), procedural_source.to_owned())],
            "gates",
            DelayProfile::Generic,
            false,
        )
        .unwrap();
        let select_procedural = |token| {
            let column = statement_start_column(procedural_source, 3, token);
            procedural
                .analysis
                .source_selection(
                    &procedural.graph,
                    &procedural.grouping,
                    SourceSelectionRange {
                        file: "top.sv",
                        start_line: 3,
                        end_line: 3,
                        start_column: Some(column),
                        end_column: Some(column),
                    },
                    SourceSelectionOptions {
                        max_nodes: 400,
                        hide_control: true,
                        hide_const: true,
                        group_vectors: false,
                        group_memories: false,
                    },
                )
                .unwrap()
        };
        let procedural_next = select_procedural("next_value");
        let procedural_other = select_procedural("other_value");
        assert_ne!(procedural_next.direct_ids, procedural_other.direct_ids);
    }

    #[test]
    fn vhdl_wire_reverse_probe_uses_original_whole_line_provenance() {
        let source_netlist = parse_value(json!({
            "modules": {
                "top": {
                    "attributes": {"top": "1"},
                    "ports": {
                        "a": {"direction": "input", "bits": [2]},
                        "y": {"direction": "output", "bits": [3]}
                    },
                    "cells": {
                        "$not$generated": {
                            "type": "$not",
                            "port_directions": {"A": "input", "Y": "output"},
                            "connections": {"A": [2], "Y": [4]},
                            "attributes": {"src": "top.vhdl:5.3-5.13"}
                        },
                        "$abc$source_less_middle": {
                            "type": "$and",
                            "port_directions": {"A": "input", "B": "input", "Y": "output"},
                            "connections": {"A": [4], "B": [2], "Y": [5]},
                            "attributes": {}
                        },
                        "$abc$source_less_output": {
                            "type": "$not",
                            "port_directions": {"A": "input", "Y": "output"},
                            "connections": {"A": [5], "Y": [3]},
                            "attributes": {}
                        }
                    },
                    "netnames": {
                        "a": {
                            "bits": [2],
                            "attributes": {"src": "ghdl-top.v:2.11-2.12"}
                        },
                        "internal": {
                            "bits": [3],
                            "attributes": {"src": "ghdl-top.v:4.15-4.23"}
                        },
                        "y": {
                            "bits": [3],
                            "attributes": {"src": "ghdl-top.v:3.11-3.12"}
                        }
                    }
                }
            }
        }))
        .unwrap();
        let mut final_netlist = source_netlist.clone();
        for cell in final_netlist
            .modules
            .get_mut("top")
            .expect("fixture has top module")
            .cells
            .values_mut()
        {
            cell.attributes.clear();
        }
        let (top, module) = select_top(&final_netlist, None).unwrap();
        let graph = Graph::from_netlist(&final_netlist, top, module).unwrap();
        let source = "entity top is\nend entity;\narchitecture rtl of top is\nbegin\n  y <= not a;\nend architecture;\n";

        let provenance = recover_source_provenance(
            &graph,
            &source_netlist,
            [("top.vhdl".to_owned(), source.to_owned())],
        );
        let fallback = provenance
            .ranges
            .iter()
            .find(|range| range.file == "top.vhdl" && range.start_line == 5)
            .expect("the final wire bit should retain VHDL line provenance");
        assert_eq!(fallback.start_column, None);
        assert_eq!(fallback.end_column, None);
        assert!(fallback.signal_bits.is_empty());
        assert_eq!(fallback.approximate_signal_bits, vec![2, 3, 4, 5]);

        let design = AnalysisDesign::from_netlists(
            &final_netlist,
            &source_netlist,
            vec![("top.vhdl".to_owned(), source.to_owned())],
            "gates",
            DelayProfile::Generic,
            false,
        )
        .unwrap();
        let reverse = design.analysis.source_ranges_for_bits(&[5]);
        assert!(!reverse.truncated);
        assert_eq!(reverse.ranges.len(), 1);
        assert_eq!(reverse.ranges[0].file, "top.vhdl");
        assert_eq!(reverse.ranges[0].start_line, 5);
        assert_eq!(reverse.ranges[0].start_column, None);
        assert_eq!(reverse.ranges[0].end_column, None);
        assert!(reverse.approximate);
        assert!(!reverse.ranges[0].mapping_incomplete);

        let forward = design
            .analysis
            .source_selection(
                &design.graph,
                &design.grouping,
                SourceSelectionRange {
                    file: "top.vhdl",
                    start_line: 5,
                    end_line: 5,
                    start_column: Some(3),
                    end_column: Some(3),
                },
                SourceSelectionOptions {
                    max_nodes: 400,
                    hide_control: true,
                    hide_const: true,
                    group_vectors: false,
                    group_memories: false,
                },
            )
            .unwrap();
        assert!(forward.direct_bits.is_empty());
        assert_ne!(forward.status, SourceSelectionStatus::MappingIncomplete);
    }

    #[test]
    fn finds_multiline_and_concatenated_continuous_assignments_only() {
        let source = r#"
module top;
// assign ignored = comment;
assign {valid, data[0]} =
    {ready, payload};
wire alias = ready, alias2 = {payload, ready};
initial $display("assign hidden = in string;");
endmodule

module unused;
assign valid = 1'b0;
endmodule
"#;
        assert_eq!(
            scan_assignments(source).continuous,
            vec![
                ContinuousAssignment {
                    module: "top".to_owned(),
                    start_line: 4,
                    start_column: statement_start_column(source, 4, "assign"),
                    end_line: 5,
                    end_column: statement_end_column(source, 5),
                    lhs_identifiers: vec!["data".to_owned(), "valid".to_owned()],
                },
                ContinuousAssignment {
                    module: "top".to_owned(),
                    start_line: 6,
                    start_column: statement_start_column(source, 6, "wire"),
                    end_line: 6,
                    end_column: statement_end_column(source, 6),
                    lhs_identifiers: vec!["alias".to_owned(), "alias2".to_owned()],
                },
                ContinuousAssignment {
                    module: "unused".to_owned(),
                    start_line: 11,
                    start_column: statement_start_column(source, 11, "assign"),
                    end_line: 11,
                    end_column: statement_end_column(source, 11),
                    lhs_identifiers: vec!["valid".to_owned()],
                },
            ]
        );
    }

    #[test]
    fn continuous_assignment_selects_only_record_assigned_objects() {
        let source = r#"
module top;
assign partial_sum[i + 1] = partial_sum[i] + value;
assign y[3:0] = x;
assign {a, b} = pair;
endmodule
"#;

        assert_eq!(
            scan_assignments(source).continuous,
            vec![
                ContinuousAssignment {
                    module: "top".to_owned(),
                    start_line: 3,
                    start_column: statement_start_column(source, 3, "assign"),
                    end_line: 3,
                    end_column: statement_end_column(source, 3),
                    lhs_identifiers: vec!["partial_sum".to_owned()],
                },
                ContinuousAssignment {
                    module: "top".to_owned(),
                    start_line: 4,
                    start_column: statement_start_column(source, 4, "assign"),
                    end_line: 4,
                    end_column: statement_end_column(source, 4),
                    lhs_identifiers: vec!["y".to_owned()],
                },
                ContinuousAssignment {
                    module: "top".to_owned(),
                    start_line: 5,
                    start_column: statement_start_column(source, 5, "assign"),
                    end_line: 5,
                    end_column: statement_end_column(source, 5),
                    lhs_identifiers: vec!["a".to_owned(), "b".to_owned()],
                },
            ]
        );
    }

    #[test]
    fn procedural_assignments_record_targets_per_statement_line() {
        let source = r#"
module top (input logic clk, input logic rst);
always_ff @(posedge clk) begin
  if (rst) begin
    idx <= 5'd0;
    valid <= 1'b0;
  end else begin
    idx <= idx_c;
  end
end
always_comb begin
  idx_c = 5'd0;
  if (req <= limit)
    idx_c = idx + 1;
  data[idx] = payload;
end
always @(posedge clk) q <= d;
endmodule
"#;
        assert_eq!(
            scan_assignments(source).procedural,
            vec![
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 5,
                    start_column: statement_start_column(source, 5, "idx"),
                    end_line: 5,
                    end_column: statement_end_column(source, 5),
                    lhs_identifiers: vec!["idx".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 6,
                    start_column: statement_start_column(source, 6, "valid"),
                    end_line: 6,
                    end_column: statement_end_column(source, 6),
                    lhs_identifiers: vec!["valid".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 8,
                    start_column: statement_start_column(source, 8, "idx"),
                    end_line: 8,
                    end_column: statement_end_column(source, 8),
                    lhs_identifiers: vec!["idx".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 12,
                    start_column: statement_start_column(source, 12, "idx_c"),
                    end_line: 12,
                    end_column: statement_end_column(source, 12),
                    lhs_identifiers: vec!["idx_c".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 14,
                    start_column: statement_start_column(source, 14, "idx_c"),
                    end_line: 14,
                    end_column: statement_end_column(source, 14),
                    lhs_identifiers: vec!["idx_c".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 15,
                    start_column: statement_start_column(source, 15, "data"),
                    end_line: 15,
                    end_column: statement_end_column(source, 15),
                    lhs_identifiers: vec!["data".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 17,
                    start_column: statement_start_column(source, 17, "q"),
                    end_line: 17,
                    end_column: statement_end_column(source, 17),
                    lhs_identifiers: vec!["q".to_owned()],
                },
            ]
        );
        assert_eq!(
            scan_assignments(source).blocks,
            vec![
                ProceduralBlock {
                    start_line: 3,
                    end_line: 10,
                },
                ProceduralBlock {
                    start_line: 11,
                    end_line: 16,
                },
                ProceduralBlock {
                    start_line: 17,
                    end_line: 17,
                },
            ]
        );
    }

    #[test]
    fn multiline_procedural_assignment_preserves_its_complete_span() {
        let source = r#"
module top;
always_comb begin
  first =
    a;
end
endmodule
"#;

        assert_eq!(
            scan_assignments(source).procedural,
            vec![ProceduralAssignment {
                module: "top".to_owned(),
                line: 4,
                start_column: statement_start_column(source, 4, "first"),
                end_line: 5,
                end_column: statement_end_column(source, 5),
                lhs_identifiers: vec!["first".to_owned()],
            }]
        );
    }

    #[test]
    fn beginless_case_and_if_blocks_keep_all_assignment_lines() {
        let source = r#"
module top;
always @* case (sel)
  1'b0: y = a;
  default: z = b;
endcase
always @* if (sel)
  y = a;
else
  z = b;
always_comb if (sel) begin
  y = a;
  z = b;
end else begin
  y = b;
  z = a;
end
always_comb if (sel) begin
  case (kind)
    1'b0: y = a;
    default: y = b;
  endcase
  z = a;
end else begin
  y = b;
  z = b;
end
endmodule
"#;
        let scanned = scan_assignments(source);
        assert_eq!(
            scanned
                .procedural
                .iter()
                .map(|assignment| (assignment.line, assignment.lhs_identifiers.clone()))
                .collect::<Vec<_>>(),
            vec![
                (4, vec!["y".to_owned()]),
                (5, vec!["z".to_owned()]),
                (8, vec!["y".to_owned()]),
                (10, vec!["z".to_owned()]),
                (12, vec!["y".to_owned()]),
                (13, vec!["z".to_owned()]),
                (15, vec!["y".to_owned()]),
                (16, vec!["z".to_owned()]),
                (20, vec!["y".to_owned()]),
                (21, vec!["y".to_owned()]),
                (23, vec!["z".to_owned()]),
                (25, vec!["y".to_owned()]),
                (26, vec!["z".to_owned()]),
            ]
        );
        assert_eq!(
            scanned.blocks,
            vec![
                ProceduralBlock {
                    start_line: 3,
                    end_line: 6,
                },
                ProceduralBlock {
                    start_line: 7,
                    end_line: 10,
                },
                ProceduralBlock {
                    start_line: 11,
                    end_line: 17,
                },
                ProceduralBlock {
                    start_line: 18,
                    end_line: 27,
                },
            ]
        );
    }

    #[test]
    fn multiline_case_item_begin_uses_the_assignment_line_and_target() {
        let source = r#"
module top;
always_comb begin
  case (state)
    IDLE: begin
      busy = 1'b0;
    end
  endcase
end
endmodule
"#;

        assert_eq!(
            scan_assignments(source).procedural,
            vec![ProceduralAssignment {
                module: "top".to_owned(),
                line: 6,
                start_column: statement_start_column(source, 6, "busy"),
                end_line: 6,
                end_column: statement_end_column(source, 6),
                lhs_identifiers: vec!["busy".to_owned()],
            }]
        );
    }

    #[test]
    fn ternary_rhs_with_relational_in_a_case_arm_records_the_real_target() {
        // The `: b <= d` false-branch must not be mistaken for a case-item
        // label separator: the statement assigns `x`, not `b`.
        let source = r#"
module top;
always_comb begin
  case (sel)
    2'd0: x = c ? a : b <= d;
  endcase
end
endmodule
"#;

        assert_eq!(
            scan_assignments(source).procedural,
            vec![ProceduralAssignment {
                module: "top".to_owned(),
                line: 5,
                start_column: statement_start_column(source, 5, "x"),
                end_line: 5,
                end_column: statement_end_column(source, 5),
                lhs_identifiers: vec!["x".to_owned()],
            }]
        );
    }

    #[test]
    fn case_arms_and_post_endcase_assignment_fill_the_whole_always_block() {
        let source = r#"
module top;
always_comb begin
  case (state)
    IDLE: begin first = 1'b0; end
    ACTIVE: begin
      later = 1'b1;
    end
    default: fallback = 1'b0;
  endcase
  after_case = later;
end
endmodule
"#;
        let scanned = scan_assignments(source);

        assert_eq!(
            scanned.procedural,
            vec![
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 5,
                    start_column: statement_start_column(source, 5, "first"),
                    end_line: 5,
                    end_column: statement_end_column(source, 5),
                    lhs_identifiers: vec!["first".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 7,
                    start_column: statement_start_column(source, 7, "later"),
                    end_line: 7,
                    end_column: statement_end_column(source, 7),
                    lhs_identifiers: vec!["later".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 9,
                    start_column: statement_start_column(source, 9, "fallback"),
                    end_line: 9,
                    end_column: statement_end_column(source, 9),
                    lhs_identifiers: vec!["fallback".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 11,
                    start_column: statement_start_column(source, 11, "after_case"),
                    end_line: 11,
                    end_column: statement_end_column(source, 11),
                    lhs_identifiers: vec!["after_case".to_owned()],
                },
            ]
        );
        assert_eq!(
            scanned.blocks,
            vec![ProceduralBlock {
                start_line: 3,
                end_line: 12,
            }]
        );
    }

    #[test]
    fn example_case_scans_cover_every_arm_and_the_full_always_block() {
        let adder = scan_assignments(include_str!(
            "../../../web/src/data/examples/adder_chain.sv"
        ));
        assert!(adder.continuous.iter().any(|assignment| {
            assignment.start_line == 16 && assignment.lhs_identifiers == ["partial_sum"]
        }));
        let fifo = scan_assignments(include_str!("../../../web/src/data/examples/fifo_pipe.sv"));
        for line in [24, 27] {
            assert!(fifo.continuous.iter().any(|assignment| {
                assignment.start_line == line && assignment.lhs_identifiers == ["ready"]
            }));
        }

        let handshake = scan_assignments(include_str!(
            "../../../web/src/data/examples/handshake_controller.sv"
        ));
        assert!(handshake.blocks.contains(&ProceduralBlock {
            start_line: 31,
            end_line: 62,
        }));
        assert!(
            !handshake
                .procedural
                .iter()
                .any(|assignment| assignment.line == 40)
        );
        assert_eq!(
            handshake
                .procedural
                .iter()
                .filter(|assignment| assignment.line == 41)
                .map(|assignment| assignment.lhs_identifiers.as_slice())
                .collect::<Vec<_>>(),
            vec![["busy"].as_slice()]
        );
        for (line, target) in [
            (46, "request_valid"),
            (48, "next_state"),
            (51, "response_ready"),
            (53, "done"),
            (54, "next_state"),
            (56, "timed_out"),
            (57, "next_state"),
            (60, "next_state"),
        ] {
            assert!(handshake.procedural.iter().any(|assignment| {
                assignment.line == line && assignment.lhs_identifiers == [target]
            }));
        }

        let priority = scan_assignments(include_str!(
            "../../../web/src/data/examples/priority_encoder_case.sv"
        ));
        assert_eq!(
            priority.blocks,
            vec![ProceduralBlock {
                start_line: 15,
                end_line: 59,
            }]
        );
        for line in 23..=54 {
            assert_eq!(
                priority
                    .procedural
                    .iter()
                    .filter(|assignment| assignment.line == line)
                    .map(|assignment| assignment.lhs_identifiers.as_slice())
                    .collect::<Vec<_>>(),
                vec![["one_hot_padded"].as_slice(), ["index"].as_slice()]
            );
        }
        assert!(priority.procedural.iter().any(|assignment| {
            assignment.line == 55 && assignment.lhs_identifiers == ["valid"]
        }));
        assert!(priority.procedural.iter().any(|assignment| {
            assignment.line == 58 && assignment.lhs_identifiers == ["one_hot"]
        }));
    }

    #[test]
    fn conditional_sources_use_only_yosys_provenance() {
        assert!(has_conditional_preprocessor(
            "`ifdef FEATURE\nassign y = a;\n`endif"
        ));
    }

    #[test]
    fn preflatten_module_graph_recovers_only_reachable_instance_scopes() {
        let netlist =
            parse_str(include_str!("../../tests/fixtures/preflatten_scopes.json")).unwrap();

        let scopes = module_scopes(&netlist, "scoped_children");

        assert_eq!(scopes.source["scoped_children"], [""]);
        assert_eq!(scopes.source["leaf"], ["u_leaf", "u_wrapper.inner_leaf"]);
        assert_eq!(scopes.source["other"], ["u_other"]);
        assert_eq!(scopes.source["parameter_leaf"], ["u_parameter"]);
        assert_eq!(scopes.source["wrapper"], ["u_wrapper"]);
        assert!(
            !scopes
                .source
                .keys()
                .any(|name| name.starts_with("$paramod"))
        );
        assert!(!scopes.source.contains_key("unused"));
        assert_eq!(
            scopes.elaborated["$paramod\\parameter_leaf\\INVERT=1"],
            ["u_parameter"]
        );
        assert!(!scopes.elaborated.contains_key("unused"));
    }

    #[test]
    fn netname_declarations_are_reachable_bounded_and_variant_exact() {
        let netlist = parse_value(json!({
            "modules": {
                "top": {
                    "attributes": {"top": "1"},
                    "cells": {
                        "u_zero": {"type": "$paramod\\leaf\\P=0"},
                        "u_one": {"type": "$paramod\\leaf\\P=1"}
                    }
                },
                "$paramod\\leaf\\P=0": {
                    "attributes": {"hdlname": "leaf"},
                    "netnames": {
                        "extra": {
                            "bits": [3],
                            "attributes": {"src": "leaf.sv:2.7-2.12"}
                        },
                        "state": {
                            "bits": [4],
                            "attributes": {"src": "leaf.sv:3.7-3.12"}
                        }
                    }
                },
                "$paramod\\leaf\\P=1": {
                    "attributes": {"hdlname": "leaf"},
                    "netnames": {
                        "state": {
                            "bits": [5],
                            "attributes": {"src": "leaf.sv:8.7-8.12"}
                        }
                    }
                },
                "unused": {
                    "netnames": {
                        "ignored": {
                            "bits": [6],
                            "attributes": {"src": "leaf.sv:20.7-20.14"}
                        }
                    }
                }
            }
        }))
        .unwrap();
        let scopes = module_scopes(&netlist, "top");
        let design_files = HashSet::from(["leaf.sv".to_owned()]);

        let (all, truncated) =
            netname_declarations(&netlist, &design_files, &scopes.elaborated, 10);
        assert!(!truncated);
        assert_eq!(
            all.iter()
                .map(|declaration| (
                    declaration.module.as_str(),
                    declaration.identifier.as_str(),
                    declaration.start_line,
                ))
                .collect::<Vec<_>>(),
            vec![
                ("$paramod\\leaf\\P=0", "extra", 2),
                ("$paramod\\leaf\\P=0", "state", 3),
                ("$paramod\\leaf\\P=1", "state", 8),
            ]
        );

        let (bounded, truncated) =
            netname_declarations(&netlist, &design_files, &scopes.elaborated, 2);
        assert!(truncated);
        assert_eq!(bounded, all[..2]);
    }

    #[test]
    fn source_root_sets_keep_a_deterministic_cap_sentinel() {
        let mut roots = BTreeSet::new();
        for id in (0..(SOURCE_ROOT_COLLECTION_CAP as NodeId + 500)).rev() {
            insert_bounded_root(&mut roots, id);
        }

        assert_eq!(roots.len(), SOURCE_ROOT_COLLECTION_CAP);
        assert_eq!(roots.first(), Some(&0));
        assert_eq!(
            roots.last(),
            Some(&(SOURCE_ROOT_COLLECTION_CAP as NodeId - 1))
        );
    }

    #[test]
    fn million_line_assignment_is_one_sparse_provenance_interval() {
        let netlist = parse_value(json!({
            "modules": {
                "top": {
                    "attributes": {"top": "1"},
                    "ports": {
                        "a": {"direction": "input", "bits": [2]},
                        "y": {"direction": "output", "bits": [2]}
                    },
                    "netnames": {
                        "a": {"bits": [2]},
                        "y": {"bits": [2]}
                    }
                }
            }
        }))
        .unwrap();
        let (top, module) = select_top(&netlist, None).unwrap();
        let graph = Graph::from_netlist(&netlist, top, module).unwrap();
        let source = format!(
            "module top(input a, output y);\nassign y =\n{}a;\nendmodule\n",
            "\n".repeat(1_000_000)
        );

        let provenance =
            recover_source_provenance(&graph, &netlist, [("sparse.sv".to_owned(), source)]);

        assert!(!provenance.truncated);
        let assignment_ranges: Vec<_> = provenance
            .ranges
            .iter()
            .filter(|range| range.start_line == 2)
            .collect();
        assert_eq!(assignment_ranges.len(), 1);
        let range = assignment_ranges[0];
        assert_eq!(range.file, "sparse.sv");
        assert_eq!(range.start_line, 2);
        assert_eq!(range.end_line, 1_000_003);
        assert!(!range.node_ids.is_empty());
        assert!(!range.mapping_incomplete);
    }

    #[test]
    fn recovered_associations_have_one_global_budget_and_mark_partial_ranges() {
        let mut ranges = Vec::new();
        let mut association_count = 0;
        for range_index in 0..11 {
            let mut range = RangeProvenance::default();
            let first = range_index * SOURCE_ROOT_COLLECTION_CAP;
            merge_range_roots(
                &mut range,
                (first..first + SOURCE_ROOT_COLLECTION_CAP).map(|id| id as NodeId),
                false,
                &mut association_count,
            );
            ranges.push(range);
        }

        assert_eq!(association_count, SOURCE_RANGE_ASSOCIATION_CAP);
        assert_eq!(
            ranges.iter().map(|range| range.roots.len()).sum::<usize>(),
            SOURCE_RANGE_ASSOCIATION_CAP
        );
        assert!(ranges[..9].iter().all(|range| !range.mapping_incomplete));
        assert!(ranges[9].mapping_incomplete);
        assert!(ranges[10].mapping_incomplete);
    }

    #[test]
    fn wire_signal_associations_are_bounded_and_mark_partial_ranges() {
        let mut range = RangeProvenance::default();
        let mut association_count = 0;

        let truncated = merge_range_signal_bits(
            &mut range,
            0..=(SOURCE_ROOT_COLLECTION_CAP as u32),
            &mut association_count,
        );

        assert!(truncated);
        assert!(range.mapping_incomplete);
        assert_eq!(range.signal_bits.len(), SOURCE_ROOT_COLLECTION_CAP);
        assert_eq!(association_count, SOURCE_ROOT_COLLECTION_CAP);
    }
}
