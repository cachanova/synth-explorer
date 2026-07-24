//! Parsing of Yosys `src` attributes.
//!
//! A `src` attribute is a `|`-separated pool of locations (RTLIL strpool):
//! `proc` merges per-case locations into one attribute, so a single cell can
//! carry several source spans. Each location is `path:start[.col][-end[.col]]`;
//! only the file name of the path is kept because the product identifies
//! sources by submitted file name.

/// `(file, start_line, start_column, end_line, end_column)`.
pub type ParsedSourceSpan = (String, usize, Option<usize>, usize, Option<usize>);

/// One parsed source location.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, deepsize::DeepSizeOf)]
pub struct SrcSpan {
    pub file: String,
    pub start_line: usize,
    pub start_column: Option<usize>,
    pub end_line: usize,
    pub end_column: Option<usize>,
}

impl From<ParsedSourceSpan> for SrcSpan {
    fn from((file, start_line, start_column, end_line, end_column): ParsedSourceSpan) -> Self {
        Self {
            file,
            start_line,
            start_column,
            end_line,
            end_column,
        }
    }
}

/// Parse every valid location in a `src` attribute pool.
pub fn parse_src_pool(src: &str) -> impl Iterator<Item = SrcSpan> + '_ {
    src.split('|')
        .filter_map(parse_src_span)
        .map(SrcSpan::from)
}

/// Call `insert` for every `(file, line)` a `src` attribute pool covers,
/// capping each location at 200 lines.
pub fn insert_src_lines(mut src: &str, mut insert: impl FnMut(&str, usize)) {
    while !src.is_empty() {
        let (loc, rest) = src
            .split_once('|')
            .map_or((src, ""), |(loc, rest)| (loc, rest));
        if let Some((file, start, end)) = parse_src_loc(loc) {
            for line in start..=end.min(start + 199) {
                insert(&file, line);
            }
        }
        src = rest;
    }
}

pub fn parse_src_loc(loc: &str) -> Option<(String, usize, usize)> {
    let (file, start_line, _, end_line, _) = parse_src_span(loc)?;
    Some((file, start_line, end_line))
}

pub fn parse_src_span(loc: &str) -> Option<ParsedSourceSpan> {
    let trimmed = loc.trim();
    let (file, rest) = trimmed.rsplit_once(':')?;
    let (start, end) = rest.split_once('-').map_or((rest, rest), |(a, b)| (a, b));
    let parse_point = |point: &str| {
        let (line, column) = point
            .split_once('.')
            .map_or((point, None), |(line, column)| (line, Some(column)));
        Some((line.parse().ok()?, column.map(str::parse).transpose().ok()?))
    };
    let (start_line, start_column) = parse_point(start)?;
    let (end_line, end_column) = parse_point(end)?;
    let file_name = std::path::Path::new(file)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(file)
        .to_owned();
    let (end_line, end_column) = if end_line < start_line {
        (start_line, start_column)
    } else {
        (end_line, end_column)
    };
    Some((file_name, start_line, start_column, end_line, end_column))
}

/// Column information from GHDL-translated VHDL points at generated Verilog,
/// not the submitted source; only line numbers are trustworthy there.
pub fn source_columns_are_authoritative(file: &str) -> bool {
    let lower = file.to_ascii_lowercase();
    !lower.ends_with(".vhd") && !lower.ends_with(".vhdl")
}

/// Inclusive-coordinate overlap between a stored range and a query range,
/// falling back to line-level overlap when either side lacks columns.
#[allow(clippy::too_many_arguments)]
pub fn source_coordinates_overlap(
    range_start_line: usize,
    range_start_column: Option<usize>,
    range_end_line: usize,
    range_end_column: Option<usize>,
    start_line: usize,
    start_column: Option<usize>,
    end_line: usize,
    end_column: Option<usize>,
) -> bool {
    if range_end_line < start_line || range_start_line > end_line {
        return false;
    }
    let (Some(range_start_column), Some(range_end_column)) = (range_start_column, range_end_column)
    else {
        return true;
    };
    let (Some(start_column), Some(end_column)) = (start_column, end_column) else {
        return true;
    };
    (range_start_line, range_start_column) <= (end_line, end_column)
        && (start_line, start_column) <= (range_end_line, range_end_column)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_spans_and_normalizes_edge_cases() {
        assert_eq!(
            parse_src_span("top.sv:2.7-4.12"),
            Some(("top.sv".to_owned(), 2, Some(7), 4, Some(12)))
        );
        assert_eq!(
            parse_src_span("  /tmp/generated/top.sv:5.7-6.11  "),
            Some(("top.sv".to_owned(), 5, Some(7), 6, Some(11)))
        );
        assert_eq!(
            parse_src_span("top.sv:8.3-7.2"),
            Some(("top.sv".to_owned(), 8, Some(3), 8, Some(3)))
        );
        assert_eq!(
            parse_src_span(r"C:\rtl\top.sv:2.1-2.4"),
            Some((r"C:\rtl\top.sv".to_owned(), 2, Some(1), 2, Some(4)))
        );
        for malformed in ["garbage", "top.sv:not-a-line", "top.sv:2.bad-2.4"] {
            assert_eq!(parse_src_span(malformed), None, "fragment: {malformed}");
        }
    }

    #[test]
    fn strpool_sources_split_into_span_sets() {
        let spans: Vec<SrcSpan> =
            parse_src_pool("top.sv:4.5-4.20|garbage|top.sv:9.3-9.18").collect();
        assert_eq!(
            spans
                .iter()
                .map(|span| (span.start_line, span.end_line))
                .collect::<Vec<_>>(),
            vec![(4, 4), (9, 9)]
        );
    }

    #[test]
    fn line_insertion_skips_malformed_fragments() {
        let mut retained = Vec::new();
        insert_src_lines(
            "garbage|/tmp/generated/top.sv:5.7-5.11|top.sv:not-a-line|top.sv:8.3-7.2",
            |file, line| retained.push((file.to_owned(), line)),
        );
        assert_eq!(
            retained,
            vec![("top.sv".to_owned(), 5), ("top.sv".to_owned(), 8)]
        );
    }
}
