use crate::vivado::{VivadoError, run_vivado};
use crate::yosys::{
    MemoryHandling, SynthMode, SynthesisOutput, ValidatedSynth, YosysError, run_yosys,
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SynthesisError {
    #[error(transparent)]
    Yosys(#[from] YosysError),
    #[error(transparent)]
    Vivado(#[from] VivadoError),
}

impl SynthesisError {
    pub fn is_resource_exhaustion(&self) -> bool {
        matches!(self, Self::Yosys(err) if err.is_resource_exhaustion())
    }
}

pub async fn run_synthesis(
    input: &ValidatedSynth,
    memory: MemoryHandling,
) -> Result<SynthesisOutput, SynthesisError> {
    match input.mode {
        SynthMode::Vivado => Ok(run_vivado(input).await?),
        _ => Ok(run_yosys(input, memory).await?),
    }
}
