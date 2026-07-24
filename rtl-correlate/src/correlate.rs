//! Correlation between a mapped netlist cut and the post-`proc` RTL snapshot.
//!
//! The mapped side of a correlation is summarized by the caller as a
//! [`MappedCut`]: the boundary net names its selected logic drives and
//! consumes. This module resolves those names against the RTL snapshot and
//! attributes the enclosed RTL cells' `src` spans.
//!
//! Grounding (verified against Yosys source, see the provenance findings
//! note): mapped cells carry no `src` after `abc`; only net names survive
//! mapping, and only public names are reliable. `$abc$<id>$<name>` aliases
//! embed the original net name. Post-`proc` `$mux`/`$pmux` cells carry
//! per-case-rule `src` pools while `$dff` cells carry the whole always
//! block, so register attribution reads the D-side mux tree for statement
//! precision and treats the flop's own span as a coarse fallback.
//!
//! The index covers the top module only: the RTL snapshot is written before
//! `flatten`, so logic inside child instances attributes to the
//! instantiation site's span and the result is flagged approximate.

use crate::NetlistDialect;
use crate::netlist::{PortDirection, YosysBit, YosysNetlist};
use crate::src_attr::{SrcSpan, parse_src_pool};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

/// RTL cells visited per attribution query before truncating.
pub const CORRELATION_CELL_VISIT_CAP: usize = 4_096;
/// Spans returned per tier before truncating.
pub const CORRELATION_SPAN_CAP: usize = 512;

#[derive(Debug, Clone, Copy)]
pub struct CorrelationLimits {
    pub cell_visit_cap: usize,
    pub span_cap: usize,
}

impl Default for CorrelationLimits {
    fn default() -> Self {
        Self {
            cell_visit_cap: CORRELATION_CELL_VISIT_CAP,
            span_cap: CORRELATION_SPAN_CAP,
        }
    }
}

/// The mapped-side summary of one selection: boundary net names reached by
/// walking the selection's fan-in/fan-out in the mapped netlist. Names are
/// passed raw; this module owns normalization.
#[derive(Debug, Clone, Default)]
pub struct MappedCut {
    /// Net names the selected logic drives (its output frontier).
    pub outputs: Vec<String>,
    /// Boundary net names feeding the selected logic.
    pub inputs: Vec<String>,
    /// The mapped-side walk hit its own caps before reaching boundaries.
    pub truncated: bool,
    /// The selection is a sequential element (register attribution mode).
    pub selected_is_sequential: bool,
}

/// Tiered attribution of one selection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Attribution {
    /// Spans the selected logic implements.
    pub exact: Vec<SrcSpan>,
    /// Gating conditions for a register selection (mux select cones).
    pub conditions: Vec<SrcSpan>,
    /// Upstream statements feeding the selection's boundaries.
    pub contributing: Vec<SrcSpan>,
    /// Attribution is a superset or fell back to coarser provenance.
    pub approximate: bool,
    /// A cap was hit; spans were dropped.
    pub truncated: bool,
}

#[derive(Debug, Default)]
struct RtlCell {
    spans: Vec<SrcSpan>,
    seq: bool,
    mux: bool,
    input_bits: Vec<u32>,
    data_bits: Vec<u32>,
    select_bits: Vec<u32>,
    output_bits: Vec<u32>,
}

/// Query index over the RTL snapshot's top module.
#[derive(Debug)]
pub struct CorrelationIndex {
    dialect: NetlistDialect,
    cells: Vec<RtlCell>,
    driver_of_bit: HashMap<u32, u32>,
    bits_by_name: HashMap<String, Vec<YosysBit>>,
    port_bits: HashSet<u32>,
    seq_out_bits: HashSet<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum CorrelateError {
    #[error("top module {0:?} not present in RTL snapshot")]
    TopNotFound(String),
}

impl CorrelationIndex {
    pub fn build(
        rtl: &YosysNetlist,
        top: &str,
        dialect: NetlistDialect,
    ) -> Result<Self, CorrelateError> {
        let module = rtl
            .modules
            .get(top)
            .ok_or_else(|| CorrelateError::TopNotFound(top.to_owned()))?;

        let mut cells = Vec::with_capacity(module.cells.len());
        let mut driver_of_bit = HashMap::new();
        let mut seq_out_bits = HashSet::new();
        // BTreeMap iteration keeps cell indices deterministic across runs.
        for cell in module.cells.values() {
            let index = cells.len() as u32;
            let seq = sequential_cell_type(&cell.cell_type);
            let mux = matches!(cell.cell_type.as_str(), "$mux" | "$pmux");
            let mut entry = RtlCell {
                spans: cell
                    .attributes
                    .get("src")
                    .map(|src| parse_src_pool(src).collect())
                    .unwrap_or_default(),
                seq,
                mux,
                ..RtlCell::default()
            };
            for (port, bits) in &cell.connections {
                let direction = cell.port_directions.get(port).copied();
                let nets = bits.iter().filter_map(YosysBit::net);
                match direction {
                    Some(PortDirection::Output) => {
                        for net in nets {
                            driver_of_bit.insert(net, index);
                            if seq {
                                seq_out_bits.insert(net);
                            }
                            entry.output_bits.push(net);
                        }
                    }
                    Some(PortDirection::Input) | Some(PortDirection::Inout) | None => {
                        // Instance cells and direction-less connections count
                        // as inputs so walks terminate on them cleanly.
                        for net in nets {
                            entry.input_bits.push(net);
                            if mux && port == "S" {
                                entry.select_bits.push(net);
                            } else if mux {
                                entry.data_bits.push(net);
                            }
                        }
                    }
                }
            }
            cells.push(entry);
        }

        let mut bits_by_name: HashMap<String, Vec<YosysBit>> = HashMap::new();
        for (name, netname) in &module.netnames {
            if name.starts_with('$') {
                // Private names are volatile through mapping; never a boundary.
                continue;
            }
            bits_by_name
                .entry(clean_public_name(name).to_owned())
                .or_default()
                .extend(netname.bits.iter().cloned());
        }

        let mut port_bits = HashSet::new();
        for port in module.ports.values() {
            port_bits.extend(port.bits.iter().filter_map(YosysBit::net));
        }

        Ok(Self {
            dialect,
            cells,
            driver_of_bit,
            bits_by_name,
            port_bits,
            seq_out_bits,
        })
    }

    /// Attribute a mapped-side cut against the RTL snapshot.
    pub fn attribute(&self, cut: &MappedCut, limits: &CorrelationLimits) -> Attribution {
        let mut result = Attribution {
            truncated: cut.truncated,
            ..Attribution::default()
        };
        let (output_bits, outputs_missing) = self.resolve_names(&cut.outputs, false);
        // Input boundaries stop the walk on every bit of the named net: a
        // boundary bus is a boundary regardless of which bit the mapped cone
        // consumed, and bit-precise stops would let word-level RTL cells
        // ($add, comparators) leak the walk through their other bits.
        let (input_bits, inputs_missing) = self.resolve_names(&cut.inputs, true);
        result.approximate |= outputs_missing || inputs_missing;
        if output_bits.is_empty() {
            result.approximate = true;
            return result;
        }

        if cut.selected_is_sequential {
            self.attribute_register(&output_bits, limits, &mut result);
        } else {
            self.attribute_combinational(&output_bits, &input_bits, limits, &mut result);
        }
        result
    }

    /// Register mode: exact = per-case spans on the D-side mux tree (falling
    /// back to the flop's whole-block span), conditions = mux select cones,
    /// contributing = the remaining D-cone statements up to shells.
    fn attribute_register(
        &self,
        q_bits: &BTreeSet<u32>,
        limits: &CorrelationLimits,
        result: &mut Attribution,
    ) {
        let mut exact = SpanCollector::new(limits.span_cap);
        let mut conditions = SpanCollector::new(limits.span_cap);
        let mut contributing = SpanCollector::new(limits.span_cap);
        let mut flop_spans = SpanCollector::new(limits.span_cap);
        let mut visited = HashSet::new();
        let mut budget = limits.cell_visit_cap;
        let mut condition_seeds = BTreeSet::new();
        let mut data_frontier = VecDeque::new();

        for &bit in q_bits {
            let Some(&cell) = self.driver_of_bit.get(&bit) else {
                result.approximate = true;
                continue;
            };
            let entry = &self.cells[cell as usize];
            if !entry.seq {
                // The Q boundary resolved onto combinational logic: treat it
                // as a plain cone rather than guessing.
                data_frontier.push_back(bit);
                result.approximate = true;
                continue;
            }
            flop_spans.extend(&entry.spans);
            if visited.insert(cell) {
                for &input in &entry.input_bits {
                    data_frontier.push_back(input);
                }
            }
        }

        // Walk the mux spine: mux cells contribute exact (case-level) spans
        // and their select bits seed condition cones; everything else in the
        // D-cone contributes upstream context.
        while let Some(bit) = data_frontier.pop_front() {
            if budget == 0 {
                result.truncated = true;
                break;
            }
            if self.port_bits.contains(&bit) || self.seq_out_bits.contains(&bit) {
                continue;
            }
            let Some(&cell) = self.driver_of_bit.get(&bit) else {
                continue;
            };
            if !visited.insert(cell) {
                continue;
            }
            budget -= 1;
            let entry = &self.cells[cell as usize];
            if entry.mux {
                exact.extend(&entry.spans);
                condition_seeds.extend(entry.select_bits.iter().copied());
                for &data in &entry.data_bits {
                    data_frontier.push_back(data);
                }
            } else {
                contributing.extend(&entry.spans);
                for &input in &entry.input_bits {
                    data_frontier.push_back(input);
                }
            }
        }

        if exact.is_empty() {
            // No mux tree (unconditional register): the always block itself
            // is the most precise statement-level fact available.
            result.approximate = true;
            exact = flop_spans;
        }

        self.walk_cone(
            condition_seeds.iter().copied(),
            &BTreeSet::new(),
            &mut conditions,
            &mut visited,
            &mut budget,
            &mut result.truncated,
        );

        result.exact = exact.into_spans(&mut result.truncated);
        result.conditions = conditions.into_spans(&mut result.truncated);
        result.contributing = contributing.into_spans(&mut result.truncated);
    }

    /// Combinational mode: exact = cells enclosed between the output frontier
    /// and the input boundaries, contributing = statements feeding those
    /// boundaries up to the previous register/port shell.
    fn attribute_combinational(
        &self,
        output_bits: &BTreeSet<u32>,
        input_bits: &BTreeSet<u32>,
        limits: &CorrelationLimits,
        result: &mut Attribution,
    ) {
        let mut exact = SpanCollector::new(limits.span_cap);
        let mut contributing = SpanCollector::new(limits.span_cap);
        let mut visited = HashSet::new();
        let mut budget = limits.cell_visit_cap;

        let frontier = self.walk_region(
            output_bits.iter().copied(),
            input_bits,
            &mut exact,
            &mut visited,
            &mut budget,
            &mut result.truncated,
        );

        self.walk_cone(
            frontier.iter().copied().chain(input_bits.iter().copied()),
            &BTreeSet::new(),
            &mut contributing,
            &mut visited,
            &mut budget,
            &mut result.truncated,
        );

        result.exact = exact.into_spans(&mut result.truncated);
        result.contributing = contributing.into_spans(&mut result.truncated);
    }

    /// Collect spans of cells strictly between `seeds` and `stop_bits`,
    /// returning the boundary bits actually reached.
    fn walk_region(
        &self,
        seeds: impl IntoIterator<Item = u32>,
        stop_bits: &BTreeSet<u32>,
        spans: &mut SpanCollector,
        visited: &mut HashSet<u32>,
        budget: &mut usize,
        truncated: &mut bool,
    ) -> BTreeSet<u32> {
        let mut frontier = BTreeSet::new();
        let mut queue: VecDeque<u32> = seeds.into_iter().collect();
        while let Some(bit) = queue.pop_front() {
            if stop_bits.contains(&bit)
                || self.port_bits.contains(&bit)
                || self.seq_out_bits.contains(&bit)
            {
                frontier.insert(bit);
                continue;
            }
            let Some(&cell) = self.driver_of_bit.get(&bit) else {
                continue;
            };
            if !visited.insert(cell) {
                continue;
            }
            if *budget == 0 {
                *truncated = true;
                break;
            }
            *budget -= 1;
            let entry = &self.cells[cell as usize];
            spans.extend(&entry.spans);
            for &input in &entry.input_bits {
                queue.push_back(input);
            }
        }
        frontier
    }

    /// Collect spans of the full fan-in cone from `seeds` up to register/port
    /// shells (crossing any bit in no stop set — pass an empty set to walk to
    /// the shells).
    fn walk_cone(
        &self,
        seeds: impl IntoIterator<Item = u32>,
        stop_bits: &BTreeSet<u32>,
        spans: &mut SpanCollector,
        visited: &mut HashSet<u32>,
        budget: &mut usize,
        truncated: &mut bool,
    ) {
        let mut queue: VecDeque<u32> = seeds.into_iter().collect();
        while let Some(bit) = queue.pop_front() {
            if stop_bits.contains(&bit) {
                continue;
            }
            let Some(&cell) = self.driver_of_bit.get(&bit) else {
                continue;
            };
            let entry = &self.cells[cell as usize];
            if !visited.insert(cell) {
                continue;
            }
            if *budget == 0 {
                *truncated = true;
                break;
            }
            *budget -= 1;
            spans.extend(&entry.spans);
            if entry.seq {
                // A register shell contributes its block span but is not
                // walked through.
                continue;
            }
            for &input in &entry.input_bits {
                if self.port_bits.contains(&input) {
                    continue;
                }
                queue.push_back(input);
            }
        }
    }

    /// Resolve raw mapped-side net names to RTL bits. Returns the resolved
    /// bit set and whether any name failed to resolve.
    fn resolve_names(&self, names: &[String], full_bus: bool) -> (BTreeSet<u32>, bool) {
        let mut bits = BTreeSet::new();
        let mut missing = false;
        for name in names {
            match self.resolve_name(name, full_bus) {
                Some(resolved) => bits.extend(resolved),
                None => missing = true,
            }
        }
        (bits, missing)
    }

    fn resolve_name(&self, raw: &str, full_bus: bool) -> Option<Vec<u32>> {
        let normalized = normalize_net_name(self.dialect, raw);
        if let Some(bits) = self.lookup(&normalized) {
            return Some(bits);
        }
        // `foo[3]` selects one bit of the RTL bus `foo` — or the whole bus
        // when the caller needs boundary-stop semantics.
        if let Some((base, index)) = split_bit_suffix(&normalized)
            && let Some(bits) = self.bits_by_name.get(base)
        {
            if full_bus {
                return Some(bits.iter().filter_map(YosysBit::net).collect());
            }
            return bits
                .get(index)
                .and_then(YosysBit::net)
                .map(|net| vec![net]);
        }
        // Vivado renames registers; try the dialect's logical base names.
        for base in self.dialect.register_base_candidates(&normalized) {
            if let Some(bits) = self.lookup(base) {
                return Some(bits);
            }
        }
        None
    }

    fn lookup(&self, name: &str) -> Option<Vec<u32>> {
        self.bits_by_name
            .get(name)
            .map(|bits| bits.iter().filter_map(YosysBit::net).collect())
    }
}

/// Normalize a mapped-netlist net name to its boundary key: strip the
/// `$abc$<id>$` alias wrapper (which embeds the original name) and any
/// leading `\`. `$techmap…` names never normalize to boundaries — template
/// internals are not RTL nets.
pub fn normalize_net_name(_dialect: NetlistDialect, name: &str) -> String {
    let mut candidate = name;
    if let Some(rest) = candidate.strip_prefix("$abc$")
        && let Some((digits, embedded)) = rest.split_once('$')
        && !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        candidate = embedded;
    }
    clean_public_name(candidate).to_owned()
}

fn clean_public_name(name: &str) -> &str {
    name.strip_prefix('\\').unwrap_or(name)
}

fn split_bit_suffix(name: &str) -> Option<(&str, usize)> {
    let rest = name.strip_suffix(']')?;
    let (base, index) = rest.rsplit_once('[')?;
    Some((base, index.parse().ok()?))
}

/// Post-`proc` sequential cell types (plus mapped flop forms so a mapped
/// snapshot never walks through a register shell).
fn sequential_cell_type(cell_type: &str) -> bool {
    matches!(
        cell_type,
        "$dff"
            | "$dffe"
            | "$adff"
            | "$adffe"
            | "$aldff"
            | "$aldffe"
            | "$sdff"
            | "$sdffe"
            | "$sdffce"
            | "$dffsr"
            | "$dffsre"
            | "$dlatch"
            | "$adlatch"
            | "$dlatchsr"
            | "$sr"
            | "$ff"
            | "$memrd"
            | "$memrd_v2"
            | "$memwr"
            | "$memwr_v2"
            | "$mem"
            | "$mem_v2"
    ) || cell_type.starts_with("$_DFF")
        || cell_type.starts_with("$_SDFF")
        || cell_type.starts_with("$_ALDFF")
        || cell_type.starts_with("$_DLATCH")
}

/// Bounded, deduplicating span accumulator.
#[derive(Debug)]
struct SpanCollector {
    spans: BTreeSet<SrcSpan>,
    cap: usize,
    dropped: bool,
}

impl SpanCollector {
    fn new(cap: usize) -> Self {
        Self {
            spans: BTreeSet::new(),
            cap,
            dropped: false,
        }
    }

    fn extend<'a>(&mut self, spans: impl IntoIterator<Item = &'a SrcSpan>) {
        for span in spans {
            if self.spans.len() >= self.cap {
                if !self.spans.contains(span) {
                    self.dropped = true;
                }
                continue;
            }
            self.spans.insert(span.clone());
        }
    }

    fn is_empty(&self) -> bool {
        self.spans.is_empty()
    }

    fn into_spans(self, truncated: &mut bool) -> Vec<SrcSpan> {
        *truncated |= self.dropped;
        self.spans.into_iter().collect()
    }
}
