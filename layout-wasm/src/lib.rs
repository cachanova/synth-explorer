#![forbid(unsafe_code)]

use schemweave::{
    ConstrainedLayoutError, Graph, GroupCollapseOptions, GroupExpansion, GroupExpansionError,
    GroupExpansionOptions, Layout, LayoutConfig, LayoutConstraints, LayoutError, ProtectedGroup,
    collapse_group_in_place, expand_group_in_place_with_reference_height,
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
    reference_height: f64,
    #[serde(default)]
    protected_groups: Vec<ProtectedGroup>,
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
    let result = match expand_group_in_place_with_reference_height(
        &request.compact_graph,
        &request.compact_layout,
        &request.expanded_graph,
        &request.expansion,
        request.reference_height,
        &GroupExpansionOptions {
            layout: config.layout,
            quality_effort: config.quality_effort,
            constraints: config.constraints,
            protected_groups: request.protected_groups,
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

#[derive(Deserialize)]
struct CollapseRequest {
    expanded_graph: Graph,
    expanded_layout: Layout,
    compact_graph: Graph,
    expansion: GroupExpansion,
    #[serde(default)]
    constraints: LayoutConstraints,
}

/// Collapse one expanded group without moving unrelated geometry.
#[wasm_bindgen]
pub fn collapse_group_json(request_json: &str) -> Result<String, JsValue> {
    let request: CollapseRequest = serde_json::from_str(request_json)
        .map_err(|error| js_error(format!("invalid group collapse request: {error}")))?;
    let mut config = LayoutConfig::highest_quality();
    config.constraints = request.constraints;
    let result = match collapse_group_in_place(
        &request.expanded_graph,
        &request.expanded_layout,
        &request.compact_graph,
        &request.expansion,
        &GroupCollapseOptions {
            layout: config.layout,
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
        .map_err(|error| js_error(format!("failed to encode group collapse: {error}")))
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
    use schemweave::{ConstrainedLayoutError, Layout, LayoutError};

    use super::{
        BOUNDARY_BUNDLE_GEOMETRY_ERROR_NAME, collapse_group_json, expand_group_json,
        layout_error_name, layout_json,
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
    fn consolidates_declared_vector_bundle_member_routes() {
        let port = |id: u32, side: &str, offset: f64| serde_json::json!({"id":id,"side":side,"offset":offset});
        let edge = |id: u32,
                    source_node: u32,
                    source_port: u32,
                    target_node: u32,
                    target_port: u32,
                    net: u32| {
            serde_json::json!({
                "id": id,
                "source": {"node": source_node, "port": source_port},
                "target": {"node": target_node, "port": target_port},
                "net": net,
                "participates_in_ranking": true
            })
        };
        let mut edges = vec![edge(0, 26, 0, 44, 2, 25), edge(9, 44, 3, 43, 0, 24)];
        edges.extend((1..=8).map(|id| edge(id, 43, 1, 47, 0, id + 10)));
        edges.extend((10..=17).map(|id| edge(id, 45, 0, 44, 0, id - 10)));
        edges.extend((18..=25).map(|id| edge(id, 46, 0, 44, 1, id - 15)));
        let members = |first: u32| {
            (0..8)
                .map(|slot| serde_json::json!({"edge":first + slot,"slots":[slot]}))
                .collect::<Vec<_>>()
        };
        let request = serde_json::json!({
            "graph": {
                "nodes": [
                    {"id":26,"width":74,"height":34,"ports":[port(0, "east", 17.0)]},
                    {
                        "id":43,
                        "width":92,
                        "height":84,
                        "cycle_breaker":true,
                        "ports":[port(0, "west", 18.56), port(1, "east", 29.0)]
                    },
                    {
                        "id":44,
                        "width":70,
                        "height":72,
                        "ports":[
                            port(0, "west", 18.0),
                            port(1, "west", 36.0),
                            port(2, "west", 54.0),
                            port(3, "east", 36.0)
                        ]
                    },
                    {"id":45,"width":74,"height":34,"ports":[port(0, "east", 17.0)]},
                    {"id":46,"width":74,"height":34,"ports":[port(0, "east", 17.0)]},
                    {"id":47,"width":74,"height":34,"ports":[port(0, "west", 17.0)]}
                ],
                "edges": edges
            },
            "constraints": {
                "inputs": [26, 45, 46],
                "outputs": [47],
                "boundary_bundles": [
                    {
                        "id":0,
                        "endpoint":{"node":45,"port":0},
                        "width":8,
                        "members":members(10)
                    },
                    {
                        "id":1,
                        "endpoint":{"node":46,"port":0},
                        "width":8,
                        "members":members(18)
                    },
                    {
                        "id":2,
                        "endpoint":{"node":47,"port":0},
                        "width":8,
                        "members":members(1)
                    }
                ]
            }
        });
        let layout: Layout =
            serde_json::from_str(&layout_json(&request.to_string()).unwrap()).unwrap();

        assert_eq!(layout.boundary_bundles.len(), 3);
        for bundle in &layout.boundary_bundles {
            assert_eq!(bundle.members.len(), 8);
            let representative = layout
                .edges
                .iter()
                .find(|route| route.id == bundle.members[0].edge)
                .unwrap();
            assert!(bundle.members.iter().all(|member| {
                layout
                    .edges
                    .iter()
                    .find(|route| route.id == member.edge)
                    .is_some_and(|route| route.points == representative.points)
            }));
        }
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
                    "nodes":[
                        {"id":10,"width":80,"height":50,"ports":[]},
                        {"id":3,"width":80,"height":50,"ports":[]}
                    ],
                    "edges":[]
                },
                "compact_layout":{
                    "nodes":[
                        {"id":10,"x":0,"y":0,"width":80,"height":50},
                        {"id":3,"x":200,"y":0,"width":80,"height":50}
                    ],
                    "edges":[],
                    "width":280,
                    "height":200
                },
                "reference_height":200,
                "expanded_graph":{
                    "nodes":[
                        {"id":1,"width":80,"height":50,"ports":[]},
                        {"id":2,"width":80,"height":50,"ports":[]},
                        {"id":3,"width":80,"height":50,"ports":[]}
                    ],
                    "edges":[]
                },
                "expansion":{
                    "anchor":10,
                    "members":[1,2],
                    "boundary_trunks":[]
                },
                "protected_groups":[
                    {"id":20,"members":[3],"frame_padding":30}
                ]
            }"#,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(&response).unwrap();

        assert_eq!(value["status"], "layout");
        assert_eq!(value["layout"]["nodes"].as_array().unwrap().len(), 3);
        assert_eq!(
            value["layout"]["nodes"][0]["x"],
            value["layout"]["nodes"][1]["x"]
        );
        assert_eq!(value["layout"]["nodes"][2]["id"], 3);
        assert_eq!(value["layout"]["nodes"][2]["x"].as_f64(), Some(200.0));
    }

    #[test]
    fn collapses_a_group_through_the_consumer_wrapper() {
        let response = collapse_group_json(
            r#"{
                "expanded_graph":{
                    "nodes":[
                        {"id":1,"width":80,"height":50,"ports":[]},
                        {"id":2,"width":80,"height":50,"ports":[]}
                    ],
                    "edges":[]
                },
                "expanded_layout":{
                    "nodes":[
                        {"id":1,"x":0,"y":0,"width":80,"height":50},
                        {"id":2,"x":0,"y":80,"width":80,"height":50}
                    ],
                    "edges":[],
                    "width":80,
                    "height":200
                },
                "compact_graph":{
                    "nodes":[{"id":10,"width":80,"height":50,"ports":[]}],
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
        assert_eq!(value["layout"]["nodes"].as_array().unwrap().len(), 1);
        assert_eq!(value["layout"]["nodes"][0]["id"], 10);
    }
}
