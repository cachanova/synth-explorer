use crate::analysis::{
    Analysis, ConeDir, ConeOptions, EndpointsResponse, FanoutResponse, NodeRef, PathsResponse,
    SourceLineIndex, SourceMapResponse, Stats, Subgraph,
};
use crate::graph::Graph;
use crate::netlist::{parse_value, select_top};
use crate::source_provenance::{SourceAliasProvenance, continuous_assign_provenance};
use crate::yosys::{SourceFile, SynthMode, SynthRequest, YosysError, run_yosys};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::mem::size_of;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{RwLock, Semaphore, watch};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

const DESIGN_CACHE_BUDGET_BYTES: usize = 256 * 1024 * 1024;
const DESIGN_CACHE_NETLIST_MULTIPLIER: usize = 2;
const YOSYS_CONCURRENCY_LIMIT: usize = 2;

#[derive(Clone)]
pub struct AppState {
    cache: Arc<RwLock<DesignCache>>,
    flights: Arc<SynthesisFlights>,
    yosys_slots: Arc<Semaphore>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::with_limits(DESIGN_CACHE_BUDGET_BYTES, YOSYS_CONCURRENCY_LIMIT)
    }
}

impl AppState {
    fn with_limits(cache_budget_bytes: usize, yosys_concurrency: usize) -> Self {
        assert!(yosys_concurrency > 0, "yosys concurrency must be positive");
        Self {
            cache: Arc::new(RwLock::new(DesignCache::new(cache_budget_bytes))),
            flights: Arc::new(SynthesisFlights::new()),
            yosys_slots: Arc::new(Semaphore::new(yosys_concurrency)),
        }
    }
}

#[derive(Debug)]
struct CacheEntry<T> {
    value: Arc<T>,
    weight_bytes: usize,
}

#[derive(Debug)]
struct WeightedCache<T> {
    entries: HashMap<String, CacheEntry<T>>,
    order: VecDeque<String>,
    weight_bytes: usize,
    budget_bytes: usize,
}

type DesignCache = WeightedCache<Design>;

impl<T> WeightedCache<T> {
    fn new(budget_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            weight_bytes: 0,
            budget_bytes,
        }
    }

    fn get(&self, id: &str) -> Option<Arc<T>> {
        self.entries.get(id).map(|entry| Arc::clone(&entry.value))
    }

    fn insert(&mut self, id: String, value: Arc<T>, weight_bytes: usize) -> bool {
        if weight_bytes > self.budget_bytes {
            return false;
        }

        if let Some(existing) = self.entries.remove(&id) {
            self.weight_bytes = self.weight_bytes.saturating_sub(existing.weight_bytes);
            self.order.retain(|entry_id| entry_id != &id);
        }
        while self.weight_bytes.saturating_add(weight_bytes) > self.budget_bytes {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(evicted) = self.entries.remove(&oldest) {
                self.weight_bytes = self.weight_bytes.saturating_sub(evicted.weight_bytes);
            }
        }

        self.weight_bytes = self.weight_bytes.saturating_add(weight_bytes);
        self.order.push_back(id.clone());
        self.entries.insert(
            id,
            CacheEntry {
                value,
                weight_bytes,
            },
        );
        true
    }
}

async fn cache_lookup<T>(cache: &RwLock<WeightedCache<T>>, id: &str) -> Option<Arc<T>> {
    cache.read().await.get(id)
}

type FlightResult = Result<Arc<Design>, ApiError>;

#[derive(Debug)]
struct SynthesisFlight {
    result: watch::Sender<Option<FlightResult>>,
}

#[derive(Debug)]
struct SynthesisFlights {
    entries: StdMutex<HashMap<String, Arc<SynthesisFlight>>>,
}

impl SynthesisFlights {
    fn new() -> Self {
        Self {
            entries: StdMutex::new(HashMap::new()),
        }
    }

    fn claim(self: &Arc<Self>, design_id: &str) -> FlightClaim {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(flight) = entries.get(design_id) {
            return FlightClaim::Follower(flight.result.subscribe());
        }

        let (result, _initial_receiver) = watch::channel(None);
        let flight = Arc::new(SynthesisFlight { result });
        entries.insert(design_id.to_owned(), Arc::clone(&flight));
        FlightClaim::Leader(FlightLeader {
            registry: Arc::clone(self),
            design_id: design_id.to_owned(),
            flight,
            completed: false,
        })
    }

    fn remove(&self, design_id: &str, flight: &Arc<SynthesisFlight>) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if entries
            .get(design_id)
            .is_some_and(|current| Arc::ptr_eq(current, flight))
        {
            entries.remove(design_id);
        }
    }
}

enum FlightClaim {
    Leader(FlightLeader),
    Follower(watch::Receiver<Option<FlightResult>>),
}

struct FlightLeader {
    registry: Arc<SynthesisFlights>,
    design_id: String,
    flight: Arc<SynthesisFlight>,
    completed: bool,
}

impl FlightLeader {
    fn complete(mut self, result: FlightResult) -> FlightResult {
        self.flight.result.send_replace(Some(result.clone()));
        self.registry.remove(&self.design_id, &self.flight);
        self.completed = true;
        result
    }
}

impl Drop for FlightLeader {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        self.flight.result.send_replace(Some(Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "synthesis request was cancelled",
        ))));
        self.registry.remove(&self.design_id, &self.flight);
    }
}

#[derive(Debug)]
struct Design {
    response: SynthesizeResponse,
    graph: Graph,
    analysis: Analysis,
    source_index: SourceLineIndex,
}

#[derive(Debug, Clone, Serialize)]
pub struct SynthesizeResponse {
    pub design_id: String,
    pub top: String,
    pub mode: String,
    pub stats: Stats,
    pub warnings: Vec<String>,
    pub log: String,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    log: Option<String>,
}

#[derive(Debug, Clone)]
struct ApiError {
    status: StatusCode,
    message: String,
    log: Option<String>,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            log: None,
        }
    }

    fn with_log(status: StatusCode, message: impl Into<String>, log: String) -> Self {
        Self {
            status,
            message: message.into(),
            log: Some(log),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: self.message,
                log: self.log,
            }),
        )
            .into_response()
    }
}

pub fn app(state: AppState) -> Router {
    let api = Router::new()
        .route("/synthesize", post(synthesize))
        .route("/examples", get(examples))
        .route("/design/{id}", get(design))
        .route("/design/{id}/endpoints", get(endpoints))
        .route("/design/{id}/paths", get(paths))
        .route("/design/{id}/cone", get(cone))
        .route("/design/{id}/line-cone", get(line_cone))
        .route("/design/{id}/fanout", get(fanout))
        .route("/design/{id}/netlist", get(netlist))
        .route("/design/{id}/source-map", get(source_map))
        .route("/design/{id}/nodes", get(nodes))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
        .with_state(state);

    let static_dir = env::var("STATIC_DIR").unwrap_or_else(|_| "../web/dist".to_owned());
    let index = PathBuf::from(&static_dir).join("index.html");
    let static_service = ServeDir::new(static_dir).not_found_service(ServeFile::new(index));
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list([
            HeaderValue::from_static("http://localhost:5173"),
            HeaderValue::from_static("http://127.0.0.1:5173"),
        ]))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers(Any);

    Router::new()
        .nest("/api", api)
        .fallback_service(static_service)
        .layer(cors)
}

async fn synthesize(
    State(state): State<AppState>,
    Json(request): Json<SynthRequest>,
) -> Result<Json<SynthesizeResponse>, ApiError> {
    let validated = request.validate().map_err(map_yosys_error)?;
    let design_id = validated.design_id();
    if let Some(design) = cache_lookup(&state.cache, &design_id).await {
        return Ok(Json(design.response.clone()));
    }

    let result = match state.flights.claim(&design_id) {
        FlightClaim::Follower(receiver) => wait_for_flight(receiver).await,
        FlightClaim::Leader(leader) => {
            // A previous flight may have filled the cache after the optimistic
            // lookup but before this request claimed the per-design key.
            let result = if let Some(design) = cache_lookup(&state.cache, &design_id).await {
                Ok(design)
            } else {
                synthesize_uncached(&state, &validated, &design_id).await
            };
            leader.complete(result)
        }
    };
    let design = result?;
    Ok(Json(design.response.clone()))
}

async fn wait_for_flight(mut receiver: watch::Receiver<Option<FlightResult>>) -> FlightResult {
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return result;
        }
        if receiver.changed().await.is_err() {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "synthesis request ended without a result",
            ));
        }
    }
}

async fn synthesize_uncached(
    state: &AppState,
    validated: &crate::yosys::ValidatedSynth,
    design_id: &str,
) -> FlightResult {
    // Keep the resource permit until the parsed graph is safely cached. Large
    // JSON values and their derived indexes otherwise overlap with additional
    // Yosys processes and defeat the intended temporary-memory bound.
    let _permit = Arc::clone(&state.yosys_slots)
        .acquire_owned()
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "synthesis capacity is unavailable",
            )
        })?;
    let output = run_yosys(validated).await.map_err(map_yosys_error)?;
    let json_bytes = output.json_bytes;
    let source_json_bytes = output.source_json_bytes;
    let parsed = parse_value(output.json).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to parse yosys netlist: {err}"),
        )
    })?;
    let source_parsed = parse_value(output.source_json).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to parse source-provenance netlist: {err}"),
        )
    })?;
    let (top, module) = select_top(&parsed, None).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to resolve top module: {err}"),
        )
    })?;
    let graph = Graph::from_netlist(&parsed, top, module).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to build analysis graph: {err}"),
        )
    })?;
    let (_, source_module) = select_top(&source_parsed, None).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to resolve source-provenance top module: {err}"),
        )
    })?;
    let SourceAliasProvenance {
        roots_by_line,
        synthesizable_lines,
    } = continuous_assign_provenance(
        &graph,
        source_module,
        validated
            .files
            .iter()
            .map(|file| (file.name.clone(), file.content.clone())),
    );
    let mut analysis = Analysis::new(&graph, validated.file_names());
    analysis.extend_source_roots(roots_by_line);
    let mut source_index = SourceLineIndex::from_module(source_module, validated.file_names());
    source_index.extend_lines(synthesizable_lines);
    let response = SynthesizeResponse {
        design_id: design_id.to_owned(),
        top: output.resolved_top,
        mode: mode_string(validated.mode),
        stats: analysis.stats(),
        warnings: analysis.warnings(),
        log: output.log,
    };
    let cache_weight_bytes = design_cache_weight(
        design_id,
        json_bytes,
        source_json_bytes,
        validated,
        &response,
    );
    let design = Arc::new(Design {
        response: response.clone(),
        graph,
        analysis,
        source_index,
    });
    let cached = state.cache.write().await.insert(
        design_id.to_owned(),
        Arc::clone(&design),
        cache_weight_bytes,
    );
    if !cached {
        return Err(ApiError::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "synthesized design exceeds the server cache budget",
        ));
    }
    Ok(design)
}

fn design_cache_weight(
    design_id: &str,
    json_bytes: usize,
    source_json_bytes: usize,
    validated: &crate::yosys::ValidatedSynth,
    response: &SynthesizeResponse,
) -> usize {
    // The graph, analysis indexes, and source index are all derived from these
    // two serialized netlists. Their exact allocator footprint is not portable,
    // so this is a conservative accounting estimate rather than an allocator
    // measurement: charge twice the exact JSON byte counts, then add data
    // retained independently by the response and cache keys.
    let file_name_bytes = validated
        .files
        .iter()
        .map(|file| file.name.len())
        .sum::<usize>()
        .saturating_mul(2);
    let warning_bytes = response
        .warnings
        .iter()
        .map(String::len)
        .sum::<usize>()
        .saturating_mul(2);
    let stats_key_bytes = response
        .stats
        .cells_by_type
        .keys()
        .map(String::len)
        .sum::<usize>()
        .saturating_mul(2);
    json_bytes
        .saturating_add(source_json_bytes)
        .saturating_mul(DESIGN_CACHE_NETLIST_MULTIPLIER)
        .saturating_add(response.log.len())
        .saturating_add(response.top.len())
        .saturating_add(response.mode.len())
        .saturating_add(warning_bytes)
        .saturating_add(stats_key_bytes)
        .saturating_add(design_id.len().saturating_mul(3))
        .saturating_add(file_name_bytes)
        .saturating_add(size_of::<Design>())
        .saturating_add(size_of::<CacheEntry<Design>>())
        .saturating_add(size_of::<SynthesizeResponse>())
        .saturating_add(size_of::<Stats>().saturating_mul(2))
        .max(1)
}

async fn design(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SynthesizeResponse>, ApiError> {
    Ok(Json(get_design(&state, &id).await?.response.clone()))
}

async fn endpoints(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<EndpointsResponse>, ApiError> {
    let design = get_design(&state, &id).await?;
    Ok(Json(design.analysis.endpoints()))
}

#[derive(Debug, Deserialize)]
struct PathsQuery {
    limit: Option<usize>,
    to: Option<u32>,
}

async fn paths(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PathsQuery>,
) -> Result<Json<PathsResponse>, ApiError> {
    let design = get_design(&state, &id).await?;
    let limit = query.limit.unwrap_or(25).min(500);
    Ok(Json(design.analysis.paths(&design.graph, limit, query.to)))
}

#[derive(Debug, Deserialize)]
struct ConeQuery {
    node: Option<u32>,
    dir: Option<String>,
    max_depth: Option<u32>,
    max_nodes: Option<usize>,
    hide_control: Option<bool>,
    hide_const: Option<bool>,
    show_infrastructure: Option<bool>,
}

async fn cone(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ConeQuery>,
) -> Result<Json<Subgraph>, ApiError> {
    let design = get_design(&state, &id).await?;
    let dir = query
        .dir
        .as_deref()
        .map(ConeDir::parse)
        .unwrap_or(Some(ConeDir::Fanin))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "dir must be fanin or fanout",
            )
        })?;
    let node = query
        .node
        .ok_or_else(|| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "node is required"))?;
    let subgraph = design
        .analysis
        .cone(
            &design.graph,
            node,
            ConeOptions {
                dir,
                max_depth: query.max_depth.unwrap_or(64),
                max_nodes: query.max_nodes.unwrap_or(300),
                hide_control: query.hide_control.unwrap_or(true),
                hide_const: query.hide_const.unwrap_or(true),
                show_infrastructure: query.show_infrastructure.unwrap_or(false),
            },
        )
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "unknown node"))?;
    Ok(Json(subgraph))
}

#[derive(Debug, Deserialize)]
struct LineConeQuery {
    file: Option<String>,
    start_line: Option<isize>,
    end_line: Option<isize>,
    max_nodes: Option<usize>,
    hide_control: Option<bool>,
    hide_const: Option<bool>,
    show_infrastructure: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum SourceEnvelopeStatus {
    Mapped,
    OptimizedOrAbsorbed,
    Unmapped,
}

#[derive(Debug, Serialize)]
struct LineConeResponse {
    status: SourceEnvelopeStatus,
    control: bool,
    graph: Subgraph,
}

async fn line_cone(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<LineConeQuery>,
) -> Result<Json<LineConeResponse>, ApiError> {
    let design = get_design(&state, &id).await?;
    let file = query
        .file
        .ok_or_else(|| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "file is required"))?;
    let start_line = query
        .start_line
        .ok_or_else(|| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "start_line is required"))?;
    let end_line = query.end_line.unwrap_or(start_line);
    if start_line < 1 || end_line < start_line {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "line range must satisfy 1 <= start_line <= end_line",
        ));
    }
    if end_line - start_line >= 200 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "at most 200 source lines may be selected",
        ));
    }
    let roots = design
        .analysis
        .source_nodes_range(&file, start_line as usize, end_line as usize)
        .ok_or_else(|| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "unknown file"))?;
    let control = roots.iter().any(|root| {
        design.graph.outgoing[*root as usize]
            .iter()
            .any(|edge_idx| design.graph.edges[*edge_idx].control)
    });
    let hide_control = query.hide_control.unwrap_or(true) && !control;
    let subgraph = design
        .analysis
        .envelope(
            &design.graph,
            &roots,
            ConeOptions {
                dir: ConeDir::Fanin,
                max_depth: 64,
                max_nodes: query.max_nodes.unwrap_or(400),
                hide_control,
                hide_const: query.hide_const.unwrap_or(true),
                show_infrastructure: query.show_infrastructure.unwrap_or(false),
            },
        )
        .expect("source map contains only valid graph node ids");
    let status = if !roots.is_empty() {
        SourceEnvelopeStatus::Mapped
    } else if design
        .source_index
        .contains_range(&file, start_line as usize, end_line as usize)
        .expect("final and provenance indexes contain the same source files")
    {
        SourceEnvelopeStatus::OptimizedOrAbsorbed
    } else {
        SourceEnvelopeStatus::Unmapped
    };
    Ok(Json(LineConeResponse {
        status,
        control,
        graph: subgraph,
    }))
}

#[derive(Debug, Deserialize)]
struct FanoutQuery {
    limit: Option<usize>,
}

async fn fanout(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<FanoutQuery>,
) -> Result<Json<FanoutResponse>, ApiError> {
    let design = get_design(&state, &id).await?;
    Ok(Json(
        design
            .analysis
            .fanout(&design.graph, query.limit.unwrap_or(50).min(500)),
    ))
}

#[derive(Debug, Deserialize)]
struct NetlistQuery {
    max_nodes: Option<usize>,
    show_infrastructure: Option<bool>,
}

async fn netlist(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<NetlistQuery>,
) -> Result<Json<Subgraph>, ApiError> {
    let design = get_design(&state, &id).await?;
    Ok(Json(design.analysis.full_netlist(
        &design.graph,
        query.max_nodes.unwrap_or(1500),
        query.show_infrastructure.unwrap_or(false),
    )))
}

async fn source_map(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SourceMapResponse>, ApiError> {
    let design = get_design(&state, &id).await?;
    Ok(Json(design.analysis.source_map()))
}

#[derive(Debug, Deserialize)]
struct NodesQuery {
    ids: Option<String>,
}

#[derive(Debug, Serialize)]
struct NodesResponse {
    nodes: Vec<NodeRef>,
}

async fn nodes(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<NodesQuery>,
) -> Result<Json<NodesResponse>, ApiError> {
    let design = get_design(&state, &id).await?;
    let ids = query
        .ids
        .ok_or_else(|| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "ids is required"))?;
    let ids = parse_node_ids(&ids)?;
    if ids.len() > 200 {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "at most 200 ids may be requested",
        ));
    }
    let nodes = ids
        .into_iter()
        .filter(|id| design.graph.nodes.get(*id as usize).is_some())
        .map(|id| design.analysis.node_ref(&design.graph, id))
        .collect();
    Ok(Json(NodesResponse { nodes }))
}

#[derive(Debug, Serialize)]
struct ExamplesResponse {
    examples: Vec<Example>,
}

#[derive(Debug, Serialize)]
struct Example {
    name: String,
    title: String,
    description: String,
    top: String,
    files: Vec<SourceFile>,
}

#[derive(Debug, Deserialize)]
struct ManifestEntry {
    name: String,
    title: String,
    description: String,
    top: String,
    files: Vec<String>,
}

async fn examples() -> Result<Json<ExamplesResponse>, ApiError> {
    let base = PathBuf::from(env::var("EXAMPLES_DIR").unwrap_or_else(|_| "../examples".to_owned()));
    let manifest_path = base.join("manifest.json");
    let manifest = match tokio::fs::read_to_string(&manifest_path).await {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Json(ExamplesResponse {
                examples: Vec::new(),
            }));
        }
        Err(err) => {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to read examples manifest: {err}"),
            ));
        }
    };
    let entries: Vec<ManifestEntry> = serde_json::from_str(&manifest).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to parse examples manifest: {err}"),
        )
    })?;
    let mut examples = Vec::new();
    for entry in entries {
        let mut files = Vec::new();
        let mut missing = false;
        for name in entry.files {
            match tokio::fs::read_to_string(base.join(&name)).await {
                Ok(content) => files.push(SourceFile { name, content }),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    missing = true;
                    break;
                }
                Err(err) => {
                    return Err(ApiError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("failed to read example file: {err}"),
                    ));
                }
            }
        }
        if !missing {
            examples.push(Example {
                name: entry.name,
                title: entry.title,
                description: entry.description,
                top: entry.top,
                files,
            });
        }
    }
    Ok(Json(ExamplesResponse { examples }))
}

async fn get_design(state: &AppState, id: &str) -> Result<Arc<Design>, ApiError> {
    cache_lookup(&state.cache, id)
        .await
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "unknown design"))
}

fn map_yosys_error(err: YosysError) -> ApiError {
    match err {
        YosysError::Validation(message) => ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, message),
        YosysError::Timeout { log } => {
            ApiError::with_log(StatusCode::GATEWAY_TIMEOUT, "yosys timed out", log)
        }
        YosysError::Yosys { log } => {
            ApiError::with_log(StatusCode::BAD_REQUEST, "yosys failed", log)
        }
        YosysError::Io(err) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to run yosys: {err}"),
        ),
        YosysError::Json(err) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("invalid yosys json: {err}"),
        ),
        YosysError::Netlist(err) => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("invalid yosys netlist: {err}"),
        ),
    }
}

fn mode_string(mode: SynthMode) -> String {
    mode.to_string()
}

fn parse_node_ids(ids: &str) -> Result<Vec<u32>, ApiError> {
    if ids.trim().is_empty() {
        return Ok(Vec::new());
    }
    ids.split(',')
        .map(|raw| {
            raw.trim().parse::<u32>().map_err(|_| {
                ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    format!("invalid node id: {raw}"),
                )
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_test_design(design_id: &str) -> Arc<Design> {
        let netlist = parse_value(serde_json::json!({
            "modules": {
                "top": {}
            }
        }))
        .unwrap();
        let (top, module) = select_top(&netlist, Some("top")).unwrap();
        let graph = Graph::from_netlist(&netlist, top, module).unwrap();
        let analysis = Analysis::new(&graph, vec!["test.sv".to_owned()]);
        let source_index = SourceLineIndex::from_module(module, vec!["test.sv".to_owned()]);
        Arc::new(Design {
            response: SynthesizeResponse {
                design_id: design_id.to_owned(),
                top: top.to_owned(),
                mode: "rtl".to_owned(),
                stats: analysis.stats(),
                warnings: analysis.warnings(),
                log: String::new(),
            },
            graph,
            analysis,
            source_index,
        })
    }

    #[test]
    fn weighted_cache_evicts_fifo_entries_to_stay_within_budget() {
        let mut cache = WeightedCache::new(10);
        assert!(cache.insert("a".to_owned(), Arc::new(1_u8), 6));
        assert!(cache.insert("b".to_owned(), Arc::new(2_u8), 4));
        assert_eq!(cache.weight_bytes, 10);

        assert!(!cache.insert("a".to_owned(), Arc::new(9_u8), 11));
        assert_eq!(cache.get("a").as_deref(), Some(&1));
        assert_eq!(cache.weight_bytes, 10);

        assert!(cache.insert("c".to_owned(), Arc::new(3_u8), 5));
        assert!(cache.get("a").is_none());
        assert_eq!(cache.get("b").as_deref(), Some(&2));
        assert_eq!(cache.get("c").as_deref(), Some(&3));
        assert_eq!(cache.weight_bytes, 9);

        assert!(!cache.insert("oversized".to_owned(), Arc::new(4_u8), 11));
        assert_eq!(cache.weight_bytes, 9);
        assert!(cache.get("b").is_some());
        assert!(cache.get("c").is_some());
    }

    #[test]
    fn weighted_cache_replacement_updates_accounting_once() {
        let mut cache = WeightedCache::new(10);
        assert!(cache.insert("a".to_owned(), Arc::new(1_u8), 6));
        assert!(cache.insert("b".to_owned(), Arc::new(2_u8), 4));

        assert!(cache.insert("a".to_owned(), Arc::new(3_u8), 3));
        assert_eq!(cache.weight_bytes, 7);
        assert_eq!(cache.entries.len(), 2);
        assert_eq!(cache.get("a").as_deref(), Some(&3));

        assert!(cache.insert("c".to_owned(), Arc::new(4_u8), 5));
        assert!(cache.get("b").is_none());
        assert_eq!(cache.get("a").as_deref(), Some(&3));
        assert_eq!(cache.get("c").as_deref(), Some(&4));
        assert_eq!(cache.weight_bytes, 8);
    }

    #[tokio::test]
    async fn synthesis_flight_shares_failure_then_releases_the_key() {
        let registry = Arc::new(SynthesisFlights::new());
        let leader = match registry.claim("same-design") {
            FlightClaim::Leader(leader) => leader,
            FlightClaim::Follower(_) => panic!("first claim must lead"),
        };
        let follower = match registry.claim("same-design") {
            FlightClaim::Follower(receiver) => receiver,
            FlightClaim::Leader(_) => panic!("second claim must follow"),
        };
        assert_eq!(registry.entries.lock().unwrap().len(), 1);

        let leader_result = leader.complete(Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "deterministic failure",
        )));
        assert_eq!(leader_result.unwrap_err().status, StatusCode::BAD_REQUEST);
        let follower_error = wait_for_flight(follower).await.unwrap_err();
        assert_eq!(follower_error.status, StatusCode::BAD_REQUEST);
        assert_eq!(follower_error.message, "deterministic failure");
        assert!(registry.entries.lock().unwrap().is_empty());

        let retry = match registry.claim("same-design") {
            FlightClaim::Leader(leader) => leader,
            FlightClaim::Follower(_) => panic!("failed flight must not poison retries"),
        };
        drop(retry);
        assert!(registry.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn synthesis_flight_shares_one_success_with_all_followers() {
        let registry = Arc::new(SynthesisFlights::new());
        let leader = match registry.claim("same-design") {
            FlightClaim::Leader(leader) => leader,
            FlightClaim::Follower(_) => panic!("first claim must lead"),
        };
        let follower = match registry.claim("same-design") {
            FlightClaim::Follower(receiver) => receiver,
            FlightClaim::Leader(_) => panic!("second claim must follow"),
        };
        let expected = empty_test_design("same-design");

        let leader_design = leader.complete(Ok(Arc::clone(&expected))).unwrap();
        let follower_design = wait_for_flight(follower).await.unwrap();
        assert!(Arc::ptr_eq(&leader_design, &expected));
        assert!(Arc::ptr_eq(&follower_design, &expected));
        assert!(registry.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelled_synthesis_leader_notifies_followers_and_releases_the_key() {
        let registry = Arc::new(SynthesisFlights::new());
        let leader = match registry.claim("cancelled-design") {
            FlightClaim::Leader(leader) => leader,
            FlightClaim::Follower(_) => panic!("first claim must lead"),
        };
        let follower = match registry.claim("cancelled-design") {
            FlightClaim::Follower(receiver) => receiver,
            FlightClaim::Leader(_) => panic!("second claim must follow"),
        };

        drop(leader);
        let error = wait_for_flight(follower).await.unwrap_err();
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error.message, "synthesis request was cancelled");
        assert!(registry.entries.lock().unwrap().is_empty());
        let retry = registry.claim("cancelled-design");
        assert!(matches!(retry, FlightClaim::Leader(_)));
    }

    #[tokio::test]
    async fn cache_recheck_after_claim_observes_a_completed_insert() {
        let cache = RwLock::new(WeightedCache::new(10));
        assert!(cache_lookup(&cache, "design").await.is_none());
        let registry = Arc::new(SynthesisFlights::new());
        let leader = match registry.claim("design") {
            FlightClaim::Leader(leader) => leader,
            FlightClaim::Follower(_) => panic!("first claim must lead"),
        };

        // This models the race handled by the leader-side cache recheck: the
        // optimistic lookup missed, then another completed request inserted the
        // value before the newly claimed leader starts expensive work.
        cache
            .write()
            .await
            .insert("design".to_owned(), Arc::new(7_u8), 4);
        assert_eq!(cache_lookup(&cache, "design").await.as_deref(), Some(&7));
        drop(leader);
    }

    #[test]
    fn yosys_slots_enforce_the_configured_global_limit() {
        let state = AppState::with_limits(1024, 2);
        let first = Arc::clone(&state.yosys_slots).try_acquire_owned().unwrap();
        let _second = Arc::clone(&state.yosys_slots).try_acquire_owned().unwrap();
        assert!(Arc::clone(&state.yosys_slots).try_acquire_owned().is_err());

        drop(first);
        assert!(Arc::clone(&state.yosys_slots).try_acquire_owned().is_ok());
    }
}
