use crate::analysis::{
    SOURCE_RANGE_ASSOCIATION_CAP, SOURCE_ROOT_COLLECTION_CAP, SourceProbeDirection,
    SourceProbeHint, SourceProbeHintKind, SourceRangeMapping,
};
use crate::graph::{Graph, NodeId, NodeKind, strip_bit_suffix};
use crate::netlist::{PortDirection, YosysNetlist};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use sv_parser::{RefNode, SyntaxTree, parse_sv_str};

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
        let Some(ScannedSource {
            assignments: scanned,
            ports: declarations,
        }) = scan_source(&source, &ports_by_module)
        else {
            continue;
        };
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
        for declaration in declarations {
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
                        kind: if declaration.direction == PortDirection::Output {
                            SourceProbeHintKind::OutputPort
                        } else {
                            SourceProbeHintKind::Signal
                        },
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

#[derive(Debug, Default, PartialEq, Eq)]
struct ScannedAssignments {
    continuous: Vec<ContinuousAssignment>,
    procedural: Vec<ProceduralAssignment>,
    blocks: Vec<ProceduralBlock>,
}

fn has_conditional_preprocessor(source: &str) -> bool {
    source.lines().any(|line| {
        matches!(
            line.split_whitespace().next(),
            Some("`ifdef" | "`ifndef" | "`elsif" | "`else")
        )
    })
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ScannedSource {
    assignments: ScannedAssignments,
    ports: Vec<PortDeclaration>,
}

struct SourceLineMap {
    newline_offsets: Vec<usize>,
}

type IdentifierRepairs = HashMap<String, String>;

/// Yosys accepts `alias` as an identifier even though IEEE SystemVerilog
/// reserves it as a keyword. sv-parser correctly rejects the bare spelling, so
/// after an ordinary parse failure, retry with bare `alias` tokens replaced by
/// same-width identifiers. Equal byte widths keep every origin offset valid;
/// extracted names are restored before the scan result leaves this module.
fn parse_source(source: &str) -> Option<(SyntaxTree, IdentifierRepairs)> {
    let defines = HashMap::new();
    let include_paths: Vec<PathBuf> = Vec::new();
    // `ignore_include = true`: submitted source is untrusted and must never
    // cause a filesystem read, and every origin offset must index the primary
    // source text (an included file's offsets would map to the wrong lines).
    let parse = |input| {
        parse_sv_str(
            input,
            Path::new("source.sv"),
            &defines,
            &include_paths,
            true,
            false,
        )
    };

    if let Ok((syntax_tree, _)) = parse(source) {
        return Some((syntax_tree, IdentifierRepairs::new()));
    }

    let (parser_source, repairs) = repair_yosys_alias_identifiers(source)?;
    let (syntax_tree, _) = parse(&parser_source).ok()?;
    Some((syntax_tree, repairs))
}

fn repair_yosys_alias_identifiers(source: &str) -> Option<(String, IdentifierRepairs)> {
    let mut parser_source = source.to_owned();
    let mut repairs = IdentifierRepairs::new();
    let bytes = source.as_bytes();

    for (offset, _) in source.match_indices("alias") {
        let before_is_identifier = offset > 0
            && (bytes[offset - 1].is_ascii_alphanumeric()
                || matches!(bytes[offset - 1], b'_' | b'$'));
        let end = offset + "alias".len();
        let after_is_identifier = bytes
            .get(end)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'));
        if before_is_identifier || after_is_identifier {
            continue;
        }

        let replacement = (b'a'..=b'z')
            .map(|initial| format!("{}____", char::from(initial)))
            .find(|candidate| !source.contains(candidate) && !repairs.contains_key(candidate))?;
        parser_source.replace_range(offset..end, &replacement);
        repairs.insert(replacement, "alias".to_owned());
    }

    if repairs.is_empty() {
        None
    } else {
        Some((parser_source, repairs))
    }
}

fn restore_identifiers(scanned: &mut ScannedSource, repairs: &IdentifierRepairs) {
    let restore = |identifier: &mut String| {
        if let Some(original) = repairs.get(identifier) {
            identifier.clone_from(original);
        }
    };

    // LHS vectors were sorted/deduped on the repaired placeholder names, so
    // re-normalize after restoring the original spellings.
    for assignment in &mut scanned.assignments.continuous {
        restore(&mut assignment.module);
        for identifier in &mut assignment.lhs_identifiers {
            restore(identifier);
        }
        assignment.lhs_identifiers.sort();
        assignment.lhs_identifiers.dedup();
    }
    for assignment in &mut scanned.assignments.procedural {
        restore(&mut assignment.module);
        for identifier in &mut assignment.lhs_identifiers {
            restore(identifier);
        }
        assignment.lhs_identifiers.sort();
        assignment.lhs_identifiers.dedup();
    }
    for declaration in &mut scanned.ports {
        restore(&mut declaration.module);
        restore(&mut declaration.identifier);
    }
}

impl SourceLineMap {
    fn new(source: &str) -> Self {
        Self {
            newline_offsets: source
                .as_bytes()
                .iter()
                .enumerate()
                .filter_map(|(offset, byte)| (*byte == b'\n').then_some(offset))
                .collect(),
        }
    }

    fn line_number(&self, byte_offset: usize) -> usize {
        self.newline_offsets
            .partition_point(|newline| *newline < byte_offset)
            + 1
    }
}

/// Parse one in-memory SystemVerilog source and recover all provenance facts in
/// one CST walk. Parse failures intentionally return `None`: provenance is a
/// best-effort supplement and must never create a mapping from malformed input.
fn scan_source(
    source: &str,
    ports_by_module: &HashMap<String, HashMap<String, PortDirection>>,
) -> Option<ScannedSource> {
    if has_conditional_preprocessor(source) {
        return None;
    }

    let (syntax_tree, repairs) = parse_source(source)?;
    let line_map = SourceLineMap::new(source);
    let mut scanned = ScannedSource::default();

    for node in &syntax_tree {
        match node {
            RefNode::ModuleDeclarationAnsi(module) => scan_module(
                &syntax_tree,
                &line_map,
                module,
                ports_by_module,
                &repairs,
                &mut scanned,
            ),
            RefNode::ModuleDeclarationNonansi(module) => scan_module(
                &syntax_tree,
                &line_map,
                module,
                ports_by_module,
                &repairs,
                &mut scanned,
            ),
            _ => {}
        }
    }

    restore_identifiers(&mut scanned, &repairs);
    scanned.ports.sort_by(|left, right| {
        left.module
            .cmp(&right.module)
            .then_with(|| left.line.cmp(&right.line))
            .then_with(|| left.identifier.cmp(&right.identifier))
            .then_with(|| {
                port_direction_order(left.direction).cmp(&port_direction_order(right.direction))
            })
    });
    scanned.ports.dedup();
    Some(scanned)
}

fn scan_module<T>(
    syntax_tree: &SyntaxTree,
    line_map: &SourceLineMap,
    module_node: &T,
    ports_by_module: &HashMap<String, HashMap<String, PortDirection>>,
    repairs: &IdentifierRepairs,
    scanned: &mut ScannedSource,
) where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    let Some(module) = module_name(syntax_tree, module_node, repairs) else {
        return;
    };
    let module_ports = ports_by_module.get(&module);

    for node in module_node {
        match node {
            RefNode::ContinuousAssign(assignment) => {
                if let Some(assignment) = continuous_assignment::<sv_parser::ContinuousAssign>(
                    syntax_tree,
                    line_map,
                    assignment,
                    &module,
                ) {
                    scanned.assignments.continuous.push(assignment);
                }
            }
            RefNode::NetDeclaration(declaration) => {
                if let Some(assignment) = initialized_net_declaration::<sv_parser::NetDeclaration>(
                    syntax_tree,
                    line_map,
                    declaration,
                    &module,
                ) {
                    scanned.assignments.continuous.push(assignment);
                }
            }
            RefNode::AlwaysConstruct(always) => {
                scan_always_construct::<sv_parser::AlwaysConstruct>(
                    syntax_tree,
                    line_map,
                    always,
                    &module,
                    &mut scanned.assignments,
                );
            }
            RefNode::AnsiPortDeclaration(declaration) => {
                if let Some(ports) = module_ports {
                    scan_port_node::<sv_parser::AnsiPortDeclaration>(
                        syntax_tree,
                        line_map,
                        declaration,
                        &module,
                        ports,
                        repairs,
                        &mut scanned.ports,
                    );
                }
            }
            RefNode::PortDeclaration(declaration) => {
                if let Some(ports) = module_ports {
                    scan_port_node::<sv_parser::PortDeclaration>(
                        syntax_tree,
                        line_map,
                        declaration,
                        &module,
                        ports,
                        repairs,
                        &mut scanned.ports,
                    );
                }
            }
            _ => {}
        }
    }
}

fn module_name<T>(
    syntax_tree: &SyntaxTree,
    module_node: &T,
    repairs: &IdentifierRepairs,
) -> Option<String>
where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    let identifier = module_node.into_iter().find_map(|node| match node {
        RefNode::ModuleIdentifier(identifier) => {
            first_identifier::<sv_parser::ModuleIdentifier>(syntax_tree, identifier)
        }
        _ => None,
    })?;
    Some(repairs.get(&identifier).cloned().unwrap_or(identifier))
}

fn continuous_assignment<T>(
    syntax_tree: &SyntaxTree,
    line_map: &SourceLineMap,
    assignment: &T,
    module: &str,
) -> Option<ContinuousAssignment>
where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    let (start_line, end_line) = node_lines(syntax_tree, line_map, assignment)?;
    let mut lhs_identifiers = Vec::new();
    for node in assignment {
        match node {
            RefNode::NetAssignment(net_assignment) => {
                lhs_identifiers.extend(net_lhs_identifiers::<sv_parser::NetAssignment>(
                    syntax_tree,
                    net_assignment,
                ));
            }
            RefNode::VariableAssignment(variable_assignment) => {
                lhs_identifiers.extend(variable_lhs_identifiers::<sv_parser::VariableAssignment>(
                    syntax_tree,
                    variable_assignment,
                ));
            }
            _ => {}
        }
    }
    lhs_identifiers.sort();
    lhs_identifiers.dedup();
    (!lhs_identifiers.is_empty()).then(|| ContinuousAssignment {
        module: module.to_owned(),
        start_line,
        end_line,
        lhs_identifiers,
    })
}

/// Net declaration assignments (`wire alias = rhs`) are continuous drivers in
/// the same way as an explicit `assign`. Only initialized declarators count.
fn initialized_net_declaration<T>(
    syntax_tree: &SyntaxTree,
    line_map: &SourceLineMap,
    declaration: &T,
    module: &str,
) -> Option<ContinuousAssignment>
where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    let (start_line, end_line) = node_lines(syntax_tree, line_map, declaration)?;
    let mut lhs_identifiers = Vec::new();
    for node in declaration {
        let RefNode::NetDeclAssignment(net_assignment) = node else {
            continue;
        };
        if !contains_symbol::<sv_parser::NetDeclAssignment>(syntax_tree, net_assignment, "=") {
            continue;
        }
        if let Some(identifier) = net_assignment.into_iter().find_map(|node| match node {
            RefNode::NetIdentifier(identifier) => {
                first_identifier::<sv_parser::NetIdentifier>(syntax_tree, identifier)
            }
            _ => None,
        }) {
            lhs_identifiers.push(identifier);
        }
    }
    (!lhs_identifiers.is_empty()).then(|| ContinuousAssignment {
        module: module.to_owned(),
        start_line,
        end_line,
        lhs_identifiers,
    })
}

fn scan_always_construct<T>(
    syntax_tree: &SyntaxTree,
    line_map: &SourceLineMap,
    always: &T,
    module: &str,
    scanned: &mut ScannedAssignments,
) where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    if let Some((start_line, end_line)) = node_lines(syntax_tree, line_map, always) {
        scanned.blocks.push(ProceduralBlock {
            start_line,
            end_line,
        });
    }

    for node in always {
        let (line, lhs_identifiers) = match node {
            RefNode::BlockingAssignment(assignment) => (
                node_lines::<sv_parser::BlockingAssignment>(syntax_tree, line_map, assignment)
                    .map(|lines| lines.0),
                variable_lhs_identifiers::<sv_parser::BlockingAssignment>(syntax_tree, assignment),
            ),
            RefNode::NonblockingAssignment(assignment) => (
                node_lines::<sv_parser::NonblockingAssignment>(syntax_tree, line_map, assignment)
                    .map(|lines| lines.0),
                variable_lhs_identifiers::<sv_parser::NonblockingAssignment>(
                    syntax_tree,
                    assignment,
                ),
            ),
            RefNode::BlockItemDeclarationData(declaration) => {
                if let Some(assignment) = implicit_block_assignment::<
                    sv_parser::BlockItemDeclarationData,
                >(
                    syntax_tree, line_map, declaration, module
                ) {
                    scanned.procedural.push(assignment);
                }
                continue;
            }
            _ => continue,
        };
        if let Some(line) = line
            && !lhs_identifiers.is_empty()
        {
            scanned.procedural.push(ProceduralAssignment {
                module: module.to_owned(),
                line,
                lhs_identifiers,
            });
        }
    }
}

/// At the start of a sequential block, sv-parser's grammar resolves an
/// untyped `name = expression;` as an implicit data declaration. Yosys resolves
/// the same text against the surrounding signal table as a blocking
/// assignment. Recover only declarations whose implicit type is completely
/// empty, leaving explicit and dimensioned block declarations untouched.
fn implicit_block_assignment<T>(
    syntax_tree: &SyntaxTree,
    line_map: &SourceLineMap,
    declaration: &T,
    module: &str,
) -> Option<ProceduralAssignment>
where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    let has_empty_implicit_type = declaration.into_iter().any(|node| match node {
        RefNode::ImplicitDataType(implicit_type) => {
            node_lines::<sv_parser::ImplicitDataType>(syntax_tree, line_map, implicit_type)
                .is_none()
        }
        _ => false,
    });
    if !has_empty_implicit_type {
        return None;
    }

    let mut line = None;
    let mut lhs_identifiers = Vec::new();
    for node in declaration {
        let RefNode::VariableDeclAssignmentVariable(assignment) = node else {
            continue;
        };
        if !contains_symbol::<sv_parser::VariableDeclAssignmentVariable>(
            syntax_tree,
            assignment,
            "=",
        ) {
            continue;
        }
        let Some(identifier) = assignment.into_iter().find_map(|node| match node {
            RefNode::VariableIdentifier(identifier) => {
                first_identifier::<sv_parser::VariableIdentifier>(syntax_tree, identifier)
            }
            _ => None,
        }) else {
            continue;
        };
        line = line.or_else(|| {
            node_lines::<sv_parser::VariableDeclAssignmentVariable>(
                syntax_tree,
                line_map,
                assignment,
            )
            .map(|lines| lines.0)
        });
        lhs_identifiers.push(identifier);
    }

    Some(ProceduralAssignment {
        module: module.to_owned(),
        line: line?,
        lhs_identifiers,
    })
}

/// Locate port identifiers from ANSI and non-ANSI declaration CST nodes while
/// taking direction from the elaborated netlist. This avoids treating widths,
/// types, parameters, or default-value expressions as ports.
fn scan_port_node<T>(
    syntax_tree: &SyntaxTree,
    line_map: &SourceLineMap,
    declaration: &T,
    module: &str,
    ports: &HashMap<String, PortDirection>,
    repairs: &IdentifierRepairs,
    declarations: &mut Vec<PortDeclaration>,
) where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    for node in declaration {
        match node {
            RefNode::PortIdentifier(identifier) => {
                push_port_declaration::<sv_parser::PortIdentifier>(
                    syntax_tree,
                    line_map,
                    identifier,
                    module,
                    ports,
                    repairs,
                    declarations,
                )
            }
            RefNode::VariableIdentifier(identifier) => {
                push_port_declaration::<sv_parser::VariableIdentifier>(
                    syntax_tree,
                    line_map,
                    identifier,
                    module,
                    ports,
                    repairs,
                    declarations,
                )
            }
            RefNode::InputPortIdentifier(identifier) => {
                push_port_declaration::<sv_parser::InputPortIdentifier>(
                    syntax_tree,
                    line_map,
                    identifier,
                    module,
                    ports,
                    repairs,
                    declarations,
                )
            }
            RefNode::OutputPortIdentifier(identifier) => {
                push_port_declaration::<sv_parser::OutputPortIdentifier>(
                    syntax_tree,
                    line_map,
                    identifier,
                    module,
                    ports,
                    repairs,
                    declarations,
                )
            }
            RefNode::InoutPortIdentifier(identifier) => {
                push_port_declaration::<sv_parser::InoutPortIdentifier>(
                    syntax_tree,
                    line_map,
                    identifier,
                    module,
                    ports,
                    repairs,
                    declarations,
                )
            }
            _ => {}
        }
    }
}

fn push_port_declaration<T>(
    syntax_tree: &SyntaxTree,
    line_map: &SourceLineMap,
    identifier_node: &T,
    module: &str,
    ports: &HashMap<String, PortDirection>,
    repairs: &IdentifierRepairs,
    declarations: &mut Vec<PortDeclaration>,
) where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    let Some(mut identifier) = first_identifier(syntax_tree, identifier_node) else {
        return;
    };
    if let Some(original) = repairs.get(&identifier) {
        identifier.clone_from(original);
    }
    let Some(direction) = ports.get(&identifier).copied() else {
        return;
    };
    let Some((line, _)) = node_lines(syntax_tree, line_map, identifier_node) else {
        return;
    };
    declarations.push(PortDeclaration {
        module: module.to_owned(),
        line,
        identifier,
        direction,
    });
}

fn net_lhs_identifiers<T>(syntax_tree: &SyntaxTree, assignment: &T) -> Vec<String>
where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    let mut identifiers = Vec::new();
    for node in assignment {
        let RefNode::NetLvalueIdentifier(lvalue) = node else {
            continue;
        };
        for node in lvalue {
            if let RefNode::PsOrHierarchicalNetIdentifier(identifier) = node {
                identifiers.extend(all_identifiers::<sv_parser::PsOrHierarchicalNetIdentifier>(
                    syntax_tree,
                    identifier,
                ));
                break;
            }
        }
    }
    identifiers
}

fn variable_lhs_identifiers<T>(syntax_tree: &SyntaxTree, assignment: &T) -> Vec<String>
where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    let mut identifiers = Vec::new();
    for node in assignment {
        let RefNode::VariableLvalueIdentifier(lvalue) = node else {
            continue;
        };
        for node in lvalue {
            if let RefNode::HierarchicalVariableIdentifier(identifier) = node {
                identifiers.extend(
                    all_identifiers::<sv_parser::HierarchicalVariableIdentifier>(
                        syntax_tree,
                        identifier,
                    ),
                );
                break;
            }
        }
    }
    identifiers
}

fn contains_symbol<T>(syntax_tree: &SyntaxTree, node: &T, expected: &str) -> bool
where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    node.into_iter().any(|node| match node {
        RefNode::Symbol(symbol) => syntax_tree.get_str_trim(symbol) == Some(expected),
        _ => false,
    })
}

fn first_identifier<T>(syntax_tree: &SyntaxTree, node: &T) -> Option<String>
where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    node.into_iter()
        .find_map(|node| first_identifier_ref(syntax_tree, node))
}

fn all_identifiers<T>(syntax_tree: &SyntaxTree, node: &T) -> Vec<String>
where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    node.into_iter()
        .filter_map(|node| first_identifier_ref(syntax_tree, node))
        .collect()
}

fn first_identifier_ref(syntax_tree: &SyntaxTree, node: RefNode<'_>) -> Option<String> {
    let raw = match node {
        RefNode::SimpleIdentifier(identifier) => syntax_tree.get_str_trim(identifier)?,
        RefNode::EscapedIdentifier(identifier) => syntax_tree.get_str_trim(identifier)?,
        _ => return None,
    };
    Some(raw.trim_start_matches('\\').to_owned())
}

fn node_lines<T>(
    syntax_tree: &SyntaxTree,
    line_map: &SourceLineMap,
    node: &T,
) -> Option<(usize, usize)>
where
    for<'a> &'a T: IntoIterator<Item = RefNode<'a>>,
{
    node.into_iter()
        .filter_map(|node| match node {
            RefNode::Locate(locate)
                if syntax_tree
                    .get_str(locate)
                    .is_some_and(|text| !text.trim().is_empty()) =>
            {
                syntax_tree
                    .get_origin(locate)
                    .map(|(_, byte_offset)| line_map.line_number(byte_offset))
            }
            _ => None,
        })
        .fold(None, |lines, line| {
            Some(lines.map_or((line, line), |(start, _)| (start, line)))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netlist::{parse_str, parse_value, select_top};
    use serde_json::json;

    fn scan_assignments(source: &str) -> ScannedAssignments {
        scan_source(source, &HashMap::new()).unwrap().assignments
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
        assert!(
            scan_source(
                "`ifdef FEATURE\nmodule top; assign y = a; endmodule\n`endif",
                &HashMap::new(),
            )
            .is_none()
        );
    }

    #[test]
    fn parse_failures_are_skipped_without_partial_results() {
        assert!(scan_source("module top( ;", &HashMap::new()).is_none());
    }

    #[test]
    fn include_directives_are_ignored_and_never_read_the_filesystem() {
        // Untrusted source names an include that must not be opened; the rest
        // of the file still yields provenance with correct primary-file lines.
        let source = "`include \"/nonexistent/evil.svh\"\n\
module top(input logic a, output logic y);\n\
  assign y = a;\n\
endmodule\n";
        let scanned = scan_source(source, &HashMap::new()).expect("include is inert");
        assert_eq!(
            scanned
                .assignments
                .continuous
                .iter()
                .map(|assignment| (assignment.start_line, assignment.lhs_identifiers.clone()))
                .collect::<Vec<_>>(),
            vec![(3, vec!["y".to_owned()])],
        );
    }

    #[test]
    fn alias_inside_strings_and_comments_never_corrupts_extraction() {
        let source = "module top(input logic a, output logic y);\n\
  // alias in a comment\n\
  wire alias = a;\n\
  initial $display(\"alias = %b\", alias);\n\
  assign y = alias;\n\
endmodule\n";
        let scanned = scan_source(source, &HashMap::new()).expect("repair applies");
        let mut targets: Vec<_> = scanned
            .assignments
            .continuous
            .iter()
            .flat_map(|assignment| assignment.lhs_identifiers.clone())
            .collect();
        targets.sort();
        assert_eq!(targets, vec!["alias".to_owned(), "y".to_owned()]);
    }

    #[test]
    fn alias_repair_candidate_exhaustion_skips_the_file_cleanly() {
        // Occupy every placeholder spelling so the repair cannot pick one; the
        // file must be skipped, never mapped incorrectly.
        let mut source = String::from("module top(output wire alias);\n");
        for initial in b'a'..=b'z' {
            source.push_str(&format!(
                "  wire {}____ = 1'b0;\n",
                char::from(initial)
            ));
        }
        source.push_str("endmodule\n");
        assert!(scan_source(&source, &HashMap::new()).is_none());
    }

    #[test]
    fn ansi_and_nonansi_ports_keep_original_declaration_lines() {
        let source = "module ansi(\n\
  input logic a,\n\
  output logic b\n\
);\n\
endmodule\n\
module legacy(a, b, c);\n\
  input a;\n\
  output b;\n\
  inout c;\n\
endmodule\n";
        let ports = HashMap::from([
            (
                "ansi".to_owned(),
                HashMap::from([
                    ("a".to_owned(), PortDirection::Input),
                    ("b".to_owned(), PortDirection::Output),
                ]),
            ),
            (
                "legacy".to_owned(),
                HashMap::from([
                    ("a".to_owned(), PortDirection::Input),
                    ("b".to_owned(), PortDirection::Output),
                    ("c".to_owned(), PortDirection::Inout),
                ]),
            ),
        ]);

        assert_eq!(
            scan_source(source, &ports).unwrap().ports,
            vec![
                PortDeclaration {
                    module: "ansi".to_owned(),
                    line: 2,
                    identifier: "a".to_owned(),
                    direction: PortDirection::Input,
                },
                PortDeclaration {
                    module: "ansi".to_owned(),
                    line: 3,
                    identifier: "b".to_owned(),
                    direction: PortDirection::Output,
                },
                PortDeclaration {
                    module: "legacy".to_owned(),
                    line: 7,
                    identifier: "a".to_owned(),
                    direction: PortDirection::Input,
                },
                PortDeclaration {
                    module: "legacy".to_owned(),
                    line: 8,
                    identifier: "b".to_owned(),
                    direction: PortDirection::Output,
                },
                PortDeclaration {
                    module: "legacy".to_owned(),
                    line: 9,
                    identifier: "c".to_owned(),
                    direction: PortDirection::Inout,
                },
            ]
        );
    }

    #[test]
    fn yosys_alias_identifier_repair_preserves_other_ansi_ports() {
        let source = "module registered_output (\n\
  input logic clk,\n\
  input logic a,\n\
  input logic b,\n\
  output logic y,\n\
  output wire alias,\n\
  output logic z\n\
);\n\
  assign alias = y;\n\
endmodule\n";
        let ports = HashMap::from([(
            "registered_output".to_owned(),
            HashMap::from([
                ("clk".to_owned(), PortDirection::Input),
                ("a".to_owned(), PortDirection::Input),
                ("b".to_owned(), PortDirection::Input),
                ("y".to_owned(), PortDirection::Output),
                ("alias".to_owned(), PortDirection::Output),
                ("z".to_owned(), PortDirection::Output),
            ]),
        )]);

        let scanned = scan_source(source, &ports).unwrap();
        assert!(
            scanned
                .ports
                .iter()
                .any(|declaration| declaration.identifier == "y" && declaration.line == 5)
        );
        assert!(
            scanned
                .ports
                .iter()
                .any(|declaration| declaration.identifier == "alias" && declaration.line == 6)
        );
    }

    #[test]
    fn every_example_parses_with_sv_parser() {
        let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples");
        let mut paths: Vec<_> = std::fs::read_dir(examples)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "sv"))
            .collect();
        paths.sort();
        assert!(!paths.is_empty());

        for path in paths {
            let source = std::fs::read_to_string(&path).unwrap();
            assert!(
                scan_source(&source, &HashMap::new()).is_some(),
                "{} failed to parse",
                path.display()
            );
        }
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
