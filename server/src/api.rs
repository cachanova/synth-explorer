use crate::analysis::{
    Analysis, ConeDir, ConeOptions, EndpointsResponse, FanoutResponse, NodeRef, PathsResponse,
    SourceMapResponse, Stats, Subgraph, node_ref,
};
use crate::graph::Graph;
use crate::netlist::{parse_value, select_top};
use crate::yosys::{SourceFile, SynthMode, SynthRequest, YosysError, run_yosys};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderValue, Method, Request, StatusCode, header};
use axum::middleware::{Next, from_fn};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct AppState {
    cache: Arc<RwLock<DesignCache>>,
    admission: SynthesisAdmission,
    metadata: Arc<BuildMetadata>,
}

const DESIGN_CACHE_BUDGET_BYTES: usize = 128 * 1024 * 1024;
const DESIGN_CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const DESIGN_CACHE_MIN_ENTRY_BYTES: usize = 64 * 1024;
const MAX_RUNNING_SYNTHESES: usize = 1;
const MAX_QUEUED_SYNTHESES: usize = 2;
const SYNTHESIS_RETRY_AFTER_SECONDS: u64 = 5;

impl Default for AppState {
    fn default() -> Self {
        Self::new("unknown")
    }
}

impl AppState {
    pub fn new(yosys_version: impl Into<String>) -> Self {
        Self {
            cache: Arc::new(RwLock::new(DesignCache::new(
                DESIGN_CACHE_BUDGET_BYTES,
                DESIGN_CACHE_TTL,
            ))),
            admission: SynthesisAdmission::new(),
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

#[derive(Clone, Debug)]
struct SynthesisAdmission {
    admitted: Arc<Semaphore>,
    running: Arc<Semaphore>,
}

impl SynthesisAdmission {
    fn new() -> Self {
        Self {
            admitted: Arc::new(Semaphore::new(MAX_RUNNING_SYNTHESES + MAX_QUEUED_SYNTHESES)),
            running: Arc::new(Semaphore::new(MAX_RUNNING_SYNTHESES)),
        }
    }

    fn try_reserve(&self) -> Result<OwnedSemaphorePermit, ApiError> {
        self.admitted
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::busy())
    }

    async fn wait_to_run(&self) -> OwnedSemaphorePermit {
        self.running
            .clone()
            .acquire_owned()
            .await
            .expect("synthesis semaphore is never closed")
    }
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
    approximate_bytes: usize,
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

    fn insert(&mut self, id: String, design: Arc<Design>, approximate_bytes: usize) {
        self.insert_at(id, design, approximate_bytes, Instant::now());
    }

    fn insert_at(
        &mut self,
        id: String,
        design: Arc<Design>,
        approximate_bytes: usize,
        now: Instant,
    ) {
        let approximate_bytes = approximate_bytes.max(DESIGN_CACHE_MIN_ENTRY_BYTES);
        self.evict_expired(now);
        self.remove(&id);
        if approximate_bytes > self.budget_bytes {
            return;
        }
        while self.total_bytes.saturating_add(approximate_bytes) > self.budget_bytes {
            if !self.evict_oldest() {
                break;
            }
        }
        // FIFO eviction keeps cache bookkeeping cheap; cache hits do not refresh order.
        self.order.push_back((id.clone(), now));
        self.total_bytes += approximate_bytes;
        self.designs.insert(
            id,
            CachedDesign {
                design,
                approximate_bytes,
                inserted_at: now,
            },
        );
    }

    fn remove(&mut self, id: &str) {
        if let Some(entry) = self.designs.remove(id) {
            self.total_bytes = self.total_bytes.saturating_sub(entry.approximate_bytes);
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

#[derive(Debug)]
struct Design {
    response: SynthesizeResponse,
    graph: Graph,
    analysis: Analysis,
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

#[derive(Debug)]
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
        .route("/design/{id}/paths", get(paths))
        .route("/design/{id}/cone", get(cone))
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
    if let Some(design) = state.cache.write().await.get(&design_id) {
        tracing::info!(design_id, mode, cache_hit = true, "synthesis_complete");
        return Ok(Json(design.response.clone()));
    }

    let _admitted = state.admission.try_reserve()?;
    let _running = state.admission.wait_to_run().await;
    // A matching queued request may have completed while this request waited.
    if let Some(design) = state.cache.write().await.get(&design_id) {
        tracing::info!(design_id, mode, cache_hit = true, "synthesis_complete");
        return Ok(Json(design.response.clone()));
    }

    let started = Instant::now();
    let output = run_yosys(&validated).await.map_err(|err| {
        tracing::warn!(
            design_id,
            mode,
            latency_ms = started.elapsed().as_millis() as u64,
            error = %err,
            "synthesis_failed"
        );
        map_yosys_error(err)
    })?;
    let approximate_bytes = output
        .json_size
        .saturating_mul(4)
        .saturating_add(output.log.len());
    let parsed = parse_value(output.json).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to parse yosys netlist: {err}"),
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
    let analysis = Analysis::new(&graph, validated.file_names());
    let response = SynthesizeResponse {
        design_id: design_id.clone(),
        top: output.resolved_top,
        mode: mode.clone(),
        stats: analysis.stats(),
        warnings: analysis.warnings(),
        log: output.log,
    };
    let design = Arc::new(Design {
        response: response.clone(),
        graph,
        analysis,
    });
    state
        .cache
        .write()
        .await
        .insert(design_id.clone(), design, approximate_bytes);
    tracing::info!(
        design_id,
        mode,
        cache_hit = false,
        latency_ms = started.elapsed().as_millis() as u64,
        approximate_bytes,
        "synthesis_complete"
    );
    Ok(Json(response))
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
            },
        )
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "unknown node"))?;
    Ok(Json(subgraph))
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
        .map(|id| node_ref(&design.graph, id))
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
    state
        .cache
        .write()
        .await
        .get(id)
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
    use axum::body::Body;
    use http_body_util::BodyExt;
    use std::collections::HashMap;
    use tower::ServiceExt;

    fn empty_design(id: &str) -> Arc<Design> {
        let graph = Graph {
            nodes: Vec::new(),
            edges: Vec::new(),
            outgoing: Vec::new(),
            incoming: Vec::new(),
            top: "empty".to_owned(),
            net_names: HashMap::new(),
            net_aliases: HashMap::new(),
            cell_info: HashMap::new(),
            blackboxes: Vec::new(),
        };
        let analysis = Analysis::new(&graph, Vec::new());
        Arc::new(Design {
            response: SynthesizeResponse {
                design_id: id.to_owned(),
                top: "empty".to_owned(),
                mode: "rtl".to_owned(),
                stats: analysis.stats(),
                warnings: Vec::new(),
                log: String::new(),
            },
            graph,
            analysis,
        })
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

    #[tokio::test]
    async fn admission_allows_one_running_two_queued_then_retries() {
        let state = AppState::default();
        let running = state.admission.running.clone().try_acquire_owned().unwrap();
        assert!(state.admission.running.clone().try_acquire_owned().is_err());

        let reservations = (0..MAX_RUNNING_SYNTHESES + MAX_QUEUED_SYNTHESES)
            .map(|_| state.admission.try_reserve().unwrap())
            .collect::<Vec<_>>();
        let error = state.admission.try_reserve().unwrap_err().into_response();
        assert_eq!(error.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            error.headers().get(header::RETRY_AFTER).unwrap(),
            SYNTHESIS_RETRY_AFTER_SECONDS.to_string().as_str()
        );
        drop(reservations);
        drop(running);
    }

    #[tokio::test]
    async fn saturated_admission_rejects_before_starting_yosys() {
        let state = AppState::default();
        let _reservations = (0..MAX_RUNNING_SYNTHESES + MAX_QUEUED_SYNTHESES)
            .map(|_| state.admission.try_reserve().unwrap())
            .collect::<Vec<_>>();
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
    }

    #[test]
    fn cache_expires_entries_at_ttl_without_refreshing_on_hit() {
        let ttl = Duration::from_secs(10);
        let mut cache = DesignCache::new(2 * DESIGN_CACHE_MIN_ENTRY_BYTES, ttl);
        let now = Instant::now();
        cache.insert_at(
            "a".to_owned(),
            empty_design("a"),
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
            empty_design("b"),
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
            empty_design("a"),
            DESIGN_CACHE_MIN_ENTRY_BYTES,
            now,
        );
        cache.insert_at(
            "b".to_owned(),
            empty_design("b"),
            DESIGN_CACHE_MIN_ENTRY_BYTES,
            now + Duration::from_secs(1),
        );
        assert!(cache.get_at("a", now + Duration::from_secs(2)).is_some());
        cache.insert_at(
            "c".to_owned(),
            empty_design("c"),
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
        cache.insert(
            "large".to_owned(),
            empty_design("large"),
            DESIGN_CACHE_MIN_ENTRY_BYTES + 1,
        );
        assert!(cache.get("large").is_none());
        assert_eq!(cache.total_bytes, 0);
    }
}
