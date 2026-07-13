use crate::analysis::{
    SOURCE_RANGE_ASSOCIATION_CAP, SOURCE_ROOT_COLLECTION_CAP, SourceRangeMapping,
};
use crate::graph::{Graph, NodeId, NodeKind, strip_bit_suffix};
use crate::netlist::YosysNetlist;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

#[derive(Debug, Default)]
pub(crate) struct SourceAliasProvenance {
    pub ranges: Vec<SourceRangeMapping>,
    pub truncated: bool,
    /// Resolved procedural-assignment targets per `(file, statement line)`.
    /// Lines whose targets could not be fully resolved carry no entry so line
    /// probes fall back to whole-block attribution.
    pub procedural_targets: HashMap<(String, usize), Vec<NodeId>>,
}

#[derive(Debug, Default)]
struct RangeProvenance {
    roots: BTreeSet<NodeId>,
    mapping_incomplete: bool,
}

#[derive(Debug, Default)]
struct SignalRootIndex {
    roots: HashMap<String, Vec<NodeId>>,
    incomplete: HashSet<String>,
}

/// Recover source provenance that Yosys JSON cannot retain for wire-only
/// continuous assignments. Cell-producing expressions continue to use Yosys
/// `src`; this narrow supplement resolves `assign` and wire-alias LHS names in
/// the selected top's live elaborated hierarchy through exact flattened scope
/// names, final net aliases, and graph incidence. Files containing conditional
/// preprocessor branches are skipped rather than risking a false mapping from
/// inactive source.
pub(crate) fn continuous_assign_provenance(
    graph: &Graph,
    source_netlist: &YosysNetlist,
    files: impl IntoIterator<Item = (String, String)>,
) -> SourceAliasProvenance {
    let roots_by_name = roots_by_signal_name(graph);
    let scopes_by_module = scopes_by_module(source_netlist, &graph.top);
    let mut ranges: BTreeMap<(String, usize, usize), RangeProvenance> = BTreeMap::new();
    let mut association_count = 0usize;
    let mut procedural: BTreeMap<(String, usize), BTreeSet<NodeId>> = BTreeMap::new();
    let mut unusable_lines: HashSet<(String, usize)> = HashSet::new();
    let mut target_count = 0usize;

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
                    mapping_incomplete |= roots_by_name.incomplete.contains(&qualified);
                    if let Some(ids) = roots_by_name.roots.get(qualified.as_str()) {
                        for id in ids {
                            mapping_incomplete |= insert_bounded_root(&mut roots, *id);
                        }
                    }
                }
            }
            let range = ranges
                .entry((file.clone(), assignment.start_line, assignment.end_line))
                .or_default();
            merge_range_roots(range, roots, mapping_incomplete, &mut association_count);
        }
        for assignment in scanned.procedural {
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
                    unusable |= roots_by_name.incomplete.contains(&qualified);
                    if let Some(ids) = roots_by_name.roots.get(qualified.as_str()) {
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
                    unusable_lines.insert(key);
                    break;
                }
                targets.insert(root);
                target_count += 1;
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
    SourceAliasProvenance {
        ranges,
        truncated,
        procedural_targets,
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
    let mut roots: HashMap<String, BTreeSet<NodeId>> = HashMap::new();
    let mut incomplete = HashSet::new();
    for node in &graph.nodes {
        if node.kind != NodeKind::PortBit {
            continue;
        }
        if let Some(port) = &node.port {
            insert_root_name(&mut roots, &mut incomplete, port, node.id);
        }
        insert_root_name(&mut roots, &mut incomplete, &node.name, node.id);
    }

    let mut incident: HashMap<u32, BTreeSet<NodeId>> = HashMap::new();
    let mut incomplete_incident = HashSet::new();
    for edge in &graph.edges {
        let Some(bit) = edge.bit else {
            continue;
        };
        let nodes = incident.entry(bit).or_default();
        if insert_bounded_root(nodes, edge.from) | insert_bounded_root(nodes, edge.to) {
            incomplete_incident.insert(bit);
        }
    }
    for (bit, aliases) in &graph.net_aliases {
        let Some(nodes) = incident.get(bit) else {
            continue;
        };
        for alias in aliases {
            if incomplete_incident.contains(bit) {
                mark_root_name_incomplete(&mut incomplete, alias);
            }
            for node in nodes {
                insert_root_name(&mut roots, &mut incomplete, alias, *node);
            }
        }
    }

    let roots = roots
        .into_iter()
        .map(|(name, ids)| {
            let mut ids: Vec<NodeId> = ids.into_iter().collect();
            ids.sort_unstable();
            (name, ids)
        })
        .collect();
    SignalRootIndex { roots, incomplete }
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

#[derive(Debug, Default, PartialEq, Eq)]
struct ScannedAssignments {
    continuous: Vec<ContinuousAssignment>,
    procedural: Vec<ProceduralAssignment>,
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
            index = cursor;
            continue;
        }
        if token == "endmodule" {
            current_module = None;
            in_always = false;
            continue;
        }
        if matches!(token, "always" | "always_ff" | "always_comb" | "always_latch") {
            in_always = current_module.is_some();
            always_begin_depth = 0;
            always_has_begin = false;
            continue;
        }
        if token == "begin" {
            if in_always {
                always_begin_depth += 1;
                always_has_begin = true;
            }
            continue;
        }
        if token == "end" {
            if in_always {
                always_begin_depth = always_begin_depth.saturating_sub(1);
                if always_has_begin && always_begin_depth == 0 {
                    in_always = false;
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
                        in_always = false;
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
/// not an assignment. A statement beginning with an identifier directly
/// followed by `=` (not `==`) is a blocking assignment; otherwise a top-level
/// `<=` (outside parentheses/brackets/braces, so comparisons in conditions do
/// not match) marks a nonblocking assignment.
fn procedural_assignment_lhs(statement: &str) -> Option<Vec<String>> {
    let bytes = statement.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() && is_identifier_continue(bytes[cursor]) {
        cursor += 1;
    }
    let lhs_end = cursor;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    if lhs_end > 0 && bytes.get(cursor) == Some(&b'=') && bytes.get(cursor + 1) != Some(&b'=') {
        return Some(vec![statement[..lhs_end].to_owned()]);
    }
    let mut nesting = 0usize;
    let mut previous = 0u8;
    for (offset, byte) in bytes.iter().enumerate() {
        match byte {
            b'(' | b'[' | b'{' => nesting += 1,
            b')' | b']' | b'}' => nesting = nesting.saturating_sub(1),
            b'<' if nesting == 0
                && previous != b'<'
                && bytes.get(offset + 1) == Some(&b'=') =>
            {
                let lhs = identifiers(&statement[..offset]);
                return (!lhs.is_empty()).then_some(lhs);
            }
            _ => {}
        }
        previous = *byte;
    }
    None
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
                    line: 16,
                    lhs_identifiers: vec!["q".to_owned()],
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
            continuous_assign_provenance(&graph, &netlist, [("sparse.sv".to_owned(), source)]);

        assert!(!provenance.truncated);
        assert_eq!(provenance.ranges.len(), 1);
        let range = &provenance.ranges[0];
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
