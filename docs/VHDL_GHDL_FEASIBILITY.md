# VHDL support via the GHDL Yosys plugin: feasibility

Status: investigation, July 2026. No implementation decision has been made.

Synth Explorer synthesizes entirely in the browser with a project-owned Yosys
WebAssembly module (`tools/yosys-wasm/`). Supporting VHDL through
[ghdl-yosys-plugin](https://github.com/ghdl/ghdl-yosys-plugin) is therefore not
primarily a Yosys-scripting question but a WebAssembly toolchain question:
can GHDL, a large Ada program, be compiled into (or next to) our
`yosys.wasm`? This document records what the plugin needs, the current state
of GHDL-on-WASM, the integration surface inside this repository, and a
recommended path.

## How the plugin works natively

- ghdl-yosys-plugin is a thin C++ shim, normally built as a Yosys plugin
  shared object (`ghdl.so`) that dynamically links `libghdl`, GHDL's
  library form. The plugin registers a `ghdl` Yosys command that analyzes and
  elaborates VHDL sources and emits RTLIL.
- `libghdl` and the synthesis kernel are default-on GHDL configure options
  (`--enable-libghdl`, `--enable-synth`, both default since v0.37).
- Synthesis is implemented in GHDL's front end and is independent of the
  code-generation backend (mcode/LLVM/GCC). A WASM port would not need the
  JIT machinery — only analysis, elaboration, and the synth kernel.
- Building the plugin sources directly into the Yosys binary (static, no
  `dlopen`) is supported upstream, though documented as "not recommended".
  For WASI it is mandatory: WASI Preview 1 has no dynamic linking.

## State of GHDL on WebAssembly (checked 2026-07-18)

- GHDL is written in Ada. The only viable compiler route is
  GNAT-LLVM targeting wasm32, packaged today as
  [AdaWebPack](https://github.com/godunko/adawebpack) (active; release
  14.0.0, Feb 2025). Its runtime has hard limitations relevant to GHDL:
  no tasks, limited exception propagation, no nested subprograms.
- The first public proof that GHDL compiles and runs under wasm32 appeared in
  May–June 2026: [UnsignedChad/ghdl-browser](https://github.com/UnsignedChad/ghdl-browser)
  builds patched GHDL 5.0.1 with GNAT-LLVM + AdaWebPack into a ~4.5 MB
  `ghdl.wasm` exposing the libghdl API to JavaScript. It targets simulation,
  not the Yosys plugin; `IEEE.NUMERIC_STD` designs crash; the required
  patches are not upstream. It is a one-person experimental project.
- No public build of Yosys with the GHDL plugin exists for WASM anywhere.
  YoWASP ships Yosys without GHDL and has never packaged GHDL
  (2020–2026). GHDL upstream has no open WebAssembly work.
- The commercial alternative frontend (Verific, `verific -vhdl`) is licensed
  through Tabby CAD only and cannot be redistributed in a public browser
  bundle; it is a non-starter for this product.

## Why a yosys.wasm + libghdl link is hard today

Even taking ghdl-browser as an existence proof, our build combines badly with
it:

1. **Two toolchains, one module.** Our Yosys is compiled by WASI SDK 33
   (clang, `wasm32-wasip1`, wasi-libc, native WebAssembly exceptions).
   AdaWebPack objects are produced by GNAT-LLVM against its own minimal Ada
   runtime, not wasi-libc. Linking both into one module means reconciling
   libc symbols, startup/ctor ordering, and the exception ABI. GNAT-LLVM's
   exception support is limited, while GHDL uses Ada exceptions for error
   recovery on malformed input — exactly the input an interactive editor
   produces continuously.
2. **Static plugin registration.** No `dlopen` under WASI, so the plugin's
   `Yosys::Pass` registration must be compiled into the main binary and the
   CMake component build (`YOSYS_COMPONENTS`) extended with an out-of-tree
   source set plus the libghdl archive.
3. **Synthesis kernel unproven on wasm.** ghdl-browser exercises analysis,
   elaboration, and its own WAT codegen; whether `--synth` (the code the
   plugin calls) survives the AdaWebPack runtime restrictions is unknown.
4. **Standard libraries in the VFS.** libghdl needs pre-analyzed `std` and
   `ieee` libraries on the (virtual) filesystem. These must be produced at
   build time by a native GHDL of the same version and shipped in
   `share.tar.gz`, growing it by several MB.
5. **Size and pinning.** `yosys.wasm` is ~30 MB today; libghdl adds an
   estimated 5–10 MB plus the analyzed libraries. The build would newly pin
   GNAT-LLVM, AdaWebPack, GHDL, and a patch stack on top of the existing
   Yosys/ABC/WASI-SDK pins, and the patch stack currently lives in an
   unreviewed personal fork.

None of these is provably impossible; every one is unowned engineering with
no prior art for the combination.

## Integration surface in this repository

If a `yosys.wasm` with a built-in `ghdl` command existed, the product changes
are modest and well-localized:

- `web/src/lib/yosysScript.ts` — accept `.vhd`/`.vhdl` filenames, and emit
  `ghdl --std=08 <files> -e <top>` instead of (or alongside) `read_verilog
  -sv`. Mixed Verilog + VHDL designs fall out naturally, since both
  frontends just populate modules before `hierarchy`. Open question: the
  plugin has no `-auto-top` equivalent, so VHDL designs likely require an
  explicit top (or we resolve one after analysis); the optional-top UI
  contract needs a decision here.
- `web/src/lib/src.ts` — GHDL emits `src` attributes as `file:line`;
  the parser already accepts line-only spans, but provenance fidelity
  (`source-netlist.json`, source-selection projection, per-line mapping)
  must be validated against real GHDL output, which is sparser than
  `read_verilog`'s.
- `web/src/components/Editor.tsx` — CodeMirror `@codemirror/legacy-modes`
  ships a VHDL mode next to the Verilog mode already in use.
- `web/src/lib/yosysScript.ts` cache constants — new artifact means bumping
  `YOSYS_VERSION`/`YOSYS_CACHE_SCHEMA` so stale IndexedDB entries are
  invalidated.
- Examples, filename validation messages, README/architecture docs, and
  calibration script rendering pick up the new language mechanically.

## Alternatives considered

- **vhd2vl (VHDL→Verilog translation) in WASM.** vhd2vl is plain
  C/flex/bison and would compile to WASM trivially, giving a quick
  "VHDL in the browser" demo. Rejected as *the* VHDL story: it handles only
  a narrow VHDL-93 subset (no functions, procedures, or packages — which
  excludes most `numeric_std`-based real code), is essentially dormant
  upstream, and destroys source provenance, the product's core interaction
  (all `src` attributes would point at generated Verilog). It could at most
  become an explicit, honest *import* feature that converts VHDL into
  editable Verilog shown to the user, with the translation as the source of
  truth.
- **Server-side GHDL.** Contradicts the product's architecture and privacy
  claim ("RTL is not uploaded to an application server"); rejected.

## Recommendation

Do not commit to shipping GHDL-based VHDL support yet. The product-side work
is small, but the toolchain work is a research project whose critical path
(GNAT-LLVM + AdaWebPack objects linked into a WASI-SDK Yosys, synth kernel
running under a restricted Ada runtime) has no prior art and depends on an
experimental, unupstreamed patch stack.

If VHDL demand justifies investment, sequence it as spikes with cheap exits:

1. **Spike A — synth kernel on wasm32.** Build libghdl per the ghdl-browser
   recipe and drive `--synth` (not simulation) on `numeric_std`-using
   designs from JS. This tests the riskiest unknown first, with no Yosys
   involvement.
2. **Spike B — single-module link.** Statically link that libghdl plus the
   plugin shim into the existing `tools/yosys-wasm` build; run
   `ghdl ... -e top; write_json` end to end under the browser WASI shim.
3. **Productize** only after both spikes pass: extend `build.sh` pins,
   ship analyzed `std`/`ieee` in `share.tar.gz`, then make the frontend
   changes listed above behind the existing mode/flag machinery.

Track upstream in the meantime: AdaWebPack releases, any upstreaming of the
ghdl-browser wasm patches into ghdl/ghdl, and any appearance of a packaged
GHDL WASM build (e.g. from the former-YoWASP/Codeberg ecosystem) — any of
these materially shortens spikes A and B.
