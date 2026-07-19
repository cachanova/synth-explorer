#!/usr/bin/env bash
set -euo pipefail

readonly adawebpack_version=24.0.0
readonly adawebpack_archive=adawebpack-24.0.0.tar.gz
readonly adawebpack_sha256=8edaae8b9987a20aec430d750f30033f12f953ce2b6437afb87fbf8cc1063796
readonly adawebpack_url="https://github.com/godunko/adawebpack/releases/download/24.0.0/$adawebpack_archive"
readonly ghdl_commit=37ad91899ea3f311423eb91e34f42c0ae1948f79
readonly ghdl_browser_commit=e98e5a6c6fd6c48a789705ae9900c6b34b3cb414
readonly gcc_commit=ed10445fe222d3973ae13eda9bf211f315c5e3f9

readonly repo=/repo
readonly cache=/cache
readonly output=/output
readonly jobs=${GHDL_WASM_JOBS:-2}
readonly archive="$cache/$adawebpack_archive"
readonly adawebpack="$cache/adawebpack-$adawebpack_version/adawebpack"
readonly ghdl="$cache/ghdl"
readonly ghdl_native="$cache/ghdl-native"
readonly browser="$cache/ghdl-browser"
readonly gcc="$cache/gcc"
readonly build="$cache/build"

mkdir -p "$cache/home" "$build" "$output"

if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 --output "$archive" "$adawebpack_url"
fi
printf '%s  %s\n' "$adawebpack_sha256" "$archive" | sha256sum --check --status
if [[ ! -x "$adawebpack/bin/llvm-gcc" ]]; then
  mkdir -p "$(dirname "$adawebpack")"
  tar --extract --gzip --file "$archive" --directory "$(dirname "$adawebpack")"
fi

clone_at() {
  local url=$1
  local commit=$2
  local destination=$3
  if [[ ! -d "$destination/.git" ]]; then
    git clone --filter=blob:none --no-checkout "$url" "$destination"
  fi
  git -C "$destination" fetch --quiet origin "$commit"
  git -C "$destination" checkout --quiet --detach "$commit"
}

clone_at https://github.com/ghdl/ghdl.git "$ghdl_commit" "$ghdl"
clone_at https://github.com/UnsignedChad/ghdl-browser.git "$ghdl_browser_commit" "$browser"
if [[ ! -d "$gcc/.git" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/gcc-mirror/gcc.git "$gcc"
  git -C "$gcc" sparse-checkout set gcc/ada/libgnat
fi
git -C "$gcc" fetch --quiet origin "$gcc_commit"
git -C "$gcc" checkout --quiet --detach "$gcc_commit"

if [[ ! -x "$ghdl_native/bin/ghdl" ]]; then
  mkdir -p "$build/ghdl-native"
  (
    cd "$build/ghdl-native"
    "$ghdl/configure" --prefix="$ghdl_native"
    make -j"$jobs"
    make install
  )
fi

# ghdl-browser supplies the wasm runtime stubs and frontend compatibility
# patches. Its setup script expects these two vendored trees.
mkdir -p "$browser/vendor/adawebpack-bin" "$browser/vendor"
ln -sfn "$adawebpack" "$browser/vendor/adawebpack-bin/adawebpack"
ln -sfn "$ghdl" "$browser/vendor/ghdl"

# The released toolchain has unversioned wrappers, while gprbuild probes the
# GNAT 14 names embedded in it.
for tool in gcc gnat gnatbind gnatlink gnatls gnatmake gnatchop gnatname gnatprep gnatclean gnatkr; do
  wrapper="$adawebpack/bin/llvm-$tool-14"
  if [[ ! -x "$wrapper" ]]; then
    printf '#!/usr/bin/env bash\nexec "$(dirname "$0")/llvm-%s" "$@"\n' "$tool" > "$wrapper"
    chmod +x "$wrapper"
  fi
done

# Recreate the frontend tree so the checked recipe, rather than stale build
# products, determines every source in the wasm module.
rm -rf "$browser/build/ghdl-wasm-full"
bash "$browser/scripts/setup-frontend-build.sh"
frontend="$browser/build/ghdl-wasm-full"

# Drop the simulation-only WAT backend and Verilog frontend. The product uses
# GHDL only as a VHDL synthesizer and passes its generic Verilog netlist to the
# separately pinned Yosys module.
rm -f "$frontend"/trans*.ad? "$frontend"/translation.ad? "$frontend"/ortho_wasm*.ad?
rm -f "$frontend"/ortho_front.ad? "$frontend"/ortho_nodes.ad?
rm -f "$frontend"/dyn_htables.ad? "$frontend"/synth-verilog_*.ad?
rm -f "$frontend"/ghdlsynth.ad? "$frontend"/ghdlsynth_maybe.ad?
rm -f "$frontend"/libghdl.ad? "$frontend"/ortho_ident.ad?

cp "$ghdl/src/synth/synthesis.ads" "$ghdl/src/synth/synthesis.adb" "$frontend/"
sed -i '/with Synth\.Verilog_Insts;/d;/Synth\.Verilog_Insts\.Synth_All_Instances;/d' "$frontend/synthesis.adb"

for unit in \
  grt-types.ads grt-c.ads grt-vhdl_types.ads grt-stdio.ads grt-severity.ads \
  grt-fcvt.ads grt-fcvt.adb grt-to_strings.ads grt-to_strings.adb \
  grt-files.ads grt-files.adb grt-files_operations.ads grt-files_operations.adb \
  grt-table.ads grt-table.adb grt-arith.ads grt-arith.adb \
  grt-algos.ads grt-algos.adb grt-astdio.ads grt-astdio.adb \
  grt-strings.ads grt-strings.adb grt-vstrings.ads grt-vstrings.adb \
  grt-rstrings.ads grt-rstrings.adb grt-dynload.ads; do
  cp "$ghdl/src/grt/$unit" "$frontend/"
done
cp "$ghdl/src/grt/grt-readline_none.ads" "$ghdl/src/grt/grt-readline_none.adb" "$frontend/"
cp "$build/ghdl-native/grt-readline.ads" "$frontend/"
patch --directory "$frontend" --strip=0 < "$repo/tools/ghdl-wasm/grt-stdio.patch"
patch --directory "$frontend" --strip=0 < "$repo/tools/ghdl-wasm/blackbox-verilog.patch"
cp "$repo/tools/ghdl-wasm/grt-stdio.adb" "$frontend/"

libgnat="$gcc/gcc/ada/libgnat"
runtime_source_units=(
  a-chahan.ads a-chahan.adb a-chlat1.ads a-strmap.ads a-strmap.adb a-stmaco.ads \
  s-bitops.ads s-bitops.adb s-bytswa.ads s-imglli.ads s-imglli.adb s-vs_lli.ads \
  s-vallli.ads s-vallli.adb s-valllli.ads s-vallllu.ads s-valllf.ads \
  g-sechas.ads g-sechas.adb g-sehash.ads g-sehash.adb \
  g-sha1.ads g-sha1.adb g-bytswa.ads g-bytswa.adb g-hesora.ads g-hesora.adb
)
for unit in "${runtime_source_units[@]}"; do
  cp "$libgnat/$unit" "$adawebpack/lib/rts-native/adainclude/"
done
sed -i '/function Swap128/,/end Swap128;/d' "$adawebpack/lib/rts-native/adainclude/g-bytswa.adb"
sed -i '/function Swap128/d' "$adawebpack/lib/rts-native/adainclude/g-bytswa.ads"
sed -i '/subtype U128/d;/function Bswap_128/d;/__builtin_bswap128/d' \
  "$adawebpack/lib/rts-native/adainclude/s-bytswa.ads"

cp "$repo/tools/ghdl-wasm/bug.adb" "$frontend/"
cp "$repo/tools/ghdl-wasm/synth_api.ads" "$repo/tools/ghdl-wasm/synth_api.adb" "$frontend/"

export PATH="$adawebpack/bin:/usr/lib/llvm-16/bin:/usr/local/bin:/usr/bin:/bin"
export GPR_PROJECT_PATH="$adawebpack/lib/gnat"

# The released AdaWebPack archive includes sources but not wasm objects for
# its browser runtime stubs. Compile an overlay before GHDL so both the
# compiler and binder see ALIs that match those sources.
stub_objects="$frontend/.objs/stubali"
mkdir -p "$stub_objects"
runtime_compile_units=(
  i-c i-cstrea gnat a-calend a-catizo a-comlin a-strunb g-dirope g-os_lib
  a-chahan a-chlat1 a-strmap a-stmaco s-bitops s-bytswa s-imglli s-vs_lli
  s-vallli g-sechas g-sehash g-sha1 g-bytswa g-hesora
)
(
  cd "$stub_objects"
  for unit in "${runtime_compile_units[@]}"; do
    source="$adawebpack/lib/rts-native/adainclude/$unit.ads"
    if [[ -f "$adawebpack/lib/rts-native/adainclude/$unit.adb" ]]; then
      source="$adawebpack/lib/rts-native/adainclude/$unit.adb"
    fi
    llvm-gcc -c --target=wasm32 -O1 \
      -gnatg -gnatyN -gnatws -I"$adawebpack/lib/rts-native/adainclude" "$source"
  done
)

cat > "$frontend/ghdl_wasm.gpr" <<EOF
with "adawebpack_config.gpr";

project Ghdl_Wasm is
   for Target use "llvm";
   for Source_Dirs use (".");
   for Object_Dir use ".objs";
   for Library_Name use "ghdl_wasm";
   for Library_Dir use "lib";
   for Library_Kind use "static";

   package Compiler is
      for Switches ("Ada") use
        ("--target=wasm32", "-O1", "-I$stub_objects");
   end Compiler;
end Ghdl_Wasm;
EOF

(
  cd "$frontend"
  gprbuild -p -P ghdl_wasm.gpr -j"$jobs"
)

mapfile -t ali_files < <(find "$frontend/.objs" -maxdepth 1 -name '*.ali' -print | sort)
(
  cd "$frontend/.objs"
  llvm-gnatbind -n -Lghdlwasm_ -o b_ghdlwasm.adb \
    -aO"$stub_objects" "${ali_files[@]}"
  llvm-gcc -c --target=wasm32 -O1 -gnatg -gnatyN -gnatws \
    -I"$adawebpack/lib/rts-native/adainclude" \
    -I"$stub_objects" \
    -I"$adawebpack/lib/rts-native/adalib" \
    b_ghdlwasm.adb
)

gnat_objects="$build/libgnat-wasm-objs"
rm -rf "$gnat_objects"
mkdir -p "$gnat_objects"
(
  cd "$gnat_objects"
  llvm-ar x "$adawebpack/lib/rts-native/adalib/libgnat.a"
  for object in *.o; do
    file "$object" | grep -q WebAssembly || rm -f "$object"
  done
  llvm-ar rcs libgnat_wasm.a ./*.o
)

extra_objects=()
while IFS= read -r object; do
  if file "$object" | grep -q WebAssembly; then
    extra_objects+=("$object")
  fi
done < <(find "$stub_objects" -name '*.o' ! -name 'g-os_lib.o' -print | sort)
clang-16 --target=wasm32 -nostdlib \
  -Wl,--no-entry -Wl,--allow-undefined -Wl,--export-memory \
  -Wl,--export=malloc -Wl,--export=free -Wl,--export=__wasm_call_ctors \
  -Wl,--export=ghdlwasm_init \
  -Wl,--export=synth_api__synth_init \
  -Wl,--export=synth_api__analyze_file \
  -Wl,--export=synth_api__synth_top \
  -Wl,--whole-archive \
    "$frontend/lib/libghdl_wasm.a" \
    "$gnat_objects/libgnat_wasm.a" \
  -Wl,--no-whole-archive \
  "${extra_objects[@]}" \
  "$frontend/.objs/b_ghdlwasm.o" \
  -o "$build/ghdl-synth.unstripped.wasm"

llvm-strip-16 --strip-all -o "$output/ghdl-synth.wasm" "$build/ghdl-synth.unstripped.wasm"
tar --create --gzip --file "$output/libraries.tar.gz" \
  --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
  --directory "$ghdl_native/lib/ghdl" .
(
  cd "$output"
  sha256sum ghdl-synth.wasm libraries.tar.gz > SHA256SUMS
)

printf 'GHDL %s / AdaWebPack %s / ghdl-browser %s\n' \
  "$ghdl_commit" "$adawebpack_version" "$ghdl_browser_commit"
du -h "$output/ghdl-synth.wasm" "$output/libraries.tar.gz"
