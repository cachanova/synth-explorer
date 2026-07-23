//! Source-provenance facts: coordinate parsing, recovery from
//! provenance-preserving synthesis artifacts, and query indexes.
//!
//! This module owns what the design's source text says about the netlist,
//! not how the graph is analyzed or projected. The dependency is one-way:
//! `analysis` consumes `source`; non-test code in this module must not
//! import from `crate::analysis`.

pub(crate) mod index;
pub(crate) mod recover;

pub(crate) use index::SourceProvenanceIndex;
pub(crate) use recover::recover_source_provenance;
