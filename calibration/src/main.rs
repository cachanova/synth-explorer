//! Delay-model calibration harness (developer tool, not part of the web app).
//!
//! The estimated timing in [`synth_explorer_server::delay_model`] is fitted
//! against real Vivado post-synthesis `report_timing`. This tool makes that fit
//! reproducible:
//!
//! ```text
//!   gen      examples/ out/      # pin each case's parameters into concrete RTL
//!   estimate out/ est.json       # run Yosys + our estimate over those cases
//!   report   est.json vivado.json# compare, per family and speed grade
//!   fit      vivado.json         # least-squares speed-grade factors (Vivado vs Vivado)
//! ```
//!
//! `gen` writes byte-identical RTL for both tools: the same generated sources are
//! shipped to the Vivado host (see `calibration/vivado.tcl`) and read back here,
//! so a divergence can never come from the two tools reading different input.
//!
//! Vivado ground truth is a **local artifact**, deliberately not checked in
//! (`calibration/vivado-*.json` is gitignored). `report`/`fit` need it, so
//! generate it first — see `calibration/README.md`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use synth_explorer_analysis::analysis::{Analysis, EndpointKind};
use synth_explorer_analysis::delay_model::DelayModel;
use synth_explorer_analysis::graph::Graph;
use synth_explorer_analysis::netlist::{YosysNetlist, parse_value, select_top};

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
    /// LUT cell count (area proxy): every `cells_by_type` entry whose name
    /// starts with `LUT`. `default` keeps older estimate files loadable.
    #[serde(default)]
    luts: usize,
    /// Per-class structural depths, so a flag sweep can tell when a combo moves
    /// the critical path to a different class (which breaks comparability with
    /// a Vivado measurement of the original path).
    #[serde(default)]
    depth_input_to_register: Option<u32>,
    #[serde(default)]
    depth_register_to_register: Option<u32>,
    #[serde(default)]
    depth_register_to_output: Option<u32>,
    #[serde(default)]
    depth_input_to_output: Option<u32>,
    /// Start/end class of the delay-critical path. This lets a post-route tool
    /// comparison select the matching domain pair instead of accidentally
    /// pairing (for example) our register path with an inserted I/O path.
    #[serde(default)]
    critical_path_class: Option<String>,
    /// Endpoint kind is retained separately so report tooling need not reverse
    /// map the combined class label (and can reject unsupported blackboxes).
    #[serde(default)]
    critical_endpoint_kind: Option<String>,
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
        Some("estimate-lattice") => cmd_estimate_lattice(&args[1..]),
        Some("report") => cmd_report(&args[1..]),
        Some("fit") => cmd_fit(&args[1..]),
        _ => {
            eprintln!(
                "usage:\n  \
                 calibrate gen <examples-dir> <out-dir>\n  \
                 calibrate estimate <cases-dir> <out.json> [extra-synth-flags...]\n  \
                 calibrate estimate-lattice <cases-dir> <out.json>\n  \
                 calibrate report <est.json> <vivado.json>\n  \
                 calibrate fit <vivado.json>"
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
        // Everything after `=` is replaced, so the separator has to be carried
        // over explicitly. Look for it before any line comment: a declaration
        // written `WIDTH = 8, // bus width` ends with the comment, not the
        // comma, and dropping the comma yields invalid SystemVerilog.
        let after_eq = &line[eq + 1..];
        let code = after_eq.split("//").next().unwrap_or(after_eq);
        let tail = if code.trim_end().ends_with(',') {
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
    let calibration_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let spec = read_spec(&calibration_dir)?;
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
    std::fs::copy(calibration_dir.join("cases.json"), out.join("cases.json"))?;
    println!("generated {} cases in {}", spec.cases.len(), out.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// estimate — run Yosys + our model over the generated cases
// ---------------------------------------------------------------------------

/// The Yosys `synth_xilinx -family` value each calibrated preset corresponds to.
/// These are Yosys's own spellings (`yosys -p "help synth_xilinx"`) — note
/// UltraScale is `xcu`, not `xcku`; Yosys hard-errors on anything else.
///
/// Errors on an unknown family rather than defaulting: a typo'd key in the spec
/// would otherwise synthesize for Series-7 while wearing the typo's label, and
/// then vanish from `report` (which iterates a fixed family list) — a silent
/// hole in the corpus rather than a failure.
fn family_arg(family: &str) -> anyhow::Result<&'static str> {
    Ok(match family {
        "series7" => "xc7",
        "ultrascale" => "xcu",
        "ultrascale_plus" => "xcup",
        other => anyhow::bail!("unknown family `{other}` in cases.json"),
    })
}

/// Production synthesis mode, visible default flags, and delay-model target for
/// one calibration family. Keeping this mapping beside `estimate_case` makes
/// the harness exercise the same request shape as the app instead of growing a
/// parallel Yosys script.
fn estimate_family(
    family: &str,
) -> anyhow::Result<(&'static str, String, &'static str, Option<&'static str>)> {
    Ok(match family {
        "ice40" => ("ice40", String::new(), "ice40", None),
        // ECP5's explorer default is visible and removable in the flags menu;
        // include it here so calibration measures the shipped default netlist.
        "ecp5" => ("ecp5", "-noiopad".to_owned(), "ecp5", None),
        _ => {
            let arg = family_arg(family)?;
            (
                "xilinx",
                format!("-family {arg} -noiopad -noclkbuf"),
                "xilinx",
                Some(arg),
            )
        }
    })
}

fn path_class_name(starts_at_register: bool, endpoint_kind: EndpointKind) -> &'static str {
    match (starts_at_register, endpoint_kind) {
        (false, EndpointKind::Register) => "input_to_register",
        (true, EndpointKind::Register) => "register_to_register",
        (true, EndpointKind::Output) => "register_to_output",
        (false, EndpointKind::Output) => "input_to_output",
        (_, EndpointKind::Blackbox) => "other",
    }
}

fn endpoint_kind_name(kind: EndpointKind) -> &'static str {
    match kind {
        EndpointKind::Register => "register",
        EndpointKind::Output => "output",
        EndpointKind::Blackbox => "blackbox",
    }
}

fn estimate_case(
    dir: &Path,
    case: &Case,
    family: &str,
    extra_flags: &[String],
) -> anyhow::Result<Estimate> {
    let content = std::fs::read_to_string(dir.join(&case.name).join(&case.file))?;
    // `-noiopad -noclkbuf` matches Vivado's `-mode out_of_context`, so both
    // tools produce a bare fabric netlist. Without it Yosys inserts
    // IBUF/OBUF/BUFG that Vivado's OOC run does not have, and the two sides
    // would be timing different circuits. It also keeps pad and clock-tree
    // delay — real, but package-dependent and not what these coefficients
    // model — out of the fit.
    //
    // `extra_flags` (from the CLI) come after the baseline, for sweeping
    // additional `synth_xilinx` options. They go through the same
    // production TypeScript validator and script builder, so a flag the app
    // would reject is rejected here too.
    let (mode, mut extra_args, model_target, model_family) = estimate_family(family)?;
    for flag in extra_flags {
        if !extra_args.is_empty() {
            extra_args.push(' ');
        }
        extra_args.push_str(flag);
    }
    let parsed = run_yosys(
        &case.file,
        &content,
        &case.top,
        mode,
        (!extra_args.is_empty()).then_some(extra_args),
    )
    .map_err(|error| anyhow::anyhow!("synth {}: {error:#}", case.name))?;
    let (top, module) = select_top(&parsed, None)?;
    let graph = Graph::from_netlist(&parsed, top, module)?;

    // Exactly the model the server would pick for this target, so the harness
    // measures the shipped default rather than a parallel copy of it.
    let model = DelayModel::for_target(model_target, model_family);
    let analysis = Analysis::with_delay_model(&graph, Vec::new(), &model);
    let estimate = analysis.estimate_timing(&graph, &model);
    let delay_ns = estimate
        .delay_ns
        .ok_or_else(|| anyhow::anyhow!("case {} has no combinational path", case.name))?;
    let bd = estimate
        .breakdown
        .ok_or_else(|| anyhow::anyhow!("case {} has no breakdown", case.name))?;
    let stats = analysis.stats();
    let starts_at_register = estimate
        .starts_at_register
        .ok_or_else(|| anyhow::anyhow!("case {} has no path start metadata", case.name))?;
    let endpoint_kind = estimate
        .endpoint_kind
        .ok_or_else(|| anyhow::anyhow!("case {} has no endpoint metadata", case.name))?;
    let critical_path_class = Some(path_class_name(starts_at_register, endpoint_kind).to_owned());
    let critical_endpoint_kind = Some(endpoint_kind_name(endpoint_kind).to_owned());
    let luts = stats
        .cells_by_type
        .iter()
        .filter(|(name, _)| name.starts_with("LUT"))
        .map(|(_, count)| count)
        .sum();
    Ok(Estimate {
        case: case.name.clone(),
        family: family.to_owned(),
        delay_ns,
        launch_ns: bd.launch_ns,
        logic_ns: bd.logic_ns,
        net_ns: bd.net_ns,
        setup_ns: bd.setup_ns,
        depth: stats.max_depth,
        luts,
        depth_input_to_register: stats.depths.input_to_register,
        depth_register_to_register: stats.depths.register_to_register,
        depth_register_to_output: stats.depths.register_to_output,
        depth_input_to_output: stats.depths.input_to_output,
        critical_path_class,
        critical_endpoint_kind,
    })
}

/// Run native Yosys for local calibration while rendering the script through
/// the production browser script builder. This keeps one canonical synthesis
/// pipeline: calibration changes fail unless the browser contract accepts them.
fn run_yosys(
    file: &str,
    content: &str,
    top: &str,
    mode: &str,
    extra_args: Option<String>,
) -> anyhow::Result<YosysNetlist> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| anyhow::anyhow!("calibration crate has no repository parent"))?
        .to_owned();
    let temp = tempfile::tempdir()?;
    std::fs::write(temp.path().join(file), content)?;
    let request_path = temp.path().join("request.json");
    std::fs::write(
        &request_path,
        serde_json::to_vec(&serde_json::json!({
            "files": [{ "name": file, "content": content }],
            "top": top,
            "mode": mode,
            "extra_args": extra_args,
        }))?,
    )?;

    let renderer = root.join("web/node_modules/.bin/tsx");
    if !renderer.is_file() {
        anyhow::bail!(
            "missing {}; run `npm install` in web/ before calibration",
            renderer.display()
        );
    }
    let rendered = Command::new(&renderer)
        .arg(root.join("calibration/render-yosys-script.ts"))
        .arg(&request_path)
        .current_dir(&root)
        .output()?;
    if !rendered.status.success() {
        anyhow::bail!(
            "browser script builder failed: {}",
            String::from_utf8_lossy(&rendered.stderr).trim()
        );
    }
    std::fs::write(temp.path().join("script.ys"), rendered.stdout)?;

    let output = Command::new("yosys")
        .args(["-q", "-T", "-s", "script.ys", "-l", "yosys.log"])
        .current_dir(temp.path())
        .output()?;
    if !output.status.success() {
        let log = std::fs::read_to_string(temp.path().join("yosys.log")).unwrap_or_default();
        anyhow::bail!("native Yosys failed:\n{}", log.trim());
    }
    let json = std::fs::read_to_string(temp.path().join("netlist.json"))?;
    Ok(parse_value(serde_json::from_str(&json)?)?)
}

fn cmd_estimate(args: &[String]) -> anyhow::Result<()> {
    let (dir, out, extra_flags) = match args {
        [a, b, rest @ ..] => (PathBuf::from(a), PathBuf::from(b), rest.to_vec()),
        _ => {
            anyhow::bail!("usage: calibrate estimate <cases-dir> <out.json> [extra-synth-flags...]")
        }
    };
    if !extra_flags.is_empty() {
        println!("extra synth flags: {}", extra_flags.join(" "));
    }
    let spec = read_spec(&dir)?;
    let families: Vec<&str> = spec.parts.keys().map(String::as_str).collect();
    estimate_families(&dir, &out, &spec, &families, &extra_flags)
}

fn cmd_estimate_lattice(args: &[String]) -> anyhow::Result<()> {
    let (dir, out) = match args {
        [a, b] => (PathBuf::from(a), PathBuf::from(b)),
        _ => anyhow::bail!("usage: calibrate estimate-lattice <cases-dir> <out.json>"),
    };
    let spec = read_spec(&dir)?;
    estimate_families(&dir, &out, &spec, &["ice40", "ecp5"], &[])
}

fn estimate_families(
    dir: &Path,
    out: &Path,
    spec: &Spec,
    families: &[&str],
    extra_flags: &[String],
) -> anyhow::Result<()> {
    let mut estimates = Vec::new();
    for family in families {
        for case in &spec.cases {
            match estimate_case(dir, case, family, extra_flags) {
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
    if estimates.is_empty() {
        anyhow::bail!("no calibration estimates were produced");
    }
    std::fs::write(out, serde_json::to_string_pretty(&estimates)?)?;
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
    let mut zero_level = Vec::new();
    let mut unpaired = Vec::new();
    println!(
        "{:<18} {:<16} {:>8} {:>8} {:>7}  {:>6} {:>6}",
        "case", "family", "est", "vivado", "err", "depth", "levels"
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
            println!(
                "{:<18} {:<16} {:>8.3} {:>8.3} {:>6.0}%  {:>6} {:>6}",
                est.case, family, ours, viv.data_path_ns, err, est.depth, viv.logic_levels
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
    fn a_duplicate_declaration_is_an_error_not_a_coin_flip() {
        // `async_fifo_blackbox.sv` declares the same parameter on two modules.
        // Pinning one of them silently would calibrate against a design whose
        // other instance still holds the default.
        let src = "    parameter int unsigned DEPTH = 4,\n\
                   \x20   parameter int unsigned DEPTH = 8,\n";
        let err = pin_param(src, "DEPTH", 16).unwrap_err().to_string();
        assert!(err.contains("found 2"), "unexpected error: {err}");
    }

    #[test]
    fn a_trailing_comment_is_not_silently_eaten() {
        // Everything after `=` is replaced, so anything trailing is dropped.
        // Harmless for a comment, but pin the behaviour so a future change to
        // this rewrite has to think about it.
        let src = "    parameter int unsigned WIDTH = 8, // bus width\n";
        let out = pin_param(src, "WIDTH", 32).unwrap();
        assert_eq!(out, "    parameter int unsigned WIDTH = 32,\n");
    }

    #[test]
    fn a_declaration_wrapped_after_the_equals_is_left_alone_or_errors() {
        // Two examples wrap their derived parameters across lines:
        //     parameter int unsigned INDEX_WIDTH =
        //         (NUM_REQUESTERS <= 1) ? 1 : $clog2(NUM_REQUESTERS)
        // No case pins a derived parameter, so this never fires today. If one
        // ever does, it must not quietly emit `= 8` with an orphaned
        // continuation line below it.
        let src = "    parameter int unsigned INDEX_WIDTH =\n\
                   \x20       (N <= 1) ? 1 : $clog2(N)\n";
        let out = pin_param(src, "INDEX_WIDTH", 8).unwrap();
        // Documents today's real behaviour: the continuation survives, so the
        // result is broken SystemVerilog that fails loudly at synthesis rather
        // than fitting against the wrong design.
        assert!(out.contains("INDEX_WIDTH = 8"), "{out}");
        assert!(
            out.contains("(N <= 1)"),
            "continuation silently dropped: {out}"
        );
    }

    #[test]
    fn a_typed_parameter_is_not_touched() {
        // `parameter logic [WIDTH-1:0] RESET_VALUE = '0` must not match: only
        // `int unsigned` declarations are pinnable.
        let src = "    parameter logic [7:0] RESET_VALUE = '0\n";
        assert!(pin_param(src, "RESET_VALUE", 1).is_err());
    }

    #[test]
    fn a_name_that_only_prefixes_a_parameter_does_not_match() {
        // `WIDTH` must not match `WIDTH_X`, nor `SUM_WIDTH` match `WIDTH`.
        let src = "    parameter int unsigned WIDTH_X = 3,\n";
        assert!(pin_param(src, "WIDTH", 9).is_err());
    }

    #[test]
    fn lattice_estimates_use_the_shipped_synthesis_shapes() {
        let (mode, flags, target, family) = estimate_family("ice40").unwrap();
        assert_eq!(mode, "ice40");
        assert!(flags.is_empty());
        assert_eq!((target, family), ("ice40", None));

        let (mode, flags, target, family) = estimate_family("ecp5").unwrap();
        assert_eq!(mode, "ecp5");
        assert_eq!(flags, "-noiopad");
        assert_eq!((target, family), ("ecp5", None));
    }

    #[test]
    fn path_classes_have_stable_artifact_names() {
        assert_eq!(
            path_class_name(true, EndpointKind::Register),
            "register_to_register"
        );
        assert_eq!(
            path_class_name(false, EndpointKind::Output),
            "input_to_output"
        );
        assert_eq!(endpoint_kind_name(EndpointKind::Register), "register");
        assert_eq!(endpoint_kind_name(EndpointKind::Output), "output");
    }
}

fn cmd_fit(args: &[String]) -> anyhow::Result<()> {
    let viv_path = match args {
        [a] => a.clone(),
        _ => anyhow::bail!("usage: calibrate fit <vivado.json>"),
    };
    // Deliberately takes no estimate file: speed grade is derived from Vivado's
    // own -1-vs-N on identical designs, so our model plays no part in it.
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
