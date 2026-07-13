use axum::body::Body;
use axum::http::StatusCode;
use http_body_util::BodyExt;
use serde_json::json;
use std::collections::BTreeSet;
use synth_explorer_server::api::{AppState, app};
use tower::ServiceExt;

async fn body_json(response: axum::response::Response) -> serde_json::Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn source_map_roots(
    source_map: &serde_json::Value,
    file: &str,
    start_line: usize,
    end_line: usize,
) -> BTreeSet<u64> {
    let mut roots = BTreeSet::new();
    for line in start_line..=end_line {
        if let Some(ids) = source_map["by_line"][format!("{file}:{line}")].as_array() {
            roots.extend(ids.iter().filter_map(serde_json::Value::as_u64));
        }
    }
    for range in source_map["ranges"].as_array().into_iter().flatten() {
        let overlaps = range["file"] == file
            && range["start_line"].as_u64().unwrap() <= end_line as u64
            && range["end_line"].as_u64().unwrap() >= start_line as u64;
        if overlaps {
            roots.extend(
                range["node_ids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(serde_json::Value::as_u64),
            );
        }
    }
    roots
}

#[tokio::test]
async fn synthesize_then_walk_analysis_routes() {
    let source = r#"
module reg_mux (
    input  logic       clk,
    input  logic       rst,
    input  logic       sel,
    input  logic [7:0] a,
    input  logic [7:0] b,
    output logic [7:0] q
);
  always_ff @(posedge clk) begin
    if (rst)
      q <= 8'd0;
    else
      q <= sel ? b : a;
  end
endmodule
"#;
    let mut app = app(AppState::default());
    let synth_body = json!({
        "files": [{"name": "01_reg_mux.sv", "content": source}],
        "top": "reg_mux",
        "mode": "rtl"
    });
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&synth_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();
    assert_eq!(design_id.len(), 12);
    assert_eq!(synth["top"], "reg_mux");
    assert!(
        synth["log"].as_str().unwrap_or_default().contains("Yosys")
            || synth["log"]
                .as_str()
                .unwrap_or_default()
                .contains("Executing"),
        "expected POST /api/synthesize to return a real yosys log"
    );
    assert!(
        synth["stats"]["cells_by_type"]["$dff"]
            .as_u64()
            .is_some_and(|count| count >= 1)
    );
    assert!(
        synth["stats"]["cells_by_type"]["$mux"]
            .as_u64()
            .is_some_and(|count| count >= 1)
    );

    let endpoints = get_json(&mut app, &format!("/api/design/{design_id}/endpoints")).await;
    let reg_node = endpoints["registers"][0]["bits"][0]["node_id"]
        .as_u64()
        .unwrap();
    assert_eq!(endpoints["registers"][0]["width"], 8);

    let nodes = get_json(
        &mut app,
        &format!("/api/design/{design_id}/nodes?ids={reg_node},999999,{reg_node}"),
    )
    .await;
    let nodes = nodes["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 2);
    assert_eq!(nodes[0]["id"].as_u64(), Some(reg_node));
    assert_eq!(nodes[1]["id"].as_u64(), Some(reg_node));

    let too_many_ids = (0..201)
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let response = get_response(
        &mut app,
        &format!("/api/design/{design_id}/nodes?ids={too_many_ids}"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let paths = get_json(
        &mut app,
        &format!("/api/design/{design_id}/paths?limit=5&to={reg_node}"),
    )
    .await;
    assert!(
        paths["paths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path["depth"].as_u64().unwrap() >= 1)
    );

    let cone = get_json(
        &mut app,
        &format!("/api/design/{design_id}/cone?node={reg_node}&dir=fanin"),
    )
    .await;
    assert!(cone["nodes"].as_array().unwrap().len() >= 2);
    assert!(
        cone["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| edge["to"].as_u64() == Some(reg_node))
    );

    let fanout = get_json(
        &mut app,
        &format!("/api/design/{design_id}/fanout?limit=10"),
    )
    .await;
    assert!(!fanout["drivers"].as_array().unwrap().is_empty());

    let source_map = get_json(&mut app, &format!("/api/design/{design_id}/source-map")).await;
    assert!(
        source_map["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file.as_str() == Some("01_reg_mux.sv"))
    );
    assert!(source_map["ranges"].is_array());
    assert!(source_map["truncated"].is_boolean());
}

#[tokio::test]
async fn line_cone_returns_assign_envelope_and_validates_source_location() {
    let source = std::fs::read_to_string("../examples/03_adder_chain.sv").unwrap();
    let mut app = app(AppState::default());
    let synth_body = json!({
        "files": [{"name": "03_adder_chain.sv", "content": source}],
        "top": "adder_chain",
        "mode": "rtl"
    });
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&synth_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();

    let source_map = get_json(&mut app, &format!("/api/design/{design_id}/source-map")).await;
    let mapped_roots = source_map_roots(&source_map, "03_adder_chain.sv", 17, 17);
    assert!(!mapped_roots.is_empty());

    let envelope = get_json(
        &mut app,
        &format!(
            "/api/design/{design_id}/line-cone?file=03_adder_chain.sv&start_line=17&end_line=17&max_nodes=400&hide_control=true&hide_const=true"
        ),
    )
    .await;
    assert_eq!(envelope["status"], "mapped");
    let graph = &envelope["graph"];
    let nodes = graph["nodes"].as_array().unwrap();
    let returned_roots: BTreeSet<_> = nodes
        .iter()
        .filter(|node| node["is_root"].as_bool() == Some(true))
        .map(|node| node["id"].as_u64().unwrap())
        .collect();
    assert_eq!(returned_roots, mapped_roots);
    assert!(
        nodes
            .iter()
            .any(|node| { node["kind"] == "port" && node["is_boundary"].as_bool() == Some(true) })
    );
    assert!(nodes.iter().any(|node| {
        node["seq"].as_bool() == Some(true) && node["is_boundary"].as_bool() == Some(true)
    }));
    assert!(
        graph["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| mapped_roots.contains(&edge["from"].as_u64().unwrap()))
    );
    assert_eq!(graph["truncated"], false);

    let range_roots = source_map_roots(&source_map, "03_adder_chain.sv", 17, 21);
    let range = get_json(
        &mut app,
        &format!(
            "/api/design/{design_id}/line-cone?file=03_adder_chain.sv&start_line=17&end_line=21"
        ),
    )
    .await;
    let returned_range_roots: BTreeSet<_> = range["graph"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| node["is_root"].as_bool() == Some(true))
        .map(|node| node["id"].as_u64().unwrap())
        .collect();
    assert_eq!(returned_range_roots, range_roots);

    let comment_line = get_json(
        &mut app,
        &format!(
            "/api/design/{design_id}/line-cone?file=03_adder_chain.sv&start_line=2&end_line=2"
        ),
    )
    .await;
    assert_eq!(comment_line["status"], "unmapped");
    assert_eq!(comment_line["graph"]["nodes"], json!([]));
    assert_eq!(comment_line["graph"]["edges"], json!([]));
    assert_eq!(comment_line["graph"]["truncated"], false);

    for uri in [
        format!("/api/design/{design_id}/line-cone?file=unknown.sv&start_line=17&end_line=17"),
        format!("/api/design/{design_id}/line-cone?file=03_adder_chain.sv&start_line=0&end_line=1"),
        format!(
            "/api/design/{design_id}/line-cone?file=03_adder_chain.sv&start_line=1&end_line=201"
        ),
    ] {
        let response = get_response(&mut app, &uri).await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    let response = get_response(
        &mut app,
        "/api/design/unknown/line-cone?file=03_adder_chain.sv&start_line=17&end_line=17",
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn line_probe_on_procedural_assignment_targets_only_the_assigned_register() {
    let source = std::fs::read_to_string("../examples/02_priority_encoder.sv").unwrap();
    // The always_ff block spans lines 59-67; line 61 assigns only `idx`.
    assert_eq!(
        source.lines().nth(58).unwrap().trim(),
        "always_ff @(posedge clk) begin"
    );
    assert_eq!(source.lines().nth(60).unwrap().trim(), "idx   <= 5'd0;");
    let mut app = app(AppState::default());
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "files": [{"name": "02_priority_encoder.sv", "content": source}],
                        "top": "priority_encoder",
                        "mode": "rtl"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();

    let endpoints = get_json(&mut app, &format!("/api/design/{design_id}/endpoints")).await;
    let register_ids = |name: &str| -> BTreeSet<u64> {
        endpoints["registers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["name"] == name)
            .unwrap_or_else(|| panic!("expected register group {name}"))["bits"]
            .as_array()
            .unwrap()
            .iter()
            .map(|bit| bit["node_id"].as_u64().unwrap())
            .collect()
    };
    let idx_ids = register_ids("idx");
    let valid_ids = register_ids("valid");

    let line_roots = |response: &serde_json::Value| -> BTreeSet<u64> {
        response["graph"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|node| node["is_root"].as_bool() == Some(true))
            .map(|node| node["id"].as_u64().unwrap())
            .collect()
    };

    let single = get_json(
        &mut app,
        &format!(
            "/api/design/{design_id}/line-cone?file=02_priority_encoder.sv&start_line=61&end_line=61"
        ),
    )
    .await;
    assert_eq!(single["status"], "mapped");
    let single_roots = line_roots(&single);
    assert!(
        single_roots.iter().any(|id| idx_ids.contains(id)),
        "probing `idx <= 5'd0;` must root the idx register: {single_roots:?}"
    );
    assert!(
        single_roots.iter().all(|id| !valid_ids.contains(id)),
        "probing `idx <= 5'd0;` must not root the valid register: {single_roots:?}"
    );

    let block = get_json(
        &mut app,
        &format!(
            "/api/design/{design_id}/line-cone?file=02_priority_encoder.sv&start_line=59&end_line=67"
        ),
    )
    .await;
    assert_eq!(block["status"], "mapped");
    let block_roots = line_roots(&block);
    assert!(block_roots.iter().any(|id| idx_ids.contains(id)));
    assert!(
        block_roots.iter().any(|id| valid_ids.contains(id)),
        "selecting the whole always block still probes every register: {block_roots:?}"
    );
}

#[tokio::test]
async fn depth_classes_and_registered_output_aliases_are_reported_once() {
    let source = r#"
module depth_classes (
    input logic clk,
    input logic a,
    input logic b,
    output logic direct,
    output logic from_reg,
    output logic comb
);
  logic r0;
  logic r1;
  always_ff @(posedge clk) begin
    r0 <= a & b;
    r1 <= ~r0;
  end
  assign direct = r1;
  assign from_reg = ~r1;
  assign comb = a ^ b;
endmodule
"#;
    let mut app = app(AppState::default());
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "files": [{"name": "depth_classes.sv", "content": source}],
                        "top": "depth_classes",
                        "mode": "rtl"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();

    assert_eq!(synth["stats"]["num_outputs"], 3);
    assert_eq!(synth["stats"]["depths"]["input_to_register"], 1);
    assert_eq!(synth["stats"]["depths"]["register_to_register"], 1);
    assert_eq!(synth["stats"]["depths"]["register_to_output"], 1);
    assert_eq!(synth["stats"]["depths"]["input_to_output"], 1);

    let endpoints = get_json(&mut app, &format!("/api/design/{design_id}/endpoints")).await;
    let r1 = endpoints["registers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["name"] == "r1")
        .expect("expected r1 endpoint group");
    assert_eq!(r1["output_aliases"][0]["name"], "direct");
    assert!(
        endpoints["outputs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|output| output["name"] != "direct")
    );

    let paths = get_json(&mut app, &format!("/api/design/{design_id}/paths?limit=25")).await;
    let direct_path_groups = paths["paths"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|path| {
            path["output_aliases"]
                .as_array()
                .is_some_and(|aliases| aliases.iter().any(|alias| alias["name"] == "direct"))
        })
        .count();
    assert_eq!(direct_path_groups, 1);
}

#[tokio::test]
async fn cone_accepts_multiple_roots_under_one_shared_budget() {
    let source = r#"
module two_regs (
    input  logic clk,
    input  logic a,
    input  logic b,
    output logic q0,
    output logic q1
);
  logic r0;
  logic r1;
  always_ff @(posedge clk) begin
    r0 <= a & b;
    r1 <= a ^ b;
  end
  assign q0 = r0 & a;
  assign q1 = r1 | b;
endmodule
"#;
    let mut app = app(AppState::default());
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "files": [{"name": "two_regs.sv", "content": source}],
                        "top": "two_regs",
                        "mode": "rtl"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();

    let endpoints = get_json(&mut app, &format!("/api/design/{design_id}/endpoints")).await;
    let register_id = |name: &str| -> u64 {
        endpoints["registers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|group| group["name"] == name)
            .unwrap_or_else(|| panic!("expected register group {name}"))["bits"][0]["node_id"]
            .as_u64()
            .unwrap()
    };
    let r0 = register_id("r0");
    let r1 = register_id("r1");
    assert_ne!(r0, r1);

    // `nodes=` overrides `node` and unions both fanin cones in one response.
    let cone = get_json(
        &mut app,
        &format!("/api/design/{design_id}/cone?node=999999&nodes={r0},{r1},{r0}&dir=fanin"),
    )
    .await;
    let nodes = cone["nodes"].as_array().unwrap();
    for root in [r0, r1] {
        assert!(
            nodes
                .iter()
                .any(|node| node["id"].as_u64() == Some(root)
                    && node["is_root"].as_bool() == Some(true)),
            "expected root {root} in multi-root cone"
        );
        assert!(
            cone["edges"]
                .as_array()
                .unwrap()
                .iter()
                .any(|edge| edge["to"].as_u64() == Some(root)),
            "expected fanin edges into root {root}"
        );
    }
    let ids: BTreeSet<u64> = nodes
        .iter()
        .map(|node| node["id"].as_u64().unwrap())
        .collect();
    assert_eq!(ids.len(), nodes.len(), "duplicate roots must be deduped");

    // Both cones share a single node cap.
    let capped = get_json(
        &mut app,
        &format!("/api/design/{design_id}/cone?nodes={r0},{r1}&dir=fanin&max_nodes=2"),
    )
    .await;
    assert!(capped["nodes"].as_array().unwrap().len() <= 2);
    assert_eq!(capped["truncated"], true);

    for (uri, expected) in [
        (
            format!("/api/design/{design_id}/cone?nodes=abc&dir=fanin"),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            format!("/api/design/{design_id}/cone?nodes=&dir=fanin"),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            format!(
                "/api/design/{design_id}/cone?nodes={}&dir=fanin",
                (0..201)
                    .map(|id| id.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            format!("/api/design/{design_id}/cone?nodes=999999&dir=fanin"),
            StatusCode::NOT_FOUND,
        ),
    ] {
        let response = get_response(&mut app, &uri).await;
        assert_eq!(response.status(), expected, "unexpected status for {uri}");
    }
}

#[tokio::test]
async fn group_vectors_collapses_buses_and_rejects_synthetic_ids() {
    let source = r#"
module bus_regs (
    input  logic       clk,
    input  logic [7:0] d,
    output logic [7:0] q
);
  always_ff @(posedge clk) q <= d;
endmodule
"#;
    let mut app = app(AppState::default());
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "files": [{"name": "bus_regs.sv", "content": source}],
                        "top": "bus_regs",
                        "mode": "gates"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let design_id = body_json(response).await["design_id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Without grouping the eight register bits render as eight per-bit nodes,
    // none carrying a width.
    let plain = get_json(
        &mut app,
        &format!("/api/design/{design_id}/netlist?max_nodes=1500"),
    )
    .await;
    assert!(
        plain["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|node| node.get("width").is_none()),
        "width must be absent without group_vectors"
    );

    // With grouping the bus collapses to one width-8 register node.
    let grouped = get_json(
        &mut app,
        &format!("/api/design/{design_id}/netlist?max_nodes=1500&group_vectors=true"),
    )
    .await;
    let group_nodes: Vec<_> = grouped["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| node.get("width").is_some())
        .collect();
    assert_eq!(group_nodes.len(), 1, "the register bus is one group node");
    let group = group_nodes[0];
    assert_eq!(group["width"].as_u64(), Some(8));
    assert_eq!(group["members"].as_array().unwrap().len(), 8);
    let synthetic_id = group["id"].as_u64().unwrap();
    let members: Vec<u64> = group["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_u64().unwrap())
        .collect();
    assert!(
        members.iter().all(|member| *member < synthetic_id),
        "synthetic group ids sit above every real member id"
    );

    // group_vectors also applies to cone and line-cone envelopes.
    let cone = get_json(
        &mut app,
        &format!(
            "/api/design/{design_id}/cone?node={}&dir=fanin&group_vectors=true",
            members[0]
        ),
    )
    .await;
    assert!(
        cone["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["id"].as_u64() == Some(synthetic_id)
                && node["is_root"].as_bool() == Some(true)),
        "a member cone lands on its group node as root"
    );

    // Synthetic group ids are not addressable through the per-bit APIs.
    let rejected = get_response(
        &mut app,
        &format!("/api/design/{design_id}/cone?node={synthetic_id}&dir=fanin"),
    )
    .await;
    assert_eq!(rejected.status(), StatusCode::NOT_FOUND);
    let nodes_rejected = get_json(
        &mut app,
        &format!("/api/design/{design_id}/nodes?ids={synthetic_id}"),
    )
    .await;
    assert!(
        nodes_rejected["nodes"].as_array().unwrap().is_empty(),
        "/nodes ignores synthetic group ids"
    );
}

#[tokio::test]
async fn line_cone_distinguishes_optimized_logic_from_non_synthesizable_lines() {
    let source = "module optimized(\n  input logic a,\n  input logic b,\n  output logic y\n);\n  wire unused = a & b;\n  assign y = a;\nendmodule\n";
    let mut app = app(AppState::default());
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "files": [{"name": "optimized.sv", "content": source}],
                        "top": "optimized",
                        "mode": "gates"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();

    let source_map = get_json(&mut app, &format!("/api/design/{design_id}/source-map")).await;
    assert!(source_map["by_line"]["optimized.sv:7"].is_null());
    assert!(
        source_map["ranges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|range| {
                range["file"] == "optimized.sv"
                    && range["start_line"] == 7
                    && range["end_line"] == 7
                    && !range["node_ids"].as_array().unwrap().is_empty()
            })
    );
    assert_eq!(source_map["truncated"], false);

    let optimized = get_json(
        &mut app,
        &format!("/api/design/{design_id}/line-cone?file=optimized.sv&start_line=6&end_line=6"),
    )
    .await;
    assert_eq!(optimized["status"], "optimized_or_absorbed");
    assert_eq!(optimized["graph"]["nodes"], json!([]));

    let wire_only_assign = get_json(
        &mut app,
        &format!("/api/design/{design_id}/line-cone?file=optimized.sv&start_line=7&end_line=7"),
    )
    .await;
    assert_eq!(wire_only_assign["status"], "mapped");
    let assign_nodes = wire_only_assign["graph"]["nodes"].as_array().unwrap();
    assert!(assign_nodes.iter().any(|node| node["name"] == "a"));
    let y = assign_nodes
        .iter()
        .find(|node| node["name"] == "y")
        .expect("wire-only output root");
    assert!(
        y["src"]
            .as_str()
            .is_some_and(|src| src.contains("optimized.sv:7-7")),
        "synthetic assign provenance must support graph-to-source probing"
    );

    let declaration = get_json(
        &mut app,
        &format!("/api/design/{design_id}/line-cone?file=optimized.sv&start_line=1&end_line=1"),
    )
    .await;
    assert_eq!(declaration["status"], "unmapped");
}

#[tokio::test]
async fn wire_alias_provenance_is_scoped_to_the_selected_top() {
    let source = "module helper(input wire a, output wire y);\n  assign y = a;\nendmodule\nmodule scoped(input wire a, output wire y);\n  wire alias = a;\n  assign y = alias;\nendmodule\n";
    let mut app = app(AppState::default());
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "files": [{"name": "scoped.sv", "content": source}],
                        "top": "scoped",
                        "mode": "gates"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();

    let helper = get_json(
        &mut app,
        &format!("/api/design/{design_id}/line-cone?file=scoped.sv&start_line=2&end_line=2"),
    )
    .await;
    assert_eq!(helper["status"], "unmapped");

    let alias = get_json(
        &mut app,
        &format!("/api/design/{design_id}/line-cone?file=scoped.sv&start_line=5&end_line=5"),
    )
    .await;
    assert_ne!(alias["status"], "unmapped");

    let top_assign = get_json(
        &mut app,
        &format!("/api/design/{design_id}/line-cone?file=scoped.sv&start_line=6&end_line=6"),
    )
    .await;
    assert_eq!(top_assign["status"], "mapped");
}

#[tokio::test]
async fn wire_alias_provenance_tracks_reachable_child_instance_scopes() {
    let source = std::fs::read_to_string("tests/fixtures/children_scope.sv").unwrap();
    let mut app = app(AppState::default());
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "files": [{"name": "children.sv", "content": source}],
                        "top": "scoped_children",
                        "mode": "gates"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();

    let leaf_alias = get_json(
        &mut app,
        &format!("/api/design/{design_id}/line-cone?file=children.sv&start_line=2&end_line=2"),
    )
    .await;
    assert_eq!(leaf_alias["status"], "mapped");
    let leaf_names: Vec<&str> = leaf_alias["graph"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|node| node["name"].as_str())
        .collect();
    assert!(leaf_names.contains(&"y0"));
    assert!(!leaf_names.contains(&"y1"));

    let other_alias = get_json(
        &mut app,
        &format!("/api/design/{design_id}/line-cone?file=children.sv&start_line=6&end_line=6"),
    )
    .await;
    assert_eq!(other_alias["status"], "mapped");
    assert!(
        other_alias["graph"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| node["name"] == "y1")
    );

    let unused_alias = get_json(
        &mut app,
        &format!("/api/design/{design_id}/line-cone?file=children.sv&start_line=10&end_line=10"),
    )
    .await;
    assert_eq!(unused_alias["status"], "unmapped");
}

#[tokio::test]
async fn generated_clock_is_labeled_and_warned_without_default_clock_wiring() {
    let source = r#"
module generated_clock (
    input logic clk,
    input logic en,
    input logic d,
    output logic q
);
  wire gated_clk = clk & en;
  always_ff @(posedge gated_clk) q <= d;
endmodule
"#;
    let mut app = app(AppState::default());
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "files": [{"name": "generated_clock.sv", "content": source}],
                        "top": "generated_clock",
                        "mode": "rtl"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();
    let endpoints = get_json(&mut app, &format!("/api/design/{design_id}/endpoints")).await;
    let register_id = endpoints["registers"][0]["bits"][0]["node_id"]
        .as_u64()
        .unwrap();

    let netlist = get_json(
        &mut app,
        &format!("/api/design/{design_id}/netlist?max_nodes=100"),
    )
    .await;
    let register = netlist["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["id"].as_u64() == Some(register_id))
        .expect("register should be present in schematic projection");
    let clock = register["controls"]
        .as_array()
        .unwrap()
        .iter()
        .find(|control| control["role"] == "clock")
        .expect("register should expose a clock label");
    assert_eq!(clock["generated"], true);
    assert_eq!(clock["net_name"], "gated_clk");
    assert!(clock["fanout"].as_u64().is_some_and(|fanout| fanout >= 1));
    assert!(netlist["edges"].as_array().unwrap().iter().all(|edge| {
        edge["to"].as_u64() != Some(register_id)
            || (edge["to_port"] != "CLK" && edge["to_port"] != "C")
    }));
}

#[tokio::test]
async fn hard_flip_flop_encoding_drives_reset_polarity_metadata() {
    let source = r#"
module active_low_reset (
    input  wire clk,
    input  wire reset,
    input  wire d,
    output reg  q
);
  always @(posedge clk or negedge reset)
    if (!reset) q <= 1'b0;
    else q <= d;
endmodule
"#;
    let mut app = app(AppState::default());
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "files": [{"name": "active_low_reset.sv", "content": source}],
                        "top": "active_low_reset",
                        "mode": "gates"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();
    let netlist = get_json(
        &mut app,
        &format!("/api/design/{design_id}/netlist?max_nodes=100"),
    )
    .await;
    let reset = netlist["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|node| node["controls"].as_array().into_iter().flatten())
        .find(|control| control["role"] == "reset")
        .expect("hard flip-flop should expose a reset control label");
    assert_eq!(reset["active_low"], true);
    assert_eq!(reset["synchronous"], false);
    assert_eq!(reset["generated"], false);
}

#[tokio::test]
async fn rtl_parameters_and_vendor_primitives_override_reset_name_heuristics() {
    let rtl_source = r#"
module rtl_reset(input wire clk, input wire reset, input wire d, output reg q);
  always @(posedge clk or negedge reset)
    if (!reset) q <= 1'b0; else q <= d;
endmodule
"#;
    let vendor_source = r#"
module vendor_reset(input wire clk, input wire rst_n, input wire d, output reg q);
  always @(posedge clk)
    if (rst_n) q <= 1'b0; else q <= d;
endmodule
"#;
    let mut app = app(AppState::default());
    for (name, source, mode, expected_active_low) in [
        ("rtl_reset", rtl_source, "rtl", true),
        ("vendor_reset", vendor_source, "xilinx", false),
    ] {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/synthesize")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&json!({
                            "files": [{"name": format!("{name}.sv"), "content": source}],
                            "top": name,
                            "mode": mode
                        }))
                        .unwrap(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let synth = body_json(response).await;
        let design_id = synth["design_id"].as_str().unwrap();
        let netlist = get_json(
            &mut app,
            &format!("/api/design/{design_id}/netlist?max_nodes=100"),
        )
        .await;
        let reset = netlist["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|node| node["controls"].as_array().into_iter().flatten())
            .find(|control| control["role"] == "reset")
            .unwrap_or_else(|| panic!("{mode} reset label"));
        assert_eq!(reset["active_low"], expected_active_low, "mode {mode}");
    }
}

#[tokio::test]
async fn enable_label_threshold_counts_only_the_driven_net_bit() {
    let source = r#"
(* blackbox *)
module enabled_sink (
    input  wire EN,
    input  wire D,
    output wire Q
);
endmodule

module local_enable_vector (
    input  wire       clk,
    input  wire       d,
    input  wire [7:0] next,
    output wire       q,
    output wire [7:0] mirror
);
  reg [7:0] controls;
  always @(posedge clk) controls <= next;
  enabled_sink sink (.EN(controls[0]), .D(d), .Q(q));
  assign mirror = controls;
endmodule
"#;
    let mut app = app(AppState::default());
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "files": [{"name": "local_enable_vector.sv", "content": source}],
                        "top": "local_enable_vector",
                        "mode": "rtl"
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();
    let netlist = get_json(
        &mut app,
        &format!("/api/design/{design_id}/netlist?max_nodes=100"),
    )
    .await;
    let sink = netlist["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["cell_type"] == "enabled_sink")
        .expect("enabled sink in netlist");
    let sink_id = sink["id"].as_u64().unwrap();
    assert!(
        sink["controls"]
            .as_array()
            .is_none_or(|controls| controls.iter().all(|control| control["role"] != "enable"))
    );
    let edges = netlist["edges"].as_array().unwrap();
    assert!(
        edges.iter().any(|edge| {
            edge["to"].as_u64() == Some(sink_id)
                && matches!(edge["to_port"].as_str(), Some("EN" | "E" | "CE"))
        }),
        "local enable edge should remain wired: {edges:#?}"
    );
}

async fn get_json(app: &mut axum::Router, uri: &str) -> serde_json::Value {
    let response = get_response(app, uri).await;
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
}

#[tokio::test]
async fn high_fanout_memory_registers_are_grouped_by_array_element() {
    let source = std::fs::read_to_string("../examples/04_high_fanout_enable.sv").unwrap();
    let mut app = app(AppState::default());
    let synth_body = json!({
        "files": [{"name": "04_high_fanout_enable.sv", "content": source}],
        "top": "high_fanout_enable",
        "mode": "gates"
    });
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&synth_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();
    assert_eq!(synth["stats"]["num_register_bits"].as_u64(), Some(128));
    assert_eq!(synth["stats"]["num_register_groups"].as_u64(), Some(16));

    let endpoints = get_json(&mut app, &format!("/api/design/{design_id}/endpoints")).await;
    let registers = endpoints["registers"].as_array().unwrap();
    assert_eq!(registers.len(), 16);
    assert!(
        registers
            .iter()
            .all(|group| group["width"].as_u64() == Some(8))
    );
    let names: BTreeSet<_> = registers
        .iter()
        .map(|group| group["name"].as_str().unwrap().to_owned())
        .collect();
    let expected: BTreeSet<_> = (0..16).map(|idx| format!("regs[{idx}]")).collect();
    assert_eq!(names, expected);
}

#[tokio::test]
async fn gates_mode_keeps_oversized_memories_abstract() {
    // Small as text, but 8 write ports on a 4096x48 memory explode past the
    // 2 GiB sandbox cap when memory_map flattens them to gates.
    let source = r#"
module big_mem (
    input  wire        clk,
    input  wire        we,
    input  wire [11:0] waddr,
    input  wire [47:0] wdata,
    input  wire [11:0] raddr,
    output reg  [47:0] rdata
);
  reg [47:0] mem [0:4095];
  genvar i;
  generate
    for (i = 0; i < 8; i = i + 1) begin : g
      always @(posedge clk) if (we) mem[waddr ^ i] <= wdata;
    end
  endgenerate
  always @(posedge clk) rdata <= mem[raddr];
endmodule
"#;
    let mut app = app(AppState::default());
    let synth_body = json!({
        "files": [{"name": "big_mem.v", "content": source}],
        "top": "big_mem",
        "mode": "gates"
    });
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&synth_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    assert_eq!(synth["memories_abstracted"], true);
    assert!(
        synth["stats"]["num_cells"]
            .as_u64()
            .is_some_and(|count| count >= 1)
    );
    let design_id = synth["design_id"].as_str().unwrap();

    // 122 port bits precede the cells in netlist order, so use a cap that
    // covers the whole design.
    let netlist = get_json(
        &mut app,
        &format!("/api/design/{design_id}/netlist?max_nodes=400"),
    )
    .await;
    assert!(
        netlist["nodes"].as_array().unwrap().iter().any(|node| {
            node["cell_type"]
                .as_str()
                .is_some_and(|cell_type| cell_type.starts_with("$mem"))
        }),
        "abstract retry should leave a $mem cell in the netlist"
    );

    // The cached design reproduces the flag on reload.
    let design = get_json(&mut app, &format!("/api/design/{design_id}")).await;
    assert_eq!(design["memories_abstracted"], true);
}

#[tokio::test]
async fn blackbox_input_paths_contribute_to_stats_max_depth() {
    let source = std::fs::read_to_string("../examples/07_blackbox.sv").unwrap();
    let mut app = app(AppState::default());
    let synth_body = json!({
        "files": [{"name": "07_blackbox.sv", "content": source}],
        "top": "blackbox_demo",
        "mode": "gates"
    });
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/synthesize")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&synth_body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let synth = body_json(response).await;
    let design_id = synth["design_id"].as_str().unwrap();
    let stats_max_depth = synth["stats"]["max_depth"].as_u64().unwrap();
    assert!(stats_max_depth >= 1);

    let paths = get_json(&mut app, &format!("/api/design/{design_id}/paths?limit=25")).await;
    let top_path_depth = paths["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|path| path["depth"].as_u64().unwrap())
        .max()
        .unwrap();
    assert_eq!(stats_max_depth, top_path_depth);
    let boundary_path = paths["paths"]
        .as_array()
        .unwrap()
        .iter()
        .find(|path| path["startpoint"]["cell_type"] == "mystery_core")
        .expect("blackbox output should remain visible as a path boundary");
    assert_eq!(boundary_path["class"], "other");
    assert_eq!(boundary_path["startpoint"]["register"], false);
}

async fn get_response(app: &mut axum::Router, uri: &str) -> axum::response::Response {
    app.clone()
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}
