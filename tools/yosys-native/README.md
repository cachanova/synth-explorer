# Pinned native Yosys for calibration

The browser and calibration must synthesize with the same Yosys revision.
Build the exact native counterpart of the project-owned WebAssembly artifact:

```bash
tools/yosys-native/build.sh
export SYNTH_EXPLORER_YOSYS="$PWD/.cache/yosys-native/build/yosys"
```

The build pins Yosys 0.67 commit `2d1509d1b` and its matching ABC submodule,
then refuses an unexpected version. The cache is local and ignored by Git.
`SYNTH_EXPLORER_YOSYS` is honored by both the Rust estimator and the Vivado
matrix collector; neither falls back after an explicitly configured binary
fails.
