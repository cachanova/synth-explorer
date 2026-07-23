//! Source-provenance facts: coordinate parsing, recovery from
//! provenance-preserving synthesis artifacts, and query indexes.
//!
//! This module owns what the design's source text says about the netlist,
//! not how the graph is analyzed or projected. The dependency is one-way:
//! `analysis` consumes `source`; non-test code in this module must not
//! import from `crate::analysis`.

pub(crate) mod coordinates;
pub(crate) mod index;
pub(crate) mod recover;
pub mod types;

/// Must equal `crate::analysis::MAX_SUBGRAPH_NODES + 1`; a compile-time
/// assertion in `analysis.rs` enforces the invariant.
pub(crate) const SOURCE_ROOT_COLLECTION_CAP: usize = 2_001;
pub(crate) const SOURCE_LINE_RESPONSE_CAP: usize = 10_000;
pub(crate) const SOURCE_LINE_RESPONSE_NODE_BUDGET: usize = 20_000;
pub(crate) const SOURCE_RANGE_RESPONSE_CAP: usize = 10_000;
pub(crate) const SOURCE_BIT_RANGE_RESPONSE_CAP: usize = 200;
pub(crate) const SOURCE_RANGE_ASSOCIATION_CAP: usize = 20_000;
pub(crate) const SOURCE_RANGE_INDEX_CAP: usize = SOURCE_RANGE_ASSOCIATION_CAP;
pub(crate) const SOURCE_SPAN_INDEX_CAP: usize = SOURCE_RANGE_ASSOCIATION_CAP;
pub(crate) const SOURCE_PROBE_TARGET_VISIT_CAP: usize = SOURCE_RANGE_ASSOCIATION_CAP;

pub(crate) use index::SourceProvenanceIndex;
pub(crate) use recover::recover_source_provenance;
pub use types::{
    SourceBitRangesResponse, SourceMapResponse, SourceProbeDirection, SourceProbeHint,
    SourceProbeHintKind, SourceRangeMapping, SourceSelectionRange,
};
