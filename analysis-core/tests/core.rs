use std::collections::HashSet;
use synth_explorer_analysis::analysis::{
    Analysis, ApiNodeKind, ConeDir, ConeOptions, FullNetlistOptions,
};
use synth_explorer_analysis::delay_model::DelayProfile;
use synth_explorer_analysis::design::AnalysisDesign;
use synth_explorer_analysis::graph::{Graph, NodeKind};
use synth_explorer_analysis::grouping::{
    GroupKind, GroupPartition, GroupingProjection, memory_arrays_from_source,
};
use synth_explorer_analysis::netlist::{parse_str, parse_value, select_top};

fn fixture(name: &str) -> (Graph, Analysis) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    let json = std::fs::read_to_string(path).unwrap();
    let netlist = parse_str(&json).unwrap();
    let (top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, top, module).unwrap();
    let analysis = Analysis::new(&graph, vec!["fixture.sv".to_owned()]);
    (graph, analysis)
}

fn full_options(
    max_nodes: usize,
    show_infrastructure: bool,
    hide_control: bool,
    hide_const: bool,
) -> FullNetlistOptions<'static> {
    FullNetlistOptions {
        max_nodes,
        show_infrastructure,
        hide_control,
        hide_const,
        priority_roots: &[],
    }
}

/// Two chained 8-bit register banks built from single-bit `$_DFF_P_` cells:
/// `d[i] -> q_i -> y_i -> y[i]`, so the endpoint analysis yields register
/// groups `q` and `y` of width 8 spanning eight cells each.
fn grouped_register_banks() -> (Graph, Analysis, GroupPartition) {
    let mut cells = serde_json::Map::new();
    for bit in 0u32..8 {
        cells.insert(
            format!("q_{bit}"),
            serde_json::json!({
                "type": "$_DFF_P_",
                "port_directions": { "C": "input", "D": "input", "Q": "output" },
                "connections": { "C": [2], "D": [3 + bit], "Q": [11 + bit] }
            }),
        );
        cells.insert(
            format!("y_{bit}"),
            serde_json::json!({
                "type": "$_DFF_P_",
                "port_directions": { "C": "input", "D": "input", "Q": "output" },
                "connections": { "C": [2], "D": [11 + bit], "Q": [19 + bit] }
            }),
        );
    }
    let netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "ports": {
                "clk": { "direction": "input", "bits": [2] },
                "d":   { "direction": "input", "bits": (3u32..11).collect::<Vec<_>>() },
                "y":   { "direction": "output", "bits": (19u32..27).collect::<Vec<_>>() }
            },
            "cells": cells,
            "netnames": {
                "clk": { "bits": [2] },
                "d": { "bits": (3u32..11).collect::<Vec<_>>() },
                "q": { "bits": (11u32..19).collect::<Vec<_>>() },
                "y": { "bits": (19u32..27).collect::<Vec<_>>() }
            }
        } }
    }))
    .unwrap();
    let (top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, top, module).unwrap();
    let analysis = Analysis::new(&graph, vec!["banks.sv".to_owned()]);
    let partition = GroupPartition::build(&graph, &analysis.endpoints().registers, Vec::new());
    (graph, analysis, partition)
}

fn cone_options(max_nodes: usize) -> ConeOptions<'static> {
    ConeOptions {
        dir: ConeDir::Fanin,
        max_depth: 64,
        max_nodes,
        hide_control: true,
        hide_const: true,
        show_infrastructure: false,
        root_port: None,
        root_port_bit: None,
        root_port_bits: None,
    }
}

#[test]
fn grouped_netlist_collapses_register_banks_into_group_nodes() {
    let (graph, analysis, partition) = grouped_register_banks();
    // Two register banks (q, y) plus the d/y bus ports; scalar clk stays.
    assert_eq!(partition.groups.len(), 4);
    assert_eq!(
        partition
            .groups
            .iter()
            .filter(|g| g.kind == GroupKind::Register)
            .count(),
        2
    );
    let base = graph.nodes.len() as u32;

    let plain = analysis.full_netlist(&graph, full_options(2000, false, true, false), None);
    assert!(
        plain
            .nodes
            .iter()
            .all(|node| node.width.is_none() && node.members.is_none()),
        "width/members must not appear without grouping"
    );

    let grouped = analysis.full_netlist(
        &graph,
        full_options(2000, false, true, false),
        Some(GroupingProjection::all(&partition)),
    );
    assert!(!grouped.truncated);
    // Register banks seed first (ids base+0, base+1); ports follow.
    let banks: Vec<_> = grouped
        .nodes
        .iter()
        .filter(|node| node.node.seq == Some(true))
        .collect();
    assert_eq!(banks.len(), 2);
    for (idx, node) in banks.iter().enumerate() {
        assert_eq!(node.node.id, base + idx as u32);
        assert_eq!(node.width, Some(8));
        let members = node.members.as_ref().unwrap();
        assert_eq!(members.len(), 8);
        assert!(members.windows(2).all(|pair| pair[0] < pair[1]));
        assert_eq!(node.node.cell_type.as_deref(), Some("$_DFF_P_"));
    }
    let labels: Vec<&str> = banks.iter().map(|node| node.node.name.as_str()).collect();
    assert_eq!(labels, vec!["q[7:0]", "y[7:0]"]);
    // Both multibit ports collapse to width-8 bus port nodes.
    let ports: Vec<_> = grouped
        .nodes
        .iter()
        .filter(|node| matches!(node.node.kind, ApiNodeKind::Port) && node.width == Some(8))
        .collect();
    assert_eq!(ports.len(), 2, "d and y ports each become one bus node");

    let member_ids: HashSet<u32> = partition
        .groups
        .iter()
        .flat_map(|group| group.members.iter().copied())
        .collect();
    assert!(
        grouped
            .nodes
            .iter()
            .all(|node| !member_ids.contains(&node.node.id)),
        "grouped members must not appear as raw nodes"
    );

    let bus = grouped
        .edges
        .iter()
        .find(|edge| edge.from == base && edge.to == base + 1)
        .expect("expected one merged bank-to-bank bus edge");
    assert_eq!(bus.from_port, "Q");
    assert_eq!(bus.to_port, "D");
    assert_eq!(bus.bits.len(), 8);
    assert_eq!(bus.net_name, "q");
    assert_eq!(
        grouped
            .edges
            .iter()
            .filter(|edge| edge.from == base && edge.to == base + 1)
            .count(),
        1
    );
}

#[test]
fn grouped_netlist_stacks_physical_primitives_from_one_logical_memory() {
    let final_netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "cells": {
                "memory.0.0": { "type": "RAM64M" },
                "memory.0.1": { "type": "RAM64M" },
                "memory.0.2": { "type": "RAM64M" },
                "other.0.0": { "type": "RAM64M" },
                "other.0.1": { "type": "RAM64M" }
            }
        } }
    }))
    .unwrap();
    let source_netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "memories": {
                "memory": {
                    "attributes": { "src": "fifo.sv:18.26-18.32" },
                    "width": 16,
                    "start_offset": 0,
                    "size": 128
                },
                "other": {
                    "width": 8,
                    "start_offset": 0,
                    "size": 64
                }
            }
        } }
    }))
    .unwrap();
    let design = AnalysisDesign::from_netlists(
        &final_netlist,
        &source_netlist,
        vec![("fifo.sv".to_owned(), "module top; endmodule".to_owned())],
        "xilinx",
        DelayProfile::Series7,
        false,
    )
    .unwrap();

    let memory_groups: Vec<_> = design
        .grouping
        .groups
        .iter()
        .filter(|group| group.kind == GroupKind::Memory)
        .collect();
    assert_eq!(memory_groups.len(), 2);
    assert_eq!(memory_groups[0].label, "memory [128×16]");
    assert_eq!(memory_groups[0].members.len(), 3);
    assert_eq!(memory_groups[1].label, "other [64×8]");
    assert_eq!(memory_groups[1].members.len(), 2);

    let grouped = design.analysis.full_netlist(
        &design.graph,
        full_options(2000, false, true, false),
        Some(GroupingProjection::all(&design.grouping)),
    );
    let memory = grouped
        .nodes
        .iter()
        .find(|node| node.node.name == "memory [128×16]")
        .expect("logical memory renders as one grouped node");
    assert_eq!(memory.node.cell_type.as_deref(), Some("RAM64M"));
    assert_eq!(memory.node.seq, Some(true));
    assert_eq!(memory.node.register, Some(false));
    assert_eq!(memory.width, Some(3));
    assert_eq!(memory.member_count, Some(3));
    assert_eq!(memory.members.as_deref().map(<[_]>::len), Some(3));
}

#[test]
fn grouped_netlist_keeps_mixed_vivado_lutram_shapes_in_one_memory() {
    let final_netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "cells": {
                "memory_reg_0_63_0_5": { "type": "RAM32M" },
                "memory_reg_0_63_6_11": { "type": "RAM32M" },
                "memory_reg_0_63_12_15": { "type": "RAM32X1D" }
            }
        } }
    }))
    .unwrap();
    let source_netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "memories": {
                "memory": { "width": 16, "start_offset": 0, "size": 64 }
            }
        } }
    }))
    .unwrap();
    let design = AnalysisDesign::from_netlists(
        &final_netlist,
        &source_netlist,
        vec![("fifo.sv".to_owned(), "module top; endmodule".to_owned())],
        "xilinx",
        DelayProfile::Series7,
        false,
    )
    .unwrap();

    let memories: Vec<_> = design
        .grouping
        .groups
        .iter()
        .filter(|group| group.kind == GroupKind::Memory)
        .collect();
    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0].label, "memory [64×16]");
    assert_eq!(memories[0].cell_type, "$mem");
    assert_eq!(memories[0].members.len(), 3);

    let grouped = design.analysis.full_netlist(
        &design.graph,
        full_options(100, false, true, false),
        Some(GroupingProjection::all(&design.grouping)),
    );
    let memory_nodes: Vec<_> = grouped
        .nodes
        .iter()
        .filter(|node| {
            node.node
                .cell_type
                .as_deref()
                .is_some_and(|cell_type| cell_type == "$mem")
        })
        .collect();
    assert_eq!(memory_nodes.len(), 1);
    assert_eq!(memory_nodes[0].member_count, Some(3));
}

#[test]
fn grouped_netlist_stacks_parallel_srl_lanes_without_a_source_memory() {
    let cells = (0..8)
        .map(|bit| {
            (
                format!("$auto$srl${bit}"),
                serde_json::json!({
                    "type": "SRL16E",
                    "port_directions": { "D": "input", "Q": "output" },
                    "connections": { "D": [2 + bit], "Q": [10 + bit] }
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let final_netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "ports": {
                "data_in": { "direction": "input", "bits": [2, 3, 4, 5, 6, 7, 8, 9] },
                "data_out": { "direction": "output", "bits": [10, 11, 12, 13, 14, 15, 16, 17] }
            },
            "cells": cells,
            "netnames": {
                "data_in": { "bits": [2, 3, 4, 5, 6, 7, 8, 9] },
                "data_out": { "bits": [10, 11, 12, 13, 14, 15, 16, 17] }
            }
        } }
    }))
    .unwrap();
    let source_netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "ports": {
                "data_in": { "direction": "input", "bits": [2, 3, 4, 5, 6, 7, 8, 9] },
                "data_out": { "direction": "output", "bits": [10, 11, 12, 13, 14, 15, 16, 17] }
            }
        } }
    }))
    .unwrap();
    let design = AnalysisDesign::from_netlists(
        &final_netlist,
        &source_netlist,
        vec![("srl_pipe.sv".to_owned(), "module top; endmodule".to_owned())],
        "xilinx",
        DelayProfile::Series7,
        false,
    )
    .unwrap();

    let memory = design
        .grouping
        .groups
        .iter()
        .find(|group| group.kind == GroupKind::Memory)
        .expect("parallel SRLs form one memory group");
    assert_eq!(memory.label, "data_out [16×8]");
    assert_eq!(memory.cell_type, "SRL16E");
    assert_eq!(memory.members.len(), 8);

    let grouped = design.analysis.full_netlist(
        &design.graph,
        full_options(100, false, true, false),
        Some(GroupingProjection::all(&design.grouping)),
    );
    let srl = grouped
        .nodes
        .iter()
        .find(|node| node.node.name == "data_out [16×8]")
        .expect("SRL vector renders as one grouped node");
    assert_eq!(srl.node.cell_type.as_deref(), Some("SRL16E"));
    assert_eq!(srl.node.seq, Some(true));
    assert_eq!(srl.node.register, Some(false));
    assert_eq!(srl.width, Some(8));
    assert_eq!(srl.member_count, Some(8));
}

#[test]
fn vivado_memory_matching_prefers_the_longest_logical_reg_prefix() {
    let final_netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "cells": {
                "foo_regbank_reg_0": { "type": "RAM32M" },
                "foo_regbank_reg_1": { "type": "RAM32M" }
            }
        } }
    }))
    .unwrap();
    let source_netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "memories": {
                "foo": { "width": 8, "start_offset": 0, "size": 32 },
                "foo_regbank": { "width": 16, "start_offset": 0, "size": 64 }
            }
        } }
    }))
    .unwrap();
    let (top, module) = select_top(&final_netlist, None).unwrap();
    let graph = Graph::from_netlist(&final_netlist, top, module).unwrap();

    let arrays = memory_arrays_from_source(&graph, &source_netlist, "top", &[]);

    assert_eq!(arrays.len(), 1);
    assert_eq!(arrays[0].name, "foo_regbank");
    assert_eq!(arrays[0].members.len(), 2);
}

#[test]
fn memory_matching_keeps_identical_child_arrays_in_separate_groups() {
    let final_netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "cells": {
                "u0.memory.0.0": { "type": "RAM64M" },
                "u0.memory.0.1": { "type": "RAM64M" },
                "u1.memory.0.0": { "type": "RAM64M" },
                "u1.memory.0.1": { "type": "RAM64M" }
            }
        } }
    }))
    .unwrap();
    let source_netlist = parse_value(serde_json::json!({
        "modules": {
            "top": {
                "attributes": { "top": "1" },
                "cells": {
                    "u0": { "type": "child" },
                    "u1": { "type": "child" }
                }
            },
            "child": {
                "memories": {
                    "memory": { "width": 16, "start_offset": 0, "size": 128 }
                }
            }
        }
    }))
    .unwrap();
    let (top, module) = select_top(&final_netlist, None).unwrap();
    let graph = Graph::from_netlist(&final_netlist, top, module).unwrap();

    let arrays = memory_arrays_from_source(&graph, &source_netlist, "top", &[]);

    assert_eq!(arrays.len(), 2);
    assert_eq!(arrays[0].name, "u0.memory");
    assert_eq!(arrays[0].members.len(), 2);
    assert_eq!(arrays[1].name, "u1.memory");
    assert_eq!(arrays[1].members.len(), 2);
    assert_ne!(arrays[0].members, arrays[1].members);
}

#[test]
fn grouped_budgets_count_units_not_member_bits() {
    let (graph, analysis, partition) = grouped_register_banks();
    let base = graph.nodes.len() as u32;
    // 33 raw nodes (17 port bits + 16 DFF cells) collapse to 5 units: the q and
    // y register banks, the d and y bus ports, and the lone scalar clk port bit.
    let units = 5;

    let full = analysis.full_netlist(
        &graph,
        full_options(units, false, true, false),
        Some(GroupingProjection::all(&partition)),
    );
    assert!(!full.truncated, "a cap of one per unit must fit everything");
    assert_eq!(full.nodes.len(), units);

    let capped = analysis.full_netlist(
        &graph,
        full_options(units - 1, false, true, false),
        Some(GroupingProjection::all(&partition)),
    );
    assert!(capped.truncated);
    assert!(capped.nodes.len() < units);

    // Two roots in different groups under max_nodes=1: one group survives.
    let q_root = partition.groups[0].members[0];
    let y_root = partition.groups[1].members[0];
    let cone = analysis
        .multi_root_cone(
            &graph,
            &[q_root, y_root],
            cone_options(1),
            Some(GroupingProjection::all(&partition)),
        )
        .unwrap();
    assert!(cone.truncated);
    assert_eq!(cone.nodes.len(), 1);
    assert_eq!(cone.nodes[0].node.id, base);
    assert_eq!(cone.nodes[0].is_root, Some(true));
    assert_eq!(cone.nodes[0].width, Some(1));
}

#[test]
fn grouped_cone_from_member_lands_on_its_group_root() {
    let (graph, analysis, partition) = grouped_register_banks();
    let base = graph.nodes.len() as u32;
    let member = partition.groups[1].members[0];

    let cone = analysis
        .cone(
            &graph,
            member,
            cone_options(300),
            Some(GroupingProjection::all(&partition)),
        )
        .unwrap();

    let root = cone
        .nodes
        .iter()
        .find(|node| node.node.id == base + 1)
        .expect("the requested member must land on its group node");
    assert_eq!(root.is_root, Some(true));
    assert_eq!(root.width, Some(1));
    assert_eq!(root.members.as_deref(), Some(&[member][..]));
    let feeding = cone
        .nodes
        .iter()
        .find(|node| node.node.id == base)
        .expect("the driving bank must appear as its group node");
    assert_eq!(feeding.is_boundary, Some(true));
    assert!(cone.nodes.iter().all(|node| node.node.id != member));
    assert!(
        cone.edges
            .iter()
            .any(|edge| edge.from == base && edge.to == base + 1)
    );
}

#[test]
fn parser_roundtrip_selects_binary_top_attr() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/reg_mux_rtl.json");
    let json = std::fs::read_to_string(path).unwrap();
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
                root_port: None,
                root_port_bit: None,
                root_port_bits: None,
            },
            None,
        )
        .unwrap();
    assert!(cone.nodes.iter().any(|node| node.is_root == Some(true)));
    assert!(
        cone.nodes
            .iter()
            .any(|node| matches!(node.node.kind, ApiNodeKind::Port)
                && node.is_boundary == Some(true))
    );
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
        root_port: None,
        root_port_bit: None,
        root_port_bits: None,
    };
    let envelope = analysis.envelope(&graph, &roots, options, None).unwrap();
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
    let capped = analysis
        .envelope(&graph, &roots, capped_options, None)
        .unwrap();
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
    let subgraph = analysis.full_netlist(&graph, full_options(2, false, true, false), None);
    assert_eq!(subgraph.nodes.len(), 2);
    assert!(subgraph.truncated);
}

#[test]
fn full_netlist_applies_control_and_constant_visibility_before_capping() {
    let (graph, analysis) = fixture("reg_mux_rtl.json");
    let controls_visible =
        analysis.full_netlist(&graph, full_options(100, false, false, false), None);
    assert!(
        controls_visible
            .edges
            .iter()
            .any(|edge| edge.control == Some(true)),
        "showing controls should retain the register clock edge"
    );
    let controls_hidden =
        analysis.full_netlist(&graph, full_options(100, false, true, false), None);
    assert!(
        controls_hidden
            .edges
            .iter()
            .all(|edge| edge.control != Some(true)),
        "hiding controls should remove labeled control wiring"
    );

    let netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "ports": {
                "y": { "direction": "output", "bits": [2] }
            },
            "cells": { "invert_zero": {
                "type": "$_NOT_",
                "port_directions": { "A": "input", "Y": "output" },
                "connections": { "A": ["0"], "Y": [2] }
            } },
            "netnames": { "y": { "bits": [2] } }
        } }
    }))
    .unwrap();
    let (top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, top, module).unwrap();
    let analysis = Analysis::new(&graph, vec!["const.sv".to_owned()]);
    let visible_nodes = graph
        .nodes
        .iter()
        .filter(|node| node.kind != NodeKind::Const)
        .count();

    let constants_visible = analysis.full_netlist(
        &graph,
        full_options(graph.nodes.len(), true, true, false),
        None,
    );
    assert!(
        constants_visible
            .nodes
            .iter()
            .any(|node| node.node.kind == ApiNodeKind::Const)
    );
    let constants_hidden =
        analysis.full_netlist(&graph, full_options(visible_nodes, true, true, true), None);
    assert_eq!(constants_hidden.nodes.len(), visible_nodes);
    assert!(!constants_hidden.truncated);
    assert!(
        constants_hidden
            .nodes
            .iter()
            .all(|node| node.node.kind != ApiNodeKind::Const),
        "hidden constants must not consume the visible-node budget"
    );
}

#[test]
fn memory_inputs_are_endpoints_and_unconnected_pins_are_omitted() {
    let netlist = parse_value(serde_json::json!({
        "modules": { "top": {
            "attributes": { "top": "1" },
            "ports": {
                "clk":   { "direction": "input", "bits": [2] },
                "addr":  { "direction": "input", "bits": [3, 4] },
                "wdata": { "direction": "input", "bits": [5, 6] },
                "we":    { "direction": "input", "bits": [7] },
                "rdata": { "direction": "output", "bits": [8, 9] }
            },
            "cells": { "ram": {
                "type": "RAM32M",
                "port_directions": {
                    "WCLK": "input", "ADDR": "input", "WDATA": "input",
                    "WE": "input", "TIED": "input", "UNUSED": "input",
                    "RDATA": "output"
                },
                "connections": {
                    "WCLK": [2], "ADDR": [3, 4], "WDATA": [5, 6],
                    "WE": [7], "TIED": ["0"], "UNUSED": ["x", "x"],
                    "RDATA": [8, 9]
                }
            } },
            "netnames": {
                "clk": { "bits": [2] }, "addr": { "bits": [3, 4] },
                "wdata": { "bits": [5, 6] }, "we": { "bits": [7] },
                "rdata": { "bits": [8, 9] }
            }
        } }
    }))
    .unwrap();
    let (top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, top, module).unwrap();
    let analysis = Analysis::new(&graph, vec!["memory.sv".to_owned()]);
    let ram = graph
        .nodes
        .iter()
        .find(|node| node.cell_type.as_deref() == Some("RAM32M"))
        .unwrap();
    assert_eq!(
        ram.name, "ram",
        "memory endpoints use the stable instance name"
    );

    let endpoints = analysis.endpoints();
    let endpoint_ports: Vec<_> = endpoints
        .boundaries
        .iter()
        .filter(|endpoint| endpoint.node_id == ram.id)
        .map(|endpoint| (endpoint.port.as_str(), endpoint.width))
        .collect();
    assert_eq!(
        endpoint_ports,
        vec![("ADDR", 2), ("TIED", 1), ("WDATA", 2), ("WE", 1)]
    );

    let ram_edges: Vec<_> = graph.incoming[ram.id as usize]
        .iter()
        .map(|edge| &graph.edges[*edge])
        .collect();
    assert!(ram_edges.iter().all(|edge| edge.to_port != "UNUSED"));
    assert!(
        ram_edges
            .iter()
            .any(|edge| edge.to_port == "WCLK" && edge.control)
    );
    let hidden_controls =
        analysis.full_netlist(&graph, full_options(100, false, true, false), None);
    assert!(
        hidden_controls
            .edges
            .iter()
            .all(|edge| edge.to_port != "WCLK")
    );

    let paths = analysis.paths(&graph, 100, None).paths;
    let path_ports: HashSet<_> = paths
        .iter()
        .filter(|path| path.endpoint.id == ram.id)
        .map(|path| path.endpoint_port.as_str())
        .collect();
    assert_eq!(path_ports, HashSet::from(["ADDR", "TIED", "WDATA", "WE"]));
    assert!(paths.iter().any(|path| {
        path.endpoint.id == ram.id && path.endpoint_port == "ADDR" && path.bits.contains(&1)
    }));

    let addr_cone = analysis
        .cone(
            &graph,
            ram.id,
            ConeOptions {
                dir: ConeDir::Fanin,
                max_depth: 8,
                max_nodes: 100,
                hide_control: false,
                hide_const: false,
                show_infrastructure: false,
                root_port: Some("ADDR"),
                root_port_bit: None,
                root_port_bits: None,
            },
            None,
        )
        .unwrap();
    assert!(
        addr_cone
            .edges
            .iter()
            .filter(|edge| edge.to == ram.id)
            .all(|edge| edge.to_port == "ADDR")
    );
    assert!(
        addr_cone
            .nodes
            .iter()
            .any(|node| node.node.name == "addr[0]")
    );
    assert!(
        addr_cone
            .nodes
            .iter()
            .any(|node| node.node.name == "addr[1]")
    );

    let addr_bit_cone = analysis
        .cone(
            &graph,
            ram.id,
            ConeOptions {
                root_port: Some("ADDR"),
                root_port_bit: Some(1),
                ..cone_options(100)
            },
            None,
        )
        .unwrap();
    assert!(
        addr_bit_cone
            .edges
            .iter()
            .filter(|edge| edge.to == ram.id)
            .all(|edge| edge.to_port == "ADDR")
    );
    assert!(
        addr_bit_cone
            .nodes
            .iter()
            .any(|node| node.node.name == "addr[1]")
    );
    assert!(
        addr_bit_cone
            .nodes
            .iter()
            .all(|node| node.node.name != "addr[0]")
    );

    let addr_path_cohort = analysis
        .cone(
            &graph,
            ram.id,
            ConeOptions {
                root_port: Some("ADDR"),
                root_port_bits: Some(&[1]),
                ..cone_options(100)
            },
            None,
        )
        .unwrap();
    assert!(
        addr_path_cohort
            .nodes
            .iter()
            .any(|node| node.node.name == "addr[1]")
    );
    assert!(
        addr_path_cohort
            .nodes
            .iter()
            .all(|node| node.node.name != "addr[0]")
    );

    let tied_cone = analysis
        .cone(
            &graph,
            ram.id,
            ConeOptions {
                root_port: Some("TIED"),
                ..cone_options(100)
            },
            None,
        )
        .unwrap();
    assert!(tied_cone.edges.iter().any(|edge| edge.to_port == "TIED"));
    assert!(
        tied_cone
            .nodes
            .iter()
            .any(|node| matches!(node.node.kind, ApiNodeKind::Const))
    );
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

    let subgraph = analysis.full_netlist(&graph, full_options(100, false, true, false), None);
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
    let shift = graph
        .nodes
        .iter()
        .find(|node| node.cell_type.as_deref() == Some("SRLC32E"))
        .unwrap();
    assert!(endpoints.boundaries.iter().any(|endpoint| {
        endpoint.node_id == shift.id && endpoint.name == "shift" && endpoint.port == "A"
    }));
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
    assert!(
        analysis
            .paths(&graph, 25, None)
            .paths
            .iter()
            .any(|path| { path.endpoint.id == shift.id && path.endpoint_port == "A" })
    );

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
                root_port: None,
                root_port_bit: None,
                root_port_bits: None,
            },
            None,
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
    let subgraph = analysis.full_netlist(&graph, full_options(100, false, true, false), None);
    let controls = &subgraph
        .nodes
        .into_iter()
        .find(|node| node.node.id == state.id)
        .unwrap()
        .controls;
    assert!(controls.iter().any(|control| control.pin == "SET"));
    assert!(controls.iter().any(|control| control.pin == "CLR"));
}
