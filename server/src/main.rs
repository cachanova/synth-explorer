use anyhow::Context;
use std::env;
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
    let vivado_version = vivado::preflight_vivado()
        .await
        .context("Vivado startup preflight failed")?;
    let bind_addr = env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".to_owned());
    let app = api::app(api::AppState::with_backends(
        yosys_version.clone(),
        vivado_version.clone(),
    ));
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    tracing::info!(bind_addr, yosys_version, vivado_version, "server_started");
    axum::serve(listener, app).await?;
    Ok(())
}
