//! Per-tool netlist conventions: name mangling and provenance quirks.

/// Which synthesis tool produced a mapped netlist.
///
/// Everything the product analyzes is normalized to Yosys JSON first, but
/// tools differ in how they rename nets and cells and in which provenance
/// facts survive synthesis. Those differences live here and nowhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
}
