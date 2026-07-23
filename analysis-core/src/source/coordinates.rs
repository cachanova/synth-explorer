//! Parsing and comparison of Yosys `src`-attribute coordinates.

use super::types::SourceRangeMapping;
use deepsize::DeepSizeOf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, DeepSizeOf)]
pub(super) struct SpanCoordinates {
    pub(super) start_line: usize,
    pub(super) end_line: usize,
    pub(super) start_column: Option<usize>,
    pub(super) end_column: Option<usize>,
}

impl SpanCoordinates {
    pub(super) fn from_range(range: &SourceRangeMapping) -> Self {
        Self {
            start_line: range.start_line,
            start_column: range.start_column,
            end_line: range.end_line,
            end_column: range.end_column,
        }
    }

    pub(super) fn overlaps(
        self,
        start_line: usize,
        end_line: usize,
        start_column: Option<usize>,
        end_column: Option<usize>,
    ) -> bool {
        source_coordinates_overlap(
            self.start_line,
            self.start_column,
            self.end_line,
            self.end_column,
            start_line,
            start_column,
            end_line,
            end_column,
        )
    }

    pub(super) fn format(self, file: &str) -> String {
        match (self.start_column, self.end_column) {
            (Some(start_column), Some(end_column)) => format!(
                "{file}:{}.{start_column}-{}.{end_column}",
                self.start_line, self.end_line
            ),
            _ => format!("{file}:{}-{}", self.start_line, self.end_line),
        }
    }
}

pub(crate) fn source_columns_are_authoritative(file: &str) -> bool {
    let lower = file.to_ascii_lowercase();
    !lower.ends_with(".vhd") && !lower.ends_with(".vhdl")
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn source_coordinates_overlap(
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

pub(crate) fn insert_src_lines(mut src: &str, mut insert: impl FnMut(&str, usize)) {
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

pub(crate) fn parse_src_loc(loc: &str) -> Option<(String, usize, usize)> {
    let (file, start_line, _, end_line, _) = parse_src_span(loc)?;
    Some((file, start_line, end_line))
}

pub(crate) type ParsedSourceSpan = (String, usize, Option<usize>, usize, Option<usize>);

pub(crate) fn parse_src_span(loc: &str) -> Option<ParsedSourceSpan> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_spans_use_inclusive_columns_and_whole_line_fallbacks() {
        let precise = SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 2,
            end_line: 2,
            start_column: Some(7),
            end_column: Some(16),
            node_ids: Vec::new(),
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        };
        let overlaps = |range: &SourceRangeMapping, column| {
            source_coordinates_overlap(
                range.start_line,
                range.start_column,
                range.end_line,
                range.end_column,
                2,
                Some(column),
                2,
                Some(column),
            )
        };
        assert!(overlaps(&precise, 10));
        assert!(!overlaps(&precise, 6));
        assert!(!overlaps(&precise, 17));
        let whole_line = SourceRangeMapping {
            start_column: None,
            end_column: None,
            ..precise
        };
        assert!(overlaps(&whole_line, 100));
        assert_eq!(
            parse_src_span("top.sv:2.7-4.12"),
            Some(("top.sv".to_owned(), 2, Some(7), 4, Some(12)))
        );
    }

    #[test]
    fn source_span_parser_keeps_valid_fragments_and_normalizes_existing_edge_cases() {
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
        for malformed in [
            "garbage",
            "top.sv:not-a-line",
            "top.sv:2.bad-2.4",
            "top.sv:2.1-4.bad",
        ] {
            assert_eq!(parse_src_span(malformed), None, "fragment: {malformed}");
        }

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
