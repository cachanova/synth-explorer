use crate::analysis::{
    SOURCE_RANGE_ASSOCIATION_CAP, SOURCE_ROOT_COLLECTION_CAP, SourceProbeDirection,
    SourceProbeHint, SourceProbeHintKind, SourceRangeMapping,
};
use crate::graph::{Graph, NodeId, NodeKind, strip_bit_suffix};
use crate::netlist::{PortDirection, YosysNetlist};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

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
    mapping_incomplete: bool,
}

#[derive(Debug, Default)]
struct SignalRootIndex {
    fanin: HashMap<String, Vec<NodeId>>,
    fanout: HashMap<String, Vec<NodeId>>,
    fanin_incomplete: HashSet<String>,
    fanout_incomplete: HashSet<String>,
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

/// Recover source provenance and directional probe intent that Yosys JSON
/// cannot retain for assignments and declarations. Cell-producing expressions
/// continue to use Yosys `src`; this supplement resolves source signal names in
/// the selected top's live elaborated hierarchy through exact flattened scope
/// names, final net aliases, and graph incidence. Files containing conditional
/// preprocessor branches are skipped rather than risking a false mapping from
/// inactive source.
pub(crate) fn recover_source_provenance(
    graph: &Graph,
    source_netlist: &YosysNetlist,
    files: impl IntoIterator<Item = (String, String)>,
) -> SourceProvenance {
    let roots_by_name = roots_by_signal_name(graph);
    let scopes_by_module = scopes_by_module(source_netlist, &graph.top);
    let mut ranges: BTreeMap<(String, usize, usize), RangeProvenance> = BTreeMap::new();
    let mut association_count = 0usize;
    let mut procedural: BTreeMap<(String, usize), BTreeSet<NodeId>> = BTreeMap::new();
    let mut unusable_lines: HashSet<(String, usize)> = HashSet::new();
    let mut target_count = 0usize;
    let mut probe_hints = Vec::new();
    let ports_by_module = ports_by_source_module(source_netlist);

    for (file, source) in files {
        if has_conditional_preprocessor(&source) {
            continue;
        }
        let scanned = scan_assignments(&source);
        for assignment in scanned.continuous {
            let Some(scopes) = scopes_by_module.get(&assignment.module) else {
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
            if !roots.is_empty() && probe_hints.len() < SOURCE_RANGE_ASSOCIATION_CAP {
                probe_hints.push(SourceProbeHint {
                    file: file.clone(),
                    start_line: assignment.start_line,
                    end_line: assignment.end_line,
                    direction: SourceProbeDirection::Fanin,
                    kind: SourceProbeHintKind::Signal,
                });
            }
            let range = ranges
                .entry((file.clone(), assignment.start_line, assignment.end_line))
                .or_default();
            merge_range_roots(range, roots, mapping_incomplete, &mut association_count);
        }
        for declaration in scan_port_declarations(&source, &ports_by_module) {
            let Some(scopes) = scopes_by_module.get(&declaration.module) else {
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
            if !roots.is_empty() && probe_hints.len() < SOURCE_RANGE_ASSOCIATION_CAP {
                for direction in directions {
                    probe_hints.push(SourceProbeHint {
                        file: file.clone(),
                        start_line: declaration.line,
                        end_line: declaration.line,
                        direction: *direction,
                        kind: SourceProbeHintKind::Signal,
                    });
                }
            }
            let range = ranges
                .entry((file.clone(), declaration.line, declaration.line))
                .or_default();
            merge_range_roots(range, roots, mapping_incomplete, &mut association_count);
        }
        for assignment in &scanned.procedural {
            let Some(scopes) = scopes_by_module.get(&assignment.module) else {
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
            if procedural.contains_key(&key)
                && !unusable_lines.contains(&key)
                && probe_hints.len() < SOURCE_RANGE_ASSOCIATION_CAP
            {
                probe_hints.push(SourceProbeHint {
                    file: file.clone(),
                    start_line: assignment.line,
                    end_line: assignment.line,
                    direction: SourceProbeDirection::Fanin,
                    kind: SourceProbeHintKind::Procedural,
                });
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
            if has_resolved_target
                && !has_unusable_target
                && probe_hints.len() < SOURCE_RANGE_ASSOCIATION_CAP
            {
                probe_hints.push(SourceProbeHint {
                    file: file.clone(),
                    start_line: block.start_line,
                    end_line: block.end_line,
                    direction: SourceProbeDirection::Fanin,
                    kind: SourceProbeHintKind::Block,
                });
            }
        }
    }

    let ranges = ranges
        .into_iter()
        .map(|((file, start_line, end_line), range)| SourceRangeMapping {
            file,
            start_line,
            end_line,
            node_ids: range.roots.into_iter().collect(),
            mapping_incomplete: range.mapping_incomplete,
        })
        .collect::<Vec<_>>();
    let truncated = ranges.iter().any(|range| range.mapping_incomplete);
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

fn scopes_by_module(
    source_netlist: &YosysNetlist,
    selected_top: &str,
) -> HashMap<String, Vec<String>> {
    let mut scopes = HashMap::<String, Vec<String>>::new();
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
            .entry(source_module_name)
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
    for prefixes in scopes.values_mut() {
        prefixes.sort();
        prefixes.dedup();
    }
    scopes
}

fn roots_by_signal_name(graph: &Graph) -> SignalRootIndex {
    let mut fanin: HashMap<String, BTreeSet<NodeId>> = HashMap::new();
    let mut fanout: HashMap<String, BTreeSet<NodeId>> = HashMap::new();
    let mut fanin_incomplete = HashSet::new();
    let mut fanout_incomplete = HashSet::new();
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

#[derive(Debug, PartialEq, Eq)]
struct PortDeclaration {
    module: String,
    line: usize,
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
        let tokens = identifiers(line);
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
            for token in &tokens {
                let Some(direction) = ports.get(token) else {
                    continue;
                };
                if in_header || body_direction == Some(*direction) {
                    declarations.push(PortDeclaration {
                        module: module.clone(),
                        line: line_index + 1,
                        identifier: token.clone(),
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
    end_line: usize,
    lhs_identifiers: Vec<String>,
}

/// A `<lhs> <=` or leading `<lhs> =` statement inside an `always` region.
/// Yosys attributes procedural cells to whole blocks; these parsed targets let
/// line probes narrow block attribution to the assigned signal.
#[derive(Debug, PartialEq, Eq)]
struct ProceduralAssignment {
    module: String,
    line: usize,
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
                if let Some(lhs_identifiers) =
                    procedural_assignment_lhs(&sanitized[token_start..statement_end])
                {
                    scanned.procedural.push(ProceduralAssignment {
                        module: current_module
                            .clone()
                            .expect("always tracking requires a module"),
                        line: line_at(token_start, &newlines),
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
            identifiers(&statement[..equals])
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
            end_line,
            lhs_identifiers,
        });
        index = statement_end.saturating_add(1);
    }
    scanned
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
                out.push(fragment[start..index].to_owned());
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
        out.push(fragment[start..index].to_owned());
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
    use crate::netlist::{parse_str, parse_value, select_top};
    use serde_json::json;

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
                    end_line: 5,
                    lhs_identifiers: vec!["data".to_owned(), "valid".to_owned()],
                },
                ContinuousAssignment {
                    module: "top".to_owned(),
                    start_line: 6,
                    end_line: 6,
                    lhs_identifiers: vec!["alias".to_owned(), "alias2".to_owned()],
                },
                ContinuousAssignment {
                    module: "unused".to_owned(),
                    start_line: 11,
                    end_line: 11,
                    lhs_identifiers: vec!["valid".to_owned()],
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
                    lhs_identifiers: vec!["idx".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 6,
                    lhs_identifiers: vec!["valid".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 8,
                    lhs_identifiers: vec!["idx".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 12,
                    lhs_identifiers: vec!["idx_c".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 14,
                    lhs_identifiers: vec!["idx_c".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 15,
                    lhs_identifiers: vec!["data".to_owned()],
                },
                ProceduralAssignment {
                    module: "top".to_owned(),
                    line: 17,
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
    fn conditional_sources_use_only_yosys_provenance() {
        assert!(has_conditional_preprocessor(
            "`ifdef FEATURE\nassign y = a;\n`endif"
        ));
    }

    #[test]
    fn preflatten_module_graph_recovers_only_reachable_instance_scopes() {
        let netlist = parse_str(include_str!("../tests/fixtures/preflatten_scopes.json")).unwrap();

        let scopes = scopes_by_module(&netlist, "scoped_children");

        assert_eq!(scopes["scoped_children"], [""]);
        assert_eq!(scopes["leaf"], ["u_leaf", "u_wrapper.inner_leaf"]);
        assert_eq!(scopes["other"], ["u_other"]);
        assert_eq!(scopes["parameter_leaf"], ["u_parameter"]);
        assert_eq!(scopes["wrapper"], ["u_wrapper"]);
        assert!(!scopes.keys().any(|name| name.starts_with("$paramod")));
        assert!(!scopes.contains_key("unused"));
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
}
