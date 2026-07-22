use anyhow::{Context, bail};
use axum::Router;
use clap::Parser;
use std::env;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use synth_explorer_vivado_bridge::{
    AppState, app as vivado_app, bridge_allowed_origins, preflight_vivado, resolve_vivado,
};
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};

const DEFAULT_APP_BIND: &str = "127.0.0.1:32124";
const DEFAULT_BUILT_IN_VIVADO_BIND: &str = "127.0.0.1:32125";

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

    start_vivado_bridge(args.vivado, &origin).await;

    if !args.no_open {
        open_chrome(args.chrome.as_deref(), &url)?;
        println!("Chrome opened. Keep this window open while using Synth Explorer.");
    } else {
        println!("Open {url}");
    }

    let server = axum::serve(listener, web_app(web_root));
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

fn web_app(web_root: PathBuf) -> Router {
    let index = web_root.join("index.html");
    let files = ServeDir::new(web_root).fallback(ServeFile::new(index));
    Router::new().fallback_service(files)
}

async fn start_vivado_bridge(explicit_vivado: Option<PathBuf>, local_origin: &str) {
    let vivado = resolve_vivado(explicit_vivado);
    println!("  Vivado: checking {}", vivado.display());
    let status = match preflight_vivado(&vivado).await {
        Ok(status) => status,
        Err(error) => {
            println!("  Vivado: unavailable ({error})");
            println!("  Yosys and GHDL remain fully available.");
            return;
        }
    };

    let bridge_address: SocketAddr = DEFAULT_BUILT_IN_VIVADO_BIND
        .parse()
        .expect("valid bridge address");
    let listener = match TcpListener::bind(bridge_address).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            eprintln!("  Vivado: built-in connector port {bridge_address} is already in use");
            return;
        }
        Err(error) => {
            eprintln!("  Vivado: failed to start built-in connector: {error}");
            return;
        }
    };
    println!(
        "  Vivado: {} ({} installed parts)",
        status.vivado_version,
        status.parts.len(),
    );
    let state = AppState::new(
        status,
        bridge_allowed_origins([local_origin.to_owned()]),
        vivado,
    );
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, vivado_app(state)).await {
            eprintln!("Built-in Vivado connector stopped: {error}");
        }
    });
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
    candidates.push(PathBuf::from(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ));

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
        let app = web_app(temp.path().to_path_buf());

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
}
