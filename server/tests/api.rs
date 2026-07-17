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

async fn post_json(
    app: &mut axum::Router,
    uri: &str,
    body: serde_json::Value,
) -> serde_json::Value {
    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
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
        "files": [{"name": "reg_mux.sv", "content": source}],
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
    assert_eq!(synth["tool"], "yosys");
    assert_eq!(synth["mode"], "rtl");
    assert!(synth.get("target").is_none());
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
            .any(|file| file.as_str() == Some("reg_mux.sv"))
    );
    assert!(source_map["ranges"].is_array());
    assert!(source_map["truncated"].is_boolean());
}

#[tokio::test]
async fn exploration_endpoint_returns_the_prepared_browser_model() {
    let source = std::fs::read_to_string("../examples/handshake_controller.sv").unwrap();
    let mut app = app(AppState::default());
    let synthesized = post_json(
        &mut app,
        "/api/synthesize",
        json!({
            "files": [{"name": "handshake_controller.sv", "content": source}],
            "top": "handshake_controller",
            "mode": "rtl"
        }),
    )
    .await;
    let design_id = synthesized["design_id"].as_str().unwrap();

    let snapshot = get_json(&mut app, &format!("/api/design/{design_id}/exploration")).await;

    assert_eq!(snapshot["design_id"], design_id);
    assert_eq!(snapshot["schema_version"], 1);
    assert!(!snapshot["nodes"].as_array().unwrap().is_empty());
    assert!(!snapshot["edges"].as_array().unwrap().is_empty());
    assert!(!snapshot["source_by_line"].as_object().unwrap().is_empty());
    assert!(!snapshot["source_hints"].as_array().unwrap().is_empty());
    assert!(snapshot["procedural_targets"]["handshake_controller.sv"].is_object());
    assert!(snapshot["nodes"].as_array().unwrap().iter().all(|node| {
        node["boundary"].is_boolean()
            && node["comb"].is_boolean()
            && node["infrastructure"].is_boolean()
    }));
}

#[tokio::test]
async fn examples_endpoint_returns_the_parameterized_catalog() {
    let mut app = app(AppState::default());
    let response = get_response(&mut app, "/api/examples").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    let examples = body["examples"].as_array().unwrap();
    let names: Vec<_> = examples
        .iter()
        .map(|example| example["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "reg_mux",
            "priority_encoder_case",
            "priority_encoder_for",
            "priority_encoder_carry",
            "adder_chain",
            "barrel_shifter",
            "round_robin_arbiter",
            "pipe",
            "srl_pipe",
            "fifo_pipe",
            "inferred_fifo",
            "async_fifo_blackbox",
            "handshake_controller",
        ]
    );
    assert!(examples.iter().all(|example| {
        example["title"].is_string()
            && example["description"].is_string()
            && example["top"].is_string()
            && example["files"].as_array().is_some_and(|files| {
                files.len() == 1
                    && files[0]["name"].is_string()
                    && files[0]["content"]
                        .as_str()
                        .is_some_and(|content| content.contains("#("))
            })
    }));
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
async fn group_vectors_collapses_buses_and_addresses_synthetic_roots() {
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
    let plain_register_names: Vec<_> = plain["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| node["register"] == true)
        .map(|node| node["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        plain_register_names,
        (0..8).map(|bit| format!("q[{bit}]")).collect::<Vec<_>>(),
        "ungrouped register nodes retain their individual bit indices"
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
    // The register bus plus the d/q port buses each collapse to one width node.
    assert_eq!(
        group_nodes.len(),
        3,
        "register bus and both port buses collapse"
    );
    assert_eq!(
        group_nodes
            .iter()
            .filter(|node| node["kind"] == "port")
            .count(),
        2,
        "d and q ports each become one bus node"
    );
    let group = group_nodes
        .iter()
        .find(|node| node["kind"] == "cell")
        .expect("the register bus is a cell group node");
    assert_eq!(group["name"], "q[7:0]");
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

    // group_vectors also applies to cone projections.
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

    // Group-aware graph projections resolve a synthetic id to all real members
    // server-side, so even groups wider than the public multi-root limit remain
    // expandable without an unbounded URL.
    let synthetic_cone = get_json(
        &mut app,
        &format!("/api/design/{design_id}/cone?node={synthetic_id}&dir=fanin&group_vectors=true"),
    )
    .await;
    assert!(
        synthetic_cone["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|node| {
                node["id"].as_u64() == Some(synthetic_id) && node["is_root"].as_bool() == Some(true)
            })
    );
    let synthetic_context = get_response(
        &mut app,
        &format!("/api/design/{design_id}/netlist?around={synthetic_id}&group_vectors=true"),
    )
    .await;
    assert_eq!(synthetic_context.status(), StatusCode::OK);

    // Without the grouping contract, synthetic ids remain unknown; /nodes is
    // intentionally a real per-bit lookup API.
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

    for (uri, expected) in [
        (
            format!("/api/design/{design_id}/netlist?around=abc"),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            format!(
                "/api/design/{design_id}/netlist?around={}",
                (0..201)
                    .map(|id| id.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            format!("/api/design/{design_id}/netlist?around=999999"),
            StatusCode::NOT_FOUND,
        ),
        (
            format!(
                "/api/design/{design_id}/netlist?around={}&group_vectors=true",
                members[0]
            ),
            StatusCode::OK,
        ),
    ] {
        let response = get_response(&mut app, &uri).await;
        assert_eq!(response.status(), expected, "unexpected status for {uri}");
    }
}

#[tokio::test]
async fn grouped_cone_expands_a_vector_wider_than_the_multi_root_limit() {
    let source = r#"
module wide_bus_regs (
    input  logic         clk,
    input  logic [255:0] d,
    output logic [255:0] q
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
                        "files": [{"name": "wide_bus_regs.sv", "content": source}],
                        "top": "wide_bus_regs",
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
    let grouped = get_json(
        &mut app,
        &format!("/api/design/{design_id}/netlist?group_vectors=true"),
    )
    .await;
    let register = grouped["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["register"] == true && node["width"] == 256)
        .expect("256-bit register group");
    assert_eq!(register["members"].as_array().unwrap().len(), 256);
    let synthetic_id = register["id"].as_u64().unwrap();

    let response = get_response(
        &mut app,
        &format!(
            "/api/design/{design_id}/cone?node={synthetic_id}&dir=fanin&max_depth=1&group_vectors=true"
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
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
async fn pipe_registers_are_grouped_by_array_element() {
    let source = std::fs::read_to_string("../examples/pipe.sv").unwrap();
    let mut app = app(AppState::default());
    let synth_body = json!({
        "files": [{"name": "pipe.sv", "content": source}],
        "top": "pipe",
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
    assert_eq!(synth["stats"]["num_register_bits"].as_u64(), Some(64));
    assert_eq!(synth["stats"]["num_register_groups"].as_u64(), Some(4));

    let endpoints = get_json(&mut app, &format!("/api/design/{design_id}/endpoints")).await;
    let registers = endpoints["registers"].as_array().unwrap();
    assert_eq!(registers.len(), 4);
    assert!(
        registers
            .iter()
            .all(|group| group["width"].as_u64() == Some(16))
    );
    let names: BTreeSet<_> = registers
        .iter()
        .map(|group| group["name"].as_str().unwrap().to_owned())
        .collect();
    let expected: BTreeSet<_> = (0..4)
        .map(|idx| format!("with_stages.stage[{idx}]"))
        .collect();
    assert_eq!(names, expected);
}

#[tokio::test]
async fn gates_mode_synthesizes_oversized_memories() {
    // 8 write ports on a 4096x48 memory. Whether flattening to gates exceeds the
    // 2 GiB sandbox cap depends on the Yosys version, so this asserts the
    // version-independent contract: gates-mode synthesis succeeds and yields a
    // usable netlist. When the abstract-memory retry does fire, the memory
    // survives as a `$mem` cell — the deterministic proof of the abstract script
    // itself lives in tests/examples.rs.
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
    let abstracted = synth["memories_abstracted"] == serde_json::json!(true);
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
    let has_mem = netlist["nodes"].as_array().unwrap().iter().any(|node| {
        node["cell_type"]
            .as_str()
            .is_some_and(|cell_type| cell_type.starts_with("$mem"))
    });
    if abstracted {
        assert!(has_mem, "an abstract retry must leave a $mem cell");
    }

    // The cached design reproduces the flag on reload.
    let design = get_json(&mut app, &format!("/api/design/{design_id}")).await;
    assert_eq!(design["memories_abstracted"], synth["memories_abstracted"]);
}

#[tokio::test]
async fn blackbox_input_paths_contribute_to_stats_max_depth() {
    let source = std::fs::read_to_string("../examples/async_fifo_blackbox.sv").unwrap();
    let mut app = app(AppState::default());
    let synth_body = json!({
        "files": [{"name": "async_fifo_blackbox.sv", "content": source}],
        "top": "async_fifo_wrapper",
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
        .find(|path| path["startpoint"]["cell_type"] == "async_fifo_ip")
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

#[tokio::test]
async fn rtl_mode_hides_the_absolute_delay_estimate() {
    let source = r#"
module add4 (
    input  logic       clk,
    input  logic [3:0] a,
    input  logic [3:0] b,
    output logic [3:0] q
);
  always_ff @(posedge clk) q <= a + b;
endmodule
"#;
    let mut app = app(AppState::default());

    let rtl = post_json(
        &mut app,
        "/api/synthesize",
        json!({
            "files": [{"name": "add4.sv", "content": source}],
            "top": "add4",
            "mode": "rtl"
        }),
    )
    .await;
    // An RTL netlist keeps word-level cells ($add here) that a per-cell model
    // cannot cost, so the absolute estimate is withheld...
    assert!(rtl["stats"].get("estimated_delay_ns").is_none());
    assert!(rtl["stats"].get("estimated_delay_breakdown").is_none());
    // ...while depth statistics stay.
    assert!(rtl["stats"]["max_depth"].as_u64().unwrap() >= 1);
    assert!(
        rtl["stats"]["depths"]["input_to_register"]
            .as_u64()
            .unwrap()
            >= 1
    );

    // A retune cannot conjure an estimate either; the resolved base model is
    // still echoed so the client can populate its coefficient editor.
    let design_id = rtl["design_id"].as_str().unwrap();
    let retune = post_json(
        &mut app,
        &format!("/api/design/{design_id}/timing"),
        json!({"profile": "sky130hd"}),
    )
    .await;
    assert!(retune["estimated_delay_ns"].is_null());
    assert!(retune.get("estimated_delay_breakdown").is_none());
    assert!(retune["model"]["lut_ps"].as_f64().unwrap() > 0.0);

    // Per-path delays are the same absolute estimate; paths and depths stay.
    let paths = get_json(&mut app, &format!("/api/design/{design_id}/paths?limit=5")).await;
    let paths = paths["paths"].as_array().unwrap();
    assert!(!paths.is_empty());
    for path in paths {
        assert!(path.get("estimated_delay_ns").is_none());
    }

    // Gates mode is structurally costable, but its automatic profile is still
    // technology-neutral. Absolute timing stays withheld until a real process
    // node is selected.
    let gates = post_json(
        &mut app,
        "/api/synthesize",
        json!({
            "files": [{"name": "add4.sv", "content": source}],
            "top": "add4",
            "mode": "gates"
        }),
    )
    .await;
    assert!(gates["stats"].get("estimated_delay_ns").is_none());
    assert!(gates["stats"].get("estimated_delay_breakdown").is_none());
    let gates_id = gates["design_id"].as_str().unwrap();
    let targeted = post_json(
        &mut app,
        &format!("/api/design/{gates_id}/timing"),
        json!({"profile": "sky130hd"}),
    )
    .await;
    assert!(targeted["estimated_delay_ns"].as_f64().unwrap() > 0.0);
    assert!(targeted.get("estimated_delay_breakdown").is_some());
}
