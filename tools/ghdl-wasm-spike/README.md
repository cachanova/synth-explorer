# GHDL-on-WASM spikes: A (synth kernel) and B1 (two-module pipeline) — both PASSED

Two sequential spikes executed 2026-07-19. Spike A proved GHDL's synthesis
kernel runs under wasm32 (details below). Spike B1 then proved the
two-module integration shape end to end: **VHDL provenance through the
project's real pinned `yosys.wasm` is equivalent to native Verilog input.**
See "Spike B1" at the bottom.


Executed 2026-07-19 against GHDL 5.0.1. This is the first spike from
[`docs/VHDL_GHDL_FEASIBILITY.md`](../../docs/VHDL_GHDL_FEASIBILITY.md):
prove that GHDL's synthesis kernel (`--synth`, the code path the
ghdl-yosys-plugin calls) runs under wasm32 with the AdaWebPack Ada runtime,
before investing in any Yosys integration.

## Result

**The synthesis kernel works in WebAssembly.** A 3.1 MB (unstripped)
`ghdl-synth.wasm` driven from Node.js analyzes VHDL, elaborates, synthesizes,
and emits a Verilog netlist that is byte-identical to native
`ghdl --synth --out=verilog` output (modulo file-path prefixes):

| Test | Content | Outcome |
| --- | --- | --- |
| `tests/and_gate.vhdl` | plain `std_logic_1164` | netlist identical to native |
| `tests/adder8.vhdl` | **`numeric_std`** `a + b`, clocked register | netlist identical to native |
| `tests/counter.vhdl` | **generic** width + `numeric_std` + sync reset/enable | netlist identical to native |
| `tests/syntax_error.vhdl` | parse error | clean `rc=-1` + diagnostic, no trap |
| `tests/sem_error.vhdl` | undefined signal | clean `rc=-1` + diagnostic, no trap |

A full run (instantiate + load `std`/`ieee` + analyze + synthesize + emit)
takes **~0.17 s** in Node on this container. The emitted Verilog carries
source locations as comments (`/* adder8.vhdl:18:14 */`) — VHDL-line
provenance survives synthesis.

Notable: `IEEE.NUMERIC_STD` works. The upstream ghdl-browser project's
numeric_std crashes are in its WAT *codegen* backend (simulation path),
which the synthesis path never touches. Its README's known issues largely
do not apply to synthesis.

## The two failure modes found, and their fixes

Both were systemic, not kernel bugs — this is the spike's key learning:

1. **No package elaboration.** ghdl-browser links with `--export-all` and
   never runs `gnatbind`, so Ada package elaboration never executes and
   statically-zeroed tables crash (they papered over one instance with a
   "self-healing Dyn_Tables" patch). First synthesis attempt died in
   `Netlists.Builders.Build_Builders` for exactly this reason. Fix: run
   `llvm-gnatbind -n -Lghdlwasm_` over the build's ALI files, compile the
   generated `b_ghdlwasm.adb`, link it in, and call the exported
   `ghdlwasm_init` from JS before anything else. This is the correct
   general fix and likely cures several of ghdl-browser's flaky behaviors.
2. **Null error-report handler.** Any diagnostic (bad input) trapped in the
   last-chance handler before printing, because no `Errorout` report
   handler was installed. Fix: `Errorout.Console.Install_Handler` in
   `synth_api__synth_init` — diagnostics then flow out through the host's
   stdio imports and errors return negative codes instead of trapping.
   This matters enormously for an interactive editor, which feeds the
   frontend malformed input on most keystrokes.

## What was built (recipe)

Everything came from source; no prebuilt toolchain downloads were needed.

1. **Ada→wasm32 compiler** (~15 min build): GNAT-LLVM at AdaCore commit
   `66e36d92` + gcc 14.1.0 Ada frontend sources + LLVM 16 (apt
   `llvm-16-dev libclang-16-dev`) + host `gnat` 13 + `gprbuild`, with
   AdaWebPack 24.0.0's patches and wasm32 RTL recipe
   (`make wasm` per its `.github/workflows/build.yml`, using
   Fabien-Chouteau/bb-runtimes branch `gnat-fsf-14`).
2. **GHDL sources**: `ghdl/ghdl` tag `v5.0.1`. A native mcode build
   (host GNAT) provides the analyzed `std`/`ieee` library tree
   (`lib/ghdl/`, ~7 MB) that the wasm module reads through its virtual
   filesystem.
3. **Build tree**: UnsignedChad/ghdl-browser's `setup-frontend-build.sh`
   (GHDL sources + their runtime stubs), then this spike's surgery:
   - removed: their WAT-codegen overlay (`trans-*`, `ortho_wasm*`,
     `translation`), the (broken-in-5.0.1) `dyn_htables`, the `Verilog.*`
     frontend-dependent `synth-verilog_*` units, driver stubs
     `ghdlsynth.adb`/`ghdlsynth_maybe.ads`;
   - restored: the real `synthesis.ads/adb` (with `Synth.Verilog_Insts`
     references stubbed out — VHDL-only);
   - added: ~16 `Grt.*` runtime units from `src/grt` (types, stdio,
     severity, fcvt, to_strings, files, files_operations, table, arith,
     algos, astdio, strings, vstrings, rstrings, dynload spec,
     `grt-readline_none` renamed to `Grt.Readline`), [`bug.adb`](bug.adb)
     stub (crash box needs `Ada.Exceptions` introspection AdaWebPack
     lacks), and ~15 pure RTL units copied from gcc 14.1 `libgnat`
     (`a-chlat1`, `a-strmap`, `a-stmaco`, `s-bitops`, `s-imglli`,
     `s-vs_lli`, `g-sha1` chain, `g-bytswa` with the 128-bit intrinsics
     deleted — wasm32 has no `Unsigned_128`);
   - [`synth_api.ads`](synth_api.ads)/[`synth_api.adb`](synth_api.adb):
     ~90-line wrapper exporting `synth_api__synth_init` /
     `synth_api__synth_top`, modeled on `ghdldrv/ghdlsynth.adb`'s
     configure→elab→synth→disp sequence minus the CLI driver.
4. **Bind + link**: `gprbuild` library project (194 objects) →
   `llvm-gnatbind -n` → single `wasm-ld` link with `--export-all
   --allow-undefined` ([`link-synth.sh`](link-synth.sh)). 46 imports
   remain, all satisfied by the ~150-line JS shim in
   [`ghdl_synth_test.mjs`](ghdl_synth_test.mjs) (C stdio to a virtual FS,
   `gnat__os_lib__*` file probes, math builtins).

Run: `node ghdl_synth_test.mjs <ghdl-synth.wasm> <lib/ghdl dir> <top> <files...>`

## Implications for Synth Explorer

- **Spike B (single-module link into our WASI yosys.wasm) is no longer the
  only path.** This module uses plain `env` imports (no libc, no WASI), so
  a **two-module pipeline** is now a credible alternative: a
  `ghdl.worker.ts` synthesizes VHDL to a Verilog netlist, which feeds the
  existing pinned `yosys.wasm` via `read_verilog` — zero changes to the
  Yosys build. Cost: provenance arrives as `/* file:line:col */` comments
  in generated Verilog rather than native `src` attributes, so either a
  small post-processor turns them into `(* src = "..." *)` attributes, or
  the source-mapping feature degrades for VHDL designs. The netlist is
  also pre-synthesized generic logic, so Yosys optimizes it rather than
  seeing original RTL idioms.
- The artifact cost is modest: ~3 MB module (unstripped, `--export-all`;
  an export-list + strip build would shrink it) + ~2 MB gzipped library
  tree, against today's 30 MB `yosys.wasm`.
- The toolchain is heavy but fully pinnable: five source repos, apt LLVM 16,
  host GNAT 13 — all reproducible without network access to GitHub
  releases.

## Caveats / not yet done

- VHDL-2008 (`--std=08`) not exercised — the spike ran the default 93c
  std; `Set_Option`-equivalent flag plumbing is still to be wired.
- Multi-file designs, packages, and instantiation hierarchies untested
  (single-file entities only).
- The analyze-stage diagnostics for files that parse with errors but
  still return a design unit are captured but not yet surfaced by the
  test host.
- `pragma Suppress (All_Checks)` is inherited from the ghdl-browser
  recipe on `libghdl.adb`/`synth_api.adb` only; the rest of the kernel
  runs with checks on, and no check-related traps were observed.
- Memory behavior on large designs unmeasured (memory grown to 64 MB up
  front in the host).

## Spike B1: two-module pipeline — PASSED

[`b1_pipeline.mjs`](b1_pipeline.mjs) runs the full chain with the
**project's pinned `yosys.wasm` + `share.tar.gz`** (via Node's WASI):

```
VHDL --ghdl-synth.wasm--> Verilog netlist with /* file:line:col */ comments
     --line_directives.mjs--> Verilog with `line directives
     --yosys.wasm--> source-netlist.json + netlist.json  (app's script shape)
```

The provenance mechanism is [`line_directives.mjs`](line_directives.mjs):
GHDL's location comments become Verilog `` `line `` directives, which
`read_verilog` honors — so cells get **native** yosys `src` attributes
pointing at the VHDL file and line (`fsm.vhdl:33.18-33.35`), in exactly the
format `web/src/lib/src.ts` already parses, including `|`-joined
multi-fragment spans for case-derived muxes. (Attribute injection
`(* src = ... *)` was tried first and rejected: the Verilog-2005 grammar
does not allow attributes on continuous assigns.)

Measured on the test designs, against a hand-written native-Verilog
baseline run through the identical script:

| Design | source-netlist cells with VHDL src | gates netlist |
| --- | --- | --- |
| `counter.vhdl` | **4/4 (100%)** — add/mux/dff at their VHDL lines | 12/34 — all FFs anchored |
| `counter` native Verilog baseline | 4/4 (100%) | 12/34 — identical |
| `fsm.vhdl` | **21/21 (100%)** — per-case-arm lines (27, 28, 29, 32, …) | 10/45 — FFs anchored |
| `adder8.vhdl` | 2/2 (100%) | 8/42 — FFs anchored |

Combinational cells losing `src` after `synth -flatten` (ABC) is identical
behavior to native Verilog input — the app already compensates via the
source netlist. Full pipeline wall time (three cold Node processes + tar
unpack): ~1.2 s; both wasm stages together are well under the app's
interactive budget once workers are warm.

Known gaps for productization:

- Port/wire declarations precede the first `` `line `` directive, so port
  wires keep generated-file locations (port *names* still match the VHDL
  entity). Emitting a directive for the entity line would need GHDL to
  annotate the module header — or a small GHDL patch.
- Column spans in the resulting attributes come from the generated
  Verilog's layout; lines are exact, columns are not meaningful.
- Yosys re-synthesizes GHDL's already-generic netlist. For gates/FPGA
  modes that is the desired behavior anyway; the "rtl" view will show
  GHDL's netlist structure rather than original VHDL idioms.
- Multi-file designs, packages, VHDL-2008 flags, and mixed VHDL+Verilog
  remain untested.

**Recommendation:** adopt the two-module shape (B1). It requires zero
changes to the pinned Yosys build, keeps the GHDL module small and
independently versioned, and delivers provenance equal to native Verilog.
The original single-module link (B2) is now only worth attempting if a
future requirement (e.g. mixed-language hierarchy resolution inside one
`hierarchy` pass) demands it.

Productization checklist (next PR-sized steps):

1. Reproducible `tools/ghdl-wasm/` build (pin the five source repos + apt
   LLVM 16, strip with an export list, emit `SHA256SUMS`), publishing
   `ghdl-synth.wasm` + a packed `lib/ghdl` tree.
2. `ghdl.worker.ts` mirroring `yosys.worker.ts` (env-import shim instead
   of WASI), producing translated Verilog + diagnostics.
3. Pipeline changes: accept `.vhd`/`.vhdl` filenames, insert the translate
   stage before the existing untouched Yosys flow, include the GHDL
   artifact version in the design cache key, add the CodeMirror VHDL mode,
   and require an explicit top for VHDL (GHDL has no `-auto-top`).
