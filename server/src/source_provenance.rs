use crate::graph::{Graph, NodeId, NodeKind, strip_bit_suffix};
use crate::netlist::YosysModule;
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Default)]
pub(crate) struct SourceAliasProvenance {
    pub roots_by_line: BTreeMap<String, Vec<NodeId>>,
    pub synthesizable_lines: HashSet<String>,
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
    source_module: &YosysModule,
    files: impl IntoIterator<Item = (String, String)>,
) -> SourceAliasProvenance {
    let roots_by_name = roots_by_signal_name(graph);
    let scopes_by_module = scopes_by_module(source_module, &graph.top);
    let mut provenance = SourceAliasProvenance::default();

    for (file, source) in files {
        if has_conditional_preprocessor(&source) {
            continue;
        }
        for assignment in continuous_assignments(&source) {
            let Some(scopes) = scopes_by_module.get(&assignment.module) else {
                continue;
            };
            let mut roots = Vec::new();
            for identifier in assignment.lhs_identifiers {
                for scope in scopes {
                    let qualified = if scope.is_empty() {
                        identifier.clone()
                    } else {
                        format!("{scope}.{identifier}")
                    };
                    if let Some(ids) = roots_by_name.get(qualified.as_str()) {
                        roots.extend(ids.iter().copied());
                    }
                }
            }
            roots.sort_unstable();
            roots.dedup();
            for line in assignment.start_line..=assignment.end_line {
                let key = format!("{file}:{line}");
                provenance.synthesizable_lines.insert(key.clone());
                if !roots.is_empty() {
                    provenance
                        .roots_by_line
                        .entry(key)
                        .or_default()
                        .extend(roots.iter().copied());
                }
            }
        }
    }

    for ids in provenance.roots_by_line.values_mut() {
        ids.sort_unstable();
        ids.dedup();
    }
    provenance
}

fn scopes_by_module(
    source_module: &YosysModule,
    selected_top: &str,
) -> HashMap<String, Vec<String>> {
    let mut scopes = HashMap::<String, Vec<String>>::new();
    scopes
        .entry(normalize_name(selected_top))
        .or_default()
        .push(String::new());
    for (cell_name, cell) in &source_module.cells {
        if cell.cell_type != "$scopeinfo" {
            continue;
        }
        let Some(module) = cell.attributes.get("module") else {
            continue;
        };
        scopes
            .entry(normalize_name(module))
            .or_default()
            .push(normalize_name(cell_name));
    }
    for prefixes in scopes.values_mut() {
        prefixes.sort();
        prefixes.dedup();
    }
    scopes
}

fn roots_by_signal_name(graph: &Graph) -> HashMap<String, Vec<NodeId>> {
    let mut roots: HashMap<String, HashSet<NodeId>> = HashMap::new();
    for node in &graph.nodes {
        if node.kind != NodeKind::PortBit {
            continue;
        }
        if let Some(port) = &node.port {
            insert_root_name(&mut roots, port, node.id);
        }
        insert_root_name(&mut roots, &node.name, node.id);
    }

    let mut incident: HashMap<u32, HashSet<NodeId>> = HashMap::new();
    for edge in &graph.edges {
        let Some(bit) = edge.bit else {
            continue;
        };
        let nodes = incident.entry(bit).or_default();
        nodes.insert(edge.from);
        nodes.insert(edge.to);
    }
    for (bit, aliases) in &graph.net_aliases {
        let Some(nodes) = incident.get(bit) else {
            continue;
        };
        for alias in aliases {
            for node in nodes {
                insert_root_name(&mut roots, alias, *node);
            }
        }
    }

    roots
        .into_iter()
        .map(|(name, ids)| {
            let mut ids: Vec<NodeId> = ids.into_iter().collect();
            ids.sort_unstable();
            (name, ids)
        })
        .collect()
}

fn insert_root_name(roots: &mut HashMap<String, HashSet<NodeId>>, raw_name: &str, node: NodeId) {
    let name = normalize_name(raw_name);
    roots.entry(name.clone()).or_default().insert(node);
    roots
        .entry(strip_bit_suffix(&name).to_owned())
        .or_default()
        .insert(node);
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

fn continuous_assignments(source: &str) -> Vec<ContinuousAssignment> {
    let sanitized = sanitize_verilog(source);
    let bytes = sanitized.as_bytes();
    let newlines: Vec<usize> = bytes
        .iter()
        .enumerate()
        .filter_map(|(index, byte)| (*byte == b'\n').then_some(index))
        .collect();
    let mut assignments = Vec::new();
    let mut index = 0;
    let mut current_module: Option<String> = None;

    while index < bytes.len() {
        if !is_identifier_start(bytes[index]) {
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
                    cursor += 1;
                }
            }
            current_module = module_name;
            index = cursor;
            continue;
        }
        if token == "endmodule" {
            current_module = None;
            continue;
        }
        let explicit_assign = token == "assign";
        let wire_alias = matches!(token, "wire" | "tri" | "wand" | "wor");
        if !explicit_assign && !wire_alias {
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
        if lhs_identifiers.is_empty() {
            index = statement_end.saturating_add(1);
            continue;
        }
        let start_line = line_at(token_start, &newlines);
        let end_line = line_at(statement_end, &newlines);
        assignments.push(ContinuousAssignment {
            module,
            start_line,
            end_line,
            lhs_identifiers,
        });
        index = statement_end.saturating_add(1);
    }
    assignments
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
            continuous_assignments(source),
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
    fn conditional_sources_use_only_yosys_provenance() {
        assert!(has_conditional_preprocessor(
            "`ifdef FEATURE\nassign y = a;\n`endif"
        ));
    }
}
