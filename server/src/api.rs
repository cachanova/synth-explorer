use crate::analysis::{
    Analysis, ConeDir, ConeOptions, EndpointsResponse, FanoutResponse, NodeRef, PathsResponse,
    SourceLineIndex, SourceMapResponse, Stats, Subgraph, node_ref,
};
use crate::graph::Graph;
use crate::netlist::{parse_value, select_top};
use crate::yosys::{SourceFile, SynthMode, SynthRequest, YosysError, run_yosys};
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone, Default)]
pub struct AppState {
    cache: Arc<RwLock<DesignCache>>,
}

const DESIGN_CACHE_CAP: usize = 32;

#[derive(Debug, Default)]
struct DesignCache {
    designs: HashMap<String, Arc<Design>>,
    order: VecDeque<String>,
}

impl DesignCache {
    fn get(&self, id: &str) -> Option<Arc<Design>> {
        self.designs.get(id).cloned()
    }

    fn insert(&mut self, id: String, design: Arc<Design>) {
        if let Some(existing) = self.designs.get_mut(&id) {
            *existing = design;
            return;
        }
        if self.designs.len() == DESIGN_CACHE_CAP
            && let Some(oldest) = self.order.pop_front()
        {
            self.designs.remove(&oldest);
        }
        // FIFO eviction keeps cache bookkeeping cheap; cache hits do not refresh order.
        self.order.push_back(id.clone());
        self.designs.insert(id, design);
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

#[derive(Debug)]
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
    if let Some(design) = state.cache.read().await.get(&design_id) {
        return Ok(Json(design.response.clone()));
    }

    let output = run_yosys(&validated).await.map_err(map_yosys_error)?;
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
    let analysis = Analysis::new(&graph, validated.file_names());
    let (_, source_module) = select_top(&source_parsed, None).map_err(|err| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to resolve source-provenance top module: {err}"),
        )
    })?;
    let source_index = SourceLineIndex::from_module(source_module, validated.file_names());
    let response = SynthesizeResponse {
        design_id: design_id.clone(),
        top: output.resolved_top,
        mode: mode_string(validated.mode),
        stats: analysis.stats(),
        warnings: analysis.warnings(),
        log: output.log,
    };
    let design = Arc::new(Design {
        response: response.clone(),
        graph,
        analysis,
        source_index,
    });
    state.cache.write().await.insert(design_id, design);
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
        .read()
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
