//! Per-tool netlist conventions: name mangling and provenance quirks.

/// Which synthesis tool produced a mapped netlist.
///
/// Everything the product analyzes is normalized to Yosys JSON first, but
/// tools differ in how they rename nets and cells and in which provenance
/// facts survive synthesis. Those differences live here and nowhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, deepsize::DeepSizeOf)]
pub enum NetlistDialect {
    Yosys,
    Vivado,
}

impl NetlistDialect {
    /// Map the product's `tool` request field to a dialect.
    pub fn from_tool(tool: &str) -> Self {
        if tool.eq_ignore_ascii_case("vivado") {
            Self::Vivado
        } else {
            Self::Yosys
        }
    }

    /// Whether procedural-assignment source ranges must be materialized as
    /// range mappings. Vivado netlists carry no Yosys `src` attributes, so
    /// recovered procedural targets are the only statement-level provenance
    /// available for them.
    pub fn includes_procedural_ranges(self) -> bool {
        matches!(self, Self::Vivado)
    }

    /// Candidate logical base names for a mapped register or memory
    /// primitive name, most-specific first.
    ///
    /// Vivado commonly maps a logical `foo` to `foo_reg`, `foo_reg_3`, or
    /// stacked forms such as `a_reg_reg`; candidates are yielded from the
    /// rightmost `_reg` leftwards so a longer logical name wins over a
    /// shorter one. The Yosys dialect yields nothing: Yosys keeps logical
    /// names on the primitives it derives them from.
    pub fn register_base_candidates(self, name: &str) -> RegisterBaseCandidates<'_> {
        RegisterBaseCandidates {
            name,
            offsets: match self {
                Self::Yosys => Vec::new(),
                Self::Vivado => name
                    .rmatch_indices("_reg")
                    .map(|(offset, _)| offset)
                    .filter(|&offset| generated_reg_suffix(&name[offset..]))
                    .collect(),
            },
            next: 0,
        }
    }

    /// Candidate boundary base names for a mapped net name, most-specific
    /// first. Empty for Yosys (its aliases embed original names verbatim).
    ///
    /// The Vivado rules are derived from harvested Vivado 2026.1 netlists
    /// (OOC and standard mode):
    /// - I/O buffer nets are logically their port: `busy_OBUF` → `busy`,
    ///   `clk_IBUF_BUFG` → `clk_IBUF` → `clk` (suffixes peel iteratively).
    /// - Flop cell-pin nets name the register: `wait_count_reg_n_0` and
    ///   `state_reg_n_0_[2]` → the `_reg` family, which then unmangles to
    ///   the logical base.
    /// - FSM re-encoding prefixes wrap the original register name:
    ///   `FSM_onehot_state_reg_n_0_[0]` → `state` (bus-level: re-encoding
    ///   breaks per-bit correspondence, so only the whole register is a
    ///   trustworthy boundary).
    ///
    /// Internal cone nets (`…_i_3_n_0`, `…_INST_0_i_1_n_0`, `p_0_in`,
    /// `data_out0`) are deliberately NOT candidates: they are genuinely new
    /// intermediate nets, and treating them as boundaries would attribute
    /// wrong enclosed regions. They stay unresolvable so cone walks expand
    /// through them and flag the superset approximate.
    pub fn net_base_candidates(self, name: &str) -> NetBaseCandidates<'_> {
        if self != Self::Vivado {
            return NetBaseCandidates::default();
        }
        vivado_net_base_candidates(name)
    }
}

fn vivado_net_base_candidates(name: &str) -> NetBaseCandidates<'_> {
    let mut candidates = NetBaseCandidates::default();
    let last_segment = name.rfind(['.', '/']).map_or((name, ""), |separator| {
        (&name[separator + 1..], &name[..=separator])
    });

    // FSM re-encoding prefixes apply to the final hierarchical path segment;
    // the leading path is retained on every derived candidate.
    let mut base = name;
    let mut fsm_path = None;
    for prefix in ["FSM_onehot_", "FSM_sequential_", "FSM_gray_"] {
        if let Some(rest) = last_segment.0.strip_prefix(prefix) {
            if last_segment.1.is_empty() {
                base = rest;
                candidates.push_borrowed(name, base);
            } else {
                fsm_path = Some(last_segment.1);
                base = rest;
                candidates.push_joined(last_segment.1, base);
            }
            break;
        }
    }

    // I/O and clock buffer suffixes peel iteratively, each stage a
    // candidate (`clk_IBUF_BUFG` → `clk_IBUF` → `clk`).
    let mut buffered = base;
    loop {
        let mut stripped = None;
        for suffix in ["_IBUF_BUFG", "_BUFG", "_IBUF", "_OBUF"] {
            if let Some(rest) = buffered.strip_suffix(suffix) {
                stripped = Some(rest);
                break;
            }
        }
        match stripped {
            Some(rest) if !rest.is_empty() => {
                if let Some(path) = fsm_path {
                    candidates.push_joined(path, rest);
                } else {
                    candidates.push_borrowed(name, rest);
                }
                buffered = rest;
            }
            _ => break,
        }
    }

    // Flop cell-pin nets: `<cell>_n_<k>` and the bussed
    // `<cell>_n_<k>_[i]` form name the driving cell; the cell is a
    // `_reg`-family name that unmangles to the logical register.
    let mut pin = base;
    if let Some((cell, tail)) = pin.rsplit_once("_n_") {
        let digits_then_bit = {
            let (digits, rest) = tail
                .split_once("_[")
                .map_or((tail, None), |(digits, rest)| (digits, Some(rest)));
            !digits.is_empty()
                && digits.bytes().all(|byte| byte.is_ascii_digit())
                && rest.is_none_or(|rest| {
                    rest.strip_suffix(']').is_some_and(|index| {
                        !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
                    })
                })
        };
        if digits_then_bit {
            if let Some(path) = fsm_path {
                candidates.push_joined(path, cell);
            } else {
                candidates.push_borrowed(name, cell);
            }
            pin = cell;
        }
    }
    for (offset, _) in pin.rmatch_indices("_reg") {
        if generated_reg_suffix(&pin[offset..]) {
            if let Some(path) = fsm_path {
                candidates.push_joined(path, &pin[..offset]);
            } else {
                candidates.push_borrowed(name, &pin[..offset]);
            }
        }
    }

    candidates
}

/// Candidate list whose suffix-derived entries are zero-allocation subslices
/// of the queried name. Only a hierarchical FSM prefix strip reconstructs a
/// string so it can preserve the leading path.
#[derive(Debug)]
pub struct NetBaseCandidates<'a> {
    items: [Option<NetBaseCandidate<'a>>; 8],
    len: usize,
    next: usize,
}

#[derive(Debug)]
pub enum NetBaseCandidate<'a> {
    Borrowed(&'a str),
    Joined(String),
}

impl AsRef<str> for NetBaseCandidate<'_> {
    fn as_ref(&self) -> &str {
        match self {
            Self::Borrowed(candidate) => candidate,
            Self::Joined(candidate) => candidate,
        }
    }
}

impl Default for NetBaseCandidates<'_> {
    fn default() -> Self {
        Self {
            items: std::array::from_fn(|_| None),
            len: 0,
            next: 0,
        }
    }
}

impl<'a> NetBaseCandidates<'a> {
    fn push_borrowed(&mut self, name: &str, candidate: &'a str) {
        if candidate.is_empty() || candidate == name || self.len == self.items.len() {
            return;
        }
        if self.items[..self.len]
            .iter()
            .flatten()
            .any(|existing| existing.as_ref() == candidate)
        {
            return;
        }
        self.items[self.len] = Some(NetBaseCandidate::Borrowed(candidate));
        self.len += 1;
    }

    fn push_joined(&mut self, path: &str, candidate: &str) {
        if candidate.is_empty() || self.len == self.items.len() {
            return;
        }
        let candidate = format!("{path}{candidate}");
        if self.items[..self.len]
            .iter()
            .flatten()
            .any(|existing| existing.as_ref() == candidate)
        {
            return;
        }
        self.items[self.len] = Some(NetBaseCandidate::Joined(candidate));
        self.len += 1;
    }
}

impl<'a> Iterator for NetBaseCandidates<'a> {
    type Item = NetBaseCandidate<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        let item = self
            .items
            .get_mut(self.next)
            .filter(|_| self.next < self.len)?
            .take()?;
        self.next += 1;
        Some(item)
    }
}

/// Iterator over Vivado-style logical base-name candidates.
#[derive(Debug)]
pub struct RegisterBaseCandidates<'a> {
    name: &'a str,
    offsets: Vec<usize>,
    next: usize,
}

impl<'a> Iterator for RegisterBaseCandidates<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<&'a str> {
        let offset = *self.offsets.get(self.next)?;
        self.next += 1;
        Some(&self.name[..offset])
    }
}

/// Whether `suffix` consists solely of generated Vivado register
/// decorations: one or more `_reg` markers optionally followed by
/// `_<digits>` replication indices.
fn generated_reg_suffix(mut suffix: &str) -> bool {
    let mut stripped_reg = false;
    while let Some(rest) = suffix.strip_prefix("_reg") {
        stripped_reg = true;
        suffix = rest;
    }
    while let Some(rest) = suffix.strip_prefix('_') {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        suffix = &rest[digits..];
    }
    stripped_reg && suffix.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidates(dialect: NetlistDialect, name: &str) -> Vec<String> {
        dialect
            .register_base_candidates(name)
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn yosys_yields_no_candidates() {
        assert!(candidates(NetlistDialect::Yosys, "foo_reg").is_empty());
    }

    #[test]
    fn vivado_strips_generated_reg_suffixes() {
        assert_eq!(candidates(NetlistDialect::Vivado, "foo_reg"), ["foo"]);
        assert_eq!(candidates(NetlistDialect::Vivado, "foo_reg_5"), ["foo"]);
        assert_eq!(
            candidates(NetlistDialect::Vivado, "foo_reg_reg_0_1"),
            ["foo_reg", "foo"],
        );
    }

    #[test]
    fn vivado_rejects_non_generated_suffixes() {
        assert!(candidates(NetlistDialect::Vivado, "foo_regbank").is_empty());
        assert!(candidates(NetlistDialect::Vivado, "foo_reg_bank").is_empty());
        assert!(candidates(NetlistDialect::Vivado, "foo").is_empty());
        assert!(candidates(NetlistDialect::Vivado, "a_reg_regbank").is_empty());
    }

    #[test]
    fn candidates_run_rightmost_first() {
        assert_eq!(
            candidates(NetlistDialect::Vivado, "a_reg_reg"),
            ["a_reg", "a"],
        );
    }

    #[test]
    fn tool_mapping_defaults_to_yosys() {
        assert_eq!(NetlistDialect::from_tool("vivado"), NetlistDialect::Vivado);
        assert_eq!(NetlistDialect::from_tool("Vivado"), NetlistDialect::Vivado);
        assert_eq!(NetlistDialect::from_tool("yosys"), NetlistDialect::Yosys);
        assert_eq!(NetlistDialect::from_tool(""), NetlistDialect::Yosys);
    }

    #[test]
    fn procedural_ranges_only_for_vivado() {
        assert!(NetlistDialect::Vivado.includes_procedural_ranges());
        assert!(!NetlistDialect::Yosys.includes_procedural_ranges());
    }

    fn net_candidates(dialect: NetlistDialect, name: &str) -> Vec<String> {
        dialect
            .net_base_candidates(name)
            .map(|candidate| candidate.as_ref().to_owned())
            .collect()
    }

    #[test]
    fn yosys_has_no_net_candidates() {
        assert!(net_candidates(NetlistDialect::Yosys, "busy_OBUF").is_empty());
    }

    // Names below are verbatim from harvested Vivado 2026.1 netlists.
    #[test]
    fn vivado_buffer_nets_unmangle_to_their_ports() {
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "busy_OBUF"),
            ["busy"]
        );
        assert_eq!(net_candidates(NetlistDialect::Vivado, "rst_IBUF"), ["rst"],);
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "clk_IBUF_BUFG"),
            ["clk"],
        );
    }

    #[test]
    fn vivado_hierarchy_preserves_separators_while_applying_net_rules() {
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "u1/busy_OBUF"),
            ["u1/busy"],
        );
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "u1/state_reg_n_0"),
            ["u1/state_reg", "u1/state"],
        );
    }

    #[test]
    fn vivado_flop_pin_nets_unmangle_to_their_register() {
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "wait_count_reg_n_0"),
            ["wait_count_reg", "wait_count"],
        );
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "FSM_onehot_state_reg_n_0_[0]"),
            ["state_reg_n_0_[0]", "state_reg", "state"],
        );
    }

    #[test]
    fn vivado_flop_pin_parser_rejects_malformed_tails() {
        // Non-numeric pin tails and malformed bit indices are not flop pin
        // nets; inventing a base there would fabricate boundaries.
        assert!(net_candidates(NetlistDialect::Vivado, "sig_n_foo").is_empty());
        assert!(net_candidates(NetlistDialect::Vivado, "sig_n_").is_empty());
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "sig_reg_n_0_[x]"),
            // The `_reg` rule still applies to the un-stripped name; the
            // malformed pin tail itself must not produce `sig_reg`/`sig`.
            Vec::<String>::new(),
        );
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "state_reg_n_0_[12]"),
            ["state_reg", "state"],
        );
    }

    #[test]
    fn vivado_fsm_recode_prefixes_all_unmangle() {
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "FSM_sequential_state_reg_n_0"),
            ["state_reg_n_0", "state_reg", "state"],
        );
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "FSM_gray_state_reg"),
            ["state_reg", "state"],
        );
    }

    #[test]
    fn vivado_fsm_recode_prefixes_apply_to_the_last_path_segment() {
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "u1/FSM_onehot_state_reg_n_0",),
            ["u1/state_reg_n_0", "u1/state_reg", "u1/state"],
        );
        assert_eq!(
            net_candidates(NetlistDialect::Vivado, "u1.FSM_onehot_state_reg_n_0",),
            ["u1.state_reg_n_0", "u1.state_reg", "u1.state"],
        );
    }

    #[test]
    fn vivado_internal_cone_nets_yield_no_boundary_candidates() {
        // Intermediate LUT-output and helper nets are new logic, not
        // renamed boundaries; unmangling them would mis-attribute regions.
        for name in [
            "data_out[10]_INST_0_i_3_n_0",
            "wait_count[3]_i_1_n_0",
            "p_0_in",
            "data_out0",
            "data_out00_in",
        ] {
            let candidates = net_candidates(NetlistDialect::Vivado, name);
            assert!(
                !candidates.iter().any(|candidate| candidate == "data_out"
                    || candidate == "wait_count"
                    || candidate == "p"),
                "{name} must not unmangle to a boundary: {candidates:?}",
            );
        }
    }
}
