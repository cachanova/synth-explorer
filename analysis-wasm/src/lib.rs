use serde::{Deserialize, Serialize};
use synth_explorer_analysis::analysis::{
    ConeDir, ConeOptions, FullNetlistOptions, MAX_PATH_RESULTS, PathSort, TimingEstimate,
};
use synth_explorer_analysis::delay_model::{DelayModel, DelayProfile};
use synth_explorer_analysis::design::AnalysisDesign;
use synth_explorer_analysis::grouping::GroupPartition;
use synth_explorer_analysis::netlist::{YosysNetlist, select_top};
use wasm_bindgen::prelude::*;

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

#[derive(Serialize)]
struct NodesResponse {
    nodes: Vec<synth_explorer_analysis::analysis::NodeRef>,
}

#[derive(Serialize)]
struct ExplorationResponse<'a> {
    design_id: &'a str,
    #[serde(flatten)]
    snapshot: synth_explorer_analysis::analysis::ExplorationSnapshot,
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
        to_json(&self.design.analysis.endpoints())
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
        let mut response = self.design.analysis.paths_with_model(
            &self.design.graph,
            &effective,
            query
                .limit
                .unwrap_or(MAX_PATH_RESULTS)
                .min(MAX_PATH_RESULTS),
            query.to,
            sort,
        );
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
        let roots = self.resolve_projection_roots(&query.nodes, grouping)?;
        let response = self
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
                },
                grouping,
            )
            .ok_or_else(|| js_error("unknown node"))?;
        to_json(&response)
    }

    pub fn netlist_json(&self, query_json: &str) -> Result<String, JsValue> {
        let query: NetlistQuery = parse_json(query_json, "netlist query")?;
        if query.around.len() > 200 {
            return Err(js_error("at most 200 context roots may be requested"));
        }
        let grouping = self.grouping(query.group_vectors);
        let roots = self.resolve_projection_roots(&query.around, grouping)?;
        let response = self.design.analysis.full_netlist(
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

    pub fn exploration_json(&self) -> Result<String, JsValue> {
        to_json(&ExplorationResponse {
            design_id: &self.design_id,
            snapshot: self.design.analysis.exploration_snapshot(
                &self.design.graph,
                &self.design.source_index,
                &self.design.grouping,
            ),
        })
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
    ) -> Result<Vec<u32>, JsValue> {
        let base = self.design.graph.nodes.len() as u32;
        let mut roots = Vec::new();
        for &id in requested {
            if id < base {
                roots.push(id);
                continue;
            }
            let group = grouping
                .and_then(|partition| {
                    id.checked_sub(base)
                        .and_then(|group_id| partition.groups.get(group_id as usize))
                })
                .ok_or_else(|| js_error("unknown node"))?;
            roots.extend(group.members.iter().copied());
        }
        Ok(roots)
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
