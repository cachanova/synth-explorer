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
    let subgraph = analysis.full_netlist(&graph, 2);
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
