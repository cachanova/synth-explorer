#!/usr/bin/env bash
# Link the synth-enabled libghdl wasm library with the from-source AdaWebPack
# runtime into ghdl-synth.wasm. Adapted from link-wasm.sh (which assumed the
# prebuilt AdaWebPack and clang/lld-21; we use the LLVM 16 apt toolchain).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$REPO/build"
ADAWP="$REPO/vendor/adawebpack-bin/adawebpack"
ADAINC="$ADAWP/lib/rts-native/adainclude"
export PATH="$ADAWP/bin:/usr/lib/llvm-16/bin:/usr/local/bin:/usr/bin:/bin"

# Runtime-stub objects were compiled next to their ALIs for gnatbind (see
# the bind step); link all of them except g-os_lib.o, whose stub body would
# shadow the JS host's gnat__os_lib__* imports and break library lookup.
STUBALI="$BUILD/ghdl-wasm-full/.objs/stubali"
EXTRA_OBJS=$(ls "$STUBALI"/*.o | grep -v 'g-os_lib\.o')

# Filter libgnat.a to wasm-valid objects (a few members are native/bitcode).
GNATTMP="$BUILD/libgnat-wasm-objs"
rm -rf "$GNATTMP"; mkdir -p "$GNATTMP"
pushd "$GNATTMP" > /dev/null
llvm-ar x "$ADAWP/lib/rts-native/adalib/libgnat.a"
for f in *.o; do
  file "$f" 2>/dev/null | grep -q 'WebAssembly' || rm -f "$f"
done
llvm-ar rcs libgnat_wasm.a *.o
popd > /dev/null

mkdir -p "$BUILD/link-wasm"
clang --target=wasm32 \
  -nostdlib \
  -Wl,--no-entry -Wl,--export-all -Wl,--allow-undefined \
  -Wl,--whole-archive \
    "$BUILD/ghdl-wasm-full/lib/libghdl_wasm.a" \
    "$GNATTMP/libgnat_wasm.a" \
  -Wl,--no-whole-archive \
  $EXTRA_OBJS \
  "$BUILD/ghdl-wasm-full/.objs/b_ghdlwasm.o" \
  -o "$BUILD/link-wasm/ghdl-synth.wasm"

ls -lh "$BUILD/link-wasm/ghdl-synth.wasm"
