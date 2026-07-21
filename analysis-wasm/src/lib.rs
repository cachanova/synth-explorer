use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use synth_explorer_analysis::analysis::{
    ConeDir, ConeOptions, FullNetlistOptions, MAX_PATH_RESULTS, MAX_SUBGRAPH_NODES, PathSort,
    SourceSelectionOptions, SourceSelectionRange, TimingEstimate,
};
use synth_explorer_analysis::delay_model::{DelayModel, DelayProfile};
use synth_explorer_analysis::design::AnalysisDesign;
use synth_explorer_analysis::grouping::GroupPartition;
use synth_explorer_analysis::netlist::{YosysNetlist, select_top};
use wasm_bindgen::prelude::*;

const MAX_PROJECTION_ROOTS: usize = MAX_SUBGRAPH_NODES / 2;
const MAX_EXPANDED_GROUP_ROOTS: usize = 256;

#[derive(Deserialize)]
struct SourceFile {
    name: String,
    content: String,
}

#[derive(Serialize)]
struct Summary<'a> {
    design_id: &'a str,
    top: &'a str,
    delay_profile: &'a str,
    stats: synth_explorer_analysis::analysis::Stats,
    warnings: Vec<String>,
}

#[derive(Default, Deserialize)]
struct TimingQuery {
    profile: Option<String>,
    speed_grade: Option<String>,
    model: Option<DelayModel>,
}

#[derive(Serialize)]
struct TimingResponse {
    estimated_delay_ns: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    estimated_delay_breakdown: Option<synth_explorer_analysis::analysis::DelayBreakdown>,
    model: DelayModel,
}

#[derive(Default, Deserialize)]
struct PathsQuery {
    limit: Option<usize>,
    to: Option<u32>,
    sort: Option<String>,
    profile: Option<String>,
    speed_grade: Option<String>,
    model: Option<DelayModel>,
}

#[derive(Deserialize)]
struct ConeQuery {
    #[serde(default)]
    nodes: Vec<u32>,
    dir: String,
    max_depth: Option<u32>,
    max_nodes: Option<usize>,
    hide_control: Option<bool>,
    hide_const: Option<bool>,
    show_infrastructure: Option<bool>,
    group_vectors: Option<bool>,
    root_port: Option<String>,
    root_port_bit: Option<u32>,
    #[serde(default)]
    root_port_bits: Vec<u32>,
}

#[derive(Default, Deserialize)]
struct NetlistQuery {
    max_nodes: Option<usize>,
    #[serde(default)]
    around: Vec<u32>,
    show_infrastructure: Option<bool>,
    hide_control: Option<bool>,
    hide_const: Option<bool>,
    group_vectors: Option<bool>,
}

#[derive(Deserialize)]
struct SourceSelectionQuery {
    file: String,
    start_line: usize,
    end_line: usize,
    max_nodes: Option<usize>,
    hide_control: Option<bool>,
    hide_const: Option<bool>,
    group_vectors: Option<bool>,
}

#[derive(Serialize)]
struct NodesResponse {
    nodes: Vec<synth_explorer_analysis::analysis::NodeRef>,
}

#[wasm_bindgen]
pub struct AnalysisSession {
    design_id: String,
    top: String,
    profile: DelayProfile,
    design: AnalysisDesign,
}

#[wasm_bindgen]
impl AnalysisSession {
    #[wasm_bindgen(constructor)]
    pub fn new(
        design_id: &str,
        netlist_json: &str,
        source_netlist_json: &str,
        files_json: &str,
        mode: &str,
        profile: &str,
    ) -> Result<AnalysisSession, JsValue> {
        let netlist: YosysNetlist = parse_json(netlist_json, "netlist")?;
        let source_netlist: YosysNetlist = parse_json(source_netlist_json, "source netlist")?;
        let files: Vec<SourceFile> = parse_json(files_json, "source files")?;
        let top = select_top(&netlist, None)
            .map_err(|error| js_error(format!("failed to resolve top module: {error}")))?
            .0
            .to_owned();
        let profile = profile_from_name(profile)?;
        let design = AnalysisDesign::from_netlists(
            &netlist,
            &source_netlist,
            files
                .into_iter()
                .map(|file| (file.name, file.content))
                .collect(),
            mode,
            profile,
            false,
        )
        .map_err(|error| js_error(error.to_string()))?;
        Ok(Self {
            design_id: design_id.to_owned(),
            top,
            profile,
            design,
        })
    }

    pub fn summary_json(&self) -> Result<String, JsValue> {
        to_json(&Summary {
            design_id: &self.design_id,
            top: &self.top,
            delay_profile: profile_name(self.profile),
            stats: self.design.stats(),
            warnings: self.design.warnings(),
        })
    }

    pub fn endpoints_json(&self) -> Result<String, JsValue> {
        to_json(self.design.analysis.endpoints())
    }

    pub fn timing_json(&self, query_json: &str) -> Result<String, JsValue> {
        let query: TimingQuery = parse_json(query_json, "timing query")?;
        let (base, profile) = self.resolve_model(query.model, query.profile.as_deref())?;
        let effective = base.scaled(profile.speed_grade_factor(query.speed_grade.as_deref()));
        let estimate = if self.design.hides_delay_estimate(profile) {
            TimingEstimate {
                delay_ns: None,
                breakdown: None,
                starts_at_register: None,
                endpoint_kind: None,
            }
        } else {
            self.design
                .analysis
                .estimate_timing(&self.design.graph, &effective)
        };
        to_json(&TimingResponse {
            estimated_delay_ns: estimate.delay_ns,
            estimated_delay_breakdown: estimate.breakdown,
            model: base,
        })
    }

    pub fn paths_json(&self, query_json: &str) -> Result<String, JsValue> {
        let query: PathsQuery = parse_json(query_json, "paths query")?;
        let (base, profile) = self.resolve_model(query.model, query.profile.as_deref())?;
        let effective = base.scaled(profile.speed_grade_factor(query.speed_grade.as_deref()));
        let hides_delay = self.design.hides_delay_estimate(profile);
        let sort = match query.sort.as_deref() {
            Some("delay") if !hides_delay => PathSort::Delay,
            _ => PathSort::Depth,
        };
        let limit = query
            .limit
            .unwrap_or(MAX_PATH_RESULTS)
            .min(MAX_PATH_RESULTS);
        let mut response = if hides_delay {
            self.design.analysis.paths_with_model(
                &self.design.graph,
                &effective,
                limit,
                query.to,
                PathSort::Depth,
            )
        } else {
            self.design.analysis.path_variants_with_model(
                &self.design.graph,
                &effective,
                limit,
                query.to,
                sort,
            )
        };
        if hides_delay {
            for path in &mut response.paths {
                path.estimated_delay_ns = None;
            }
        }
        to_json(&response)
    }

    pub fn cone_json(&self, query_json: &str) -> Result<String, JsValue> {
        let query: ConeQuery = parse_json(query_json, "cone query")?;
        if query.nodes.is_empty() {
            return Err(js_error("at least one cone root is required"));
        }
        if query.nodes.len() > 200 {
            return Err(js_error("at most 200 cone roots may be requested"));
        }
        let dir = ConeDir::parse(&query.dir)
            .ok_or_else(|| js_error("cone direction must be fanin or fanout"))?;
        let grouping = self.grouping(query.group_vectors);
        // Synthetic group ids remain valid request roots when presentation is
        // toggled back to raw nodes. Resolve through the canonical partition,
        // then apply grouping only to the returned projection.
        let (roots, roots_truncated) =
            self.resolve_projection_roots(&query.nodes, Some(&self.design.grouping))?;
        let mut response = self
            .design
            .analysis
            .multi_root_cone(
                &self.design.graph,
                &roots,
                ConeOptions {
                    dir,
                    max_depth: query.max_depth.unwrap_or(64),
                    max_nodes: query.max_nodes.unwrap_or(300),
                    hide_control: query.hide_control.unwrap_or(true),
                    hide_const: query.hide_const.unwrap_or(true),
                    show_infrastructure: query.show_infrastructure.unwrap_or(false),
                    root_port: query.root_port.as_deref(),
                    root_port_bit: query.root_port_bit,
                    root_port_bits: (!query.root_port_bits.is_empty())
                        .then_some(query.root_port_bits.as_slice()),
                },
                grouping,
            )
            .ok_or_else(|| js_error("unknown node"))?;
        response.truncated |= roots_truncated;
        to_json(&response)
    }

    pub fn netlist_json(&self, query_json: &str) -> Result<String, JsValue> {
        let query: NetlistQuery = parse_json(query_json, "netlist query")?;
        if query.around.len() > 200 {
            return Err(js_error("at most 200 context roots may be requested"));
        }
        let grouping = self.grouping(query.group_vectors);
        let (roots, roots_truncated) =
            self.resolve_projection_roots(&query.around, Some(&self.design.grouping))?;
        let mut response = self.design.analysis.full_netlist(
            &self.design.graph,
            FullNetlistOptions {
                max_nodes: query.max_nodes.unwrap_or(1_500),
                show_infrastructure: query.show_infrastructure.unwrap_or(false),
                hide_control: query.hide_control.unwrap_or(true),
                hide_const: query.hide_const.unwrap_or(false),
                priority_roots: &roots,
            },
            grouping,
        );
        response.truncated |= roots_truncated;
        to_json(&response)
    }

    pub fn fanout_json(&self, limit: Option<usize>) -> Result<String, JsValue> {
        to_json(
            &self
                .design
                .analysis
                .fanout(&self.design.graph, limit.unwrap_or(50).min(500)),
        )
    }

    pub fn source_map_json(&self) -> Result<String, JsValue> {
        to_json(&self.design.analysis.source_map())
    }

    pub fn nodes_json(&self, ids_json: &str) -> Result<String, JsValue> {
        let ids: Vec<u32> = parse_json(ids_json, "node ids")?;
        if ids.len() > 200 {
            return Err(js_error("at most 200 node ids may be requested"));
        }
        let nodes = ids
            .into_iter()
            .filter(|id| self.design.graph.nodes.get(*id as usize).is_some())
            .map(|id| self.design.analysis.node_ref(&self.design.graph, id))
            .collect();
        to_json(&NodesResponse { nodes })
    }

    pub fn source_selection_json(&self, query_json: &str) -> Result<String, JsValue> {
        let query: SourceSelectionQuery = parse_json(query_json, "source selection query")?;
        let response = self
            .design
            .analysis
            .source_selection(
                &self.design.graph,
                &self.design.source_index,
                &self.design.grouping,
                SourceSelectionRange {
                    file: &query.file,
                    start_line: query.start_line,
                    end_line: query.end_line,
                },
                SourceSelectionOptions {
                    max_nodes: query.max_nodes.unwrap_or(400),
                    hide_control: query.hide_control.unwrap_or(true),
                    hide_const: query.hide_const.unwrap_or(true),
                    group_vectors: query.group_vectors.unwrap_or(false),
                },
            )
            .map_err(|error| js_error(error.to_string()))?;
        to_json(&response)
    }
}

impl AnalysisSession {
    fn resolve_model(
        &self,
        model: Option<DelayModel>,
        profile: Option<&str>,
    ) -> Result<(DelayModel, DelayProfile), JsValue> {
        let resolved_profile = match profile {
            Some(name) => profile_from_name(name)?,
            None => self.profile,
        };
        let base = match (model, profile) {
            (Some(model), _) => model,
            (None, Some(_)) => resolved_profile.model(),
            (None, None) => self.design.delay_model,
        };
        Ok((base, resolved_profile))
    }

    fn grouping(&self, enabled: Option<bool>) -> Option<&GroupPartition> {
        enabled.unwrap_or(false).then_some(&self.design.grouping)
    }

    fn resolve_projection_roots(
        &self,
        requested: &[u32],
        grouping: Option<&GroupPartition>,
    ) -> Result<(Vec<u32>, bool), JsValue> {
        let base = self.design.graph.nodes.len() as u32;
        let mut roots = Vec::new();
        let mut requested_seen = HashSet::new();
        let mut roots_seen = HashSet::new();
        let mut requested_groups = Vec::new();
        let mut truncated = false;
        for &id in requested {
            if !requested_seen.insert(id) {
                continue;
            }
            if id < base {
                if roots_seen.contains(&id) {
                    continue;
                }
                if roots.len() >= MAX_PROJECTION_ROOTS {
                    truncated = true;
                } else {
                    roots_seen.insert(id);
                    roots.push(id);
                }
                continue;
            }
            let group = grouping
                .and_then(|partition| {
                    id.checked_sub(base)
                        .and_then(|group_id| partition.groups.get(group_id as usize))
                })
                .ok_or_else(|| js_error("unknown node"))?;
            requested_groups.push(group);
        }

        // Give every requested group one representative root before filling
        // larger samples, leaving half the raw-node budget for traversal
        // context around those roots.
        let mut group_added = vec![0usize; requested_groups.len()];
        for (index, group) in requested_groups.iter().enumerate() {
            let Some(&member) = group
                .members
                .iter()
                .find(|member| !roots_seen.contains(member))
            else {
                continue;
            };
            if roots.len() >= MAX_PROJECTION_ROOTS {
                truncated = true;
                continue;
            }
            roots_seen.insert(member);
            roots.push(member);
            group_added[index] = 1;
        }
        for (index, group) in requested_groups.iter().enumerate() {
            for &member in &group.members {
                if roots_seen.contains(&member) {
                    continue;
                }
                if roots.len() >= MAX_PROJECTION_ROOTS
                    || group_added[index] >= MAX_EXPANDED_GROUP_ROOTS
                {
                    truncated = true;
                    break;
                }
                roots_seen.insert(member);
                roots.push(member);
                group_added[index] += 1;
            }
        }
        Ok((roots, truncated))
    }
}

fn parse_json<T: for<'de> Deserialize<'de>>(json: &str, label: &str) -> Result<T, JsValue> {
    serde_json::from_str(json).map_err(|error| js_error(format!("invalid {label}: {error}")))
}

fn to_json<T: Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(|error| js_error(format!("serialization failed: {error}")))
}

fn profile_from_name(name: &str) -> Result<DelayProfile, JsValue> {
    match name {
        "series7" => Ok(DelayProfile::Series7),
        "ultrascale" => Ok(DelayProfile::UltraScale),
        "ultrascale_plus" => Ok(DelayProfile::UltraScalePlus),
        "ice40" => Ok(DelayProfile::Ice40),
        "ecp5" => Ok(DelayProfile::Ecp5),
        "sky130hd" => Ok(DelayProfile::Sky130Hd),
        "gf180mcu" => Ok(DelayProfile::Gf180Mcu),
        "asap7" => Ok(DelayProfile::Asap7),
        "generic" => Ok(DelayProfile::Generic),
        _ => Err(js_error(format!("unknown delay profile: {name}"))),
    }
}

fn profile_name(profile: DelayProfile) -> &'static str {
    match profile {
        DelayProfile::Series7 => "series7",
        DelayProfile::UltraScale => "ultrascale",
        DelayProfile::UltraScalePlus => "ultrascale_plus",
        DelayProfile::Ice40 => "ice40",
        DelayProfile::Ecp5 => "ecp5",
        DelayProfile::Sky130Hd => "sky130hd",
        DelayProfile::Gf180Mcu => "gf180mcu",
        DelayProfile::Asap7 => "asap7",
        DelayProfile::Generic => "generic",
    }
}

fn js_error(message: impl AsRef<str>) -> JsValue {
    JsValue::from_str(message.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashMap};
    use synth_explorer_analysis::analysis::PathsResponse;
    use synth_explorer_analysis::grouping::{Group, GroupKind};

    const PRECOMPUTED: &str = include_str!(
        "../../web/public/precomputed/37326325514266a7636dac567a458bca4fd19c042a2e547533a9e09a226ccdb8.json"
    );

    fn session(mode: &str, profile: &str) -> AnalysisSession {
        let fixture: serde_json::Value =
            serde_json::from_str(PRECOMPUTED).expect("precomputed fixture parses");
        let output = &fixture["output"];
        let files =
            serde_json::to_string(&fixture["input"]["files"]).expect("fixture files serialize");
        AnalysisSession::new(
            "test",
            output["netlistJson"]
                .as_str()
                .expect("netlist JSON is present"),
            output["sourceNetlistJson"]
                .as_str()
                .expect("source netlist JSON is present"),
            &files,
            mode,
            profile,
        )
        .expect("fixture session builds")
    }

    fn path_identities(json: &str) -> BTreeSet<(String, Vec<u64>)> {
        let response: serde_json::Value = serde_json::from_str(json).expect("paths JSON parses");
        response["paths"]
            .as_array()
            .expect("paths is an array")
            .iter()
            .map(|path| {
                let endpoint = path["endpoint_group"]
                    .as_str()
                    .expect("endpoint group is a string")
                    .to_owned();
                let nodes = path["nodes"]
                    .as_array()
                    .expect("nodes is an array")
                    .iter()
                    .map(|node| node["id"].as_u64().expect("node id is numeric"))
                    .collect();
                (endpoint, nodes)
            })
            .collect()
    }

    fn response_identities(response: &PathsResponse) -> BTreeSet<(String, Vec<u64>)> {
        response
            .paths
            .iter()
            .map(|path| {
                (
                    path.endpoint_group.clone(),
                    path.nodes.iter().map(|node| u64::from(node.id)).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn hidden_timing_paths_stay_depth_only_without_delay_values() {
        let session = session("gates", "generic");
        let depth_only = session.design.analysis.paths_with_model(
            &session.design.graph,
            &session.design.delay_model,
            MAX_PATH_RESULTS,
            None,
            PathSort::Depth,
        );
        let response = session
            .paths_json(r#"{"sort":"delay"}"#)
            .expect("paths query succeeds");
        let json: serde_json::Value = serde_json::from_str(&response).expect("paths JSON parses");
        let paths = json["paths"].as_array().expect("paths is an array");

        assert!(!paths.is_empty());
        assert!(
            paths
                .iter()
                .all(|path| path.get("estimated_delay_ns").is_none())
        );
        assert_eq!(path_identities(&response), response_identities(&depth_only));
    }

    #[test]
    fn visible_timing_sorts_share_the_canonical_route_set() {
        let session = session("gates", "series7");
        let depth_only = session.design.analysis.paths_with_model(
            &session.design.graph,
            &session.design.delay_model,
            MAX_PATH_RESULTS,
            None,
            PathSort::Depth,
        );
        let depth = session
            .paths_json(r#"{"sort":"depth"}"#)
            .expect("depth query succeeds");
        let delay = session
            .paths_json(r#"{"sort":"delay"}"#)
            .expect("delay query succeeds");
        let json: serde_json::Value = serde_json::from_str(&depth).expect("paths JSON parses");
        let paths = json["paths"].as_array().expect("paths is an array");

        assert!(!paths.is_empty());
        assert!(
            paths
                .iter()
                .all(|path| path["estimated_delay_ns"].is_number())
        );
        assert_eq!(path_identities(&depth), path_identities(&delay));
        assert!(path_identities(&depth).is_superset(&response_identities(&depth_only)));
        assert!(path_identities(&depth).len() > depth_only.paths.len());
    }

    #[test]
    fn synthetic_cone_root_survives_turning_grouping_off() {
        let session = session("gates", "series7");
        let base = session.design.graph.nodes.len() as u32;
        let group_id = session
            .design
            .grouping
            .groups
            .iter()
            .position(|group| group.members.len() >= 2)
            .expect("fixture has a grouped vector") as u32;
        let synthetic_id = base + group_id;
        let response = session
            .cone_json(
                &serde_json::json!({
                    "nodes": [synthetic_id],
                    "dir": "fanin",
                    "max_depth": 1,
                    "max_nodes": 400,
                    "group_vectors": false
                })
                .to_string(),
            )
            .expect("synthetic root resolves while the response is ungrouped");
        let json: serde_json::Value = serde_json::from_str(&response).expect("cone JSON parses");
        let nodes = json["nodes"].as_array().expect("nodes is an array");

        assert!(!nodes.is_empty());
        assert!(
            nodes
                .iter()
                .all(|node| node["id"].as_u64().is_some_and(|id| id < u64::from(base)))
        );

        let (once, once_truncated) = session
            .resolve_projection_roots(&[synthetic_id], Some(&session.design.grouping))
            .expect("one synthetic root resolves");
        let (repeated, repeated_truncated) = session
            .resolve_projection_roots(&vec![synthetic_id; 200], Some(&session.design.grouping))
            .expect("repeated synthetic roots resolve");
        assert_eq!(repeated, once, "duplicate requests must not amplify roots");
        assert_eq!(repeated_truncated, once_truncated);

        let oversized = GroupPartition {
            groups: vec![Group {
                kind: GroupKind::Memory,
                members: (0..5_000).collect(),
                label: "memory [5000×1]".to_owned(),
                cell_type: "$mem".to_owned(),
            }],
            group_of: HashMap::new(),
        };
        let (bounded, bounded_truncated) = session
            .resolve_projection_roots(&[base], Some(&oversized))
            .expect("oversized synthetic root resolves within the raw-node cap");
        assert_eq!(bounded.len(), MAX_EXPANDED_GROUP_ROOTS);
        assert!(bounded_truncated);
    }
}
