//! Delay-model calibration harness (developer tool, not part of the server).
//!
//! The estimated timing in [`synth_explorer_server::delay_model`] is fitted
//! against real Vivado post-synthesis `report_timing`. This tool makes that fit
//! reproducible:
//!
//! ```text
//!   gen      examples/ out/      # pin each case's parameters into concrete RTL
//!   estimate out/ est.json       # run Yosys + our estimate over those cases
//!   report   est.json vivado.json# compare, per family and speed grade
//!   fit      est.json vivado.json# least-squares speed-grade factors
//!   cells    cells.txt           # per-arc/per-net delays -> the coefficients
//! ```
//!
//! `cells` is the one that produces the numbers in `delay_model.rs`: it reads
//! the `NET:`/`CELL:` rows from a `calibration/cells.tcl` run (checked in at
//! `calibration/cells-2026.1.txt`) and prints a suggested coefficient row per
//! family. Nothing in `delay_model.rs` should be a number typed in by hand.
//!
//! `gen` writes byte-identical RTL for both tools: the same generated sources are
//! shipped to the Vivado host (see `calibration/vivado.tcl`) and read back here,
//! so a divergence can never come from the two tools reading different input.
//!
//! Vivado ground truth is checked in at `calibration/vivado-<version>.json`, so
//! `report`/`fit` run without Vivado access. Regenerate it only when the corpus
//! or the Vivado version changes — see `calibration/README.md`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use synth_explorer_server::analysis::{Analysis, estimate_timing};
use synth_explorer_server::delay_model::{CellClass, DelayModel};
use synth_explorer_server::graph::Graph;
use synth_explorer_server::netlist::{parse_value, select_top};
use synth_explorer_server::synthesis::run_synthesis;
use synth_explorer_server::yosys::{
    MemoryHandling, SourceFile, SynthMode, SynthRequest, SynthTool,
};

/// One calibration case: an example module pinned to concrete parameters.
#[derive(Debug, Clone, Deserialize)]
struct Case {
    name: String,
    file: String,
    top: String,
    #[serde(default)]
    params: BTreeMap<String, i64>,
}

#[derive(Debug, Deserialize)]
struct Spec {
    parts: BTreeMap<String, BTreeMap<String, String>>,
    cases: Vec<Case>,
}

/// Our estimate for one case, at the family's baseline (-1) coefficients.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Estimate {
    case: String,
    family: String,
    /// Worst-case path delay (ns) from the Tier-0 model.
    delay_ns: f64,
    launch_ns: f64,
    logic_ns: f64,
    net_ns: f64,
    setup_ns: f64,
    /// Structural depth of the critical path, for sanity-checking against
    /// Vivado's "Logic Levels".
    depth: u32,
}

/// Vivado's `report_timing` for one case (produced by `calibration/vivado.tcl`).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct VivadoTiming {
    case: String,
    family: String,
    speed_grade: String,
    /// `Data Path Delay` — clock-to-Q + logic + route. Setup is NOT included
    /// (Vivado folds it into slack), so this is what our launch+logic+net sums to.
    data_path_ns: f64,
    logic_ns: f64,
    route_ns: f64,
    logic_levels: u32,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("gen") => cmd_gen(&args[1..]),
        Some("estimate") => cmd_estimate(&args[1..]),
        Some("report") => cmd_report(&args[1..]),
        Some("fit") => cmd_fit(&args[1..]),
        Some("cells") => cmd_cells(&args[1..]),
        _ => {
            eprintln!(
                "usage:\n  \
                 calibrate gen <examples-dir> <out-dir>\n  \
                 calibrate estimate <cases-dir> <out.json>\n  \
                 calibrate report <est.json> <vivado.json>\n  \
                 calibrate fit <est.json> <vivado.json>\n  \
                 calibrate cells <cells.txt>"
            );
            return ExitCode::FAILURE;
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::FAILURE
        }
    }
}

fn read_spec(dir: &Path) -> anyhow::Result<Spec> {
    let path = dir.join("cases.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| anyhow::anyhow!("reading {}: {e}", path.display()))?;
    Ok(serde_json::from_str(&text)?)
}

// ---------------------------------------------------------------------------
// gen — pin parameters into concrete RTL
// ---------------------------------------------------------------------------

/// Rewrite `parameter int unsigned NAME = <default>` to `= value`.
///
/// Both tools then read the same literal source, so Yosys and Vivado cannot
/// disagree because of how a parameter was overridden. Derived parameters
/// (`INDEX_WIDTH`, `SUM_WIDTH`, …) are expressions over the overridden ones and
/// recompute on their own. Errors if the parameter isn't found rather than
/// silently synthesizing the default — a silent miss would calibrate against the
/// wrong design.
fn pin_param(source: &str, name: &str, value: i64) -> anyhow::Result<String> {
    const PREFIX: &str = "parameter int unsigned ";
    let mut out = Vec::new();
    let mut hits = 0;
    for line in source.lines() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix(PREFIX) else {
            out.push(line.to_owned());
            continue;
        };
        let ident: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if ident != name {
            out.push(line.to_owned());
            continue;
        }
        let Some(eq) = line.find('=') else {
            anyhow::bail!("parameter {name} declaration has no '='");
        };
        // Preserve a trailing comma: it separates this parameter from the next.
        let tail = if line.trim_end().ends_with(',') {
            ","
        } else {
            ""
        };
        out.push(format!("{}= {value}{tail}", &line[..eq]));
        hits += 1;
    }
    if hits != 1 {
        anyhow::bail!("expected exactly 1 declaration of `{name}`, found {hits}");
    }
    Ok(out.join("\n") + "\n")
}

fn cmd_gen(args: &[String]) -> anyhow::Result<()> {
    let (examples, out) = match args {
        [a, b] => (PathBuf::from(a), PathBuf::from(b)),
        _ => anyhow::bail!("usage: calibrate gen <examples-dir> <out-dir>"),
    };
    // The spec lives next to the harness; the RTL comes from the examples dir
    // under test, so a reworked example set can be calibrated without moving it.
    let spec = read_spec(&PathBuf::from("../calibration"))?;
    std::fs::create_dir_all(&out)?;
    for case in &spec.cases {
        let src = std::fs::read_to_string(examples.join(&case.file))
            .map_err(|e| anyhow::anyhow!("reading example {}: {e}", case.file))?;
        let mut pinned = src;
        for (name, value) in &case.params {
            pinned = pin_param(&pinned, name, *value)
                .map_err(|e| anyhow::anyhow!("case {}: {e}", case.name))?;
        }
        let dir = out.join(&case.name);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join(&case.file), pinned)?;
    }
    // Re-emit the spec beside the generated RTL so the Vivado host needs only
    // this one directory.
    std::fs::copy("../calibration/cases.json", out.join("cases.json"))?;
    println!("generated {} cases in {}", spec.cases.len(), out.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// estimate — run Yosys + our model over the generated cases
// ---------------------------------------------------------------------------

/// The Yosys `synth_xilinx -family` value each calibrated preset corresponds to.
/// These are Yosys's own spellings (`yosys -p "help synth_xilinx"`) — note
/// UltraScale is `xcu`, not `xcku`; Yosys hard-errors on anything else.
fn family_arg(family: &str) -> &'static str {
    match family {
        "ultrascale" => "xcu",
        "ultrascale_plus" => "xcup",
        _ => "xc7",
    }
}

async fn estimate_case(dir: &Path, case: &Case, family: &str) -> anyhow::Result<Estimate> {
    let content = std::fs::read_to_string(dir.join(&case.name).join(&case.file))?;
    let request = SynthRequest {
        files: vec![SourceFile {
            name: case.file.clone(),
            content,
        }],
        top: Some(case.top.clone()),
        tool: SynthTool::Yosys,
        mode: SynthMode::Xilinx,
        target: None,
        // `-noiopad -noclkbuf` matches Vivado's `-mode out_of_context`, so both
        // tools produce a bare fabric netlist. Without it Yosys inserts
        // IBUF/OBUF/BUFG that Vivado's OOC run does not have, and the two sides
        // would be timing different circuits. It also keeps pad and clock-tree
        // delay — real, but package-dependent and not what these coefficients
        // model — out of the fit.
        extra_args: Some(format!("-family {} -noiopad -noclkbuf", family_arg(family))),
    };
    let validated = request
        .validate()
        .map_err(|e| anyhow::anyhow!("validate {}: {e}", case.name))?;
    let output = run_synthesis(&validated, MemoryHandling::Map)
        .await
        .map_err(|e| anyhow::anyhow!("synth {}: {e}", case.name))?;
    let parsed = parse_value(output.json)?;
    let (top, module) = select_top(&parsed, None)?;
    let graph = Graph::from_netlist(&parsed, top, module)?;

    // Exactly the model the server would pick for this target, so the harness
    // measures the shipped default rather than a parallel copy of it.
    let model = DelayModel::for_target("xilinx", Some(family_arg(family)));
    let estimate = estimate_timing(&graph, &model);
    let delay_ns = estimate
        .delay_ns
        .ok_or_else(|| anyhow::anyhow!("case {} has no combinational path", case.name))?;
    let bd = estimate
        .breakdown
        .ok_or_else(|| anyhow::anyhow!("case {} has no breakdown", case.name))?;
    let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);
    let depth = analysis.stats().max_depth;
    Ok(Estimate {
        case: case.name.clone(),
        family: family.to_owned(),
        delay_ns,
        launch_ns: bd.launch_ns,
        logic_ns: bd.logic_ns,
        net_ns: bd.net_ns,
        setup_ns: bd.setup_ns,
        depth,
    })
}

fn cmd_estimate(args: &[String]) -> anyhow::Result<()> {
    let (dir, out) = match args {
        [a, b] => (PathBuf::from(a), PathBuf::from(b)),
        _ => anyhow::bail!("usage: calibrate estimate <cases-dir> <out.json>"),
    };
    let spec = read_spec(&dir)?;
    let runtime = tokio::runtime::Runtime::new()?;
    let mut estimates = Vec::new();
    for family in spec.parts.keys() {
        for case in &spec.cases {
            match runtime.block_on(estimate_case(&dir, case, family)) {
                Ok(est) => {
                    println!(
                        "{:<18} {:<16} {:>7.3} ns",
                        est.case, est.family, est.delay_ns
                    );
                    estimates.push(est);
                }
                // A case that has no timing path at all (or that Yosys can't
                // map) is reported and skipped, never silently dropped.
                Err(err) => eprintln!("skip {} [{}]: {err:#}", case.name, family),
            }
        }
    }
    std::fs::write(&out, serde_json::to_string_pretty(&estimates)?)?;
    println!("wrote {} estimates to {}", estimates.len(), out.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// report / fit
// ---------------------------------------------------------------------------

fn load<T: for<'de> Deserialize<'de>>(path: &str) -> anyhow::Result<Vec<T>> {
    let text = std::fs::read_to_string(path)?;
    let value: Value = serde_json::from_str(&text)?;
    Ok(serde_json::from_value(value)?)
}

/// Pair our estimate with Vivado's measurement for the baseline speed grade.
///
/// Compares `launch + logic + net` against Vivado's `Data Path Delay`: Vivado
/// reports setup separately (inside slack), so including our setup term would
/// compare different quantities.
///
/// Only the *total* is comparable, not the columns: Vivado folds register
/// clock-to-Q into its `logic` figure, whereas we keep it in `launch`. So our
/// `logic_ns` and Vivado's `logic_ns` differ by a clk-to-Q on any FF-launched
/// path, by construction.
fn comparable_ns(est: &Estimate) -> f64 {
    est.launch_ns + est.logic_ns + est.net_ns
}

fn cmd_report(args: &[String]) -> anyhow::Result<()> {
    let (est_path, viv_path) = match args {
        [a, b] => (a.clone(), b.clone()),
        _ => anyhow::bail!("usage: calibrate report <est.json> <vivado.json>"),
    };
    let estimates: Vec<Estimate> = load(&est_path)?;
    let vivado: Vec<VivadoTiming> = load(&viv_path)?;

    let mut errors = Vec::new();
    // Errors on the subset where Yosys and Vivado agree on the netlist's
    // structure. See the note printed below: on the rest, the two tools are not
    // timing the same circuit, so the residual is mapping quality rather than
    // model quality and no coefficient can fix it.
    let mut matched_errors = Vec::new();
    let mut depth_ratios = Vec::new();
    let mut zero_level = Vec::new();
    let mut unpaired = Vec::new();
    println!(
        "{:<18} {:<16} {:>8} {:>8} {:>7}  {:>6} {:>6} {:>6}",
        "case", "family", "est", "vivado", "err", "depth", "levels", "d/l"
    );
    for family in ["series7", "ultrascale", "ultrascale_plus"] {
        for est in estimates.iter().filter(|e| e.family == family) {
            // The presets are characterized at -1; other grades are the `fit`
            // subcommand's job.
            let Some(viv) = vivado
                .iter()
                .find(|v| v.case == est.case && v.family == family && v.speed_grade == "-1")
            else {
                unpaired.push(format!("{} [{}]", est.case, family));
                continue;
            };
            // Vivado's worst path here has no logic in it (a bare FF->FF or
            // FF->port hop). Our model only walks combinational nodes, so it is
            // not estimating that path at all — the two numbers describe
            // different things and averaging them in would flatter or punish the
            // fit for no reason. Held out and reported, not dropped.
            if viv.logic_levels == 0 {
                zero_level.push(format!("{} [{}]", est.case, family));
                continue;
            }
            let ours = comparable_ns(est);
            let err = (ours - viv.data_path_ns) / viv.data_path_ns * 100.0;
            errors.push(err.abs());
            let ratio = f64::from(est.depth) / f64::from(viv.logic_levels);
            depth_ratios.push(ratio);
            if est.depth == viv.logic_levels {
                matched_errors.push(err.abs());
            }
            println!(
                "{:<18} {:<16} {:>8.3} {:>8.3} {:>6.0}%  {:>6} {:>6} {:>6.1}",
                est.case, family, ours, viv.data_path_ns, err, est.depth, viv.logic_levels, ratio
            );
        }
    }
    if !errors.is_empty() {
        let mean = errors.iter().sum::<f64>() / errors.len() as f64;
        let worst = errors.iter().cloned().fold(0.0_f64, f64::max);
        println!(
            "\n{} pairs — mean abs err {mean:.1}%, worst {worst:.0}%",
            errors.len()
        );

        // Separate model error from mapping error. This is the number that says
        // when to reach for the Vivado backend instead of tuning coefficients.
        let mut sorted = depth_ratios.clone();
        sorted.sort_by(f64::total_cmp);
        let median = sorted[sorted.len() / 2];
        let mean_ratio = depth_ratios.iter().sum::<f64>() / depth_ratios.len() as f64;
        println!(
            "\nstructural mismatch — our depth / Vivado's logic levels: median {median:.2}, \
             mean {mean_ratio:.2} over {} pairs ({} at 2x or worse)",
            depth_ratios.len(),
            depth_ratios.iter().filter(|r| **r >= 2.0).count(),
        );
        if !matched_errors.is_empty() {
            let m = matched_errors.iter().sum::<f64>() / matched_errors.len() as f64;
            let w = matched_errors.iter().cloned().fold(0.0_f64, f64::max);
            println!(
                "  on the {} pairs where depth == levels (same structure, so this is \
                 model error): mean abs err {m:.1}%, worst {w:.0}%",
                matched_errors.len()
            );
        }
        println!(
            "  Yosys and Vivado map the same RTL to different netlists (Yosys emits LUT\n  \
             chains where Vivado packs LUT6; it infers FF chains where Vivado infers SRL16E).\n  \
             Timing a ~2x deeper netlist overestimates however good the per-hop model is —\n  \
             that part is mapping quality, not model error, and fitting it away would turn\n  \
             the coefficients into fudge factors. Use the Vivado backend to time Vivado's\n  \
             netlist."
        );
    }
    if !zero_level.is_empty() {
        println!(
            "\nheld out — Vivado's worst path has 0 logic levels, which our model \
             has no path for ({}): {}",
            zero_level.len(),
            zero_level.join(", ")
        );
    }
    if !unpaired.is_empty() {
        println!(
            "\nno Vivado measurement ({}): {}",
            unpaired.len(),
            unpaired.join(", ")
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// cells — attribute measured delay to the primitive that caused it
// ---------------------------------------------------------------------------

/// One `NET:` row from `calibration/cells.tcl`: a single driver→sink hop with
/// the delay Vivado estimated for it.
#[derive(Debug, Clone, PartialEq)]
struct NetRow {
    family: String,
    case: String,
    fanout: u32,
    /// `unplaced` (UG906's documented estimate) or `unset`/`none` (port nets —
    /// a category no AMD doc describes, kept separate rather than averaged in).
    state: String,
    incr_ns: f64,
    driver: String,
    sink: String,
    sink_pin: String,
    net: String,
}

/// One `CELL:` row: a primitive's pin-to-pin timing arc and its delay.
#[derive(Debug, Clone, PartialEq)]
struct CellRow {
    family: String,
    case: String,
    arc: String,
    incr_ns: f64,
}

/// Parse the `NET:`/`CELL:` lines out of a `cells.tcl` run.
///
/// Vivado's own log lines are interleaved and are ignored. A malformed
/// `NET:`/`CELL:` line is an error rather than a skip: silently dropping rows
/// is exactly how a probe reports confident numbers from half a corpus.
fn parse_cells_log(text: &str) -> anyhow::Result<(Vec<NetRow>, Vec<CellRow>)> {
    let mut nets = Vec::new();
    let mut cells = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("NET:") {
            let f: Vec<&str> = rest.split_whitespace().collect();
            let [
                family,
                case,
                fanout,
                state,
                incr,
                driver,
                sink,
                sink_pin,
                net,
            ] = f[..]
            else {
                anyhow::bail!("malformed NET row: {line}");
            };
            nets.push(NetRow {
                family: family.to_owned(),
                case: case.to_owned(),
                fanout: fanout.parse()?,
                state: state.to_owned(),
                incr_ns: incr.parse()?,
                driver: driver.to_owned(),
                sink: sink.to_owned(),
                sink_pin: sink_pin.to_owned(),
                net: net.to_owned(),
            });
        } else if let Some(rest) = line.strip_prefix("CELL:") {
            let f: Vec<&str> = rest.split_whitespace().collect();
            let [family, case, arc, incr] = f[..] else {
                anyhow::bail!("malformed CELL row: {line}");
            };
            cells.push(CellRow {
                family: family.to_owned(),
                case: case.to_owned(),
                arc: arc.to_owned(),
                incr_ns: incr.parse()?,
            });
        }
    }
    Ok((nets, cells))
}

/// Classify a probe's primitive name into the model's category.
///
/// `port` is the probe's own marker for a top-level boundary; everything else
/// is a real primitive name and goes through the same [`CellClass`] the shipped
/// model uses, so the fit cannot classify differently from the estimator.
fn class_of(prim: &str) -> CellClass {
    if prim == "port" {
        CellClass::Port
    } else {
        CellClass::of(prim)
    }
}

/// Whether a net sinks into a **clock** pin.
///
/// A data path never terminates at a clock pin, so such a row is always the
/// clock tree leaking into the data numbers. `cells.tcl` gates these out at the
/// source now, but the invariant is cheap to enforce here too and this is the
/// bug that keeps coming back (see #53): a destination clock path's
/// `net (fo=3, unset) 0.924 clk` otherwise becomes a phantom `LUT->FF` route.
fn is_clock_pin(pin: &str) -> bool {
    let upper = pin.to_ascii_uppercase();
    matches!(upper.as_str(), "C" | "CLK" | "CK" | "G")
        || upper.starts_with("CLK")
        || upper.ends_with("CLK")
}

/// Mean of a slice, or NaN when empty.
fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        f64::NAN
    } else {
        xs.iter().sum::<f64>() / xs.len() as f64
    }
}

/// Pearson correlation of paired samples.
fn correlation(pairs: &[(f64, f64)]) -> f64 {
    let n = pairs.len() as f64;
    if pairs.len() < 2 {
        return f64::NAN;
    }
    let mx = pairs.iter().map(|(x, _)| x).sum::<f64>() / n;
    let my = pairs.iter().map(|(_, y)| y).sum::<f64>() / n;
    let mut sxy = 0.0;
    let mut sxx = 0.0;
    let mut syy = 0.0;
    for (x, y) in pairs {
        sxy += (x - mx) * (y - my);
        sxx += (x - mx) * (x - mx);
        syy += (y - my) * (y - my);
    }
    if sxx <= 0.0 || syy <= 0.0 {
        return f64::NAN;
    }
    sxy / (sxx * syy).sqrt()
}

/// Slope through the origin of within-design-centred residuals.
///
/// **This is the no-pooling rule from `calibration/README.md`, and it is now
/// documentation-backed rather than only an empirical scar.** UG906 p.132 says
/// the estimate keys on the *nature of the driver and loads* as well as fanout,
/// so each design sits at its own baseline set by its driver/load type mix. A
/// pooled regression therefore measures that type-mix confound, not fanout: on
/// Series-7 pooling reports r = -0.09 and a negative slope ("routing has no
/// fanout dependence") while `barrel_w32` alone shows r = +0.95. Simpson's
/// paradox. Designs with no fanout spread contribute no information and are
/// skipped rather than dragging the slope to zero.
fn fanout_slope(rows: &[&NetRow]) -> (f64, f64, usize) {
    let mut by_case: BTreeMap<&str, Vec<(f64, f64)>> = BTreeMap::new();
    for r in rows {
        by_case
            .entry(r.case.as_str())
            .or_default()
            .push((f64::from(r.fanout.max(1)).log2(), r.incr_ns * 1000.0));
    }
    let mut residuals: Vec<(f64, f64)> = Vec::new();
    let mut used = 0;
    for pairs in by_case.values() {
        let xs: Vec<f64> = pairs.iter().map(|(x, _)| *x).collect();
        // No fanout spread inside this design => no information about the
        // fanout term. Including it only adds an intercept to average away.
        if xs.iter().any(|x| (x - xs[0]).abs() > 1e-9) {
            let mx = mean(&xs);
            let my = mean(&pairs.iter().map(|(_, y)| *y).collect::<Vec<_>>());
            for (x, y) in pairs {
                residuals.push((x - mx, y - my));
            }
            used += 1;
        }
    }
    let num: f64 = residuals.iter().map(|(x, y)| x * y).sum();
    let den: f64 = residuals.iter().map(|(x, _)| x * x).sum();
    let slope = if den > 0.0 { num / den } else { f64::NAN };
    (slope, correlation(&residuals), used)
}

/// Carry-propagate delay per **Yosys `CARRY4`**, which is the unit the model
/// charges — not per Vivado carry cell.
///
/// Yosys emits `CARRY4` for *every* Xilinx family (verified: `synth_xilinx
/// -family xc7|xcu|xcup` all produce CARRY4), but Vivado uses `CARRY8` on
/// UltraScale and UltraScale+. So one Vivado CARRY8 arc spans two of our cells,
/// and pasting a CARRY8 delay into `carry_ps` would double the carry cost of
/// every UltraScale adder.
///
/// The propagate arcs also span different bit counts (`CI_CO[0]` is one bit,
/// `CI_CO[7]` is eight), so averaging them is meaningless. Take the widest
/// propagate arc, reduce it to a per-bit rate, and scale to CARRY4's 4 bits.
fn carry_ps_per_yosys_carry4(cells: &[CellRow], family: &str) -> f64 {
    let mut best: Option<(u32, f64)> = None;
    for c in cells.iter().filter(|c| c.family == family) {
        let arc = c.arc.to_ascii_lowercase();
        if !arc.starts_with("carry") || !arc.contains("_ci_co") {
            continue;
        }
        // `carry8_ci_co[7]` -> span 8 (bits 0..=7).
        let Some(idx) = arc
            .rsplit_once('[')
            .and_then(|(_, tail)| tail.trim_end_matches(']').parse::<u32>().ok())
        else {
            continue;
        };
        let span = idx + 1;
        if best.is_none_or(|(s, _)| span > s) {
            best = Some((span, c.incr_ns * 1000.0));
        }
    }
    match best {
        Some((span, ps)) => ps / f64::from(span) * 4.0,
        None => f64::NAN,
    }
}

fn cmd_cells(args: &[String]) -> anyhow::Result<()> {
    let path = match args {
        [a] => a.clone(),
        _ => anyhow::bail!("usage: calibrate cells <cells.txt>"),
    };
    let text = std::fs::read_to_string(&path)?;
    let (mut nets, cells) = parse_cells_log(&text)?;

    // Drop clock-tree rows loudly rather than silently: a count here is the
    // tell that `cells.tcl`'s clock gating has regressed.
    let total = nets.len();
    nets.retain(|r| !is_clock_pin(&r.sink_pin));
    if nets.len() != total {
        println!(
            "dropped {} clock-pin rows (clock tree, not data paths)",
            total - nets.len()
        );
    }

    // The probe runs two reports per case (all endpoints, then
    // register-to-register), so a path reachable both ways yields byte-identical
    // rows twice. Dedupe on the whole tuple: two rows differing only in delay
    // are genuinely different arcs and both must survive.
    let before = nets.len();
    nets.sort_by(|a, b| {
        (&a.family, &a.case, &a.net, &a.sink, &a.sink_pin, &a.driver)
            .cmp(&(&b.family, &b.case, &b.net, &b.sink, &b.sink_pin, &b.driver))
            .then(a.incr_ns.total_cmp(&b.incr_ns))
            .then(a.fanout.cmp(&b.fanout))
    });
    nets.dedup();
    println!(
        "{} net rows ({} after de-duplicating the two reports), {} cell rows\n",
        before,
        nets.len(),
        cells.len()
    );

    // --- Net delay by driver->sink pair, which is what UG906 p.132 says the
    // --- estimate keys on. `unset`/`none` (port) nets are reported apart from
    // --- `unplaced` (fabric) nets: they are a different, undocumented category.
    for state_group in ["unplaced", "port"] {
        println!(
            "== net delay, {} ==",
            if state_group == "unplaced" {
                "state=unplaced (UG906 'estimated' fabric route)"
            } else {
                "state=unset/none (port boundary nets — undocumented category)"
            }
        );
        println!(
            "{:<16} {:>8} {:>8} {:>5} {:>8} {:>8} {:>8} {:>7} {:>6}",
            "family", "driver", "sink", "n", "mean_ps", "min_ps", "max_ps", "fo_med", "cases"
        );
        for family in ["series7", "ultrascale", "ultrascale_plus"] {
            let mut groups: BTreeMap<(String, String), Vec<&NetRow>> = BTreeMap::new();
            for r in nets.iter().filter(|r| r.family == family) {
                let is_port = r.state == "unset" || r.state == "none";
                if (state_group == "port") != is_port {
                    continue;
                }
                let d = class_of(&r.driver);
                let s = class_of(&r.sink);
                groups
                    .entry((format!("{d:?}"), format!("{s:?}")))
                    .or_default()
                    .push(r);
            }
            for ((d, s), rows) in &groups {
                let ps: Vec<f64> = rows.iter().map(|r| r.incr_ns * 1000.0).collect();
                let mut fos: Vec<u32> = rows.iter().map(|r| r.fanout).collect();
                fos.sort_unstable();
                let cases: std::collections::BTreeSet<&str> =
                    rows.iter().map(|r| r.case.as_str()).collect();
                println!(
                    "{family:<16} {d:>8} {s:>8} {:>5} {:>8.0} {:>8.0} {:>8.0} {:>7} {:>6}",
                    ps.len(),
                    mean(&ps),
                    ps.iter().cloned().fold(f64::INFINITY, f64::min),
                    ps.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
                    fos[fos.len() / 2],
                    cases.len(),
                );
            }
        }
        println!();
    }

    // --- Fanout term, fitted per (family, driver->sink) on within-design
    // --- residuals only. See `fanout_slope`.
    println!("== fanout slope (ps per log2(fanout)), within-design residuals ==");
    println!(
        "{:<16} {:>8} {:>8} {:>5} {:>10} {:>7} {:>6}",
        "family", "driver", "sink", "n", "slope_ps", "r", "cases"
    );
    for family in ["series7", "ultrascale", "ultrascale_plus"] {
        let mut groups: BTreeMap<(String, String), Vec<&NetRow>> = BTreeMap::new();
        for r in nets
            .iter()
            .filter(|r| r.family == family && r.state == "unplaced")
        {
            groups
                .entry((
                    format!("{:?}", class_of(&r.driver)),
                    format!("{:?}", class_of(&r.sink)),
                ))
                .or_default()
                .push(r);
        }
        for ((d, s), rows) in &groups {
            let (slope, r, cases) = fanout_slope(rows);
            if cases == 0 {
                continue;
            }
            println!(
                "{family:<16} {d:>8} {s:>8} {:>5} {slope:>10.0} {r:>7.2} {cases:>6}",
                rows.len()
            );
        }
    }
    println!();

    // --- Carry sinks broken out by PIN. The pair alone is not the whole story
    // --- for a carry chain: on Series-7 a LUT->CARRY hop is free into the `S`
    // --- (select) input but pays full general routing into `DI` (the data
    // --- input). Averaging them produces a number that describes neither.
    println!("== net delay into carry chains, by sink pin ==");
    println!(
        "{:<16} {:>8} {:>8} {:>5} {:>8} {:>8} {:>8}",
        "family", "driver", "sink_pin", "n", "mean_ps", "min_ps", "max_ps"
    );
    for family in ["series7", "ultrascale", "ultrascale_plus"] {
        let mut groups: BTreeMap<(String, String), Vec<f64>> = BTreeMap::new();
        for r in nets.iter().filter(|r| {
            r.family == family && r.state == "unplaced" && class_of(&r.sink) == CellClass::Carry
        }) {
            // `DI[1]` and `S[3]` are the same pin for our purposes; the bit
            // index is which bit of the 4-bit slice, not a different route.
            let pin = r
                .sink_pin
                .split('[')
                .next()
                .unwrap_or(&r.sink_pin)
                .to_owned();
            groups
                .entry((format!("{:?}", class_of(&r.driver)), pin))
                .or_default()
                .push(r.incr_ns * 1000.0);
        }
        for ((d, pin), ps) in &groups {
            println!(
                "{family:<16} {d:>8} {pin:>8} {:>5} {:>8.0} {:>8.0} {:>8.0}",
                ps.len(),
                mean(ps),
                ps.iter().cloned().fold(f64::INFINITY, f64::min),
                ps.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
            );
        }
    }
    println!();

    // --- The coefficients themselves, derived from the rows above so the fit is
    // --- reproducible rather than arithmetic done by hand in a commit message.
    //
    // Net terms are reported as an INTERCEPT at fanout 1, not a raw mean: the
    // model is `base + per_fanout * log2(fanout)`, so pasting a mean (taken at
    // the corpus's median fanout) into `net_base_ps` would double-count the
    // fanout term.
    println!("== suggested coefficients (ps) ==");
    println!(
        "{:<16} {:>8} {:>8} {:>9} {:>10} {:>9} {:>9} {:>10} {:>9}",
        "family",
        "lut_ps",
        "carry_ps",
        "ff_clk_q",
        "net_base",
        "net_/fo",
        "net_reg",
        "net_carry",
        "net_port"
    );
    for family in ["series7", "ultrascale", "ultrascale_plus"] {
        let fam_nets: Vec<&NetRow> = nets.iter().filter(|r| r.family == family).collect();
        if fam_nets.is_empty() {
            continue;
        }
        // Cell arcs, by category.
        //
        // NOTE: cell rows are **occurrence-weighted** — unlike net rows they
        // are not de-duplicated, so an arc on many reported paths counts many
        // times. That is deliberate: the model sums a cell delay per cell along
        // a path, so the right coefficient is the mean over arcs *as they occur
        // on critical paths*, not the mean over distinct arc types.
        //
        // The choice is worth ~10-17%: on UltraScale the weighted LUT mean is
        // 151 ps while the distinct-tuple mean is 126. Weighted is the one that
        // reproduces Vivado — its own aggregate `logic` column at identical
        // logic levels has UltraScale *slower* than Series-7 in 8 of 11 cases,
        // which only the weighted statistic (151 vs 152) predicts. It is also
        // why `lut_ps` is not monotonic across families; see the
        // `newer_families_win_on_routing_not_on_logic` test.
        let arc_mean = |pred: &dyn Fn(&str) -> bool| -> f64 {
            let v: Vec<f64> = cells
                .iter()
                .filter(|c| c.family == family && pred(&c.arc.to_ascii_lowercase()))
                .map(|c| c.incr_ns * 1000.0)
                .collect();
            mean(&v)
        };
        let lut = arc_mean(&|a: &str| a.starts_with("lut"));
        let ffq = arc_mean(&|a: &str| a.starts_with("fd") && a.contains("_c_q"));
        let carry = carry_ps_per_yosys_carry4(&cells, family);

        // Net terms: intercept at fanout 1 from the within-design slope.
        let class_rows = |d: CellClass, s: CellClass| -> Vec<&NetRow> {
            fam_nets
                .iter()
                .filter(|r| {
                    r.state == "unplaced" && class_of(&r.driver) == d && class_of(&r.sink) == s
                })
                .copied()
                .collect()
        };
        let general = class_rows(CellClass::Lut, CellClass::Lut);
        let (slope, _, _) = fanout_slope(&general);
        let slope = if slope.is_finite() { slope } else { 0.0 };
        let intercept = |rows: &[&NetRow]| -> f64 {
            let ys: Vec<f64> = rows.iter().map(|r| r.incr_ns * 1000.0).collect();
            let xs: Vec<f64> = rows
                .iter()
                .map(|r| f64::from(r.fanout.max(1)).log2())
                .collect();
            mean(&ys) - slope * mean(&xs)
        };
        let net_base = intercept(&general);
        let net_reg = intercept(&class_rows(CellClass::Lut, CellClass::Reg));
        // Only the DI pin pays; S is free and would halve a pooled mean.
        let di: Vec<f64> = fam_nets
            .iter()
            .filter(|r| {
                r.state == "unplaced"
                    && class_of(&r.sink) == CellClass::Carry
                    && class_of(&r.driver) != CellClass::Carry
                    && !r.sink_pin.starts_with('S')
            })
            .map(|r| r.incr_ns * 1000.0)
            .collect();
        let port: Vec<f64> = fam_nets
            .iter()
            .filter(|r| r.state == "unset" || r.state == "none")
            .map(|r| r.incr_ns * 1000.0)
            .collect();
        println!(
            "{family:<16} {lut:>8.0} {carry:>8.0} {ffq:>9.0} {net_base:>10.0} {slope:>9.0} \
             {net_reg:>9.0} {:>10.0} {:>9.0}",
            mean(&di),
            mean(&port),
        );
    }
    println!();

    // --- Cell delay by timing arc. The arc, not the cell type, is the unit: a
    // --- carry chain ENTRY (carry4_DI_CO) and a PROPAGATE (carry4_CI_CO) are
    // --- different costs from the same primitive.
    println!("== cell delay by timing arc ==");
    println!(
        "{:<16} {:<28} {:>5} {:>8} {:>8} {:>8}",
        "family", "arc", "n", "mean_ps", "min_ps", "max_ps"
    );
    for family in ["series7", "ultrascale", "ultrascale_plus"] {
        let mut groups: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
        for c in cells.iter().filter(|c| c.family == family) {
            groups
                .entry(c.arc.as_str())
                .or_default()
                .push(c.incr_ns * 1000.0);
        }
        for (arc, ps) in &groups {
            println!(
                "{family:<16} {arc:<28} {:>5} {:>8.0} {:>8.0} {:>8.0}",
                ps.len(),
                mean(ps),
                ps.iter().cloned().fold(f64::INFINITY, f64::min),
                ps.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
            );
        }
    }
    Ok(())
}

/// Least-squares scale factor: the `k` minimizing |k·xs − ys|², i.e. the factor
/// that best maps our -1 numbers onto a faster grade's measurements.
fn best_scale(pairs: &[(f64, f64)]) -> Option<f64> {
    let num: f64 = pairs.iter().map(|(x, y)| x * y).sum();
    let den: f64 = pairs.iter().map(|(x, _)| x * x).sum();
    (den > 0.0).then(|| num / den)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRC: &str = "module adder_chain #(\n\
                       \x20   parameter int unsigned WIDTH = 16,\n\
                       \x20   parameter int unsigned NUM_INPUTS = 4,\n\
                       \x20   parameter int unsigned SUM_WIDTH = WIDTH + $clog2(NUM_INPUTS)\n\
                       ) ();\nendmodule\n";

    #[test]
    fn pins_a_parameter_and_keeps_the_separator() {
        let out = pin_param(SRC, "WIDTH", 64).unwrap();
        assert!(out.contains("parameter int unsigned WIDTH = 64,"));
        // The other declarations, including the derived one, are untouched.
        assert!(out.contains("parameter int unsigned NUM_INPUTS = 4,"));
        assert!(out.contains("SUM_WIDTH = WIDTH + $clog2(NUM_INPUTS)"));
    }

    #[test]
    fn pins_the_last_parameter_without_inventing_a_comma() {
        let out = pin_param(SRC, "SUM_WIDTH", 8).unwrap();
        assert!(out.contains("parameter int unsigned SUM_WIDTH = 8\n"));
        assert!(!out.contains("SUM_WIDTH = 8,"));
    }

    #[test]
    fn pinning_is_composable() {
        let out = pin_param(&pin_param(SRC, "WIDTH", 32).unwrap(), "NUM_INPUTS", 2).unwrap();
        assert!(out.contains("WIDTH = 32,"));
        assert!(out.contains("NUM_INPUTS = 2,"));
    }

    #[test]
    fn an_unknown_parameter_is_an_error_not_a_silent_default() {
        // Silently synthesizing the default would calibrate against the wrong
        // design and quietly corrupt the fit — the whole point of erroring.
        let err = pin_param(SRC, "DEPTH", 4).unwrap_err().to_string();
        assert!(err.contains("found 0"), "unexpected error: {err}");
    }

    #[test]
    fn a_name_that_only_prefixes_a_parameter_does_not_match() {
        // `WIDTH` must not match `WIDTH_X`, nor `SUM_WIDTH` match `WIDTH`.
        let src = "    parameter int unsigned WIDTH_X = 3,\n";
        assert!(pin_param(src, "WIDTH", 9).is_err());
    }
}

fn cmd_fit(args: &[String]) -> anyhow::Result<()> {
    let (est_path, viv_path) = match args {
        [a, b] => (a.clone(), b.clone()),
        _ => anyhow::bail!("usage: calibrate fit <est.json> <vivado.json>"),
    };
    let _estimates: Vec<Estimate> = load(&est_path)?;
    let vivado: Vec<VivadoTiming> = load(&viv_path)?;

    // Speed grade is a property of the silicon, not of our model: fit it from
    // Vivado's own -1 vs -N measurements on identical designs. Fitting logic and
    // route separately tests the assumption that one flat multiplier is enough.
    println!(
        "{:<16} {:>6} {:>8} {:>8} {:>8} {:>5}",
        "family", "grade", "total", "logic", "route", "n"
    );
    for family in ["series7", "ultrascale", "ultrascale_plus"] {
        for grade in ["-2", "-3"] {
            let mut total = Vec::new();
            let mut logic = Vec::new();
            let mut route = Vec::new();
            for base in vivado
                .iter()
                .filter(|v| v.family == family && v.speed_grade == "-1")
            {
                let Some(fast) = vivado
                    .iter()
                    .find(|v| v.case == base.case && v.family == family && v.speed_grade == grade)
                else {
                    continue;
                };
                total.push((base.data_path_ns, fast.data_path_ns));
                logic.push((base.logic_ns, fast.logic_ns));
                route.push((base.route_ns, fast.route_ns));
            }
            let Some(t) = best_scale(&total) else {
                continue;
            };
            let l = best_scale(&logic).unwrap_or(f64::NAN);
            let r = best_scale(&route).unwrap_or(f64::NAN);
            println!(
                "{family:<16} {grade:>6} {t:>8.3} {l:>8.3} {r:>8.3} {:>5}",
                total.len()
            );
        }
    }
    Ok(())
}
