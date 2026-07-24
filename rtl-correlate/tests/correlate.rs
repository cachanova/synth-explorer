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
    assert_eq!(normalize_net_name("$abc$42$sum"), "sum");
    assert_eq!(normalize_net_name("$abc$42$\\sum"), "sum");
    // Not an abc alias: digits segment malformed.
    assert_eq!(normalize_net_name("$abc$x$sum"), "$abc$x$sum");
    assert_eq!(normalize_net_name("\\sum"), "sum");
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
            feeds_registers: Vec::new(),
            declarations: Vec::new(),
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
            feeds_registers: Vec::new(),
            declarations: Vec::new(),
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
            feeds_registers: Vec::new(),
            declarations: Vec::new(),
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
            feeds_registers: Vec::new(),
            declarations: Vec::new(),
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
            feeds_registers: Vec::new(),
            declarations: Vec::new(),
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
            feeds_registers: Vec::new(),
            declarations: Vec::new(),
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
            feeds_registers: Vec::new(),
            declarations: Vec::new(),
            truncated: false,
            selected_is_sequential: true,
        },
        &CorrelationLimits::default(),
    );
    assert_eq!(lines(&attribution.exact), vec![5, 6]);
}

#[test]
fn register_conditions_carry_select_cone_sources() {
    // The mux select is computed logic ($eq on line 4), not a bare port:
    // its span must surface in the conditions tier.
    let netlist = parse_str(
        r##"{
          "modules": {
            "top": {
              "attributes": {"top": "1"},
              "ports": {
                "clk": {"direction": "input", "bits": [2]},
                "mode": {"direction": "input", "bits": [3]},
                "a": {"direction": "input", "bits": [4]},
                "q": {"direction": "output", "bits": [12]}
              },
              "cells": {
                "$eq$top.sv:4$1": {
                  "type": "$eq",
                  "attributes": {"src": "top.sv:4.9-4.20"},
                  "port_directions": {"A": "input", "B": "input", "Y": "output"},
                  "connections": {"A": [3], "B": [4], "Y": [16]}
                },
                "$procmux$2": {
                  "type": "$mux",
                  "attributes": {"src": "top.sv:5.13-5.22"},
                  "port_directions": {"A": "input", "B": "input", "S": "input", "Y": "output"},
                  "connections": {"A": [12], "B": [4], "S": [16], "Y": [14]}
                },
                "$procdff$3": {
                  "type": "$dff",
                  "attributes": {"src": "top.sv:4.3-5.22"},
                  "port_directions": {"CLK": "input", "D": "input", "Q": "output"},
                  "connections": {"CLK": [2], "D": [14], "Q": [12]}
                }
              },
              "netnames": {
                "q": {"bits": [12]},
                "a": {"bits": [4]},
                "mode": {"bits": [3]}
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
            feeds_registers: Vec::new(),
            declarations: Vec::new(),
            truncated: false,
            selected_is_sequential: true,
        },
        &CorrelationLimits::default(),
    );
    assert_eq!(lines(&attribution.exact), vec![5]);
    assert_eq!(lines(&attribution.conditions), vec![4]);
    assert!(!attribution.approximate);
}

#[test]
fn bussed_buffer_nets_resolve_their_base_and_bit() {
    // `data_in_IBUF[3]` blocks suffix stripping until the bit splits off;
    // the base then unmangles and the bit index must survive.
    let netlist = parse_str(
        r##"{
          "modules": {
            "top": {
              "attributes": {"top": "1"},
              "ports": {"data_in": {"direction": "input", "bits": [4, 5, 6, 7]}},
              "cells": {
                "$and$top.sv:2$1": {
                  "type": "$and",
                  "attributes": {"src": "top.sv:2.10-2.20"},
                  "port_directions": {"A": "input", "B": "input", "Y": "output"},
                  "connections": {"A": [7], "B": [6], "Y": [9]}
                }
              },
              "netnames": {
                "data_in": {"bits": [4, 5, 6, 7]},
                "y": {"bits": [9]}
              }
            }
          }
        }"##,
    )
    .expect("fixture parses");
    let index =
        CorrelationIndex::build(&netlist, "top", NetlistDialect::Vivado).expect("index builds");
    assert!(index.is_boundary("data_in_IBUF[3]"));
    assert!(index.is_boundary("data_in_OBUF[0]"));
    assert!(!index.is_boundary("data_in_IBUF[9]"), "out-of-range bit");
    // The single-bit resolution binds the right bit: an attribution whose
    // inputs stop at data_in_IBUF[3] (net 7) must enclose the $and.
    let attribution = index.attribute(
        &MappedCut {
            outputs: vec!["y".to_owned()],
            inputs: vec!["data_in_IBUF[3]".to_owned(), "data_in_IBUF[2]".to_owned()],
            feeds_registers: Vec::new(),
            declarations: Vec::new(),
            truncated: false,
            selected_is_sequential: false,
        },
        &CorrelationLimits::default(),
    );
    assert_eq!(lines(&attribution.exact), vec![2]);
    assert!(!attribution.approximate);
}

#[test]
fn genuine_rtl_names_shadow_vivado_unmangling() {
    // A design may legitimately declare `q_OBUF`; exact match must win
    // over unmangling it to `q`.
    let netlist = parse_str(
        r##"{
          "modules": {
            "top": {
              "attributes": {"top": "1"},
              "ports": {"q": {"direction": "output", "bits": [2]}},
              "cells": {
                "$not$top.sv:3$1": {
                  "type": "$not",
                  "attributes": {"src": "top.sv:3.5-3.15"},
                  "port_directions": {"A": "input", "Y": "output"},
                  "connections": {"A": [4], "Y": [2]}
                }
              },
              "netnames": {
                "q": {"bits": [2]},
                "q_OBUF": {"bits": [4]}
              }
            }
          }
        }"##,
    )
    .expect("fixture parses");
    let index =
        CorrelationIndex::build(&netlist, "top", NetlistDialect::Vivado).expect("index builds");
    // Attribution whose output is the literal `q_OBUF` net (bit 4) must
    // stop there — bit 4 has no driver, so nothing is enclosed. If
    // unmangling won instead, the output would be `q` (bit 2) and the $not
    // on line 3 would be wrongly attributed.
    let attribution = index.attribute(
        &MappedCut {
            outputs: vec!["q_OBUF".to_owned()],
            inputs: Vec::new(),
            feeds_registers: Vec::new(),
            declarations: Vec::new(),
            truncated: false,
            selected_is_sequential: false,
        },
        &CorrelationLimits::default(),
    );
    assert!(attribution.exact.is_empty());
}

#[test]
fn feeds_registers_seed_the_rtl_d_cone() {
    // Crate-level: a cut that only names the register it feeds must
    // attribute the register's D-cone, flagged as a superset.
    let attribution = index().attribute(
        &MappedCut {
            outputs: Vec::new(),
            inputs: vec!["sum".to_owned(), "b".to_owned()],
            feeds_registers: vec!["q".to_owned()],
            declarations: Vec::new(),
            truncated: false,
            selected_is_sequential: false,
        },
        &CorrelationLimits::default(),
    );
    // The full D-cone is enclosed: both branch assignments (5, 6) and the
    // gated path (3) that reaches D outside the declared input boundaries.
    // A superset by design, so approximate is set.
    assert_eq!(lines(&attribution.exact), vec![3, 5, 6]);
    assert!(attribution.approximate);
}

#[test]
fn feeds_registers_exclude_enable_and_control_cones() {
    // $dffe with a combinationally-driven enable: the enable condition
    // (line 7) must not leak into the exact tier of logic that merely
    // feeds the register's D pin.
    let netlist = parse_str(
        r##"{
          "modules": {
            "top": {
              "attributes": {"top": "1"},
              "ports": {
                "clk": {"direction": "input", "bits": [2]},
                "sel": {"direction": "input", "bits": [3]},
                "a": {"direction": "input", "bits": [4]},
                "b": {"direction": "input", "bits": [6]},
                "q": {"direction": "output", "bits": [12]}
              },
              "cells": {
                "$procmux$1": {
                  "type": "$mux",
                  "attributes": {"src": "top.sv:5.13-5.22|top.sv:6.13-6.20"},
                  "port_directions": {"A": "input", "B": "input", "S": "input", "Y": "output"},
                  "connections": {"A": [4], "B": [6], "S": [3], "Y": [14]}
                },
                "$and$top.sv:7$2": {
                  "type": "$and",
                  "attributes": {"src": "top.sv:7.9-7.22"},
                  "port_directions": {"A": "input", "B": "input", "Y": "output"},
                  "connections": {"A": [3], "B": [4], "Y": [16]}
                },
                "$procdff$3": {
                  "type": "$dffe",
                  "attributes": {"src": "top.sv:4.3-7.22"},
                  "port_directions": {"CLK": "input", "D": "input", "EN": "input", "Q": "output"},
                  "connections": {"CLK": [2], "D": [14], "EN": [16], "Q": [12]}
                }
              },
              "netnames": {
                "q": {"bits": [12]},
                "a": {"bits": [4]},
                "b": {"bits": [6]},
                "sel": {"bits": [3]}
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
            outputs: Vec::new(),
            inputs: vec!["a".to_owned(), "b".to_owned(), "sel".to_owned()],
            feeds_registers: vec!["q".to_owned()],
            declarations: Vec::new(),
            truncated: false,
            selected_is_sequential: false,
        },
        &CorrelationLimits::default(),
    );
    assert_eq!(lines(&attribution.exact), vec![5, 6]);
    assert!(attribution.approximate);
}

#[test]
fn declaration_cuts_join_the_exact_tier_precisely() {
    // Declarations resolve from netname src attributes; a declaration-only
    // cut is precise, and combined with an output region the union stays
    // deduplicated under one collector.
    let attribution = index().attribute(
        &MappedCut {
            outputs: Vec::new(),
            inputs: Vec::new(),
            feeds_registers: Vec::new(),
            declarations: vec!["sum".to_owned()],
            truncated: false,
            selected_is_sequential: false,
        },
        &CorrelationLimits::default(),
    );
    // `sum`'s netname declaration span is line 2.
    assert_eq!(lines(&attribution.exact), vec![2]);
    assert!(!attribution.approximate);
    assert!(attribution.contributing.is_empty());

    let combined = index().attribute(
        &MappedCut {
            outputs: vec!["gated".to_owned()],
            inputs: vec!["sum".to_owned(), "b".to_owned()],
            feeds_registers: Vec::new(),
            declarations: vec!["gated".to_owned()],
            truncated: false,
            selected_is_sequential: false,
        },
        &CorrelationLimits::default(),
    );
    // Declaration (line 3 netname) and enclosed $and (line 3 cell) merge
    // and dedup by span under the shared cap.
    assert_eq!(lines(&combined.exact), vec![3, 3]);
    assert!(!combined.approximate);
}

#[test]
fn net_cuts_attribute_the_declaration_and_driver_before_the_upstream_cone() {
    let attribution = index().attribute_net(
        &MappedCut {
            outputs: vec!["gated".to_owned()],
            inputs: Vec::new(),
            feeds_registers: Vec::new(),
            declarations: vec!["gated".to_owned()],
            truncated: false,
            selected_is_sequential: false,
        },
        &CorrelationLimits::default(),
    );
    assert_eq!(lines(&attribution.exact), vec![3, 3]);
    assert_eq!(lines(&attribution.contributing), vec![2]);
    assert!(!attribution.approximate);
}

#[test]
fn flop_driven_net_contributing_tier_follows_only_the_data_input() {
    let netlist = parse_str(
        r##"{
          "modules": {
            "top": {
              "attributes": {"top": "1"},
              "ports": {
                "clk_seed": {"direction": "input", "bits": [2]},
                "data_seed": {"direction": "input", "bits": [3]},
                "q": {"direction": "output", "bits": [12]}
              },
              "cells": {
                "$not$clock": {
                  "type": "$not",
                  "attributes": {"src": "top.sv:2.10-2.20"},
                  "port_directions": {"A": "input", "Y": "output"},
                  "connections": {"A": [2], "Y": [4]}
                },
                "$not$data": {
                  "type": "$not",
                  "attributes": {"src": "top.sv:3.10-3.20"},
                  "port_directions": {"A": "input", "Y": "output"},
                  "connections": {"A": [3], "Y": [5]}
                },
                "$procdff$q": {
                  "type": "$dff",
                  "attributes": {"src": "top.sv:4.3-4.18"},
                  "port_directions": {"CLK": "input", "D": "input", "Q": "output"},
                  "connections": {"CLK": [4], "D": [5], "Q": [12]}
                }
              },
              "netnames": {
                "q": {"bits": [12]},
                "clk_seed": {"bits": [2]},
                "data_seed": {"bits": [3]}
              }
            }
          }
        }"##,
    )
    .expect("fixture parses");
    let index =
        CorrelationIndex::build(&netlist, "top", NetlistDialect::Yosys).expect("index builds");
    let attribution = index.attribute_net(
        &MappedCut {
            outputs: vec!["q".to_owned()],
            inputs: Vec::new(),
            feeds_registers: Vec::new(),
            declarations: Vec::new(),
            truncated: false,
            selected_is_sequential: false,
        },
        &CorrelationLimits::default(),
    );

    assert_eq!(lines(&attribution.exact), vec![4]);
    assert_eq!(lines(&attribution.contributing), vec![3]);
    assert!(!lines(&attribution.contributing).contains(&2));
}
