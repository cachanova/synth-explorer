use synth_explorer_server::analysis::{Analysis, FanoutResponse};
use synth_explorer_server::graph::{Graph, NodeKind};
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
    let (_graph, analysis) = analyze_example("01_reg_mux.sv", "reg_mux", SynthMode::Rtl).await;
    let endpoints = analysis.endpoints();
    assert!(
        endpoints
            .registers
            .iter()
            .any(|group| group.name == "q" && group.width == 8)
    );
}
