//! Response and query types for source-provenance facts.

use deepsize::DeepSizeOf;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceSelectionRange<'a> {
    pub file: &'a str,
    pub start_line: usize,
    pub end_line: usize,
    pub start_column: Option<usize>,
    pub end_column: Option<usize>,
}

/// One span in a tiered node-attribution response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, DeepSizeOf)]
pub struct SourceTierSpan {
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<usize>,
}

/// Tiered source attribution for a schematic selection.
#[derive(Debug, Clone, Default, Serialize, DeepSizeOf)]
pub struct SourceNodeTiersResponse {
    pub exact: Vec<SourceTierSpan>,
    pub contributing: Vec<SourceTierSpan>,
    pub approximate: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct SourceMapResponse {
    pub files: Vec<String>,
    pub by_line: BTreeMap<String, Vec<u32>>,
    pub ranges: Vec<SourceRangeMapping>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, DeepSizeOf)]
pub struct SourceBitRangesResponse {
    pub ranges: Vec<SourceRangeMapping>,
    pub truncated: bool,
    pub approximate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, DeepSizeOf)]
pub struct SourceRangeMapping {
    pub file: String,
    pub start_line: usize,
    pub end_line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_column: Option<usize>,
    pub node_ids: Vec<u32>,
    #[serde(rename = "signalBits", skip_serializing_if = "Vec::is_empty")]
    pub signal_bits: Vec<u32>,
    #[serde(
        rename = "approximateSignalBits",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub approximate_signal_bits: Vec<u32>,
    pub mapping_incomplete: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, DeepSizeOf)]
#[serde(rename_all = "lowercase")]
pub enum SourceProbeDirection {
    Fanin,
    Fanout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, DeepSizeOf)]
#[serde(rename_all = "snake_case")]
pub enum SourceProbeHintKind {
    Block,
    OutputPort,
    Procedural,
    Signal,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, DeepSizeOf)]
pub struct SourceProbeHint {
    pub file: String,
    pub start_line: usize,
    pub start_column: Option<usize>,
    pub end_line: usize,
    pub end_column: Option<usize>,
    pub direction: SourceProbeDirection,
    pub kind: SourceProbeHintKind,
}
