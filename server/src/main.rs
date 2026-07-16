use anyhow::Context;
use std::env;
use std::path::PathBuf;
use synth_explorer_server::{api, vivado, yosys};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("synth_explorer_server=info")),
        )
        .json()
        .init();

    let yosys_version = yosys::preflight_yosys()
        .await
        .context("Yosys startup preflight failed")?;
    let vivado_backend = vivado::preflight_vivado()
        .await
        .context("Vivado startup preflight failed")?;
    let vivado_access = load_vivado_access(vivado_backend.is_some())?;
    let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".to_owned());
    let design_store_dir = env::var_os("DESIGN_STORE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/designs"));
    let state = api::AppState::with_persistent_store(
        yosys_version.clone(),
        vivado_backend.clone(),
        vivado_access,
        &design_store_dir,
    )
    .context("failed to initialize persistent design store")?;
    let app = api::app(state);
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    let vivado_version = vivado_backend.as_ref().map(|backend| &backend.version);
    let vivado_parts = vivado_backend
        .as_ref()
        .map_or(0, |backend| backend.parts.len());
    tracing::info!(
        bind_addr,
        yosys_version,
        vivado_version,
        vivado_parts,
        design_store_dir = %design_store_dir.display(),
        "server_started"
    );
    axum::serve(listener, app).await?;
    Ok(())
}

fn load_vivado_access(vivado_configured: bool) -> anyhow::Result<Option<api::VivadoAccess>> {
    if !vivado_configured {
        return Ok(None);
    }
    let owner = env::var("VIVADO_ACCESS_TOKEN_SHA256")
        .context("VIVADO_ACCESS_TOKEN_SHA256 is required when Vivado is configured")?;
    let deploy = env::var("VIVADO_DEPLOY_TOKEN_SHA256")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let mut digests = vec![owner.as_str()];
    if let Some(deploy) = deploy.as_deref() {
        digests.push(deploy);
    }
    let access = api::VivadoAccess::from_digest_hexes(digests)
        .map_err(anyhow::Error::msg)
        .context("invalid Vivado access digest")?;
    Ok(Some(access))
}
