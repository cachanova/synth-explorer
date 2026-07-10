use synth_explorer_server::analysis::{Analysis, ConeDir, ConeOptions, FanoutResponse};
use synth_explorer_server::graph::{
    Graph, NodeKind, cell_depth_weight, is_control_pin, is_control_pin_for_cell,
};
use synth_explorer_server::netlist::{parse_value, select_top};
use synth_explorer_server::yosys::{SourceFile, SynthMode, SynthRequest, run_yosys};

async fn analyze_example(name: &str, top: &str, mode: SynthMode) -> (Graph, Analysis) {
    let path = std::path::Path::new("../examples").join(name);
    assert!(path.exists(), "missing example file {}", path.display());
    let content = std::fs::read_to_string(&path).unwrap();
    let request = SynthRequest {
        files: vec![SourceFile {
            name: name.to_owned(),
            content,
        }],
        top: Some(top.to_owned()),
        mode,
        extra_args: None,
    }
    .validate()
    .unwrap();
    let output = run_yosys(&request).await.unwrap();
    let netlist = parse_value(output.json).unwrap();
    let (resolved_top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, resolved_top, module).unwrap();
    let analysis = Analysis::new(&graph, request.file_names());
    (graph, analysis)
}

fn is_lut_cell(cell_type: &str) -> bool {
    matches!(
        cell_type,
        "LUT1" | "LUT2" | "LUT3" | "LUT4" | "LUT5" | "LUT6" | "SB_LUT4"
    )
}

#[tokio::test]
async fn adder_chain_is_deeper_than_reg_mux() {
    let (_reg_graph, reg) = analyze_example("01_reg_mux.sv", "reg_mux", SynthMode::Rtl).await;
    let (_adder_graph, adder) =
        analyze_example("03_adder_chain.sv", "adder_chain", SynthMode::Rtl).await;
    assert!(
        adder.stats().max_depth > reg.stats().max_depth,
        "expected adder_chain depth {} > reg_mux depth {}",
        adder.stats().max_depth,
        reg.stats().max_depth
    );
}

#[tokio::test]
async fn high_fanout_enable_ranks_large_driver() {
    let (graph, analysis) = analyze_example(
        "04_high_fanout_enable.sv",
        "high_fanout_enable",
        SynthMode::Gates,
    )
    .await;
    let fanout: FanoutResponse = analysis.fanout(&graph, 5);
    let endpoints = analysis.endpoints();
    assert_eq!(analysis.stats().num_register_bits, 128);
    assert_eq!(analysis.stats().num_register_groups, 16);
    assert_eq!(endpoints.registers.len(), 16);
    assert!(
        endpoints
            .registers
            .iter()
            .all(|group| group.name.starts_with("regs[") && group.width == 8)
    );
    assert!(
        fanout
            .drivers
            .first()
            .is_some_and(|driver| driver.fanout >= 16),
        "top fanout driver was {:?}",
        fanout.drivers.first()
    );
}

#[tokio::test]
async fn blackbox_is_seq_like_boundary() {
    let (graph, analysis) =
        analyze_example("07_blackbox.sv", "blackbox_demo", SynthMode::Rtl).await;
    assert!(
        graph
            .nodes
            .iter()
            .any(|node| node.kind == NodeKind::Cell && node.blackbox && node.seq)
    );
    assert!(
        analysis
            .warnings()
            .iter()
            .any(|warning| warning.contains("blackbox boundary"))
    );
}

#[tokio::test]
async fn reg_mux_endpoints_include_q_width_8() {
    for mode in [SynthMode::Rtl, SynthMode::Xilinx] {
        let (graph, analysis) = analyze_example("01_reg_mux.sv", "reg_mux", mode).await;
        let endpoints = analysis.endpoints();
        let q = endpoints
            .registers
            .iter()
            .find(|group| group.name == "q" && group.width == 8)
            .unwrap_or_else(|| {
                panic!(
                    "expected q register group in {mode}; got {:?}",
                    endpoints
                        .registers
                        .iter()
                        .map(|group| (&group.name, group.width))
                        .collect::<Vec<_>>()
                )
            });
        assert_eq!(q.output_aliases.len(), 1, "mode {mode}");
        assert_eq!(q.output_aliases[0].name, "q");
        assert_eq!(q.output_aliases[0].bits.len(), 8);
        assert!(endpoints.outputs.iter().all(|output| output.name != "q"));

        let paths = analysis.paths(&graph, 25, None);
        assert!(paths.paths.iter().any(|path| {
            path.endpoint_group == "q"
                && path.output_aliases.iter().any(|alias| alias.name == "q")
                && !path.bits.is_empty()
        }));
    }
}

#[tokio::test]
async fn vendor_fsm_modes_have_depth_and_lut_fanin() {
    for (mode, expected_lut, collapsed_buffer) in [
        (SynthMode::Xilinx, None, Some("OBUF")),
        (SynthMode::Ice40, Some("SB_LUT4"), None),
        (SynthMode::Ecp5, Some("LUT4"), None),
    ] {
        let (graph, analysis) = analyze_example("08_fsm.sv", "fsm", mode).await;
        assert!(
            analysis.stats().max_depth >= 1,
            "{mode} max_depth was {}",
            analysis.stats().max_depth
        );

        let valid = analysis
            .endpoints()
            .outputs
            .into_iter()
            .find(|output| output.name == "valid")
            .expect("expected valid output");
        let cone = analysis
            .cone(
                &graph,
                valid.bits[0].node_id,
                ConeOptions {
                    dir: ConeDir::Fanin,
                    max_depth: 64,
                    max_nodes: 300,
                    hide_control: true,
                    hide_const: true,
                    show_infrastructure: false,
                },
            )
            .expect("valid output node should have a fanin cone");
        let cell_types: Vec<&str> = cone
            .nodes
            .iter()
            .filter_map(|node| node.node.cell_type.as_deref())
            .collect();
        assert!(
            cell_types.iter().any(|cell_type| is_lut_cell(cell_type)),
            "{mode} valid fanin did not cross a LUT: {cell_types:?}"
        );
        if let Some(expected) = expected_lut {
            assert!(cell_types.contains(&expected));
        }
        if let Some(expected) = collapsed_buffer {
            assert!(
                !cell_types.contains(&expected),
                "{expected} should be collapsed from the default analysis cone"
            );
            let implementation_cone = analysis
                .cone(
                    &graph,
                    valid.bits[0].node_id,
                    ConeOptions {
                        show_infrastructure: true,
                        ..ConeOptions {
                            dir: ConeDir::Fanin,
                            max_depth: 64,
                            max_nodes: 300,
                            hide_control: true,
                            hide_const: true,
                            show_infrastructure: false,
                        }
                    },
                )
                .unwrap();
            assert!(
                implementation_cone
                    .nodes
                    .iter()
                    .any(|node| { node.node.cell_type.as_deref() == Some(expected) })
            );
        }
    }
}

#[tokio::test]
async fn xilinx_adder_depth_excludes_buffers() {
    let (graph, analysis) =
        analyze_example("03_adder_chain.sv", "adder_chain", SynthMode::Xilinx).await;
    let path = analysis
        .paths(&graph, 1, None)
        .paths
        .into_iter()
        .next()
        .expect("expected a critical path");
    let buffer_count = path
        .nodes
        .iter()
        .filter_map(|node| node.cell_type.as_deref())
        .filter(|cell_type| cell_depth_weight(cell_type) == 0)
        .count();
    let weighted_comb_count = path
        .nodes
        .iter()
        .filter(|node| node.seq != Some(true))
        .filter_map(|node| node.cell_type.as_deref())
        .filter(|cell_type| cell_depth_weight(cell_type) != 0)
        .count();

    assert!(analysis.stats().max_depth >= 2);
    assert_eq!(
        buffer_count, 0,
        "infrastructure should be collapsed from paths"
    );
    assert_eq!(path.depth as usize, weighted_comb_count);
}

#[tokio::test]
async fn vendor_flip_flops_are_sequential_with_control_edges() {
    for (mode, ff_type, expected_control_ports) in [
        (SynthMode::Xilinx, "FDRE", &["C", "CE", "R"][..]),
        (SynthMode::Ice40, "SB_DFFSR", &["C", "R"][..]),
        (SynthMode::Ecp5, "TRELLIS_FF", &["CLK", "LSR"][..]),
    ] {
        let (graph, analysis) = analyze_example("08_fsm.sv", "fsm", mode).await;
        let ff = graph
            .nodes
            .iter()
            .find(|node| node.cell_type.as_deref() == Some(ff_type))
            .unwrap_or_else(|| panic!("{mode} did not emit {ff_type}"));
        assert!(ff.seq, "{ff_type} was not sequential");
        assert!(!ff.blackbox, "{ff_type} was classified as a blackbox");

        let incoming = graph.incoming[ff.id as usize]
            .iter()
            .map(|edge_idx| &graph.edges[*edge_idx])
            .collect::<Vec<_>>();
        for port in expected_control_ports {
            assert!(
                incoming
                    .iter()
                    .any(|edge| edge.to_port == *port && edge.control),
                "{ff_type} port {port} was not tagged control"
            );
        }
        assert!(
            incoming
                .iter()
                .any(|edge| edge.to_port == "D" || edge.to_port == "DI")
        );
        assert!(
            incoming
                .iter()
                .filter(|edge| edge.to_port == "D" || edge.to_port == "DI")
                .all(|edge| !edge.control)
        );

        let schematic = analysis.full_netlist(&graph, 2000, false);
        let rendered_ff = schematic
            .nodes
            .iter()
            .find(|node| node.node.id == ff.id)
            .expect("FF should remain in the schematic projection");
        assert!(rendered_ff.controls.iter().any(|control| {
            control.role == synth_explorer_server::analysis::ControlRole::Clock
        }));
        assert!(schematic.edges.iter().all(|edge| {
            edge.to != ff.id
                || !rendered_ff
                    .controls
                    .iter()
                    .any(|control| control.driver_id == edge.from && control.pin == edge.to_port)
        }));
    }
}

#[test]
fn vendor_flip_flop_control_pin_names_are_tagged() {
    for pin in ["CLK", "CE", "CLR", "PRE", "LSR", "SR"] {
        assert!(is_control_pin(pin), "{pin} should be a control pin");
    }
    for context_dependent in ["C", "E", "R", "S"] {
        assert!(!is_control_pin(context_dependent));
    }
    assert!(!is_control_pin("D"));
    assert!(!is_control_pin("DI"));
    assert!(is_control_pin_for_cell("FDRE", "S"));
    assert!(!is_control_pin_for_cell("$_MUX_", "S"));
}

#[tokio::test]
async fn mux_select_is_a_data_dependency_not_a_set_reset_control() {
    let (graph, _analysis) = analyze_example("01_reg_mux.sv", "reg_mux", SynthMode::Rtl).await;
    let mux = graph
        .nodes
        .iter()
        .find(|node| node.cell_type.as_deref() == Some("$mux"))
        .expect("expected RTL mux");
    let select_edges: Vec<_> = graph.incoming[mux.id as usize]
        .iter()
        .map(|idx| &graph.edges[*idx])
        .filter(|edge| edge.to_port == "S")
        .collect();
    assert!(!select_edges.is_empty());
    assert!(select_edges.iter().all(|edge| !edge.control));
}
