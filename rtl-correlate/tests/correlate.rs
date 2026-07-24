//! Correlation fixtures derived from the Yosys provenance findings note:
//! boundary-name normalization, flop-Q boundaries, per-branch mux src,
//! techmap-internal exclusion, and strpool splitting.

use rtl_correlate::netlist::parse_str;
use rtl_correlate::{
    CorrelationIndex, CorrelationLimits, MappedCut, NetlistDialect, normalize_net_name,
};

fn fixture() -> &'static str {
    // Post-`proc` shaped snapshot of:
    //   1  module top(input clk, input sel, input [1:0] a, b, output reg [1:0] q);
    //   2    wire [1:0] sum = a + b;      // $add on line 2
    //   3    wire [1:0] gated = sum & b;  // $and on line 3
    //   4    always @(posedge clk)
    //   5      if (sel) q <= gated;       // case src line 5
    //   6      else q <= sum;             // case src line 6
    //   7  endmodule
    // Nets: clk=2 sel=3 a=4,5 b=6,7 sum=8,9 gated=10,11 q=12,13 d=14,15
    r##"{
      "modules": {
        "top": {
          "attributes": {"top": "1"},
          "ports": {
            "clk": {"direction": "input", "bits": [2]},
            "sel": {"direction": "input", "bits": [3]},
            "a": {"direction": "input", "bits": [4, 5]},
            "b": {"direction": "input", "bits": [6, 7]},
            "q": {"direction": "output", "bits": [12, 13]}
          },
          "cells": {
            "$add$top.sv:2$1": {
              "type": "$add",
              "attributes": {"src": "top.sv:2.20-2.25"},
              "port_directions": {"A": "input", "B": "input", "Y": "output"},
              "connections": {"A": [4, 5], "B": [6, 7], "Y": [8, 9]}
            },
            "$and$top.sv:3$2": {
              "type": "$and",
              "attributes": {"src": "top.sv:3.22-3.29"},
              "port_directions": {"A": "input", "B": "input", "Y": "output"},
              "connections": {"A": [8, 9], "B": [6, 7], "Y": [10, 11]}
            },
            "$procmux$3": {
              "type": "$mux",
              "attributes": {"src": "top.sv:5.13-5.24|top.sv:6.13-6.22"},
              "port_directions": {"A": "input", "B": "input", "S": "input", "Y": "output"},
              "connections": {"A": [8, 9], "B": [10, 11], "S": [3], "Y": [14, 15]}
            },
            "$procdff$4": {
              "type": "$dff",
              "attributes": {"src": "top.sv:4.3-6.22"},
              "port_directions": {"CLK": "input", "D": "input", "Q": "output"},
              "connections": {"CLK": [2], "D": [14, 15], "Q": [12, 13]}
            }
          },
          "netnames": {
            "sum": {"bits": [8, 9], "attributes": {"src": "top.sv:2.14-2.17"}},
            "gated": {"bits": [10, 11], "attributes": {"src": "top.sv:3.14-3.19"}},
            "q": {"bits": [12, 13], "attributes": {}},
            "a": {"bits": [4, 5], "attributes": {}},
            "b": {"bits": [6, 7], "attributes": {}},
            "$techmap$something.internal": {"bits": [20], "attributes": {}}
          }
        }
      }
    }"##
}

fn index() -> CorrelationIndex {
    let netlist = parse_str(fixture()).expect("fixture parses");
    CorrelationIndex::build(&netlist, "top", NetlistDialect::Yosys).expect("index builds")
}

fn lines(spans: &[rtl_correlate::SrcSpan]) -> Vec<usize> {
    spans.iter().map(|span| span.start_line).collect()
}

#[test]
fn abc_alias_names_normalize_to_their_embedded_original() {
    assert_eq!(normalize_net_name(NetlistDialect::Yosys, "$abc$42$sum"), "sum");
    assert_eq!(
        normalize_net_name(NetlistDialect::Yosys, "$abc$42$\\sum"),
        "sum"
    );
    // Not an abc alias: digits segment malformed.
    assert_eq!(
        normalize_net_name(NetlistDialect::Yosys, "$abc$x$sum"),
        "$abc$x$sum"
    );
    assert_eq!(normalize_net_name(NetlistDialect::Yosys, "\\sum"), "sum");
}

#[test]
fn lut_cone_attributes_enclosed_cells_exactly() {
    // A LUT that computed `gated` from boundary `sum` and port `b`
    // encloses only the $and on line 3; the $add on line 2 feeds the input
    // boundary and lands in the contributing tier.
    let attribution = index().attribute(
        &MappedCut {
            outputs: vec!["$abc$7$gated".to_owned()],
            inputs: vec!["sum".to_owned(), "b".to_owned()],
            truncated: false,
            selected_is_sequential: false,
        },
        &CorrelationLimits::default(),
    );
    assert_eq!(lines(&attribution.exact), vec![3]);
    assert_eq!(lines(&attribution.contributing), vec![2]);
    assert!(!attribution.approximate);
    assert!(!attribution.truncated);
}

#[test]
fn register_attribution_reads_case_level_mux_sources() {
    let attribution = index().attribute(
        &MappedCut {
            outputs: vec!["q".to_owned()],
            inputs: Vec::new(),
            truncated: false,
            selected_is_sequential: true,
        },
        &CorrelationLimits::default(),
    );
    // Exact = both branch assignments (strpool split), NOT the whole block.
    assert_eq!(lines(&attribution.exact), vec![5, 6]);
    // Conditions = the select cone; `sel` is a port with no driver, so no
    // spans, but the data cone statements land in contributing.
    assert_eq!(lines(&attribution.contributing), vec![2, 3]);
    assert!(!attribution.approximate);
}

#[test]
fn bit_suffixed_boundaries_resolve_single_bits() {
    let attribution = index().attribute(
        &MappedCut {
            outputs: vec!["gated[1]".to_owned()],
            inputs: vec!["sum[1]".to_owned(), "b[1]".to_owned()],
            truncated: false,
            selected_is_sequential: false,
        },
        &CorrelationLimits::default(),
    );
    assert_eq!(lines(&attribution.exact), vec![3]);
    assert!(!attribution.approximate);
}

#[test]
fn unresolved_boundaries_flag_approximate_attribution() {
    let attribution = index().attribute(
        &MappedCut {
            outputs: vec!["$techmap$something.internal".to_owned()],
            inputs: Vec::new(),
            truncated: false,
            selected_is_sequential: false,
        },
        &CorrelationLimits::default(),
    );
    // Techmap template internals are not RTL boundaries.
    assert!(attribution.approximate);
    assert!(attribution.exact.is_empty());
}

#[test]
fn unconditional_register_falls_back_to_block_span() {
    // Snapshot without a mux: q <= sum directly.
    let netlist = parse_str(
        r##"{
          "modules": {
            "top": {
              "attributes": {"top": "1"},
              "ports": {
                "clk": {"direction": "input", "bits": [2]},
                "a": {"direction": "input", "bits": [4]},
                "q": {"direction": "output", "bits": [12]}
              },
              "cells": {
                "$procdff$1": {
                  "type": "$dff",
                  "attributes": {"src": "top.sv:4.3-5.14"},
                  "port_directions": {"CLK": "input", "D": "input", "Q": "output"},
                  "connections": {"CLK": [2], "D": [4], "Q": [12]}
                }
              },
              "netnames": {
                "q": {"bits": [12], "attributes": {}},
                "a": {"bits": [4], "attributes": {}}
              }
            }
          }
        }"##,
    )
    .expect("fixture parses");
    let index =
        CorrelationIndex::build(&netlist, "top", NetlistDialect::Yosys).expect("index builds");
    let attribution = index.attribute(
        &MappedCut {
            outputs: vec!["q".to_owned()],
            inputs: Vec::new(),
            truncated: false,
            selected_is_sequential: true,
        },
        &CorrelationLimits::default(),
    );
    assert_eq!(lines(&attribution.exact), vec![4]);
    assert!(attribution.approximate);
}

#[test]
fn caps_truncate_instead_of_walking_unbounded() {
    let attribution = index().attribute(
        &MappedCut {
            outputs: vec!["q".to_owned()],
            inputs: Vec::new(),
            truncated: false,
            selected_is_sequential: true,
        },
        &CorrelationLimits {
            cell_visit_cap: 1,
            span_cap: 1,
        },
    );
    assert!(attribution.truncated);
}

#[test]
fn vivado_reg_suffixed_boundaries_resolve_via_dialect() {
    let netlist = parse_str(fixture()).expect("fixture parses");
    let index =
        CorrelationIndex::build(&netlist, "top", NetlistDialect::Vivado).expect("index builds");
    let attribution = index.attribute(
        &MappedCut {
            outputs: vec!["q_reg".to_owned()],
            inputs: Vec::new(),
            truncated: false,
            selected_is_sequential: true,
        },
        &CorrelationLimits::default(),
    );
    assert_eq!(lines(&attribution.exact), vec![5, 6]);
}
