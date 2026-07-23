//! Construction and ownership of one browser- or server-resident analysis session.

use crate::analysis::{Analysis, SourceRangeMapping, Stats};
use crate::delay_model::{DelayModel, DelayProfile};
use crate::graph::Graph;
use crate::grouping::{GroupPartition, memory_arrays_from_source};
use crate::netlist::{YosysNetlist, select_top};
use crate::source::{recover_source_provenance, SourceProvenanceIndex};
use deepsize::DeepSizeOf;
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DesignBuildError {
    #[error("failed to resolve top module: {0}")]
    Top(String),
    #[error("failed to build analysis graph: {0}")]
    Graph(String),
    #[error("failed to resolve source-provenance top module: {0}")]
    SourceTop(String),
}

#[derive(Debug, DeepSizeOf)]
pub struct AnalysisDesign {
    pub graph: Graph,
    pub analysis: Analysis,
    pub grouping: GroupPartition,
    pub delay_model: DelayModel,
    pub delay_profile: DelayProfile,
    mode: String,
}

impl AnalysisDesign {
    pub fn from_netlists(
        netlist: &YosysNetlist,
        source_netlist: &YosysNetlist,
        files: Vec<(String, String)>,
        mode: impl Into<String>,
        delay_profile: DelayProfile,
        include_vivado_procedural_ranges: bool,
    ) -> Result<Self, DesignBuildError> {
        let (top, module) =
            select_top(netlist, None).map_err(|error| DesignBuildError::Top(error.to_string()))?;
        let graph = Graph::from_netlist(netlist, top, module)
            .map_err(|error| DesignBuildError::Graph(error.to_string()))?;
        let (source_top, _) = select_top(source_netlist, None)
            .map_err(|error| DesignBuildError::SourceTop(error.to_string()))?;
        let mut source_provenance =
            recover_source_provenance(&graph, source_netlist, files.clone());
        if include_vivado_procedural_ranges {
            source_provenance
                .ranges
                .extend(procedural_ranges(&source_provenance.procedural_targets));
        }

        let delay_model = delay_profile.model();
        let file_names = files.into_iter().map(|(name, _)| name).collect::<Vec<_>>();
        let source_provenance = SourceProvenanceIndex::build(
            &graph,
            source_netlist,
            source_top,
            file_names.clone(),
            source_provenance,
        );
        let analysis = Analysis::with_delay_model_and_source_provenance(
            &graph,
            file_names,
            &delay_model,
            source_provenance,
        );
        let registers = &analysis.endpoints().registers;
        let memory_arrays =
            memory_arrays_from_source(&graph, source_netlist, source_top, registers);
        let grouping = GroupPartition::build(&graph, registers, memory_arrays);

        Ok(Self {
            graph,
            analysis,
            grouping,
            delay_model,
            delay_profile,
            mode: mode.into(),
        })
    }

    pub fn stats(&self) -> Stats {
        let mut stats = self.analysis.stats();
        if self.hides_delay_estimate(self.delay_profile) {
            stats.estimated_delay_ns = None;
            stats.estimated_delay_breakdown = None;
        }
        stats
    }

    pub fn warnings(&self) -> Vec<String> {
        self.analysis.warnings()
    }

    pub fn hides_delay_estimate(&self, profile: DelayProfile) -> bool {
        self.mode == "rtl"
            || (matches!(self.mode.as_str(), "gates" | "lut4" | "lut6")
                && profile == DelayProfile::Generic)
    }

    pub fn estimated_heap_bytes(&self) -> usize {
        self.deep_size_of()
    }
}

fn procedural_ranges(targets: &HashMap<(String, usize), Vec<u32>>) -> Vec<SourceRangeMapping> {
    let mut ranges = targets
        .iter()
        .map(|((file, line), node_ids)| SourceRangeMapping {
            file: file.clone(),
            start_line: *line,
            end_line: *line,
            start_column: None,
            end_column: None,
            node_ids: node_ids.clone(),
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        })
        .collect::<Vec<_>>();
    ranges.sort_by(|left, right| {
        (&left.file, left.start_line, left.end_line).cmp(&(
            &right.file,
            right.start_line,
            right.end_line,
        ))
    });
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vivado_procedural_targets_become_deterministic_source_ranges() {
        let targets = HashMap::from([
            (("top.sv".to_owned(), 17), vec![8, 9]),
            (("top.sv".to_owned(), 14), vec![7]),
        ]);
        let ranges = procedural_ranges(&targets);
        assert_eq!(
            ranges
                .iter()
                .map(|range| (range.start_line, range.node_ids.clone()))
                .collect::<Vec<_>>(),
            vec![(14, vec![7]), (17, vec![8, 9])]
        );
        assert!(ranges.iter().all(|range| !range.mapping_incomplete));
    }
}
