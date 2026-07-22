#![forbid(unsafe_code)]

use schemweave::{Graph, LayoutOptions};
use wasm_bindgen::prelude::*;

/// Lay out one compact circuit graph inside the dedicated layout worker.
#[wasm_bindgen]
pub fn layout_json(graph_json: &str) -> Result<String, JsValue> {
    let graph: Graph = serde_json::from_str(graph_json)
        .map_err(|error| js_error(format!("invalid layout graph: {error}")))?;
    let layout = schemweave::layout(&graph, LayoutOptions::default())
        .map_err(|error| js_error(error.to_string()))?;
    serde_json::to_string(&layout)
        .map_err(|error| js_error(format!("failed to encode layout: {error}")))
}

fn js_error(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}

#[cfg(test)]
mod tests {
    use super::layout_json;

    #[test]
    fn lays_out_an_empty_graph() {
        assert_eq!(
            layout_json(r#"{"nodes":[],"edges":[]}"#).unwrap(),
            r#"{"nodes":[],"edges":[],"width":0.0,"height":0.0}"#
        );
    }

    #[test]
    fn lays_out_and_routes_a_connected_graph() {
        let output = layout_json(
            r#"{"nodes":[{"id":1,"width":62,"height":46,"ports":[{"id":0,"side":"east","offset":23}]},{"id":2,"width":62,"height":46,"ports":[{"id":0,"side":"west","offset":23}]}],"edges":[{"id":7,"source":{"node":1,"port":0},"target":{"node":2,"port":0},"net":3,"participates_in_ranking":true}]}"#,
        )
        .unwrap();
        let layout: serde_json::Value = serde_json::from_str(&output).unwrap();

        assert_eq!(layout["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(layout["edges"][0]["id"], 7);
        assert!(layout["edges"][0]["points"].as_array().unwrap().len() >= 2);
        assert!(layout["width"].as_f64().unwrap() > 0.0);
    }
}
