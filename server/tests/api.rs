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
    let mapped_roots: BTreeSet<_> = source_map["by_line"]["03_adder_chain.sv:17"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_u64().unwrap())
        .collect();
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

    let mut range_roots = BTreeSet::new();
    for line in 17..=21 {
        if let Some(ids) = source_map["by_line"][format!("03_adder_chain.sv:{line}")].as_array() {
            range_roots.extend(ids.iter().map(|id| id.as_u64().unwrap()));
        }
    }
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
    assert!(assign_nodes.iter().any(|node| node["name"] == "y"));

    let declaration = get_json(
        &mut app,
        &format!("/api/design/{design_id}/line-cone?file=optimized.sv&start_line=1&end_line=1"),
    )
    .await;
    assert_eq!(declaration["status"], "unmapped");
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
