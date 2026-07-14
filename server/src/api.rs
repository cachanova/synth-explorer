use crate::analysis::{
    Analysis, ApiNodeKind, ConeDir, ConeOptions, EndpointsResponse, FanoutResponse, NodeRef,
    PathsResponse, SourceLineIndex, SourceMapResponse, Stats, Subgraph, estimate_delay_ns,
};
use crate::delay_model::DelayModel;
use crate::graph::Graph;
use crate::grouping::GroupPartition;
use crate::netlist::{parse_value, select_top};
use crate::source_provenance::{SourceProvenance, recover_source_provenance};
use crate::yosys::{
    MemoryHandling, ResourceKind, SourceFile, SynthMode, SynthRequest, YosysError, run_yosys,
};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderValue, Method, Request, StatusCode, header};
use axum::middleware::{Next, from_fn};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::mem::size_of;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::sync::{RwLock, Semaphore, watch};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

const DESIGN_CACHE_BUDGET_BYTES: usize = 128 * 1024 * 1024;
const DESIGN_CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const DESIGN_CACHE_MIN_ENTRY_BYTES: usize = 64 * 1024;
const MAX_IN_FLIGHT_DESIGNS: usize = 3;
const MAX_RUNNING_SYNTHESES: usize = 1;
const SYNTHESIS_RETRY_AFTER_SECONDS: u64 = 5;

#[derive(Clone)]
pub struct AppState {
    cache: Arc<RwLock<DesignCache>>,
    flights: Arc<SynthesisFlights>,
    running: Arc<Semaphore>,
    metadata: Arc<BuildMetadata>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new("unknown")
    }
}

impl AppState {
    pub fn new(yosys_version: impl Into<String>) -> Self {
        Self::with_cache_config(yosys_version, DESIGN_CACHE_BUDGET_BYTES, DESIGN_CACHE_TTL)
    }

    fn with_cache_config(
        yosys_version: impl Into<String>,
        cache_budget_bytes: usize,
        cache_ttl: Duration,
    ) -> Self {
        Self {
            cache: Arc::new(RwLock::new(DesignCache::new(cache_budget_bytes, cache_ttl))),
            flights: Arc::new(SynthesisFlights::new()),
            running: Arc::new(Semaphore::new(MAX_RUNNING_SYNTHESES)),
            metadata: Arc::new(BuildMetadata {
                status: "ok",
                commit: env::var("BUILD_COMMIT").unwrap_or_else(|_| "unknown".to_owned()),
                version: env!("CARGO_PKG_VERSION"),
                yosys_version: yosys_version.into(),
            }),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct BuildMetadata {
    status: &'static str,
    commit: String,
    version: &'static str,
    yosys_version: String,
}

#[derive(Debug)]
struct DesignCache {
    designs: HashMap<String, CachedDesign>,
    order: VecDeque<(String, Instant)>,
    total_bytes: usize,
    budget_bytes: usize,
    ttl: Duration,
}

#[derive(Debug)]
struct CachedDesign {
    design: Arc<Design>,
    weight_bytes: usize,
    inserted_at: Instant,
}

impl DesignCache {
    fn new(budget_bytes: usize, ttl: Duration) -> Self {
        Self {
            designs: HashMap::new(),
            order: VecDeque::new(),
            total_bytes: 0,
            budget_bytes,
            ttl,
        }
    }

    fn get(&mut self, id: &str) -> Option<Arc<Design>> {
        self.get_at(id, Instant::now())
    }

    fn get_at(&mut self, id: &str, now: Instant) -> Option<Arc<Design>> {
        self.evict_expired(now);
        self.designs.get(id).map(|entry| Arc::clone(&entry.design))
    }

    fn insert(&mut self, id: String, design: Arc<Design>, weight_bytes: usize) -> bool {
        self.insert_at(id, design, weight_bytes, Instant::now())
    }

    fn insert_at(
        &mut self,
        id: String,
        design: Arc<Design>,
        weight_bytes: usize,
        now: Instant,
    ) -> bool {
        let weight_bytes = weight_bytes.max(DESIGN_CACHE_MIN_ENTRY_BYTES);
        self.evict_expired(now);
        if weight_bytes > self.budget_bytes {
            return false;
        }
        self.remove(&id);
        while self.total_bytes.saturating_add(weight_bytes) > self.budget_bytes {
            if !self.evict_oldest() {
                break;
            }
        }
        // FIFO eviction keeps cache bookkeeping cheap; cache hits do not refresh order.
        self.order.push_back((id.clone(), now));
        self.total_bytes += weight_bytes;
        self.designs.insert(
            id,
            CachedDesign {
                design,
                weight_bytes,
                inserted_at: now,
            },
        );
        true
    }

    fn remove(&mut self, id: &str) {
        if let Some(entry) = self.designs.remove(id) {
            self.total_bytes = self.total_bytes.saturating_sub(entry.weight_bytes);
        }
    }

    fn evict_oldest(&mut self) -> bool {
        while let Some((id, inserted_at)) = self.order.pop_front() {
            let is_current = self
                .designs
                .get(&id)
                .is_some_and(|entry| entry.inserted_at == inserted_at);
            if is_current {
                self.remove(&id);
                return true;
            }
        }
        false
    }

    fn evict_expired(&mut self, now: Instant) {
        loop {
            let Some((id, inserted_at)) = self.order.front() else {
                return;
            };
            let is_current = self
                .designs
                .get(id)
                .is_some_and(|entry| entry.inserted_at == *inserted_at);
            if !is_current {
                self.order.pop_front();
                continue;
            }
            let expired = now
                .checked_duration_since(*inserted_at)
                .is_some_and(|age| age >= self.ttl);
            if !expired {
                return;
            }
            let id = id.clone();
            self.order.pop_front();
            self.remove(&id);
        }
    }
}

async fn cache_lookup(cache: &RwLock<DesignCache>, id: &str) -> Option<Arc<Design>> {
    cache.write().await.get(id)
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

    fn claim(self: &Arc<Self>, design_id: &str) -> Result<FlightClaim, FlightClaimError> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(flight) = entries.get(design_id) {
            return Ok(FlightClaim::Follower(flight.result.subscribe()));
        }
        if entries.len() >= MAX_IN_FLIGHT_DESIGNS {
            return Err(FlightClaimError::AtCapacity);
        }

        let (result, receiver) = watch::channel(None);
        let flight = Arc::new(SynthesisFlight { result });
        entries.insert(design_id.to_owned(), Arc::clone(&flight));
        Ok(FlightClaim::New {
            receiver,
            task: FlightTaskGuard {
                registry: Arc::clone(self),
                design_id: design_id.to_owned(),
                flight,
                completed: false,
            },
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
    Follower(watch::Receiver<Option<FlightResult>>),
    New {
        receiver: watch::Receiver<Option<FlightResult>>,
        task: FlightTaskGuard,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlightClaimError {
    AtCapacity,
}

struct FlightTaskGuard {
    registry: Arc<SynthesisFlights>,
    design_id: String,
    flight: Arc<SynthesisFlight>,
    completed: bool,
}

impl FlightTaskGuard {
    fn complete(mut self, result: FlightResult) {
        self.flight.result.send_replace(Some(result));
        self.registry.remove(&self.design_id, &self.flight);
        self.completed = true;
    }
}

impl Drop for FlightTaskGuard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        self.flight.result.send_replace(Some(Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "shared synthesis task was cancelled",
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
    grouping: GroupPartition,
    /// The delay model chosen from the synthesis target, i.e. the one that
    /// produced `response.stats.estimated_delay_ns`. Used as the default base
    /// for `/timing` retunes so a no-argument retune reproduces that number.
    delay_model: DelayModel,
}

impl Design {
    /// Deterministic estimate of retained allocation, not allocator-exact RSS.
    fn estimated_heap_bytes(&self) -> usize {
        size_of::<Self>()
            .saturating_add(synthesize_response_heap_bytes(&self.response))
            .saturating_add(self.graph.estimated_heap_bytes())
            .saturating_add(self.analysis.estimated_heap_bytes())
            .saturating_add(self.source_index.estimated_heap_bytes())
            .saturating_add(self.grouping.estimated_heap_bytes())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SynthesizeResponse {
    pub design_id: String,
    pub top: String,
    pub mode: String,
    pub stats: Stats,
    pub warnings: Vec<String>,
    pub log: String,
    /// True when generic synthesis hit the sandbox memory limit and succeeded
    /// on the abstract-memory retry, leaving `$mem_v2` cells unmapped.
    pub memories_abstracted: bool,
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
    retry_after_seconds: Option<u64>,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
            log: None,
            retry_after_seconds: None,
        }
    }

    fn with_log(status: StatusCode, message: impl Into<String>, log: String) -> Self {
        Self {
            status,
            message: message.into(),
            log: Some(log),
            retry_after_seconds: None,
        }
    }

    fn busy() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: "synthesis queue is full".to_owned(),
            log: None,
            retry_after_seconds: Some(SYNTHESIS_RETRY_AFTER_SECONDS),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(ErrorBody {
                error: self.message,
                log: self.log,
            }),
        )
            .into_response();
        if let Some(seconds) = self.retry_after_seconds
            && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
        {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        response
    }
}

pub fn app(state: AppState) -> Router {
    let health_state = state.clone();
    let api = Router::new()
        .route("/synthesize", post(synthesize))
        .route("/examples", get(examples))
        .route("/design/{id}", get(design))
        .route("/design/{id}/endpoints", get(endpoints))
        .route("/design/{id}/timing", post(design_timing))
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
        .route("/healthz", get(health))
        .nest("/api", api)
        .fallback_service(static_service)
        .with_state(health_state)
        .layer(from_fn(trace_request))
        .layer(cors)
}

async fn health(State(state): State<AppState>) -> Json<BuildMetadata> {
    Json((*state.metadata).clone())
}

async fn trace_request(request: Request<axum::body::Body>, next: Next) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let started = Instant::now();
    let response = next.run(request).await;
    tracing::info!(
        method = %method,
        uri = %uri,
        status = response.status().as_u16(),
        latency_ms = started.elapsed().as_millis() as u64,
        "http_request"
    );
    response
}

async fn synthesize(
    State(state): State<AppState>,
    Json(request): Json<SynthRequest>,
) -> Result<Json<SynthesizeResponse>, ApiError> {
    let validated = request.validate().map_err(map_yosys_error)?;
    let design_id = validated.design_id();
    let mode = mode_string(validated.mode);
    if let Some(design) = cache_lookup(&state.cache, &design_id).await {
        tracing::info!(design_id, mode, cache_hit = true, "synthesis_complete");
        return Ok(Json(design.response.clone()));
    }

    let receiver = match state.flights.claim(&design_id) {
        Ok(FlightClaim::Follower(receiver)) => {
            // Followers need only the stable design id. Do not retain another
            // complete source payload while the shared pipeline is running.
            drop(validated);
            receiver
        }
        Ok(FlightClaim::New { receiver, task }) => {
            let task_state = state.clone();
            let task_design_id = design_id.clone();
            tokio::spawn(async move {
                let task_mode = mode_string(validated.mode);
                // A previous flight may have filled the cache after the
                // optimistic lookup but before this key was claimed.
                let result =
                    if let Some(design) = cache_lookup(&task_state.cache, &task_design_id).await {
                        tracing::info!(
                            design_id = task_design_id,
                            mode = task_mode,
                            cache_hit = true,
                            "synthesis_complete"
                        );
                        Ok(design)
                    } else {
                        synthesize_uncached(&task_state, &validated, &task_design_id).await
                    };
                task.complete(result);
            });
            receiver
        }
        Err(FlightClaimError::AtCapacity) => {
            // A task can publish its cache entry immediately before removing
            // its flight. Close that race before rejecting a distinct key.
            if let Some(design) = cache_lookup(&state.cache, &design_id).await {
                tracing::info!(design_id, mode, cache_hit = true, "synthesis_complete");
                return Ok(Json(design.response.clone()));
            }
            return Err(ApiError::busy());
        }
    };
    let design = wait_for_flight(receiver).await?;
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
    // Keep the sole running permit until the parsed graph is safely cached.
    // The flight registry separately bounds this task plus two queued leaders.
    let _running = Arc::clone(&state.running)
        .acquire_owned()
        .await
        .expect("synthesis semaphore is never closed");
    let mode = mode_string(validated.mode);
    if let Some(design) = cache_lookup(&state.cache, design_id).await {
        tracing::info!(design_id, mode, cache_hit = true, "synthesis_complete");
        return Ok(design);
    }
    let started = Instant::now();
    let synthesis_failed = |err: &YosysError| {
        tracing::warn!(
            design_id,
            mode,
            latency_ms = started.elapsed().as_millis() as u64,
            error = %err,
            "synthesis_failed"
        );
    };
    let (output, memories_abstracted) = match run_yosys(validated, MemoryHandling::Map).await {
        Ok(output) => (output, false),
        // A too-large memory flatten exhausts memory, CPU, or the wall clock
        // depending on the Yosys version; any of them is worth one retry that
        // keeps memories abstract.
        Err(err) if validated.mode.is_generic() && err.is_resource_exhaustion() => {
            tracing::info!(design_id, mode, "synthesis_memory_retry");
            let output = run_yosys(validated, MemoryHandling::Abstract)
                .await
                .map_err(|retry_err| {
                    synthesis_failed(&retry_err);
                    map_yosys_error(retry_err)
                })?;
            (output, true)
        }
        Err(err) => {
            synthesis_failed(&err);
            return Err(map_yosys_error(err));
        }
    };
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
    let (source_top, _) = select_top(&source_parsed, None).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to resolve source-provenance top module: {err}"),
        )
    })?;
    let SourceProvenance {
        ranges,
        truncated: source_ranges_truncated,
        procedural_targets,
        probe_hints,
    } = recover_source_provenance(
        &graph,
        &source_parsed,
        validated
            .files
            .iter()
            .map(|file| (file.name.clone(), file.content.clone())),
    );
    let delay_model = DelayModel::for_target(&mode, validated.family());
    let mut analysis = Analysis::with_delay_model(&graph, validated.file_names(), &delay_model);
    let mut source_index =
        SourceLineIndex::from_netlist(&source_parsed, source_top, validated.file_names());
    source_index.extend_ranges(&ranges);
    analysis.extend_source_ranges(ranges, source_ranges_truncated);
    analysis.set_procedural_targets(procedural_targets);
    analysis.set_source_probe_hints(probe_hints);
    let response = SynthesizeResponse {
        design_id: design_id.to_owned(),
        top: output.resolved_top,
        mode: mode.clone(),
        stats: analysis.stats(),
        warnings: analysis.warnings(),
        log: output.log,
        memories_abstracted,
    };
    let grouping = GroupPartition::build(&graph, &analysis.endpoints().registers);
    let design = Arc::new(Design {
        response: response.clone(),
        graph,
        analysis,
        source_index,
        grouping,
        delay_model,
    });
    let cache_estimated_bytes = design_cache_weight(design_id, &design);
    let cache_charge_bytes = cache_estimated_bytes.max(DESIGN_CACHE_MIN_ENTRY_BYTES);
    let cached = state.cache.write().await.insert(
        design_id.to_owned(),
        Arc::clone(&design),
        cache_charge_bytes,
    );
    if !cached {
        tracing::warn!(
            design_id,
            mode,
            latency_ms = started.elapsed().as_millis() as u64,
            cache_estimated_bytes,
            cache_charge_bytes,
            "synthesis_cache_rejected"
        );
        return Err(ApiError::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "synthesized design exceeds the server cache budget",
        ));
    }
    tracing::info!(
        design_id,
        mode,
        cache_hit = false,
        latency_ms = started.elapsed().as_millis() as u64,
        cache_estimated_bytes,
        cache_charge_bytes,
        "synthesis_complete"
    );
    Ok(design)
}

fn design_cache_weight(design_id: &str, design: &Design) -> usize {
    // The cache retains two owned id strings (hash-map key and FIFO key), one
    // hash-map entry, and one VecDeque element in addition to the design.
    design
        .estimated_heap_bytes()
        .saturating_add(size_of::<(String, CachedDesign)>())
        .saturating_add(size_of::<(String, Instant)>())
        .saturating_add(design_id.len().saturating_mul(2))
        .max(1)
}

fn synthesize_response_heap_bytes(response: &SynthesizeResponse) -> usize {
    let mut bytes = response
        .design_id
        .capacity()
        .saturating_add(response.top.capacity())
        .saturating_add(response.mode.capacity())
        .saturating_add(response.log.capacity())
        .saturating_add(
            response
                .warnings
                .capacity()
                .saturating_mul(size_of::<String>()),
        )
        .saturating_add(
            response
                .stats
                .cells_by_type
                .len()
                .saturating_mul(size_of::<(String, usize)>() + 3 * size_of::<usize>()),
        );
    for warning in &response.warnings {
        bytes = bytes.saturating_add(warning.capacity());
    }
    for cell_type in response.stats.cells_by_type.keys() {
        bytes = bytes.saturating_add(cell_type.capacity());
    }
    bytes
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

/// Retune the estimated timing of an already-synthesized design. The caller
/// supplies a base delay profile (or a full coefficient override) plus a speed
/// grade; the delay is recomputed on the cached graph without re-synthesizing.
#[derive(Debug, Deserialize)]
struct TimingRequest {
    /// Named preset: series7 | ultrascale | ultrascale_plus | ice40 | ecp5 |
    /// generic. Ignored when `model` is present. Defaults to series7.
    profile: Option<String>,
    /// Speed grade: "-1" (slowest, default), "-2", or "-3".
    speed_grade: Option<String>,
    /// Full coefficient override from the advanced editor; wins over `profile`.
    model: Option<DelayModel>,
}

#[derive(Debug, Serialize)]
struct TimingResponse {
    /// Recomputed worst-case combinational delay; null when there are no
    /// combinational paths.
    estimated_delay_ns: Option<f64>,
    /// The base coefficients used (before the speed-grade multiplier), so the
    /// client can populate the editor when only a profile name was sent.
    model: DelayModel,
}

fn profile_preset(name: Option<&str>) -> DelayModel {
    match name {
        Some("ultrascale") => DelayModel::ultrascale(),
        Some("ultrascale_plus") => DelayModel::ultrascale_plus(),
        Some("ice40") => DelayModel::ice40(),
        Some("ecp5") => DelayModel::ecp5(),
        Some("generic") => DelayModel::generic(),
        _ => DelayModel::series7(),
    }
}

fn speed_grade_factor(grade: Option<&str>) -> f64 {
    match grade {
        Some("-2") => 0.87,
        Some("-3") => 0.78,
        // "-1" or unspecified: the baseline the presets are characterized at.
        _ => 1.0,
    }
}

async fn design_timing(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<TimingRequest>,
) -> Result<Json<TimingResponse>, ApiError> {
    let design = get_design(&state, &id).await?;
    // Precedence: an explicit coefficient override wins, then a named profile,
    // then the design's own synth-time model — so a no-argument retune
    // reproduces the estimate shown in the synthesis panel.
    let base = match (request.model, request.profile.as_deref()) {
        (Some(model), _) => model,
        (None, Some(profile)) => profile_preset(Some(profile)),
        (None, None) => design.delay_model,
    };
    let effective = base.scaled(speed_grade_factor(request.speed_grade.as_deref()));
    let estimated_delay_ns = estimate_delay_ns(&design.graph, &effective);
    Ok(Json(TimingResponse {
        estimated_delay_ns,
        model: base,
    }))
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
    nodes: Option<String>,
    dir: Option<String>,
    max_depth: Option<u32>,
    max_nodes: Option<usize>,
    hide_control: Option<bool>,
    hide_const: Option<bool>,
    show_infrastructure: Option<bool>,
    group_vectors: Option<bool>,
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
    let roots =
        match &query.nodes {
            Some(nodes) => {
                let ids = parse_node_ids(nodes)?;
                if ids.is_empty() {
                    return Err(ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "nodes must contain at least one node id",
                    ));
                }
                if ids.len() > 200 {
                    return Err(ApiError::new(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "at most 200 nodes may be requested",
                    ));
                }
                ids
            }
            None => vec![query.node.ok_or_else(|| {
                ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "node is required")
            })?],
        };
    let subgraph = design
        .analysis
        .multi_root_cone(
            &design.graph,
            &roots,
            ConeOptions {
                dir,
                max_depth: query.max_depth.unwrap_or(64),
                max_nodes: query.max_nodes.unwrap_or(300),
                hide_control: query.hide_control.unwrap_or(true),
                hide_const: query.hide_const.unwrap_or(true),
                show_infrastructure: query.show_infrastructure.unwrap_or(false),
            },
            grouping_for(&design, query.group_vectors),
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
    group_vectors: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum SourceEnvelopeStatus {
    Mapped,
    MappingIncomplete,
    OptimizedOrAbsorbed,
    Unmapped,
}

#[derive(Debug, Serialize)]
struct LineConeResponse {
    status: SourceEnvelopeStatus,
    control: bool,
    highlight: Vec<u32>,
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
    let probe = design
        .analysis
        .source_probe_range(&design.graph, &file, start_line as usize, end_line as usize)
        .ok_or_else(|| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "unknown file"))?;
    let roots = probe.roots;
    let control = roots.iter().any(|root| {
        design.graph.outgoing[*root as usize]
            .iter()
            .any(|edge_idx| design.graph.edges[*edge_idx].control)
    });
    let hide_control = query.hide_control.unwrap_or(true) && !control;
    let options = ConeOptions {
        dir: probe.direction.unwrap_or(ConeDir::Fanin),
        max_depth: 64,
        max_nodes: query.max_nodes.unwrap_or(400),
        hide_control,
        hide_const: query.hide_const.unwrap_or(true),
        show_infrastructure: query.show_infrastructure.unwrap_or(false),
    };
    let grouping = grouping_for(&design, query.group_vectors);
    let subgraph = match probe.direction {
        Some(_) => design.analysis.multi_root_source_cone(
            &design.graph,
            &roots,
            options,
            grouping,
            probe.expand_output_register_inputs,
        ),
        None => design
            .analysis
            .envelope(&design.graph, &roots, options, grouping),
    }
    .expect("source map contains only valid graph node ids");
    let highlight = subgraph
        .nodes
        .iter()
        .filter(|node| {
            if probe.highlight_logic {
                node.node.kind == ApiNodeKind::Cell
            } else {
                node.is_root == Some(true)
            }
        })
        .map(|node| node.node.id)
        .collect();
    let mapping_incomplete = design
        .analysis
        .source_mapping_incomplete(&file, start_line as usize, end_line as usize)
        .expect("final and provenance indexes contain the same source files");
    let source_seen = design
        .source_index
        .contains_range(&file, start_line as usize, end_line as usize)
        .expect("final and provenance indexes contain the same source files");
    let status = source_envelope_status(!roots.is_empty(), mapping_incomplete, source_seen);
    Ok(Json(LineConeResponse {
        status,
        control,
        highlight,
        graph: subgraph,
    }))
}

fn source_envelope_status(
    has_roots: bool,
    mapping_incomplete: bool,
    source_seen: bool,
) -> SourceEnvelopeStatus {
    if mapping_incomplete {
        SourceEnvelopeStatus::MappingIncomplete
    } else if has_roots {
        SourceEnvelopeStatus::Mapped
    } else if source_seen {
        SourceEnvelopeStatus::OptimizedOrAbsorbed
    } else {
        SourceEnvelopeStatus::Unmapped
    }
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
    group_vectors: Option<bool>,
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
        grouping_for(&design, query.group_vectors),
    )))
}

/// The design's cached partition when the caller opted into grouping, else
/// `None` (per-bit projection). Grouping defaults off at the API for contract
/// compatibility; the UI opts in.
fn grouping_for(design: &Design, group_vectors: Option<bool>) -> Option<&GroupPartition> {
    group_vectors.unwrap_or(false).then_some(&design.grouping)
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
        YosysError::ResourceLimit { kind, log } => {
            let message = match kind {
                ResourceKind::Memory => {
                    "synthesis exceeded the sandbox memory limit — large memories cannot be \
                     flattened to gates; try RTL or a vendor mode, or reduce memory sizes"
                }
                ResourceKind::Cpu => {
                    "synthesis exceeded the sandbox CPU limit — simplify the design or use a \
                     lighter mode"
                }
                ResourceKind::OutputSize => "synthesis output exceeded the sandbox size limit",
            };
            ApiError::with_log(StatusCode::BAD_REQUEST, message, log)
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
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

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
        let grouping = GroupPartition::build(&graph, &analysis.endpoints().registers);
        Arc::new(Design {
            response: SynthesizeResponse {
                design_id: design_id.to_owned(),
                top: top.to_owned(),
                mode: "rtl".to_owned(),
                stats: analysis.stats(),
                warnings: analysis.warnings(),
                log: String::new(),
                memories_abstracted: false,
            },
            graph,
            analysis,
            source_index,
            grouping,
            delay_model: DelayModel::default(),
        })
    }

    #[test]
    fn weighted_cache_evicts_fifo_entries_to_stay_within_budget() {
        let unit = DESIGN_CACHE_MIN_ENTRY_BYTES;
        let mut cache = DesignCache::new(10 * unit, Duration::from_secs(60));
        assert!(cache.insert("a".to_owned(), empty_test_design("a"), 6 * unit));
        assert!(cache.insert("b".to_owned(), empty_test_design("b"), 4 * unit));
        assert_eq!(cache.total_bytes, 10 * unit);

        assert!(!cache.insert("a".to_owned(), empty_test_design("replacement"), 11 * unit));
        assert_eq!(cache.get("a").unwrap().response.design_id, "a");
        assert_eq!(cache.total_bytes, 10 * unit);

        assert!(cache.insert("c".to_owned(), empty_test_design("c"), 5 * unit));
        assert!(cache.get("a").is_none());
        assert_eq!(cache.get("b").unwrap().response.design_id, "b");
        assert_eq!(cache.get("c").unwrap().response.design_id, "c");
        assert_eq!(cache.total_bytes, 9 * unit);

        assert!(!cache.insert(
            "oversized".to_owned(),
            empty_test_design("oversized"),
            11 * unit,
        ));
        assert_eq!(cache.total_bytes, 9 * unit);
        assert!(cache.get("b").is_some());
        assert!(cache.get("c").is_some());
    }

    #[test]
    fn weighted_cache_replacement_updates_accounting_once() {
        let unit = DESIGN_CACHE_MIN_ENTRY_BYTES;
        let mut cache = DesignCache::new(10 * unit, Duration::from_secs(60));
        assert!(cache.insert("a".to_owned(), empty_test_design("a-old"), 6 * unit));
        assert!(cache.insert("b".to_owned(), empty_test_design("b"), 4 * unit));

        assert!(cache.insert("a".to_owned(), empty_test_design("a-new"), 3 * unit));
        assert_eq!(cache.total_bytes, 7 * unit);
        assert_eq!(cache.designs.len(), 2);
        assert_eq!(cache.get("a").unwrap().response.design_id, "a-new");

        assert!(cache.insert("c".to_owned(), empty_test_design("c"), 5 * unit));
        assert!(cache.get("b").is_none());
        assert_eq!(cache.get("a").unwrap().response.design_id, "a-new");
        assert_eq!(cache.get("c").unwrap().response.design_id, "c");
        assert_eq!(cache.total_bytes, 8 * unit);
    }

    #[test]
    fn retained_design_capacity_increases_cache_weight() {
        let small = empty_test_design("design");
        let mut large = empty_test_design("design");
        let mut retained_log = String::with_capacity(16 * 1024);
        retained_log.push('x');
        Arc::get_mut(&mut large).unwrap().response.log = retained_log;

        assert!(
            design_cache_weight("design", &large) > design_cache_weight("design", &small),
            "retained buffer capacity must contribute to cache accounting"
        );
    }

    #[test]
    fn incomplete_source_mapping_is_never_reported_as_optimized() {
        assert_eq!(
            source_envelope_status(false, true, true),
            SourceEnvelopeStatus::MappingIncomplete
        );
        assert_eq!(
            source_envelope_status(true, true, true),
            SourceEnvelopeStatus::MappingIncomplete
        );
    }

    #[tokio::test]
    async fn synthesis_flight_shares_failure_then_releases_the_key() {
        let registry = Arc::new(SynthesisFlights::new());
        let (initiator, task) = match registry.claim("same-design").unwrap() {
            FlightClaim::New { receiver, task } => (receiver, task),
            FlightClaim::Follower(_) => panic!("first claim must create a task"),
        };
        let follower = match registry.claim("same-design").unwrap() {
            FlightClaim::Follower(receiver) => receiver,
            FlightClaim::New { .. } => panic!("second claim must follow"),
        };
        assert_eq!(registry.entries.lock().unwrap().len(), 1);

        task.complete(Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "deterministic failure",
        )));
        let initiator_error = wait_for_flight(initiator).await.unwrap_err();
        assert_eq!(initiator_error.status, StatusCode::BAD_REQUEST);
        let follower_error = wait_for_flight(follower).await.unwrap_err();
        assert_eq!(follower_error.status, StatusCode::BAD_REQUEST);
        assert_eq!(follower_error.message, "deterministic failure");
        assert!(registry.entries.lock().unwrap().is_empty());

        let retry = match registry.claim("same-design").unwrap() {
            FlightClaim::New { task, .. } => task,
            FlightClaim::Follower(_) => panic!("failed flight must not poison retries"),
        };
        drop(retry);
        assert!(registry.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn synthesis_flight_shares_one_success_with_all_followers() {
        let registry = Arc::new(SynthesisFlights::new());
        let (initiator, task) = match registry.claim("same-design").unwrap() {
            FlightClaim::New { receiver, task } => (receiver, task),
            FlightClaim::Follower(_) => panic!("first claim must create a task"),
        };
        let follower = match registry.claim("same-design").unwrap() {
            FlightClaim::Follower(receiver) => receiver,
            FlightClaim::New { .. } => panic!("second claim must follow"),
        };
        let expected = empty_test_design("same-design");

        task.complete(Ok(Arc::clone(&expected)));
        let initiator_design = wait_for_flight(initiator).await.unwrap();
        let follower_design = wait_for_flight(follower).await.unwrap();
        assert!(Arc::ptr_eq(&initiator_design, &expected));
        assert!(Arc::ptr_eq(&follower_design, &expected));
        assert!(registry.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn initiating_receiver_drop_does_not_cancel_shared_task() {
        let registry = Arc::new(SynthesisFlights::new());
        let (initiator, task) = match registry.claim("shared-design").unwrap() {
            FlightClaim::New { receiver, task } => (receiver, task),
            FlightClaim::Follower(_) => panic!("first claim must create a task"),
        };
        drop(initiator);
        let follower = match registry.claim("shared-design").unwrap() {
            FlightClaim::Follower(receiver) => receiver,
            FlightClaim::New { .. } => panic!("task must outlive its initiating receiver"),
        };
        let expected = empty_test_design("shared-design");

        task.complete(Ok(Arc::clone(&expected)));
        let follower_design = wait_for_flight(follower).await.unwrap();
        assert!(Arc::ptr_eq(&follower_design, &expected));
        assert!(registry.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cancelled_shared_task_notifies_followers_and_releases_the_key() {
        let registry = Arc::new(SynthesisFlights::new());
        let task = match registry.claim("cancelled-design").unwrap() {
            FlightClaim::New { task, .. } => task,
            FlightClaim::Follower(_) => panic!("first claim must create a task"),
        };
        let follower = match registry.claim("cancelled-design").unwrap() {
            FlightClaim::Follower(receiver) => receiver,
            FlightClaim::New { .. } => panic!("second claim must follow"),
        };

        drop(task);
        let error = wait_for_flight(follower).await.unwrap_err();
        assert_eq!(error.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error.message, "shared synthesis task was cancelled");
        assert!(registry.entries.lock().unwrap().is_empty());
        assert!(matches!(
            registry.claim("cancelled-design"),
            Ok(FlightClaim::New { .. })
        ));
    }

    #[test]
    fn synthesis_flights_bound_distinct_keys_but_keep_existing_followers() {
        let registry = Arc::new(SynthesisFlights::new());
        let mut active = Vec::new();
        for index in 0..MAX_IN_FLIGHT_DESIGNS {
            match registry.claim(&format!("design-{index}")).unwrap() {
                FlightClaim::New { receiver, task } => active.push((receiver, task)),
                FlightClaim::Follower(_) => panic!("distinct key unexpectedly followed"),
            }
        }
        assert_eq!(
            registry.entries.lock().unwrap().len(),
            MAX_IN_FLIGHT_DESIGNS
        );
        assert!(matches!(
            registry.claim("overflow-design"),
            Err(FlightClaimError::AtCapacity)
        ));
        assert!(matches!(
            registry.claim("design-0"),
            Ok(FlightClaim::Follower(_))
        ));

        drop(active);
        assert!(registry.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn cache_recheck_after_claim_observes_a_completed_insert() {
        let cache = RwLock::new(DesignCache::new(
            2 * DESIGN_CACHE_MIN_ENTRY_BYTES,
            Duration::from_secs(60),
        ));
        assert!(cache_lookup(&cache, "design").await.is_none());
        let registry = Arc::new(SynthesisFlights::new());
        let task = match registry.claim("design").unwrap() {
            FlightClaim::New { task, .. } => task,
            FlightClaim::Follower(_) => panic!("first claim must create a task"),
        };

        // This models the race handled by the leader-side cache recheck: the
        // optimistic lookup missed, then another completed request inserted the
        // value before the newly claimed leader starts expensive work.
        let expected = empty_test_design("design");
        assert!(cache.write().await.insert(
            "design".to_owned(),
            Arc::clone(&expected),
            DESIGN_CACHE_MIN_ENTRY_BYTES,
        ));
        let cached = cache_lookup(&cache, "design").await.unwrap();
        assert!(Arc::ptr_eq(&cached, &expected));
        drop(task);
    }

    #[test]
    fn running_semaphore_allows_exactly_one_pipeline() {
        let state = AppState::default();
        let first = Arc::clone(&state.running).try_acquire_owned().unwrap();
        assert!(Arc::clone(&state.running).try_acquire_owned().is_err());

        drop(first);
        assert!(Arc::clone(&state.running).try_acquire_owned().is_ok());
    }

    #[tokio::test]
    async fn health_reports_static_build_and_yosys_metadata() {
        let response = app(AppState::new("Yosys test-version"))
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["yosys_version"], "Yosys test-version");
        assert!(
            body["commit"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );
    }

    async fn post_timing(state: &AppState, id: &str, body: serde_json::Value) -> Response {
        app(state.clone())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/design/{id}/timing"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn timing_model(response: Response) -> DelayModel {
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        serde_json::from_value(body["model"].clone()).unwrap()
    }

    #[tokio::test]
    async fn timing_endpoint_resolves_base_model_by_precedence() {
        let state = AppState::default();
        state.cache.write().await.insert(
            "d".to_owned(),
            empty_test_design("d"),
            DESIGN_CACHE_MIN_ENTRY_BYTES,
        );

        // Explicit profile is honored.
        let model = timing_model(
            post_timing(
                &state,
                "d",
                serde_json::json!({"profile": "ultrascale_plus"}),
            )
            .await,
        )
        .await;
        assert_eq!(model, DelayModel::ultrascale_plus());

        // A full override wins over a conflicting profile.
        let override_model = DelayModel::ice40();
        let model = timing_model(
            post_timing(
                &state,
                "d",
                serde_json::json!({"profile": "series7", "model": override_model}),
            )
            .await,
        )
        .await;
        assert_eq!(model, override_model);

        // No base given → the design's own synth-time model (default here).
        let model = timing_model(post_timing(&state, "d", serde_json::json!({})).await).await;
        assert_eq!(model, DelayModel::default());

        // Unknown design → 404.
        let missing = post_timing(&state, "nope", serde_json::json!({})).await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn capacity_error_returns_retry_after() {
        let error = ApiError::busy().into_response();
        assert_eq!(error.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            error.headers().get(header::RETRY_AFTER).unwrap(),
            SYNTHESIS_RETRY_AFTER_SECONDS.to_string().as_str()
        );
    }

    #[tokio::test]
    async fn saturated_flight_registry_rejects_before_starting_yosys() {
        let state = AppState::default();
        let mut active = Vec::new();
        for index in 0..MAX_IN_FLIGHT_DESIGNS {
            match state.flights.claim(&format!("active-{index}")).unwrap() {
                FlightClaim::New { receiver, task } => active.push((receiver, task)),
                FlightClaim::Follower(_) => panic!("distinct key unexpectedly followed"),
            }
        }
        let request = serde_json::json!({
            "files": [{"name": "top.sv", "content": "module top; endmodule"}],
            "top": "top",
            "mode": "rtl"
        });
        let response = app(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/synthesize")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.headers().get(header::RETRY_AFTER).unwrap(),
            SYNTHESIS_RETRY_AFTER_SECONDS.to_string().as_str()
        );
        drop(active);
    }

    #[tokio::test]
    async fn synthesized_design_that_cannot_be_retained_returns_507() {
        let state = AppState::with_cache_config(
            "Yosys test-version",
            DESIGN_CACHE_MIN_ENTRY_BYTES - 1,
            Duration::from_secs(60),
        );
        let request = serde_json::json!({
            "files": [{
                "name": "top.sv",
                "content": "module top(input logic a, output logic y); assign y = a; endmodule"
            }],
            "top": "top",
            "mode": "rtl"
        });
        let response = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/synthesize")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&request).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::INSUFFICIENT_STORAGE);
        assert!(state.cache.write().await.designs.is_empty());
        assert!(state.flights.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn cache_expires_entries_at_ttl_without_refreshing_on_hit() {
        let ttl = Duration::from_secs(10);
        let mut cache = DesignCache::new(2 * DESIGN_CACHE_MIN_ENTRY_BYTES, ttl);
        let now = Instant::now();
        cache.insert_at(
            "a".to_owned(),
            empty_test_design("a"),
            DESIGN_CACHE_MIN_ENTRY_BYTES,
            now,
        );
        assert!(
            cache
                .get_at("a", now + ttl - Duration::from_nanos(1))
                .is_some()
        );
        cache.insert_at(
            "b".to_owned(),
            empty_test_design("b"),
            DESIGN_CACHE_MIN_ENTRY_BYTES,
            now + Duration::from_secs(5),
        );
        assert!(cache.get_at("b", now + ttl).is_some());
        assert!(cache.get_at("a", now + ttl).is_none());
        assert_eq!(cache.total_bytes, DESIGN_CACHE_MIN_ENTRY_BYTES);
    }

    #[test]
    fn cache_evicts_fifo_to_stay_within_byte_budget() {
        let mut cache = DesignCache::new(2 * DESIGN_CACHE_MIN_ENTRY_BYTES, Duration::from_secs(60));
        let now = Instant::now();
        cache.insert_at(
            "a".to_owned(),
            empty_test_design("a"),
            DESIGN_CACHE_MIN_ENTRY_BYTES,
            now,
        );
        cache.insert_at(
            "b".to_owned(),
            empty_test_design("b"),
            DESIGN_CACHE_MIN_ENTRY_BYTES,
            now + Duration::from_secs(1),
        );
        assert!(cache.get_at("a", now + Duration::from_secs(2)).is_some());
        cache.insert_at(
            "c".to_owned(),
            empty_test_design("c"),
            DESIGN_CACHE_MIN_ENTRY_BYTES,
            now + Duration::from_secs(3),
        );
        assert!(cache.get_at("a", now + Duration::from_secs(4)).is_none());
        assert!(cache.get_at("b", now + Duration::from_secs(4)).is_some());
        assert!(cache.get_at("c", now + Duration::from_secs(4)).is_some());
        assert_eq!(cache.total_bytes, 2 * DESIGN_CACHE_MIN_ENTRY_BYTES);
    }

    #[test]
    fn cache_does_not_retain_an_entry_larger_than_its_budget() {
        let mut cache = DesignCache::new(DESIGN_CACHE_MIN_ENTRY_BYTES, Duration::from_secs(60));
        assert!(!cache.insert(
            "large".to_owned(),
            empty_test_design("large"),
            DESIGN_CACHE_MIN_ENTRY_BYTES + 1,
        ));
        assert!(cache.get("large").is_none());
        assert_eq!(cache.total_bytes, 0);
    }
}
