use anyhow::{Context, bail};
use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;
use synth_explorer_vivado_bridge::{AppState, DEFAULT_BIND, app, pairing_code, preflight_vivado};

#[derive(Debug, Parser)]
#[command(
    name = "synth-explorer-vivado-bridge",
    about = "Connect synthexplorer.dev to a Vivado installation on this computer"
)]
struct Args {
    /// Vivado executable. Defaults to VIVADO_BIN, then `vivado` on PATH.
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
    let vivado = args.vivado.unwrap_or_else(|| PathBuf::from("vivado"));
    let status = preflight_vivado(&vivado)
        .await
        .with_context(|| format!("Vivado preflight failed for {}", vivado.display()))?;
    let token = pairing_code();
    let mut origins = vec![
        "https://synthexplorer.dev".to_owned(),
        "https://www.synthexplorer.dev".to_owned(),
        "http://localhost:5173".to_owned(),
        "http://127.0.0.1:5173".to_owned(),
    ];
    origins.extend(args.additional_origins);
    let state = AppState::new(status.clone(), token.clone(), origins, vivado);
    let listener = tokio::net::TcpListener::bind(args.bind)
        .await
        .context("failed to bind the loopback bridge")?;

    println!("Synth Explorer Vivado bridge is ready");
    println!("  Vivado: {}", status.vivado_version);
    println!("  Installed parts: {}", status.parts.len());
    println!("  Website: https://synthexplorer.dev");
    println!("  Pairing code: {token}");
    println!("Keep this window open while using local Vivado synthesis.");

    axum::serve(listener, app(state))
        .await
        .context("Vivado bridge server failed")?;
    Ok(())
}
