use crate::netlist::{NetlistError, parse_value, select_top};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::time::Duration;
use tempfile::TempDir;
use thiserror::Error;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::process::Command;
use tokio::time::timeout;

const LOG_TAIL_LIMIT: usize = 64 * 1024;
const JSON_SIZE_LIMIT: u64 = 64 * 1024 * 1024;
const YOSYS_TIMEOUT: Duration = Duration::from_secs(60);
const YOSYS_PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "linux")]
const CHILD_ADDRESS_SPACE_LIMIT: libc::rlim_t = 2 * 1024 * 1024 * 1024;
#[cfg(target_os = "linux")]
const CHILD_FILE_SIZE_LIMIT: libc::rlim_t = 128 * 1024 * 1024;
#[cfg(target_os = "linux")]
const CHILD_OPEN_FILES_LIMIT: libc::rlim_t = 128;
#[cfg(target_os = "linux")]
const CHILD_CPU_SECONDS_LIMIT: libc::rlim_t = 65;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SynthMode {
    Rtl,
    Gates,
    Lut4,
    Lut6,
    Ice40,
    Ecp5,
    Xilinx,
}

impl fmt::Display for SynthMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Rtl => "rtl",
            Self::Gates => "gates",
            Self::Lut4 => "lut4",
            Self::Lut6 => "lut6",
            Self::Ice40 => "ice40",
            Self::Ecp5 => "ecp5",
            Self::Xilinx => "xilinx",
        };
        f.write_str(value)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SynthRequest {
    pub files: Vec<SourceFile>,
    pub top: Option<String>,
    pub mode: SynthMode,
    pub extra_args: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ValidatedSynth {
    pub files: Vec<SourceFile>,
    pub top: Option<String>,
    pub mode: SynthMode,
    pub extra_args: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct YosysOutput {
    pub json: Value,
    pub source_json: Value,
    pub log: String,
    pub resolved_top: String,
}

#[derive(Debug, Error)]
pub enum YosysError {
    #[error("{0}")]
    Validation(String),
    #[error("yosys timed out")]
    Timeout { log: String },
    #[error("yosys failed")]
    Yosys { log: String },
    #[error("failed to run yosys: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid yosys output: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid yosys netlist: {0}")]
    Netlist(#[from] NetlistError),
}

impl SynthRequest {
    pub fn validate(self) -> Result<ValidatedSynth, YosysError> {
        if self.files.is_empty() {
            return Err(YosysError::Validation(
                "at least one source file is required".to_owned(),
            ));
        }
        let mut files = self.files;
        files.sort_by(|a, b| a.name.cmp(&b.name));
        for file in &files {
            validate_filename(&file.name)?;
        }
        if let Some(top) = &self.top {
            validate_top(top)?;
        }
        let extra_args = parse_extra_args(self.extra_args.as_deref())?;
        Ok(ValidatedSynth {
            files,
            top: self.top,
            mode: self.mode,
            extra_args,
        })
    }
}

impl ValidatedSynth {
    pub fn design_id(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.mode.to_string().as_bytes());
        hasher.update([0]);
        if let Some(top) = &self.top {
            hasher.update(top.as_bytes());
        }
        hasher.update([0]);
        hasher.update(self.extra_args.join(" ").as_bytes());
        hasher.update([0]);
        for file in &self.files {
            hasher.update(file.name.as_bytes());
            hasher.update([0]);
            hasher.update(file.content.as_bytes());
            hasher.update([0]);
        }
        let digest = hasher.finalize();
        let mut out = String::with_capacity(12);
        for byte in &digest[..6] {
            out.push_str(&format!("{:02x}", *byte));
        }
        out
    }

    pub fn file_names(&self) -> Vec<String> {
        self.files.iter().map(|file| file.name.clone()).collect()
    }
}

/// Verify the production runtime can execute Yosys and capture its version once.
///
/// Routers do not perform this check so unit tests and in-process callers remain cheap.
pub async fn preflight_yosys() -> Result<String, YosysError> {
    let output = timeout(
        YOSYS_PREFLIGHT_TIMEOUT,
        Command::new("yosys").arg("-V").output(),
    )
    .await
    .map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "yosys version check timed out",
        )
    })??;
    if !output.status.success() {
        return Err(YosysError::Yosys {
            log: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if version.is_empty() {
        return Err(YosysError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "yosys returned an empty version",
        )));
    }
    Ok(version)
}

pub async fn run_yosys(input: &ValidatedSynth) -> Result<YosysOutput, YosysError> {
    let temp = TempDir::new()?;
    for file in &input.files {
        fs::write(temp.path().join(&file.name), &file.content).await?;
    }

    let script = build_script(input);
    let script_path = temp.path().join("script.ys");
    let log_path = temp.path().join("log.txt");
    let json_path = temp.path().join("netlist.json");
    let source_json_path = temp.path().join("source-netlist.json");
    fs::write(&script_path, script).await?;

    let mut command = Command::new("yosys");
    command
        .arg("-q")
        .arg("-T")
        .arg("-l")
        .arg(&log_path)
        .arg("-s")
        .arg(&script_path)
        .current_dir(temp.path())
        .kill_on_drop(true);
    configure_child(&mut command);
    let mut child = command.spawn()?;
    let mut process_group = ProcessGroupGuard::new(&child);

    let status = match timeout(YOSYS_TIMEOUT, child.wait()).await {
        Ok(status) => {
            let status = status?;
            process_group.disarm();
            status
        }
        Err(_) => {
            process_group.kill();
            #[cfg(not(target_os = "linux"))]
            let _ = child.kill().await;
            let _ = child.wait().await;
            process_group.disarm();
            let log = read_log_tail(&log_path).await.unwrap_or_default();
            return Err(YosysError::Timeout { log });
        }
    };

    let log = read_log_tail(&log_path).await.unwrap_or_default();
    if !status.success() {
        return Err(YosysError::Yosys { log });
    }

    let json = read_json_limited(&json_path, "yosys json").await?;
    let source_json = read_json_limited(&source_json_path, "yosys source json").await?;
    let parsed = parse_value(json.clone())?;
    let (top, _) = select_top(&parsed, None)?;
    Ok(YosysOutput {
        json,
        source_json,
        log,
        resolved_top: top.to_owned(),
    })
}

#[cfg(target_os = "linux")]
fn configure_child(command: &mut Command) {
    command.as_std_mut().process_group(0);
    // SAFETY: the callback only invokes async-signal-safe setrlimit calls between
    // fork and exec. The limits are inherited by Yosys and every ABC descendant.
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
    // SAFETY: `limit` is a valid pointer for the duration of this call and the
    // resource constants above are valid on Linux.
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
            // SAFETY: a negative PID targets the isolated process group created
            // for this child. SIGKILL is used so timeout cleanup cannot hang.
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

fn build_script(input: &ValidatedSynth) -> String {
    let mut script = String::new();
    push_read_verilog(&mut script, input);
    script.push_str(&format!(
        "hierarchy {}\nproc\nwrite_json source-netlist.json\ndesign -reset\n",
        top_args(input.top.as_deref())
    ));
    push_read_verilog(&mut script, input);
    let top_args = top_args(input.top.as_deref());
    let extra = if input.extra_args.is_empty() {
        String::new()
    } else {
        format!(" {}", input.extra_args.join(" "))
    };
    match input.mode {
        SynthMode::Rtl => {
            script.push_str(&format!("prep {top_args}{extra}\nflatten\n"));
        }
        SynthMode::Gates => {
            script.push_str(&format!("synth {top_args} -flatten{extra}\n"));
        }
        SynthMode::Lut4 => {
            script.push_str(&format!("synth {top_args} -flatten -lut 4{extra}\n"));
        }
        SynthMode::Lut6 => {
            script.push_str(&format!("synth {top_args} -flatten -lut 6{extra}\n"));
        }
        SynthMode::Ice40 => {
            if input.top.is_none() {
                script.push_str("hierarchy -auto-top\n");
            }
            script.push_str(&format!(
                "synth_ice40 {} -flatten{extra}\n",
                top_only(input.top.as_deref())
            ));
        }
        SynthMode::Ecp5 => {
            if input.top.is_none() {
                script.push_str("hierarchy -auto-top\n");
            }
            script.push_str(&format!(
                "synth_ecp5 {} -flatten{extra}\n",
                top_only(input.top.as_deref())
            ));
        }
        SynthMode::Xilinx => {
            if input.top.is_none() {
                script.push_str("hierarchy -auto-top\n");
            }
            script.push_str(&format!(
                "synth_xilinx {} -flatten{extra}\n",
                top_only(input.top.as_deref())
            ));
        }
    }
    script.push_str("write_json netlist.json\n");
    script
}

fn push_read_verilog(script: &mut String, input: &ValidatedSynth) {
    script.push_str("read_verilog -sv");
    for file in &input.files {
        script.push(' ');
        script.push_str(&file.name);
    }
    script.push('\n');
}

async fn read_json_limited(path: &Path, label: &str) -> Result<Value, YosysError> {
    let metadata = fs::metadata(path).await?;
    if metadata.len() > JSON_SIZE_LIMIT {
        return Err(YosysError::Validation(format!(
            "{label} exceeded {JSON_SIZE_LIMIT} bytes"
        )));
    }
    let bytes = fs::read(path).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn top_args(top: Option<&str>) -> String {
    top.map_or_else(|| "-auto-top".to_owned(), |name| format!("-top {name}"))
}

fn top_only(top: Option<&str>) -> String {
    top.map_or_else(String::new, |name| format!("-top {name}"))
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

fn validate_filename(name: &str) -> Result<(), YosysError> {
    if !name.ends_with(".v") && !name.ends_with(".sv") {
        return Err(YosysError::Validation(format!(
            "source filename must end in .v or .sv: {name}"
        )));
    }
    if name.is_empty()
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        return Err(YosysError::Validation(format!(
            "invalid source filename: {name}"
        )));
    }
    Ok(())
}

fn validate_top(top: &str) -> Result<(), YosysError> {
    if top.is_empty()
        || !top
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$'))
    {
        return Err(YosysError::Validation(format!(
            "invalid top module name: {top}"
        )));
    }
    Ok(())
}

fn parse_extra_args(extra_args: Option<&str>) -> Result<Vec<String>, YosysError> {
    let Some(extra_args) = extra_args else {
        return Ok(Vec::new());
    };
    extra_args
        .split_whitespace()
        .map(|token| {
            if token.chars().all(|ch| {
                ch.is_ascii_alphanumeric() || matches!(ch, '_' | '+' | '=' | '.' | ',' | ':' | '-')
            }) {
                Ok(token.to_owned())
            } else {
                Err(YosysError::Validation(format!(
                    "invalid extra_args token: {token}"
                )))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_rejects_traversal_filename() {
        let request = SynthRequest {
            files: vec![SourceFile {
                name: "../bad.sv".to_owned(),
                content: String::new(),
            }],
            top: None,
            mode: SynthMode::Rtl,
            extra_args: None,
        };
        assert!(request.validate().is_err());
    }

    #[test]
    fn validation_rejects_yosys_script_injection() {
        let request = SynthRequest {
            files: vec![SourceFile {
                name: "design.sv".to_owned(),
                content: "module top; endmodule".to_owned(),
            }],
            top: Some("top".to_owned()),
            mode: SynthMode::Gates,
            extra_args: Some("-noabc;rm".to_owned()),
        };
        let error = request.validate().unwrap_err();
        assert_eq!(error.to_string(), "invalid extra_args token: -noabc;rm");
    }

    #[test]
    fn synthesis_flags_are_normalized_and_appended_to_the_selected_pass() {
        let input = SynthRequest {
            files: vec![SourceFile {
                name: "design.sv".to_owned(),
                content: "module top; endmodule".to_owned(),
            }],
            top: Some("top".to_owned()),
            mode: SynthMode::Gates,
            extra_args: Some("  -nofsm   -noabc  ".to_owned()),
        }
        .validate()
        .unwrap();

        assert_eq!(input.extra_args, ["-nofsm", "-noabc"]);
        assert_eq!(
            build_script(&input),
            "read_verilog -sv design.sv\nhierarchy -top top\nproc\nwrite_json source-netlist.json\ndesign -reset\nread_verilog -sv design.sv\nsynth -top top -flatten -nofsm -noabc\nwrite_json netlist.json\n"
        );
    }

    #[test]
    fn design_id_is_order_stable() {
        let a = SynthRequest {
            files: vec![
                SourceFile {
                    name: "b.sv".to_owned(),
                    content: "module b; endmodule".to_owned(),
                },
                SourceFile {
                    name: "a.sv".to_owned(),
                    content: "module a; endmodule".to_owned(),
                },
            ],
            top: Some("a".to_owned()),
            mode: SynthMode::Rtl,
            extra_args: Some("  -ifx   ".to_owned()),
        }
        .validate()
        .unwrap();
        let b = SynthRequest {
            files: a.files.iter().cloned().rev().collect(),
            top: a.top.clone(),
            mode: a.mode,
            extra_args: Some(a.extra_args.join(" ")),
        }
        .validate()
        .unwrap();
        assert_eq!(a.design_id(), b.design_id());
        assert_eq!(a.design_id().len(), 12);
    }
}
