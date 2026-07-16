use crate::netlist::{NetlistError, parse_value, select_top};
use crate::yosys::{
    MemoryHandling, SynthMode, SynthTool, SynthesisOutput, ValidatedSynth, YosysError, run_yosys,
    valid_vivado_part_name,
};
use deepsize::DeepSizeOf;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt::Write as _;
#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tempfile::TempDir;
use thiserror::Error;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::process::Command;
use tokio::time::timeout;

const LOG_TAIL_LIMIT: usize = 64 * 1024;
const JSON_SIZE_LIMIT: u64 = 64 * 1024 * 1024;
/// The worst-path block sits at the head of a `report_timing` report, so a
/// bounded prefix read is enough and keeps a pathological report off the heap.
const TIMING_REPORT_LIMIT: u64 = 256 * 1024;
/// Period of the analysis-only reference clock applied *after* `synth_design`.
/// It cannot change the netlist and does not affect `data_path_delay_ns`; it
/// only sets what `slack_ns` is measured against. See `docs/API.md`.
const REFERENCE_PERIOD_NS: f64 = 10.0;
const TIMING_REPORT_NAME: &str = "timing.rpt";
/// Marker the Tcl writes once `write_verilog` has returned. Its presence is
/// what distinguishes "synthesis finished, the optional timing step ran out of
/// wall clock" from "synthesis itself timed out".
const NETLIST_MARKER_NAME: &str = "netlist-complete.marker";
const VIVADO_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const NORMALIZE_TIMEOUT: Duration = Duration::from_secs(60);
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(30);
const PART_MARKER: &str = "SYNTH_EXPLORER_PART\t";
#[cfg(target_os = "linux")]
const CHILD_ADDRESS_SPACE_LIMIT: libc::rlim_t = 16 * 1024 * 1024 * 1024;
#[cfg(target_os = "linux")]
const CHILD_FILE_SIZE_LIMIT: libc::rlim_t = 256 * 1024 * 1024;
#[cfg(target_os = "linux")]
const CHILD_OPEN_FILES_LIMIT: libc::rlim_t = 256;
#[cfg(target_os = "linux")]
// RLIMIT_CPU is cumulative across Vivado's worker threads. Allow eight busy
// threads for the five-minute wall window while retaining a hard process cap.
const CHILD_CPU_SECONDS_LIMIT: libc::rlim_t = 40 * 60;

#[derive(Debug, Error)]
pub enum VivadoError {
    #[error("source prepass failed: {0}")]
    Source(#[source] YosysError),
    #[error("vivado timed out")]
    Timeout { log: String },
    #[error("vivado failed")]
    Vivado { log: String },
    #[error("vivado netlist normalization timed out")]
    NormalizeTimeout { log: String },
    #[error("vivado netlist normalization failed")]
    Normalize { log: String },
    #[error("failed to run vivado synthesis: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid normalized netlist json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid normalized netlist: {0}")]
    Netlist(#[from] NetlistError),
}

#[derive(Debug, Clone)]
pub struct VivadoBackend {
    pub version: String,
    pub parts: Vec<VivadoPart>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VivadoPart {
    pub name: String,
    pub family: String,
    pub speed: String,
}

/// Vivado's own `report_timing` figures for the worst register-to-register
/// path, measured by Vivado's timing engine on the netlist it synthesized —
/// as opposed to the Tier-0 estimate this project computes from the graph.
///
/// This is still a *post-synthesis* report: routing is estimated, not placed,
/// so it is not timing closure either. It is Vivado's own estimate, which
/// makes it the reference our delay model is calibrated against.
// DeepSizeOf: this rides `SynthesizeResponse` inside a cached `Design`, whose
// weight is `deep_size_of()`. The derive accounts for the two owned strings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, DeepSizeOf)]
pub struct VivadoTiming {
    /// Vivado's `Data Path Delay`: clock-to-Q + logic + route. Setup is *not*
    /// included — it is folded into `slack_ns` — so this must not be compared
    /// against a Tier-0 estimate without first removing that estimate's setup
    /// term.
    pub data_path_delay_ns: f64,
    /// The logic (cell) share of `data_path_delay_ns`.
    pub logic_ns: f64,
    /// The route (net) share of `data_path_delay_ns`.
    pub route_ns: f64,
    /// Cell count along the path, as Vivado counts `Logic Levels`.
    pub logic_levels: u32,
    /// Setup slack against `reference_period_ns`, not against any user target.
    pub slack_ns: f64,
    /// False when Vivado reported the path as VIOLATED.
    pub slack_met: bool,
    /// Period of the synthetic reference clock `slack_ns` is measured against.
    pub reference_period_ns: f64,
    /// Launching pin, e.g. `ra_reg[1]/C`.
    pub source: String,
    /// Capturing pin, e.g. `q_reg[13]/D`.
    pub destination: String,
}

/// Parse the worst-path block of a Vivado `report_timing` report.
///
/// Returns `None` when the report has no *constrained* path: either Vivado
/// found no register-to-register path at all ("No timing paths found."), or
/// every such path is unconstrained and reported as `Slack: inf` (which
/// happens when the registers run on a clock we did not constrain, e.g. an
/// internally generated/divided clock). An unconstrained path's delay is real
/// but has no defined launch edge, so we decline to report it rather than
/// present it as comparable to the estimate.
fn parse_report_timing(report: &str) -> Option<VivadoTiming> {
    let (slack_ns, slack_met) = parse_slack(field(report, "Slack")?)?;
    let (data_path_delay_ns, logic_ns, route_ns) =
        parse_data_path_delay(field(report, "Data Path Delay:")?)?;
    let logic_levels = field(report, "Logic Levels:")?
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    Some(VivadoTiming {
        data_path_delay_ns,
        logic_ns,
        route_ns,
        logic_levels,
        slack_ns,
        slack_met,
        reference_period_ns: REFERENCE_PERIOD_NS,
        source: field(report, "Source:")?.to_owned(),
        destination: field(report, "Destination:")?.to_owned(),
    })
}

/// First line whose trimmed text starts with `name`, returning the remainder.
/// `report_timing` indents these as `  Data Path Delay:        2.616ns  (...)`.
/// Longer labels that merely share a prefix (`Destination Clock Delay (DCD):`
/// vs `Destination:`) do not collide because `name` carries its own colon.
fn field<'a>(report: &'a str, name: &str) -> Option<&'a str> {
    report
        .lines()
        .find_map(|line| line.trim().strip_prefix(name))
        .map(str::trim)
}

/// `(MET) :             7.280ns  (required time - arrival time)` -> (7.28, true)
/// `(VIOLATED) :        -1.720ns (...)`                          -> (-1.72, false)
/// `:                   inf`                                     -> None
fn parse_slack(rest: &str) -> Option<(f64, bool)> {
    let (label, value) = rest.split_once(':')?;
    let met = match label.trim() {
        "(MET)" => true,
        "(VIOLATED)" => false,
        // A bare `Slack:` marks an unconstrained path, whose value is `inf`.
        _ => return None,
    };
    Some((parse_ns(value.split_whitespace().next()?)?, met))
}

/// `2.616ns  (logic 1.855ns (70.910%)  route 0.761ns (29.090%))`
fn parse_data_path_delay(rest: &str) -> Option<(f64, f64, f64)> {
    let total = parse_ns(rest.split_whitespace().next()?)?;
    Some((
        total,
        labeled_ns(rest, "logic")?,
        labeled_ns(rest, "route")?,
    ))
}

fn labeled_ns(text: &str, label: &str) -> Option<f64> {
    let rest = text.split_once(&format!("{label} "))?.1;
    parse_ns(rest.split_whitespace().next()?)
}

fn parse_ns(token: &str) -> Option<f64> {
    let value: f64 = token.strip_suffix("ns")?.parse().ok()?;
    value.is_finite().then_some(value)
}

/// Read and parse the optional timing report. Tier 2 is additive: a missing,
/// oversized, or unparseable report degrades to `None` and must never fail a
/// synthesis that otherwise succeeded.
async fn read_timing_report(path: &Path) -> Option<VivadoTiming> {
    let file = fs::File::open(path).await.ok()?;
    let mut bytes = Vec::new();
    file.take(TIMING_REPORT_LIMIT)
        .read_to_end(&mut bytes)
        .await
        .ok()?;
    parse_report_timing(&String::from_utf8_lossy(&bytes))
}

/// Return the configured Vivado version and installed part catalog, or `None`
/// when this deployment has no Vivado backend. Merely having the UI does not
/// advertise an unavailable tool.
pub async fn preflight_vivado() -> Result<Option<VivadoBackend>, VivadoError> {
    let Some(vivado_bin) = std::env::var_os("VIVADO_BIN") else {
        return Ok(None);
    };
    let mut command = Command::new(&vivado_bin);
    command.arg("-version").kill_on_drop(true);
    let output = timeout(PREFLIGHT_TIMEOUT, command.output())
        .await
        .map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "vivado version check timed out",
            )
        })??;
    if !output.status.success() {
        return Err(VivadoError::Vivado {
            log: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = parse_version_banner(&stdout).unwrap_or_default().to_owned();
    if version.is_empty() {
        return Err(VivadoError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "vivado returned an empty version",
        )));
    }
    let temp = TempDir::new()?;
    let catalog_script = temp.path().join("catalog.tcl");
    fs::write(
        &catalog_script,
        "foreach part [lsort [get_parts]] {\n\
         \tputs \"SYNTH_EXPLORER_PART\\t$part\\t[get_property FAMILY $part]\\t[get_property SPEED $part]\"\n\
         }\n",
    )
    .await?;
    let mut command = Command::new(vivado_bin);
    command
        .arg("-mode")
        .arg("batch")
        .arg("-nojournal")
        .arg("-nolog")
        .arg("-notrace")
        .arg("-source")
        .arg(&catalog_script)
        .current_dir(temp.path())
        .kill_on_drop(true);
    let output = timeout(PREFLIGHT_TIMEOUT, command.output())
        .await
        .map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "vivado part catalog check timed out",
            )
        })??;
    if !output.status.success() {
        return Err(VivadoError::Vivado {
            log: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    let parts = parse_part_catalog(&String::from_utf8_lossy(&output.stdout))?;
    Ok(Some(VivadoBackend { version, parts }))
}

fn parse_version_banner(output: &str) -> Option<&str> {
    output.lines().find_map(|line| {
        let line = line.trim();
        line.get(..7)
            .filter(|prefix| prefix.eq_ignore_ascii_case("vivado "))
            .map(|_| line)
    })
}

fn parse_part_catalog(output: &str) -> Result<Vec<VivadoPart>, VivadoError> {
    let mut parts = output
        .lines()
        .filter_map(|line| line.trim().strip_prefix(PART_MARKER))
        .map(|line| {
            let mut fields = line.split('\t');
            let (Some(name), Some(family), Some(speed), None) =
                (fields.next(), fields.next(), fields.next(), fields.next())
            else {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "vivado returned a malformed part catalog entry",
                ));
            };
            if !valid_vivado_part_name(name)
                || family.is_empty()
                || family.len() > 128
                || speed.is_empty()
                || speed.len() > 32
                || !valid_vivado_part_name(speed)
            {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "vivado returned an invalid part catalog entry",
                ));
            }
            Ok(VivadoPart {
                name: name.to_owned(),
                family: family.to_owned(),
                speed: speed.to_owned(),
            })
        })
        .collect::<Result<Vec<_>, std::io::Error>>()?;
    parts.sort_by(|a, b| (&a.family, &a.name).cmp(&(&b.family, &b.name)));
    parts.dedup_by(|a, b| a.name == b.name);
    if parts.is_empty() {
        return Err(VivadoError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "vivado returned an empty part catalog",
        )));
    }
    Ok(parts)
}

/// Run Vivado synthesis, then normalize its structural Verilog into the Yosys
/// JSON contract consumed by the rest of Synth Explorer.
pub async fn run_vivado(input: &ValidatedSynth) -> Result<SynthesisOutput, VivadoError> {
    // Preserve the existing source-provenance representation. Vivado's emitted
    // names are best-effort aliases, while this source-only Yosys pass retains
    // the user's original spans and procedural targets.
    let mut source_input = input.clone();
    source_input.tool = SynthTool::Yosys;
    source_input.mode = SynthMode::Rtl;
    source_input.target = None;
    source_input.extra_args.clear();
    let source = run_yosys(&source_input, MemoryHandling::Map)
        .await
        .map_err(VivadoError::Source)?;

    let temp = TempDir::new()?;
    for file in &input.files {
        fs::write(temp.path().join(&file.name), &file.content).await?;
    }

    let tcl_path = temp.path().join("synthesize.tcl");
    let vivado_netlist_path = temp.path().join("vivado-netlist.v");
    fs::write(
        &tcl_path,
        build_tcl(input, &source.resolved_top, "vivado-netlist.v"),
    )
    .await?;

    let vivado_console_path = temp.path().join("vivado-console.log");
    let vivado_log_path = temp.path().join("vivado.log");
    let vivado_bin = std::env::var_os("VIVADO_BIN").unwrap_or_else(|| "vivado".into());
    let mut vivado = Command::new(vivado_bin);
    vivado
        .arg("-mode")
        .arg("batch")
        .arg("-nojournal")
        .arg("-notrace")
        .arg("-log")
        .arg(&vivado_log_path)
        .arg("-source")
        .arg(&tcl_path)
        .current_dir(temp.path())
        .kill_on_drop(true);
    let status = run_command(&mut vivado, VIVADO_TIMEOUT, &vivado_console_path).await;
    let vivado_log = combined_log(&[&vivado_log_path, &vivado_console_path]).await;
    // Written by the Tcl once `write_verilog` returned, so it proves the
    // netlist on disk is complete rather than a partial flush.
    let netlist_complete = fs::metadata(temp.path().join(NETLIST_MARKER_NAME))
        .await
        .is_ok();
    match status {
        Ok(status) if status.success() => {}
        Ok(_) => return Err(VivadoError::Vivado { log: vivado_log }),
        // The timing step is best-effort and runs only after the netlist is
        // written, so it adds wall time to a budget sized for synthesis alone.
        // A timeout inside it must not discard a synthesis that already
        // finished: keep the netlist and drop the timing report instead.
        Err(CommandFailure::Timeout) if netlist_complete => {}
        Err(CommandFailure::Timeout) => return Err(VivadoError::Timeout { log: vivado_log }),
        Err(CommandFailure::Io(err)) => return Err(VivadoError::Io(err)),
    }
    if fs::metadata(&vivado_netlist_path).await.is_err() {
        return Err(VivadoError::Vivado { log: vivado_log });
    }
    // Best-effort Tier 2: absent for a design with no constrained
    // register-to-register path, and never a reason to fail the synthesis.
    let vivado_timing = read_timing_report(&temp.path().join(TIMING_REPORT_NAME)).await;
    strip_vivado_preamble(&vivado_netlist_path).await?;

    let normalize_script_path = temp.path().join("normalize.ys");
    let normalize_log_path = temp.path().join("normalize.log");
    let json_path = temp.path().join("netlist.json");
    fs::write(
        &normalize_script_path,
        build_normalize_script(&source.resolved_top),
    )
    .await?;
    let mut yosys = Command::new("yosys");
    yosys
        .arg("-q")
        .arg("-T")
        .arg("-s")
        .arg(&normalize_script_path)
        .current_dir(temp.path())
        .kill_on_drop(true);
    let status = run_command(&mut yosys, NORMALIZE_TIMEOUT, &normalize_log_path).await;
    let normalize_log = read_log_tail(&normalize_log_path).await.unwrap_or_default();
    let log = join_logs(&vivado_log, &normalize_log);
    match status {
        Ok(status) if status.success() => {}
        Ok(_) => return Err(VivadoError::Normalize { log }),
        Err(CommandFailure::Timeout) => return Err(VivadoError::NormalizeTimeout { log }),
        Err(CommandFailure::Io(err)) => return Err(VivadoError::Io(err)),
    }

    let json = read_json_limited(&json_path).await?;
    let parsed = parse_value(json.clone())?;
    let (top, _) = select_top(&parsed, Some(&source.resolved_top))?;
    Ok(SynthesisOutput {
        json,
        source_json: source.source_json,
        log,
        resolved_top: top.to_owned(),
        vivado_timing,
    })
}

async fn strip_vivado_preamble(path: &Path) -> Result<(), VivadoError> {
    let metadata = fs::metadata(path).await?;
    if metadata.len() > JSON_SIZE_LIMIT {
        return Err(VivadoError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("vivado netlist exceeded {JSON_SIZE_LIMIT} bytes"),
        )));
    }
    let bytes = fs::read(path).await?;
    let offset = line_start_offset(&bytes, b"`timescale").ok_or_else(|| {
        VivadoError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "vivado netlist did not contain a `timescale directive",
        ))
    })?;
    let body = &bytes[offset..];
    let end = line_start_offset(body, b"`ifndef GLBL").unwrap_or(body.len());
    if offset > 0 || end < body.len() {
        fs::write(path, &body[..end]).await?;
    }
    Ok(())
}

fn line_start_offset(bytes: &[u8], marker: &[u8]) -> Option<usize> {
    if bytes.starts_with(marker) {
        return Some(0);
    }
    bytes
        .windows(marker.len() + 1)
        .position(|window| window[0] == b'\n' && &window[1..] == marker)
        .map(|offset| offset + 1)
}

fn build_tcl(input: &ValidatedSynth, top: &str, output: &str) -> String {
    let mut script = String::new();
    for file in &input.files {
        writeln!(&mut script, "read_verilog -sv {{{}}}", file.name).unwrap();
    }
    let target = input
        .target
        .as_deref()
        .expect("validated Vivado requests always have a target");
    write!(
        &mut script,
        "synth_design -top {{{top}}} -part {{{target}}} -flatten_hierarchy full"
    )
    .unwrap();
    if !input.extra_args.is_empty() {
        write!(&mut script, " {}", input.extra_args.join(" ")).unwrap();
    }
    script.push('\n');
    writeln!(
        &mut script,
        "write_verilog -force -mode funcsim {{{output}}}"
    )
    .unwrap();
    // Ordered between the netlist and the timing step on purpose: everything
    // above this line is Tier 1, everything below is best-effort Tier 2.
    writeln!(&mut script, "close [open {{{NETLIST_MARKER_NAME}}} w]").unwrap();
    script.push_str(&build_timing_tcl());
    script
}

/// Vivado's own `report_timing` on the netlist `synth_design` just produced.
///
/// Everything here runs *after* `write_verilog`, so it cannot influence the
/// netlist the rest of Synth Explorer analyses: `create_clock` is an
/// analysis-only constraint and the emitted design is already on disk. That
/// ordering is what lets Tier 2 be a pure observation of Tier 1.
///
/// The report is restricted to register-to-register paths. Vivado sorts by
/// slack, and I/O paths are unconstrained here (no `set_input_delay` /
/// `set_output_delay`), so without `-from/-to` a design's worst *slack* path
/// can be an unconstrained I/O path dominated by IBUF/OBUF pad delay — which
/// the Tier-0 model deliberately treats as zero-depth infrastructure and would
/// never account for. Register-to-register is the class both tiers agree on.
///
/// The whole block is wrapped in `catch` because Tier 2 is additive: any Tcl
/// error here leaves the report absent and Tier 1 synthesis untouched.
/// No caller-supplied text is interpolated — the period is a Rust constant and
/// clock names are positional.
///
/// `catch` covers Tcl errors but not wall clock, and this step is not free:
/// measured at ~7s on a 2001-register design (~6s of it Vivado building its
/// timing graph on first `all_registers`, ~1s the report itself), against 36s
/// of synthesis. It therefore eats into `VIVADO_TIMEOUT`, which was sized when
/// a run ended at `write_verilog`. `NETLIST_MARKER_NAME` is what keeps that
/// from turning a previously-passing synthesis into a timeout.
fn build_timing_tcl() -> String {
    format!(
        "if {{[catch {{\n\
         \tset se_regs [all_registers]\n\
         \tif {{[llength $se_regs] > 0}} {{\n\
         \t\tset se_clk_ports [filter [all_fanin -flat -startpoints_only \
         [all_registers -clock_pins]] {{CLASS == port}}]\n\
         \t\tset se_i 0\n\
         \t\tforeach se_port $se_clk_ports {{\n\
         \t\t\tcreate_clock -name se_ref_clk_$se_i -period {REFERENCE_PERIOD_NS:.3} $se_port\n\
         \t\t\tincr se_i\n\
         \t\t}}\n\
         \t\treport_timing -delay_type max -from $se_regs -to $se_regs -file {{{TIMING_REPORT_NAME}}}\n\
         \t}}\n\
         }} se_err]}} {{\n\
         \tputs \"SYNTH_EXPLORER_TIMING_ERROR: $se_err\"\n\
         }}\n"
    )
}

fn build_normalize_script(top: &str) -> String {
    format!(
        "read_verilog -lib +/xilinx/cells_sim.v\n\
         read_verilog -lib +/xilinx/cells_xtra.v\n\
         read_verilog vivado-netlist.v\n\
         hierarchy -check -top {top}\n\
         flatten\n\
         select -clear\n\
         select {top}\n\
         write_json -selected netlist.json\n"
    )
}

enum CommandFailure {
    Timeout,
    Io(std::io::Error),
}

async fn run_command(
    command: &mut Command,
    duration: Duration,
    console_path: &Path,
) -> Result<std::process::ExitStatus, CommandFailure> {
    let console = std::fs::File::create(console_path).map_err(CommandFailure::Io)?;
    command
        .stdout(Stdio::from(
            console.try_clone().map_err(CommandFailure::Io)?,
        ))
        .stderr(Stdio::from(console));
    configure_child(command);
    let mut child = command.spawn().map_err(CommandFailure::Io)?;
    let mut process_group = ProcessGroupGuard::new(&child);
    match timeout(duration, child.wait()).await {
        Ok(result) => {
            let status = result.map_err(CommandFailure::Io)?;
            process_group.disarm();
            Ok(status)
        }
        Err(_) => {
            process_group.kill();
            #[cfg(not(target_os = "linux"))]
            let _ = child.kill().await;
            let _ = child.wait().await;
            process_group.disarm();
            Err(CommandFailure::Timeout)
        }
    }
}

#[cfg(target_os = "linux")]
fn configure_child(command: &mut Command) {
    command.as_std_mut().process_group(0);
    // SAFETY: only async-signal-safe setrlimit calls run between fork and exec.
    unsafe {
        command.as_std_mut().pre_exec(apply_child_limits);
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_child(_command: &mut Command) {}

#[cfg(target_os = "linux")]
fn apply_child_limits() -> std::io::Result<()> {
    set_limit(libc::RLIMIT_AS, CHILD_ADDRESS_SPACE_LIMIT)?;
    set_limit(libc::RLIMIT_CPU, CHILD_CPU_SECONDS_LIMIT)?;
    set_limit(libc::RLIMIT_FSIZE, CHILD_FILE_SIZE_LIMIT)?;
    set_limit(libc::RLIMIT_NOFILE, CHILD_OPEN_FILES_LIMIT)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_limit(resource: libc::__rlimit_resource_t, value: libc::rlim_t) -> std::io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: value,
        rlim_max: value,
    };
    // SAFETY: `limit` lives through this call and `resource` is a valid RLIMIT.
    if unsafe { libc::setrlimit(resource, &limit) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

struct ProcessGroupGuard {
    #[cfg(target_os = "linux")]
    pgid: Option<i32>,
}

impl ProcessGroupGuard {
    fn new(child: &tokio::process::Child) -> Self {
        Self {
            #[cfg(target_os = "linux")]
            pgid: child.id().and_then(|id| i32::try_from(id).ok()),
        }
    }

    fn kill(&self) {
        #[cfg(target_os = "linux")]
        if let Some(pgid) = self.pgid {
            // SAFETY: the negative PID targets the isolated child process group.
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }

    fn disarm(&mut self) {
        #[cfg(target_os = "linux")]
        {
            self.pgid = None;
        }
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

async fn read_json_limited(path: &Path) -> Result<Value, VivadoError> {
    let metadata = fs::metadata(path).await?;
    if metadata.len() > JSON_SIZE_LIMIT {
        return Err(VivadoError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("normalized netlist exceeded {JSON_SIZE_LIMIT} bytes"),
        )));
    }
    let bytes = fs::read(path).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn read_log_tail(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path).await?;
    let len = file.metadata().await?.len();
    let start = len.saturating_sub(LOG_TAIL_LIMIT as u64);
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn combined_log(paths: &[&Path]) -> String {
    let mut log = String::new();
    for path in paths {
        if let Ok(tail) = read_log_tail(path).await {
            log = join_logs(&log, &tail);
        }
    }
    if log.len() > LOG_TAIL_LIMIT {
        log.split_off(log.len() - LOG_TAIL_LIMIT)
    } else {
        log
    }
}

fn join_logs(first: &str, second: &str) -> String {
    match (first.is_empty(), second.is_empty()) {
        (true, _) => second.to_owned(),
        (_, true) => first.to_owned(),
        _ => format!("{first}\n{second}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::yosys::SourceFile;

    fn input() -> ValidatedSynth {
        ValidatedSynth {
            files: vec![
                SourceFile {
                    name: "a.sv".to_owned(),
                    content: String::new(),
                },
                SourceFile {
                    name: "top.sv".to_owned(),
                    content: String::new(),
                },
            ],
            top: Some("top".to_owned()),
            tool: SynthTool::Vivado,
            mode: SynthMode::Gates,
            target: Some(crate::yosys::DEFAULT_VIVADO_PART.to_owned()),
            extra_args: Vec::new(),
        }
    }

    #[test]
    fn tcl_uses_fixed_basic_part_and_validated_sources() {
        let script = build_tcl(&input(), "top", "vivado-netlist.v");
        // The synthesis half is exact; the appended timing-report half is
        // asserted separately by the tests below.
        assert!(script.starts_with(
            "read_verilog -sv {a.sv}\n\
             read_verilog -sv {top.sv}\n\
             synth_design -top {top} -part {xc7a35tcpg236-1} -flatten_hierarchy full\n\
             write_verilog -force -mode funcsim {vivado-netlist.v}\n"
        ));
    }

    #[test]
    fn tcl_appends_validated_vivado_flags() {
        let mut input = input();
        input.extra_args = vec!["-retiming".to_owned(), "-no_lc".to_owned()];
        assert!(build_tcl(&input, "top", "vivado-netlist.v").contains(
            "synth_design -top {top} -part {xc7a35tcpg236-1} -flatten_hierarchy full -retiming -no_lc\n"
        ));
    }

    #[test]
    fn normalizer_loads_xilinx_directions_and_selects_only_top() {
        let script = build_normalize_script("top");
        assert!(script.contains("read_verilog -lib +/xilinx/cells_sim.v"));
        assert!(script.contains("read_verilog -lib +/xilinx/cells_xtra.v"));
        assert!(script.contains("hierarchy -check -top top"));
        assert!(script.contains("write_json -selected netlist.json"));
    }

    #[test]
    fn version_parser_accepts_the_real_2026_banner() {
        let output = "vivado v2026.1 (64-bit)\nTool Version Limit: 2026.06\n";
        assert_eq!(
            parse_version_banner(output),
            Some("vivado v2026.1 (64-bit)")
        );
    }

    #[test]
    fn part_catalog_parser_sorts_and_deduplicates_installed_parts() {
        let output = "noise\n\
            SYNTH_EXPLORER_PART\txcku025-ffva1156-2-e\tkintexu\t-2\n\
            SYNTH_EXPLORER_PART\txc7a35tcpg236-1\tartix7\t-1\n\
            SYNTH_EXPLORER_PART\txc7a35tcpg236-1\tartix7\t-1\n";
        assert_eq!(
            parse_part_catalog(output).unwrap(),
            vec![
                VivadoPart {
                    name: "xc7a35tcpg236-1".to_owned(),
                    family: "artix7".to_owned(),
                    speed: "-1".to_owned(),
                },
                VivadoPart {
                    name: "xcku025-ffva1156-2-e".to_owned(),
                    family: "kintexu".to_owned(),
                    speed: "-2".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn part_catalog_parser_rejects_empty_or_unsafe_catalogs() {
        assert!(parse_part_catalog("Vivado v2026.1").is_err());
        assert!(parse_part_catalog("SYNTH_EXPLORER_PART\txc7a35t;exec\tartix7\t-1\n").is_err());
    }

    // Every fixture below is verbatim `report_timing` output captured from the
    // real Vivado 2026.1 install (xc7a35tcpg236-1), not hand-written.
    const MET_REPORT: &str = include_str!("../tests/fixtures/vivado_report_timing_met.rpt");
    const VIOLATED_REPORT: &str =
        include_str!("../tests/fixtures/vivado_report_timing_violated.rpt");
    const NO_PATHS_REPORT: &str =
        include_str!("../tests/fixtures/vivado_report_timing_no_paths.rpt");
    const UNCONSTRAINED_REPORT: &str =
        include_str!("../tests/fixtures/vivado_report_timing_unconstrained.rpt");

    #[test]
    fn timing_parser_reads_every_field_of_a_real_met_report() {
        assert_eq!(
            parse_report_timing(MET_REPORT).unwrap(),
            VivadoTiming {
                data_path_delay_ns: 2.616,
                logic_ns: 1.855,
                route_ns: 0.761,
                logic_levels: 5,
                slack_ns: 7.280,
                slack_met: true,
                reference_period_ns: 10.0,
                source: "ra_reg[1]/C".to_owned(),
                destination: "q_reg[13]/D".to_owned(),
            }
        );
    }

    #[test]
    fn timing_parser_reads_a_real_violated_report_as_negative_slack() {
        let timing = parse_report_timing(VIOLATED_REPORT).unwrap();
        assert_eq!(timing.slack_ns, -1.720);
        assert!(!timing.slack_met);
    }

    /// The met and violated fixtures are the same design reported against a
    /// 10ns and a 1ns reference clock. Vivado's `Data Path Delay` is identical
    /// across both while slack moves by exactly the 9ns period change — the
    /// property that lets us report a delay under an arbitrary reference clock.
    #[test]
    fn reference_period_moves_slack_but_never_the_reported_delay() {
        let met = parse_report_timing(MET_REPORT).unwrap();
        let violated = parse_report_timing(VIOLATED_REPORT).unwrap();
        assert_eq!(met.data_path_delay_ns, violated.data_path_delay_ns);
        assert_eq!(met.logic_ns, violated.logic_ns);
        assert_eq!(met.route_ns, violated.route_ns);
        assert_eq!(met.logic_levels, violated.logic_levels);
        assert!((met.slack_ns - violated.slack_ns - 9.0).abs() < 1e-9);
    }

    /// `logic + route` is the whole of `Data Path Delay`; setup is not in it.
    #[test]
    fn reported_logic_and_route_account_for_the_whole_data_path() {
        let timing = parse_report_timing(MET_REPORT).unwrap();
        assert!((timing.logic_ns + timing.route_ns - timing.data_path_delay_ns).abs() < 1e-9);
    }

    /// A design whose registers all run on an internally generated clock: we
    /// constrain no port, so Vivado reports the path with `Slack: inf`. The
    /// delay is real but has no launch edge, so we report nothing.
    #[test]
    fn timing_parser_declines_a_real_unconstrained_report() {
        assert!(UNCONSTRAINED_REPORT.contains("Data Path Delay:        2.522ns"));
        assert_eq!(parse_report_timing(UNCONSTRAINED_REPORT), None);
    }

    #[test]
    fn timing_parser_declines_a_real_report_with_no_register_paths() {
        assert_eq!(parse_report_timing(NO_PATHS_REPORT), None);
    }

    #[test]
    fn timing_parser_declines_truncated_or_unrelated_output() {
        assert_eq!(parse_report_timing(""), None);
        assert_eq!(parse_report_timing("Vivado v2026.1"), None);
        // A slack line alone is not a usable report.
        assert_eq!(parse_report_timing("Slack (MET) :  7.280ns"), None);
    }

    /// `Destination:` must not be satisfied by `Destination Clock Delay (DCD):`,
    /// which appears first in some reports.
    #[test]
    fn timing_field_lookup_does_not_confuse_similarly_prefixed_labels() {
        let timing = parse_report_timing(MET_REPORT).unwrap();
        assert_eq!(timing.destination, "q_reg[13]/D");
        assert_eq!(timing.source, "ra_reg[1]/C");
    }

    #[test]
    fn timing_tcl_reports_after_write_verilog_and_cannot_fail_synthesis() {
        let script = build_tcl(&input(), "top", "vivado-netlist.v");
        let write = script.find("write_verilog").unwrap();
        let report = script.find("report_timing").unwrap();
        // Ordering is the guarantee that Tier 2 cannot perturb the netlist.
        assert!(write < script.find("create_clock").unwrap());
        assert!(write < report);
        assert!(script.contains("catch"));
        assert!(script.contains("-period 10.000"));
        assert!(script.contains("report_timing -delay_type max -from $se_regs -to $se_regs"));
    }

    /// The completion marker must sit after the netlist and before the timing
    /// step, or a timeout inside the timing step could not be told apart from
    /// a synthesis that never finished.
    #[test]
    fn netlist_marker_separates_synthesis_from_the_best_effort_timing_step() {
        let script = build_tcl(&input(), "top", "vivado-netlist.v");
        let write = script.find("write_verilog").unwrap();
        let marker = script.find(NETLIST_MARKER_NAME).unwrap();
        let timing = script.find("all_registers").unwrap();
        assert!(write < marker, "marker must prove write_verilog returned");
        assert!(marker < timing, "marker must precede the timing step");
        assert!(script.contains("close [open {netlist-complete.marker} w]"));
    }

    #[test]
    fn netlist_preamble_parser_skips_malformed_vivado_os_banner() {
        let netlist = b"// Host: worker running Ubuntu\"\n\
                        VERSION_ID=\"24.04 24.04.4 LTS\"\n\
                        VERSION_CODENAME=noble\n\
                        `timescale 1 ps / 1 ps\n\
                        module top; endmodule\n";
        let offset = line_start_offset(netlist, b"`timescale").unwrap();
        assert_eq!(
            &netlist[offset..],
            b"`timescale 1 ps / 1 ps\nmodule top; endmodule\n"
        );
    }

    #[test]
    fn netlist_parser_finds_appended_glbl_simulation_module() {
        let netlist = b"`timescale 1 ps / 1 ps\n\
                        module top; endmodule\n\
                        `ifndef GLBL\n\
                        module glbl ();\n\
                        tri1 p_up_tmp;\n\
                        endmodule\n\
                        `endif\n";
        let end = line_start_offset(netlist, b"`ifndef GLBL").unwrap();
        assert_eq!(
            &netlist[..end],
            b"`timescale 1 ps / 1 ps\nmodule top; endmodule\n"
        );
    }
}
