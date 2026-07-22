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
}
