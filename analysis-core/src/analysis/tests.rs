use super::*;
use crate::graph::{CellInfo, Edge, Graph, Node, NodeKind};
use crate::grouping::{Group, GroupKind};
use crate::netlist::{PortDirection, YosysBit, parse_str, select_top};
use crate::source::{
    SOURCE_LINE_RESPONSE_CAP, SOURCE_PROBE_TARGET_VISIT_CAP, SOURCE_RANGE_INDEX_CAP,
    SOURCE_RANGE_RESPONSE_CAP, SOURCE_ROOT_COLLECTION_CAP, SourceProbeHintKind,
};
use std::time::Instant;

type EdgeSignature = (
    NodeId,
    NodeId,
    String,
    String,
    String,
    Vec<u32>,
    Option<bool>,
);

fn full_options(
    max_nodes: usize,
    show_infrastructure: bool,
    hide_control: bool,
    hide_const: bool,
    priority_roots: &[NodeId],
) -> FullNetlistOptions<'_> {
    FullNetlistOptions {
        max_nodes,
        show_infrastructure,
        hide_control,
        hide_const,
        priority_roots,
    }
}

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

/// The retired `paths` wrapper's shape: default delay model, depth sort.
fn depth_paths(analysis: &Analysis, graph: &Graph, limit: usize) -> PathsResponse {
    analysis.paths_with_model(graph, &DelayModel::default(), limit, None, PathSort::Depth)
}

#[test]
fn depth_dp_counts_three_and_levels() {
    let (_graph, analysis) = fixture("and_chain_rtl.json");
    assert_eq!(analysis.stats.max_depth, 3);
    let paths = depth_paths(&analysis, &_graph, 5);
    assert_eq!(paths.paths[0].depth, 3);
}

#[test]
fn estimates_a_positive_critical_path_delay() {
    let (graph, analysis) = fixture("and_chain_rtl.json");
    let est = analysis
        .stats
        .estimated_delay_ns
        .expect("a combinational design has a delay estimate");
    // A depth-3 chain: a few cells + fanout nets + capture setup — the rough
    // pre-route figure should be positive and in a sane nanosecond range.
    assert!(est > 0.3 && est < 30.0, "implausible estimate: {est} ns");
    let timing = analysis.estimate_timing(&graph, &DelayModel::default());
    assert_eq!(timing.starts_at_register, Some(false));
    assert_eq!(timing.endpoint_kind, Some(EndpointKind::Output));
}

/// The single node of `cell_type` in a fixture, by cell name.
fn cell_named<'a>(graph: &'a Graph, name: &str) -> &'a Node {
    graph
        .nodes
        .iter()
        .find(|node| node.name == name)
        .unwrap_or_else(|| panic!("fixture has a cell named {name}"))
}

#[test]
fn clock_distribution_is_not_a_data_path() {
    // `synth_xilinx` defaults emit clk -> IBUF -> BUFG -> every FDRE's C
    // pin. Walked as ordinary combinational logic that chain charges a cell
    // delay per buffer and then a register setup, so a shallow sequential
    // design reports its own clock tree as the critical path.
    let (graph, analysis) = fixture("pipe_clock_tree_xilinx.json");

    // The clock buffer and the IBUF feeding it carry a clock, not data.
    let bufg = cell_named(&graph, "$auto$clkbufmap.cc:261:execute$1720");
    assert_eq!(bufg.cell_type.as_deref(), Some("BUFG"));
    assert!(graph.is_clock_network(bufg.id));
    assert!(graph.is_clock_network(cell_named(&graph, "$iopadmap$pipe.clk").id));

    // An IBUF on a *data* port stays a data-path node — the rule is about
    // where a signal goes, not which primitive drives it. `en` and `rst`
    // land on control pins (CE/R) but are still real signals, not clocks.
    for data_port in [
        "$iopadmap$pipe.data_in",
        "$iopadmap$pipe.data_in_7",
        "$iopadmap$pipe.en",
        "$iopadmap$pipe.rst",
    ] {
        let node = cell_named(&graph, data_port);
        assert!(
            !graph.is_clock_network(node.id),
            "{data_port} is not part of the clock network",
        );
    }

    let model = DelayModel::series7();
    let est = analysis.estimate_timing(&graph, &model);
    let bd = est.breakdown.expect("a registered design has a breakdown");
    // The reported path must be a *data* path. Which one is worst depends
    // on the coefficients — a bare FF->FF hop (clk-to-Q + route) or a data
    // input through its IBUF (two routes + one cell) — but the clock chain
    // (IBUF + BUFG + every FF's C pin) must never be walked. The bug
    // charged both clock buffers as logic: logic_ns of 2x cell_ps. A data
    // path through at most the port IBUF can never carry more than one.
    assert!(
        bd.logic_ns <= model.cell_ps / 1000.0 + 1e-9,
        "at most the data-port IBUF is logic, never the IBUF+BUFG clock \
             chain: {} ns",
        bd.logic_ns,
    );
    assert_eq!(bd.setup_ns, model.ff_setup_ps / 1000.0);
    let delay = est.delay_ns.expect("a registered design has an estimate");
    // Exactly the worse of the two real data paths, from the model itself.
    let ff_hop = model.ff_clk_to_q_ps + model.net_delay_ps(1);
    let input_hop = 2.0 * model.net_delay_ps(1) + model.cell_ps;
    let expected = (ff_hop.max(input_hop) + model.ff_setup_ps) / 1000.0;
    assert!(
        (delay - expected).abs() < 1e-9,
        "a data path, not the clock tree: {delay} vs {expected}",
    );
}

#[test]
fn register_to_register_design_is_a_timing_path() {
    // Nothing but 32 FDREs (`-noiopad -noclkbuf`): zero combinational
    // cells. The DP only walks combinational nodes, so this design used to
    // produce no estimate at all where a vendor tool reports a real
    // clk-to-Q + route + setup number. A direct register->register
    // connection is a timing path with zero logic levels.
    let (graph, analysis) = fixture("pipe_registers_only_xilinx.json");
    assert!(
        !graph.nodes.iter().any(|node| graph.is_comb(node.id)),
        "fixture is registers only",
    );

    let model = DelayModel::series7();
    let est = analysis.estimate_timing(&graph, &model);
    let delay = est
        .delay_ns
        .expect("a register-to-register design has an estimate");
    let bd = est.breakdown.expect("and a breakdown");
    assert_eq!(bd.launch_ns, model.ff_clk_to_q_ps / 1000.0);
    assert_eq!(bd.logic_ns, 0.0, "a direct FF->FF hop has no logic levels");
    assert_eq!(bd.net_ns, model.net_delay_ps(1) / 1000.0);
    assert_eq!(bd.setup_ns, model.ff_setup_ps / 1000.0);
    assert_eq!(est.starts_at_register, Some(true));
    assert_eq!(est.endpoint_kind, Some(EndpointKind::Register));
    let expected = (model.ff_clk_to_q_ps + model.net_delay_ps(1) + model.ff_setup_ps) / 1000.0;
    assert!(
        (delay - expected).abs() < 1e-9,
        "launch + net + setup: {delay} vs {expected}"
    );
    // The overview figure agrees with the stats the API serves.
    assert_eq!(analysis.stats.estimated_delay_ns, Some(delay));
    assert_eq!(analysis.stats.max_depth, 0, "no logic levels");
}

#[test]
fn paths_carry_a_per_path_delay_matching_the_overview_worst() {
    let (graph, analysis) = fixture("reg_mux_rtl.json");
    let overall = analysis
        .stats
        .estimated_delay_ns
        .expect("a registered design has a delay estimate");
    let paths = depth_paths(&analysis, &graph, 25);
    let worst = paths
        .paths
        .iter()
        .filter_map(|p| p.estimated_delay_ns)
        .fold(0.0f64, f64::max);
    // Every reconstructed path is delay-costed, and the slowest one matches
    // the overview's worst-case figure (both use the same model + setup).
    assert!(paths.paths.iter().all(|p| p.estimated_delay_ns.is_some()));
    assert!(worst > 0.0);
    assert!(
        (worst - overall).abs() < 1e-6,
        "worst path {worst} should match overview {overall}",
    );
}

#[test]
fn paths_with_model_retunes_per_path_delays() {
    let (graph, analysis) = fixture("reg_mux_rtl.json");
    let worst = |resp: &PathsResponse| {
        resp.paths
            .iter()
            .filter_map(|p| p.estimated_delay_ns)
            .fold(0.0f64, f64::max)
    };
    let s7 = analysis.paths_with_model(&graph, &DelayModel::series7(), 25, None, PathSort::Depth);
    let usp = analysis.paths_with_model(
        &graph,
        &DelayModel::ultrascale_plus(),
        25,
        None,
        PathSort::Depth,
    );
    // A faster model shrinks the per-path delays without changing structure.
    assert_eq!(s7.paths.len(), usp.paths.len());
    assert!(worst(&usp) < worst(&s7), "ultrascale+ should be faster");
}

#[test]
fn asic_gate_prices_flow_through_overview_and_paths() {
    // Reuse the three-cell chain fixture but spell its generic cells as the
    // gates-mode Yosys types this model dispatches. The chain becomes
    // XOR -> AND -> AND, so exact logic timing must be the sum of those
    // three characterized categories everywhere timing is surfaced.
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/and_chain_rtl.json");
    let json = std::fs::read_to_string(path).unwrap();
    let mut netlist = parse_str(&json).unwrap();
    let cells = &mut netlist.modules.get_mut("top").unwrap().cells;
    for (cell, cell_type) in cells.values_mut().zip(["$_XOR_", "$_AND_", "$_AND_"]) {
        cell.cell_type = cell_type.to_owned();
    }
    let module = netlist.modules.get("top").unwrap();
    let graph = Graph::from_netlist(&netlist, "top", module).unwrap();

    let mut model = DelayModel::sky130hd();
    model.ff_clk_to_q_ps = 0.0;
    model.ff_setup_ps = 0.0;
    model.net_base_ps = 0.0;
    model.net_per_fanout_ps = 0.0;
    let analysis = Analysis::with_delay_model(&graph, vec!["fixture.sv".to_owned()], &model);
    let expected_ns = (330.5 + 189.2 + 189.2) / 1000.0;

    let breakdown = analysis.stats.estimated_delay_breakdown.unwrap();
    assert!((breakdown.logic_ns - expected_ns).abs() < 1e-9);
    assert_eq!(breakdown.net_ns, 0.0);
    assert_eq!(analysis.stats.estimated_delay_ns, Some(expected_ns));

    let worst_path_delay = |response: &PathsResponse| {
        response
            .paths
            .iter()
            .filter_map(|path| path.estimated_delay_ns)
            .fold(0.0f64, f64::max)
    };
    assert!(
        (worst_path_delay(&analysis.paths_with_model(&graph, &model, 25, None, PathSort::Depth))
            - expected_ns)
            .abs()
            < 1e-9
    );

    // Force the Paths recomputation branch with a custom XOR override and
    // prove it agrees exactly with the Overview estimator for that model.
    let mut retuned = model;
    retuned.gate_ps.as_mut().unwrap().xor = Some(500.0);
    let retuned_overview = analysis.estimate_timing(&graph, &retuned).delay_ns.unwrap();
    let retuned_paths = analysis.paths_with_model(&graph, &retuned, 25, None, PathSort::Depth);
    let retuned_expected_ns = (500.0 + 189.2 + 189.2) / 1000.0;
    assert!((retuned_overview - retuned_expected_ns).abs() < 1e-9);
    assert!((worst_path_delay(&retuned_paths) - retuned_expected_ns).abs() < 1e-9);
}

#[test]
fn delay_sort_reconstructs_and_costs_the_delay_argmax() {
    let graph = divergent_depth_delay_graph();
    let mut model = DelayModel::generic();
    model.lut_ps = 1_000.0;
    model.cell_ps = 1.0;
    model.net_base_ps = 0.0;
    model.net_per_fanout_ps = 0.0;
    let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);

    let depth = analysis.paths_with_model(&graph, &model, 2, None, PathSort::Depth);
    let depth_path = depth
        .paths
        .iter()
        .find(|path| path.endpoint_group == "slow_output")
        .expect("the convergent output is returned");
    assert!(depth_path.nodes.iter().any(|node| node.id == 2));
    assert!(!depth_path.nodes.iter().any(|node| node.id == 4));
    assert_eq!(depth_path.estimated_delay_ns, Some(0.003));

    let delay = analysis.paths_with_model(&graph, &model, 2, None, PathSort::Delay);
    let delay_path = delay
        .paths
        .iter()
        .find(|path| path.endpoint_group == "slow_output")
        .expect("the convergent output is returned");
    assert!(!delay_path.nodes.iter().any(|node| node.id == 2));
    assert!(delay_path.nodes.iter().any(|node| node.id == 4));
    assert_eq!(delay_path.estimated_delay_ns, Some(1.001));
}

#[test]
fn path_variants_keep_one_route_set_across_presentation_sorts() {
    let graph = divergent_depth_delay_graph();
    let mut model = DelayModel::generic();
    model.lut_ps = 1_000.0;
    model.cell_ps = 1.0;
    model.net_base_ps = 0.0;
    model.net_per_fanout_ps = 0.0;
    let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);

    let depth = analysis.path_variants_with_model(&graph, &model, 8, None, PathSort::Depth);
    let delay = analysis.path_variants_with_model(&graph, &model, 8, None, PathSort::Delay);
    let identities = |response: &PathsResponse| {
        response
            .paths
            .iter()
            .map(|path| {
                (
                    path.endpoint_group.clone(),
                    path.nodes.iter().map(|node| node.id).collect::<Vec<_>>(),
                )
            })
            .collect::<HashSet<_>>()
    };

    assert_eq!(identities(&depth), identities(&delay));
    let slow_routes: Vec<_> = depth
        .paths
        .iter()
        .filter(|path| path.endpoint_group == "slow_output")
        .collect();
    assert_eq!(slow_routes.len(), 2);
    assert!(
        slow_routes
            .iter()
            .any(|path| path.nodes.iter().any(|node| node.id == 2))
    );
    assert!(
        slow_routes
            .iter()
            .any(|path| path.nodes.iter().any(|node| node.id == 4))
    );
    assert!(
        depth
            .paths
            .windows(2)
            .all(|pair| pair[0].depth >= pair[1].depth)
    );
    assert!(delay.paths.windows(2).all(|pair| {
        pair[0].estimated_delay_ns.unwrap_or(f64::NEG_INFINITY)
            >= pair[1].estimated_delay_ns.unwrap_or(f64::NEG_INFINITY)
    }));

    let bounded_depth = analysis.path_variants_with_model(&graph, &model, 2, None, PathSort::Depth);
    let bounded_delay = analysis.path_variants_with_model(&graph, &model, 2, None, PathSort::Delay);
    assert!(bounded_depth.truncated);
    assert!(bounded_delay.truncated);
    assert_eq!(identities(&bounded_depth), identities(&bounded_delay));
    assert_eq!(bounded_depth.paths.len(), 2);
    assert_eq!(bounded_delay.paths.len(), 2);
    assert_eq!(
        bounded_depth
            .paths
            .iter()
            .map(|path| path.endpoint_group.as_str())
            .collect::<HashSet<_>>(),
        HashSet::from(["deep_output", "slow_output"]),
    );
    assert!(
        bounded_depth
            .paths
            .windows(2)
            .all(|pair| pair[0].depth >= pair[1].depth)
    );
    assert!(bounded_delay.paths.windows(2).all(|pair| {
        pair[0].estimated_delay_ns.unwrap_or(f64::NEG_INFINITY)
            >= pair[1].estimated_delay_ns.unwrap_or(f64::NEG_INFINITY)
    }));
}

#[test]
fn path_variant_union_keeps_same_shape_routes_with_distinct_nodes() {
    let graph = same_shape_divergent_delay_graph();
    let mut model = DelayModel::generic();
    model.cell_ps = 1.0;
    model.net_base_ps = 0.0;
    model.net_per_fanout_ps = 100.0;
    let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);

    let variants = analysis.path_variants_with_model(&graph, &model, 32, None, PathSort::Depth);
    let output_routes: Vec<_> = variants
        .paths
        .iter()
        .filter(|path| path.endpoint_group == "out")
        .collect();

    assert_eq!(output_routes.len(), 2);
    assert!(
        output_routes
            .iter()
            .any(|path| path.nodes.iter().any(|node| node.id == 2))
    );
    assert!(
        output_routes
            .iter()
            .any(|path| path.nodes.iter().any(|node| node.id == 4))
    );
}

#[test]
fn endpoint_truncation_follows_the_requested_sort() {
    let graph = divergent_depth_delay_graph();
    let mut model = DelayModel::generic();
    model.lut_ps = 1_000.0;
    model.cell_ps = 1.0;
    model.net_base_ps = 0.0;
    model.net_per_fanout_ps = 0.0;
    let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);

    let depth = analysis.paths_with_model(&graph, &model, 1, None, PathSort::Depth);
    assert_eq!(depth.paths[0].endpoint_group, "deep_output");
    let delay = analysis.paths_with_model(&graph, &model, 1, None, PathSort::Delay);
    assert_eq!(delay.paths[0].endpoint_group, "slow_output");
}

#[test]
fn output_critical_path_does_not_charge_register_setup() {
    let graph = divergent_depth_delay_graph();
    let mut model = DelayModel::generic();
    model.lut_ps = 1_000.0;
    model.cell_ps = 1.0;
    model.ff_setup_ps = 500.0;
    model.net_base_ps = 0.0;
    model.net_per_fanout_ps = 0.0;
    let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);
    let estimate = analysis.estimate_timing(&graph, &model);
    let breakdown = estimate.breakdown.expect("an output path has timing");

    assert_eq!(estimate.delay_ns, Some(1.001));
    assert_eq!(breakdown.setup_ns, 0.0);
    assert_eq!(
        breakdown.launch_ns + breakdown.logic_ns + breakdown.net_ns,
        estimate.delay_ns.unwrap()
    );
}

#[test]
fn delay_breakdown_sums_to_the_total() {
    let (_graph, analysis) = fixture("reg_mux_rtl.json");
    let total = analysis.stats.estimated_delay_ns.unwrap();
    let bd = analysis
        .stats
        .estimated_delay_breakdown
        .expect("an estimate has a breakdown");
    let sum = bd.launch_ns + bd.logic_ns + bd.net_ns + bd.setup_ns;
    assert!(
        (sum - total).abs() < 1e-9,
        "breakdown {sum} != total {total}"
    );
    // Every real path crosses at least one net; all terms are non-negative.
    // (launch is 0 when the path starts at a primary input; setup is 0 when
    // it ends at an output rather than a register.)
    assert!(bd.net_ns > 0.0);
    for term in [bd.launch_ns, bd.logic_ns, bd.net_ns, bd.setup_ns] {
        assert!(term >= 0.0);
    }
}

#[test]
fn estimate_delay_ns_shrinks_with_a_faster_preset() {
    let (graph, analysis) = fixture("and_chain_rtl.json");
    let s7 = analysis
        .estimate_timing(&graph, &DelayModel::series7())
        .delay_ns
        .unwrap();
    let usp = analysis
        .estimate_timing(&graph, &DelayModel::ultrascale_plus())
        .delay_ns
        .unwrap();
    let s7_fast = analysis
        .estimate_timing(&graph, &DelayModel::series7().scaled(0.78))
        .delay_ns
        .unwrap();
    // A faster process, and a faster speed grade, both reduce the estimate.
    assert!(usp < s7, "ultrascale+ {usp} should beat series7 {s7}");
    assert!(s7_fast < s7, "-3 grade {s7_fast} should beat -1 {s7}");
}

#[test]
fn register_grouping_uses_q_net() {
    let (_graph, analysis) = fixture("reg_mux_rtl.json");
    let q = analysis
        .endpoints
        .registers
        .iter()
        .find(|group| group.name == "q")
        .unwrap();
    assert_eq!(q.width, 8);
    assert_eq!(q.worst_depth, 1);
    let alias = q
        .output_aliases
        .iter()
        .find(|alias| alias.name == "q")
        .expect("direct top-level registered output should be grouped with q");
    assert_eq!(alias.bits.len(), 8);
    assert!(
        analysis
            .endpoints
            .outputs
            .iter()
            .all(|output| output.name != "q")
    );
    assert_eq!(analysis.stats.depths.input_to_register, Some(1));
}

#[test]
fn hidden_vector_group_identities_preserve_yosys_separators() {
    assert_eq!(hidden_vector_group_name("$a$b[0]").as_deref(), Some("$a$b"));
    assert_eq!(hidden_vector_group_name("$a.b[1]").as_deref(), Some("$a.b"));
    assert_ne!(
        hidden_vector_group_name("$a$b[0]"),
        hidden_vector_group_name("$a.b[1]")
    );
    assert_eq!(hidden_vector_group_name("$scalar"), None);
}

#[test]
fn grouped_controls_compact_distinct_nets_without_losing_drivers() {
    let control = |role, pin: &str, net: &str, driver_id, fanout, src: Option<&str>| ControlRef {
        role,
        pin: pin.to_owned(),
        net_name: net.to_owned(),
        driver_id,
        driver_ids: Vec::new(),
        net_count: None,
        fanout,
        active_low: Some(false),
        synchronous: None,
        src: src.map(str::to_owned),
        generated: None,
    };
    let mut controls = vec![control(
        ControlRole::Clock,
        "CLK",
        "clk",
        1,
        2_048,
        Some("top.sv:2"),
    )];
    for row in 0..128 {
        controls.push(control(
            ControlRole::Enable,
            "EN",
            &format!("row_en[{row}]"),
            row + 2,
            16,
            (row == 0).then_some("top.sv:8"),
        ));
    }
    let compact = compact_group_controls(controls);

    assert_eq!(compact.len(), 2);
    assert_eq!(compact[0].role, ControlRole::Clock);
    assert_eq!(compact[0].net_count, None);
    assert!(compact[0].driver_ids.is_empty());
    assert_eq!(compact[1].role, ControlRole::Enable);
    assert_eq!(compact[1].net_count, Some(128));
    assert_eq!(compact[1].driver_ids, (2..130).collect::<Vec<_>>());
    assert_eq!(compact[1].fanout, 2_048);
    assert_eq!(compact[1].src, None);
}

#[test]
fn detects_combinational_loop_fixture() {
    let (graph, analysis) = fixture("comb_loop_rtl.json");
    assert_eq!(analysis.comb_loops.len(), 2);
    let names: Vec<_> = analysis
        .comb_loops
        .iter()
        .map(|id| graph.node_ref_name(*id))
        .collect();
    assert!(names.iter().any(|name| name.contains("$not")));
    assert!(
        analysis
            .comb_loops
            .iter()
            .all(|id| graph.nodes[*id as usize].kind == NodeKind::Cell)
    );
}

#[test]
fn analysis_handles_deep_comb_chain_without_recursive_scc_stack() {
    let depth = 200_000usize;
    let graph = deep_chain_graph(depth);
    let started = Instant::now();
    let analysis = Analysis::new(&graph, vec!["deep_chain.sv".to_owned()]);
    assert!(started.elapsed().as_secs() < 10);
    assert!(analysis.comb_loops.is_empty());
    assert_eq!(analysis.stats.max_depth, depth as u32);

    let paths = depth_paths(&analysis, &graph, 1);
    assert!(paths.truncated);
    assert_eq!(paths.paths.len(), 1);
    let path = &paths.paths[0];
    assert_eq!(path.nodes.len(), PATH_NODE_CAP);
    assert_eq!(path.startpoint.id, 0);
    assert_eq!(path.endpoint.id, (depth + 1) as NodeId);
    assert_eq!(
        path.nodes.first().map(|node| node.id),
        Some(path.startpoint.id)
    );
    assert_eq!(
        path.nodes.last().map(|node| node.id),
        Some(path.endpoint.id)
    );
}

#[test]
fn path_sampling_represents_deepest_logical_groups_before_extra_bits() {
    let graph = register_bank_graph(30, 64);
    let analysis = Analysis::new(&graph, vec!["register_bank.sv".to_owned()]);

    let paths = depth_paths(&analysis, &graph, 25);
    let groups: HashSet<_> = paths
        .paths
        .iter()
        .map(|path| path.endpoint_group.as_str())
        .collect();
    assert_eq!(paths.paths.len(), 25);
    assert_eq!(groups.len(), 25);
    assert!(paths.truncated);

    let all_paths = depth_paths(&analysis, &graph, MAX_PATH_RESULTS);
    let all_groups: HashSet<_> = all_paths
        .paths
        .iter()
        .map(|path| path.endpoint_group.as_str())
        .collect();
    assert_eq!(all_paths.paths.len(), 30);
    assert_eq!(all_groups.len(), 30);
    assert!(!all_paths.truncated);
}

#[test]
fn wide_register_endpoint_discovery_is_near_linear() {
    let width = 20_000;
    let graph = register_bank_graph(1, width);
    let started = Instant::now();
    let analysis = Analysis::new(&graph, vec!["wide_register.sv".to_owned()]);

    assert!(started.elapsed().as_secs() < 5);
    assert_eq!(analysis.endpoints.registers.len(), 1);
    assert_eq!(analysis.endpoints.registers[0].bits.len(), width);
    assert_eq!(
        analysis.endpoints.registers[0].bits[width - 1].bit,
        width - 1
    );
}

#[test]
fn wide_bus_edges_merge_once_and_remain_deterministic() {
    let width = 20_000u32;
    let edges: Vec<Edge> = (0..width)
        .rev()
        .map(|bit| Edge {
            from: 0,
            to: 1,
            from_port: "Y".to_owned(),
            to_port: "D".to_owned(),
            to_port_bit: bit,
            bit: Some(bit),
            net_name: "wide_bus".to_owned(),
            control: false,
        })
        .collect();
    let started = Instant::now();
    let (merged, truncated) = merge_edges(edges.iter().collect(), |edge| edge.control);

    assert!(started.elapsed().as_secs() < 5);
    assert!(truncated);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].bits.len(), MAX_SUBGRAPH_EDGE_BITS);
    assert_eq!(merged[0].bits.first(), Some(&10_000));
    assert_eq!(merged[0].bits.last(), Some(&(width - 1)));
}

#[test]
fn wide_parallel_edges_do_not_starve_other_root_connections() {
    let wide_edge_count = MAX_FULL_NETLIST_EDGE_VISITS * 2;
    let mut edges: Vec<Edge> = (0..wide_edge_count)
        .map(|bit| Edge {
            from: 0,
            to: 1,
            from_port: "Y".to_owned(),
            to_port: "D".to_owned(),
            to_port_bit: bit as u32,
            bit: Some(bit as u32),
            net_name: "wide".to_owned(),
            control: false,
        })
        .collect();
    edges.push(Edge {
        from: 2,
        to: 3,
        from_port: "Y".to_owned(),
        to_port: "A".to_owned(),
        to_port_bit: 0,
        bit: Some(0),
        net_name: "other".to_owned(),
        control: false,
    });
    let mut outgoing = vec![Vec::new(); 4];
    outgoing[0] = (0..wide_edge_count).collect();
    outgoing[2].push(wide_edge_count);
    let mut incoming = vec![Vec::new(); 4];
    incoming[1] = (0..wide_edge_count).collect();
    incoming[3].push(wide_edge_count);
    let graph = graph_from_parts(
        "wide_and_other",
        (0..4)
            .map(|id| combinational_node(id, "$and", None))
            .collect(),
        edges,
        outgoing,
        incoming,
    );
    let analysis = Analysis::new(&graph, Vec::new());

    let full = analysis.full_netlist(&graph, full_options(4, true, false, false, &[]), None);
    assert!(full.truncated);
    assert!(full.edges.iter().any(|edge| edge.from == 2 && edge.to == 3));
    assert!(
        full.edges
            .iter()
            .find(|edge| edge.from == 0 && edge.to == 1)
            .is_some_and(|edge| edge.bits.len() <= MAX_FULL_GROUP_MEMBERS)
    );

    let context = analysis.full_netlist(&graph, full_options(4, true, false, false, &[0, 2]), None);
    assert!(
        context
            .edges
            .iter()
            .any(|edge| edge.from == 2 && edge.to == 3)
    );

    let cone = analysis
        .multi_root_cone(
            &graph,
            &[0, 2],
            ConeOptions {
                dir: ConeDir::Fanout,
                max_depth: 64,
                max_nodes: 4,
                hide_control: false,
                hide_const: false,
                show_infrastructure: true,
                root_port: None,
                root_port_bit: None,
                root_port_bits: None,
            },
            None,
        )
        .unwrap();
    assert!(cone.edges.iter().any(|edge| edge.from == 2 && edge.to == 3));
}

#[test]
fn dense_subgraphs_enforce_the_merged_edge_cap_deterministically() {
    let graph = dense_dag_graph(150);
    let analysis = Analysis::new(&graph, vec!["dense.sv".to_owned()]);

    let first = analysis.full_netlist(
        &graph,
        full_options(MAX_SUBGRAPH_NODES, true, true, false, &[]),
        None,
    );
    let second = analysis.full_netlist(
        &graph,
        full_options(MAX_SUBGRAPH_NODES, true, true, false, &[]),
        None,
    );

    assert_eq!(first.edges.len(), MAX_SUBGRAPH_EDGES);
    assert!(first.truncated);
    assert_eq!(edge_signature(&first), edge_signature(&second));
}

#[test]
fn full_netlist_filters_controls_before_the_edge_cap() {
    let mut graph = dense_dag_graph(150);
    for edge in graph.edges.iter_mut().take(MAX_SUBGRAPH_EDGES + 1) {
        edge.control = true;
        edge.to_port = "C".to_owned();
    }
    let visible_data_edges = graph.edges.len() - (MAX_SUBGRAPH_EDGES + 1);
    let analysis = Analysis::new(&graph, vec!["dense_controls.sv".to_owned()]);

    let controls_visible = analysis.full_netlist(
        &graph,
        full_options(MAX_SUBGRAPH_NODES, true, false, false, &[]),
        None,
    );
    assert_eq!(controls_visible.edges.len(), MAX_SUBGRAPH_EDGES);
    assert!(controls_visible.truncated);

    let controls_hidden = analysis.full_netlist(
        &graph,
        full_options(MAX_SUBGRAPH_NODES, true, true, false, &[]),
        None,
    );
    assert_eq!(controls_hidden.edges.len(), visible_data_edges);
    assert!(!controls_hidden.truncated);
    assert!(
        controls_hidden
            .edges
            .iter()
            .all(|edge| edge.control.is_none())
    );
}

#[test]
fn full_netlist_prioritizes_context_nearest_to_relevant_roots() {
    let graph = deep_chain_graph(10);
    let analysis = Analysis::new(&graph, vec!["nearby.sv".to_owned()]);

    let nearby = analysis.full_netlist(&graph, full_options(3, true, true, false, &[8]), None);

    assert_eq!(
        nearby
            .nodes
            .iter()
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![7, 8, 9]
    );
    assert_eq!(
        nearby
            .edges
            .iter()
            .map(|edge| (edge.from, edge.to))
            .collect::<Vec<_>>(),
        vec![(7, 8), (8, 9)]
    );
    assert!(nearby.truncated);
}

#[test]
fn infrastructure_projection_caps_intermediate_work_and_output() {
    let (graph, subgraph) = branching_infrastructure_subgraph(100, 101);

    let first = cap_subgraph_edges(collapse_infrastructure(&graph, subgraph.clone()));
    let second = cap_subgraph_edges(collapse_infrastructure(&graph, subgraph));

    assert!(first.truncated);
    assert!(first.edges.len() <= MAX_SUBGRAPH_EDGES);
    assert_eq!(edge_signature(&first), edge_signature(&second));
}

#[test]
fn transparent_buffer_collapses_even_as_a_cone_root() {
    // n0 ($and) -> n1 (OBUF, cone root) -> n2 ($and). A source line can map
    // straight onto the OBUF, making it a root; hiding infrastructure must
    // still collapse the buffer and bridge n0 -> n2 rather than leaving the
    // OBUF on screen ("IBUF shows with infrastructure off").
    let graph = graph_from_parts(
        "buf",
        vec![
            combinational_node(0, "$and", None),
            combinational_node(1, "OBUF", None),
            combinational_node(2, "$and", None),
        ],
        Vec::new(),
        vec![Vec::new(); 3],
        vec![Vec::new(); 3],
    );
    let mk = |id: NodeId, root: bool| GraphNode {
        node: node_ref(&graph, id),
        is_root: root.then_some(true),
        is_boundary: None,
        depth: None,
        params: BTreeMap::new(),
        controls: Vec::new(),
        width: None,
        member_count: None,
        members: None,
        boundary_members: Vec::new(),
    };
    let subgraph = Subgraph {
        nodes: vec![mk(0, false), mk(1, true), mk(2, false)],
        edges: vec![
            GraphEdge {
                from: 0,
                to: 1,
                from_port: "Y".to_owned(),
                to_port: "I".to_owned(),
                net_name: "a".to_owned(),
                bits: vec![0],
                control: None,
                source_boundary_members: Vec::new(),
                target_boundary_members: Vec::new(),
            },
            GraphEdge {
                from: 1,
                to: 2,
                from_port: "O".to_owned(),
                to_port: "A".to_owned(),
                net_name: "y".to_owned(),
                bits: vec![0],
                control: None,
                source_boundary_members: Vec::new(),
                target_boundary_members: Vec::new(),
            },
        ],
        truncated: false,
    };

    let out = collapse_infrastructure(&graph, subgraph);

    assert!(
        out.nodes.iter().all(|n| n.node.id != 1),
        "the root OBUF must collapse when infrastructure is hidden"
    );
    assert!(
        out.edges.iter().any(|e| e.from == 0 && e.to == 2),
        "n0 must bridge directly to n2 through the hidden buffer"
    );
}

#[test]
fn infrastructure_projection_borrows_wide_bits_across_branching_queue() {
    let branches = 4_500;
    let (graph, subgraph) = wide_branching_infrastructure_subgraph(20_000, branches);
    let started = Instant::now();

    let projected = collapse_infrastructure(&graph, subgraph);

    assert!(started.elapsed().as_secs() < 5);
    assert!(!projected.truncated);
    assert_eq!(projected.edges.len(), branches);
    assert!(projected.edges.iter().all(|edge| edge.bits.len() == 1));
}

#[test]
fn infrastructure_projection_preserves_reconvergent_bit_sources() {
    let nodes = (0..=5)
        .map(|id| {
            if id == 0 {
                let mut input = port_node(id, "a", PortDirection::Input);
                input.port_bit = Some(0);
                input
            } else {
                combinational_node(id, if id == 5 { "$and" } else { "OBUF" }, None)
            }
        })
        .collect();
    let graph = graph_from_parts(
        "reconvergent_projection",
        nodes,
        Vec::new(),
        vec![Vec::new(); 6],
        vec![Vec::new(); 6],
    );
    let projected_nodes = graph
        .nodes
        .iter()
        .map(|node| GraphNode {
            node: node_ref(&graph, node.id),
            is_root: None,
            is_boundary: None,
            depth: None,
            params: BTreeMap::new(),
            controls: Vec::new(),
            width: None,
            member_count: None,
            members: None,
            boundary_members: Vec::new(),
        })
        .collect();
    let edge = |from, to, bits: Vec<u32>| GraphEdge {
        from,
        to,
        from_port: "O".to_owned(),
        to_port: "I".to_owned(),
        net_name: format!("n{from}_{to}"),
        bits,
        control: None,
        source_boundary_members: Vec::new(),
        target_boundary_members: Vec::new(),
    };
    let subgraph = Subgraph {
        nodes: projected_nodes,
        edges: vec![
            edge(0, 1, vec![99]),
            edge(1, 2, vec![1]),
            edge(1, 3, vec![2]),
            edge(2, 4, Vec::new()),
            edge(3, 4, Vec::new()),
            edge(4, 5, Vec::new()),
        ],
        truncated: false,
    };

    let projected = collapse_infrastructure(&graph, subgraph);

    assert_eq!(projected.edges.len(), 1);
    assert_eq!(projected.edges[0].bits, vec![1, 2]);
    assert_eq!(
        projected.boundary_electrical[0]
            .as_deref()
            .and_then(|provenance| provenance.source_bits.as_deref()),
        Some([99].as_slice()),
        "reconvergent paths must union and deduplicate one source boundary identity"
    );
}

#[test]
fn path_reconstruction_obeys_the_shared_node_budget() {
    let graph = deep_register_bank_graph(400, 256);
    let analysis = Analysis::new(&graph, vec!["deep_bank.sv".to_owned()]);

    let paths = depth_paths(&analysis, &graph, 500);
    let reconstructed_nodes: usize = paths.paths.iter().map(|path| path.nodes.len()).sum();
    let groups: HashSet<_> = paths
        .paths
        .iter()
        .map(|path| path.endpoint_group.as_str())
        .collect();

    assert!(paths.truncated);
    assert!(paths.paths.len() < 400);
    assert_eq!(groups.len(), paths.paths.len());
    assert!(reconstructed_nodes <= PATH_RECONSTRUCTION_NODE_BUDGET);

    let (variants, variant_reconstruction_work) = analysis.path_variants_with_model_and_work(
        &graph,
        &DelayModel::generic(),
        500,
        None,
        PathSort::Depth,
    );
    let variant_nodes: usize = variants.paths.iter().map(|path| path.nodes.len()).sum();
    assert!(variants.truncated);
    assert!(variant_nodes <= PATH_RECONSTRUCTION_NODE_BUDGET);
    assert!(variant_reconstruction_work > PATH_RECONSTRUCTION_NODE_BUDGET / 2);
    assert!(variant_reconstruction_work <= PATH_RECONSTRUCTION_NODE_BUDGET);
}

#[test]
fn source_selection_returns_only_the_bounded_projection() {
    let graph = graph_from_parts(
        "source_selection",
        vec![combinational_node(0, "$and", Some("source.sv:10"))],
        Vec::new(),
        vec![Vec::new()],
        vec![Vec::new()],
    );
    let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);
    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "source.sv",
                start_line: 10,
                end_line: 10,
                start_column: None,
                end_column: None,
            },
            SourceSelectionOptions {
                max_nodes: 400,
                hide_control: true,
                hide_const: true,
                group_vectors: false,
                group_memories: false,
            },
        )
        .unwrap();

    assert_eq!(result.status, SourceSelectionStatus::Mapped);
    assert_eq!(result.direct_ids, vec![0]);
    assert_eq!(result.graph.nodes.len(), 1);
    assert_eq!(result.graph.nodes[0].is_root, Some(true));
}

#[test]
fn source_selection_keeps_a_large_design_response_bounded() {
    let node_count = 50_000;
    let nodes = (0..node_count)
        .map(|id| {
            combinational_node(
                id as NodeId,
                "$and",
                (id == node_count / 2).then_some("source.sv:10"),
            )
        })
        .collect();
    let graph = graph_from_parts(
        "large_source_selection",
        nodes,
        Vec::new(),
        vec![Vec::new(); node_count],
        vec![Vec::new(); node_count],
    );
    let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);
    let started = Instant::now();

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "source.sv",
                start_line: 10,
                end_line: 10,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();

    assert!(started.elapsed().as_secs() < 1);
    assert_eq!(result.status, SourceSelectionStatus::Mapped);
    assert_eq!(result.graph.nodes.len(), 1);
    assert_eq!(result.graph.nodes[0].node.id, (node_count / 2) as NodeId);
}

#[test]
fn grouped_source_selection_caps_raw_members_and_serialized_payload() {
    let group_member_count = 5_000;
    let context_id = group_member_count as NodeId;
    let mut incoming = vec![Vec::new(); group_member_count + 1];
    let mut outgoing = vec![Vec::new(); group_member_count + 1];
    incoming[0].push(0);
    outgoing[context_id as usize].push(0);
    let graph = graph_from_parts(
        "wide_group",
        (0..group_member_count)
            .map(|id| combinational_node(id as NodeId, "$and", Some("source.sv:10")))
            .chain(std::iter::once(combinational_node(
                context_id, "$not", None,
            )))
            .collect(),
        vec![Edge {
            from: context_id,
            to: 0,
            from_port: "Y".to_owned(),
            to_port: "A".to_owned(),
            to_port_bit: 0,
            bit: Some(0),
            net_name: "context".to_owned(),
            control: false,
        }],
        outgoing,
        incoming,
    );
    let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);
    let grouping = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Comb,
            members: (0..group_member_count as NodeId).collect(),
            label: "wide_logic".to_owned(),
            cell_type: "$and".to_owned(),
        }],
        group_of: (0..group_member_count as NodeId)
            .map(|id| (id, 0))
            .collect(),
    };

    let full = analysis.full_netlist(
        &graph,
        full_options(1, false, true, false, &[]),
        Some(GroupingProjection::all(&grouping)),
    );
    assert!(full.truncated);
    assert_eq!(full.nodes.len(), 1);
    assert_eq!(full.nodes[0].width, Some(MAX_FULL_GROUP_MEMBERS as u32));
    assert_eq!(full.nodes[0].member_count, Some(group_member_count as u32));
    assert_eq!(
        full.nodes[0].members.as_ref().unwrap().len(),
        MAX_FULL_GROUP_MEMBERS
    );
    assert!(serde_json::to_vec(&full).unwrap().len() < 100_000);

    let result = analysis
        .source_selection(
            &graph,
            &grouping,
            SourceSelectionRange {
                file: "source.sv",
                start_line: 10,
                end_line: 10,
                start_column: None,
                end_column: None,
            },
            SourceSelectionOptions {
                group_vectors: true,
                ..selection_options()
            },
        )
        .unwrap();

    assert!(result.graph.truncated);
    assert_eq!(result.graph.nodes.len(), 2);
    let grouped = result
        .graph
        .nodes
        .iter()
        .find(|node| node.member_count.is_some())
        .expect("the grouped source roots remain projected");
    assert_eq!(grouped.width, Some(MAX_FULL_GROUP_MEMBERS as u32));
    assert_eq!(grouped.member_count, Some(group_member_count as u32));
    assert_eq!(
        grouped.members.as_ref().unwrap().len(),
        MAX_FULL_GROUP_MEMBERS
    );
    assert!(
        result
            .graph
            .nodes
            .iter()
            .any(|node| node.node.id == context_id)
    );
    assert_eq!(result.graph.edges.len(), 1);
    assert!(serde_json::to_vec(&result).unwrap().len() < 100_000);
}

#[test]
fn full_netlist_samples_wide_groups_without_starving_other_units() {
    let group_member_count = 4_096;
    let singleton_count = 10;
    let node_count = group_member_count + singleton_count;
    let graph = graph_from_parts(
        "wide_group_with_context",
        (0..node_count)
            .map(|id| combinational_node(id as NodeId, "$and", None))
            .collect(),
        Vec::new(),
        vec![Vec::new(); node_count],
        vec![Vec::new(); node_count],
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let grouping = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Comb,
            members: (0..group_member_count as NodeId).collect(),
            label: "wide_logic".to_owned(),
            cell_type: "$and".to_owned(),
        }],
        group_of: (0..group_member_count as NodeId)
            .map(|id| (id, 0))
            .collect(),
    };

    let result = analysis.full_netlist(
        &graph,
        full_options(singleton_count + 1, false, true, false, &[]),
        Some(GroupingProjection::all(&grouping)),
    );

    assert!(result.truncated);
    assert_eq!(result.nodes.len(), singleton_count + 1);
    assert_eq!(
        result
            .nodes
            .iter()
            .find(|node| node.member_count.is_some())
            .and_then(|node| node.width),
        Some(MAX_FULL_GROUP_MEMBERS as u32)
    );
    for id in group_member_count as NodeId..node_count as NodeId {
        assert!(result.nodes.iter().any(|node| node.node.id == id));
    }
}

#[test]
fn context_netlist_samples_a_wide_group_and_keeps_its_neighbor() {
    let group_member_count = 4_096;
    let context_id = group_member_count as NodeId;
    let mut outgoing = vec![Vec::new(); group_member_count + 1];
    let mut incoming = vec![Vec::new(); group_member_count + 1];
    outgoing[0].push(0);
    incoming[context_id as usize].push(0);
    let graph = graph_from_parts(
        "wide_context_group",
        (0..group_member_count)
            .map(|id| combinational_node(id as NodeId, "$and", None))
            .chain(std::iter::once(combinational_node(
                context_id, "$not", None,
            )))
            .collect(),
        vec![Edge {
            from: 0,
            to: context_id,
            from_port: "Y".to_owned(),
            to_port: "A".to_owned(),
            to_port_bit: 0,
            bit: Some(0),
            net_name: "context".to_owned(),
            control: false,
        }],
        outgoing,
        incoming,
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let grouping = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Comb,
            members: (0..group_member_count as NodeId).collect(),
            label: "wide_logic".to_owned(),
            cell_type: "$and".to_owned(),
        }],
        group_of: (0..group_member_count as NodeId)
            .map(|id| (id, 0))
            .collect(),
    };
    let roots: Vec<NodeId> = (0..group_member_count as NodeId).collect();

    let result = analysis.full_netlist(
        &graph,
        full_options(10, false, true, false, &roots),
        Some(GroupingProjection::all(&grouping)),
    );

    assert!(result.truncated);
    assert_eq!(result.nodes.len(), 2);
    assert!(result.nodes.iter().any(|node| node.node.id == context_id));
    let grouped = result
        .nodes
        .iter()
        .find(|node| node.member_count.is_some())
        .expect("wide group remains projected");
    assert_eq!(grouped.width, Some(MAX_FULL_GROUP_MEMBERS as u32));
    assert_eq!(grouped.member_count, Some(group_member_count as u32));
    assert_eq!(result.edges.len(), 1);
}

#[test]
fn grouped_root_frontiers_share_context_capacity_fairly() {
    let node_count = 8;
    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::new(); node_count];
    let mut incoming = vec![Vec::new(); node_count];
    for neighbor in 2..7 {
        add_test_edge(
            &mut edges,
            &mut outgoing,
            &mut incoming,
            0,
            neighbor,
            neighbor,
        );
    }
    add_test_edge(&mut edges, &mut outgoing, &mut incoming, 1, 7, 7);
    let graph = graph_from_parts(
        "fair_root_frontiers",
        (0..node_count)
            .map(|id| combinational_node(id as NodeId, "$and", None))
            .collect(),
        edges,
        outgoing,
        incoming,
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let grouping = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Comb,
            members: vec![0, 1],
            label: "roots[1:0]".to_owned(),
            cell_type: "$and".to_owned(),
        }],
        group_of: HashMap::from([(0, 0), (1, 0)]),
    };
    let projection = Some(GroupingProjection::all(&grouping));
    let cone = analysis
        .multi_root_cone(
            &graph,
            &[0, 1],
            ConeOptions {
                dir: ConeDir::Fanout,
                max_depth: 64,
                max_nodes: 3,
                hide_control: true,
                hide_const: true,
                show_infrastructure: true,
                root_port: None,
                root_port_bit: None,
                root_port_bits: None,
            },
            projection,
        )
        .unwrap();
    assert!(cone.nodes.iter().any(|node| node.node.id == 7));

    let context = analysis.full_netlist(
        &graph,
        full_options(3, true, true, false, &[0, 1]),
        projection,
    );
    assert!(context.nodes.iter().any(|node| node.node.id == 7));
}

#[test]
fn hidden_edges_on_one_root_do_not_starve_another_root() {
    let hidden_count = MAX_SUBGRAPH_EDGES * 2;
    let mut edges: Vec<Edge> = (0..hidden_count)
        .map(|bit| Edge {
            from: 0,
            to: 2,
            from_port: "Y".to_owned(),
            to_port: "C".to_owned(),
            to_port_bit: bit as u32,
            bit: Some(bit as u32),
            net_name: "hidden_clock".to_owned(),
            control: true,
        })
        .collect();
    edges.push(Edge {
        from: 1,
        to: 3,
        from_port: "Y".to_owned(),
        to_port: "A".to_owned(),
        to_port_bit: 0,
        bit: Some(0),
        net_name: "visible".to_owned(),
        control: false,
    });
    let mut outgoing = vec![Vec::new(); 4];
    outgoing[0] = (0..hidden_count).collect();
    outgoing[1].push(hidden_count);
    let mut incoming = vec![Vec::new(); 4];
    incoming[2] = (0..hidden_count).collect();
    incoming[3].push(hidden_count);
    let graph = graph_from_parts(
        "hidden_root_fairness",
        (0..4)
            .map(|id| combinational_node(id, "$and", None))
            .collect(),
        edges,
        outgoing,
        incoming,
    );
    let analysis = Analysis::new(&graph, Vec::new());

    let result = analysis
        .multi_root_cone(
            &graph,
            &[0, 1],
            ConeOptions {
                dir: ConeDir::Fanout,
                max_depth: 64,
                max_nodes: 4,
                hide_control: true,
                hide_const: true,
                show_infrastructure: true,
                root_port: None,
                root_port_bit: None,
                root_port_bits: None,
            },
            None,
        )
        .unwrap();

    assert!(result.truncated);
    assert!(result.nodes.iter().any(|node| node.node.id == 3));
    assert!(
        result
            .edges
            .iter()
            .any(|edge| edge.from == 1 && edge.to == 3)
    );
}

#[test]
fn ungrouped_root_budget_stratifies_across_the_full_request() {
    let roots: Vec<NodeId> = (0..256).collect();

    let (bounded, truncated) = bounded_projection_roots(&roots, None, 256, 50, 1_000);

    assert!(truncated);
    assert_eq!(bounded.len(), 25);
    assert_eq!(bounded.first(), Some(&0));
    assert_eq!(bounded.last(), Some(&255));
}

#[test]
fn shared_group_budgets_stratify_every_admitted_group_end_to_end() {
    let group_count = 25usize;
    let members_per_group = 2_048usize;
    let node_count = group_count * members_per_group;
    let grouping = GroupPartition {
        groups: (0..group_count)
            .map(|group| Group {
                kind: GroupKind::Memory,
                members: ((group * members_per_group) as NodeId
                    ..((group + 1) * members_per_group) as NodeId)
                    .collect(),
                label: format!("memory{group} [2048x1]"),
                cell_type: "$mem".to_owned(),
            })
            .collect(),
        group_of: (0..node_count as NodeId)
            .map(|id| (id, id / members_per_group as NodeId))
            .collect(),
    };
    let projection = GroupingProjection::all(&grouping);
    let roots: Vec<NodeId> = (0..node_count as NodeId).collect();

    let (bounded, truncated) = bounded_projection_roots(
        &roots,
        Some(projection),
        node_count as NodeId,
        group_count * 2,
        1_000,
    );

    assert!(truncated);
    assert_eq!(bounded.len(), 1_000);
    for group in 0..group_count {
        let first = (group * members_per_group) as NodeId;
        let last = ((group + 1) * members_per_group - 1) as NodeId;
        let sampled: Vec<NodeId> = bounded
            .iter()
            .copied()
            .filter(|member| (*member >= first) && (*member <= last))
            .collect();
        assert_eq!(sampled.len(), 40, "group {group}");
        assert_eq!(sampled.first(), Some(&first), "group {group}");
        assert_eq!(sampled.last(), Some(&last), "group {group}");
    }

    let graph = graph_from_parts(
        "many_wide_memories",
        (0..node_count)
            .map(|id| combinational_node(id as NodeId, "$and", None))
            .collect(),
        Vec::new(),
        vec![Vec::new(); node_count],
        vec![Vec::new(); node_count],
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let full = analysis.full_netlist(
        &graph,
        full_options(group_count, false, true, false, &[]),
        Some(projection),
    );

    assert!(full.truncated);
    assert_eq!(full.nodes.len(), group_count);
    for node in &full.nodes {
        assert_eq!(node.width, Some(80));
        assert_eq!(node.member_count, Some(members_per_group as u32));
        let members = node.members.as_ref().expect("sampled group members");
        let group = (node.node.id - node_count as NodeId) as usize;
        assert_eq!(
            members.first(),
            Some(&((group * members_per_group) as NodeId))
        );
        assert_eq!(
            members.last(),
            Some(&(((group + 1) * members_per_group - 1) as NodeId))
        );
    }
}

#[test]
fn memory_and_vector_grouping_policies_are_independent() {
    let graph = graph_from_parts(
        "selective_grouping",
        (0..4)
            .map(|id| combinational_node(id, "$and", None))
            .collect(),
        Vec::new(),
        vec![Vec::new(); 4],
        vec![Vec::new(); 4],
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let grouping = GroupPartition {
        groups: vec![
            Group {
                kind: GroupKind::Memory,
                members: vec![0, 1],
                label: "memory [2×1]".to_owned(),
                cell_type: "$mem".to_owned(),
            },
            Group {
                kind: GroupKind::Register,
                members: vec![2, 3],
                label: "register[1:0]".to_owned(),
                cell_type: "$dff".to_owned(),
            },
        ],
        group_of: HashMap::from([(0, 0), (1, 0), (2, 1), (3, 1)]),
    };

    let memory_only = analysis.full_netlist(
        &graph,
        full_options(4, false, true, false, &[]),
        Some(GroupingProjection {
            partition: &grouping,
            vectors: false,
            memories: true,
            expanded_groups: &[],
        }),
    );
    assert_eq!(memory_only.nodes.len(), 3);
    assert!(memory_only.nodes.iter().any(|node| node.node.id == 4));
    assert!(memory_only.nodes.iter().any(|node| node.node.id == 2));
    assert!(memory_only.nodes.iter().any(|node| node.node.id == 3));

    let vectors_only = analysis.full_netlist(
        &graph,
        full_options(4, false, true, false, &[]),
        Some(GroupingProjection {
            partition: &grouping,
            vectors: true,
            memories: false,
            expanded_groups: &[],
        }),
    );
    assert_eq!(vectors_only.nodes.len(), 3);
    assert!(vectors_only.nodes.iter().any(|node| node.node.id == 5));
    assert!(vectors_only.nodes.iter().any(|node| node.node.id == 0));
    assert!(vectors_only.nodes.iter().any(|node| node.node.id == 1));
}

#[test]
fn group_expansion_returns_every_raw_member_without_expanding_other_groups() {
    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::new(); 4];
    let mut incoming = vec![Vec::new(); 4];
    add_test_edge(&mut edges, &mut outgoing, &mut incoming, 0, 2, 10);
    add_test_edge(&mut edges, &mut outgoing, &mut incoming, 1, 3, 11);
    let graph = graph_from_parts(
        "expand_group",
        (0..4)
            .map(|id| combinational_node(id, "$and", None))
            .collect(),
        edges,
        outgoing,
        incoming,
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let grouping = GroupPartition {
        groups: vec![
            Group {
                kind: GroupKind::Memory,
                members: vec![0, 1],
                label: "memory [2×1]".to_owned(),
                cell_type: "$mem".to_owned(),
            },
            Group {
                kind: GroupKind::Comb,
                members: vec![2, 3],
                label: "logic[1:0]".to_owned(),
                cell_type: "$and".to_owned(),
            },
        ],
        group_of: HashMap::from([(0, 0), (1, 0), (2, 1), (3, 1)]),
    };
    let projection = GroupingProjection::from_flags_with_expanded(&grouping, true, true, &[0]);

    let expanded = analysis
        .expand_group(
            &graph,
            &grouping,
            0,
            GroupExpansionOptions {
                max_nodes: MAX_SUBGRAPH_NODES,
                hide_control: true,
                hide_const: true,
            },
            projection,
        )
        .expect("known group");

    assert_eq!(expanded.members, vec![0, 1]);
    assert_eq!(
        expanded
            .graph
            .nodes
            .iter()
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![0, 1, 5]
    );
    assert!(
        expanded
            .graph
            .nodes
            .iter()
            .filter(|node| node.node.id < 2)
            .all(|node| node.members.is_none())
    );
    assert_eq!(
        expanded
            .graph
            .nodes
            .iter()
            .find(|node| node.node.id == 5)
            .and_then(|node| node.members.as_ref())
            .map(Vec::len),
        Some(2)
    );
    assert_eq!(
        expanded
            .graph
            .edges
            .iter()
            .map(|edge| (edge.from, edge.to, edge.bits.clone()))
            .collect::<Vec<_>>(),
        vec![(0, 5, vec![10]), (1, 5, vec![11])]
    );
    assert!(!expanded.graph.truncated);
}

#[test]
fn group_expansion_routes_to_member_pins_of_another_open_group() {
    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::new(); 4];
    let mut incoming = vec![Vec::new(); 4];
    add_test_edge(&mut edges, &mut outgoing, &mut incoming, 0, 2, 10);
    add_test_edge(&mut edges, &mut outgoing, &mut incoming, 1, 3, 11);
    let graph = graph_from_parts(
        "expand_group",
        (0..4)
            .map(|id| combinational_node(id, "$and", None))
            .collect(),
        edges,
        outgoing,
        incoming,
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let grouping = GroupPartition {
        groups: vec![
            Group {
                kind: GroupKind::Memory,
                members: vec![0, 1],
                label: "memory [2×1]".to_owned(),
                cell_type: "$mem".to_owned(),
            },
            Group {
                kind: GroupKind::Comb,
                members: vec![2, 3],
                label: "logic[1:0]".to_owned(),
                cell_type: "$and".to_owned(),
            },
        ],
        group_of: HashMap::from([(0, 0), (1, 0), (2, 1), (3, 1)]),
    };
    // Both groups are open, so neither collapses back to a quotient node in
    // the other's expansion projection.
    let projection = GroupingProjection::from_flags_with_expanded(&grouping, true, true, &[0, 1]);

    let expanded = analysis
        .expand_group(
            &graph,
            &grouping,
            0,
            GroupExpansionOptions {
                max_nodes: MAX_SUBGRAPH_NODES,
                hide_control: true,
                hide_const: true,
            },
            projection,
        )
        .expect("known group");

    assert_eq!(expanded.members, vec![0, 1]);
    assert_eq!(
        expanded
            .graph
            .nodes
            .iter()
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![0, 1, 2, 3]
    );
    assert!(
        expanded
            .graph
            .nodes
            .iter()
            .all(|node| node.members.is_none())
    );
    assert_eq!(
        expanded
            .graph
            .edges
            .iter()
            .map(|edge| (edge.from, edge.to, edge.bits.clone()))
            .collect::<Vec<_>>(),
        vec![(0, 2, vec![10]), (1, 3, vec![11])]
    );
    assert!(!expanded.graph.truncated);
}

#[test]
fn group_expansion_maps_compact_boundary_trunks_to_projected_edges_by_exact_key() {
    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::new(); 4];
    let mut incoming = vec![Vec::new(); 4];
    add_test_edge(&mut edges, &mut outgoing, &mut incoming, 0, 2, 10);
    add_test_edge(&mut edges, &mut outgoing, &mut incoming, 0, 2, 10);
    add_test_edge(&mut edges, &mut outgoing, &mut incoming, 1, 2, 11);
    add_test_edge(&mut edges, &mut outgoing, &mut incoming, 3, 0, 12);
    add_test_edge(&mut edges, &mut outgoing, &mut incoming, 3, 1, 13);
    let graph = graph_from_parts(
        "expand_group_boundary_trunks",
        (0..4)
            .map(|id| combinational_node(id, "$and", None))
            .collect(),
        edges,
        outgoing,
        incoming,
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let grouping = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Memory,
            members: vec![0, 1],
            label: "memory [2×1]".to_owned(),
            cell_type: "$mem".to_owned(),
        }],
        group_of: HashMap::from([(0, 0), (1, 0)]),
    };
    let projection = GroupingProjection::from_flags_with_expanded(&grouping, true, true, &[0]);

    let expanded = analysis
        .expand_group(
            &graph,
            &grouping,
            0,
            GroupExpansionOptions {
                max_nodes: MAX_SUBGRAPH_NODES,
                hide_control: true,
                hide_const: true,
            },
            projection,
        )
        .expect("known group");

    assert_eq!(
        expanded.boundary_trunks,
        vec![
            GroupExpansionBoundaryTrunk {
                compact_edge: ProjectedEdgeKey {
                    from: 3,
                    to: 4,
                    from_port: "Y".to_owned(),
                    to_port: "A".to_owned(),
                },
                expanded_edges: vec![
                    ProjectedEdgeKey {
                        from: 3,
                        to: 0,
                        from_port: "Y".to_owned(),
                        to_port: "A".to_owned(),
                    },
                    ProjectedEdgeKey {
                        from: 3,
                        to: 1,
                        from_port: "Y".to_owned(),
                        to_port: "A".to_owned(),
                    },
                ],
            },
            GroupExpansionBoundaryTrunk {
                compact_edge: ProjectedEdgeKey {
                    from: 4,
                    to: 2,
                    from_port: "Y".to_owned(),
                    to_port: "A".to_owned(),
                },
                expanded_edges: vec![
                    ProjectedEdgeKey {
                        from: 0,
                        to: 2,
                        from_port: "Y".to_owned(),
                        to_port: "A".to_owned(),
                    },
                    ProjectedEdgeKey {
                        from: 1,
                        to: 2,
                        from_port: "Y".to_owned(),
                        to_port: "A".to_owned(),
                    },
                ],
            },
        ],
    );
    let compact = analysis.full_netlist(
        &graph,
        full_options(4, false, true, false, &[]),
        Some(GroupingProjection::all(&grouping)),
    );
    let mut compact_boundary_edges = compact
        .edges
        .iter()
        .filter(|edge| edge.from == 4 || edge.to == 4)
        .map(projected_edge_key)
        .collect::<Vec<_>>();
    compact_boundary_edges.sort();
    assert_eq!(
        compact_boundary_edges,
        expanded
            .boundary_trunks
            .iter()
            .map(|trunk| trunk.compact_edge.clone())
            .collect::<Vec<_>>(),
    );

    let permutation = [4usize, 1, 3, 2, 0];
    let permuted_edges = permutation
        .iter()
        .map(|&index| graph.edges[index].clone())
        .collect::<Vec<_>>();
    let mut permuted_outgoing = vec![Vec::new(); 4];
    let mut permuted_incoming = vec![Vec::new(); 4];
    for (index, edge) in permuted_edges.iter().enumerate() {
        permuted_outgoing[edge.from as usize].push(index);
        permuted_incoming[edge.to as usize].push(index);
    }
    let permuted_graph = graph_from_parts(
        "expand_group_boundary_trunks_permuted",
        graph.nodes.clone(),
        permuted_edges,
        permuted_outgoing,
        permuted_incoming,
    );
    let permuted_analysis = Analysis::new(&permuted_graph, Vec::new());
    let permuted = permuted_analysis
        .expand_group(
            &permuted_graph,
            &grouping,
            0,
            GroupExpansionOptions {
                max_nodes: MAX_SUBGRAPH_NODES,
                hide_control: true,
                hide_const: true,
            },
            projection,
        )
        .expect("known group");

    assert_eq!(permuted.boundary_trunks, expanded.boundary_trunks);
}

#[test]
fn group_expansion_trunk_keys_survive_compact_group_sampling() {
    let member_count = 300u32;
    let outside = member_count;
    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::new(); member_count as usize + 1];
    let mut incoming = vec![Vec::new(); member_count as usize + 1];
    for member in 0..member_count {
        add_test_edge(
            &mut edges,
            &mut outgoing,
            &mut incoming,
            member,
            outside,
            member,
        );
    }
    let graph = graph_from_parts(
        "sampled_compact_group_boundary",
        (0..=member_count)
            .map(|id| combinational_node(id, "$and", None))
            .collect(),
        edges,
        outgoing,
        incoming,
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let members = (0..member_count).collect::<Vec<_>>();
    let grouping = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Memory,
            members: members.clone(),
            label: "memory [300×1]".to_owned(),
            cell_type: "$mem".to_owned(),
        }],
        group_of: members.iter().map(|member| (*member, 0)).collect(),
    };
    let compact = analysis.full_netlist(
        &graph,
        full_options(400, false, true, false, &[]),
        Some(GroupingProjection::all(&grouping)),
    );
    let compact_group = compact
        .nodes
        .iter()
        .find(|node| node.node.id == member_count + 1)
        .expect("compact group is present");
    assert_eq!(compact_group.width, Some(MAX_FULL_GROUP_MEMBERS as u32));
    assert_eq!(compact_group.member_count, Some(member_count));

    let expanded = analysis
        .expand_group(
            &graph,
            &grouping,
            0,
            GroupExpansionOptions {
                max_nodes: MAX_GROUP_EXPANSION_NODES,
                hide_control: true,
                hide_const: true,
            },
            GroupingProjection::from_flags_with_expanded(&grouping, true, true, &[0]),
        )
        .expect("known group");
    let expected_compact_key = compact
        .edges
        .iter()
        .find(|edge| edge.from == member_count + 1 && edge.to == outside)
        .map(projected_edge_key)
        .expect("sampled compact projection retains the boundary trunk");
    let focused = analysis.full_netlist(
        &graph,
        full_options(2, false, true, false, &[outside]),
        Some(GroupingProjection::all(&grouping)),
    );
    let focused_compact_key = focused
        .edges
        .iter()
        .find(|edge| edge.from == member_count + 1 && edge.to == outside)
        .map(projected_edge_key)
        .expect("focused compact projection retains the boundary trunk");

    assert_eq!(expanded.boundary_trunks.len(), 1);
    assert_eq!(
        expanded.boundary_trunks[0].compact_edge,
        expected_compact_key,
    );
    assert_eq!(focused_compact_key, expected_compact_key);
    assert_eq!(
        expanded.boundary_trunks[0].expanded_edges.len(),
        member_count as usize,
    );
}

#[test]
fn group_expansion_fully_opens_a_2048_instance_memory() {
    let member_count = 2_048;
    let graph = graph_from_parts(
        "wide_expand_group",
        (0..member_count)
            .map(|id| combinational_node(id, "$dff", None))
            .collect(),
        Vec::new(),
        vec![Vec::new(); member_count as usize],
        vec![Vec::new(); member_count as usize],
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let members: Vec<NodeId> = (0..member_count).collect();
    let grouping = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Memory,
            members: members.clone(),
            label: "memory [128×16]".to_owned(),
            cell_type: "$mem".to_owned(),
        }],
        group_of: members.iter().map(|id| (*id, 0)).collect(),
    };
    let expanded_groups = [0];
    let projection =
        GroupingProjection::from_flags_with_expanded(&grouping, true, true, &expanded_groups);

    let expanded = analysis
        .expand_group(
            &graph,
            &grouping,
            0,
            GroupExpansionOptions {
                max_nodes: MAX_GROUP_EXPANSION_NODES,
                hide_control: true,
                hide_const: true,
            },
            projection,
        )
        .expect("known group");

    assert_eq!(expanded.members.len(), member_count as usize);
    assert_eq!(expanded.graph.nodes.len(), member_count as usize);
    assert!(!expanded.graph.truncated);
}

#[test]
fn full_netlist_reserves_a_bounded_memory_sample_before_graph_order() {
    let node_count = 5_000;
    let memory_start = 4_000;
    let graph = graph_from_parts(
        "late_memory",
        (0..node_count)
            .map(|id| combinational_node(id as NodeId, "$and", None))
            .collect(),
        Vec::new(),
        vec![Vec::new(); node_count],
        vec![Vec::new(); node_count],
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let grouping = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Memory,
            members: (memory_start as NodeId..node_count as NodeId).collect(),
            label: "memory [1000×1]".to_owned(),
            cell_type: "$mem".to_owned(),
        }],
        group_of: (memory_start as NodeId..node_count as NodeId)
            .map(|id| (id, 0))
            .collect(),
    };

    let result = analysis.full_netlist(
        &graph,
        full_options(400, false, true, false, &[]),
        Some(GroupingProjection::all(&grouping)),
    );
    let memory = result
        .nodes
        .iter()
        .find(|node| node.node.id == node_count as NodeId)
        .expect("the late-sorting logical memory remains visible");

    assert!(result.truncated);
    assert_eq!(result.nodes.len(), 400);
    assert_eq!(memory.width, Some(MAX_FULL_GROUP_MEMBERS as u32));
    assert_eq!(memory.member_count, Some(1_000));
    assert_eq!(
        memory.members.as_ref().unwrap().len(),
        MAX_FULL_GROUP_MEMBERS
    );
}

#[test]
fn full_netlist_reserves_every_memory_before_distributing_samples() {
    let group_count = 10;
    let members_per_group = 300;
    let node_count = group_count * members_per_group;
    let graph = graph_from_parts(
        "many_memories",
        (0..node_count)
            .map(|id| combinational_node(id as NodeId, "$and", None))
            .collect(),
        Vec::new(),
        vec![Vec::new(); node_count],
        vec![Vec::new(); node_count],
    );
    let analysis = Analysis::new(&graph, Vec::new());
    let grouping = GroupPartition {
        groups: (0..group_count)
            .map(|group| Group {
                kind: GroupKind::Memory,
                members: ((group * members_per_group) as NodeId
                    ..((group + 1) * members_per_group) as NodeId)
                    .collect(),
                label: format!("memory{group} [300×1]"),
                cell_type: "$mem".to_owned(),
            })
            .collect(),
        group_of: (0..node_count as NodeId)
            .map(|id| (id, id / members_per_group as NodeId))
            .collect(),
    };

    let result = analysis.full_netlist(
        &graph,
        full_options(group_count, false, true, false, &[]),
        Some(GroupingProjection::all(&grouping)),
    );

    assert!(result.truncated);
    assert_eq!(result.nodes.len(), group_count);
    assert!(result.nodes.iter().all(|node| {
        node.members
            .as_ref()
            .is_some_and(|members| !members.is_empty())
    }));
    assert!(
        result
            .nodes
            .iter()
            .map(|node| node.members.as_ref().map_or(0, Vec::len))
            .sum::<usize>()
            <= MAX_SUBGRAPH_NODES
    );
}

#[test]
fn source_selection_caps_raw_edge_bits_before_serialization() {
    let edge_count = MAX_SUBGRAPH_EDGES * 2;
    let edges: Vec<Edge> = (0..edge_count)
        .map(|bit| Edge {
            from: 0,
            to: 1,
            from_port: "a".to_owned(),
            to_port: "A".to_owned(),
            to_port_bit: bit as u32,
            bit: Some(bit as u32),
            net_name: "wide".to_owned(),
            control: false,
        })
        .collect();
    let graph = graph_from_parts(
        "wide_edges",
        vec![
            port_node(0, "a", PortDirection::Input),
            combinational_node(1, "$and", Some("source.sv:10")),
        ],
        edges,
        vec![(0..edge_count).collect(), Vec::new()],
        vec![Vec::new(), (0..edge_count).collect()],
    );
    let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "source.sv",
                start_line: 10,
                end_line: 10,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();

    assert!(result.graph.truncated);
    assert_eq!(result.graph.edges.len(), 1);
    assert_eq!(result.graph.edges[0].bits.len(), MAX_FULL_GROUP_MEMBERS);

    let full = analysis.full_netlist(&graph, full_options(2, true, false, false, &[]), None);
    assert!(full.truncated);
    assert_eq!(full.edges.len(), 1);
    assert_eq!(full.edges[0].bits.len(), MAX_FULL_GROUP_MEMBERS);

    let context = analysis.full_netlist(&graph, full_options(2, true, false, false, &[1]), None);
    assert!(context.truncated);
    assert_eq!(context.edges.len(), 1);
    assert_eq!(context.edges[0].bits.len(), MAX_FULL_GROUP_MEMBERS);
}

#[test]
fn source_selection_caps_examined_hidden_edges() {
    let edge_count = MAX_SUBGRAPH_EDGES * 2;
    let edges: Vec<Edge> = (0..edge_count)
        .map(|bit| Edge {
            from: 0,
            to: 1,
            from_port: "1'b0".to_owned(),
            to_port: "A".to_owned(),
            to_port_bit: bit as u32,
            bit: Some(bit as u32),
            net_name: "hidden".to_owned(),
            control: false,
        })
        .collect();
    let graph = graph_from_parts(
        "hidden_edges",
        vec![
            constant_node(0, "1'b0"),
            combinational_node(1, "$and", Some("source.sv:10")),
        ],
        edges,
        vec![(0..edge_count).collect(), Vec::new()],
        vec![Vec::new(), (0..edge_count).collect()],
    );
    let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "source.sv",
                start_line: 10,
                end_line: 10,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();

    assert!(result.graph.truncated);
    assert_eq!(result.graph.nodes.len(), 1);
    assert!(result.graph.edges.is_empty());
}

#[test]
fn source_selection_queries_sparse_targets_in_a_large_procedural_block() {
    let graph = source_selection_fixture();
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.set_source_probe_hints(vec![SourceProbeHint {
        file: "top.sv".to_owned(),
        start_line: 1,
        start_column: None,
        end_line: 1_000_000_000,
        end_column: None,
        direction: SourceProbeDirection::Fanin,
        kind: SourceProbeHintKind::Block,
    }]);
    analysis.set_procedural_targets(HashMap::from([(
        ("top.sv".to_owned(), 999_999_999),
        vec![1],
    )]));
    let started = Instant::now();

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 500_000_000,
                end_line: 500_000_000,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();

    assert!(started.elapsed().as_secs() < 1);
    assert_eq!(result.status, SourceSelectionStatus::Mapped);
    assert_eq!(
        result
            .graph
            .nodes
            .iter()
            .filter(|node| node.is_root == Some(true))
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![1]
    );
}

#[test]
fn source_selection_caps_duplicate_procedural_target_visits() {
    let graph = source_selection_fixture();
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    let end_line = SOURCE_PROBE_TARGET_VISIT_CAP * 2;
    analysis.set_source_probe_hints(vec![SourceProbeHint {
        file: "top.sv".to_owned(),
        start_line: 1,
        start_column: None,
        end_line,
        end_column: None,
        direction: SourceProbeDirection::Fanin,
        kind: SourceProbeHintKind::Block,
    }]);
    analysis.set_procedural_targets(
        (1..=end_line)
            .map(|line| (("top.sv".to_owned(), line), vec![1]))
            .collect(),
    );
    let started = Instant::now();

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 1,
                end_line: 1,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();

    assert!(started.elapsed().as_secs() < 1);
    assert!(result.graph.truncated);
    assert_eq!(result.status, SourceSelectionStatus::Mapped);
    assert_eq!(
        result
            .graph
            .nodes
            .iter()
            .filter(|node| node.is_root == Some(true))
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![1]
    );
}

#[test]
fn source_selection_preserves_validation_precedence() {
    let graph = source_selection_fixture();
    let analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    let select = |file, start_line, end_line| {
        analysis.source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file,
                start_line,
                end_line,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
    };

    assert_eq!(
        select("missing.sv", 0, 0).unwrap_err(),
        SourceSelectionError::UnknownFile
    );
    assert_eq!(
        select("top.sv", 0, 0).unwrap_err(),
        SourceSelectionError::InvalidRange
    );
    assert_eq!(
        select("top.sv", 1, 201).unwrap_err(),
        SourceSelectionError::TooManyLines
    );
}

#[test]
fn source_selection_honors_directional_hints_and_legacy_envelopes() {
    let mut fanin_graph = source_selection_fixture();
    fanin_graph.nodes[1].src = Some("top.sv:4".to_owned());
    let mut fanin_analysis = Analysis::new(&fanin_graph, vec!["top.sv".to_owned()]);
    fanin_analysis.set_source_probe_hints(vec![SourceProbeHint {
        file: "top.sv".to_owned(),
        start_line: 4,
        start_column: None,
        end_line: 4,
        end_column: None,
        direction: SourceProbeDirection::Fanin,
        kind: SourceProbeHintKind::Signal,
    }]);
    let fanin = fanin_analysis
        .source_selection(
            &fanin_graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 4,
                end_line: 4,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();
    assert_eq!(
        fanin
            .graph
            .nodes
            .iter()
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(fanin.direct_ids, vec![1]);

    let mut fanout_graph = source_selection_fixture();
    fanout_graph.nodes[0].src = Some("top.sv:2".to_owned());
    let mut fanout_analysis = Analysis::new(&fanout_graph, vec!["top.sv".to_owned()]);
    fanout_analysis.set_source_probe_hints(vec![SourceProbeHint {
        file: "top.sv".to_owned(),
        start_line: 2,
        start_column: None,
        end_line: 2,
        end_column: None,
        direction: SourceProbeDirection::Fanout,
        kind: SourceProbeHintKind::Signal,
    }]);
    let fanout = fanout_analysis
        .source_selection(
            &fanout_graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 2,
                end_line: 2,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();
    assert_eq!(
        fanout
            .graph
            .nodes
            .iter()
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_eq!(fanout.graph.nodes[2].is_boundary, Some(true));

    let mut envelope_graph = source_selection_fixture();
    envelope_graph.nodes[1].src = Some("top.sv:7".to_owned());
    let envelope_analysis = Analysis::new(&envelope_graph, vec!["top.sv".to_owned()]);
    let envelope = envelope_analysis
        .source_selection(
            &envelope_graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 7,
                end_line: 7,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();
    assert_eq!(
        envelope
            .graph
            .nodes
            .iter()
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
}

#[test]
fn source_selection_narrows_block_attribution_to_the_assignment_target() {
    let mut first = combinational_node(0, "$dff", Some("top.sv:8.1-14.3"));
    first.seq = true;
    let mut second = combinational_node(1, "$dff", Some("top.sv:8.1-14.3"));
    second.seq = true;
    let graph = graph_from_parts(
        "procedural",
        vec![first, second],
        Vec::new(),
        vec![Vec::new(), Vec::new()],
        vec![Vec::new(), Vec::new()],
    );
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.set_procedural_targets(HashMap::from([(("top.sv".to_owned(), 10), vec![0])]));
    analysis.set_source_probe_hints(vec![SourceProbeHint {
        file: "top.sv".to_owned(),
        start_line: 10,
        start_column: None,
        end_line: 10,
        end_column: None,
        direction: SourceProbeDirection::Fanin,
        kind: SourceProbeHintKind::Procedural,
    }]);

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 10,
                end_line: 10,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();
    assert_eq!(
        result
            .graph
            .nodes
            .iter()
            .filter(|node| node.is_root == Some(true))
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![0]
    );
}

#[test]
fn same_span_signal_hint_suppresses_coalesced_block_policy() {
    let mut graph = source_selection_fixture();
    graph.nodes[1].src = Some("top.sv:4".to_owned());
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.set_source_probe_hints(vec![
        SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 4,
            start_column: None,
            end_line: 4,
            end_column: None,
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::Block,
        },
        SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 4,
            start_column: None,
            end_line: 4,
            end_column: None,
            direction: SourceProbeDirection::Fanout,
            kind: SourceProbeHintKind::Signal,
        },
    ]);

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 4,
                end_line: 4,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();

    assert_eq!(
        result
            .graph
            .nodes
            .iter()
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
}

#[test]
fn source_selection_distinguishes_optimized_source_from_unmapped_text() {
    let graph = source_selection_fixture();
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    let seen = SourceRangeMapping {
        file: "top.sv".to_owned(),
        start_line: 20,
        end_line: 20,
        start_column: None,
        end_column: None,
        node_ids: Vec::new(),
        signal_bits: Vec::new(),
        approximate_signal_bits: Vec::new(),
        mapping_incomplete: false,
    };
    analysis.extend_source_ranges(
        vec![
            seen,
            SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 22,
                end_line: 22,
                start_column: Some(7),
                end_column: Some(16),
                node_ids: Vec::new(),
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            },
        ],
        false,
    );

    let status = |line| {
        analysis
            .source_selection(
                &graph,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: line,
                    end_line: line,
                    start_column: None,
                    end_column: None,
                },
                selection_options(),
            )
            .unwrap()
            .status
    };
    assert_eq!(status(20), SourceSelectionStatus::OptimizedOrAbsorbed);
    assert_eq!(status(21), SourceSelectionStatus::Unmapped);
    let optimized_declaration = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 22,
                end_line: 22,
                start_column: Some(1),
                end_column: Some(1),
            },
            selection_options(),
        )
        .unwrap();
    assert_eq!(
        optimized_declaration.status,
        SourceSelectionStatus::Unmapped
    );
}

#[test]
fn source_selection_reports_aggregate_direct_bit_truncation() {
    let graph = source_selection_fixture();
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(
        (0..=SOURCE_ROOT_COLLECTION_CAP)
            .map(|bit| SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 30,
                end_line: 30,
                start_column: None,
                end_column: None,
                node_ids: Vec::new(),
                signal_bits: vec![bit as u32],
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            })
            .collect(),
        false,
    );

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 30,
                end_line: 30,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();

    assert_eq!(result.status, SourceSelectionStatus::MappingIncomplete);
    assert_eq!(result.direct_bits.len(), SOURCE_ROOT_COLLECTION_CAP);
}

#[test]
fn bit_to_source_query_is_independent_of_the_bulk_source_map_cap() {
    let graph = source_selection_fixture();
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    let target_line = SOURCE_RANGE_RESPONSE_CAP + 1;
    analysis.extend_source_ranges(
        (1..=target_line)
            .map(|line| SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: line,
                end_line: line,
                start_column: Some(7),
                end_column: Some(12),
                node_ids: Vec::new(),
                signal_bits: vec![if line == target_line { 99 } else { 1 }],
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            })
            .collect(),
        false,
    );

    let bulk = analysis.source_map();
    assert!(bulk.truncated);
    assert!(
        !bulk
            .ranges
            .iter()
            .any(|range| range.start_line == target_line)
    );
    let reverse = analysis.source_ranges_for_bits(&[99]);
    assert!(!reverse.truncated);
    assert_eq!(reverse.ranges.len(), 1);
    assert_eq!(reverse.ranges[0].start_line, target_line);
    assert!(reverse.ranges[0].node_ids.is_empty());
    assert!(reverse.ranges[0].signal_bits.is_empty());
}

#[test]
fn bit_to_source_query_reports_incomplete_provenance() {
    let graph = source_selection_fixture();
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(
        vec![SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 2,
            end_line: 2,
            start_column: Some(7),
            end_column: Some(12),
            node_ids: vec![1],
            signal_bits: vec![99],
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: true,
        }],
        false,
    );

    let reverse = analysis.source_ranges_for_bits(&[99]);
    assert!(reverse.truncated);
    assert!(!reverse.approximate);
    assert_eq!(reverse.ranges.len(), 1);
    assert!(reverse.ranges[0].mapping_incomplete);

    analysis.extend_source_ranges(Vec::new(), true);
    assert!(analysis.source_ranges_for_bits(&[99]).truncated);
}

#[test]
fn bit_to_source_query_deduplicates_input_and_orders_exact_and_approximate_ranges() {
    let graph = source_selection_fixture();
    let mut analysis = Analysis::new(&graph, vec!["z.sv".to_owned(), "a.sv".to_owned()]);
    analysis.extend_source_ranges(
        vec![
            SourceRangeMapping {
                file: "z.sv".to_owned(),
                start_line: 5,
                end_line: 5,
                start_column: None,
                end_column: None,
                node_ids: vec![2],
                signal_bits: Vec::new(),
                approximate_signal_bits: vec![9],
                mapping_incomplete: false,
            },
            SourceRangeMapping {
                file: "a.sv".to_owned(),
                start_line: 9,
                end_line: 9,
                start_column: Some(7),
                end_column: Some(12),
                node_ids: vec![1],
                signal_bits: vec![9],
                approximate_signal_bits: vec![7],
                mapping_incomplete: false,
            },
            SourceRangeMapping {
                file: "a.sv".to_owned(),
                start_line: 3,
                end_line: 3,
                start_column: Some(2),
                end_column: Some(4),
                node_ids: vec![0],
                signal_bits: vec![7],
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            },
        ],
        false,
    );

    let reverse = analysis.source_ranges_for_bits(&[9, 7, 9, 7]);

    assert!(!reverse.truncated);
    assert!(reverse.approximate);
    assert_eq!(
        reverse
            .ranges
            .iter()
            .map(|range| (range.file.as_str(), range.start_line))
            .collect::<Vec<_>>(),
        vec![("a.sv", 3), ("a.sv", 9), ("z.sv", 5)]
    );
    assert!(reverse.ranges.iter().all(|range| {
        range.node_ids.is_empty()
            && range.signal_bits.is_empty()
            && range.approximate_signal_bits.is_empty()
    }));
    assert_eq!(reverse.ranges[0].start_column, Some(2));
    assert_eq!(reverse.ranges[1].end_column, Some(12));
    assert_eq!(reverse.ranges[2].start_column, None);
}

#[test]
fn source_selection_reports_global_source_mapping_truncation() {
    let graph = source_selection_fixture();
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(Vec::new(), true);

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 21,
                end_line: 21,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();

    assert_eq!(result.status, SourceSelectionStatus::MappingIncomplete);
}

#[test]
fn duplicate_source_spans_coalesce_without_hiding_distinct_spans() {
    let duplicate = SourceRangeMapping {
        file: "top.sv".to_owned(),
        start_line: 2,
        end_line: 2,
        start_column: Some(7),
        end_column: Some(12),
        node_ids: Vec::new(),
        signal_bits: Vec::new(),
        approximate_signal_bits: Vec::new(),
        mapping_incomplete: false,
    };
    let distinct = SourceRangeMapping {
        start_line: 3,
        end_line: 3,
        ..duplicate.clone()
    };
    let graph = graph_from_parts("spans", Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(vec![duplicate.clone(), duplicate, distinct], false);

    let source_map = analysis.source_map();
    assert_eq!(source_map.ranges.len(), 2);
    assert!(source_map.ranges.iter().any(|range| range.start_line == 3));
}

#[test]
fn shared_coordinates_preserve_distinct_mapping_completeness() {
    let graph = graph_from_parts(
        "shared_coordinates",
        vec![
            combinational_node(0, "$and", None),
            combinational_node(1, "$or", None),
        ],
        Vec::new(),
        vec![Vec::new(); 2],
        vec![Vec::new(); 2],
    );
    let complete = SourceRangeMapping {
        file: "top.sv".to_owned(),
        start_line: 2,
        end_line: 2,
        start_column: Some(7),
        end_column: Some(12),
        node_ids: vec![0],
        signal_bits: vec![1],
        approximate_signal_bits: Vec::new(),
        mapping_incomplete: false,
    };
    let incomplete = SourceRangeMapping {
        node_ids: vec![1],
        signal_bits: vec![2],
        mapping_incomplete: true,
        ..complete.clone()
    };
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(vec![complete.clone(), incomplete.clone()], false);

    assert_eq!(analysis.source_map().ranges, vec![complete, incomplete]);
    assert!(!analysis.source_ranges_for_bits(&[1]).truncated);
    assert!(analysis.source_ranges_for_bits(&[2]).truncated);
    assert_eq!(
        analysis.node_ref(&graph, 0).src.as_deref(),
        Some("top.sv:2.7-2.12")
    );
    assert_eq!(
        analysis.node_ref(&graph, 1).src.as_deref(),
        Some("top.sv:2.7-2.12")
    );
}

#[test]
fn canonical_source_index_reports_omitted_distinct_spans() {
    let graph = source_selection_fixture();
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis
        .source_provenance
        .mark_test_span_incomplete("top.sv");
    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 9,
                end_line: 9,
                start_column: Some(4),
                end_column: Some(4),
            },
            selection_options(),
        )
        .unwrap();
    assert_eq!(result.status, SourceSelectionStatus::MappingIncomplete);
}

#[test]
fn canonical_source_index_rejects_recovered_range_overflow() {
    let graph = sourced_node_graph(1);
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    let ranges = (1..=SOURCE_RANGE_INDEX_CAP + 1)
        .map(|line| SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: line,
            end_line: line,
            start_column: Some(1),
            end_column: Some(2),
            node_ids: Vec::new(),
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        })
        .collect();

    analysis.extend_source_ranges(ranges, false);

    assert_eq!(
        analysis.source_provenance.recovered_span_count(),
        SOURCE_RANGE_INDEX_CAP
    );
    assert!(analysis.source_map().truncated);
    assert!(analysis.source_ranges_for_bits(&[]).truncated);
}

#[test]
fn source_selection_distinguishes_same_line_node_spans() {
    let graph = graph_from_parts(
        "same_line_nodes",
        vec![
            combinational_node(0, "$and", Some("top.sv:5.1-5.12")),
            combinational_node(1, "$or", Some("top.sv:5.20-5.30")),
        ],
        Vec::new(),
        vec![Vec::new(); 2],
        vec![Vec::new(); 2],
    );
    let analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    let select = |column| {
        analysis
            .source_selection(
                &graph,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 5,
                    end_line: 5,
                    start_column: Some(column),
                    end_column: Some(column),
                },
                selection_options(),
            )
            .unwrap()
    };

    assert_eq!(select(6).direct_ids, vec![0]);
    assert_eq!(select(25).direct_ids, vec![1]);
    assert_eq!(select(16).status, SourceSelectionStatus::Unmapped);
}

#[test]
fn precise_mapping_does_not_hide_native_nodes_on_other_selected_lines() {
    let graph = graph_from_parts(
        "mixed_source_ranges",
        vec![
            combinational_node(0, "$and", Some("top.sv:5.1-5.12")),
            combinational_node(1, "$or", Some("top.sv:6.1-6.12")),
        ],
        Vec::new(),
        vec![Vec::new(); 2],
        vec![Vec::new(); 2],
    );
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(
        vec![SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 5,
            end_line: 5,
            start_column: Some(1),
            end_column: Some(12),
            node_ids: vec![0],
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        }],
        false,
    );

    let probe = analysis
        .source_provenance
        .resolve_selection(
            SourceSelectionRange {
                file: "top.sv",
                start_line: 5,
                end_line: 6,
                start_column: Some(1),
                end_column: Some(12),
            },
            None,
        )
        .unwrap();
    assert_eq!(probe.roots, vec![0, 1]);
}

#[test]
fn collapsed_caret_falls_back_to_the_nearest_span_inside_its_statement() {
    let graph = graph_from_parts(
        "nearest_declaration",
        vec![
            combinational_node(0, "$and", None),
            combinational_node(1, "$or", None),
        ],
        Vec::new(),
        vec![Vec::new(); 2],
        vec![Vec::new(); 2],
    );
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(
        vec![
            SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 5,
                end_line: 5,
                start_column: Some(7),
                end_column: Some(11),
                node_ids: vec![0],
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            },
            SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 5,
                end_line: 5,
                start_column: Some(20),
                end_column: Some(25),
                node_ids: vec![1],
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            },
        ],
        false,
    );
    let select = |column, fallback_columns| {
        analysis
            .source_selection_with_fallback(
                &graph,
                &GroupPartition::default(),
                SourceSelectionRange {
                    file: "top.sv",
                    start_line: 5,
                    end_line: 5,
                    start_column: Some(column),
                    end_column: Some(column),
                },
                Some(fallback_columns),
                selection_options(),
            )
            .unwrap()
            .direct_ids
    };

    assert_eq!(select(1, (1, 12)), vec![0]);
    assert_eq!(select(14, (13, 26)), vec![1]);
    assert!(select(14, (13, 18)).is_empty());
    assert_eq!(select(22, (1, 26)), vec![1]);
}

#[test]
fn collapsed_caret_falls_back_to_a_native_yosys_span() {
    let graph = graph_from_parts(
        "native_fallback",
        vec![combinational_node(0, "$and", Some("top.sv:5.7-5.25"))],
        Vec::new(),
        vec![Vec::new()],
        vec![Vec::new()],
    );
    let analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    let result = analysis
        .source_selection_with_fallback(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 5,
                end_line: 5,
                start_column: Some(1),
                end_column: Some(1),
            },
            Some((1, 26)),
            selection_options(),
        )
        .unwrap();

    assert_eq!(result.status, SourceSelectionStatus::Mapped);
    assert_eq!(result.direct_ids, vec![0]);

    let end_of_line = analysis
        .source_selection_with_fallback(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 5,
                end_line: 5,
                start_column: Some(26),
                end_column: Some(26),
            },
            Some((1, 25)),
            selection_options(),
        )
        .unwrap();
    assert_eq!(end_of_line.status, SourceSelectionStatus::Mapped);
    assert_eq!(end_of_line.direct_ids, vec![0]);
}

#[test]
fn exact_optimized_span_does_not_fall_through_to_a_mapped_neighbor() {
    let graph = graph_from_parts(
        "optimized_neighbor",
        vec![combinational_node(0, "$and", None)],
        Vec::new(),
        vec![Vec::new()],
        vec![Vec::new()],
    );
    let optimized = SourceRangeMapping {
        file: "top.sv".to_owned(),
        start_line: 5,
        end_line: 5,
        start_column: Some(7),
        end_column: Some(11),
        node_ids: Vec::new(),
        signal_bits: Vec::new(),
        approximate_signal_bits: Vec::new(),
        mapping_incomplete: false,
    };
    let mapped = SourceRangeMapping {
        file: "top.sv".to_owned(),
        start_line: 5,
        end_line: 5,
        start_column: Some(20),
        end_column: Some(25),
        node_ids: vec![0],
        signal_bits: vec![42],
        approximate_signal_bits: Vec::new(),
        mapping_incomplete: false,
    };
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(vec![mapped.clone(), optimized.clone()], false);

    let result = analysis
        .source_selection_with_fallback(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 5,
                end_line: 5,
                start_column: Some(9),
                end_column: Some(9),
            },
            Some((1, 30)),
            selection_options(),
        )
        .unwrap();

    assert_eq!(result.status, SourceSelectionStatus::OptimizedOrAbsorbed);
    assert!(result.direct_ids.is_empty());
    assert!(result.direct_bits.is_empty());
    assert!(result.graph.nodes.is_empty());
}

#[test]
fn fallback_ties_are_stable_and_only_apply_to_valid_collapsed_carets() {
    let graph = graph_from_parts(
        "fallback_boundaries",
        vec![
            combinational_node(0, "$and", None),
            combinational_node(1, "$or", None),
        ],
        Vec::new(),
        vec![Vec::new(); 2],
        vec![Vec::new(); 2],
    );
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(
        vec![
            SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 5,
                end_line: 5,
                start_column: Some(7),
                end_column: Some(9),
                node_ids: vec![0],
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            },
            SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 5,
                end_line: 5,
                start_column: Some(13),
                end_column: Some(15),
                node_ids: vec![1],
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            },
        ],
        false,
    );
    let select = |selection, fallback_columns| {
        analysis
            .source_selection_with_fallback(
                &graph,
                &GroupPartition::default(),
                selection,
                fallback_columns,
                selection_options(),
            )
            .unwrap()
    };
    let caret = |column| SourceSelectionRange {
        file: "top.sv",
        start_line: 5,
        end_line: 5,
        start_column: Some(column),
        end_column: Some(column),
    };

    assert_eq!(select(caret(11), Some((1, 20))).direct_ids, vec![0]);
    assert_eq!(select(caret(11), Some((10, 20))).direct_ids, vec![1]);
    assert!(select(caret(11), Some((12, 20))).direct_ids.is_empty());
    assert!(select(caret(11), None).direct_ids.is_empty());
    assert!(
        select(
            SourceSelectionRange {
                start_column: Some(10),
                end_column: Some(11),
                ..caret(10)
            },
            Some((1, 20)),
        )
        .direct_ids
        .is_empty()
    );
    assert!(
        select(
            SourceSelectionRange {
                start_line: 5,
                end_line: 6,
                start_column: Some(16),
                end_column: Some(1),
                ..caret(16)
            },
            Some((1, 20)),
        )
        .direct_ids
        .is_empty()
    );
}

#[test]
fn node_ref_unions_deduplicates_and_orders_native_and_synthetic_sources() {
    let graph = graph_from_parts(
        "source_union",
        vec![combinational_node(
            0,
            "$and",
            Some("top.sv:9.1-9.3|top.sv:2.1-2.3|top.sv:9.1-9.3"),
        )],
        Vec::new(),
        vec![Vec::new()],
        vec![Vec::new()],
    );
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(
        vec![
            SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 4,
                end_line: 4,
                start_column: Some(7),
                end_column: Some(8),
                node_ids: vec![0],
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            },
            SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: 2,
                end_line: 2,
                start_column: Some(1),
                end_column: Some(3),
                node_ids: vec![0],
                signal_bits: Vec::new(),
                approximate_signal_bits: Vec::new(),
                mapping_incomplete: false,
            },
        ],
        false,
    );

    assert_eq!(
        analysis.node_ref(&graph, 0).src.as_deref(),
        Some("top.sv:2.1-2.3|top.sv:4.7-4.8|top.sv:9.1-9.3")
    );
}

#[test]
fn exact_native_mapping_wins_when_the_auxiliary_span_index_is_incomplete() {
    let graph = graph_from_parts(
        "exact_native",
        vec![
            combinational_node(0, "$and", Some("top.sv:5.7-5.11")),
            combinational_node(1, "$or", None),
        ],
        Vec::new(),
        vec![Vec::new(); 2],
        vec![Vec::new(); 2],
    );
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(
        vec![SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 5,
            end_line: 5,
            start_column: Some(20),
            end_column: Some(25),
            node_ids: vec![1],
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        }],
        false,
    );
    analysis
        .source_provenance
        .mark_test_span_incomplete("top.sv");

    let result = analysis
        .source_selection_with_fallback(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 5,
                end_line: 5,
                start_column: Some(9),
                end_column: Some(9),
            },
            Some((1, 26)),
            selection_options(),
        )
        .unwrap();

    assert_eq!(result.direct_ids, vec![0]);
    assert_eq!(result.status, SourceSelectionStatus::MappingIncomplete);
}

#[test]
fn bidirectional_source_probe_uses_a_local_neighborhood() {
    let graph = deep_chain_graph(10);
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(
        vec![SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 5,
            end_line: 5,
            start_column: Some(7),
            end_column: Some(16),
            node_ids: vec![5],
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        }],
        false,
    );
    analysis.set_source_probe_hints(vec![
        SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 5,
            start_column: Some(7),
            end_line: 5,
            end_column: Some(16),
            direction: SourceProbeDirection::Fanin,
            kind: SourceProbeHintKind::Signal,
        },
        SourceProbeHint {
            file: "top.sv".to_owned(),
            start_line: 5,
            start_column: Some(7),
            end_line: 5,
            end_column: Some(16),
            direction: SourceProbeDirection::Fanout,
            kind: SourceProbeHintKind::Signal,
        },
    ]);

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 5,
                end_line: 5,
                start_column: Some(10),
                end_column: Some(10),
            },
            selection_options(),
        )
        .unwrap();

    assert_eq!(
        result
            .graph
            .nodes
            .iter()
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![4, 5, 6]
    );
}

#[test]
fn legacy_no_hint_source_probe_retains_its_deep_envelope() {
    let graph = deep_chain_graph(10);
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(
        vec![SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 5,
            end_line: 5,
            start_column: Some(7),
            end_column: Some(16),
            node_ids: vec![5],
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        }],
        false,
    );

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 5,
                end_line: 5,
                start_column: Some(10),
                end_column: Some(10),
            },
            selection_options(),
        )
        .unwrap();

    assert_eq!(
        result
            .graph
            .nodes
            .iter()
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        (0..graph.nodes.len() as u32).collect::<Vec<_>>()
    );
}

#[test]
fn source_selection_expands_a_direct_output_register_through_its_data_input() {
    let mut register = combinational_node(2, "$dff", None);
    register.seq = true;
    register.name = "registered".to_owned();
    let mut output = port_node(3, "y", PortDirection::Output);
    output.src = Some("top.sv:5".to_owned());
    let nodes = vec![
        port_node(0, "a", PortDirection::Input),
        combinational_node(1, "$and", None),
        register,
        output,
    ];
    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::new(); nodes.len()];
    let mut incoming = vec![Vec::new(); nodes.len()];
    for (from, to, from_port, to_port) in [(0, 1, "a", "A"), (1, 2, "Y", "D"), (2, 3, "Q", "y")] {
        let index = edges.len();
        edges.push(Edge {
            from,
            to,
            from_port: from_port.to_owned(),
            to_port: to_port.to_owned(),
            to_port_bit: 0,
            bit: Some(index as u32),
            net_name: format!("n{index}"),
            control: false,
        });
        outgoing[from as usize].push(index);
        incoming[to as usize].push(index);
    }
    let graph = graph_from_parts("registered_output", nodes, edges, outgoing, incoming);
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.set_source_probe_hints(vec![SourceProbeHint {
        file: "top.sv".to_owned(),
        start_line: 5,
        start_column: None,
        end_line: 5,
        end_column: None,
        direction: SourceProbeDirection::Fanin,
        kind: SourceProbeHintKind::OutputPort,
    }]);

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 5,
                end_line: 5,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();
    assert_eq!(
        result
            .graph
            .nodes
            .iter()
            .map(|node| node.node.id)
            .collect::<Vec<_>>(),
        vec![0, 1, 2, 3]
    );
}

#[test]
fn source_selection_keeps_visible_controls_for_dependency_registers() {
    let mut register = combinational_node(2, "$dff", None);
    register.seq = true;
    register.name = "registered".to_owned();
    let mut output = port_node(3, "y", PortDirection::Output);
    output.src = Some("top.sv:5".to_owned());
    let nodes = vec![
        port_node(0, "a", PortDirection::Input),
        combinational_node(1, "$and", None),
        register,
        output,
        port_node(4, "clk", PortDirection::Input),
        port_node(5, "rst", PortDirection::Input),
    ];
    let connections = [
        (0, 1, "a", "A", false),
        (2, 1, "Q", "B", false),
        (1, 3, "Y", "y", false),
        (4, 2, "clk", "C", true),
        (5, 2, "rst", "R", true),
    ];
    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::new(); nodes.len()];
    let mut incoming = vec![Vec::new(); nodes.len()];
    for (from, to, from_port, to_port, control) in connections {
        let index = edges.len();
        edges.push(Edge {
            from,
            to,
            from_port: from_port.to_owned(),
            to_port: to_port.to_owned(),
            to_port_bit: 0,
            bit: Some(index as u32),
            net_name: from_port.to_owned(),
            control,
        });
        outgoing[from as usize].push(index);
        incoming[to as usize].push(index);
    }
    let graph = graph_from_parts(
        "registered_output_controls",
        nodes,
        edges,
        outgoing,
        incoming,
    );
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.set_source_probe_hints(vec![SourceProbeHint {
        file: "top.sv".to_owned(),
        start_line: 5,
        start_column: None,
        end_line: 5,
        end_column: None,
        direction: SourceProbeDirection::Fanin,
        kind: SourceProbeHintKind::OutputPort,
    }]);

    let result = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 5,
                end_line: 5,
                start_column: None,
                end_column: None,
            },
            SourceSelectionOptions {
                hide_control: false,
                ..selection_options()
            },
        )
        .unwrap();

    assert!(
        result
            .graph
            .nodes
            .iter()
            .any(|node| node.node.name == "clk")
    );
    assert!(
        result
            .graph
            .nodes
            .iter()
            .any(|node| node.node.name == "rst")
    );
    assert!(
        result
            .graph
            .edges
            .iter()
            .any(|edge| { edge.to == 2 && edge.to_port == "C" && edge.control == Some(true) })
    );
    assert!(
        result
            .graph
            .edges
            .iter()
            .any(|edge| { edge.to == 2 && edge.to_port == "R" && edge.control == Some(true) })
    );

    let hidden = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "top.sv",
                start_line: 5,
                end_line: 5,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();
    assert!(
        hidden
            .graph
            .nodes
            .iter()
            .all(|node| !matches!(node.node.name.as_str(), "clk" | "rst"))
    );
    assert!(
        hidden
            .graph
            .edges
            .iter()
            .all(|edge| edge.control != Some(true))
    );
}

#[test]
fn source_selection_projects_groups_and_prioritizes_incomplete_mapping() {
    let graph = graph_from_parts(
        "grouped_source",
        vec![
            port_node(0, "a", PortDirection::Input),
            combinational_node(1, "$and", Some("top.sv:9-12")),
            port_node(2, "y", PortDirection::Output),
            combinational_node(3, "$and", Some("top.sv:9-12")),
        ],
        Vec::new(),
        vec![Vec::new(); 4],
        vec![Vec::new(); 4],
    );
    let range = SourceRangeMapping {
        file: "top.sv".to_owned(),
        start_line: 9,
        start_column: None,
        end_line: 9,
        end_column: None,
        node_ids: vec![1, 3],
        signal_bits: Vec::new(),
        approximate_signal_bits: Vec::new(),
        mapping_incomplete: true,
    };
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(vec![range.clone()], false);
    analysis.set_source_probe_hints(vec![SourceProbeHint {
        file: "top.sv".to_owned(),
        start_line: 9,
        start_column: None,
        end_line: 9,
        end_column: None,
        direction: SourceProbeDirection::Fanin,
        kind: SourceProbeHintKind::Signal,
    }]);
    let grouping = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Comb,
            members: vec![1, 3],
            label: "logic[1:0]".to_owned(),
            cell_type: "$and".to_owned(),
        }],
        group_of: HashMap::from([(1, 0), (3, 0)]),
    };
    let result = analysis
        .source_selection(
            &graph,
            &grouping,
            SourceSelectionRange {
                file: "top.sv",
                start_line: 9,
                end_line: 9,
                start_column: None,
                end_column: None,
            },
            SourceSelectionOptions {
                group_vectors: true,
                ..selection_options()
            },
        )
        .unwrap();

    assert_eq!(result.status, SourceSelectionStatus::MappingIncomplete);
    assert_eq!(result.graph.nodes.len(), 1);
    let group = &result.graph.nodes[0];
    assert_eq!(group.node.id, 4);
    assert_eq!(group.node.name, "logic[1:0]");
    assert_eq!(group.node.src.as_deref(), Some("top.sv:9-12|top.sv:9-9"));
    assert_eq!(group.is_root, Some(true));
    assert_eq!(group.width, Some(2));
    assert_eq!(group.members.as_deref(), Some(&[1, 3][..]));
    assert_eq!(result.direct_ids, vec![4]);
    assert!(group.controls.is_empty());
}

#[test]
fn source_selection_preserves_recovered_metadata_on_grouped_ports() {
    let graph = graph_from_parts(
        "grouped_ports",
        vec![
            port_node(0, "a[0]", PortDirection::Input),
            port_node(1, "a[1]", PortDirection::Input),
        ],
        Vec::new(),
        vec![Vec::new(); 2],
        vec![Vec::new(); 2],
    );
    let range = SourceRangeMapping {
        file: "top.sv".to_owned(),
        start_line: 2,
        end_line: 2,
        start_column: None,
        end_column: None,
        node_ids: vec![0, 1],
        signal_bits: Vec::new(),
        approximate_signal_bits: Vec::new(),
        mapping_incomplete: false,
    };
    let mut analysis = Analysis::new(&graph, vec!["top.sv".to_owned()]);
    analysis.extend_source_ranges(vec![range.clone()], false);
    let grouping = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Port,
            members: vec![0, 1],
            label: "a[1:0]".to_owned(),
            cell_type: String::new(),
        }],
        group_of: HashMap::from([(0, 0), (1, 0)]),
    };
    let result = analysis
        .source_selection(
            &graph,
            &grouping,
            SourceSelectionRange {
                file: "top.sv",
                start_line: 2,
                end_line: 2,
                start_column: None,
                end_column: None,
            },
            SourceSelectionOptions {
                group_vectors: true,
                ..selection_options()
            },
        )
        .unwrap();

    assert_eq!(result.graph.nodes.len(), 1);
    let group = &result.graph.nodes[0];
    assert_eq!(group.node.id, 2);
    assert_eq!(group.node.name, "a[1:0]");
    assert_eq!(group.node.src.as_deref(), Some("top.sv:2-2"));
    assert_eq!(group.width, Some(2));
    assert!(group.controls.is_empty());
}

#[test]
fn quotient_boundary_metadata_preserves_sparse_declared_slots() {
    let mut nodes = (0..32)
        .map(|bit| {
            let mut node = port_node(bit, &format!("a[{bit}]"), PortDirection::Input);
            node.raw_name = "a".to_owned();
            node.port = Some("a".to_owned());
            node.port_bit = Some(bit as usize);
            node
        })
        .collect::<Vec<_>>();
    nodes.push(combinational_node(32, "$or", None));
    let graph = graph_from_parts(
        "sparse_boundary",
        nodes,
        Vec::new(),
        vec![Vec::new(); 33],
        vec![Vec::new(); 33],
    );
    let partition = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Port,
            members: (0..32).collect(),
            label: "a[31:0]".to_owned(),
            cell_type: String::new(),
        }],
        group_of: (0..32).map(|member| (member, 0)).collect(),
    };
    let projected_node = |id| GraphNode {
        node: node_ref(&graph, id),
        is_root: None,
        is_boundary: None,
        depth: None,
        params: BTreeMap::new(),
        controls: Vec::new(),
        width: None,
        member_count: None,
        members: None,
        boundary_members: Vec::new(),
    };
    let projected_edge = |member, bit| GraphEdge {
        from: member,
        to: 32,
        from_port: "a".to_owned(),
        to_port: "A".to_owned(),
        net_name: format!("a[{member}]"),
        bits: vec![bit],
        control: None,
        source_boundary_members: Vec::new(),
        target_boundary_members: Vec::new(),
    };
    let projected = Subgraph {
        nodes: vec![projected_node(0), projected_node(31), projected_node(32)],
        edges: vec![projected_edge(0, 100), projected_edge(31, 131)],
        truncated: true,
    };

    let quotient = quotient_subgraph(&graph, projected, GroupingProjection::all(&partition));
    let boundary = quotient
        .nodes
        .iter()
        .find(|node| node.node.name == "a[31:0]")
        .expect("sparse grouped boundary");
    assert_eq!(boundary.width, Some(2));
    assert_eq!(boundary.member_count, Some(32));
    assert_eq!(
        boundary.boundary_members,
        vec![
            BoundaryMember { member: 0, bit: 0 },
            BoundaryMember {
                member: 31,
                bit: 31
            },
        ]
    );
    let edge = quotient
        .edges
        .iter()
        .find(|edge| edge.from == boundary.node.id)
        .expect("collapsed sparse boundary edge");
    assert_eq!(
        edge.source_boundary_members,
        vec![
            EdgeBoundaryMember {
                member: 0,
                net_bits: vec![100],
            },
            EdgeBoundaryMember {
                member: 31,
                net_bits: vec![131],
            },
        ]
    );
    assert!(edge.target_boundary_members.is_empty());

    let permuted = Subgraph {
        nodes: vec![projected_node(32), projected_node(31), projected_node(0)],
        edges: vec![projected_edge(31, 131), projected_edge(0, 100)],
        truncated: true,
    };
    let permuted = quotient_subgraph(&graph, permuted, GroupingProjection::all(&partition));
    assert_eq!(
        serde_json::to_value(permuted).unwrap(),
        serde_json::to_value(quotient).unwrap(),
        "quotient metadata must not depend on projected node or edge order"
    );
}

#[test]
fn quotient_boundary_metadata_preserves_input_bits_through_hidden_buffers() {
    let mut input_0 = port_node(0, "a[0]", PortDirection::Input);
    input_0.raw_name = "a".to_owned();
    input_0.port = Some("a".to_owned());
    input_0.port_bit = Some(0);
    let mut input_1 = port_node(1, "a[1]", PortDirection::Input);
    input_1.raw_name = "a".to_owned();
    input_1.port = Some("a".to_owned());
    input_1.port_bit = Some(1);
    let graph = graph_from_parts(
        "buffered_boundary",
        vec![
            input_0,
            input_1,
            combinational_node(2, "IBUF", None),
            combinational_node(3, "$or", None),
        ],
        Vec::new(),
        vec![Vec::new(); 4],
        vec![Vec::new(); 4],
    );
    let partition = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Port,
            members: vec![0, 1],
            label: "a[1:0]".to_owned(),
            cell_type: String::new(),
        }],
        group_of: HashMap::from([(0, 0), (1, 0)]),
    };
    let projected_node = |id| GraphNode {
        node: node_ref(&graph, id),
        is_root: None,
        is_boundary: None,
        depth: None,
        params: BTreeMap::new(),
        controls: Vec::new(),
        width: None,
        member_count: None,
        members: None,
        boundary_members: Vec::new(),
    };
    let projected_edge =
        |from, to, from_port: &str, to_port: &str, net_name: &str, bit| GraphEdge {
            from,
            to,
            from_port: from_port.to_owned(),
            to_port: to_port.to_owned(),
            net_name: net_name.to_owned(),
            bits: vec![bit],
            control: None,
            source_boundary_members: Vec::new(),
            target_boundary_members: Vec::new(),
        };
    let mut projected = collapse_infrastructure(
        &graph,
        Subgraph {
            nodes: (0..4).map(projected_node).collect(),
            edges: vec![
                projected_edge(0, 3, "a", "A", "a[0]", 10),
                projected_edge(1, 2, "a", "I", "a[1]", 11),
                projected_edge(2, 3, "O", "A", "a_IBUF[1]", 101),
            ],
            truncated: false,
        },
    );
    // Exercise the production cap/sort boundary from a deliberately
    // non-canonical order. Edge and sidecar must move together.
    projected.subgraph.edges.reverse();
    projected.boundary_electrical.reverse();
    let projected = cap_subgraph_edges(projected);

    let buffered = projected
        .edges
        .iter()
        .find(|edge| edge.from == 1 && edge.to == 3)
        .expect("hidden IBUF must project input member 1 directly to the logic");
    assert_eq!(
        buffered.bits,
        vec![101],
        "visual edge identity remains the downstream post-IBUF net"
    );

    let quotient = quotient_subgraph(&graph, projected, GroupingProjection::all(&partition));
    let edge = quotient
        .edges
        .iter()
        .find(|edge| edge.to == 3)
        .expect("grouped input boundary must connect to the logic");
    assert_eq!(
        edge.source_boundary_members,
        vec![
            EdgeBoundaryMember {
                member: 0,
                net_bits: vec![10],
            },
            EdgeBoundaryMember {
                member: 1,
                net_bits: vec![11],
            },
        ],
        "each grouped input slot must retain its pre-buffer electrical net"
    );
    assert_eq!(
        edge.bits,
        vec![10, 101],
        "quotient drawing bits retain their existing downstream identities"
    );
}

#[test]
fn quotient_boundary_metadata_uses_final_bits_after_hidden_output_buffers() {
    let mut output_0 = port_node(2, "q[0]", PortDirection::Output);
    output_0.raw_name = "q".to_owned();
    output_0.port = Some("q".to_owned());
    output_0.port_bit = Some(0);
    let mut output_1 = port_node(3, "q[1]", PortDirection::Output);
    output_1.raw_name = "q".to_owned();
    output_1.port = Some("q".to_owned());
    output_1.port_bit = Some(1);
    let graph = graph_from_parts(
        "buffered_output_boundary",
        vec![
            combinational_node(0, "$or", None),
            combinational_node(1, "OBUF", None),
            output_0,
            output_1,
        ],
        Vec::new(),
        vec![Vec::new(); 4],
        vec![Vec::new(); 4],
    );
    let partition = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Port,
            members: vec![2, 3],
            label: "q[1:0]".to_owned(),
            cell_type: String::new(),
        }],
        group_of: HashMap::from([(2, 0), (3, 0)]),
    };
    let projected_node = |id| GraphNode {
        node: node_ref(&graph, id),
        is_root: None,
        is_boundary: None,
        depth: None,
        params: BTreeMap::new(),
        controls: Vec::new(),
        width: None,
        member_count: None,
        members: None,
        boundary_members: Vec::new(),
    };
    let projected_edge =
        |from, to, from_port: &str, to_port: &str, net_name: &str, bit| GraphEdge {
            from,
            to,
            from_port: from_port.to_owned(),
            to_port: to_port.to_owned(),
            net_name: net_name.to_owned(),
            bits: vec![bit],
            control: None,
            source_boundary_members: Vec::new(),
            target_boundary_members: Vec::new(),
        };
    let projected = collapse_infrastructure(
        &graph,
        Subgraph {
            nodes: (0..4).map(projected_node).collect(),
            edges: vec![
                projected_edge(0, 2, "Y", "q", "q[0]", 20),
                projected_edge(0, 1, "Y", "I", "pre_OBUF[1]", 120),
                projected_edge(1, 3, "O", "q", "q[1]", 21),
            ],
            truncated: false,
        },
    );

    let buffered_index = projected
        .edges
        .iter()
        .position(|edge| edge.from == 0 && edge.to == 3)
        .expect("hidden OBUF must project the logic directly to output member 1");
    let buffered = &projected.edges[buffered_index];
    assert_eq!(buffered.bits, vec![21]);
    assert_eq!(
        projected.boundary_electrical[buffered_index]
            .as_deref()
            .and_then(|provenance| provenance.target_bits.as_deref()),
        Some([21].as_slice())
    );

    let quotient = quotient_subgraph(&graph, projected, GroupingProjection::all(&partition));
    let edge = quotient
        .edges
        .iter()
        .find(|edge| edge.from == 0)
        .expect("logic must connect to the grouped output boundary");
    assert_eq!(
        edge.target_boundary_members,
        vec![
            EdgeBoundaryMember {
                member: 2,
                net_bits: vec![20],
            },
            EdgeBoundaryMember {
                member: 3,
                net_bits: vec![21],
            },
        ]
    );
    assert!(edge.source_boundary_members.is_empty());
}

#[test]
fn grouped_source_fragment_cap_marks_the_projection_truncated() {
    let graph = graph_from_parts(
        "grouped_src_cap",
        (0..9)
            .map(|id| {
                let mut node = combinational_node(id, "$and", None);
                node.src = Some(format!("top.sv:{}", id + 1));
                node
            })
            .collect(),
        Vec::new(),
        vec![Vec::new(); 9],
        vec![Vec::new(); 9],
    );
    let partition = GroupPartition {
        groups: vec![Group {
            kind: GroupKind::Comb,
            members: (0..9).collect(),
            label: "logic[8:0]".to_owned(),
            cell_type: "$and".to_owned(),
        }],
        group_of: (0..9).map(|id| (id, 0)).collect(),
    };
    let subgraph = Subgraph {
        nodes: (0..9)
            .map(|id| GraphNode {
                node: node_ref(&graph, id),
                is_root: None,
                is_boundary: None,
                depth: None,
                params: BTreeMap::new(),
                controls: Vec::new(),
                width: None,
                member_count: None,
                members: None,
                boundary_members: Vec::new(),
            })
            .collect(),
        edges: Vec::new(),
        truncated: false,
    };

    let grouped = quotient_subgraph(&graph, subgraph, GroupingProjection::all(&partition));

    assert!(grouped.truncated);
    assert_eq!(
        grouped.nodes[0]
            .node
            .src
            .as_deref()
            .unwrap()
            .split('|')
            .count(),
        8
    );
}

#[test]
fn source_range_roots_use_a_sentinel_and_propagate_truncation() {
    let graph = sourced_node_graph(SOURCE_ROOT_COLLECTION_CAP + 500);
    let analysis = Analysis::new(&graph, vec!["source.sv".to_owned()]);
    let roots = analysis
        .source_provenance
        .resolve_selection(
            SourceSelectionRange {
                file: "source.sv",
                start_line: 1,
                end_line: 1,
                start_column: None,
                end_column: None,
            },
            None,
        )
        .map(|probe| probe.roots)
        .unwrap();

    assert_eq!(roots.len(), SOURCE_ROOT_COLLECTION_CAP);
    assert_eq!(roots.first(), Some(&0));
    assert_eq!(roots.last(), Some(&(MAX_SUBGRAPH_NODES as NodeId)));

    let envelope = analysis
        .source_selection(
            &graph,
            &GroupPartition::default(),
            SourceSelectionRange {
                file: "source.sv",
                start_line: 1,
                end_line: 1,
                start_column: None,
                end_column: None,
            },
            selection_options(),
        )
        .unwrap();
    // Root units consume at most half the display budget so even a source
    // line with thousands of mapped nodes leaves room for graph context.
    assert_eq!(envelope.graph.nodes.len(), 200);
    assert!(envelope.graph.truncated);
}

#[test]
fn sparse_recovered_span_uses_one_interval_for_queries_and_source_probe() {
    let graph = graph_from_parts(
        "sparse",
        vec![combinational_node(0, "$and", None)],
        Vec::new(),
        vec![Vec::new()],
        vec![Vec::new()],
    );
    let range = SourceRangeMapping {
        file: "sparse.sv".to_owned(),
        start_line: 2,
        start_column: None,
        end_line: 1_000_003,
        end_column: None,
        node_ids: vec![0],
        signal_bits: Vec::new(),
        approximate_signal_bits: Vec::new(),
        mapping_incomplete: false,
    };
    let mut analysis = Analysis::new(&graph, vec!["sparse.sv".to_owned()]);
    analysis.extend_source_ranges(vec![range.clone()], false);
    analysis.set_source_probe_hints(vec![SourceProbeHint {
        file: "sparse.sv".to_owned(),
        start_line: 2,
        start_column: None,
        end_line: 1_000_003,
        end_column: None,
        direction: SourceProbeDirection::Fanin,
        kind: SourceProbeHintKind::Signal,
    }]);

    let probe = analysis
        .source_provenance
        .resolve_selection(
            SourceSelectionRange {
                file: "sparse.sv",
                start_line: 500_000,
                end_line: 500_000,
                start_column: None,
                end_column: None,
            },
            None,
        )
        .unwrap();
    assert_eq!(probe.roots, [0]);
    assert_eq!(probe.direction, Some(SourceProbeDirection::Fanin));
    assert!(analysis.source_map().by_line.is_empty());
    assert_eq!(
        analysis.node_ref(&graph, 0).src.as_deref(),
        Some("sparse.sv:2-1000003")
    );
    let public = analysis.source_map();
    assert_eq!(public.ranges, vec![range.clone()]);
    assert!(!public.truncated);

    let inside = analysis.source_provenance.resolve_selection(
        SourceSelectionRange {
            file: "sparse.sv",
            start_line: 500_000,
            end_line: 500_000,
            start_column: None,
            end_column: None,
        },
        None,
    );
    let outside = analysis.source_provenance.resolve_selection(
        SourceSelectionRange {
            file: "sparse.sv",
            start_line: 1_000_004,
            end_line: 1_000_004,
            start_column: None,
            end_column: None,
        },
        None,
    );
    assert!(inside.unwrap().source_seen);
    assert!(!outside.unwrap().source_seen);
}

#[test]
fn canonical_source_index_uses_only_reachable_preflatten_modules() {
    let netlist = parse_str(include_str!("../../tests/fixtures/preflatten_scopes.json")).unwrap();

    let graph = graph_from_parts(
        "scoped_children",
        Vec::new(),
        Vec::new(),
        Vec::new(),
        Vec::new(),
    );
    let index = SourceProvenanceIndex::build(
        &graph,
        &netlist,
        "scoped_children",
        vec!["children.sv".to_owned()],
        crate::source::recover::SourceProvenance::default(),
    );
    let seen = |line| {
        index
            .resolve_selection(
                SourceSelectionRange {
                    file: "children.sv",
                    start_line: line,
                    end_line: line,
                    start_column: None,
                    end_column: None,
                },
                None,
            )
            .unwrap()
            .source_seen
    };
    assert!(seen(2));
    assert!(seen(6));
    assert!(!seen(10));
}

#[test]
fn public_source_ranges_are_bounded_and_report_truncation() {
    let graph = graph_from_parts("bounded", Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut analysis = Analysis::new(&graph, vec!["bounded.sv".to_owned()]);
    let ranges = (0..SOURCE_RANGE_RESPONSE_CAP + 5)
        .map(|line| SourceRangeMapping {
            file: "bounded.sv".to_owned(),
            start_line: line + 1,
            end_line: line + 1,
            start_column: None,
            end_column: None,
            node_ids: Vec::new(),
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        })
        .collect();
    analysis.extend_source_ranges(ranges, false);

    let public = analysis.source_map();
    assert_eq!(public.ranges.len(), SOURCE_RANGE_RESPONSE_CAP);
    assert!(public.truncated);
}

#[test]
fn public_source_lines_preserve_legacy_lexical_cap_order() {
    let node_count = SOURCE_LINE_RESPONSE_CAP + 5;
    let nodes = (0..node_count)
        .map(|id| {
            let source = format!("bounded.sv:{}", id + 1);
            combinational_node(id as NodeId, "$and", Some(&source))
        })
        .collect();
    let graph = graph_from_parts(
        "bounded_lines",
        nodes,
        Vec::new(),
        vec![Vec::new(); node_count],
        vec![Vec::new(); node_count],
    );
    let analysis = Analysis::new(&graph, vec!["bounded.sv".to_owned()]);
    let public = analysis.source_map();
    assert_eq!(public.by_line.len(), SOURCE_LINE_RESPONSE_CAP);
    assert!(public.by_line.contains_key("bounded.sv:10005"));
    assert!(!public.by_line.contains_key("bounded.sv:9999"));
    assert!(public.truncated);
}

#[test]
fn exact_native_selection_uses_the_line_association_cap() {
    let node_count = SOURCE_ROOT_COLLECTION_CAP + 1;
    let nodes = (0..node_count)
        .map(|id| {
            let column = id + 1;
            let source = format!("saturated.sv:1.{column}-1.{column}");
            combinational_node(id as NodeId, "$and", Some(&source))
        })
        .collect();
    let graph = graph_from_parts(
        "saturated_native_line",
        nodes,
        Vec::new(),
        vec![Vec::new(); node_count],
        vec![Vec::new(); node_count],
    );
    let analysis = Analysis::new(&graph, vec!["saturated.sv".to_owned()]);
    let resolve = |column| {
        analysis
            .source_provenance
            .resolve_selection(
                SourceSelectionRange {
                    file: "saturated.sv",
                    start_line: 1,
                    end_line: 1,
                    start_column: Some(column),
                    end_column: Some(column),
                },
                None,
            )
            .unwrap()
            .roots
    };

    assert_eq!(resolve(1), vec![0]);
    assert!(resolve(node_count).is_empty());
}

#[test]
fn boundary_endpoint_catalog_is_bounded_and_stats_remain_complete() {
    let graph = boundary_cap_graph();
    let analysis = Analysis::new(&graph, vec!["boundary_cap.sv".to_owned()]);

    assert_eq!(analysis.endpoints.boundaries.len(), MAX_BOUNDARY_ENDPOINTS);
    assert!(analysis.endpoints.boundaries_truncated);
    assert!(analysis.endpoint_targets_truncated);
    assert_eq!(analysis.stats.max_depth, 1);
    assert!(depth_paths(&analysis, &graph, 1).truncated);
}

#[test]
fn boundary_bit_catalog_is_bounded_and_marks_partial_ports() {
    let graph = boundary_bit_cap_graph();
    let analysis = Analysis::new(&graph, vec!["boundary_bit_cap.sv".to_owned()]);
    let wide = analysis
        .endpoints
        .boundaries
        .iter()
        .find(|endpoint| endpoint.port == "WIDE")
        .unwrap();
    assert_eq!(wide.width, MAX_BOUNDARY_ENDPOINT_BITS + 1);
    assert_eq!(wide.bits.len(), MAX_BOUNDARY_ENDPOINT_BITS);
    assert!(wide.bits_truncated);
    let late = analysis
        .endpoints
        .boundaries
        .iter()
        .find(|endpoint| endpoint.port == "LATE")
        .unwrap();
    assert_eq!(late.width, 1);
    assert!(late.bits.is_empty());
    assert!(late.bits_truncated);
    assert!(analysis.endpoints.boundaries_truncated);
    assert!(analysis.endpoint_targets_truncated);
}

fn boundary_bit_cap_graph() -> Graph {
    let nodes = vec![port_node(0, "in", PortDirection::Input), boundary_node(1)];
    let mut edges = Vec::with_capacity(MAX_BOUNDARY_ENDPOINT_BITS + 2);
    let mut outgoing = vec![Vec::new(); 2];
    let mut incoming = vec![Vec::new(); 2];
    for bit in 0..=MAX_BOUNDARY_ENDPOINT_BITS as u32 {
        let index = edges.len();
        edges.push(Edge {
            from: 0,
            to: 1,
            from_port: "in".to_owned(),
            to_port: "WIDE".to_owned(),
            to_port_bit: bit,
            bit: Some(bit),
            net_name: "wide".to_owned(),
            control: false,
        });
        outgoing[0].push(index);
        incoming[1].push(index);
    }
    let index = edges.len();
    edges.push(Edge {
        from: 0,
        to: 1,
        from_port: "in".to_owned(),
        to_port: "LATE".to_owned(),
        to_port_bit: 0,
        bit: Some(MAX_BOUNDARY_ENDPOINT_BITS as u32 + 1),
        net_name: "late".to_owned(),
        control: false,
    });
    outgoing[0].push(index);
    incoming[1].push(index);
    graph_from_parts("boundary_bit_cap", nodes, edges, outgoing, incoming)
}

fn boundary_cap_graph() -> Graph {
    let comb_id = (MAX_BOUNDARY_ENDPOINTS + 1) as NodeId;
    let deep_boundary_id = comb_id + 1;
    let node_count = deep_boundary_id as usize + 1;
    let mut nodes = Vec::with_capacity(node_count);
    nodes.push(port_node(0, "in", PortDirection::Input));
    for id in 1..=MAX_BOUNDARY_ENDPOINTS as NodeId {
        nodes.push(boundary_node(id));
    }
    nodes.push(combinational_node(comb_id, "$buf", None));
    nodes.push(boundary_node(deep_boundary_id));

    let mut edges = Vec::with_capacity(MAX_BOUNDARY_ENDPOINTS + 2);
    let mut outgoing = vec![Vec::new(); node_count];
    let mut incoming = vec![Vec::new(); node_count];
    let mut add_edge = |from: NodeId, to: NodeId, bit: u32| {
        let index = edges.len();
        edges.push(Edge {
            from,
            to,
            from_port: "Y".to_owned(),
            to_port: "D".to_owned(),
            to_port_bit: 0,
            bit: Some(bit),
            net_name: format!("n{bit}"),
            control: false,
        });
        outgoing[from as usize].push(index);
        incoming[to as usize].push(index);
    };
    for id in 1..=MAX_BOUNDARY_ENDPOINTS as NodeId {
        add_edge(0, id, id);
    }
    add_edge(0, comb_id, comb_id);
    add_edge(comb_id, deep_boundary_id, deep_boundary_id);
    graph_from_parts("boundary_cap", nodes, edges, outgoing, incoming)
}

fn boundary_node(id: NodeId) -> Node {
    Node {
        id,
        kind: NodeKind::Cell,
        name: format!("boundary_{id}"),
        raw_name: format!("boundary_{id}"),
        cell_type: Some("CUSTOM_BOUNDARY".to_owned()),
        seq: true,
        blackbox: true,
        src: None,
        params: BTreeMap::new(),
        port: None,
        port_bit: None,
        port_dir: None,
        const_value: None,
    }
}

fn deep_chain_graph(depth: usize) -> Graph {
    let node_count = depth + 2;
    let mut nodes = Vec::with_capacity(node_count);
    nodes.push(Node {
        id: 0,
        kind: NodeKind::PortBit,
        name: "in".to_owned(),
        raw_name: "in".to_owned(),
        cell_type: None,
        seq: false,
        blackbox: false,
        src: None,
        params: BTreeMap::new(),
        port: Some("in".to_owned()),
        port_bit: Some(0),
        port_dir: Some(PortDirection::Input),
        const_value: None,
    });
    for idx in 0..depth {
        let id = (idx + 1) as NodeId;
        nodes.push(Node {
            id,
            kind: NodeKind::Cell,
            name: format!("buf_{idx}"),
            raw_name: format!("buf_{idx}"),
            cell_type: Some("$buf".to_owned()),
            seq: false,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: None,
            port_bit: None,
            port_dir: None,
            const_value: None,
        });
    }
    let output_id = (depth + 1) as NodeId;
    nodes.push(Node {
        id: output_id,
        kind: NodeKind::PortBit,
        name: "out".to_owned(),
        raw_name: "out".to_owned(),
        cell_type: None,
        seq: false,
        blackbox: false,
        src: None,
        params: BTreeMap::new(),
        port: Some("out".to_owned()),
        port_bit: Some(0),
        port_dir: Some(PortDirection::Output),
        const_value: None,
    });

    let mut edges = Vec::with_capacity(depth + 1);
    let mut outgoing = vec![Vec::new(); node_count];
    let mut incoming = vec![Vec::new(); node_count];
    for idx in 0..=depth {
        let from = idx as NodeId;
        let to = (idx + 1) as NodeId;
        let edge_idx = edges.len();
        edges.push(Edge {
            from,
            to,
            from_port: if idx == 0 { "in" } else { "Y" }.to_owned(),
            to_port: if idx == depth { "out" } else { "A" }.to_owned(),
            to_port_bit: 0,
            bit: Some(idx as u32),
            net_name: format!("n{idx}"),
            control: false,
        });
        outgoing[from as usize].push(edge_idx);
        incoming[to as usize].push(edge_idx);
    }

    Graph {
        nodes,
        edges,
        outgoing,
        incoming,
        top: "deep_chain".to_owned(),
        net_names: HashMap::new(),
        net_aliases: HashMap::new(),
        cell_info: HashMap::new(),
        blackboxes: Vec::new(),
        signal_fanout: HashMap::new(),
        clock_network: Vec::new(),
    }
}

fn divergent_depth_delay_graph() -> Graph {
    let mut nodes = vec![
        port_node(0, "deep_in", PortDirection::Input),
        port_node(1, "slow_in", PortDirection::Input),
        combinational_node(2, "$and", None),
        combinational_node(3, "$and", None),
        combinational_node(4, "LUT6", None),
        combinational_node(5, "$and", None),
        port_node(6, "slow_output", PortDirection::Output),
        combinational_node(7, "$and", None),
        combinational_node(8, "$and", None),
        combinational_node(9, "$and", None),
        combinational_node(10, "$and", None),
        port_node(11, "deep_output", PortDirection::Output),
    ];
    for node in &mut nodes {
        if node.kind == NodeKind::PortBit {
            node.port_bit = Some(0);
        }
    }
    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::new(); nodes.len()];
    let mut incoming = vec![Vec::new(); nodes.len()];
    for (bit, (from, to)) in [
        (0, 2),
        (2, 3),
        (3, 5),
        (1, 4),
        (4, 5),
        (5, 6),
        (0, 7),
        (7, 8),
        (8, 9),
        (9, 10),
        (10, 11),
    ]
    .into_iter()
    .enumerate()
    {
        let edge_idx = edges.len();
        edges.push(Edge {
            from,
            to,
            from_port: "Y".to_owned(),
            to_port: if nodes[to as usize].kind == NodeKind::PortBit {
                nodes[to as usize].name.clone()
            } else {
                "A".to_owned()
            },
            to_port_bit: 0,
            bit: Some(bit as u32),
            net_name: format!("n{bit}"),
            control: false,
        });
        outgoing[from as usize].push(edge_idx);
        incoming[to as usize].push(edge_idx);
    }
    graph_from_parts("divergent", nodes, edges, outgoing, incoming)
}

fn same_shape_divergent_delay_graph() -> Graph {
    let mut nodes = vec![
        port_node(0, "depth_in", PortDirection::Input),
        port_node(1, "delay_in", PortDirection::Input),
        combinational_node(2, "$and", None),
        combinational_node(3, "$and", None),
        combinational_node(4, "$and", None),
        combinational_node(5, "$and", None),
        combinational_node(6, "$and", None),
        port_node(7, "out", PortDirection::Output),
    ];
    for index in 0..8 {
        nodes.push(port_node(
            (8 + index) as NodeId,
            &format!("fanout_{index}"),
            PortDirection::Output,
        ));
    }
    for node in &mut nodes {
        if node.kind == NodeKind::PortBit {
            node.port_bit = Some(0);
        }
    }
    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::new(); nodes.len()];
    let mut incoming = vec![Vec::new(); nodes.len()];
    for (from, to) in [(0, 2), (2, 3), (3, 6), (1, 4), (4, 5), (5, 6), (6, 7)] {
        let bit = edges.len() as u32;
        add_test_edge(&mut edges, &mut outgoing, &mut incoming, from, to, bit);
    }
    for to in 8..16 {
        let bit = edges.len() as u32;
        add_test_edge(&mut edges, &mut outgoing, &mut incoming, 4, to, bit);
    }
    graph_from_parts("same_shape_divergent", nodes, edges, outgoing, incoming)
}

fn port_node(id: NodeId, name: &str, direction: PortDirection) -> Node {
    Node {
        id,
        kind: NodeKind::PortBit,
        name: name.to_owned(),
        raw_name: name.to_owned(),
        cell_type: None,
        seq: false,
        blackbox: false,
        src: None,
        params: BTreeMap::new(),
        port: Some(name.to_owned()),
        port_bit: None,
        port_dir: Some(direction),
        const_value: None,
    }
}

fn register_bank_graph(groups: usize, width: usize) -> Graph {
    let mut nodes = Vec::with_capacity(groups + 1);
    nodes.push(Node {
        id: 0,
        kind: NodeKind::PortBit,
        name: "in".to_owned(),
        raw_name: "in".to_owned(),
        cell_type: None,
        seq: false,
        blackbox: false,
        src: None,
        params: BTreeMap::new(),
        port: Some("in".to_owned()),
        port_bit: Some(0),
        port_dir: Some(PortDirection::Input),
        const_value: None,
    });

    let mut edges = Vec::with_capacity(groups * width);
    let mut outgoing = vec![Vec::new(); groups + 1];
    let mut incoming = vec![Vec::new(); groups + 1];
    let mut net_aliases = HashMap::new();
    let mut cell_info = HashMap::new();
    let d_bits: Vec<YosysBit> = (0..width)
        .map(|bit| YosysBit::Net((bit + 1) as u32))
        .collect();

    for group in 0..groups {
        let id = (group + 1) as NodeId;
        nodes.push(Node {
            id,
            kind: NodeKind::Cell,
            name: format!("q{group}"),
            raw_name: format!("q{group}"),
            cell_type: Some("$dff".to_owned()),
            seq: true,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: None,
            port_bit: None,
            port_dir: None,
            const_value: None,
        });

        let q_bits: Vec<YosysBit> = (0..width)
            .map(|bit| {
                let net = 1_000_000 + group * width + bit;
                net_aliases.insert(net as u32, vec![format!("q{group}[{bit}]")]);
                YosysBit::Net(net as u32)
            })
            .collect();
        for bit in 0..width {
            let edge_idx = edges.len();
            edges.push(Edge {
                from: 0,
                to: id,
                from_port: "in".to_owned(),
                to_port: "D".to_owned(),
                to_port_bit: bit as u32,
                bit: Some((bit + 1) as u32),
                net_name: format!("d[{bit}]"),
                control: false,
            });
            outgoing[0].push(edge_idx);
            incoming[id as usize].push(edge_idx);
        }
        cell_info.insert(
            id,
            CellInfo {
                q_bits,
                d_bits: d_bits.clone(),
                clock_net: None,
                output_ports: HashSet::from(["Q".to_owned()]),
                input_ports: HashSet::from(["D".to_owned()]),
            },
        );
    }

    Graph {
        nodes,
        edges,
        outgoing,
        incoming,
        top: "register_bank".to_owned(),
        net_names: HashMap::new(),
        net_aliases,
        cell_info,
        blackboxes: Vec::new(),
        signal_fanout: HashMap::new(),
        clock_network: Vec::new(),
    }
}

fn dense_dag_graph(node_count: usize) -> Graph {
    let nodes = (0..node_count)
        .map(|id| combinational_node(id as NodeId, "$and", None))
        .collect();
    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::new(); node_count];
    let mut incoming = vec![Vec::new(); node_count];
    let mut from = 0;
    while from < node_count {
        let mut to = from + 1;
        while to < node_count {
            let edge_idx = edges.len();
            edges.push(Edge {
                from: from as NodeId,
                to: to as NodeId,
                from_port: "Y".to_owned(),
                to_port: "A".to_owned(),
                to_port_bit: 0,
                bit: Some(edge_idx as u32),
                net_name: format!("n{from}_{to}"),
                control: false,
            });
            outgoing[from].push(edge_idx);
            incoming[to].push(edge_idx);
            to += 1;
        }
        from += 1;
    }
    graph_from_parts("dense", nodes, edges, outgoing, incoming)
}

fn branching_infrastructure_subgraph(hidden_count: usize, sink_count: usize) -> (Graph, Subgraph) {
    let node_count = 1 + hidden_count + sink_count;
    let mut nodes = Vec::with_capacity(node_count);
    nodes.push(combinational_node(0, "$and", None));
    for id in 1..=hidden_count {
        nodes.push(combinational_node(id as NodeId, "OBUF", None));
    }
    for id in (hidden_count + 1)..node_count {
        nodes.push(combinational_node(id as NodeId, "$and", None));
    }
    let graph = graph_from_parts(
        "projection",
        nodes,
        Vec::new(),
        vec![Vec::new(); node_count],
        vec![Vec::new(); node_count],
    );
    let projected_nodes = graph
        .nodes
        .iter()
        .map(|node| GraphNode {
            node: node_ref(&graph, node.id),
            is_root: None,
            is_boundary: None,
            depth: None,
            params: BTreeMap::new(),
            controls: Vec::new(),
            width: None,
            member_count: None,
            members: None,
            boundary_members: Vec::new(),
        })
        .collect();
    let mut edges = Vec::new();
    for hidden in 1..=hidden_count {
        edges.push(GraphEdge {
            from: 0,
            to: hidden as NodeId,
            from_port: "Y".to_owned(),
            to_port: "I".to_owned(),
            net_name: format!("to_hidden_{hidden}"),
            bits: vec![hidden as u32],
            control: None,
            source_boundary_members: Vec::new(),
            target_boundary_members: Vec::new(),
        });
        for sink in 0..sink_count {
            let sink_id = (hidden_count + 1 + sink) as NodeId;
            edges.push(GraphEdge {
                from: hidden as NodeId,
                to: sink_id,
                from_port: "O".to_owned(),
                to_port: "A".to_owned(),
                net_name: format!("h{hidden}_s{sink}"),
                bits: vec![(hidden * sink_count + sink) as u32],
                control: None,
                source_boundary_members: Vec::new(),
                target_boundary_members: Vec::new(),
            });
        }
    }
    (
        graph,
        Subgraph {
            nodes: projected_nodes,
            edges,
            truncated: false,
        },
    )
}

fn wide_branching_infrastructure_subgraph(width: usize, branches: usize) -> (Graph, Subgraph) {
    let sink_id = (branches + 2) as NodeId;
    let mut nodes = Vec::with_capacity(branches + 3);
    nodes.push(combinational_node(0, "$and", None));
    nodes.push(combinational_node(1, "OBUF", None));
    for id in 0..branches {
        nodes.push(combinational_node((id + 2) as NodeId, "OBUF", None));
    }
    nodes.push(combinational_node(sink_id, "$and", None));
    let graph = graph_from_parts(
        "wide_projection",
        nodes,
        Vec::new(),
        vec![Vec::new(); branches + 3],
        vec![Vec::new(); branches + 3],
    );
    let projected_nodes = graph
        .nodes
        .iter()
        .map(|node| GraphNode {
            node: node_ref(&graph, node.id),
            is_root: None,
            is_boundary: None,
            depth: None,
            params: BTreeMap::new(),
            controls: Vec::new(),
            width: None,
            member_count: None,
            members: None,
            boundary_members: Vec::new(),
        })
        .collect();
    let mut edges = Vec::with_capacity(1 + 2 * branches);
    edges.push(GraphEdge {
        from: 0,
        to: 1,
        from_port: "Y".to_owned(),
        to_port: "I".to_owned(),
        net_name: "wide".to_owned(),
        bits: (0..width as u32).collect(),
        control: None,
        source_boundary_members: Vec::new(),
        target_boundary_members: Vec::new(),
    });
    for branch in 0..branches {
        let branch_id = (branch + 2) as NodeId;
        edges.push(GraphEdge {
            from: 1,
            to: branch_id,
            from_port: "O".to_owned(),
            to_port: "I".to_owned(),
            net_name: format!("branch_{branch}"),
            bits: Vec::new(),
            control: None,
            source_boundary_members: Vec::new(),
            target_boundary_members: Vec::new(),
        });
        edges.push(GraphEdge {
            from: branch_id,
            to: sink_id,
            from_port: "O".to_owned(),
            to_port: "A".to_owned(),
            net_name: format!("sink_{branch}"),
            bits: vec![branch as u32],
            control: None,
            source_boundary_members: Vec::new(),
            target_boundary_members: Vec::new(),
        });
    }
    (
        graph,
        Subgraph {
            nodes: projected_nodes,
            edges,
            truncated: false,
        },
    )
}

fn deep_register_bank_graph(groups: usize, depth: usize) -> Graph {
    let node_count = 1 + depth + groups;
    let mut nodes = Vec::with_capacity(node_count);
    nodes.push(Node {
        id: 0,
        kind: NodeKind::PortBit,
        name: "in".to_owned(),
        raw_name: "in".to_owned(),
        cell_type: None,
        seq: false,
        blackbox: false,
        src: None,
        params: BTreeMap::new(),
        port: Some("in".to_owned()),
        port_bit: Some(0),
        port_dir: Some(PortDirection::Input),
        const_value: None,
    });
    for id in 1..=depth {
        nodes.push(combinational_node(id as NodeId, "$and", None));
    }
    for group in 0..groups {
        let id = (depth + 1 + group) as NodeId;
        nodes.push(Node {
            id,
            kind: NodeKind::Cell,
            name: format!("q{group}"),
            raw_name: format!("q{group}"),
            cell_type: Some("$dff".to_owned()),
            seq: true,
            blackbox: false,
            src: None,
            params: BTreeMap::new(),
            port: None,
            port_bit: None,
            port_dir: None,
            const_value: None,
        });
    }

    let mut edges = Vec::new();
    let mut outgoing = vec![Vec::new(); node_count];
    let mut incoming = vec![Vec::new(); node_count];
    for step in 0..depth {
        add_test_edge(
            &mut edges,
            &mut outgoing,
            &mut incoming,
            step as NodeId,
            (step + 1) as NodeId,
            step as u32,
        );
    }
    let mut net_aliases = HashMap::new();
    let mut cell_info = HashMap::new();
    for group in 0..groups {
        let id = (depth + 1 + group) as NodeId;
        let data_net = depth.saturating_sub(1) as u32;
        add_test_edge(
            &mut edges,
            &mut outgoing,
            &mut incoming,
            depth as NodeId,
            id,
            data_net,
        );
        let q_net = 1_000_000 + group as u32;
        net_aliases.insert(q_net, vec![format!("q{group}[0]")]);
        cell_info.insert(
            id,
            CellInfo {
                q_bits: vec![YosysBit::Net(q_net)],
                d_bits: vec![YosysBit::Net(data_net)],
                clock_net: None,
                output_ports: HashSet::from(["Q".to_owned()]),
                input_ports: HashSet::from(["D".to_owned()]),
            },
        );
    }
    let mut graph = graph_from_parts("deep_bank", nodes, edges, outgoing, incoming);
    graph.net_aliases = net_aliases;
    graph.cell_info = cell_info;
    graph
}

fn sourced_node_graph(node_count: usize) -> Graph {
    let nodes = (0..node_count)
        .map(|id| combinational_node(id as NodeId, "$and", Some("source.sv:1")))
        .collect();
    graph_from_parts(
        "sourced",
        nodes,
        Vec::new(),
        vec![Vec::new(); node_count],
        vec![Vec::new(); node_count],
    )
}

fn selection_options() -> SourceSelectionOptions {
    SourceSelectionOptions {
        max_nodes: 400,
        hide_control: true,
        hide_const: true,
        group_vectors: false,
        group_memories: false,
    }
}

fn source_selection_fixture() -> Graph {
    let nodes = vec![
        port_node(0, "a", PortDirection::Input),
        combinational_node(1, "$and", None),
        port_node(2, "y", PortDirection::Output),
    ];
    let edges = vec![
        Edge {
            from: 0,
            to: 1,
            from_port: "a".to_owned(),
            to_port: "A".to_owned(),
            to_port_bit: 0,
            bit: Some(0),
            net_name: "a".to_owned(),
            control: false,
        },
        Edge {
            from: 1,
            to: 2,
            from_port: "Y".to_owned(),
            to_port: "y".to_owned(),
            to_port_bit: 0,
            bit: Some(1),
            net_name: "y".to_owned(),
            control: false,
        },
    ];
    graph_from_parts(
        "source_selection",
        nodes,
        edges,
        vec![vec![0], vec![1], Vec::new()],
        vec![Vec::new(), vec![0], vec![1]],
    )
}

fn combinational_node(id: NodeId, cell_type: &str, src: Option<&str>) -> Node {
    Node {
        id,
        kind: NodeKind::Cell,
        name: format!("n{id}"),
        raw_name: format!("n{id}"),
        cell_type: Some(cell_type.to_owned()),
        seq: false,
        blackbox: false,
        src: src.map(str::to_owned),
        params: BTreeMap::new(),
        port: None,
        port_bit: None,
        port_dir: None,
        const_value: None,
    }
}

fn constant_node(id: NodeId, value: &str) -> Node {
    Node {
        id,
        kind: NodeKind::Const,
        name: value.to_owned(),
        raw_name: value.to_owned(),
        cell_type: None,
        seq: false,
        blackbox: false,
        src: None,
        params: BTreeMap::new(),
        port: None,
        port_bit: None,
        port_dir: None,
        const_value: Some(value.to_owned()),
    }
}

fn add_test_edge(
    edges: &mut Vec<Edge>,
    outgoing: &mut [Vec<usize>],
    incoming: &mut [Vec<usize>],
    from: NodeId,
    to: NodeId,
    bit: u32,
) {
    let edge_idx = edges.len();
    edges.push(Edge {
        from,
        to,
        from_port: "Y".to_owned(),
        to_port: if to as usize + 1 == outgoing.len() {
            "D".to_owned()
        } else {
            "A".to_owned()
        },
        to_port_bit: 0,
        bit: Some(bit),
        net_name: format!("n{bit}"),
        control: false,
    });
    outgoing[from as usize].push(edge_idx);
    incoming[to as usize].push(edge_idx);
}

fn graph_from_parts(
    top: &str,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    outgoing: Vec<Vec<usize>>,
    incoming: Vec<Vec<usize>>,
) -> Graph {
    Graph {
        nodes,
        edges,
        outgoing,
        incoming,
        top: top.to_owned(),
        net_names: HashMap::new(),
        net_aliases: HashMap::new(),
        cell_info: HashMap::new(),
        blackboxes: Vec::new(),
        signal_fanout: HashMap::new(),
        clock_network: Vec::new(),
    }
}

fn edge_signature(subgraph: &Subgraph) -> Vec<EdgeSignature> {
    subgraph
        .edges
        .iter()
        .map(|edge| {
            (
                edge.from,
                edge.to,
                edge.from_port.clone(),
                edge.to_port.clone(),
                edge.net_name.clone(),
                edge.bits.clone(),
                edge.control,
            )
        })
        .collect()
}

#[test]
fn multi_root_union_dedups_sibling_cones_with_one_shared_cap() {
    // Ported from the retired public `envelope` entry point: the [Fanin,
    // Fanout] union path stays live via `multi_root_source_envelope`, and
    // this exercises it under the `for_public_projection` limits used by
    // `multi_root_cone`.
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
    let envelope = analysis
        .multi_root_subgraph(
            &graph,
            &roots,
            &[ConeDir::Fanin, ConeDir::Fanout],
            options,
            None,
            SubgraphWorkLimits::for_public_projection(),
        )
        .unwrap();
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

    let node_ids: std::collections::HashSet<_> =
        envelope.nodes.iter().map(|node| node.node.id).collect();
    assert_eq!(node_ids.len(), envelope.nodes.len());
    let edge_ids: std::collections::HashSet<_> = envelope
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
        .multi_root_subgraph(
            &graph,
            &roots,
            &[ConeDir::Fanin, ConeDir::Fanout],
            capped_options,
            None,
            SubgraphWorkLimits::for_public_projection(),
        )
        .unwrap();
    assert!(capped.nodes.len() <= capped_options.max_nodes);
    assert!(capped.truncated);
    assert!(capped.edges.iter().any(|edge| roots.contains(&edge.to)));
    assert!(capped.edges.iter().any(|edge| roots.contains(&edge.from)));
}
