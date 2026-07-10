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
