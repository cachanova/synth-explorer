#![forbid(unsafe_code)]

use schemweave::{
    ConstrainedLayoutError, Graph, GroupExpansion, GroupExpansionError, GroupExpansionOptions,
    Layout, LayoutConfig, LayoutConstraints, LayoutError,
};
use serde::{Deserialize, Serialize};
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

#[derive(Deserialize)]
struct ExpansionRequest {
    compact_graph: Graph,
    compact_layout: Layout,
    expanded_graph: Graph,
    expansion: GroupExpansion,
    #[serde(default)]
    constraints: LayoutConstraints,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum ExpansionResponse {
    Layout { layout: Layout },
    NeedsFullRelayout { reason: FullRelayoutReason },
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum FullRelayoutReason {
    Geometry,
    WorkLimit,
    PreservedGeometryTooLarge,
}

/// Expand one quotient group while retaining unrelated compact geometry.
#[wasm_bindgen]
pub fn expand_group_json(request_json: &str) -> Result<String, JsValue> {
    let request: ExpansionRequest = serde_json::from_str(request_json)
        .map_err(|error| js_error(format!("invalid group expansion request: {error}")))?;
    let mut config = LayoutConfig::highest_quality();
    config.constraints = request.constraints;
    let result = match schemweave::expand_group_in_place(
        &request.compact_graph,
        &request.compact_layout,
        &request.expanded_graph,
        &request.expansion,
        &GroupExpansionOptions {
            layout: config.layout,
            quality_effort: config.quality_effort,
            constraints: config.constraints,
        },
    ) {
        Ok(layout) => ExpansionResponse::Layout { layout },
        Err(GroupExpansionError::NeedsFullRelayout) => ExpansionResponse::NeedsFullRelayout {
            reason: FullRelayoutReason::Geometry,
        },
        Err(GroupExpansionError::ExpansionWorkLimitExceeded { .. }) => {
            ExpansionResponse::NeedsFullRelayout {
                reason: FullRelayoutReason::WorkLimit,
            }
        }
        Err(GroupExpansionError::PreservedGeometryTooLarge { .. }) => {
            ExpansionResponse::NeedsFullRelayout {
                reason: FullRelayoutReason::PreservedGeometryTooLarge,
            }
        }
        Err(error) => return Err(js_error(error.to_string())),
    };
    serde_json::to_string(&result)
        .map_err(|error| js_error(format!("failed to encode group expansion: {error}")))
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

    use super::{
        BOUNDARY_BUNDLE_GEOMETRY_ERROR_NAME, expand_group_json, layout_error_name, layout_json,
    };

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

    #[test]
    fn expands_a_group_through_the_consumer_wrapper() {
        let response = expand_group_json(
            r#"{
                "compact_graph":{
                    "nodes":[{"id":10,"width":80,"height":50,"ports":[]}],
                    "edges":[]
                },
                "compact_layout":{
                    "nodes":[{"id":10,"x":0,"y":0,"width":80,"height":50}],
                    "edges":[],
                    "width":80,
                    "height":200
                },
                "expanded_graph":{
                    "nodes":[
                        {"id":1,"width":80,"height":50,"ports":[]},
                        {"id":2,"width":80,"height":50,"ports":[]}
                    ],
                    "edges":[]
                },
                "expansion":{
                    "anchor":10,
                    "members":[1,2],
                    "boundary_trunks":[]
                }
            }"#,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&response).unwrap();

        assert_eq!(value["status"], "layout");
        assert_eq!(value["layout"]["nodes"].as_array().unwrap().len(), 2);
        assert_eq!(
            value["layout"]["nodes"][0]["x"],
            value["layout"]["nodes"][1]["x"]
        );
    }
}
