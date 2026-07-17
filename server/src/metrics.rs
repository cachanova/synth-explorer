use std::fmt::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

#[derive(Debug, Default)]
pub(crate) struct AppMetrics {
    synthesis_requests: AtomicU64,
    synthesis_runs: AtomicU64,
    synthesis_cache_hits: AtomicU64,
    synthesis_failures: AtomicU64,
    synthesis_queue_rejections: AtomicU64,
    synthesis_in_flight: AtomicU64,
    started_at: Option<Instant>,
}

impl AppMetrics {
    pub(crate) fn new() -> Self {
        Self {
            started_at: Some(Instant::now()),
            ..Self::default()
        }
    }

    pub(crate) fn record_synthesis_request(&self) {
        self.synthesis_requests.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_synthesis_cache_hit(&self) {
        self.synthesis_cache_hits.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn record_synthesis_queue_rejection(&self) {
        self.synthesis_queue_rejections
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn start_synthesis(&self) -> SynthesisRun<'_> {
        self.synthesis_runs.fetch_add(1, Ordering::Relaxed);
        self.synthesis_in_flight.fetch_add(1, Ordering::Relaxed);
        SynthesisRun {
            metrics: self,
            succeeded: false,
        }
    }

    pub(crate) fn render(&self) -> String {
        let mut output = String::with_capacity(2_048);
        metric(
            &mut output,
            "synth_explorer_synthesis_requests_total",
            "Validated synthesis API requests, including cache hits and shared-flight followers.",
            "counter",
            self.synthesis_requests.load(Ordering::Relaxed),
        );
        metric(
            &mut output,
            "synth_explorer_synthesis_runs_total",
            "Synthesis pipelines that reached an actual synthesis backend.",
            "counter",
            self.synthesis_runs.load(Ordering::Relaxed),
        );
        metric(
            &mut output,
            "synth_explorer_synthesis_cache_hits_total",
            "Synthesis requests completed from memory or persistent cache.",
            "counter",
            self.synthesis_cache_hits.load(Ordering::Relaxed),
        );
        metric(
            &mut output,
            "synth_explorer_synthesis_failures_total",
            "Actual synthesis pipelines that ended without a retained design.",
            "counter",
            self.synthesis_failures.load(Ordering::Relaxed),
        );
        metric(
            &mut output,
            "synth_explorer_synthesis_queue_rejections_total",
            "Synthesis requests rejected because the distinct-design queue was full.",
            "counter",
            self.synthesis_queue_rejections.load(Ordering::Relaxed),
        );
        metric(
            &mut output,
            "synth_explorer_synthesis_in_flight",
            "Actual synthesis pipelines currently running.",
            "gauge",
            self.synthesis_in_flight.load(Ordering::Relaxed),
        );
        metric(
            &mut output,
            "synth_explorer_process_resident_memory_bytes",
            "Resident memory used by the Synth Explorer server process.",
            "gauge",
            process_resident_memory_bytes(),
        );
        metric(
            &mut output,
            "synth_explorer_process_uptime_seconds",
            "Seconds since the Synth Explorer server process started.",
            "gauge",
            self.started_at
                .map_or(0, |started| started.elapsed().as_secs()),
        );
        output
    }
}

pub(crate) struct SynthesisRun<'a> {
    metrics: &'a AppMetrics,
    succeeded: bool,
}

impl SynthesisRun<'_> {
    pub(crate) fn succeed(mut self) {
        self.succeeded = true;
    }
}

impl Drop for SynthesisRun<'_> {
    fn drop(&mut self) {
        self.metrics
            .synthesis_in_flight
            .fetch_sub(1, Ordering::Relaxed);
        if !self.succeeded {
            self.metrics
                .synthesis_failures
                .fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn metric(output: &mut String, name: &str, help: &str, kind: &str, value: u64) {
    writeln!(output, "# HELP {name} {help}").expect("writing to a String cannot fail");
    writeln!(output, "# TYPE {name} {kind}").expect("writing to a String cannot fail");
    writeln!(output, "{name} {value}").expect("writing to a String cannot fail");
}

fn process_resident_memory_bytes() -> u64 {
    let Ok(status) = std::fs::read_to_string("/proc/self/status") else {
        return 0;
    };
    status
        .lines()
        .find_map(|line| {
            let value = line.strip_prefix("VmRSS:")?.split_whitespace().next()?;
            value.parse::<u64>().ok()?.checked_mul(1_024)
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthesis_guard_tracks_success_and_failure() {
        let metrics = AppMetrics::new();
        metrics.record_synthesis_request();
        metrics.record_synthesis_cache_hit();
        metrics.record_synthesis_queue_rejection();
        metrics.start_synthesis().succeed();
        drop(metrics.start_synthesis());

        let rendered = metrics.render();
        assert!(rendered.contains("synth_explorer_synthesis_requests_total 1\n"));
        assert!(rendered.contains("synth_explorer_synthesis_runs_total 2\n"));
        assert!(rendered.contains("synth_explorer_synthesis_cache_hits_total 1\n"));
        assert!(rendered.contains("synth_explorer_synthesis_failures_total 1\n"));
        assert!(rendered.contains("synth_explorer_synthesis_queue_rejections_total 1\n"));
        assert!(rendered.contains("synth_explorer_synthesis_in_flight 0\n"));
    }
}
