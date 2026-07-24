use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use synth_explorer_analysis::analysis::{
    ConeDir, ConeOptions, FullNetlistOptions, GroupExpansionOptions, MAX_GROUP_EXPANSION_NODES,
    MAX_PATH_RESULTS, MAX_SUBGRAPH_NODES, PathSort, SourceSelectionOptions, TimingEstimate,
};
use synth_explorer_analysis::delay_model::{DelayModel, DelayProfile};
use synth_explorer_analysis::NetlistDialect;
use synth_explorer_analysis::design::AnalysisDesign;
use synth_explorer_analysis::grouping::{GroupPartition, GroupingProjection};
use synth_explorer_analysis::netlist::{YosysNetlist, select_top};
use synth_explorer_analysis::source::SourceSelectionRange;
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
    group_memories: Option<bool>,
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
    group_memories: Option<bool>,
}

#[derive(Deserialize)]
struct GroupExpansionQuery {
    node: u32,
    #[serde(default)]
    expanded_nodes: Vec<u32>,
    max_nodes: Option<usize>,
    hide_control: Option<bool>,
    hide_const: Option<bool>,
    group_vectors: Option<bool>,
    group_memories: Option<bool>,
}

fn validate_single_group_expansion(
    expanded_nodes: &[u32],
    base: u32,
    group_count: usize,
    group_id: u32,
) -> Result<(), &'static str> {
    for node in expanded_nodes {
        let id = node
            .checked_sub(base)
            .filter(|id| (*id as usize) < group_count)
            .ok_or("expanded node is not a grouped instance")?;
        if id != group_id {
            return Err("only one grouped instance can be expanded at a time");
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct SourceSelectionQuery {
    file: String,
    start_line: usize,
    end_line: usize,
    start_column: Option<usize>,
    end_column: Option<usize>,
    fallback_start_column: Option<usize>,
    fallback_end_column: Option<usize>,
    max_nodes: Option<usize>,
    hide_control: Option<bool>,
    hide_const: Option<bool>,
    group_vectors: Option<bool>,
    group_memories: Option<bool>,
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
        tool: &str,
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
            NetlistDialect::from_tool(tool),
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

    pub fn source_for_nodes_json(&self, ids_json: &str) -> Result<String, JsValue> {
        let ids: Vec<u32> = parse_json(ids_json, "node ids")?;
        // Synthetic group ids resolve to their member nodes, so a grouped
        // bus register attributes as the union of its bits.
        let (roots, roots_truncated) =
            self.resolve_projection_roots(&ids, Some(&self.design.grouping))?;
        let mut response = self.design.source_tiers_for_nodes(&roots);
        response.truncated |= roots_truncated;
        to_json(&response)
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
        let grouping = self.grouping(query.group_vectors, query.group_memories);
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
        let grouping = self.grouping(query.group_vectors, query.group_memories);
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

    pub fn expand_group_json(&self, query_json: &str) -> Result<String, JsValue> {
        let query: GroupExpansionQuery = parse_json(query_json, "group expansion query")?;
        let base = self.design.graph.nodes.len() as u32;
        let group_id = query
            .node
            .checked_sub(base)
            .filter(|id| self.design.grouping.groups.get(*id as usize).is_some())
            .ok_or_else(|| js_error("node is not a grouped instance"))?;
        validate_single_group_expansion(
            &query.expanded_nodes,
            base,
            self.design.grouping.groups.len(),
            group_id,
        )
        .map_err(js_error)?;
        let expanded_groups = [group_id];
        let grouping = GroupingProjection::from_flags_with_expanded(
            &self.design.grouping,
            query.group_vectors.unwrap_or(false),
            query.group_memories.unwrap_or(false),
            &expanded_groups,
        );
        let response = self
            .design
            .analysis
            .expand_group(
                &self.design.graph,
                &self.design.grouping,
                group_id,
                GroupExpansionOptions {
                    max_nodes: query.max_nodes.unwrap_or(MAX_GROUP_EXPANSION_NODES),
                    hide_control: query.hide_control.unwrap_or(true),
                    hide_const: query.hide_const.unwrap_or(true),
                },
                grouping,
            )
            .ok_or_else(|| js_error("unknown group"))?;
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

    pub fn source_ranges_for_bits_json(&self, bits_json: &str) -> Result<String, JsValue> {
        let bits: Vec<u32> = parse_json(bits_json, "source net bits")?;
        to_json(&self.design.analysis.source_ranges_for_bits(&bits))
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
            .source_selection_with_fallback(
                &self.design.graph,
                &self.design.grouping,
                SourceSelectionRange {
                    file: &query.file,
                    start_line: query.start_line,
                    end_line: query.end_line,
                    start_column: query.start_column,
                    end_column: query.end_column,
                },
                query.fallback_start_column.zip(query.fallback_end_column),
                SourceSelectionOptions {
                    max_nodes: query.max_nodes.unwrap_or(400),
                    hide_control: query.hide_control.unwrap_or(true),
                    hide_const: query.hide_const.unwrap_or(true),
                    group_vectors: query.group_vectors.unwrap_or(false),
                    group_memories: query.group_memories.unwrap_or(false),
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

    fn grouping(
        &self,
        vectors: Option<bool>,
        memories: Option<bool>,
    ) -> Option<GroupingProjection<'_>> {
        GroupingProjection::from_flags(
            &self.design.grouping,
            vectors.unwrap_or(false),
            memories.unwrap_or(false),
        )
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

        // Stratify across every canonical membership and distribute sample
        // positions round-robin, so neither low ids nor an earlier requested
        // group monopolizes the bounded expansion passed into core traversal.
        let sample_limits: Vec<usize> = requested_groups
            .iter()
            .map(|group| group.members.len().min(MAX_EXPANDED_GROUP_ROOTS))
            .collect();
        let mut sample_counts = vec![0usize; requested_groups.len()];
        let mut remaining = MAX_PROJECTION_ROOTS.saturating_sub(roots.len());
        while remaining > 0 {
            let mut advanced = false;
            for (index, &limit) in sample_limits.iter().enumerate() {
                if sample_counts[index] >= limit || remaining == 0 {
                    continue;
                }
                sample_counts[index] += 1;
                remaining -= 1;
                advanced = true;
            }
            if !advanced {
                break;
            }
        }
        let max_sample = sample_counts.iter().copied().max().unwrap_or(0);
        'samples: for sample_index in 0..max_sample {
            for (index, group) in requested_groups.iter().enumerate() {
                let target = sample_counts[index];
                if sample_index >= target {
                    continue;
                }
                let member_index = if target == 1 {
                    0
                } else {
                    sample_index * (group.members.len() - 1) / (target - 1)
                };
                let member = group.members[member_index];
                if !roots_seen.insert(member) {
                    continue;
                }
                if roots.len() >= MAX_PROJECTION_ROOTS {
                    roots_seen.remove(&member);
                    truncated = true;
                    break 'samples;
                }
                roots.push(member);
            }
        }
        truncated |= requested_groups
            .iter()
            .zip(sample_counts)
            .any(|(group, sampled)| group.members.len() > sampled);
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
            "yosys",
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

    fn assert_json_keys_in_order(raw: &str, keys: &[&str]) {
        let mut cursor = 0;
        for key in keys {
            let needle = format!(r#""{key}":"#);
            let offset = raw[cursor..]
                .find(&needle)
                .unwrap_or_else(|| panic!("missing JSON key {key} in {raw}"));
            cursor += offset + needle.len();
        }
    }

    fn json_digest(raw: &str) -> u64 {
        raw.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
    }

    #[test]
    fn provenance_json_preserves_casing_omission_and_deterministic_order() {
        let session = session("gates", "generic");
        let source_map_raw = session
            .source_map_json()
            .expect("source map query succeeds");
        assert_json_keys_in_order(
            &source_map_raw,
            &["files", "by_line", "ranges", "truncated"],
        );
        let source_map: serde_json::Value =
            serde_json::from_str(&source_map_raw).expect("source map JSON parses");
        assert_eq!(
            source_map["files"],
            serde_json::json!(["round_robin_arbiter.sv"])
        );
        let ranges = source_map["ranges"]
            .as_array()
            .expect("source ranges are an array");
        assert!(!ranges.is_empty());
        assert!(ranges.iter().all(|range| {
            range.get("file").is_some()
                && range.get("start_line").is_some()
                && range.get("end_line").is_some()
                && range.get("node_ids").is_some()
                && range.get("mapping_incomplete").is_some()
                && range.get("signal_bits").is_none()
                && range.get("approximate_signal_bits").is_none()
        }));
        let signal_range = ranges
            .iter()
            .find(|range| {
                range["signalBits"]
                    .as_array()
                    .is_some_and(|bits| !bits.is_empty())
            })
            .expect("fixture has an exact signal-bit range");
        let signal_bit = signal_range["signalBits"][0]
            .as_u64()
            .expect("signal bit is numeric");
        let locations = ranges
            .iter()
            .map(|range| {
                (
                    range["file"].as_str().expect("range file").to_owned(),
                    range["start_line"].as_u64().expect("range start line"),
                    range["end_line"].as_u64().expect("range end line"),
                    range.get("start_column").and_then(|value| value.as_u64()),
                    range.get("end_column").and_then(|value| value.as_u64()),
                )
            })
            .collect::<Vec<_>>();
        assert!(locations.windows(2).all(|pair| pair[0] <= pair[1]));

        let reverse_raw = session
            .source_ranges_for_bits_json(&serde_json::json!([signal_bit, signal_bit]).to_string())
            .expect("reverse source query succeeds");
        assert_json_keys_in_order(&reverse_raw, &["ranges", "truncated", "approximate"]);
        let reverse: serde_json::Value =
            serde_json::from_str(&reverse_raw).expect("reverse source JSON parses");
        let reverse_ranges = reverse["ranges"]
            .as_array()
            .expect("reverse ranges are an array");
        assert!(!reverse_ranges.is_empty());
        assert!(reverse_ranges.iter().all(|range| {
            range["node_ids"] == serde_json::json!([])
                && range.get("signalBits").is_none()
                && range.get("approximateSignalBits").is_none()
        }));

        let selection_raw = session
            .source_selection_json(
                &serde_json::json!({
                    "file": "round_robin_arbiter.sv",
                    "start_line": 15,
                    "end_line": 15,
                    "start_column": 30,
                    "end_column": 30,
                    "fallback_start_column": 1,
                    "fallback_end_column": 43
                })
                .to_string(),
            )
            .expect("source selection query succeeds");
        assert_json_keys_in_order(
            &selection_raw,
            &["status", "control", "directIds", "directBits", "graph"],
        );
        let selection: serde_json::Value =
            serde_json::from_str(&selection_raw).expect("source selection JSON parses");
        assert!(selection.get("directIds").is_some());
        assert!(selection.get("directBits").is_some());
        assert!(selection.get("direct_ids").is_none());
        assert!(selection.get("direct_bits").is_none());

        let nodes_raw = session
            .nodes_json("[0]")
            .expect("node source query succeeds");
        let nodes: serde_json::Value = serde_json::from_str(&nodes_raw).expect("node JSON parses");
        assert_eq!(nodes["nodes"].as_array().map(Vec::len), Some(1));
        assert!(nodes["nodes"][0].get("src").is_some());
        assert_eq!(nodes["nodes"][0]["port_direction"], "input");

        assert_eq!(
            [
                json_digest(&source_map_raw),
                json_digest(&reverse_raw),
                json_digest(&selection_raw),
                json_digest(&nodes_raw),
            ],
            [
                0x46a2_3292_4aa2_e2bd,
                0xfd05_2ab5_cbed_6e77,
                0x7cb9_f6a4_9b9c_718c,
                0x30f0_c349_fd9b_88b2,
            ],
            "update only after intentionally reviewing all provenance wire changes"
        );
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
        assert_eq!(bounded.first(), Some(&0));
        assert_eq!(bounded.last(), Some(&4_999));

        let group_count = 25u32;
        let members_per_group = 2_048u32;
        let many_groups = GroupPartition {
            groups: (0..group_count)
                .map(|group| Group {
                    kind: GroupKind::Memory,
                    members: (group * members_per_group..(group + 1) * members_per_group).collect(),
                    label: format!("memory{group} [2048×1]"),
                    cell_type: "$mem".to_owned(),
                })
                .collect(),
            group_of: HashMap::new(),
        };
        let requested: Vec<u32> = (0..group_count).map(|group| base + group).collect();
        let (fair, fair_truncated) = session
            .resolve_projection_roots(&requested, Some(&many_groups))
            .expect("many synthetic groups share the global root cap fairly");
        assert_eq!(fair.len(), MAX_PROJECTION_ROOTS);
        assert!(fair_truncated);
        for group in 0..group_count as usize {
            assert_eq!(fair[group], group as u32 * members_per_group);
            assert_eq!(
                fair[(MAX_PROJECTION_ROOTS / group_count as usize - 1) * group_count as usize
                    + group],
                (group as u32 + 1) * members_per_group - 1
            );
        }
    }

    #[test]
    fn group_expansion_json_owns_stable_boundary_trunk_provenance() {
        let session = session("gates", "series7");
        let base = session.design.graph.nodes.len() as u32;
        let group_id = session
            .design
            .grouping
            .groups
            .iter()
            .enumerate()
            .find(|(_, group)| {
                let members: BTreeSet<_> = group.members.iter().copied().collect();
                session
                    .design
                    .graph
                    .edges
                    .iter()
                    .any(|edge| members.contains(&edge.from) ^ members.contains(&edge.to))
            })
            .map(|(group_id, _)| group_id as u32)
            .expect("fixture has a group with boundary edges");
        let response = session
            .expand_group_json(
                &serde_json::json!({
                    "node": base + group_id,
                    "expanded_nodes": [base + group_id],
                    "group_vectors": true,
                    "group_memories": true
                })
                .to_string(),
            )
            .expect("group expansion succeeds");
        let json: serde_json::Value =
            serde_json::from_str(&response).expect("group expansion JSON parses");
        let trunks = json["boundary_trunks"]
            .as_array()
            .expect("boundary trunk provenance is an array");

        assert!(!trunks.is_empty());
        assert!(trunks.iter().all(|trunk| {
            trunk["compact_edge"].is_object()
                && trunk["expanded_edges"]
                    .as_array()
                    .is_some_and(|edges| !edges.is_empty())
        }));
        assert!(trunks.iter().all(|trunk| {
            let key = &trunk["compact_edge"];
            key.get("from").is_some()
                && key.get("to").is_some()
                && key.get("from_port").is_some()
                && key.get("to_port").is_some()
                && key.get("to_port_bit").is_none()
                && key.get("bit").is_none()
                && key.get("canonical_edges").is_none()
        }));
    }

    #[test]
    fn ordinary_graph_json_omits_group_expansion_provenance() {
        let session = session("gates", "series7");
        for query in [
            r#"{"max_nodes":400}"#,
            r#"{"max_nodes":400,"group_vectors":true,"group_memories":true}"#,
        ] {
            let response = session
                .netlist_json(query)
                .expect("ordinary netlist query succeeds");
            let json: serde_json::Value =
                serde_json::from_str(&response).expect("netlist JSON parses");

            assert!(json.get("boundary_trunks").is_none());
            assert!(
                json["edges"]
                    .as_array()
                    .expect("edges is an array")
                    .iter()
                    .all(|edge| edge.get("canonical_edges").is_none()
                        && edge.get("projected_edge_key").is_none())
            );
        }
    }

    #[test]
    fn group_expansion_rejects_a_second_open_group() {
        assert_eq!(validate_single_group_expansion(&[10], 10, 2, 0), Ok(()));
        assert_eq!(
            validate_single_group_expansion(&[10, 11], 10, 2, 0),
            Err("only one grouped instance can be expanded at a time")
        );
        assert_eq!(
            validate_single_group_expansion(&[12], 10, 2, 0),
            Err("expanded node is not a grouped instance")
        );
    }

    #[test]
    fn source_for_nodes_resolves_synthetic_group_ids_to_member_unions() {
        let session = session("gates", "generic");
        let base = session.design.graph.nodes.len() as u32;
        let group_index = session
            .design
            .grouping
            .groups
            .iter()
            .position(|group| !group.members.is_empty())
            .expect("fixture design produces at least one group");
        let members = session.design.grouping.groups[group_index].members.clone();

        let group_response = session
            .source_for_nodes_json(&serde_json::to_string(&[base + group_index as u32]).unwrap())
            .expect("group id resolves");
        let member_response = session
            .source_for_nodes_json(&serde_json::to_string(&members).unwrap())
            .expect("member ids resolve");
        // A synthetic group id attributes exactly as the union of its
        // members, and the wire shape keeps its snake_case contract.
        assert_eq!(group_response, member_response);
        let parsed: serde_json::Value = serde_json::from_str(&group_response).unwrap();
        for key in ["exact", "contributing", "approximate", "truncated"] {
            assert!(parsed.get(key).is_some(), "missing key {key}");
        }
        for span in parsed["exact"].as_array().unwrap() {
            assert!(span.get("start_line").is_some());
            assert!(span.get("file").is_some());
        }
    }
}
