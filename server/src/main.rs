use synth_explorer_server::api;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let app = api::app(api::AppState::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8787").await?;
    axum::serve(listener, app).await?;
    Ok(())
}
