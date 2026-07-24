//! RTL ↔ mapped-netlist source correlation over Yosys JSON netlists.
//!
//! This crate owns the tool-dialect rules (name normalization and
//! provenance quirks per synthesis tool) and the Yosys JSON netlist model
//! shared by both sides of a correlation. It deliberately has no
//! product-specific types: consumers adapt their graph representations to
//! the traits and inputs defined here.

pub mod dialect;
pub mod netlist;

pub use dialect::NetlistDialect;
