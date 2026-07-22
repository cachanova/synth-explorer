use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::fmt::Write as _;
#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tempfile::TempDir;
use thiserror::Error;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::time::timeout;

pub const DEFAULT_BIND: &str = "127.0.0.1:32123";
pub const LOCAL_APP_ORIGIN: &str = "http://127.0.0.1:32124";
pub const PROTOCOL_VERSION: u32 = 2;
const LOG_TAIL_LIMIT: usize = 64 * 1024;
const NETLIST_SIZE_LIMIT: u64 = 64 * 1024 * 1024;
const REQUEST_BODY_LIMIT: usize = 8 * 1024 * 1024;
const SOURCE_SIZE_LIMIT: usize = 4 * 1024 * 1024;
const TIMING_REPORT_SIZE_LIMIT: u64 = 256 * 1024;
const VIVADO_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(45);
const PART_MARKER: &str = "SYNTH_EXPLORER_PART\t";
const NETLIST_MARKER_NAME: &str = "netlist-complete.marker";
const TIMING_METADATA_NAME: &str = "vivado-timing.tsv";
const TIMING_REPORT_NAME: &str = "vivado-timing.rpt";
#[cfg(target_os = "linux")]
const VIVADO_LINUX_LIBRARY_CANDIDATES: &[&str] = &[
    "lib/lnx64.o/Ubuntu/24",
    "lib/lnx64.o/Ubuntu/22",
    "lib/lnx64.o/Rhel/10",
    "lib/lnx64.o/Rhel/9",
    "lib/lnx64.o/SuSE",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VivadoPart {
    pub name: String,
    pub family: String,
    pub speed: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct BridgeStatus {
    pub protocol_version: u32,
    pub bridge_version: &'static str,
    pub vivado_version: String,
    pub parts: Vec<VivadoPart>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SourceFile {
    pub name: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SynthesisRequest {
    pub files: Vec<SourceFile>,
    pub top: String,
    pub target: String,
    pub extra_args: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SynthesisResponse {
    pub top: String,
    pub target: String,
    pub netlist: String,
    pub log: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<VivadoTimingReport>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct VivadoTimingReport {
    pub data_path_delay_ns: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logic_delay_ns: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net_delay_ns: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logic_levels: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slack_ns: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requirement_ns: Option<f64>,
    pub startpoint: String,
    pub endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_type: Option<String>,
    pub report: String,
}

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("{0}")]
    Validation(String),
    #[error("vivado timed out")]
    Timeout { log: String },
    #[error("vivado failed")]
    Vivado { log: String },
    #[error("failed to run vivado: {0}")]
    Io(#[from] std::io::Error),
}

impl IntoResponse for BridgeError {
    fn into_response(self) -> Response {
        let (status, message, log) = match self {
            Self::Validation(message) => (StatusCode::UNPROCESSABLE_ENTITY, message, None),
            Self::Timeout { log } => (
                StatusCode::GATEWAY_TIMEOUT,
                "vivado timed out".to_owned(),
                Some(log),
            ),
            Self::Vivado { log } => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "vivado failed".to_owned(),
                Some(log),
            ),
            Self::Io(error) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to run vivado: {error}"),
                None,
            ),
        };
        (
            status,
            Json(ErrorResponse {
                error: message,
                log,
            }),
        )
            .into_response()
    }
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    log: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    status: Arc<BridgeStatus>,
    allowed_origins: Arc<HashSet<String>>,
    vivado_bin: Arc<PathBuf>,
    running: Arc<Semaphore>,
    website_seen: Arc<AtomicBool>,
}

impl AppState {
    pub fn new(
        status: BridgeStatus,
        allowed_origins: impl IntoIterator<Item = String>,
        vivado_bin: PathBuf,
    ) -> Self {
        Self {
            status: Arc::new(status),
            allowed_origins: Arc::new(allowed_origins.into_iter().collect()),
            vivado_bin: Arc::new(vivado_bin),
            running: Arc::new(Semaphore::new(1)),
            website_seen: Arc::new(AtomicBool::new(false)),
        }
    }
}

pub fn bridge_allowed_origins(additional: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut origins = vec![
        "https://synthexplorer.dev".to_owned(),
        "https://www.synthexplorer.dev".to_owned(),
        LOCAL_APP_ORIGIN.to_owned(),
    ];
    origins.extend(additional);
    origins
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/v1/status", get(status).options(preflight))
        .route("/v1/synthesize", post(synthesize).options(preflight))
        .layer(DefaultBodyLimit::max(REQUEST_BODY_LIMIT))
        .with_state(state)
}

async fn preflight(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let origin = match allowed_origin(&state, &headers) {
        Ok(origin) => origin,
        Err(error) => return error.into_response(),
    };
    with_cors(StatusCode::NO_CONTENT.into_response(), origin)
}

async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let origin = match allowed_origin(&state, &headers) {
        Ok(origin) => origin,
        Err(error) => return error.into_response(),
    };
    if !state.website_seen.swap(true, Ordering::Relaxed) {
        println!("Website connected: {origin}");
    }
    with_cors(Json(state.status.as_ref().clone()).into_response(), origin)
}

async fn synthesize(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<SynthesisRequest>,
) -> Response {
    let origin = match allowed_origin(&state, &headers) {
        Ok(origin) => origin,
        Err(error) => return error.into_response(),
    };
    let validated = match validate_request(request, &state.status.parts) {
        Ok(request) => request,
        Err(error) => return with_cors(error.into_response(), origin),
    };
    let permit = match state.running.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            return with_cors(
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(ErrorResponse {
                        error: "a vivado synthesis is already running".to_owned(),
                        log: None,
                    }),
                )
                    .into_response(),
                origin,
            );
        }
    };
    println!(
        "Vivado synthesis started: top={} target={}",
        validated.top, validated.target
    );
    let result = run_vivado(&state.vivado_bin, &validated).await;
    match &result {
        Ok(_) => println!("Vivado synthesis completed: top={}", validated.top),
        Err(error) => eprintln!(
            "Vivado synthesis failed: top={} error={error}",
            validated.top
        ),
    }
    drop(permit);
    with_cors(
        match result {
            Ok(result) => Json(result).into_response(),
            Err(error) => error.into_response(),
        },
        origin,
    )
}

struct AuthFailure<'a> {
    status: StatusCode,
    message: &'static str,
    origin: Option<&'a str>,
}

impl AuthFailure<'_> {
    fn into_response(self) -> Response {
        let response = (
            self.status,
            Json(ErrorResponse {
                error: self.message.to_owned(),
                log: None,
            }),
        )
            .into_response();
        match self.origin {
            Some(origin) => with_cors(response, origin),
            None => response,
        }
    }
}

fn allowed_origin<'a>(
    state: &AppState,
    headers: &'a HeaderMap,
) -> Result<&'a str, AuthFailure<'a>> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if state.allowed_origins.contains(origin) {
        Ok(origin)
    } else {
        Err(AuthFailure {
            status: StatusCode::FORBIDDEN,
            message: "origin is not allowed by this Vivado bridge",
            origin: None,
        })
    }
}

fn with_cors(mut response: Response, origin: &str) -> Response {
    let headers = response.headers_mut();
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type"),
    );
    headers.insert(
        HeaderName::from_static("access-control-allow-private-network"),
        HeaderValue::from_static("true"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    response
}

#[derive(Clone, Debug)]
struct ValidatedRequest {
    files: Vec<SourceFile>,
    top: String,
    target: String,
    extra_args: Vec<String>,
}

fn validate_request(
    mut request: SynthesisRequest,
    installed_parts: &[VivadoPart],
) -> Result<ValidatedRequest, BridgeError> {
    if request.files.is_empty() {
        return Err(validation("at least one source file is required"));
    }
    if request.files.len() > 64 {
        return Err(validation("at most 64 source files are supported"));
    }
    let mut total_size = 0usize;
    let mut names = HashSet::new();
    for file in &request.files {
        validate_filename(&file.name)?;
        if !names.insert(file.name.clone()) {
            return Err(validation(format!(
                "duplicate source filename: {}",
                file.name
            )));
        }
        total_size = total_size.saturating_add(file.content.len());
    }
    if total_size > SOURCE_SIZE_LIMIT {
        return Err(validation("source files exceed the 4 MiB limit"));
    }
    if !valid_identifier(&request.top) {
        return Err(validation(format!(
            "invalid top module or entity: {}",
            request.top
        )));
    }
    if !installed_parts
        .iter()
        .any(|part| part.name == request.target)
    {
        return Err(validation("Vivado target is not installed locally"));
    }
    let extra_args = parse_extra_args(request.extra_args.take().as_deref())?;
    if extra_args.iter().any(|arg| {
        matches!(arg.as_str(), "-top" | "-part")
            || arg.starts_with("-top=")
            || arg.starts_with("-part=")
    }) {
        return Err(validation(
            "Vivado top and part must use the dedicated request fields",
        ));
    }
    Ok(ValidatedRequest {
        files: request.files,
        top: request.top,
        target: request.target,
        extra_args,
    })
}

fn validate_filename(name: &str) -> Result<(), BridgeError> {
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        || !matches!(
            Path::new(name)
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("v" | "sv" | "svh" | "vhd" | "vhdl")
        )
    {
        return Err(validation(format!("invalid source filename: {name}")));
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'$'))
}

fn valid_part_field(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn parse_extra_args(value: Option<&str>) -> Result<Vec<String>, BridgeError> {
    value
        .unwrap_or_default()
        .split_whitespace()
        .map(|token| {
            if token.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'_' | b'+' | b'=' | b'.' | b',' | b':' | b'-')
            }) {
                Ok(token.to_owned())
            } else {
                Err(validation(format!(
                    "invalid Vivado argument token: {token}"
                )))
            }
        })
        .collect()
}

fn validation(message: impl Into<String>) -> BridgeError {
    BridgeError::Validation(message.into())
}

pub async fn preflight_vivado(vivado_bin: &Path) -> Result<BridgeStatus, BridgeError> {
    let mut version_command = Command::new(vivado_bin);
    version_command.arg("-version").kill_on_drop(true);
    apply_vivado_environment(&mut version_command, vivado_bin);
    let output = timeout(PREFLIGHT_TIMEOUT, version_command.output())
        .await
        .map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "Vivado version check timed out",
            )
        })??;
    if !output.status.success() {
        return Err(BridgeError::Vivado {
            log: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    let version = parse_version_banner(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Vivado returned no version banner",
            )
        })?
        .to_owned();
    let temp = TempDir::new()?;
    let script = temp.path().join("catalog.tcl");
    fs::write(
        &script,
        "set synth_explorer_catalog_fp [open {catalog.tsv} w]\n\
         foreach part [lsort [get_parts]] {\n\
         \tputs $synth_explorer_catalog_fp \"SYNTH_EXPLORER_PART\\t$part\\t[get_property FAMILY $part]\\t[get_property SPEED $part]\"\n\
         }\n\
         close $synth_explorer_catalog_fp\n",
    )
    .await?;
    let catalog_path = temp.path().join("catalog.tsv");
    let console_path = temp.path().join("vivado-catalog-console.log");
    let mut command = Command::new(vivado_bin);
    command
        .args([
            "-mode",
            "batch",
            "-nojournal",
            "-nolog",
            "-notrace",
            "-source",
        ])
        .arg(&script)
        .current_dir(temp.path())
        .kill_on_drop(true);
    apply_vivado_environment(&mut command, vivado_bin);
    let status = run_command(&mut command, PREFLIGHT_TIMEOUT, &console_path).await;
    let log = read_log_tail(&console_path).await.unwrap_or_default();
    match status {
        Ok(status) if status.success() => {}
        Ok(_) => return Err(BridgeError::Vivado { log }),
        Err(CommandFailure::Timeout) => return Err(BridgeError::Timeout { log }),
        Err(CommandFailure::Io(error)) => return Err(BridgeError::Io(error)),
    }
    let catalog = fs::read_to_string(catalog_path).await.unwrap_or_default();
    let parts = parse_part_catalog_with_diagnostic(&catalog, &log)?;
    Ok(BridgeStatus {
        protocol_version: PROTOCOL_VERSION,
        bridge_version: env!("CARGO_PKG_VERSION"),
        vivado_version: version,
        parts,
    })
}

pub fn resolve_vivado(explicit: Option<PathBuf>) -> PathBuf {
    if let Some(vivado) = explicit {
        return vivado;
    }
    if let Some(root) = env::var_os("XILINX_VIVADO") {
        let candidate = PathBuf::from(root).join("bin").join(vivado_executable());
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(vivado_executable())
}

fn vivado_executable() -> &'static str {
    if cfg!(windows) {
        "vivado.bat"
    } else {
        "vivado"
    }
}

fn parse_version_banner(output: &str) -> Option<&str> {
    output.lines().find_map(|line| {
        let line = line.trim();
        line.get(..7)
            .filter(|prefix| prefix.eq_ignore_ascii_case("vivado "))
            .map(|_| line)
    })
}

#[cfg(test)]
fn parse_part_catalog(output: &str) -> Result<Vec<VivadoPart>, BridgeError> {
    parse_part_catalog_with_diagnostic(output, "")
}

fn parse_part_catalog_with_diagnostic(
    output: &str,
    diagnostic: &str,
) -> Result<Vec<VivadoPart>, BridgeError> {
    let mut parts = output
        .lines()
        .filter_map(|line| line.trim().strip_prefix(PART_MARKER))
        .map(|line| {
            let fields = line.split('\t').collect::<Vec<_>>();
            if fields.len() != 3
                || !valid_part_field(fields[0], 128)
                || !valid_part_field(fields[1], 128)
                || !valid_part_field(fields[2], 32)
            {
                return Err(validation("Vivado returned an invalid part catalog entry"));
            }
            Ok(VivadoPart {
                name: fields[0].to_owned(),
                family: fields[1].to_owned(),
                speed: fields[2].to_owned(),
            })
        })
        .collect::<Result<Vec<_>, BridgeError>>()?;
    parts.sort_by(|left, right| (&left.family, &left.name).cmp(&(&right.family, &right.name)));
    parts.dedup_by(|left, right| left.name == right.name);
    if parts.is_empty() {
        let output = output.trim();
        let output = if output.is_empty() {
            diagnostic.trim()
        } else {
            output
        };
        let output = log_tail(output);
        if !output.is_empty() {
            return Err(validation(format!(
                "Vivado returned no part catalog. Output:\n{output}"
            )));
        }
        return Err(validation("Vivado returned an empty part catalog"));
    }
    Ok(parts)
}

fn log_tail(output: &str) -> &str {
    if output.len() <= LOG_TAIL_LIMIT {
        return output;
    }
    let mut start = output.len() - LOG_TAIL_LIMIT;
    while !output.is_char_boundary(start) {
        start += 1;
    }
    &output[start..]
}

#[cfg(target_os = "linux")]
fn apply_vivado_environment(command: &mut Command, vivado_bin: &Path) {
    let Some(value) =
        vivado_linux_library_path(vivado_bin, env::var_os("LD_LIBRARY_PATH").as_deref())
    else {
        return;
    };
    command.env("LD_LIBRARY_PATH", value);
}

#[cfg(target_os = "linux")]
fn vivado_linux_library_path(
    vivado_bin: &Path,
    existing: Option<&std::ffi::OsStr>,
) -> Option<std::ffi::OsString> {
    let lib_dir = bundled_vivado_linux_lib_dir(vivado_bin)?;
    let mut paths = vec![lib_dir];
    if let Some(existing) = existing {
        paths.extend(env::split_paths(existing));
    }
    env::join_paths(paths).ok()
}

#[cfg(not(target_os = "linux"))]
fn apply_vivado_environment(_command: &mut Command, _vivado_bin: &Path) {}

#[cfg(target_os = "linux")]
fn bundled_vivado_linux_lib_dir(vivado_bin: &Path) -> Option<PathBuf> {
    bundled_vivado_linux_lib_dir_with_path(vivado_bin, env::var_os("PATH").as_deref())
}

#[cfg(target_os = "linux")]
fn bundled_vivado_linux_lib_dir_with_path(
    vivado_bin: &Path,
    path_env: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    let executable = resolve_executable_path(vivado_bin, path_env)?;
    let root = executable.parent()?.parent()?;
    VIVADO_LINUX_LIBRARY_CANDIDATES
        .iter()
        .map(|relative| root.join(relative))
        .find(|dir| dir.join("libncurses.so.5").is_file() && dir.join("libtinfo.so.5").is_file())
}

#[cfg(target_os = "linux")]
fn resolve_executable_path(
    vivado_bin: &Path,
    path_env: Option<&std::ffi::OsStr>,
) -> Option<PathBuf> {
    let candidate = if vivado_bin.components().count() > 1 {
        vivado_bin.to_path_buf()
    } else {
        let name = vivado_bin.as_os_str();
        if name.is_empty() {
            return None;
        }
        env::split_paths(path_env?).find_map(|dir| {
            let candidate = dir.join(name);
            candidate.is_file().then_some(candidate)
        })?
    };
    Some(std::fs::canonicalize(&candidate).unwrap_or(candidate))
}

async fn run_vivado(
    vivado_bin: &Path,
    input: &ValidatedRequest,
) -> Result<SynthesisResponse, BridgeError> {
    let temp = TempDir::new()?;
    for file in &input.files {
        fs::write(temp.path().join(&file.name), &file.content).await?;
    }
    let tcl_path = temp.path().join("synthesize.tcl");
    fs::write(
        &tcl_path,
        build_tcl(
            input,
            "vivado-netlist.v",
            TIMING_METADATA_NAME,
            TIMING_REPORT_NAME,
        ),
    )
    .await?;
    let console_path = temp.path().join("vivado-console.log");
    let vivado_log_path = temp.path().join("vivado.log");
    let mut command = Command::new(vivado_bin);
    command
        .args(["-mode", "batch", "-nojournal", "-notrace", "-log"])
        .arg(&vivado_log_path)
        .arg("-source")
        .arg(&tcl_path)
        .current_dir(temp.path())
        .kill_on_drop(true);
    apply_vivado_environment(&mut command, vivado_bin);
    let status = run_command(&mut command, VIVADO_TIMEOUT, &console_path).await;
    let log = combined_log(&[&vivado_log_path, &console_path]).await;
    match status {
        Ok(status) if status.success() => {}
        Ok(_) => return Err(BridgeError::Vivado { log }),
        Err(CommandFailure::Timeout) => return Err(BridgeError::Timeout { log }),
        Err(CommandFailure::Io(error)) => return Err(BridgeError::Io(error)),
    }
    let marker = temp.path().join(NETLIST_MARKER_NAME);
    if fs::metadata(marker).await.is_err() {
        return Err(BridgeError::Vivado { log });
    }
    let netlist_path = temp.path().join("vivado-netlist.v");
    let netlist = read_netlist(&netlist_path).await?;
    let timing = read_timing(temp.path()).await?;
    Ok(SynthesisResponse {
        top: input.top.clone(),
        target: input.target.clone(),
        netlist,
        log,
        timing,
    })
}

fn build_tcl(
    input: &ValidatedRequest,
    output: &str,
    timing_metadata: &str,
    timing_report: &str,
) -> String {
    let mut script = String::new();
    for file in &input.files {
        match Path::new(&file.name)
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("v" | "sv") => {
                writeln!(&mut script, "read_verilog -sv {{{}}}", file.name).unwrap();
            }
            Some("vhd" | "vhdl") => {
                writeln!(&mut script, "read_vhdl -vhdl2008 {{{}}}", file.name).unwrap();
            }
            _ => {}
        }
    }
    write!(
        &mut script,
        "synth_design -top {{{}}} -part {{{}}} -flatten_hierarchy full",
        input.top, input.target,
    )
    .unwrap();
    if !input.extra_args.is_empty() {
        write!(&mut script, " {}", input.extra_args.join(" ")).unwrap();
    }
    writeln!(&mut script).unwrap();
    writeln!(
        &mut script,
        "proc synth_explorer_prop {{object prop}} {{\n\
         \tif {{[catch {{get_property $prop $object}} value]}} {{ return \"\" }}\n\
         \treturn $value\n\
         }}"
    )
    .unwrap();
    writeln!(
        &mut script,
        "report_timing -max_paths 1 -delay_type max -file {{{timing_report}}}"
    )
    .unwrap();
    writeln!(
        &mut script,
        "set synth_explorer_timing_fp [open {{{timing_metadata}}} w]"
    )
    .unwrap();
    writeln!(
        &mut script,
        "set synth_explorer_timing_paths [get_timing_paths -max_paths 1 -delay_type max]"
    )
    .unwrap();
    writeln!(
        &mut script,
        "if {{[llength $synth_explorer_timing_paths] > 0}} {{"
    )
    .unwrap();
    writeln!(
        &mut script,
        "\tset synth_explorer_path [lindex $synth_explorer_timing_paths 0]"
    )
    .unwrap();
    writeln!(
        &mut script,
        "\tputs $synth_explorer_timing_fp [join [list path \\\n\
         \t\t[synth_explorer_prop $synth_explorer_path DATAPATH_DELAY] \\\n\
         \t\t[synth_explorer_prop $synth_explorer_path DATAPATH_LOGIC_DELAY] \\\n\
         \t\t[synth_explorer_prop $synth_explorer_path DATAPATH_NET_DELAY] \\\n\
         \t\t[synth_explorer_prop $synth_explorer_path LOGIC_LEVELS] \\\n\
         \t\t[synth_explorer_prop $synth_explorer_path SLACK] \\\n\
         \t\t[synth_explorer_prop $synth_explorer_path REQUIREMENT] \\\n\
         \t\t[synth_explorer_prop $synth_explorer_path STARTPOINT_PIN] \\\n\
         \t\t[synth_explorer_prop $synth_explorer_path ENDPOINT_PIN] \\\n\
         \t\t[synth_explorer_prop $synth_explorer_path GROUP] \\\n\
         \t\t[synth_explorer_prop $synth_explorer_path CORNER] \\\n\
         \t\t[synth_explorer_prop $synth_explorer_path DELAY_TYPE]] \"\\t\"]"
    )
    .unwrap();
    writeln!(&mut script, "}} else {{").unwrap();
    writeln!(&mut script, "\tputs $synth_explorer_timing_fp none").unwrap();
    writeln!(&mut script, "}}").unwrap();
    writeln!(&mut script, "close $synth_explorer_timing_fp").unwrap();
    writeln!(
        &mut script,
        "write_verilog -force -mode funcsim {{{output}}}"
    )
    .unwrap();
    writeln!(&mut script, "close [open {{{NETLIST_MARKER_NAME}}} w]").unwrap();
    script
}

async fn read_netlist(path: &Path) -> Result<String, BridgeError> {
    let metadata = fs::metadata(path).await?;
    if metadata.len() > NETLIST_SIZE_LIMIT {
        return Err(validation("Vivado netlist exceeded 64 MiB"));
    }
    let bytes = fs::read(path).await?;
    let start = line_start_offset(&bytes, b"`timescale")
        .ok_or_else(|| validation("Vivado netlist did not contain a `timescale directive"))?;
    let body = &bytes[start..];
    let end = line_start_offset(body, b"`ifndef GLBL").unwrap_or(body.len());
    Ok(String::from_utf8_lossy(&body[..end]).into_owned())
}

async fn read_timing(dir: &Path) -> Result<Option<VivadoTimingReport>, BridgeError> {
    let metadata = fs::read_to_string(dir.join(TIMING_METADATA_NAME)).await?;
    let line = metadata
        .lines()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| validation("Vivado timing metadata was empty"))?;
    if line.trim() == "none" {
        return Ok(None);
    }
    let fields = line.split('\t').collect::<Vec<_>>();
    if fields.len() != 12 || fields[0] != "path" {
        return Err(validation("Vivado returned invalid timing metadata"));
    }
    let report = read_timing_report(&dir.join(TIMING_REPORT_NAME)).await?;
    Ok(Some(VivadoTimingReport {
        data_path_delay_ns: required_finite_f64(fields[1], "data path delay")?,
        logic_delay_ns: optional_finite_f64(fields[2], "logic delay")?,
        net_delay_ns: optional_finite_f64(fields[3], "net delay")?,
        logic_levels: optional_u32(fields[4], "logic levels")?,
        slack_ns: optional_finite_f64(fields[5], "slack")?,
        requirement_ns: optional_finite_f64(fields[6], "requirement")?,
        startpoint: required_timing_text(fields[7], "startpoint")?,
        endpoint: required_timing_text(fields[8], "endpoint")?,
        path_group: optional_timing_text(fields[9]),
        corner: optional_timing_text(fields[10]),
        delay_type: optional_timing_text(fields[11]),
        report,
    }))
}

async fn read_timing_report(path: &Path) -> Result<String, BridgeError> {
    let metadata = fs::metadata(path).await?;
    if metadata.len() > TIMING_REPORT_SIZE_LIMIT {
        return Err(validation("Vivado timing report exceeded 256 KiB"));
    }
    let bytes = fs::read(path).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn required_finite_f64(value: &str, label: &str) -> Result<f64, BridgeError> {
    let parsed = value
        .trim()
        .parse::<f64>()
        .map_err(|_| validation(format!("Vivado timing {label} was not numeric")))?;
    if parsed.is_finite() && parsed >= 0.0 {
        Ok(parsed)
    } else {
        Err(validation(format!("Vivado timing {label} was not finite")))
    }
}

fn optional_finite_f64(value: &str, label: &str) -> Result<Option<f64>, BridgeError> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let parsed = value
        .parse::<f64>()
        .map_err(|_| validation(format!("Vivado timing {label} was not numeric")))?;
    if parsed.is_finite() {
        Ok(Some(parsed))
    } else {
        Ok(None)
    }
}

fn optional_u32(value: &str, label: &str) -> Result<Option<u32>, BridgeError> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    value
        .parse::<u32>()
        .map(Some)
        .map_err(|_| validation(format!("Vivado timing {label} was not numeric")))
}

fn required_timing_text(value: &str, label: &str) -> Result<String, BridgeError> {
    optional_timing_text(value)
        .ok_or_else(|| validation(format!("Vivado timing {label} was empty")))
}

fn optional_timing_text(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value == "(none)" {
        return None;
    }
    Some(value.chars().take(512).collect())
}

fn line_start_offset(bytes: &[u8], marker: &[u8]) -> Option<usize> {
    if bytes.starts_with(marker) {
        return Some(0);
    }
    bytes
        .windows(marker.len() + 1)
        .position(|window| window[0] == b'\n' && &window[1..] == marker)
        .map(|offset| offset + 1)
}

enum CommandFailure {
    Timeout,
    Io(std::io::Error),
}

async fn run_command(
    command: &mut Command,
    duration: Duration,
    console_path: &Path,
) -> Result<std::process::ExitStatus, CommandFailure> {
    let console = std::fs::File::create(console_path).map_err(CommandFailure::Io)?;
    command
        .stdout(Stdio::from(
            console.try_clone().map_err(CommandFailure::Io)?,
        ))
        .stderr(Stdio::from(console));
    configure_child(command);
    let mut child = command.spawn().map_err(CommandFailure::Io)?;
    let mut process_group = ProcessGroupGuard::new(&child);
    match timeout(duration, child.wait()).await {
        Ok(result) => {
            let status = result.map_err(CommandFailure::Io)?;
            process_group.disarm();
            Ok(status)
        }
        Err(_) => {
            process_group.kill();
            #[cfg(not(target_os = "linux"))]
            let _ = child.kill().await;
            let _ = child.wait().await;
            process_group.disarm();
            Err(CommandFailure::Timeout)
        }
    }
}

#[cfg(target_os = "linux")]
fn configure_child(command: &mut Command) {
    command.as_std_mut().process_group(0);
}

#[cfg(not(target_os = "linux"))]
fn configure_child(_command: &mut Command) {}

struct ProcessGroupGuard {
    #[cfg(target_os = "linux")]
    pgid: Option<i32>,
}

impl ProcessGroupGuard {
    fn new(_child: &tokio::process::Child) -> Self {
        Self {
            #[cfg(target_os = "linux")]
            pgid: _child.id().and_then(|id| i32::try_from(id).ok()),
        }
    }

    fn kill(&self) {
        #[cfg(target_os = "linux")]
        if let Some(pgid) = self.pgid {
            // SAFETY: the negative PID targets the isolated Vivado process group.
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }

    fn disarm(&mut self) {
        #[cfg(target_os = "linux")]
        {
            self.pgid = None;
        }
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

async fn read_log_tail(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path).await?;
    let len = file.metadata().await?.len();
    let start = len.saturating_sub(LOG_TAIL_LIMIT as u64);
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn combined_log(paths: &[&Path]) -> String {
    let mut log = String::new();
    for path in paths {
        if let Ok(part) = read_log_tail(path).await {
            if !log.is_empty() && !part.is_empty() {
                log.push('\n');
            }
            log.push_str(&part);
        }
    }
    if log.len() > LOG_TAIL_LIMIT {
        log.split_off(log.len() - LOG_TAIL_LIMIT)
    } else {
        log
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::PermissionsExt;
    use tower::ServiceExt;

    fn part() -> VivadoPart {
        VivadoPart {
            name: "xc7a35tcpg236-1".to_owned(),
            family: "artix7".to_owned(),
            speed: "-1".to_owned(),
        }
    }

    fn state() -> AppState {
        AppState::new(
            BridgeStatus {
                protocol_version: PROTOCOL_VERSION,
                bridge_version: "test",
                vivado_version: "Vivado v2026.1".to_owned(),
                parts: vec![part()],
            },
            ["https://synthexplorer.dev".to_owned()],
            PathBuf::from("vivado"),
        )
    }

    #[tokio::test]
    async fn status_requires_allowed_origin_without_a_pairing_code() {
        let app = app(state());
        let denied = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/v1/status")
                    .header(header::ORIGIN, "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);

        let allowed = app
            .oneshot(
                Request::builder()
                    .uri("/v1/status")
                    .header(header::ORIGIN, "https://synthexplorer.dev")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
        assert_eq!(
            allowed.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://synthexplorer.dev",
        );
        let body = allowed.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["protocol_version"], PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn downloadable_local_app_origin_is_allowed_by_default() {
        let state = AppState::new(
            BridgeStatus {
                protocol_version: PROTOCOL_VERSION,
                bridge_version: "test",
                vivado_version: "Vivado v2026.1".to_owned(),
                parts: vec![part()],
            },
            bridge_allowed_origins([]),
            PathBuf::from("vivado"),
        );
        let response = app(state)
            .oneshot(
                Request::builder()
                    .uri("/v1/status")
                    .header(header::ORIGIN, LOCAL_APP_ORIGIN)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            LOCAL_APP_ORIGIN,
        );
    }

    #[test]
    fn validation_rejects_paths_uninstalled_targets_and_tcl_tokens() {
        let request = |name: &str, target: &str, extra_args: Option<&str>| SynthesisRequest {
            files: vec![SourceFile {
                name: name.to_owned(),
                content: "module top; endmodule".to_owned(),
            }],
            top: "top".to_owned(),
            target: target.to_owned(),
            extra_args: extra_args.map(str::to_owned),
        };
        assert!(validate_request(request("../top.sv", &part().name, None), &[part()]).is_err());
        assert!(validate_request(request("top.sv", "xc7unknown", None), &[part()]).is_err());
        assert!(
            validate_request(
                request("top.sv", &part().name, Some("-directive;exec")),
                &[part()]
            )
            .is_err()
        );
        assert!(
            validate_request(
                request("top.sv", &part().name, Some("-part other")),
                &[part()]
            )
            .is_err()
        );
    }

    #[test]
    fn tcl_reads_sources_and_uses_only_validated_top_and_part() {
        let input = validate_request(
            SynthesisRequest {
                files: vec![
                    SourceFile {
                        name: "defs.svh".to_owned(),
                        content: String::new(),
                    },
                    SourceFile {
                        name: "top.sv".to_owned(),
                        content: String::new(),
                    },
                ],
                top: "top".to_owned(),
                target: part().name.clone(),
                extra_args: Some("-mode out_of_context -retiming".to_owned()),
            },
            &[part()],
        )
        .unwrap();
        let script = build_tcl(
            &input,
            "vivado-netlist.v",
            "vivado-timing.tsv",
            "vivado-timing.rpt",
        );
        assert!(!script.contains("read_verilog -sv {defs.svh}"));
        assert!(script.contains("read_verilog -sv {top.sv}"));
        assert!(script.contains(
            "synth_design -top {top} -part {xc7a35tcpg236-1} -flatten_hierarchy full -mode out_of_context -retiming"
        ));
        assert!(
            script.contains("report_timing -max_paths 1 -delay_type max -file {vivado-timing.rpt}")
        );
        assert!(script.contains("get_timing_paths -max_paths 1 -delay_type max"));
        assert!(script.contains("write_verilog -force -mode funcsim {vivado-netlist.v}"));
    }

    #[test]
    fn tcl_preserves_source_order_for_vhdl_dependencies() {
        let input = validate_request(
            SynthesisRequest {
                files: vec![
                    SourceFile {
                        name: "types.vhd".to_owned(),
                        content: String::new(),
                    },
                    SourceFile {
                        name: "core.vhdl".to_owned(),
                        content: String::new(),
                    },
                ],
                top: "core".to_owned(),
                target: part().name.clone(),
                extra_args: None,
            },
            &[part()],
        )
        .unwrap();
        let script = build_tcl(
            &input,
            "vivado-netlist.v",
            "vivado-timing.tsv",
            "vivado-timing.rpt",
        );
        let types = script.find("read_vhdl -vhdl2008 {types.vhd}").unwrap();
        let core = script.find("read_vhdl -vhdl2008 {core.vhdl}").unwrap();
        assert!(types < core);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn vivado_environment_resolves_bundled_linux_compatibility_libraries() {
        let temp = TempDir::new().unwrap();
        let executable = temp.path().join("Vivado/bin/vivado");
        let lib_dir = temp.path().join("Vivado/lib/lnx64.o/Ubuntu/24");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&lib_dir).unwrap();
        std::fs::write(&executable, "").unwrap();
        std::fs::write(lib_dir.join("libncurses.so.5"), "").unwrap();
        std::fs::write(lib_dir.join("libtinfo.so.5"), "").unwrap();

        assert_eq!(bundled_vivado_linux_lib_dir(&executable), Some(lib_dir));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn vivado_environment_resolves_bare_path_and_symlinked_executable() {
        let temp = TempDir::new().unwrap();
        let executable = temp.path().join("Vivado/bin/vivado");
        let lib_dir = temp.path().join("Vivado/lib/lnx64.o/Ubuntu/24");
        let path_dir = temp.path().join("path-bin");
        let symlink = path_dir.join("vivado");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&lib_dir).unwrap();
        std::fs::create_dir_all(&path_dir).unwrap();
        std::fs::write(&executable, "").unwrap();
        std::fs::write(lib_dir.join("libncurses.so.5"), "").unwrap();
        std::fs::write(lib_dir.join("libtinfo.so.5"), "").unwrap();
        std::os::unix::fs::symlink(&executable, &symlink).unwrap();

        assert_eq!(
            bundled_vivado_linux_lib_dir_with_path(Path::new("vivado"), Some(path_dir.as_os_str())),
            Some(lib_dir)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn vivado_environment_prepends_bundled_libraries_before_inherited_paths() {
        let temp = TempDir::new().unwrap();
        let executable = temp.path().join("Vivado/bin/vivado");
        let lib_dir = temp.path().join("Vivado/lib/lnx64.o/Ubuntu/24");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&lib_dir).unwrap();
        std::fs::write(&executable, "").unwrap();
        std::fs::write(lib_dir.join("libncurses.so.5"), "").unwrap();
        std::fs::write(lib_dir.join("libtinfo.so.5"), "").unwrap();

        let value = vivado_linux_library_path(
            &executable,
            Some(std::ffi::OsStr::new("/existing/one:/existing/two")),
        )
        .unwrap();
        assert_eq!(
            env::split_paths(&value).collect::<Vec<_>>(),
            vec![
                lib_dir,
                PathBuf::from("/existing/one"),
                PathBuf::from("/existing/two"),
            ]
        );
    }

    #[test]
    fn part_catalog_reports_non_marker_vivado_output() {
        let output = "application-specific initialization failed: couldn't load file \"libxv_commontasks.so\": libncurses.so.5: cannot open shared object file";
        let error = parse_part_catalog(output).unwrap_err();

        assert_eq!(
            error.to_string(),
            format!("Vivado returned no part catalog. Output:\n{output}")
        );
    }

    #[test]
    fn part_catalog_error_keeps_only_bounded_output_tail() {
        let output = format!("head{}", "x".repeat(LOG_TAIL_LIMIT + 128));
        let error = parse_part_catalog(&output).unwrap_err().to_string();

        assert!(!error.contains("head"));
        assert!(error.ends_with(&"x".repeat(LOG_TAIL_LIMIT)));
    }

    #[test]
    fn part_catalog_reports_empty_vivado_output() {
        let error = parse_part_catalog("").unwrap_err();

        assert_eq!(error.to_string(), "Vivado returned an empty part catalog");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn fake_vivado_runs_preflight_and_synthesis_as_child_processes() {
        let temp = TempDir::new().unwrap();
        let executable = temp.path().join("Vivado/bin/vivado");
        let lib_dir = temp.path().join("Vivado/lib/lnx64.o/Ubuntu/24");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&lib_dir).unwrap();
        std::fs::write(lib_dir.join("libncurses.so.5"), "").unwrap();
        std::fs::write(lib_dir.join("libtinfo.so.5"), "").unwrap();
        fs::write(
            &executable,
            format!(
                r#"#!/bin/sh
first=${{LD_LIBRARY_PATH%%:*}}
if [ "$first" != "{lib_dir}" ]; then
  echo 'Vivado support library path was not first' >&2
  exit 7
fi
if [ "$1" = "-version" ]; then
  echo 'Vivado v2026.1 (64-bit)'
  exit 0
fi
case "$*" in
  *catalog.tcl*)
    printf 'SYNTH_EXPLORER_PART\txc7a35tcpg236-1\tartix7\t-1\n' > catalog.tsv
    ;;
  *)
    printf 'fake synthesis complete\n'
    printf '\140timescale 1 ps / 1 ps\nmodule top; endmodule\n' > vivado-netlist.v
    printf 'path\t4.016\t3.216\t0.800\t2\t\t\tq_reg[0]/C\tq[0]\t(none)\tSlow\tmax\n' > vivado-timing.tsv
    printf 'Timing Report\n\nSlack:                    inf\n  Data Path Delay:        4.016ns  (logic 3.216ns route 0.800ns)\n' > vivado-timing.rpt
    : > netlist-complete.marker
    ;;
esac
"#,
                lib_dir = lib_dir.display()
            ),
        )
        .await
        .unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let status = preflight_vivado(&executable).await.unwrap();
        assert_eq!(status.vivado_version, "Vivado v2026.1 (64-bit)");
        assert_eq!(status.parts, vec![part()]);

        let input = validate_request(
            SynthesisRequest {
                files: vec![SourceFile {
                    name: "top.sv".to_owned(),
                    content: "module top; endmodule".to_owned(),
                }],
                top: "top".to_owned(),
                target: part().name,
                extra_args: None,
            },
            &status.parts,
        )
        .unwrap();
        let result = run_vivado(&executable, &input).await.unwrap();
        assert!(result.netlist.starts_with("`timescale 1 ps / 1 ps"));
        assert!(result.log.contains("fake synthesis complete"));
        assert_eq!(
            result.timing,
            Some(VivadoTimingReport {
                data_path_delay_ns: 4.016,
                logic_delay_ns: Some(3.216),
                net_delay_ns: Some(0.800),
                logic_levels: Some(2),
                slack_ns: None,
                requirement_ns: None,
                startpoint: "q_reg[0]/C".to_owned(),
                endpoint: "q[0]".to_owned(),
                path_group: None,
                corner: Some("Slow".to_owned()),
                delay_type: Some("max".to_owned()),
                report: "Timing Report\n\nSlack:                    inf\n  Data Path Delay:        4.016ns  (logic 3.216ns route 0.800ns)\n".to_owned(),
            })
        );
    }
}
