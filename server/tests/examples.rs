use synth_explorer_server::analysis::{Analysis, ConeDir, ConeOptions, FanoutResponse};
use synth_explorer_server::graph::{
    Graph, NodeKind, cell_depth_weight, is_control_pin, is_control_pin_for_cell, is_sequential_type,
};
use synth_explorer_server::netlist::{parse_value, select_top};
use synth_explorer_server::yosys::{
    MemoryHandling, SourceFile, SynthMode, SynthRequest, SynthTool, run_yosys,
};

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
        tool: SynthTool::Yosys,
        mode,
        target: None,
        extra_args: None,
    }
    .validate()
    .unwrap();
    let output = run_yosys(&request, MemoryHandling::Map).await.unwrap();
    let netlist = parse_value(output.json).unwrap();
    let (resolved_top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, resolved_top, module).unwrap();
    let analysis = Analysis::new(&graph, request.file_names());
    (graph, analysis)
}

async fn analyze_source(name: &str, source: &str, top: &str, mode: SynthMode) -> (Graph, Analysis) {
    let request = SynthRequest {
        files: vec![SourceFile {
            name: name.to_owned(),
            content: source.to_owned(),
        }],
        top: Some(top.to_owned()),
        tool: SynthTool::Yosys,
        mode,
        target: None,
        extra_args: None,
    }
    .validate()
    .unwrap();
    let output = run_yosys(&request, MemoryHandling::Map).await.unwrap();
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
async fn parameterized_example_catalog_synthesizes() {
    let manifest = std::fs::read_to_string("../examples/manifest.json").unwrap();
    let entries: Vec<serde_json::Value> = serde_json::from_str(&manifest).unwrap();
    assert_eq!(entries.len(), 13);

    for entry in entries {
        let top = entry["top"].as_str().unwrap();
        let files = entry["files"].as_array().unwrap();
        assert_eq!(files.len(), 1, "{top} should be a standalone example");
        let file = files[0].as_str().unwrap();
        let source =
            std::fs::read_to_string(std::path::Path::new("../examples").join(file)).unwrap();
        assert!(
            source.contains("#("),
            "{file} must expose design parameters"
        );

        let (graph, _analysis) = analyze_example(file, top, SynthMode::Rtl).await;
        assert!(!graph.nodes.is_empty(), "{file} produced an empty graph");
    }
}

#[tokio::test]
async fn adder_chain_is_deeper_than_reg_mux() {
    let (_reg_graph, reg) = analyze_example("reg_mux.sv", "reg_mux", SynthMode::Rtl).await;
    let (_adder_graph, adder) =
        analyze_example("adder_chain.sv", "adder_chain", SynthMode::Rtl).await;
    assert!(
        adder.stats().max_depth > reg.stats().max_depth,
        "expected adder_chain depth {} > reg_mux depth {}",
        adder.stats().max_depth,
        reg.stats().max_depth
    );
}

#[tokio::test]
async fn high_fanout_enable_ranks_large_driver() {
    let source = r#"
module high_fanout_fixture (
    input logic clk,
    input logic rst,
    input logic en,
    input logic [127:0] d_in,
    output logic [127:0] d_out
);
  logic [7:0] regs [16];
  for (genvar i = 0; i < 16; i = i + 1) begin : g_regs
    always_ff @(posedge clk) begin
      if (rst) regs[i] <= '0;
      else if (en) regs[i] <= d_in[i*8 +: 8];
    end
    assign d_out[i*8 +: 8] = regs[i];
  end
endmodule
"#;
    let (graph, analysis) = analyze_source(
        "high_fanout_fixture.sv",
        source,
        "high_fanout_fixture",
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
    let (graph, analysis) = analyze_example(
        "async_fifo_blackbox.sv",
        "async_fifo_wrapper",
        SynthMode::Rtl,
    )
    .await;
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
        let (graph, analysis) = analyze_example("reg_mux.sv", "reg_mux", mode).await;
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
async fn vendor_handshake_controller_modes_have_depth_and_lut_fanin() {
    for (mode, expected_lut, collapsed_buffer) in [
        (SynthMode::Xilinx, None, Some("OBUF")),
        (SynthMode::Ice40, Some("SB_LUT4"), None),
        (SynthMode::Ecp5, Some("LUT4"), None),
    ] {
        let (graph, analysis) =
            analyze_example("handshake_controller.sv", "handshake_controller", mode).await;
        assert!(
            analysis.stats().max_depth >= 1,
            "{mode} max_depth was {}",
            analysis.stats().max_depth
        );

        let timed_out = analysis
            .endpoints()
            .outputs
            .into_iter()
            .find(|output| output.name == "timed_out")
            .expect("expected timed_out output");
        let cone = analysis
            .cone(
                &graph,
                timed_out.bits[0].node_id,
                ConeOptions {
                    dir: ConeDir::Fanin,
                    max_depth: 64,
                    max_nodes: 300,
                    hide_control: true,
                    hide_const: true,
                    show_infrastructure: false,
                },
                None,
            )
            .expect("timed_out output node should have a fanin cone");
        let cell_types: Vec<&str> = cone
            .nodes
            .iter()
            .filter_map(|node| node.node.cell_type.as_deref())
            .collect();
        assert!(
            cell_types.iter().any(|cell_type| is_lut_cell(cell_type)),
            "{mode} timed_out fanin did not cross a LUT: {cell_types:?}"
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
                    timed_out.bits[0].node_id,
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
                    None,
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
        analyze_example("adder_chain.sv", "adder_chain", SynthMode::Xilinx).await;
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
async fn xilinx_shift_register_luts_are_stateful_boundaries_not_register_aliases() {
    let source = r#"
module shift_lut (
    input  wire       clk,
    input  wire       en,
    input  wire       d,
    input  wire [3:0] addr,
    output wire       q
);
  reg [15:0] shift;
  always @(posedge clk)
    if (en) shift <= {shift[14:0], d};
  assign q = shift[addr];
endmodule
"#;
    let (graph, analysis) =
        analyze_source("shift_lut.sv", source, "shift_lut", SynthMode::Xilinx).await;
    let srl = graph
        .nodes
        .iter()
        .find(|node| matches!(node.cell_type.as_deref(), Some("SRL16E" | "SRLC32E")))
        .expect("Xilinx synthesis should infer a shift-register LUT");
    assert!(srl.seq);
    assert!(!srl.blackbox);

    let endpoints = analysis.endpoints();
    assert!(
        endpoints
            .registers
            .iter()
            .all(|register| register.bits.iter().all(|bit| bit.node_id != srl.id))
    );
    let q = endpoints
        .outputs
        .iter()
        .find(|output| output.name == "q")
        .expect("addressable SRL output must remain a top-level output endpoint");
    assert_eq!(q.bits.len(), 1);
    assert!(
        q.worst_depth >= 1,
        "SRL address mux must contribute output depth"
    );

    let paths = analysis.paths(&graph, 25, None);
    assert!(paths.paths.iter().any(|path| {
        path.endpoint_kind == synth_explorer_server::analysis::EndpointKind::Output
            && path.endpoint_group == "q"
            && path.class == synth_explorer_server::analysis::PathClass::InputToOutput
            && path.nodes.iter().any(|node| node.id == srl.id)
    }));
    assert!(paths.paths.iter().any(|path| {
        path.endpoint.id == srl.id
            && path.endpoint_port == "D"
            && path.class == synth_explorer_server::analysis::PathClass::Other
    }));
}

#[tokio::test]
async fn xilinx_srlc32e_vector_address_contributes_output_depth() {
    let source = r#"
module shift_lut32 (
    input  wire       clk,
    input  wire       en,
    input  wire       d,
    input  wire [4:0] addr,
    output wire       q
);
  reg [31:0] shift;
  always @(posedge clk)
    if (en) shift <= {shift[30:0], d};
  assign q = shift[addr];
endmodule
"#;
    let (graph, analysis) =
        analyze_source("shift_lut32.sv", source, "shift_lut32", SynthMode::Xilinx).await;
    let srl = graph
        .nodes
        .iter()
        .find(|node| node.cell_type.as_deref() == Some("SRLC32E"))
        .expect("Xilinx synthesis should infer SRLC32E");
    assert!(
        graph.incoming[srl.id as usize]
            .iter()
            .any(|edge| graph.edges[*edge].to_port == "A")
    );
    assert!(analysis.paths(&graph, 25, None).paths.iter().any(|path| {
        path.endpoint_group == "q"
            && path.depth >= 1
            && path.nodes.iter().any(|node| node.id == srl.id)
    }));
}

#[test]
fn word_level_set_reset_cells_are_state_boundaries() {
    assert!(is_sequential_type("$sr"));
}

#[tokio::test]
async fn xilinx_register_endpoints_are_named_even_when_yosys_names_are_hidden() {
    // Write-first block-RAM inference makes memory_libmap re-emit the
    // transparency bypass registers with fresh `$auto$ff.cc:...:slice` names,
    // library-file src (ff_map.v), and no surviving user Q-net alias — the
    // same failure StreamingHistogram.v shows at scale. Naming must recover
    // from D-net aliases or fall back to a deterministic per-node label.
    let source = r#"
module hidden_regs (
    input  wire        clk,
    input  wire        we,
    input  wire [9:0]  waddr,
    input  wire [9:0]  raddr,
    input  wire [15:0] wdata,
    output reg  [15:0] rdata
);
  (* ram_style = "block" *) reg [15:0] mem [0:1023];
  always @(posedge clk) begin
    rdata <= mem[raddr];
    if (we && (waddr == raddr))
      rdata <= wdata;
    if (we)
      mem[waddr] <= wdata;
  end
endmodule
"#;
    let (graph, analysis) =
        analyze_source("hidden_regs.sv", source, "hidden_regs", SynthMode::Xilinx).await;
    assert!(
        graph.nodes.iter().any(|node| {
            node.cell_type
                .as_deref()
                .is_some_and(|t| t.starts_with("FD"))
                && node.name.starts_with('$')
        }),
        "fixture must contain flip-flops whose yosys names are hidden"
    );

    let endpoints = analysis.endpoints();
    assert!(!endpoints.registers.is_empty());
    let mut seen = std::collections::BTreeSet::new();
    for register in &endpoints.registers {
        assert!(
            !register.name.starts_with('$'),
            "register endpoint fell back to a hidden yosys name: {}",
            register.name
        );
        assert!(
            seen.insert(register.name.clone()),
            "two register endpoints share the displayed name {}",
            register.name
        );
    }
    // The bypass data registers recover their identity from the D-net alias.
    assert!(
        endpoints
            .registers
            .iter()
            .any(|group| group.name == "wdata"),
        "expected a D-net-alias-derived group, got {:?}",
        endpoints
            .registers
            .iter()
            .map(|group| (&group.name, group.width))
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn latches_are_register_endpoints_in_rtl_and_xilinx_modes() {
    let source = r#"
module latch_demo (
    input  wire gate,
    input  wire clear,
    input  wire d,
    output reg  q
);
  always @* begin
    if (clear) q = 1'b0;
    else if (gate) q = d;
  end
endmodule
"#;
    for mode in [SynthMode::Rtl, SynthMode::Xilinx] {
        let (graph, analysis) = analyze_source("latch_demo.sv", source, "latch_demo", mode).await;
        let latch = graph
            .nodes
            .iter()
            .find(|node| {
                matches!(
                    node.cell_type.as_deref(),
                    Some("$dlatch" | "$adlatch" | "LDCE" | "LDPE")
                )
            })
            .unwrap_or_else(|| panic!("{mode} should retain a latch primitive"));
        assert!(latch.seq, "{mode} latch should be a state boundary");
        assert!(
            analysis
                .endpoints()
                .registers
                .iter()
                .any(|register| register.bits.iter().any(|bit| bit.node_id == latch.id)),
            "{mode} latch should be a register endpoint"
        );
    }
}

#[tokio::test]
async fn xilinx_negative_edge_flip_flops_remain_register_endpoints() {
    let source = r#"
module negedge_ff(input wire clk, input wire d, output reg q);
  always @(negedge clk) q <= d;
endmodule
"#;
    let (graph, analysis) =
        analyze_source("negedge_ff.sv", source, "negedge_ff", SynthMode::Xilinx).await;
    let ff = graph
        .nodes
        .iter()
        .find(|node| {
            matches!(
                node.cell_type.as_deref(),
                Some("FDRE_1" | "FDSE_1" | "FDCE_1" | "FDPE_1")
            )
        })
        .expect("Xilinx synthesis should emit a negative-edge FF primitive");
    assert!(ff.seq);
    assert!(!ff.blackbox);
    assert!(
        analysis
            .endpoints()
            .registers
            .iter()
            .any(|register| register.bits.iter().any(|bit| bit.node_id == ff.id))
    );
    let clock = analysis
        .full_netlist(&graph, 100, false, true, false, None)
        .nodes
        .into_iter()
        .find(|node| node.node.id == ff.id)
        .and_then(|node| {
            node.controls
                .into_iter()
                .find(|control| control.role == synth_explorer_server::analysis::ControlRole::Clock)
        })
        .expect("negative-edge FF clock metadata");
    assert_eq!(clock.active_low, Some(true));
}

#[tokio::test]
async fn vendor_flip_flops_are_sequential_with_control_edges() {
    for (mode, ff_type, expected_control_ports) in [
        (SynthMode::Xilinx, "FDRE", &["C", "CE", "R"][..]),
        (SynthMode::Ice40, "SB_DFFSR", &["C", "R"][..]),
        (SynthMode::Ecp5, "TRELLIS_FF", &["CLK", "LSR"][..]),
    ] {
        let (graph, analysis) =
            analyze_example("handshake_controller.sv", "handshake_controller", mode).await;
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

        let schematic = analysis.full_netlist(&graph, 2000, false, true, false, None);
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
    let (graph, _analysis) = analyze_example("reg_mux.sv", "reg_mux", SynthMode::Rtl).await;
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

#[tokio::test]
async fn abstract_memory_handling_keeps_mem_cells_unmapped_in_generic_modes() {
    // The abstract retry path runs the generic pipeline while leaving memories
    // as `$mem_v2` cells. Exercised directly (not through an OOM) so it is
    // deterministic across Yosys versions and sandbox limits.
    let source = r#"
module mem_top (
    input  wire        clk,
    input  wire        we,
    input  wire [9:0]  waddr,
    input  wire [31:0] wdata,
    input  wire [9:0]  raddr,
    output reg  [31:0] rdata
);
  reg [31:0] mem [0:1023];
  always @(posedge clk) begin
    if (we) mem[waddr] <= wdata;
    rdata <= mem[raddr];
  end
endmodule
"#;
    let request = SynthRequest {
        files: vec![SourceFile {
            name: "mem_top.v".to_owned(),
            content: source.to_owned(),
        }],
        top: Some("mem_top".to_owned()),
        tool: SynthTool::Yosys,
        mode: SynthMode::Gates,
        target: None,
        extra_args: None,
    }
    .validate()
    .unwrap();

    let abstract_out = run_yosys(&request, MemoryHandling::Abstract).await.unwrap();
    let netlist = parse_value(abstract_out.json).unwrap();
    let (top, module) = select_top(&netlist, None).unwrap();
    let graph = Graph::from_netlist(&netlist, top, module).unwrap();
    assert!(
        graph.nodes.iter().any(|node| node
            .cell_type
            .as_deref()
            .is_some_and(|cell_type| cell_type.starts_with("$mem"))),
        "abstract handling must retain a $mem cell in generic mode"
    );
}
