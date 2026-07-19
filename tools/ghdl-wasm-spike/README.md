# Spike A: GHDL synthesis kernel on wasm32 — PASSED

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

## Suggested next step (revised Spike B)

Evaluate the two integration shapes against each other before any linking
work:

- **B1 — two modules**: prototype `ghdl.worker.ts` + comment-to-`(* src *)`
  rewriting, feed `yosys.wasm`, and check end-to-end source mapping
  quality in the real product pipeline.
- **B2 — one module**: only if B1's provenance or double-synthesis cost
  disappoints, attempt statically linking libghdl + the ghdl-yosys-plugin
  shim into the WASI-SDK Yosys build (the original Spike B; harder:
  two toolchains, one memory, one libc).
