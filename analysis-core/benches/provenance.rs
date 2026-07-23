use criterion::{BatchSize, BenchmarkId, Criterion, Throughput, criterion_group, criterion_main};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::env;
use std::fs;
use std::hint::black_box;
use std::path::{Path, PathBuf};
use std::time::Duration;
use synth_explorer_analysis::analysis::{
    SourceSelectionOptions, SourceSelectionRange, SourceSelectionResult,
};
use synth_explorer_analysis::delay_model::DelayProfile;
use synth_explorer_analysis::design::AnalysisDesign;
use synth_explorer_analysis::netlist::YosysNetlist;

const DEFAULT_FIXTURES: &[&str] = &[
    "round_robin_arbiter:verilog",
    "round_robin_arbiter:vhdl",
    "priority_encoder_for:vhdl",
    "barrel_shifter:verilog",
    "inferred_fifo:verilog",
    "inferred_fifo:vhdl",
];

#[derive(Deserialize)]
struct PrecomputedManifest {
    entries: Vec<PrecomputedEntry>,
}

#[derive(Deserialize)]
struct PrecomputedEntry {
    name: String,
    key: String,
}

#[derive(Deserialize)]
struct PrecomputedArtifact {
    input: ArtifactInput,
    profile: String,
    output: ArtifactOutput,
}

#[derive(Deserialize)]
struct ArtifactInput {
    files: Vec<SourceFile>,
    mode: String,
}

#[derive(Deserialize)]
struct SourceFile {
    name: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactOutput {
    netlist_json: String,
    source_netlist_json: String,
}

struct Fixture {
    name: String,
    netlist: YosysNetlist,
    source_netlist: YosysNetlist,
    files: Vec<(String, String)>,
    mode: String,
    profile: DelayProfile,
}

#[derive(Clone)]
struct SelectionWorkload {
    file: String,
    line: usize,
    column: Option<usize>,
    fallback_columns: Option<(usize, usize)>,
}

struct PreparedFixture {
    name: String,
    design: AnalysisDesign,
    exact: Option<SelectionWorkload>,
    fallback: Option<SelectionWorkload>,
    node_ids: Vec<u32>,
    bits: Vec<u32>,
}

#[derive(Clone, Copy)]
struct BaselineDigests {
    source_map: u64,
    exact: Option<u64>,
    fallback: Option<u64>,
    nodes: u64,
    bits: u64,
}

fn baseline_digests(name: &str) -> BaselineDigests {
    match name {
        "round_robin_arbiter:verilog" => BaselineDigests {
            source_map: 0x46a2_3292_4aa2_e2bd,
            exact: Some(0xe0f7_a049_801e_2957),
            fallback: Some(0xe0f7_a049_801e_2957),
            nodes: 0x615a_1ec5_4172_d186,
            bits: 0xe1f6_3ad3_0a9c_230f,
        },
        "round_robin_arbiter:vhdl" => BaselineDigests {
            source_map: 0xe996_697f_3868_a217,
            exact: Some(0xf0bb_aa27_32be_094a),
            fallback: None,
            nodes: 0x57ab_a874_c480_1b26,
            bits: 0x5019_3dc1_e6ef_35db,
        },
        "priority_encoder_for:vhdl" => BaselineDigests {
            source_map: 0x49b9_e1c2_3983_6f81,
            exact: None,
            fallback: None,
            nodes: 0x7f8c_8b29_880e_71d3,
            bits: 0x25a0_2f23_74d4_2f27,
        },
        "barrel_shifter:verilog" => BaselineDigests {
            source_map: 0x5e2c_5590_fb96_1302,
            exact: Some(0xfd4a_9dd9_2109_c1e2),
            fallback: Some(0xfd4a_9dd9_2109_c1e2),
            nodes: 0xd497_ac52_4b0f_89f3,
            bits: 0xee5c_e43c_f034_10d9,
        },
        "inferred_fifo:verilog" => BaselineDigests {
            source_map: 0xc323_506e_9eec_eae9,
            exact: Some(0xdb99_4db8_6a1c_ae1b),
            fallback: Some(0xdb99_4db8_6a1c_ae1b),
            nodes: 0x7ee7_bf07_5aa1_1f61,
            bits: 0x1e43_6276_f3a9_c033,
        },
        "inferred_fifo:vhdl" => BaselineDigests {
            source_map: 0x6215_c83d_8716_f14a,
            exact: Some(0x4e20_76bf_21cc_407a),
            fallback: None,
            nodes: 0xf253_cf2f_d2d1_224d,
            bits: 0x8d18_8eaa_81d0_5b52,
        },
        _ => panic!("missing frozen baseline digests for {name}"),
    }
}

fn benchmark_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("analysis-core must be inside the repository")
        .to_owned()
}

fn requested_fixture_names() -> Vec<String> {
    env::var("SYNTH_PROVENANCE_BENCH_FIXTURES")
        .ok()
        .map(|names| {
            names
                .split(',')
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|names| !names.is_empty())
        .unwrap_or_else(|| {
            DEFAULT_FIXTURES
                .iter()
                .map(|name| (*name).to_owned())
                .collect()
        })
}

fn load_fixtures() -> Vec<Fixture> {
    let root = benchmark_root();
    let manifest_path = root.join("web/src/data/precomputedManifest.json");
    let manifest: PrecomputedManifest = serde_json::from_slice(
        &fs::read(&manifest_path)
            .unwrap_or_else(|error| panic!("failed to read {}: {error}", manifest_path.display())),
    )
    .unwrap_or_else(|error| panic!("failed to parse {}: {error}", manifest_path.display()));
    let keys = manifest
        .entries
        .into_iter()
        .map(|entry| (entry.name, entry.key))
        .collect::<HashMap<_, _>>();

    requested_fixture_names()
        .into_iter()
        .map(|name| {
            let key = keys
                .get(&name)
                .unwrap_or_else(|| panic!("unknown precomputed fixture {name:?}"));
            let artifact_path = root.join(format!("web/public/precomputed/{key}.json"));
            let artifact: PrecomputedArtifact =
                serde_json::from_slice(&fs::read(&artifact_path).unwrap_or_else(|error| {
                    panic!("failed to read {}: {error}", artifact_path.display())
                }))
                .unwrap_or_else(|error| {
                    panic!("failed to parse {}: {error}", artifact_path.display())
                });
            let netlist = serde_json::from_str(&artifact.output.netlist_json)
                .unwrap_or_else(|error| panic!("failed to parse {name} mapped netlist: {error}"));
            let source_netlist = serde_json::from_str(&artifact.output.source_netlist_json)
                .unwrap_or_else(|error| panic!("failed to parse {name} source netlist: {error}"));
            Fixture {
                name,
                netlist,
                source_netlist,
                files: artifact
                    .input
                    .files
                    .into_iter()
                    .map(|file| (file.name, file.content))
                    .collect(),
                mode: artifact.input.mode,
                profile: DelayProfile::from_name(Some(&artifact.profile)),
            }
        })
        .collect()
}

fn build_design(fixture: &Fixture, files: Vec<(String, String)>) -> AnalysisDesign {
    AnalysisDesign::from_netlists(
        &fixture.netlist,
        &fixture.source_netlist,
        files,
        fixture.mode.as_str(),
        fixture.profile,
        false,
    )
    .unwrap_or_else(|error| panic!("failed to build fixture {}: {error}", fixture.name))
}

fn selection_options() -> SourceSelectionOptions {
    SourceSelectionOptions {
        max_nodes: 400,
        hide_control: true,
        hide_const: true,
        group_vectors: false,
        group_memories: false,
    }
}

fn run_selection(design: &AnalysisDesign, workload: &SelectionWorkload) -> SourceSelectionResult {
    design
        .analysis
        .source_selection_with_fallback(
            &design.graph,
            &design.grouping,
            SourceSelectionRange {
                file: &workload.file,
                start_line: workload.line,
                end_line: workload.line,
                start_column: workload.column,
                end_column: workload.column,
            },
            workload.fallback_columns,
            selection_options(),
        )
        .unwrap_or_else(|error| {
            panic!(
                "source selection failed for {}:{}:{:?}: {error}",
                workload.file, workload.line, workload.column
            )
        })
}

fn has_direct_mapping(result: &SourceSelectionResult) -> bool {
    !result.direct_ids.is_empty() || !result.direct_bits.is_empty()
}

fn source_line<'a>(files: &'a [(String, String)], file: &str, line: usize) -> Option<&'a str> {
    files
        .iter()
        .find(|(name, _)| name == file)
        .and_then(|(_, source)| source.lines().nth(line.checked_sub(1)?))
}

fn statement_bounds(line: &str, column: usize) -> (usize, usize) {
    let offset = column.saturating_sub(1).min(line.len());
    let start = line[..offset]
        .rfind(';')
        .map_or(1, |semicolon| semicolon + 2);
    let end = line[offset..]
        .find(';')
        .map_or_else(|| line.len().max(1), |semicolon| offset + semicolon + 1);
    (start, end.max(start))
}

fn find_selection_workloads(
    fixture: &Fixture,
    design: &AnalysisDesign,
) -> (Option<SelectionWorkload>, Option<SelectionWorkload>) {
    let source_map = design.analysis.source_map();
    for range in &source_map.ranges {
        let (Some(start), Some(end)) = (range.start_column, range.end_column) else {
            continue;
        };
        if range.start_line != range.end_line || start > end {
            continue;
        }
        let exact = SelectionWorkload {
            file: range.file.clone(),
            line: range.start_line,
            column: Some(start),
            fallback_columns: None,
        };
        if !has_direct_mapping(&run_selection(design, &exact)) {
            continue;
        }

        let fallback =
            source_line(&fixture.files, &range.file, range.start_line).and_then(|line| {
                let bounds = statement_bounds(line, start);
                (bounds.0..=bounds.1).find_map(|column| {
                    let miss = SelectionWorkload {
                        file: range.file.clone(),
                        line: range.start_line,
                        column: Some(column),
                        fallback_columns: None,
                    };
                    if has_direct_mapping(&run_selection(design, &miss)) {
                        return None;
                    }
                    let fallback = SelectionWorkload {
                        fallback_columns: Some(bounds),
                        ..miss
                    };
                    has_direct_mapping(&run_selection(design, &fallback)).then_some(fallback)
                })
            });
        return (Some(exact), fallback);
    }
    for range in &source_map.ranges {
        let exact = SelectionWorkload {
            file: range.file.clone(),
            line: range.start_line,
            column: None,
            fallback_columns: None,
        };
        if has_direct_mapping(&run_selection(design, &exact)) {
            return (Some(exact), None);
        }
    }
    (None, None)
}

fn query_node_ids(design: &AnalysisDesign) -> Vec<u32> {
    let sourced = design
        .analysis
        .source_map()
        .ranges
        .into_iter()
        .flat_map(|range| range.node_ids)
        .collect::<BTreeSet<_>>();
    let mut ids = sourced.iter().copied().take(200).collect::<Vec<_>>();
    ids.extend(
        (0..design.graph.nodes.len())
            .map(|id| id as u32)
            .filter(|id| !sourced.contains(id))
            .take(200 - ids.len()),
    );
    ids
}

fn query_bits(design: &AnalysisDesign) -> Vec<u32> {
    let mut sourced = BTreeSet::new();
    for range in design.analysis.source_map().ranges {
        sourced.extend(range.signal_bits);
        sourced.extend(range.approximate_signal_bits);
    }
    let mut bits = sourced.iter().copied().take(200).collect::<Vec<_>>();
    let unsourced = design
        .graph
        .net_names
        .keys()
        .copied()
        .collect::<BTreeSet<_>>();
    bits.extend(
        unsourced
            .into_iter()
            .filter(|bit| !sourced.contains(bit))
            .take(200 - bits.len()),
    );
    bits
}

fn digest<T: Serialize>(value: &T) -> u64 {
    serde_json::to_vec(value)
        .expect("benchmark response must serialize")
        .into_iter()
        .fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
}

fn stable_digest<T: Serialize>(first: &T, second: &T, label: &str) -> u64 {
    let first = digest(first);
    let second = digest(second);
    assert_eq!(
        first, second,
        "non-deterministic benchmark result for {label}"
    );
    first
}

fn prepare_fixture(fixture: &Fixture) -> PreparedFixture {
    let design = build_design(fixture, fixture.files.clone());
    let (exact, fallback) = find_selection_workloads(fixture, &design);
    let node_ids = query_node_ids(&design);
    let bits = query_bits(&design);
    assert!(!node_ids.is_empty(), "{} has no graph nodes", fixture.name);
    assert!(
        !bits.is_empty(),
        "{} has no queryable net bits",
        fixture.name
    );

    let exact_digest = exact.as_ref().map(|workload| {
        stable_digest(
            &run_selection(&design, workload),
            &run_selection(&design, workload),
            &format!("{}/source_selection/exact", fixture.name),
        )
    });
    let fallback_digest = fallback.as_ref().map(|workload| {
        stable_digest(
            &run_selection(&design, workload),
            &run_selection(&design, workload),
            &format!("{}/source_selection/fallback", fixture.name),
        )
    });
    let nodes_once = node_ids
        .iter()
        .map(|id| design.analysis.node_ref(&design.graph, *id))
        .collect::<Vec<_>>();
    let nodes_twice = node_ids
        .iter()
        .map(|id| design.analysis.node_ref(&design.graph, *id))
        .collect::<Vec<_>>();
    let nodes_digest = stable_digest(
        &nodes_once,
        &nodes_twice,
        &format!("{}/node_to_source", fixture.name),
    );
    let bits_digest = stable_digest(
        &design.analysis.source_ranges_for_bits(&bits),
        &design.analysis.source_ranges_for_bits(&bits),
        &format!("{}/bit_to_source", fixture.name),
    );
    let source_map_digest = stable_digest(
        &design.analysis.source_map(),
        &design.analysis.source_map(),
        &format!("{}/source_map", fixture.name),
    );
    let baseline = baseline_digests(&fixture.name);
    assert_eq!(
        source_map_digest, baseline.source_map,
        "{} source-map behavior differs from the frozen baseline",
        fixture.name
    );
    assert_eq!(
        exact_digest, baseline.exact,
        "{} exact-selection behavior differs from the frozen baseline",
        fixture.name
    );
    assert_eq!(
        fallback_digest, baseline.fallback,
        "{} fallback-selection behavior differs from the frozen baseline",
        fixture.name
    );
    assert_eq!(
        nodes_digest, baseline.nodes,
        "{} node-to-source behavior differs from the frozen baseline",
        fixture.name
    );
    assert_eq!(
        bits_digest, baseline.bits,
        "{} bit-to-source behavior differs from the frozen baseline",
        fixture.name
    );
    eprintln!(
        "provenance_metric fixture={} retained_heap_bytes={} provenance_heap_bytes={} graph_nodes={} source_ranges={} node_query_count={} bit_query_count={} source_map_digest={source_map_digest:016x} exact_digest={} fallback_digest={} nodes_digest={nodes_digest:016x} bits_digest={bits_digest:016x}",
        fixture.name,
        design.estimated_heap_bytes(),
        design.analysis.estimated_source_provenance_heap_bytes(),
        design.graph.nodes.len(),
        design.analysis.source_map().ranges.len(),
        node_ids.len(),
        bits.len(),
        exact_digest.map_or_else(|| "unsupported".to_owned(), |value| format!("{value:016x}")),
        fallback_digest.map_or_else(|| "unsupported".to_owned(), |value| format!("{value:016x}")),
    );

    PreparedFixture {
        name: fixture.name.clone(),
        design,
        exact,
        fallback,
        node_ids,
        bits,
    }
}

fn provenance_benchmarks(criterion: &mut Criterion) {
    let fixtures = load_fixtures();

    let mut construction = criterion.benchmark_group("provenance/construction");
    for fixture in &fixtures {
        construction.bench_with_input(
            BenchmarkId::new("analysis_design", &fixture.name),
            fixture,
            |benchmark, fixture| {
                benchmark.iter_batched(
                    || fixture.files.clone(),
                    |files| black_box(build_design(fixture, files)),
                    BatchSize::SmallInput,
                );
            },
        );
    }
    construction.finish();

    let prepared = fixtures.iter().map(prepare_fixture).collect::<Vec<_>>();

    let mut source_selection = criterion.benchmark_group("provenance/source_selection");
    for fixture in &prepared {
        if fixture.exact.is_some() {
            source_selection.bench_with_input(
                BenchmarkId::new("exact", &fixture.name),
                fixture,
                |benchmark, fixture| {
                    benchmark.iter(|| {
                        black_box(run_selection(
                            &fixture.design,
                            fixture.exact.as_ref().expect("exact workload"),
                        ))
                    });
                },
            );
        }
        if fixture.fallback.is_some() {
            source_selection.bench_with_input(
                BenchmarkId::new("fallback", &fixture.name),
                fixture,
                |benchmark, fixture| {
                    benchmark.iter(|| {
                        black_box(run_selection(
                            &fixture.design,
                            fixture.fallback.as_ref().expect("fallback workload"),
                        ))
                    });
                },
            );
        }
    }
    source_selection.finish();

    let mut node_source = criterion.benchmark_group("provenance/node_to_source");
    for fixture in &prepared {
        for count in [1, fixture.node_ids.len()] {
            let ids = &fixture.node_ids[..count];
            node_source.throughput(Throughput::Elements(count as u64));
            node_source.bench_with_input(
                BenchmarkId::new(format!("batch_{count}"), &fixture.name),
                ids,
                |benchmark, ids| {
                    benchmark.iter(|| {
                        black_box(
                            ids.iter()
                                .map(|id| {
                                    fixture.design.analysis.node_ref(&fixture.design.graph, *id)
                                })
                                .collect::<Vec<_>>(),
                        )
                    });
                },
            );
        }
    }
    node_source.finish();

    let mut bit_source = criterion.benchmark_group("provenance/bit_to_source");
    for fixture in &prepared {
        for count in [1, fixture.bits.len()] {
            let bits = &fixture.bits[..count];
            bit_source.throughput(Throughput::Elements(count as u64));
            bit_source.bench_with_input(
                BenchmarkId::new(format!("batch_{count}"), &fixture.name),
                bits,
                |benchmark, bits| {
                    benchmark
                        .iter(|| black_box(fixture.design.analysis.source_ranges_for_bits(bits)));
                },
            );
        }
    }
    bit_source.finish();
}

criterion_group! {
    name = benches;
    config = Criterion::default()
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(3))
        .sample_size(20);
    targets = provenance_benchmarks
}
criterion_main!(benches);
