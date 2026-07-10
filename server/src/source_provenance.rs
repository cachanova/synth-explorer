use crate::graph::{Graph, NodeId, NodeKind, strip_bit_suffix};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Default)]
pub(crate) struct SourceAliasProvenance {
    pub roots_by_line: BTreeMap<String, Vec<NodeId>>,
    pub synthesizable_lines: HashSet<String>,
}

/// Recover source provenance that Yosys JSON cannot retain for wire-only
/// continuous assignments. Cell-producing expressions continue to use Yosys
/// `src`; this narrow supplement resolves each `assign` LHS through final net
/// aliases and graph incidence.
pub(crate) fn continuous_assign_provenance(
    graph: &Graph,
    files: impl IntoIterator<Item = (String, String)>,
) -> SourceAliasProvenance {
    let roots_by_name = roots_by_signal_name(graph);
    let mut provenance = SourceAliasProvenance::default();

    for (file, source) in files {
        for assignment in continuous_assignments(&source) {
            let mut roots = Vec::new();
            for identifier in assignment.lhs_identifiers {
                if let Some(ids) = roots_by_name.get(identifier.as_str()) {
                    roots.extend(ids.iter().copied());
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
    let name = raw_name.trim_start_matches('\\').replace('\\', "");
    roots.entry(name.clone()).or_default().insert(node);
    roots
        .entry(strip_bit_suffix(&name).to_owned())
        .or_default()
        .insert(node);
    if let Some((_, leaf)) = name.rsplit_once('.') {
        roots.entry(leaf.to_owned()).or_default().insert(node);
        roots
            .entry(strip_bit_suffix(leaf).to_owned())
            .or_default()
            .insert(node);
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ContinuousAssignment {
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
        if &sanitized[token_start..index] != "assign" {
            continue;
        }

        let statement_end = bytes[index..]
            .iter()
            .position(|byte| *byte == b';')
            .map_or(bytes.len(), |offset| index + offset);
        let Some(equals) = bytes[index..statement_end]
            .iter()
            .position(|byte| *byte == b'=')
            .map(|offset| index + offset)
        else {
            index = statement_end.saturating_add(1);
            continue;
        };
        let lhs_identifiers = identifiers(&sanitized[index..equals]);
        let start_line = line_at(token_start, &newlines);
        let end_line = line_at(statement_end, &newlines);
        assignments.push(ContinuousAssignment {
            start_line,
            end_line,
            lhs_identifiers,
        });
        index = statement_end.saturating_add(1);
    }
    assignments
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
    out.sort();
    out.dedup();
    out
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
// assign ignored = comment;
assign {valid, data[0]} =
    {ready, payload};
initial $display("assign hidden = in string;");
"#;
        assert_eq!(
            continuous_assignments(source),
            vec![ContinuousAssignment {
                start_line: 3,
                end_line: 4,
                lhs_identifiers: vec!["data".to_owned(), "valid".to_owned()],
            }]
        );
    }
}
