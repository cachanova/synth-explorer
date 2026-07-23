#![forbid(unsafe_code)]

use schemweave::{ConstrainedLayoutError, Graph, LayoutConfig, LayoutConstraints, LayoutError};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

const BOUNDARY_BUNDLE_GEOMETRY_ERROR_NAME: &str = "BoundaryBundleGeometryUnsatisfied";

#[derive(Deserialize)]
#[serde(untagged)]
enum LayoutRequest {
    Constrained {
        graph: Graph,
        #[serde(default)]
        constraints: LayoutConstraints,
    },
    Graph(Graph),
}

/// Lay out one compact circuit graph inside the dedicated comparison worker.
#[wasm_bindgen]
pub fn layout_json(graph_json: &str) -> Result<String, JsValue> {
    let request: LayoutRequest = serde_json::from_str(graph_json)
        .map_err(|error| js_error(format!("invalid layout graph: {error}")))?;
    let (graph, constraints) = match request {
        LayoutRequest::Constrained { graph, constraints } => (graph, constraints),
        LayoutRequest::Graph(graph) => (graph, LayoutConstraints::default()),
    };
    let mut config = LayoutConfig::highest_quality();
    config.constraints = constraints;
    let layout = schemweave::layout_with_config(&graph, &config).map_err(layout_error)?;
    serde_json::to_string(&layout)
        .map_err(|error| js_error(format!("failed to encode layout: {error}")))
}

fn layout_error_name(error: &ConstrainedLayoutError) -> Option<&'static str> {
    matches!(
        error,
        ConstrainedLayoutError::Layout(LayoutError::BoundaryBundleGeometryUnsatisfied)
    )
    .then_some(BOUNDARY_BUNDLE_GEOMETRY_ERROR_NAME)
}

fn layout_error(error: ConstrainedLayoutError) -> JsValue {
    let js_error = js_sys::Error::new(&error.to_string());
    if let Some(name) = layout_error_name(&error) {
        js_error.set_name(name);
    }
    js_error.into()
}

fn js_error(message: impl AsRef<str>) -> JsValue {
    js_sys::Error::new(message.as_ref()).into()
}

#[cfg(test)]
mod tests {
    use schemweave::{ConstrainedLayoutError, LayoutError};

    use super::{BOUNDARY_BUNDLE_GEOMETRY_ERROR_NAME, layout_error_name, layout_json};

    #[test]
    fn lays_out_an_empty_graph_for_compatibility() {
        assert_eq!(
            layout_json(r#"{"nodes":[],"edges":[]}"#).unwrap(),
            r#"{"nodes":[],"edges":[],"width":0.0,"height":0.0}"#
        );
    }

    #[test]
    fn emits_boundary_bundle_geometry() {
        let output = layout_json(
            r#"{
                "graph": {
                    "nodes": [
                        {"id":1,"width":40,"height":30,"ports":[{"id":0,"side":"east","offset":15}]},
                        {"id":2,"width":40,"height":30,"ports":[{"id":0,"side":"west","offset":15}]}
                    ],
                    "edges": [
                        {"id":7,"source":{"node":1,"port":0},"target":{"node":2,"port":0},"net":3,"participates_in_ranking":true}
                    ]
                },
                "constraints": {
                    "inputs":[1],
                    "outputs":[2],
                    "boundary_bundles":[{
                        "id":9,
                        "endpoint":{"node":1,"port":0},
                        "width":8,
                        "members":[{"edge":7,"slots":[0,7]}]
                    }]
                }
            }"#,
        )
        .unwrap();
        let layout: serde_json::Value = serde_json::from_str(&output).unwrap();

        assert_eq!(layout["boundary_bundles"][0]["id"], 9);
        assert_eq!(layout["boundary_bundles"][0]["role"], "input");
        assert_eq!(layout["boundary_bundles"][0]["width"], 8);
        assert_eq!(
            layout["boundary_bundles"][0]["members"][0]["slots"],
            serde_json::json!([0, 7])
        );
    }

    #[test]
    fn classifies_only_the_stable_boundary_bundle_readability_error() {
        assert_eq!(
            layout_error_name(&ConstrainedLayoutError::Layout(
                LayoutError::BoundaryBundleGeometryUnsatisfied,
            )),
            Some(BOUNDARY_BUNDLE_GEOMETRY_ERROR_NAME),
        );
        assert_eq!(
            layout_error_name(&ConstrainedLayoutError::Layout(
                LayoutError::UnrelatedRouteContactUnsatisfied,
            )),
            None,
        );
    }
}
