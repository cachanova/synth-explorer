use anyhow::{Context, bail};
use clap::Parser;
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use synth_explorer_vivado_bridge::{AppState, DEFAULT_BIND, app, preflight_vivado};

#[derive(Debug, Parser)]
#[command(
    name = "synth-explorer-vivado-bridge",
    about = "Connect synthexplorer.dev to a Vivado installation on this computer"
)]
struct Args {
    /// Vivado executable. Defaults to VIVADO_BIN, XILINX_VIVADO/bin/vivado, then vivado on PATH.
    #[arg(long, env = "VIVADO_BIN")]
    vivado: Option<PathBuf>,

    /// Loopback address to listen on.
    #[arg(long, default_value = DEFAULT_BIND)]
    bind: SocketAddr,

    /// Additional website origin allowed to use this bridge.
    #[arg(long = "allow-origin")]
    additional_origins: Vec<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    if !args.bind.ip().is_loopback() {
        bail!("--bind must be a loopback address; refusing to expose Vivado on the network");
    }
    let vivado = resolve_vivado(args.vivado);
    let status = preflight_vivado(&vivado)
        .await
        .with_context(|| format!("Vivado preflight failed for {}", vivado.display()))?;
    let mut origins = vec![
        "https://synthexplorer.dev".to_owned(),
        "https://www.synthexplorer.dev".to_owned(),
    ];
    origins.extend(args.additional_origins);
    let state = AppState::new(status.clone(), origins, vivado);
    let listener = tokio::net::TcpListener::bind(args.bind)
        .await
        .context("failed to bind the loopback bridge")?;

    println!("Synth Explorer Vivado bridge is ready");
    println!("  Vivado: {}", status.vivado_version);
    println!("  Installed parts: {}", status.parts.len());
    println!("  Website: https://synthexplorer.dev");
    println!("Waiting for Synth Explorer to connect...");
    println!("Keep this window open while using local Vivado synthesis.");

    axum::serve(listener, app(state))
        .await
        .context("Vivado bridge server failed")?;
    Ok(())
}

fn resolve_vivado(explicit: Option<PathBuf>) -> PathBuf {
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
