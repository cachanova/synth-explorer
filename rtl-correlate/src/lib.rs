//! RTL ↔ mapped-netlist source correlation over Yosys JSON netlists.
//!
//! This crate owns the tool-dialect rules (name normalization and
//! provenance quirks per synthesis tool) and the Yosys JSON netlist model
//! shared by both sides of a correlation. It deliberately has no
//! product-specific types: consumers adapt their graph representations to
//! the traits and inputs defined here.

pub mod correlate;
pub mod dialect;
pub mod src_attr;
pub mod netlist;

pub use correlate::{
    Attribution, CorrelateError, CorrelationIndex, CorrelationLimits, MappedCut,
    normalize_net_name,
};
pub use dialect::NetlistDialect;
pub use src_attr::SrcSpan;
