use std::collections::HashSet;
use synth_explorer_server::analysis::{Analysis, ConeDir, ConeOptions};
use synth_explorer_server::graph::{Graph, NodeKind};
use synth_explorer_server::netlist::{parse_str, select_top};

fn fixture(name: &str) -> (Graph, Analysis) {
    let json = std::fs::read_to_string(format!("tests/fixtures/{name}")).unwrap();
    let netlist = parse_str(&json).unwrap();
    let (top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, top, module).unwrap();
    let analysis = Analysis::new(&graph, vec!["fixture.sv".to_owned()]);
    (graph, analysis)
}

#[test]
fn parser_roundtrip_selects_binary_top_attr() {
    let json = std::fs::read_to_string("tests/fixtures/reg_mux_rtl.json").unwrap();
    let netlist = parse_str(&json).unwrap();
    let (top, module) = select_top(&netlist, None).unwrap();
    assert_eq!(top, "top");
    assert_eq!(module.cells.len(), 2);
    assert!(module.ports.contains_key("q"));
}

#[test]
fn graph_construction_has_seq_cell_and_edges() {
    let (graph, _analysis) = fixture("reg_mux_rtl.json");
    let seq_cells: Vec<_> = graph.nodes.iter().filter(|node| node.seq).collect();
    assert_eq!(seq_cells.len(), 1);
    assert_eq!(seq_cells[0].name, "q");
    assert!(graph.edges.len() >= 25);
}

#[test]
fn cone_stops_at_boundary_nodes() {
    let (graph, analysis) = fixture("reg_mux_rtl.json");
    let q = analysis.endpoints().registers[0].bits[0].node_id;
    let cone = analysis
        .cone(
            &graph,
            q,
            ConeOptions {
                dir: ConeDir::Fanin,
                max_depth: 8,
                max_nodes: 300,
                hide_control: true,
                hide_const: true,
                show_infrastructure: false,
            },
        )
        .unwrap();
    assert!(cone.nodes.iter().any(|node| node.is_root == Some(true)));
    assert!(cone.nodes.iter().any(|node| matches!(
        node.node.kind,
        synth_explorer_server::analysis::ApiNodeKind::Port
    ) && node.is_boundary == Some(true)));
}

#[test]
fn multi_root_envelope_unions_sibling_cones_with_one_shared_cap() {
    let (graph, analysis) = fixture("high_fanout_enable_gates.json");
    let roots: Vec<_> = graph
        .nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Cell)
        .take(2)
        .map(|node| node.id)
        .collect();
    assert_eq!(roots.len(), 2);

    let options = ConeOptions {
        dir: ConeDir::Fanin,
        max_depth: 8,
        max_nodes: 20,
        hide_control: false,
        hide_const: true,
        show_infrastructure: false,
    };
    let envelope = analysis.envelope(&graph, &roots, options).unwrap();
    assert!(!envelope.truncated);
    assert!(envelope.nodes.len() <= options.max_nodes);
    assert!(roots.iter().all(|root| {
        envelope
            .nodes
            .iter()
            .any(|node| node.node.id == *root && node.is_root == Some(true))
    }));
    assert!(roots.iter().all(|root| {
        envelope.edges.iter().any(|edge| edge.to == *root)
            && envelope.edges.iter().any(|edge| edge.from == *root)
    }));

    let node_ids: HashSet<_> = envelope.nodes.iter().map(|node| node.node.id).collect();
    assert_eq!(node_ids.len(), envelope.nodes.len());
    let edge_ids: HashSet<_> = envelope
        .edges
        .iter()
        .map(|edge| (edge.from, edge.to, &edge.from_port, &edge.to_port))
        .collect();
    assert_eq!(edge_ids.len(), envelope.edges.len());
    assert!(node_ids.iter().any(|candidate| {
        roots.iter().all(|root| {
            envelope
                .edges
                .iter()
                .any(|edge| edge.from == *candidate && edge.to == *root)
        })
    }));

    let capped_options = ConeOptions {
        max_nodes: roots.len() + 2,
        ..options
    };
    let capped = analysis.envelope(&graph, &roots, capped_options).unwrap();
    assert!(capped.nodes.len() <= capped_options.max_nodes);
    assert!(capped.truncated);
    assert!(capped.edges.iter().any(|edge| roots.contains(&edge.to)));
    assert!(capped.edges.iter().any(|edge| roots.contains(&edge.from)));
}

#[test]
fn fanout_counts_direct_sinks() {
    let (graph, analysis) = fixture("high_fanout_enable_gates.json");
    let fanout = analysis.fanout(&graph, 10);
    let en = fanout
        .drivers
        .iter()
        .find(|driver| driver.net_name == "en")
        .expect("expected enable fanout driver");
    assert!(en.fanout >= 8);
    assert!(en.control);
}

#[test]
fn full_netlist_caps_nodes() {
    let (graph, analysis) = fixture("and_chain_rtl.json");
    let subgraph = analysis.full_netlist(&graph, 2, false);
    assert_eq!(subgraph.nodes.len(), 2);
    assert!(subgraph.truncated);
}

#[test]
fn comb_loop_nodes_are_comb_cells() {
    let (graph, analysis) = fixture("comb_loop_rtl.json");
    assert_eq!(analysis.comb_loops.len(), 2);
    assert!(
        analysis
            .comb_loops
            .iter()
            .all(|id| graph.nodes[*id as usize].kind == NodeKind::Cell)
    );
}

#[test]
fn xilinx_latch_gate_and_inverted_control_metadata_are_preserved() {
    let netlist = parse_str(
        r#"{
          "modules": { "top": {
            "attributes": { "top": "1" },
            "ports": {
              "g":   { "direction": "input",  "bits": [2] },
              "clr": { "direction": "input",  "bits": [3] },
              "d":   { "direction": "input",  "bits": [4] },
              "q":   { "direction": "output", "bits": [5] }
            },
            "cells": { "latch": {
              "type": "LDCPE",
              "parameters": {
                "IS_G_INVERTED": "1",
                "IS_CLR_INVERTED": "1"
              },
              "port_directions": {
                "G": "input", "GE": "input", "CLR": "input",
                "PRE": "input", "D": "input", "Q": "output"
              },
              "connections": {
                "G": [2], "GE": ["1"], "CLR": [3], "PRE": ["0"],
                "D": [4], "Q": [5]
              }
            } },
            "netnames": {
              "g": { "bits": [2] }, "clr": { "bits": [3] },
              "d": { "bits": [4] }, "q": { "bits": [5] }
            }
          } }
        }"#,
    )
    .unwrap();
    let (top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, top, module).unwrap();
    let analysis = Analysis::new(&graph, vec!["fixture.sv".to_owned()]);
    let latch = graph
        .nodes
        .iter()
        .find(|node| node.cell_type.as_deref() == Some("LDCPE"))
        .unwrap();

    assert_eq!(
        latch.params.get("IS_G_INVERTED").map(String::as_str),
        Some("1")
    );
    let endpoints = analysis.endpoints();
    let endpoint = endpoints
        .registers
        .iter()
        .find(|register| register.bits.iter().any(|bit| bit.node_id == latch.id))
        .unwrap();
    assert_eq!(endpoint.clock.as_deref(), Some("g"));

    let subgraph = analysis.full_netlist(&graph, 100, false);
    let reset = subgraph
        .nodes
        .iter()
        .find(|node| node.node.id == latch.id)
        .unwrap()
        .controls
        .iter()
        .find(|control| control.pin == "CLR")
        .unwrap();
    assert_eq!(reset.active_low, Some(true));
}

#[test]
fn srl_address_feedback_is_reported_as_a_combinational_loop() {
    let netlist = parse_str(
        r#"{
          "modules": { "top": {
            "attributes": { "top": "1" },
            "ports": {
              "d":   { "direction": "input",  "bits": [4] },
              "clk": { "direction": "input",  "bits": [5] },
              "q":   { "direction": "output", "bits": [2] }
            },
            "cells": {
              "shift": {
                "type": "SRLC32E",
                "port_directions": {
                  "A": "input", "D": "input", "CE": "input",
                  "CLK": "input", "Q": "output"
                },
                "connections": {
                  "A": [3], "D": [4], "CE": ["1"], "CLK": [5], "Q": [2]
                }
              },
              "feedback": {
                "type": "LUT1",
                "port_directions": { "I0": "input", "O": "output" },
                "connections": { "I0": [2], "O": [3] }
              }
            },
            "netnames": {
              "q": { "bits": [2] }, "address": { "bits": [3] },
              "d": { "bits": [4] }, "clk": { "bits": [5] }
            }
          } }
        }"#,
    )
    .unwrap();
    let (top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, top, module).unwrap();
    let analysis = Analysis::new(&graph, vec!["fixture.sv".to_owned()]);
    let loop_types: HashSet<_> = analysis
        .comb_loops
        .iter()
        .filter_map(|id| graph.nodes[*id as usize].cell_type.as_deref())
        .collect();
    assert_eq!(loop_types, HashSet::from(["SRLC32E", "LUT1"]));
}

#[test]
fn srlc32e_fixed_tap_does_not_inherit_address_depth() {
    let netlist = parse_str(
        r#"{
          "modules": { "top": {
            "attributes": { "top": "1" },
            "ports": {
              "address": { "direction": "input",  "bits": [3] },
              "d":       { "direction": "input",  "bits": [4] },
              "clk":     { "direction": "input",  "bits": [5] },
              "q":       { "direction": "output", "bits": [2] },
              "q31":     { "direction": "output", "bits": [6] }
            },
            "cells": { "shift": {
              "type": "SRLC32E",
              "port_directions": {
                "A": "input", "D": "input", "CE": "input", "CLK": "input",
                "Q": "output", "Q31": "output"
              },
              "connections": {
                "A": [3], "D": [4], "CE": ["1"], "CLK": [5],
                "Q": [2], "Q31": [6]
              }
            } },
            "netnames": {
              "q": { "bits": [2] }, "address": { "bits": [3] },
              "d": { "bits": [4] }, "clk": { "bits": [5] },
              "q31": { "bits": [6] }
            }
          } }
        }"#,
    )
    .unwrap();
    let (top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, top, module).unwrap();
    let analysis = Analysis::new(&graph, vec!["fixture.sv".to_owned()]);
    let endpoints = analysis.endpoints();
    let q = endpoints
        .outputs
        .iter()
        .find(|output| output.name == "q")
        .unwrap();
    let q31 = endpoints
        .outputs
        .iter()
        .find(|output| output.name == "q31")
        .unwrap();
    assert_eq!(q.worst_depth, 1);
    assert_eq!(q31.worst_depth, 0);

    let q31_path = analysis
        .paths(&graph, 25, None)
        .paths
        .into_iter()
        .find(|path| path.endpoint_group == "q31")
        .unwrap();
    assert_eq!(q31_path.depth, 0);
    assert!(q31_path.nodes.iter().all(|node| node.name != "address"));

    let cone = analysis
        .cone(
            &graph,
            q31.bits[0].node_id,
            ConeOptions {
                dir: ConeDir::Fanin,
                max_depth: 8,
                max_nodes: 100,
                hide_control: true,
                hide_const: true,
                show_infrastructure: false,
            },
        )
        .unwrap();
    assert!(cone.nodes.iter().all(|node| node.node.name != "address"));
}

#[test]
fn word_level_sr_set_and_clear_are_control_pins() {
    let netlist = parse_str(
        r#"{
          "modules": { "top": {
            "attributes": { "top": "1" },
            "ports": {
              "set": { "direction": "input", "bits": [2] },
              "clr": { "direction": "input", "bits": [3] },
              "q":   { "direction": "output", "bits": [4] }
            },
            "cells": { "state": {
              "type": "$sr",
              "parameters": { "SET_POLARITY": "1", "CLR_POLARITY": "1" },
              "port_directions": { "SET": "input", "CLR": "input", "Q": "output" },
              "connections": { "SET": [2], "CLR": [3], "Q": [4] }
            } },
            "netnames": {
              "set": { "bits": [2] }, "clr": { "bits": [3] }, "q": { "bits": [4] }
            }
          } }
        }"#,
    )
    .unwrap();
    let (top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, top, module).unwrap();
    let analysis = Analysis::new(&graph, vec!["fixture.sv".to_owned()]);
    let state = graph
        .nodes
        .iter()
        .find(|node| node.cell_type.as_deref() == Some("$sr"))
        .unwrap();
    let incoming: Vec<_> = graph.incoming[state.id as usize]
        .iter()
        .map(|edge| &graph.edges[*edge])
        .collect();
    assert!(incoming.iter().all(|edge| edge.control));
    let subgraph = analysis.full_netlist(&graph, 100, false);
    let controls = &subgraph
        .nodes
        .into_iter()
        .find(|node| node.node.id == state.id)
        .unwrap()
        .controls;
    assert!(controls.iter().any(|control| control.pin == "SET"));
    assert!(controls.iter().any(|control| control.pin == "CLR"));
}
