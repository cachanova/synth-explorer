//! Canonical source-provenance storage and query indexes.

use crate::analysis::{
    SOURCE_BIT_RANGE_RESPONSE_CAP, SOURCE_LINE_RESPONSE_CAP, SOURCE_LINE_RESPONSE_NODE_BUDGET,
    SOURCE_PROBE_TARGET_VISIT_CAP, SOURCE_RANGE_INDEX_CAP, SOURCE_RANGE_RESPONSE_CAP,
    SOURCE_ROOT_COLLECTION_CAP, SOURCE_SPAN_INDEX_CAP, SourceBitRangesResponse, SourceMapResponse,
    SourceProbeDirection, SourceProbeHintKind, SourceRangeMapping, SourceSelectionRange,
    insert_src_lines, parse_src_span, source_columns_are_authoritative, source_coordinates_overlap,
};
use crate::graph::{Graph, NodeId};
use crate::netlist::YosysNetlist;
use crate::source_provenance::SourceProvenance;
use deepsize::DeepSizeOf;
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashSet};

const ROLE_RECOVERED: u8 = 1 << 0;
const ROLE_NATIVE: u8 = 1 << 1;
const BIT_REVERSE_MAPPING_THRESHOLD: usize = 64;
const BIT_REVERSE_ASSOCIATION_THRESHOLD: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, DeepSizeOf)]
struct SpanCoordinates {
    start_line: usize,
    end_line: usize,
    start_column: Option<usize>,
    end_column: Option<usize>,
}

impl SpanCoordinates {
    fn from_range(range: &SourceRangeMapping) -> Self {
        Self {
            start_line: range.start_line,
            start_column: range.start_column,
            end_line: range.end_line,
            end_column: range.end_column,
        }
    }

    fn overlaps(
        self,
        start_line: usize,
        end_line: usize,
        start_column: Option<usize>,
        end_column: Option<usize>,
    ) -> bool {
        source_coordinates_overlap(
            self.start_line,
            self.start_column,
            self.end_line,
            self.end_column,
            start_line,
            start_column,
            end_line,
            end_column,
        )
    }

    fn format(self, file: &str) -> String {
        match (self.start_column, self.end_column) {
            (Some(start_column), Some(end_column)) => format!(
                "{file}:{}.{start_column}-{}.{end_column}",
                self.start_line, self.end_line
            ),
            _ => format!("{file}:{}-{}", self.start_line, self.end_line),
        }
    }
}

#[derive(Debug, Clone, DeepSizeOf)]
struct IndexedSpan {
    coordinates: SpanCoordinates,
    facts: Option<Box<SpanFacts>>,
    presence_indexed: bool,
    recovered_presence: bool,
}

#[derive(Debug, Clone, DeepSizeOf)]
struct SpanFacts {
    display: String,
    nodes: Vec<NodeId>,
    native_node_count: u32,
    mappings: Vec<MappingFact>,
    policies: u16,
    roles: u8,
    mapping_incomplete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, DeepSizeOf)]
struct MappingFact {
    nodes: Vec<NodeId>,
    exact_bits: Vec<u32>,
    approximate_bits: Vec<u32>,
    incomplete: bool,
}

impl IndexedSpan {
    fn recovered(&self) -> bool {
        self.facts
            .as_deref()
            .is_some_and(|facts| facts.roles & ROLE_RECOVERED != 0)
    }

    fn facts(&self) -> Option<&SpanFacts> {
        self.facts.as_deref()
    }

    fn nodes(&self) -> &[NodeId] {
        self.facts().map_or(&[], |facts| {
            &facts.nodes[facts.native_node_count as usize..]
        })
    }

    fn native_nodes(&self) -> &[NodeId] {
        self.facts().map_or(&[], |facts| {
            &facts.nodes[..facts.native_node_count as usize]
        })
    }

    fn mappings(&self) -> &[MappingFact] {
        self.facts().map_or(&[], |facts| facts.mappings.as_slice())
    }

    fn mapping_incomplete(&self) -> bool {
        self.facts().is_some_and(|facts| facts.mapping_incomplete)
    }

    fn has_policy(&self, kind: SourceProbeHintKind, direction: SourceProbeDirection) -> bool {
        self.facts()
            .is_some_and(|facts| facts.policies & policy_bit(kind, direction) != 0)
    }

    fn has_any_policy(&self) -> bool {
        self.facts().is_some_and(|facts| facts.policies != 0)
    }

    fn has_non_block_policy(&self) -> bool {
        [
            SourceProbeHintKind::OutputPort,
            SourceProbeHintKind::Procedural,
            SourceProbeHintKind::Signal,
        ]
        .into_iter()
        .any(|kind| {
            [SourceProbeDirection::Fanin, SourceProbeDirection::Fanout]
                .into_iter()
                .any(|direction| self.has_policy(kind, direction))
        })
    }
}

#[derive(Debug, Clone, DeepSizeOf)]
struct SourceFileIndex {
    name: String,
    submitted: bool,
    native_lines: BTreeMap<usize, Vec<NodeId>>,
    native_line_order: Vec<usize>,
    seen_lines: BTreeSet<usize>,
    procedural_targets: BTreeMap<usize, Vec<NodeId>>,
    spans: Vec<IndexedSpan>,
    prefix_max_end: Vec<usize>,
    incomplete_spans: bool,
}

impl SourceFileIndex {
    fn candidates(&self, start_line: usize, end_line: usize) -> &[IndexedSpan] {
        let end = self
            .spans
            .partition_point(|span| span.coordinates.start_line <= end_line);
        let start = self.prefix_max_end[..end].partition_point(|max_end| *max_end < start_line);
        &self.spans[start..end]
    }

    fn overlapping(
        &self,
        start_line: usize,
        end_line: usize,
        start_column: Option<usize>,
        end_column: Option<usize>,
    ) -> impl Iterator<Item = &IndexedSpan> {
        self.candidates(start_line, end_line)
            .iter()
            .filter(move |span| {
                span.coordinates
                    .overlaps(start_line, end_line, start_column, end_column)
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, DeepSizeOf)]
struct SpanHandle {
    file: u32,
    span: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, DeepSizeOf)]
struct MappingHandle {
    span: SpanId,
    mapping: u32,
}

type SpanId = u32;

#[derive(Debug, Default)]
struct SpanIndexBuilder {
    entries: BTreeMap<u32, Vec<SpanId>>,
}

impl SpanIndexBuilder {
    fn insert(&mut self, key: u32, span: SpanId) {
        let values = self.entries.entry(key).or_default();
        if values.last() != Some(&span) {
            values.push(span);
        }
    }

    fn association_count(&self) -> usize {
        self.entries.values().map(Vec::len).sum()
    }
}

#[derive(Debug, Clone, Default, DeepSizeOf)]
struct CompactSpanIndex {
    keys: Vec<u32>,
    offsets: Vec<u32>,
    spans: Vec<SpanId>,
}

impl CompactSpanIndex {
    fn from_builder(builder: SpanIndexBuilder) -> Self {
        let mut keys = Vec::with_capacity(builder.entries.len());
        let mut offsets = Vec::with_capacity(builder.entries.len() + 1);
        let mut spans = Vec::new();
        for (key, entries) in builder.entries {
            keys.push(key);
            offsets.push(spans.len() as u32);
            spans.extend(entries);
        }
        offsets.push(spans.len() as u32);
        Self {
            keys,
            offsets,
            spans,
        }
    }

    fn get(&self, key: u32) -> &[SpanId] {
        let Ok(index) = self.keys.binary_search(&key) else {
            return &[];
        };
        &self.spans[self.offsets[index] as usize..self.offsets[index + 1] as usize]
    }
}

#[derive(Debug, Clone, Default, DeepSizeOf)]
struct DenseSpanIndex {
    offsets: Vec<u32>,
    spans: Vec<SpanId>,
}

impl DenseSpanIndex {
    fn from_builder(builder: SpanIndexBuilder) -> Self {
        let Some(max_key) = builder.entries.keys().next_back().copied() else {
            return Self::default();
        };
        let mut offsets = Vec::with_capacity(max_key as usize + 2);
        let mut spans = Vec::new();
        for key in 0..=max_key {
            offsets.push(spans.len() as u32);
            if let Some(entries) = builder.entries.get(&key) {
                spans.extend(entries.iter().copied());
            }
        }
        offsets.push(spans.len() as u32);
        Self { offsets, spans }
    }

    fn get(&self, key: u32) -> &[SpanId] {
        let key = key as usize;
        let Some((&start, &end)) = self.offsets.get(key).zip(self.offsets.get(key + 1)) else {
            return &[];
        };
        &self.spans[start as usize..end as usize]
    }
}

#[derive(Debug, Clone, DeepSizeOf)]
enum NodeSpanIndex {
    Dense(DenseSpanIndex),
    Compact(CompactSpanIndex),
}

impl NodeSpanIndex {
    fn from_builder(builder: SpanIndexBuilder) -> Self {
        let key_count = builder.entries.len();
        let dense_len = builder
            .entries
            .keys()
            .next_back()
            .map_or(0, |key| *key as usize + 2);
        if dense_len <= key_count.saturating_mul(2) {
            Self::Dense(DenseSpanIndex::from_builder(builder))
        } else {
            Self::Compact(CompactSpanIndex::from_builder(builder))
        }
    }

    fn get(&self, key: u32) -> &[SpanId] {
        match self {
            Self::Dense(index) => index.get(key),
            Self::Compact(index) => index.get(key),
        }
    }
}

/// One immutable owner for native, recovered, directional, and reverse source
/// provenance. Public response objects are projections built from this index.
#[derive(Debug, Clone, DeepSizeOf)]
pub(crate) struct SourceProvenanceIndex {
    files: Vec<SourceFileIndex>,
    submitted_files: Vec<u32>,
    span_locations: Vec<SpanHandle>,
    mapping_locations: Vec<MappingHandle>,
    spans_by_node: NodeSpanIndex,
    recovered_by_node: NodeSpanIndex,
    exact_by_bit: CompactSpanIndex,
    approximate_by_bit: CompactSpanIndex,
    mapping_truncated: bool,
}

#[derive(Debug)]
struct SpanBuilder {
    coordinates: SpanCoordinates,
    native_nodes: Vec<NodeId>,
    nodes: BTreeSet<NodeId>,
    mappings: BTreeSet<MappingFact>,
    policies: u16,
    roles: u8,
    mapping_incomplete: bool,
    presence_indexed: bool,
    recovered_presence: bool,
}

impl SpanBuilder {
    fn new(coordinates: SpanCoordinates) -> Self {
        Self {
            coordinates,
            native_nodes: Vec::new(),
            nodes: BTreeSet::new(),
            mappings: BTreeSet::new(),
            policies: 0,
            roles: 0,
            mapping_incomplete: false,
            presence_indexed: false,
            recovered_presence: false,
        }
    }
}

#[derive(Debug)]
struct FileBuilder {
    name: String,
    submitted: bool,
    native_lines: BTreeMap<usize, Vec<NodeId>>,
    seen_lines: BTreeSet<usize>,
    procedural_targets: BTreeMap<usize, BTreeSet<NodeId>>,
    spans: BTreeMap<SpanCoordinates, SpanBuilder>,
    incomplete_spans: bool,
}

impl FileBuilder {
    fn new(name: String, submitted: bool) -> Self {
        Self {
            name,
            submitted,
            native_lines: BTreeMap::new(),
            seen_lines: BTreeSet::new(),
            procedural_targets: BTreeMap::new(),
            spans: BTreeMap::new(),
            incomplete_spans: false,
        }
    }
}

struct IndexBuilder {
    files: Vec<FileBuilder>,
    file_positions: std::collections::HashMap<String, usize>,
    submitted_names: Vec<String>,
    presence_count: usize,
    recovered_presence_count: usize,
    mapping_truncated: bool,
}

impl IndexBuilder {
    fn new(files: Vec<String>) -> Self {
        let mut builder = Self {
            files: Vec::new(),
            file_positions: std::collections::HashMap::new(),
            submitted_names: files.clone(),
            presence_count: 0,
            recovered_presence_count: 0,
            mapping_truncated: false,
        };
        for file in files {
            builder.ensure_file(&file, true);
        }
        builder
    }

    fn file_position(&self, name: &str) -> Option<usize> {
        self.file_positions.get(name).copied()
    }

    fn ensure_file(&mut self, name: &str, submitted: bool) -> usize {
        if let Some(index) = self.file_position(name) {
            self.files[index].submitted |= submitted;
            return index;
        }
        self.files
            .push(FileBuilder::new(name.to_owned(), submitted));
        let index = self.files.len() - 1;
        self.file_positions.insert(name.to_owned(), index);
        index
    }

    fn add_native_graph(&mut self, graph: &Graph) {
        for node in &graph.nodes {
            let Some(src) = node.src.as_deref() else {
                continue;
            };
            for fragment in src.split('|') {
                let Some((file, start_line, start_column, end_line, end_column)) =
                    parse_src_span(fragment)
                else {
                    continue;
                };
                let file_index = self.ensure_file(&file, false);
                let mut admitted_on_line = false;
                for line in start_line..=end_line.min(start_line + 199) {
                    let ids = self.files[file_index].native_lines.entry(line).or_default();
                    if ids.last() == Some(&node.id) {
                        admitted_on_line = true;
                        continue;
                    }
                    if ids.len() < SOURCE_ROOT_COLLECTION_CAP {
                        ids.push(node.id);
                        admitted_on_line = true;
                    } else {
                        self.mapping_truncated = true;
                    }
                }
                if admitted_on_line && source_columns_are_authoritative(&file) {
                    let span = self.span_mut(
                        &file,
                        SpanCoordinates {
                            start_line,
                            start_column,
                            end_line,
                            end_column,
                        },
                    );
                    span.roles |= ROLE_NATIVE;
                    if span.native_nodes.last() != Some(&node.id) {
                        span.native_nodes.push(node.id);
                    }
                }
            }
        }
        for file in &mut self.files {
            for ids in file.native_lines.values_mut() {
                ids.sort_unstable();
                ids.dedup();
                ids.truncate(SOURCE_ROOT_COLLECTION_CAP);
            }
        }
    }

    fn add_preflatten_presence(&mut self, netlist: &YosysNetlist, top: &str) {
        let mut reachable = HashSet::new();
        let mut pending = vec![top];
        while let Some(module_name) = pending.pop() {
            if !reachable.insert(module_name) {
                continue;
            }
            let Some(module) = netlist.modules.get(module_name) else {
                continue;
            };
            for cell in module.cells.values() {
                if let Some((child_name, _)) = netlist.modules.get_key_value(&cell.cell_type) {
                    pending.push(child_name);
                }
                let Some(src) = cell.attributes.get("src") else {
                    continue;
                };
                insert_src_lines(src, |file, line| {
                    let file_index = self.ensure_file(file, false);
                    self.files[file_index].seen_lines.insert(line);
                });
                for fragment in src.split('|') {
                    let Some((file, start_line, start_column, end_line, end_column)) =
                        parse_src_span(fragment)
                    else {
                        continue;
                    };
                    self.add_presence(
                        &file,
                        SpanCoordinates {
                            start_line,
                            start_column,
                            end_line,
                            end_column,
                        },
                    );
                }
            }
        }
    }

    fn span_mut(&mut self, file: &str, coordinates: SpanCoordinates) -> &mut SpanBuilder {
        let file_index = self.ensure_file(file, false);
        self.files[file_index]
            .spans
            .entry(coordinates)
            .or_insert_with(|| SpanBuilder::new(coordinates))
    }

    fn add_presence(&mut self, file: &str, coordinates: SpanCoordinates) -> bool {
        let file_index = self.ensure_file(file, false);
        if self.files[file_index]
            .spans
            .get(&coordinates)
            .is_some_and(|span| span.presence_indexed)
        {
            return true;
        }
        if self.presence_count == SOURCE_SPAN_INDEX_CAP {
            self.files[file_index].incomplete_spans = true;
            return false;
        }
        self.span_mut(file, coordinates).presence_indexed = true;
        self.presence_count += 1;
        true
    }

    fn add_recovered_presence(&mut self, range: &SourceRangeMapping) {
        let coordinates = SpanCoordinates::from_range(range);
        let file_index = self.ensure_file(&range.file, false);
        if self.files[file_index]
            .spans
            .get(&coordinates)
            .is_some_and(|span| span.recovered_presence)
        {
            return;
        }
        if self.recovered_presence_count == SOURCE_SPAN_INDEX_CAP {
            self.files[file_index].incomplete_spans = true;
            return;
        }
        self.span_mut(&range.file, coordinates).recovered_presence = true;
        self.recovered_presence_count += 1;
    }

    fn add_recovered_range(&mut self, range: SourceRangeMapping) {
        let coordinates = SpanCoordinates::from_range(&range);
        let span = self.span_mut(&range.file, coordinates);
        span.roles |= ROLE_RECOVERED;
        span.mapping_incomplete |= range.mapping_incomplete;
        span.nodes.extend(range.node_ids.iter().copied());
        span.mappings.insert(MappingFact {
            nodes: range.node_ids,
            exact_bits: range.signal_bits,
            approximate_bits: range.approximate_signal_bits,
            incomplete: range.mapping_incomplete,
        });
    }

    fn add_hint(
        &mut self,
        file: String,
        coordinates: SpanCoordinates,
        kind: SourceProbeHintKind,
        direction: SourceProbeDirection,
    ) {
        self.span_mut(&file, coordinates).policies |= policy_bit(kind, direction);
    }

    fn mark_procedural_targets(&mut self, targets: BTreeMap<(String, usize), BTreeSet<NodeId>>) {
        for ((file, line), target_ids) in targets {
            let file_index = self.ensure_file(&file, false);
            self.files[file_index]
                .procedural_targets
                .entry(line)
                .or_default()
                .extend(target_ids.iter().copied());
        }
    }

    fn finish(mut self) -> SourceProvenanceIndex {
        self.files.sort_by(|left, right| left.name.cmp(&right.name));
        self.file_positions = self
            .files
            .iter()
            .enumerate()
            .map(|(index, file)| (file.name.clone(), index))
            .collect();
        let submitted_files = self
            .submitted_names
            .iter()
            .filter_map(|name| self.file_position(name))
            .map(|index| index as u32)
            .collect();
        let mut files = Vec::with_capacity(self.files.len());
        let mut span_locations = Vec::new();
        let mut mapping_locations = Vec::new();
        let mut spans_by_node = SpanIndexBuilder::default();
        let mut recovered_by_node = SpanIndexBuilder::default();
        let mut exact_by_bit = SpanIndexBuilder::default();
        let mut approximate_by_bit = SpanIndexBuilder::default();
        for (file_index, file) in self.files.into_iter().enumerate() {
            let mut native_line_order = file.native_lines.keys().copied().collect::<Vec<_>>();
            native_line_order.sort_by_cached_key(|line| line.to_string());
            let mut prefix_max_end = Vec::with_capacity(file.spans.len());
            let mut max_end = 0usize;
            let mut spans = Vec::with_capacity(file.spans.len());
            for (_, span) in file.spans {
                max_end = max_end.max(span.coordinates.end_line);
                prefix_max_end.push(max_end);
                let mut nodes = span.native_nodes;
                nodes.sort_unstable();
                nodes.dedup();
                let native_node_count = nodes.len() as u32;
                nodes.extend(span.nodes);
                let mappings = span.mappings.into_iter().collect::<Vec<_>>();
                if span.roles & (ROLE_NATIVE | ROLE_RECOVERED) != 0 {
                    let span_id = span_locations.len() as SpanId;
                    span_locations.push(SpanHandle {
                        file: file_index as u32,
                        span: spans.len() as u32,
                    });
                    for node in &nodes {
                        spans_by_node.insert(*node, span_id);
                    }
                }
                if span.roles & ROLE_RECOVERED != 0 {
                    let span_id = (span_locations.len() - 1) as SpanId;
                    for node in nodes.iter().skip(native_node_count as usize) {
                        recovered_by_node.insert(*node, span_id);
                    }
                    for (mapping_index, mapping) in mappings.iter().enumerate() {
                        let mapping_id = mapping_locations.len() as u32;
                        mapping_locations.push(MappingHandle {
                            span: span_id,
                            mapping: mapping_index as u32,
                        });
                        for bit in &mapping.exact_bits {
                            exact_by_bit.insert(*bit, mapping_id);
                        }
                        for bit in &mapping.approximate_bits {
                            approximate_by_bit.insert(*bit, mapping_id);
                        }
                    }
                }
                let has_facts = span.roles != 0
                    || span.policies != 0
                    || span.mapping_incomplete
                    || !nodes.is_empty()
                    || !mappings.is_empty();
                spans.push(IndexedSpan {
                    coordinates: span.coordinates,
                    facts: has_facts.then(|| {
                        Box::new(SpanFacts {
                            display: if span.roles & ROLE_RECOVERED != 0 {
                                span.coordinates.format(&file.name)
                            } else {
                                String::new()
                            },
                            nodes,
                            native_node_count,
                            mappings,
                            policies: span.policies,
                            roles: span.roles,
                            mapping_incomplete: span.mapping_incomplete,
                        })
                    }),
                    presence_indexed: span.presence_indexed,
                    recovered_presence: span.recovered_presence,
                });
            }
            files.push(SourceFileIndex {
                name: file.name,
                submitted: file.submitted,
                native_lines: file.native_lines,
                native_line_order,
                seen_lines: file.seen_lines,
                procedural_targets: file
                    .procedural_targets
                    .into_iter()
                    .map(|(line, ids)| (line, ids.into_iter().collect()))
                    .collect(),
                spans,
                prefix_max_end,
                incomplete_spans: file.incomplete_spans,
            });
        }
        let bit_association_count =
            exact_by_bit.association_count() + approximate_by_bit.association_count();
        let retain_bit_reverse_index = mapping_locations.len() > BIT_REVERSE_MAPPING_THRESHOLD
            || bit_association_count <= BIT_REVERSE_ASSOCIATION_THRESHOLD;
        if !retain_bit_reverse_index {
            mapping_locations.clear();
            mapping_locations.shrink_to_fit();
        }
        SourceProvenanceIndex {
            files,
            submitted_files,
            span_locations,
            mapping_locations,
            spans_by_node: NodeSpanIndex::from_builder(spans_by_node),
            recovered_by_node: NodeSpanIndex::from_builder(recovered_by_node),
            exact_by_bit: if retain_bit_reverse_index {
                CompactSpanIndex::from_builder(exact_by_bit)
            } else {
                CompactSpanIndex::default()
            },
            approximate_by_bit: if retain_bit_reverse_index {
                CompactSpanIndex::from_builder(approximate_by_bit)
            } else {
                CompactSpanIndex::default()
            },
            mapping_truncated: self.mapping_truncated,
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedSourceProbe {
    pub roots: Vec<NodeId>,
    pub direct_bits: Vec<u32>,
    pub direction: Option<SourceProbeDirection>,
    pub local_bidirectional: bool,
    pub expand_output_register_inputs: bool,
    pub truncated: bool,
    pub mapping_incomplete: bool,
    pub source_seen: bool,
}

impl SourceProvenanceIndex {
    pub(crate) fn from_graph(graph: &Graph, files: Vec<String>) -> Self {
        let mut builder = IndexBuilder::new(files);
        builder.add_native_graph(graph);
        builder.finish()
    }

    pub(crate) fn build(
        graph: &Graph,
        source_netlist: &YosysNetlist,
        source_top: &str,
        files: Vec<String>,
        provenance: SourceProvenance,
    ) -> Self {
        let mut builder = IndexBuilder::new(files);
        builder.add_native_graph(graph);
        builder.add_preflatten_presence(source_netlist, source_top);
        let SourceProvenance {
            ranges,
            truncated,
            procedural_targets,
            probe_hints,
        } = provenance;
        for range in &ranges {
            builder.add_recovered_presence(range);
        }
        let mut retained_ranges = 0usize;
        for range in ranges {
            if retained_ranges == SOURCE_RANGE_INDEX_CAP {
                builder.mapping_truncated = true;
                continue;
            }
            builder.add_recovered_range(range);
            retained_ranges += 1;
        }
        for hint in probe_hints {
            builder.add_hint(
                hint.file,
                SpanCoordinates {
                    start_line: hint.start_line,
                    start_column: hint.start_column,
                    end_line: hint.end_line,
                    end_column: hint.end_column,
                },
                hint.kind,
                hint.direction,
            );
        }
        let targets = procedural_targets
            .into_iter()
            .map(|(key, ids)| (key, ids.into_iter().collect::<BTreeSet<_>>()))
            .collect();
        builder.mark_procedural_targets(targets);
        builder.mapping_truncated |= truncated;
        builder.finish()
    }

    #[cfg(test)]
    pub(crate) fn extend_test_ranges(&mut self, ranges: Vec<SourceRangeMapping>, truncated: bool) {
        let mut builder = self.test_builder();
        for range in &ranges {
            builder.add_recovered_presence(range);
        }
        let retained = builder
            .files
            .iter()
            .flat_map(|file| file.spans.values())
            .filter(|span| span.roles & ROLE_RECOVERED != 0)
            .count();
        let available = SOURCE_RANGE_INDEX_CAP.saturating_sub(retained);
        let ranges_omitted = ranges.len() > available;
        for range in ranges.into_iter().take(available) {
            builder.add_recovered_range(range);
        }
        builder.mapping_truncated |= truncated || ranges_omitted;
        *self = builder.finish();
    }

    #[cfg(test)]
    pub(crate) fn set_test_hints(&mut self, hints: Vec<crate::analysis::SourceProbeHint>) {
        let mut builder = self.test_builder();
        for hint in hints {
            builder.add_hint(
                hint.file,
                SpanCoordinates {
                    start_line: hint.start_line,
                    start_column: hint.start_column,
                    end_line: hint.end_line,
                    end_column: hint.end_column,
                },
                hint.kind,
                hint.direction,
            );
        }
        *self = builder.finish();
    }

    #[cfg(test)]
    pub(crate) fn set_test_procedural_targets(
        &mut self,
        targets: std::collections::HashMap<(String, usize), Vec<NodeId>>,
    ) {
        let mut builder = self.test_builder();
        builder.mark_procedural_targets(
            targets
                .into_iter()
                .map(|(key, ids)| (key, ids.into_iter().collect()))
                .collect(),
        );
        *self = builder.finish();
    }

    #[cfg(test)]
    fn test_builder(&self) -> IndexBuilder {
        let submitted = self
            .submitted_files
            .iter()
            .map(|index| self.files[*index as usize].name.clone())
            .collect();
        let mut builder = IndexBuilder::new(submitted);
        builder.mapping_truncated = self.mapping_truncated;
        for file in &self.files {
            let file_index = builder.ensure_file(&file.name, file.submitted);
            builder.files[file_index].native_lines = file.native_lines.clone();
            builder.files[file_index].seen_lines = file.seen_lines.clone();
            builder.files[file_index].procedural_targets = file
                .procedural_targets
                .iter()
                .map(|(line, ids)| (*line, ids.iter().copied().collect()))
                .collect();
            builder.files[file_index].incomplete_spans = file.incomplete_spans;
            for span in &file.spans {
                let mut restored = SpanBuilder::new(span.coordinates);
                if let Some(facts) = span.facts() {
                    restored
                        .native_nodes
                        .extend(span.native_nodes().iter().copied());
                    restored.nodes.extend(span.nodes().iter().copied());
                    restored.mappings.extend(facts.mappings.iter().cloned());
                    restored.policies = facts.policies;
                    restored.roles = facts.roles;
                    restored.mapping_incomplete = facts.mapping_incomplete;
                }
                restored.presence_indexed = span.presence_indexed;
                restored.recovered_presence = span.recovered_presence;
                builder.files[file_index]
                    .spans
                    .insert(span.coordinates, restored);
                builder.presence_count += usize::from(span.presence_indexed);
                builder.recovered_presence_count += usize::from(span.recovered_presence);
            }
        }
        builder
    }

    pub(crate) fn estimated_heap_bytes(&self) -> usize {
        self.deep_size_of()
    }

    fn file_index(&self, file: &str) -> Option<usize> {
        self.files
            .binary_search_by(|candidate| candidate.name.as_str().cmp(file))
            .ok()
            .filter(|index| self.files[*index].submitted)
    }

    pub(crate) fn contains_file(&self, file: &str) -> bool {
        self.file_index(file).is_some()
    }

    #[cfg(test)]
    pub(crate) fn mark_test_span_incomplete(&mut self, file: &str) {
        let index = self
            .file_index(file)
            .expect("test source file must be submitted");
        self.files[index].incomplete_spans = true;
    }

    #[cfg(test)]
    pub(crate) fn recovered_span_count(&self) -> usize {
        self.files
            .iter()
            .flat_map(|file| &file.spans)
            .filter(|span| span.recovered())
            .count()
    }

    fn span(&self, span: SpanId) -> (&SourceFileIndex, &IndexedSpan) {
        let handle = self.span_locations[span as usize];
        let file = &self.files[handle.file as usize];
        (file, &file.spans[handle.span as usize])
    }

    fn mapping(&self, mapping: u32) -> (&SourceFileIndex, &IndexedSpan, &MappingFact) {
        let handle = self.mapping_locations[mapping as usize];
        let (file, span) = self.span(handle.span);
        (file, span, &span.mappings()[handle.mapping as usize])
    }

    pub(crate) fn source_map(&self) -> SourceMapResponse {
        let mut response = SourceMapResponse {
            files: self
                .submitted_files
                .iter()
                .map(|index| self.files[*index as usize].name.clone())
                .collect(),
            by_line: BTreeMap::new(),
            ranges: Vec::new(),
            truncated: self.mapping_truncated,
        };
        let line_entry_count = self
            .files
            .iter()
            .map(|file| file.native_lines.len())
            .sum::<usize>();
        let mut node_budget = SOURCE_LINE_RESPONSE_NODE_BUDGET;
        let mut position = 0usize;
        let mut line_positions = vec![0usize; self.files.len()];
        let mut pending_lines = self
            .files
            .iter()
            .enumerate()
            .filter_map(|(file_index, file)| {
                let line = *file.native_line_order.first()?;
                Some(Reverse((format!("{}:{line}", file.name), file_index, line)))
            })
            .collect::<BinaryHeap<_>>();
        while position < line_entry_count {
            if response.by_line.len() == SOURCE_LINE_RESPONSE_CAP {
                response.truncated = true;
                break;
            }
            let Some(Reverse((location, file_index, line))) = pending_lines.pop() else {
                break;
            };
            line_positions[file_index] += 1;
            if let Some(next_line) = self.files[file_index]
                .native_line_order
                .get(line_positions[file_index])
            {
                pending_lines.push(Reverse((
                    format!("{}:{next_line}", self.files[file_index].name),
                    file_index,
                    *next_line,
                )));
            }
            let ids = &self.files[file_index].native_lines[&line];
            if !ids.is_empty() && node_budget == 0 {
                response.truncated = true;
                break;
            }
            if ids.len() > node_budget {
                response
                    .by_line
                    .insert(location, ids.iter().take(node_budget).copied().collect());
                response.truncated = true;
                break;
            }
            node_budget -= ids.len();
            response.by_line.insert(location, ids.clone());
            position += 1;
            if node_budget == 0 && position < line_entry_count {
                response.truncated = true;
                break;
            }
        }

        let mut range_node_budget = crate::analysis::SOURCE_RANGE_ASSOCIATION_CAP;
        for file in &self.files {
            for span in file.spans.iter().filter(|span| span.recovered()) {
                for mapping in span.mappings() {
                    if response.ranges.len() == SOURCE_RANGE_RESPONSE_CAP {
                        response.truncated = true;
                        return response;
                    }
                    if !mapping.nodes.is_empty() && range_node_budget == 0 {
                        response.truncated = true;
                        return response;
                    }
                    let mut range = public_mapping(file, span, mapping);
                    if range.node_ids.len() > range_node_budget {
                        range.node_ids.truncate(range_node_budget);
                        response.ranges.push(range);
                        response.truncated = true;
                        return response;
                    }
                    range_node_budget -= range.node_ids.len();
                    response.ranges.push(range);
                }
            }
        }
        response
    }

    pub(crate) fn source_ranges_for_bits(&self, bits: &[u32]) -> SourceBitRangesResponse {
        let mut selected = bits
            .iter()
            .take(SOURCE_ROOT_COLLECTION_CAP)
            .copied()
            .collect::<Vec<_>>();
        selected.sort_unstable();
        selected.dedup();
        let mut response = SourceBitRangesResponse {
            ranges: Vec::new(),
            truncated: self.mapping_truncated || bits.len() > SOURCE_ROOT_COLLECTION_CAP,
            approximate: false,
        };
        if self.mapping_locations.is_empty() || selected.len() > self.mapping_locations.len() {
            'files: for file in &self.files {
                for span in file.spans.iter().filter(|span| span.recovered()) {
                    for mapping in span.mappings() {
                        if append_bit_mapping(&mut response, &selected, file, span, mapping) {
                            break 'files;
                        }
                    }
                }
            }
            return response;
        }
        let mut handles = Vec::new();
        for bit in &selected {
            handles.extend_from_slice(self.exact_by_bit.get(*bit));
            handles.extend_from_slice(self.approximate_by_bit.get(*bit));
        }
        handles.sort_unstable();
        handles.dedup();
        for handle in handles {
            let (file, span, mapping) = self.mapping(handle);
            if append_bit_mapping(&mut response, &selected, file, span, mapping) {
                break;
            }
        }
        response
    }

    pub(crate) fn recovered_sources_for_node(&self, node: NodeId) -> Vec<String> {
        self.recovered_by_node
            .get(node)
            .iter()
            .map(|handle| {
                let (_, span) = self.span(*handle);
                span.facts()
                    .expect("recovered reverse index must reference facts")
                    .display
                    .clone()
            })
            .collect()
    }

    pub(crate) fn resolve_selection(
        &self,
        selection: SourceSelectionRange<'_>,
        fallback_columns: Option<(usize, usize)>,
    ) -> Option<ResolvedSourceProbe> {
        let file_index = self.file_index(selection.file)?;
        let exact = self.probe_range(file_index, selection);
        let exact_mapped = !exact.roots.is_empty() || !exact.direct_bits.is_empty();
        let resolved = if exact_mapped {
            selection
        } else {
            self.nearest_span(file_index, selection, fallback_columns, exact.source_seen)
        };
        let probe = if resolved == selection {
            exact
        } else {
            self.probe_range(file_index, resolved)
        };
        Some(ResolvedSourceProbe {
            roots: probe.roots.into_iter().collect(),
            direct_bits: probe.direct_bits,
            direction: probe.direction,
            local_bidirectional: probe.local_bidirectional,
            expand_output_register_inputs: probe.expand_output_register_inputs,
            truncated: probe.truncated,
            mapping_incomplete: probe.mapping_incomplete,
            source_seen: probe.source_seen,
        })
    }

    fn nearest_span<'a>(
        &self,
        file_index: usize,
        selection: SourceSelectionRange<'a>,
        fallback_columns: Option<(usize, usize)>,
        source_seen: bool,
    ) -> SourceSelectionRange<'a> {
        let (Some(caret_column), Some(end_column)) = (selection.start_column, selection.end_column)
        else {
            return selection;
        };
        if selection.start_line != selection.end_line || caret_column != end_column {
            return selection;
        }
        let Some((fallback_start, fallback_end)) = fallback_columns else {
            return selection;
        };
        if fallback_start < 1
            || fallback_end < fallback_start
            || caret_column < fallback_start
            || caret_column > fallback_end
        {
            return selection;
        }
        let file = &self.files[file_index];
        if source_seen {
            return selection;
        }
        let nearest = file
            .candidates(selection.start_line, selection.end_line)
            .iter()
            .filter(|span| {
                span.recovered()
                    && span.coordinates.start_line == selection.start_line
                    && span.coordinates.end_line == selection.end_line
                    && span.coordinates.start_column.is_some()
                    && span.coordinates.end_column.is_some()
                    && span
                        .coordinates
                        .start_column
                        .is_some_and(|start| start >= fallback_start)
                    && span
                        .coordinates
                        .end_column
                        .is_some_and(|end| end <= fallback_end)
            })
            .min_by_key(|span| {
                let start = span.coordinates.start_column.expect("precise source span");
                let end = span.coordinates.end_column.expect("precise source span");
                let distance = if caret_column < start {
                    start - caret_column
                } else {
                    caret_column.saturating_sub(end)
                };
                (distance, start, end)
            });
        nearest.map_or(selection, |span| SourceSelectionRange {
            file: selection.file,
            start_line: span.coordinates.start_line,
            end_line: span.coordinates.end_line,
            start_column: span.coordinates.start_column,
            end_column: span.coordinates.end_column,
        })
    }

    fn probe_range(&self, file_index: usize, selection: SourceSelectionRange<'_>) -> ProbeFacts {
        let file = &self.files[file_index];
        let matching = file
            .overlapping(
                selection.start_line,
                selection.end_line,
                selection.start_column,
                selection.end_column,
            )
            .collect::<Vec<_>>();
        let source_seen = if selection.start_column.is_none()
            || !source_columns_are_authoritative(selection.file)
        {
            file.seen_lines
                .range(selection.start_line..=selection.end_line)
                .next()
                .is_some()
                || matching.iter().any(|span| span.recovered_presence)
        } else {
            matching
                .iter()
                .any(|span| span.presence_indexed || span.recovered())
        };
        let mapping_incomplete = self.mapping_truncated
            || (selection.start_column.is_some() && file.incomplete_spans)
            || matching
                .iter()
                .any(|span| span.recovered() && span.mapping_incomplete());
        let mut roots = self.source_nodes_range(file_index, selection, &matching);
        let mut direct_bits = BTreeSet::new();
        let mut direct_bits_incomplete = false;
        for span in matching.iter().copied().filter(|span| span.recovered()) {
            for bit in span
                .mappings()
                .iter()
                .flat_map(|mapping| &mapping.exact_bits)
            {
                if !direct_bits.contains(bit) && direct_bits.len() == SOURCE_ROOT_COLLECTION_CAP {
                    direct_bits_incomplete = true;
                    continue;
                }
                direct_bits.insert(*bit);
            }
        }
        let mut selected = matching
            .iter()
            .copied()
            .filter(|span| span.has_any_policy())
            .collect::<Vec<_>>();
        let suppress_block = selection.start_line == selection.end_line
            && selected.iter().any(|span| span.has_non_block_policy());
        if suppress_block {
            selected.retain(|span| span.has_non_block_policy());
        }
        if selected.is_empty() {
            return ProbeFacts {
                roots,
                direct_bits: direct_bits.into_iter().collect(),
                direction: None,
                local_bidirectional: false,
                expand_output_register_inputs: false,
                truncated: false,
                mapping_incomplete: mapping_incomplete || direct_bits_incomplete,
                source_seen,
            };
        }
        if !suppress_block
            && selected.iter().all(|span| {
                span.has_any_policy()
                    && !span.has_non_block_policy()
                    && [SourceProbeDirection::Fanin, SourceProbeDirection::Fanout]
                        .into_iter()
                        .any(|direction| span.has_policy(SourceProbeHintKind::Block, direction))
            })
        {
            roots.clear();
        }
        let mut target_visits = 0usize;
        let mut truncated = false;
        'targets: for kind in [SourceProbeHintKind::Procedural, SourceProbeHintKind::Block] {
            if suppress_block && kind == SourceProbeHintKind::Block {
                continue;
            }
            for span in &selected {
                let has_kind = [SourceProbeDirection::Fanin, SourceProbeDirection::Fanout]
                    .into_iter()
                    .any(|direction| span.has_policy(kind, direction));
                if !has_kind {
                    continue;
                }
                if span.coordinates.start_column.is_some() {
                    for id in span.nodes() {
                        if target_visits == SOURCE_PROBE_TARGET_VISIT_CAP {
                            truncated = true;
                            break 'targets;
                        }
                        target_visits += 1;
                        if insert_bounded(&mut roots, *id) {
                            truncated = true;
                            break 'targets;
                        }
                    }
                    continue;
                }
                for ids in file
                    .procedural_targets
                    .range(span.coordinates.start_line..=span.coordinates.end_line)
                    .map(|(_, ids)| ids)
                {
                    for id in ids {
                        if target_visits == SOURCE_PROBE_TARGET_VISIT_CAP {
                            truncated = true;
                            break 'targets;
                        }
                        target_visits += 1;
                        if insert_bounded(&mut roots, *id) {
                            truncated = true;
                            break 'targets;
                        }
                    }
                }
            }
        }
        if roots.is_empty() {
            roots.extend(self.source_nodes_range(file_index, selection, &matching));
        }
        let has_fanin = selected.iter().any(|span| {
            [
                SourceProbeHintKind::Block,
                SourceProbeHintKind::OutputPort,
                SourceProbeHintKind::Procedural,
                SourceProbeHintKind::Signal,
            ]
            .into_iter()
            .any(|kind| {
                (!suppress_block || kind != SourceProbeHintKind::Block)
                    && span.has_policy(kind, SourceProbeDirection::Fanin)
            })
        });
        let has_fanout = selected.iter().any(|span| {
            [
                SourceProbeHintKind::Block,
                SourceProbeHintKind::OutputPort,
                SourceProbeHintKind::Procedural,
                SourceProbeHintKind::Signal,
            ]
            .into_iter()
            .any(|kind| {
                (!suppress_block || kind != SourceProbeHintKind::Block)
                    && span.has_policy(kind, SourceProbeDirection::Fanout)
            })
        });
        let shared_signal_span = selected.first().is_some_and(|first| {
            selected.iter().all(|span| {
                span.coordinates == first.coordinates
                    && ![
                        SourceProbeHintKind::Block,
                        SourceProbeHintKind::OutputPort,
                        SourceProbeHintKind::Procedural,
                    ]
                    .into_iter()
                    .any(|kind| {
                        (!suppress_block || kind != SourceProbeHintKind::Block)
                            && [SourceProbeDirection::Fanin, SourceProbeDirection::Fanout]
                                .into_iter()
                                .any(|direction| span.has_policy(kind, direction))
                    })
            })
        });
        ProbeFacts {
            roots: roots.into_iter().collect(),
            direct_bits: direct_bits.into_iter().collect(),
            direction: match (has_fanin, has_fanout) {
                (true, false) => Some(SourceProbeDirection::Fanin),
                (false, true) => Some(SourceProbeDirection::Fanout),
                _ => None,
            },
            local_bidirectional: has_fanin && has_fanout && shared_signal_span,
            expand_output_register_inputs: selected.iter().any(|span| {
                [SourceProbeDirection::Fanin, SourceProbeDirection::Fanout]
                    .into_iter()
                    .any(|direction| span.has_policy(SourceProbeHintKind::OutputPort, direction))
            }),
            truncated,
            mapping_incomplete: mapping_incomplete || direct_bits_incomplete,
            source_seen,
        }
    }

    fn source_nodes_range(
        &self,
        file_index: usize,
        selection: SourceSelectionRange<'_>,
        matching: &[&IndexedSpan],
    ) -> BTreeSet<NodeId> {
        let file = &self.files[file_index];
        let precise_lines = selection
            .start_column
            .map(|_| {
                matching
                    .iter()
                    .filter(|span| span.recovered() && span.coordinates.start_column.is_some())
                    .flat_map(|span| {
                        span.coordinates.start_line.max(selection.start_line)
                            ..=span.coordinates.end_line.min(selection.end_line)
                    })
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default();
        let mut roots = BTreeSet::new();
        'collect: {
            if selection.start_column.is_some() && source_columns_are_authoritative(selection.file)
            {
                for span in matching {
                    let selected_start = span.coordinates.start_line.max(selection.start_line);
                    let selected_end = span.coordinates.end_line.min(selection.end_line);
                    if (selected_start..=selected_end).all(|line| precise_lines.contains(&line)) {
                        continue;
                    }
                    for id in span.native_nodes() {
                        let admitted = (selected_start..=selected_end).any(|line| {
                            file.native_lines
                                .get(&line)
                                .is_some_and(|ids| ids.binary_search(id).is_ok())
                        });
                        if !admitted {
                            continue;
                        }
                        if insert_bounded(&mut roots, *id) {
                            break 'collect;
                        }
                    }
                }
            } else {
                for line in selection.start_line..=selection.end_line {
                    if precise_lines.contains(&line) {
                        continue;
                    }
                    if let Some(ids) = file.native_lines.get(&line) {
                        for id in ids {
                            if insert_bounded(&mut roots, *id) {
                                break 'collect;
                            }
                        }
                    }
                }
            }
            for span in matching.iter().copied().filter(|span| span.recovered()) {
                for id in span.nodes() {
                    if insert_bounded(&mut roots, *id) {
                        break 'collect;
                    }
                }
            }
        }
        self.narrow_to_assignment_targets(file_index, selection, roots, matching)
    }

    fn narrow_to_assignment_targets(
        &self,
        file_index: usize,
        selection: SourceSelectionRange<'_>,
        roots: BTreeSet<NodeId>,
        matching: &[&IndexedSpan],
    ) -> BTreeSet<NodeId> {
        let file = &self.files[file_index];
        if roots.is_empty() || file.procedural_targets.is_empty() {
            return roots;
        }
        let block_roots = roots
            .iter()
            .copied()
            .filter(|id| self.is_block_attributed(*id, selection))
            .collect::<HashSet<_>>();
        if block_roots.is_empty() {
            return roots;
        }
        let precise_targets = selection.start_column.and_then(|_| {
            let ids = matching
                .iter()
                .filter(|span| span.recovered() && span.coordinates.start_column.is_some())
                .flat_map(|span| span.nodes().iter().copied())
                .collect::<HashSet<_>>();
            (!ids.is_empty()).then_some(ids)
        });
        let mut targets = precise_targets.clone().unwrap_or_default();
        for line in selection.start_line..=selection.end_line {
            let line_targets = precise_targets.is_none().then(|| {
                file.procedural_targets
                    .get(&line)
                    .cloned()
                    .unwrap_or_default()
            });
            if let Some(ids) = &line_targets {
                targets.extend(ids.iter().copied());
            }
            let contributed = file
                .native_lines
                .get(&line)
                .is_some_and(|ids| ids.iter().any(|id| block_roots.contains(id)))
                || file.candidates(line, line).iter().any(|span| {
                    span.recovered()
                        && span.nodes().iter().any(|id| block_roots.contains(id))
                        && span.coordinates.start_line <= line
                        && line <= span.coordinates.end_line
                });
            if precise_targets.is_none()
                && contributed
                && line_targets.as_ref().is_none_or(Vec::is_empty)
            {
                return roots;
            }
        }
        if targets.is_empty() {
            return roots;
        }
        let narrowed = roots
            .iter()
            .copied()
            .filter(|id| targets.contains(id) || !block_roots.contains(id))
            .collect::<BTreeSet<_>>();
        if narrowed.is_empty() { roots } else { narrowed }
    }

    fn is_block_attributed(&self, id: NodeId, selection: SourceSelectionRange<'_>) -> bool {
        let span_outside = |coordinates: SpanCoordinates| {
            if !coordinates.overlaps(
                selection.start_line,
                selection.end_line,
                selection.start_column,
                selection.end_column,
            ) {
                return false;
            }
            match (
                coordinates.start_column,
                coordinates.end_column,
                selection.start_column,
                selection.end_column,
            ) {
                (
                    Some(span_start_column),
                    Some(span_end_column),
                    Some(start_column),
                    Some(end_column),
                ) => {
                    (coordinates.start_line, span_start_column)
                        < (selection.start_line, start_column)
                        || (coordinates.end_line, span_end_column)
                            > (selection.end_line, end_column)
                }
                _ => {
                    coordinates.start_line < selection.start_line
                        || coordinates.end_line > selection.end_line
                }
            }
        };
        self.spans_by_node.get(id).iter().any(|handle| {
            let (file, span) = self.span(*handle);
            file.name == selection.file && span_outside(span.coordinates)
        })
    }
}

#[derive(Debug)]
struct ProbeFacts {
    roots: BTreeSet<NodeId>,
    direct_bits: Vec<u32>,
    direction: Option<SourceProbeDirection>,
    local_bidirectional: bool,
    expand_output_register_inputs: bool,
    truncated: bool,
    mapping_incomplete: bool,
    source_seen: bool,
}

fn append_bit_mapping(
    response: &mut SourceBitRangesResponse,
    selected: &[u32],
    file: &SourceFileIndex,
    span: &IndexedSpan,
    mapping: &MappingFact,
) -> bool {
    let exact_match = mapping
        .exact_bits
        .iter()
        .any(|bit| selected.binary_search(bit).is_ok());
    let approximate_match = mapping
        .approximate_bits
        .iter()
        .any(|bit| selected.binary_search(bit).is_ok());
    if !exact_match && !approximate_match {
        return false;
    }
    if response.ranges.len() == SOURCE_BIT_RANGE_RESPONSE_CAP {
        response.truncated = true;
        return true;
    }
    response.truncated |= mapping.incomplete;
    response.approximate |= approximate_match;
    response.ranges.push(SourceRangeMapping {
        file: file.name.clone(),
        start_line: span.coordinates.start_line,
        end_line: span.coordinates.end_line,
        start_column: span.coordinates.start_column,
        end_column: span.coordinates.end_column,
        node_ids: Vec::new(),
        signal_bits: Vec::new(),
        approximate_signal_bits: Vec::new(),
        mapping_incomplete: mapping.incomplete,
    });
    false
}

fn public_mapping(
    file: &SourceFileIndex,
    span: &IndexedSpan,
    mapping: &MappingFact,
) -> SourceRangeMapping {
    SourceRangeMapping {
        file: file.name.clone(),
        start_line: span.coordinates.start_line,
        end_line: span.coordinates.end_line,
        start_column: span.coordinates.start_column,
        end_column: span.coordinates.end_column,
        node_ids: mapping.nodes.clone(),
        signal_bits: mapping.exact_bits.clone(),
        approximate_signal_bits: mapping.approximate_bits.clone(),
        mapping_incomplete: mapping.incomplete,
    }
}

fn policy_bit(kind: SourceProbeHintKind, direction: SourceProbeDirection) -> u16 {
    let kind = match kind {
        SourceProbeHintKind::Block => 0,
        SourceProbeHintKind::OutputPort => 1,
        SourceProbeHintKind::Procedural => 2,
        SourceProbeHintKind::Signal => 3,
    };
    let direction = match direction {
        SourceProbeDirection::Fanin => 0,
        SourceProbeDirection::Fanout => 1,
    };
    1 << (kind * 2 + direction)
}

fn insert_bounded(ids: &mut BTreeSet<NodeId>, id: NodeId) -> bool {
    if ids.len() < SOURCE_ROOT_COLLECTION_CAP {
        ids.insert(id);
    }
    ids.len() >= SOURCE_ROOT_COLLECTION_CAP
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Graph, Node, NodeKind};
    use std::collections::{BTreeMap, HashMap};

    fn native_graph(node_count: usize, unique_coordinates: bool) -> Graph {
        let nodes = (0..node_count)
            .map(|id| {
                let source = if unique_coordinates {
                    let column = id + 1;
                    format!("top.sv:1.{column}-1.{column}")
                } else {
                    "top.sv:1.1-1.1".to_owned()
                };
                Node {
                    id: id as NodeId,
                    kind: NodeKind::Cell,
                    name: format!("n{id}"),
                    raw_name: format!("n{id}"),
                    cell_type: Some("$and".to_owned()),
                    seq: false,
                    blackbox: false,
                    src: Some(source),
                    params: BTreeMap::new(),
                    port: None,
                    port_bit: None,
                    port_dir: None,
                    const_value: None,
                }
            })
            .collect();
        Graph {
            nodes,
            edges: Vec::new(),
            outgoing: Vec::new(),
            incoming: Vec::new(),
            top: "top".to_owned(),
            net_names: HashMap::new(),
            net_aliases: HashMap::new(),
            cell_info: HashMap::new(),
            blackboxes: Vec::new(),
            signal_fanout: HashMap::new(),
            clock_network: Vec::new(),
        }
    }

    #[test]
    fn canonical_span_cap_admits_duplicates_and_rejects_new_coordinates() {
        let existing = SpanCoordinates {
            start_line: 2,
            start_column: Some(7),
            end_line: 2,
            end_column: Some(12),
        };
        let omitted = SpanCoordinates {
            start_line: 3,
            ..existing
        };
        let mut builder = IndexBuilder::new(vec!["top.sv".to_owned()]);
        assert!(builder.add_presence("top.sv", existing));
        builder.presence_count = SOURCE_SPAN_INDEX_CAP;

        assert!(builder.add_presence("top.sv", existing));
        assert!(!builder.add_presence("top.sv", omitted));

        let index = builder.finish();
        assert_eq!(index.files[0].spans.len(), 1);
        assert!(index.files[0].incomplete_spans);
        assert!(!index.mapping_truncated);
    }

    #[test]
    fn rejected_recovered_presence_does_not_bypass_the_span_cap() {
        let mut builder = IndexBuilder::new(vec!["top.sv".to_owned()]);
        builder.recovered_presence_count = SOURCE_SPAN_INDEX_CAP;
        builder.add_recovered_presence(&SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 9,
            start_column: Some(3),
            end_line: 9,
            end_column: Some(8),
            node_ids: Vec::new(),
            signal_bits: Vec::new(),
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        });

        let index = builder.finish();
        assert!(index.files[0].spans.is_empty());
        assert!(index.files[0].incomplete_spans);
        assert!(!index.mapping_truncated);
    }

    #[test]
    fn saturated_presence_budget_does_not_drop_recovered_facts_or_hints() {
        let coordinates = SpanCoordinates {
            start_line: 9,
            start_column: Some(3),
            end_line: 9,
            end_column: Some(8),
        };
        let mut builder = IndexBuilder::new(vec!["top.sv".to_owned()]);
        builder.presence_count = SOURCE_SPAN_INDEX_CAP;
        assert!(!builder.add_presence("top.sv", coordinates));
        builder.add_recovered_range(SourceRangeMapping {
            file: "top.sv".to_owned(),
            start_line: 9,
            start_column: Some(3),
            end_line: 9,
            end_column: Some(8),
            node_ids: vec![7],
            signal_bits: vec![42],
            approximate_signal_bits: Vec::new(),
            mapping_incomplete: false,
        });
        builder.add_hint(
            "top.sv".to_owned(),
            coordinates,
            SourceProbeHintKind::Signal,
            SourceProbeDirection::Fanout,
        );

        let index = builder.finish();
        let span = &index.files[0].spans[0];
        assert!(span.recovered());
        assert_eq!(span.nodes(), vec![7]);
        assert_eq!(span.mappings()[0].exact_bits, vec![42]);
        assert!(span.has_policy(SourceProbeHintKind::Signal, SourceProbeDirection::Fanout));
    }

    #[test]
    fn node_reverse_index_stays_compact_for_a_sparse_high_node_id() {
        let mut sparse = SpanIndexBuilder::default();
        sparse.insert(99_999, 7);
        let index = NodeSpanIndex::from_builder(sparse);

        assert!(matches!(index, NodeSpanIndex::Compact(_)));
        assert_eq!(index.get(99_999), &[7]);
        assert!(index.get(0).is_empty());
    }

    #[test]
    fn native_line_cap_bounds_same_and_unique_coordinate_associations() {
        for unique_coordinates in [false, true] {
            let graph = native_graph(100_000, unique_coordinates);
            let index = SourceProvenanceIndex::from_graph(&graph, vec!["top.sv".to_owned()]);
            let file = &index.files[0];

            assert_eq!(file.native_lines[&1].len(), SOURCE_ROOT_COLLECTION_CAP);
            assert_eq!(
                file.spans
                    .iter()
                    .map(|span| span.native_nodes().len())
                    .sum::<usize>(),
                SOURCE_ROOT_COLLECTION_CAP
            );
            assert_eq!(
                index
                    .spans_by_node
                    .get((SOURCE_ROOT_COLLECTION_CAP - 1) as u32)
                    .len(),
                1
            );
            assert!(
                index
                    .spans_by_node
                    .get(SOURCE_ROOT_COLLECTION_CAP as u32)
                    .is_empty()
            );
        }
    }

    #[test]
    fn adaptive_bit_reverse_paths_return_identical_ordered_ranges() {
        let mut builder = IndexBuilder::new(vec!["top.sv".to_owned()]);
        for line in 1..=8 {
            builder.add_recovered_range(SourceRangeMapping {
                file: "top.sv".to_owned(),
                start_line: line,
                start_column: Some(1),
                end_line: line,
                end_column: Some(2),
                node_ids: vec![line as u32],
                signal_bits: vec![line as u32],
                approximate_signal_bits: vec![100 + line as u32],
                mapping_incomplete: line == 8,
            });
        }
        let indexed = builder.finish();
        assert!(!indexed.mapping_locations.is_empty());
        let mut scanned = indexed.clone();
        scanned.mapping_locations.clear();
        scanned.exact_by_bit = CompactSpanIndex::default();
        scanned.approximate_by_bit = CompactSpanIndex::default();

        for bits in [vec![1], vec![1, 8, 101, 108], vec![999]] {
            assert_eq!(
                serde_json::to_value(indexed.source_ranges_for_bits(&bits)).unwrap(),
                serde_json::to_value(scanned.source_ranges_for_bits(&bits)).unwrap()
            );
        }
    }
}
