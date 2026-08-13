use super::depth::{compute_depths, fanout_of, is_depth_node, is_depth_output_edge};
use super::endpoints::EndpointTarget;
use super::{
    Analysis, ApiNodeKind, EndpointKind, EndpointsResponse, MAX_PATH_RESULTS, NodeRef, OutputAlias,
    OutputAliasBit, PATH_NODE_CAP, PATH_RECONSTRUCTION_NODE_BUDGET, PathClass, PathEntry, PathSort,
    PathsResponse,
};
use crate::delay_model::DelayModel;
use crate::graph::{Graph, NodeId, is_infrastructure_cell};
use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Copy)]
pub(super) struct PathComputation<'a> {
    pub(super) model: &'a DelayModel,
    pub(super) sort: PathSort,
    pub(super) node_delay: &'a [f64],
    pub(super) depth_path_delay: &'a [f64],
    pub(super) delay_pred: &'a [Option<usize>],
    pub(super) delay_startpoint: &'a [Option<NodeId>],
}

pub(super) struct PathSelection {
    pub(super) response: PathsResponse,
    pub(super) reconstructed_nodes: usize,
}

pub(super) type PathGroupKey = (String, EndpointKind, PathClass, u32, String, Vec<String>);
pub(super) type EndpointTargetGroupKey<'a> = (EndpointKind, &'a str, &'a str);
pub(super) type EndpointTargetGroup<'a> = (EndpointTargetGroupKey<'a>, Vec<&'a EndpointTarget>);
pub(super) fn path_node_signature(node: &NodeRef) -> String {
    match node.kind {
        ApiNodeKind::Cell => format!(
            "cell:{}:{}",
            node.cell_type.as_deref().unwrap_or("?"),
            node.seq == Some(true)
        ),
        ApiNodeKind::Port => "port".to_owned(),
        ApiNodeKind::Const => "const".to_owned(),
    }
}

pub(super) fn compare_target_rank(a: &EndpointTarget, b: &EndpointTarget) -> Ordering {
    Reverse(a.depth)
        .cmp(&Reverse(b.depth))
        .then_with(|| a.bit.cmp(&b.bit))
        .then_with(|| a.endpoint.cmp(&b.endpoint))
        .then_with(|| a.endpoint_port.cmp(&b.endpoint_port))
}

pub(super) fn compare_path_entries(a: &PathEntry, b: &PathEntry, sort: PathSort) -> Ordering {
    let tie_break = || compare_path_identity(a, b);
    match sort {
        PathSort::Depth => Reverse(a.depth).cmp(&Reverse(b.depth)).then_with(tie_break),
        PathSort::Delay => b
            .estimated_delay_ns
            .unwrap_or(f64::NEG_INFINITY)
            .total_cmp(&a.estimated_delay_ns.unwrap_or(f64::NEG_INFINITY))
            .then_with(|| Reverse(a.depth).cmp(&Reverse(b.depth)))
            .then_with(tie_break),
    }
}

pub(super) fn compare_path_membership(a: &PathEntry, b: &PathEntry) -> Ordering {
    Reverse(a.depth)
        .cmp(&Reverse(b.depth))
        .then_with(|| {
            b.estimated_delay_ns
                .unwrap_or(f64::NEG_INFINITY)
                .total_cmp(&a.estimated_delay_ns.unwrap_or(f64::NEG_INFINITY))
        })
        .then_with(|| compare_path_identity(a, b))
}

pub(super) fn compare_path_identity(a: &PathEntry, b: &PathEntry) -> Ordering {
    a.endpoint_group
        .cmp(&b.endpoint_group)
        .then_with(|| a.endpoint_kind.cmp(&b.endpoint_kind))
        .then_with(|| a.class.cmp(&b.class))
        .then_with(|| a.endpoint_port.cmp(&b.endpoint_port))
        .then_with(|| a.bits.cmp(&b.bits))
        .then_with(|| {
            a.nodes
                .iter()
                .map(|node| node.id)
                .cmp(b.nodes.iter().map(|node| node.id))
        })
}

pub(super) fn classify_path(startpoint: &NodeRef, endpoint_kind: EndpointKind) -> PathClass {
    let starts_at_register = startpoint.register == Some(true);
    let starts_at_input = startpoint.kind == ApiNodeKind::Port;
    match (starts_at_register, starts_at_input, endpoint_kind) {
        (true, _, EndpointKind::Register) => PathClass::RegisterToRegister,
        (_, true, EndpointKind::Register) => PathClass::InputToRegister,
        (true, _, EndpointKind::Output) => PathClass::RegisterToOutput,
        (_, true, EndpointKind::Output) => PathClass::InputToOutput,
        _ => PathClass::Other,
    }
}

pub(super) type RegisterAliasLookup<'a> =
    HashMap<(&'a str, usize), Vec<(&'a OutputAlias, &'a OutputAliasBit)>>;

pub(super) fn build_alias_lookup<'a>(
    endpoints: &'a EndpointsResponse,
    candidate_keys: &HashSet<(&str, usize)>,
) -> RegisterAliasLookup<'a> {
    let mut lookup: RegisterAliasLookup<'_> = HashMap::new();
    let mut candidate_bits_by_group: HashMap<&str, HashSet<usize>> = HashMap::new();
    for (group, bit) in candidate_keys {
        candidate_bits_by_group
            .entry(*group)
            .or_default()
            .insert(*bit);
    }
    for group in &endpoints.registers {
        let Some(candidate_bits) = candidate_bits_by_group.get(group.name.as_str()) else {
            continue;
        };
        for alias in &group.output_aliases {
            for bit in &alias.bits {
                if !candidate_bits.contains(&bit.register_bit) {
                    continue;
                }
                lookup
                    .entry((group.name.as_str(), bit.register_bit))
                    .or_default()
                    .push((alias, bit));
            }
        }
    }
    lookup
}

pub(super) fn aliases_for_register_bit(
    lookup: &RegisterAliasLookup<'_>,
    register_group: &str,
    register_bit: usize,
) -> Vec<OutputAlias> {
    let Some(entries) = lookup.get(&(register_group, register_bit)) else {
        return Vec::new();
    };
    let mut aliases: BTreeMap<(&str, usize), Vec<OutputAliasBit>> = BTreeMap::new();
    for (alias, bit) in entries {
        aliases
            .entry((alias.name.as_str(), alias.width))
            .or_default()
            .push((*bit).clone());
    }
    aliases
        .into_iter()
        .map(|((name, width), mut bits)| {
            bits.sort_by_key(|bit| (bit.register_bit, bit.output_bit));
            bits.dedup_by_key(|bit| (bit.register_bit, bit.output_bit));
            OutputAlias {
                name: name.to_owned(),
                width,
                bits,
            }
        })
        .collect()
}

pub(super) fn merge_output_aliases(existing: &mut Vec<OutputAlias>, incoming: Vec<OutputAlias>) {
    for alias in incoming {
        if let Some(current) = existing
            .iter_mut()
            .find(|current| current.name == alias.name)
        {
            current.bits.extend(alias.bits);
            current
                .bits
                .sort_by_key(|bit| (bit.register_bit, bit.output_bit));
            current
                .bits
                .dedup_by_key(|bit| (bit.register_bit, bit.output_bit));
        } else {
            existing.push(alias);
        }
    }
    existing.sort_by(|a, b| a.name.cmp(&b.name));
}

impl Analysis {
    /// Structural route variants selected by both depth and delay, with
    /// `sort` affecting presentation order only. The union stays bounded by
    /// `limit` and reports truncation when either selection or the union is
    /// clipped.
    pub fn path_variants_with_model(
        &self,
        graph: &Graph,
        model: &DelayModel,
        limit: usize,
        to: Option<NodeId>,
        sort: PathSort,
    ) -> PathsResponse {
        self.path_variants_with_model_and_work(graph, model, limit, to, sort)
            .0
    }

    pub(super) fn path_variants_with_model_and_work(
        &self,
        graph: &Graph,
        model: &DelayModel,
        limit: usize,
        to: Option<NodeId>,
        sort: PathSort,
    ) -> (PathsResponse, usize) {
        let recomputed;
        let (node_delay, depth_path_delay, delay_pred, delay_startpoint) =
            if *model == self.delay_model {
                (
                    &self.node_delay,
                    &self.depth_path_delay,
                    &self.delay_pred,
                    &self.delay_startpoint,
                )
            } else {
                recomputed = compute_depths(graph, &self.comb_loop_set, model);
                (
                    &recomputed.node_delay,
                    &recomputed.depth_path_delay,
                    &recomputed.delay_pred,
                    &recomputed.delay_startpoint,
                )
            };
        let depth_computation = PathComputation {
            model,
            sort: PathSort::Depth,
            node_delay,
            depth_path_delay,
            delay_pred,
            delay_startpoint,
        };
        let delay_computation = PathComputation {
            sort: PathSort::Delay,
            ..depth_computation
        };
        let depth_budget = PATH_RECONSTRUCTION_NODE_BUDGET / 2;
        let delay_budget = PATH_RECONSTRUCTION_NODE_BUDGET - depth_budget;
        let depth_selection =
            self.paths_with_computation(graph, limit, to, &depth_computation, depth_budget);
        let delay_selection =
            self.paths_with_computation(graph, limit, to, &delay_computation, delay_budget);
        let reconstructed_nodes =
            depth_selection.reconstructed_nodes + delay_selection.reconstructed_nodes;
        debug_assert!(reconstructed_nodes <= PATH_RECONSTRUCTION_NODE_BUDGET);
        let depth = depth_selection.response;
        let delay = delay_selection.response;
        debug_assert_eq!(depth.comb_loops, delay.comb_loops);
        let mut truncated = depth.truncated || delay.truncated;
        let comb_loops = depth.comb_loops;
        let mut grouped: BTreeMap<_, PathEntry> = BTreeMap::new();

        for path in depth.paths.into_iter().chain(delay.paths) {
            let signature = path.nodes.iter().map(|node| node.id).collect::<Vec<_>>();
            let key = (
                path.endpoint_group.clone(),
                path.endpoint_kind,
                path.class,
                path.depth,
                path.endpoint_port.clone(),
                signature,
            );
            if let Some(existing) = grouped.get_mut(&key) {
                existing.bits.extend(path.bits);
                existing.bits.sort_unstable();
                existing.bits.dedup();
                merge_output_aliases(&mut existing.output_aliases, path.output_aliases);
            } else {
                grouped.insert(key, path);
            }
        }

        let mut paths: Vec<PathEntry> = grouped.into_values().collect();
        paths.sort_by(compare_path_membership);
        if paths.len() > limit {
            paths.truncate(limit);
            truncated = true;
        }
        paths.sort_by(|a, b| compare_path_entries(a, b, sort));
        (
            PathsResponse {
                paths,
                comb_loops,
                truncated,
            },
            reconstructed_nodes,
        )
    }

    /// Return structural paths delay-costed with a caller-supplied model (e.g. a
    /// client's retune), so per-path delays track the overview.
    pub fn paths_with_model(
        &self,
        graph: &Graph,
        model: &DelayModel,
        limit: usize,
        to: Option<NodeId>,
        sort: PathSort,
    ) -> PathsResponse {
        // Path structure (targets, routes) is model-independent; only the delay
        // numbers depend on the model. Reuse the synth-time arrivals when the
        // caller's model matches, else recompute the delay DP for it.
        let recomputed;
        let computation = if *model == self.delay_model {
            PathComputation {
                model,
                sort,
                node_delay: &self.node_delay,
                depth_path_delay: &self.depth_path_delay,
                delay_pred: &self.delay_pred,
                delay_startpoint: &self.delay_startpoint,
            }
        } else {
            recomputed = compute_depths(graph, &self.comb_loop_set, model);
            PathComputation {
                model,
                sort,
                node_delay: &recomputed.node_delay,
                depth_path_delay: &recomputed.depth_path_delay,
                delay_pred: &recomputed.delay_pred,
                delay_startpoint: &recomputed.delay_startpoint,
            }
        };
        self.paths_with_computation(
            graph,
            limit,
            to,
            &computation,
            PATH_RECONSTRUCTION_NODE_BUDGET,
        )
        .response
    }

    fn paths_with_computation(
        &self,
        graph: &Graph,
        limit: usize,
        to: Option<NodeId>,
        computation: &PathComputation<'_>,
        reconstruction_node_budget: usize,
    ) -> PathSelection {
        let sort = computation.sort;
        let target_delay = |target: &EndpointTarget| {
            self.path_delay_ns(graph, target, computation.node_delay, computation.model)
                .unwrap_or(f64::NEG_INFINITY)
        };
        let compare_rank = |a: &EndpointTarget, b: &EndpointTarget| match sort {
            PathSort::Depth => compare_target_rank(a, b),
            PathSort::Delay => target_delay(b)
                .total_cmp(&target_delay(a))
                .then_with(|| compare_target_rank(a, b)),
        };
        const TARGETS_PER_GROUP_CAP: usize = 64;
        let candidate_cap = limit.max(1).saturating_mul(16).min(MAX_PATH_RESULTS);
        let mut total_targets = 0;
        let mut grouped_targets: HashMap<EndpointTargetGroupKey<'_>, Vec<&EndpointTarget>> =
            HashMap::new();
        for target in self
            .endpoint_targets
            .iter()
            .filter(|target| to.is_none_or(|id| target.endpoint == id))
        {
            total_targets += 1;
            let group = grouped_targets
                .entry((
                    target.kind,
                    target.group.as_str(),
                    target.endpoint_port.as_str(),
                ))
                .or_default();
            if group.len() < TARGETS_PER_GROUP_CAP {
                group.push(target);
                continue;
            }
            let worst = group
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| compare_rank(a, b))
                .map(|(index, _)| index)
                .expect("a capped target group is not empty");
            if compare_rank(target, group[worst]) == Ordering::Less {
                group[worst] = target;
            }
        }

        let mut target_groups: Vec<EndpointTargetGroup<'_>> = grouped_targets.into_iter().collect();
        for (_, targets) in &mut target_groups {
            targets.sort_by(|a, b| compare_rank(a, b));
        }
        target_groups.sort_by(|(a_key, a), (b_key, b)| {
            compare_rank(a[0], b[0]).then_with(|| a_key.cmp(b_key))
        });

        // Give every top-ranked logical endpoint a representative before spending
        // the bounded budget on additional bit/route variants. Extra targets
        // are selected round-robin so a single wide vector cannot crowd out
        // other groups.
        let represented_groups = target_groups.len().min(candidate_cap);
        let mut candidates = Vec::with_capacity(candidate_cap);
        for (_, targets) in target_groups.iter().take(represented_groups) {
            candidates.push(targets[0]);
        }
        let mut bit_index = 1;
        while candidates.len() < candidate_cap {
            let mut added = false;
            for (_, targets) in target_groups.iter().take(represented_groups) {
                let Some(target) = targets.get(bit_index) else {
                    continue;
                };
                candidates.push(*target);
                added = true;
                if candidates.len() == candidate_cap {
                    break;
                }
            }
            if !added {
                break;
            }
            bit_index += 1;
        }

        let candidate_alias_keys: HashSet<(&str, usize)> = candidates
            .iter()
            .filter(|target| target.kind == EndpointKind::Register)
            .map(|target| (target.group.as_str(), target.bit))
            .collect();
        let alias_lookup = build_alias_lookup(&self.endpoints, &candidate_alias_keys);
        let mut grouped: BTreeMap<PathGroupKey, PathEntry> = BTreeMap::new();
        let mut route_clipped = false;
        let mut reconstruction_budget = reconstruction_node_budget;
        let mut reconstructed_candidates = 0;
        for target in &candidates {
            if reconstruction_budget < 2 {
                route_clipped = true;
                break;
            }
            let per_path_cap = PATH_NODE_CAP.min(reconstruction_budget);
            let (path, clipped, consumed_nodes) =
                self.path_for_target(graph, target, per_path_cap, &alias_lookup, computation);
            reconstruction_budget = reconstruction_budget.saturating_sub(consumed_nodes);
            reconstructed_candidates += 1;
            route_clipped |= clipped;
            let signature = path
                .nodes
                .iter()
                .map(path_node_signature)
                .collect::<Vec<_>>();
            let key = (
                path.endpoint_group.clone(),
                path.endpoint_kind,
                path.class,
                path.depth,
                path.endpoint_port.clone(),
                signature,
            );
            if let Some(existing) = grouped.get_mut(&key) {
                existing.bits.extend(path.bits);
                existing.bits.sort_unstable();
                existing.bits.dedup();
                merge_output_aliases(&mut existing.output_aliases, path.output_aliases);
            } else {
                grouped.insert(key, path);
            }
        }
        let mut paths: Vec<PathEntry> = grouped.into_values().collect();
        paths.sort_by(|a, b| compare_path_entries(a, b, sort));
        let grouped_count = paths.len();
        paths.truncate(limit);
        PathSelection {
            response: PathsResponse {
                paths,
                comb_loops: self
                    .comb_loops
                    .iter()
                    .map(|id| graph.node_ref_name(*id))
                    .collect(),
                truncated: self.endpoint_targets_truncated
                    || route_clipped
                    || reconstructed_candidates < candidates.len()
                    || candidates.len() < total_targets
                    || grouped_count > limit,
            },
            reconstructed_nodes: reconstruction_node_budget - reconstruction_budget,
        }
    }
    fn path_for_target(
        &self,
        graph: &Graph,
        target: &EndpointTarget,
        node_cap: usize,
        alias_lookup: &RegisterAliasLookup<'_>,
        computation: &PathComputation<'_>,
    ) -> (PathEntry, bool, usize) {
        debug_assert!(node_cap >= 2);
        let mut node_ids = vec![target.endpoint];
        let mut clipped = false;
        if let Some(edge_idx) = target.edge {
            let mut downstream_edge = edge_idx;
            let mut current = graph.edges[edge_idx].from;
            loop {
                if node_ids.len() >= node_cap {
                    clipped = true;
                    break;
                }
                node_ids.push(current);
                if !is_depth_node(graph, current)
                    || !is_depth_output_edge(graph, &graph.edges[downstream_edge])
                {
                    break;
                }
                let pred = match computation.sort {
                    PathSort::Depth => &self.best_pred,
                    PathSort::Delay => computation.delay_pred,
                };
                let Some(pred_edge) = pred[current as usize] else {
                    break;
                };
                downstream_edge = pred_edge;
                current = graph.edges[pred_edge].from;
            }
        }
        let consumed_nodes = node_ids.len();
        let expected_startpoint = match computation.sort {
            PathSort::Depth => target.startpoint,
            PathSort::Delay => target
                .edge
                .and_then(|edge| computation.delay_startpoint[graph.edges[edge].from as usize])
                .unwrap_or(target.startpoint),
        };
        if clipped && node_ids.last().copied() != Some(expected_startpoint) {
            *node_ids
                .last_mut()
                .expect("an endpoint path always contains its endpoint") = expected_startpoint;
        }
        node_ids.reverse();
        let actual_startpoint = node_ids.first().copied().unwrap_or(expected_startpoint);
        let nodes: Vec<NodeRef> = node_ids
            .iter()
            .filter(|id| {
                **id == actual_startpoint
                    || **id == target.endpoint
                    || graph.nodes[**id as usize]
                        .cell_type
                        .as_deref()
                        .is_none_or(|cell_type| !is_infrastructure_cell(cell_type))
            })
            .map(|id| self.node_ref(graph, *id))
            .collect();
        let startpoint = self.node_ref(graph, actual_startpoint);
        let endpoint = self.node_ref(graph, target.endpoint);
        let class = classify_path(&startpoint, target.kind);
        let output_aliases = if target.kind == EndpointKind::Register {
            aliases_for_register_bit(alias_lookup, &target.group, target.bit)
        } else {
            Vec::new()
        };
        let route_delay = match computation.sort {
            PathSort::Depth => computation.depth_path_delay,
            PathSort::Delay => computation.node_delay,
        };
        let estimated_delay_ns = self.path_delay_ns(graph, target, route_delay, computation.model);
        (
            PathEntry {
                depth: target.depth,
                class,
                endpoint_group: target.group.clone(),
                endpoint_kind: target.kind,
                bits: vec![target.bit],
                output_aliases,
                startpoint,
                endpoint,
                endpoint_port: target.endpoint_port.clone(),
                nodes,
                estimated_delay_ns,
            },
            clipped,
            consumed_nodes,
        )
    }

    /// Estimated delay (ns) for a single endpoint's critical path, using the
    /// same accounting as the overview estimate: arrival at the last driver's
    /// output, plus that net, plus setup for register endpoints. Taken over all
    /// endpoints, the max matches the overview figure.
    fn path_delay_ns(
        &self,
        graph: &Graph,
        target: &EndpointTarget,
        node_delay: &[f64],
        model: &DelayModel,
    ) -> Option<f64> {
        let arrival_ps = match target.edge {
            Some(edge_idx) => {
                let from = graph.edges[edge_idx].from;
                // A comb driver contributes its computed arrival; a register/input
                // driver launches the path (clk-to-Q / zero), mirroring the DP.
                let base = if is_depth_node(graph, from) {
                    *node_delay.get(from as usize)?
                } else {
                    model.launch_ps(graph.nodes.get(from as usize)?.seq)
                };
                base + model.net_delay_ps(fanout_of(graph, from))
            }
            None => {
                let start = graph.nodes.get(target.startpoint as usize)?;
                model.launch_ps(start.seq) + model.net_delay_ps(fanout_of(graph, target.startpoint))
            }
        };
        let setup = if target.kind == EndpointKind::Register {
            model.ff_setup_ps
        } else {
            0.0
        };
        Some((arrival_ps + setup) / 1000.0)
    }
}
