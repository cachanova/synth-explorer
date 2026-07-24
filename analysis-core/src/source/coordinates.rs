//! Comparison of Yosys `src`-attribute coordinates.
//!
//! Parsing primitives live in `rtl_correlate::src_attr`; this module keeps
//! the range-comparison helpers that depend on product response types.

use super::types::SourceRangeMapping;
use deepsize::DeepSizeOf;
pub(crate) use rtl_correlate::src_attr::{
    ParsedSourceSpan, insert_src_lines, parse_src_loc, parse_src_span,
    source_columns_are_authoritative, source_coordinates_overlap,
};

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
    }
}
