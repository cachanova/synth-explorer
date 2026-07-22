use anyhow::{Context, bail};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    routing::post,
};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::env;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use synth_explorer_vivado_bridge::{
    AppState, BridgeError, BridgeStatus, app as vivado_app, bridge_allowed_origins,
    preflight_vivado, resolve_vivado,
};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tower_http::services::{ServeDir, ServeFile};

const DEFAULT_APP_BIND: &str = "127.0.0.1:32124";
const DEFAULT_BUILT_IN_VIVADO_BIND: &str = "127.0.0.1:32125";

#[derive(Clone)]
struct LauncherState {
    local_origin: String,
    vivado: Arc<Mutex<VivadoRuntime>>,
}

struct VivadoRuntime {
    configured_vivado: Option<PathBuf>,
    running: Option<RunningVivadoBridge>,
}

struct RunningVivadoBridge {
    status: BridgeStatus,
    task: JoinHandle<()>,
}

#[derive(Debug, Default, Deserialize)]
struct StartVivadoRequest {
    vivado: Option<String>,
}

#[derive(Debug, Serialize)]
struct StartVivadoError {
    error: String,
    path_required: bool,
}

impl LauncherState {
    fn new(configured_vivado: Option<PathBuf>, local_origin: String) -> Self {
        Self {
            local_origin,
            vivado: Arc::new(Mutex::new(VivadoRuntime {
                configured_vivado,
                running: None,
            })),
        }
    }
}

#[derive(Debug, Parser)]
#[command(
    name = "synth-explorer",
    about = "Run Synth Explorer locally in a dedicated Chrome window"
)]
struct Args {
    /// Vivado executable. Defaults to VIVADO_BIN, XILINX_VIVADO/bin/vivado, then vivado on PATH.
    #[arg(long, env = "VIVADO_BIN")]
    vivado: Option<PathBuf>,

    /// Chrome or Chromium executable. Defaults to CHROME_BIN, then common installation paths.
    #[arg(long, env = "CHROME_BIN")]
    chrome: Option<PathBuf>,

    /// Directory containing the packaged web application.
    #[arg(long)]
    web_root: Option<PathBuf>,

    /// Loopback address for the local web application.
    #[arg(long, default_value = DEFAULT_APP_BIND)]
    bind: SocketAddr,

    /// Serve the application without opening Chrome.
    #[arg(long)]
    no_open: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    if !args.bind.ip().is_loopback() {
        bail!("--bind must be a loopback address; refusing to expose the application");
    }

    let web_root = match args.web_root {
        Some(path) => path,
        None => default_web_root(&env::current_exe().context("failed to locate launcher")?)?,
    };
    validate_web_root(&web_root)?;

    let listener = TcpListener::bind(args.bind)
        .await
        .with_context(|| format!("failed to bind local application at {}", args.bind))?;
    let local_address = listener
        .local_addr()
        .context("failed to read local address")?;
    let origin = format!("http://{local_address}");
    let url = format!("{origin}/?launcher=1");

    println!("Synth Explorer local application");
    println!("  Application: {origin}");
    println!("  Files: {}", web_root.display());
    println!("  Vivado: starts when selected in the application");

    let launcher_state = LauncherState::new(args.vivado, origin.clone());

    if !args.no_open {
        open_chrome(args.chrome.as_deref(), &url)?;
        println!("Chrome opened. Keep this window open while using Synth Explorer.");
    } else {
        println!("Open {url}");
    }

    let server = axum::serve(listener, web_app(web_root, launcher_state));
    server
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("local application server failed")?;
    Ok(())
}

fn default_web_root(executable: &Path) -> anyhow::Result<PathBuf> {
    let directory = executable
        .parent()
        .context("launcher executable has no parent directory")?;
    Ok(directory.join("web"))
}

fn validate_web_root(web_root: &Path) -> anyhow::Result<()> {
    let index = web_root.join("index.html");
    if !index.is_file() {
        bail!(
            "packaged web application is missing {}; extract the complete download before running it",
            index.display(),
        );
    }
    Ok(())
}

fn web_app(web_root: PathBuf, launcher_state: LauncherState) -> Router {
    let index = web_root.join("index.html");
    let files = ServeDir::new(web_root).fallback(ServeFile::new(index));
    Router::new()
        .route("/launcher/vivado/start", post(start_vivado_bridge))
        .fallback_service(files)
        .with_state(launcher_state)
}

async fn start_vivado_bridge(
    State(state): State<LauncherState>,
    headers: HeaderMap,
    Json(request): Json<StartVivadoRequest>,
) -> Result<Json<BridgeStatus>, (StatusCode, Json<StartVivadoError>)> {
    let request_origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if request_origin != Some(state.local_origin.as_str()) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(StartVivadoError {
                error: "Vivado can only be started by this local Synth Explorer application"
                    .to_owned(),
                path_required: false,
            }),
        ));
    }

    let mut runtime = state.vivado.lock().await;
    if let Some(running) = runtime.running.as_ref()
        && !running.task.is_finished()
    {
        return Ok(Json(running.status.clone()));
    }
    runtime.running.take();

    let requested_vivado = request
        .vivado
        .map(|path| path.trim().to_owned())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let vivado = resolve_vivado(requested_vivado.or_else(|| runtime.configured_vivado.clone()));
    println!("  Vivado: start requested by the local application");
    println!("  Vivado: checking {}", vivado.display());
    let status = match preflight_vivado(&vivado).await {
        Ok(status) => status,
        Err(error) => {
            let path_required = matches!(
                &error,
                BridgeError::Io(source) if source.kind() == io::ErrorKind::NotFound
            );
            let message = if path_required {
                format!("Vivado was not found: {error}")
            } else {
                format!("Vivado could not start: {error}")
            };
            println!("  Vivado: unavailable ({error})");
            println!("  Yosys and GHDL remain fully available.");
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(StartVivadoError {
                    error: message,
                    path_required,
                }),
            ));
        }
    };

    let bridge_address: SocketAddr = DEFAULT_BUILT_IN_VIVADO_BIND
        .parse()
        .expect("valid bridge address");
    let listener = match TcpListener::bind(bridge_address).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            eprintln!("  Vivado: built-in connector port {bridge_address} is already in use");
            return Err((
                StatusCode::CONFLICT,
                Json(StartVivadoError {
                    error: format!("Vivado connector port {bridge_address} is already in use"),
                    path_required: false,
                }),
            ));
        }
        Err(error) => {
            eprintln!("  Vivado: failed to start built-in connector: {error}");
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(StartVivadoError {
                    error: format!("Failed to start the Vivado connector: {error}"),
                    path_required: false,
                }),
            ));
        }
    };
    println!(
        "  Vivado: {} ({} installed parts)",
        status.vivado_version,
        status.parts.len(),
    );
    let state = AppState::new(
        status.clone(),
        bridge_allowed_origins([state.local_origin.clone()]),
        vivado.clone(),
    );
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, vivado_app(state)).await {
            eprintln!("Built-in Vivado connector stopped: {error}");
        }
    });
    runtime.configured_vivado = Some(vivado);
    runtime.running = Some(RunningVivadoBridge {
        status: status.clone(),
        task,
    });
    Ok(Json(status))
}

fn open_chrome(explicit: Option<&Path>, url: &str) -> anyhow::Result<()> {
    let mut candidates = Vec::new();
    if let Some(path) = explicit {
        candidates.push(path.to_path_buf());
    } else {
        candidates.extend(chrome_candidates());
    }

    let mut not_found = Vec::new();
    for candidate in candidates {
        let mut command = Command::new(&candidate);
        command
            .arg(format!("--app={url}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        match command.spawn() {
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => not_found.push(candidate),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to open {}", candidate.display()));
            }
        }
    }

    let attempted = not_found
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    bail!(
        "Chrome or Chromium was not found (tried: {attempted}). Install Chrome or start with --chrome /path/to/chrome"
    )
}

fn chrome_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = env::var_os("CHROME_BIN") {
        candidates.push(PathBuf::from(path));
    }

    #[cfg(target_os = "windows")]
    {
        for variable in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
            if let Some(root) = env::var_os(variable) {
                candidates.push(
                    PathBuf::from(root)
                        .join("Google")
                        .join("Chrome")
                        .join("Application")
                        .join("chrome.exe"),
                );
            }
        }
        candidates.push(PathBuf::from("chrome.exe"));
    }

    #[cfg(target_os = "linux")]
    {
        candidates.extend(
            [
                "google-chrome",
                "google-chrome-stable",
                "chromium",
                "chromium-browser",
            ]
            .map(PathBuf::from),
        );
    }

    #[cfg(target_os = "macos")]
    {
        candidates.extend(
            [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            ]
            .map(PathBuf::from),
        );
        if let Some(home) = env::var_os("HOME") {
            let applications = PathBuf::from(home).join("Applications");
            candidates.push(
                applications
                    .join("Google Chrome.app")
                    .join("Contents/MacOS/Google Chrome"),
            );
            candidates.push(
                applications
                    .join("Chromium.app")
                    .join("Contents/MacOS/Chromium"),
            );
        }
    }

    candidates
}

async fn shutdown_signal() {
    if tokio::signal::ctrl_c().await.is_ok() {
        println!("Stopping Synth Explorer.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode, header};
    use http_body_util::BodyExt;
    use tempfile::TempDir;
    use tower::ServiceExt;

    #[test]
    fn packaged_web_root_is_next_to_launcher() {
        let executable = Path::new("/release/synth-explorer");
        assert_eq!(
            default_web_root(executable).unwrap(),
            Path::new("/release/web"),
        );
    }

    #[test]
    fn incomplete_download_fails_clearly() {
        let temp = TempDir::new().unwrap();
        let error = validate_web_root(temp.path()).unwrap_err().to_string();
        assert!(error.contains("extract the complete download"));
        assert!(error.contains("index.html"));
    }

    #[tokio::test]
    async fn static_app_serves_wasm_mime_and_spa_fallback() {
        let temp = TempDir::new().unwrap();
        std::fs::write(temp.path().join("index.html"), "local app").unwrap();
        std::fs::write(temp.path().join("engine.wasm"), b"wasm").unwrap();
        let state = LauncherState::new(None, "http://127.0.0.1:32124".to_owned());
        let app = web_app(temp.path().to_path_buf(), state);

        let wasm = app
            .clone()
            .oneshot(Request::get("/engine.wasm").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(wasm.status(), StatusCode::OK);
        assert_eq!(wasm.headers()[header::CONTENT_TYPE], "application/wasm");

        let fallback = app
            .oneshot(Request::get("/workspace").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(fallback.status(), StatusCode::OK);
        let body = fallback.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"local app");
    }

    #[tokio::test]
    async fn vivado_stays_stopped_until_requested_and_missing_path_can_be_retried() {
        let temp = TempDir::new().unwrap();
        std::fs::write(temp.path().join("index.html"), "local app").unwrap();
        let missing_vivado = temp.path().join("missing-vivado");
        let state = LauncherState::new(None, "http://127.0.0.1:32124".to_owned());
        assert!(state.vivado.lock().await.running.is_none());
        let app = web_app(temp.path().to_path_buf(), state);
        let request = serde_json::json!({ "vivado": missing_vivado });

        let response = app
            .oneshot(
                Request::post("/launcher/vivado/start")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::ORIGIN, "http://127.0.0.1:32124")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let error: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(error["path_required"], true);
        assert!(
            error["error"]
                .as_str()
                .unwrap()
                .contains("Vivado was not found")
        );
    }

    #[tokio::test]
    async fn vivado_start_rejects_requests_outside_the_local_app_origin() {
        let temp = TempDir::new().unwrap();
        std::fs::write(temp.path().join("index.html"), "local app").unwrap();
        let state = LauncherState::new(None, "http://127.0.0.1:32124".to_owned());
        let app = web_app(temp.path().to_path_buf(), state);

        let response = app
            .oneshot(
                Request::post("/launcher/vivado/start")
                    .header(header::CONTENT_TYPE, "application/json")
                    .header(header::ORIGIN, "https://example.com")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
