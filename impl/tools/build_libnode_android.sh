#!/usr/bin/env bash
# Rebuilds libnode.so for Android arm64 with 16 KB page alignment.
#
# Why this exists: the prebuilt libnode.so from nodejs-mobile v18.20.4 is linked
# with p_align = 0x1000 (4 KB). Google Play requires 16 KB support since Nov
# 2025, and on a 16 KB-page device the loader rejects an ELF whose LOAD segments
# are aligned for 4 KB. There is no post-processing fix — p_align cannot be
# patched after the fact, because the segments' file offsets and virtual
# addresses would no longer be congruent modulo 16 KB. The only fix is to relink.
#
# Usage:
#   ./build_libnode_android.sh <ndk-dir> <source-dir-or-tarball> [options]
#
# Options:
#   --api <n>     Android API level (default 24)
#   --jobs <n>    parallelism (default: nproc)
#   --clean       wipe out/ and android-toolchain/ first (full rebuild)
#   --configure   force ./android-configure even if out/ looks configured
#   --verify      only check an existing out_android/arm64-v8a/libnode.so
#
# Why resume is the default: a full node+v8 cross build is ~40 min on 16 cores
# and nodejs-mobile's own android_build.sh starts with `make clean`, so any
# interruption (sandbox hibernation, a typo, one bad flag) throws away every
# object file. This wrapper only pays that cost once and then reuses out/.
#
# Output: out_android/arm64-v8a/libnode.so  (verified below)
set -euo pipefail

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

[ $# -ge 2 ] || usage
NDK=$1; SRC=$2; shift 2
API=24
JOBS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8)
MODE=resume

while [ $# -gt 0 ]; do
  case $1 in
    --api) API=$2; shift 2 ;;
    --jobs) JOBS=$2; shift 2 ;;
    --clean) MODE=clean; shift ;;
    --configure) MODE=configure; shift ;;
    --verify) MODE=verify; shift ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

NDK=$(cd "$NDK" 2>/dev/null && pwd) || { echo "ndk not found: $1" >&2; exit 1; }
WORK=${WORK:-/tmp/libnode-build}
READELF="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf"

# --------------------------------------------------------------- flatten ----
# A tarball is unpacked once into $WORK/src and then reused, so a --clean
# rebuild does not re-extract 100+ MB.
if [ -d "$SRC" ]; then
  SRC_DIR=$(cd "$SRC" && pwd)
elif [ -f "$SRC" ]; then
  SRC_DIR="$WORK/src"
  if [ ! -f "$SRC_DIR/.unpacked" ]; then
    echo "== unpacking $(basename "$SRC") -> $SRC_DIR"
    rm -rf "$SRC_DIR"; mkdir -p "$SRC_DIR"
    tar xzf "$SRC" -C "$SRC_DIR" --strip-components=1
    touch "$SRC_DIR/.unpacked"
  fi
else
  echo "source not found: $SRC" >&2; exit 1
fi
cd "$SRC_DIR"

# ---------------------------------------------------------------- verify ----
verify() {
  local so=$1
  [ -f "$so" ] || { echo "missing: $so" >&2; return 1; }
  echo "== $so ($(du -h "$so" | cut -f1))"
  echo "== LOAD segments:"
  "$READELF" -lW "$so" | awk '/LOAD/ {printf "   %s\n", $0}'
  local aligns
  aligns=$("$READELF" -lW "$so" | awk '/LOAD/ {print $NF}' | sort -u | tr '\n' ' ')
  echo "== aligns: $aligns"
  case "$aligns" in
    *0x4000*) echo "== OK: 16 KB aligned" ;;
    *) echo "== FAIL: not 16 KB aligned" >&2; return 2 ;;
  esac
}

if [ "$MODE" = verify ]; then
  verify out_android/arm64-v8a/libnode.so
  exit $?
fi

# ------------------------------------------------------------ 16 KB flags ----
# Two independent carriers, deliberately redundant:
#   * common.gypi patches the android/target ldflags (survives regeneration),
#   * LDFLAGS here covers anything gyp links without those ldflags.
# Both flags are required: max-page-size drives p_align, common-page-size keeps
# segment file offsets congruent with their virtual addresses.
# -soname: bionic 按 SONAME 匹配已加载实例（NAPI addon 以 DT_NEEDED libnode.so
# 复用进程内 libnode，见 tools/build-require-builtin-android.sh）。没有它就得
# 事后 patchelf，重建时容易漏。
export LDFLAGS="-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384 -Wl,-soname,libnode.so"

# intl 必须 != none：nodejs-mobile 的 android_configure 原本硬编码
# --with-intl=none，无 ICU 的 V8 不认 Unicode property escapes（\p{...}），
# dsh 的 24 个插件全部 import 失败（实测）。默认 small-icu
# （deps/icu-small 随源码带全，Unicode 属性表完整，仅 locale 裁剪为 en）；
# 要中文 Intl 格式化时改 NODE_ANDROID_INTL=full-icu（APK +~28MB）。
if grep -q 'with-intl=none' android_configure.py 2>/dev/null; then
  echo "== patching android_configure.py: --with-intl=none -> env NODE_ANDROID_INTL (default small-icu)"
  sed -i 's|--with-intl=none|--with-intl='"'"' + os.environ.get("NODE_ANDROID_INTL", "small-icu") + '"'"'|' android_configure.py
fi

if [ "$MODE" = clean ]; then
  echo "== clean: removing out/ and android-toolchain/"
  make clean >/dev/null 2>&1 || true
  rm -rf out android-toolchain
fi

CONFIGURED=no
if [ -f out/Makefile ] && grep -q 'OS.: .android' config.gypi 2>/dev/null; then
  CONFIGURED=yes
fi

# android-configure cannot be re-run over an existing tree: it re-links the
# toolchain dir and regenerates config.gypi, but gyp only rewrites out/Makefile
# when --depth matches the previous invocation exactly.
if [ "$CONFIGURED" = no ] || [ "$MODE" = configure ]; then
  echo "== configuring (NDK $NDK, API $API, arm64)"
  rm -rf android-toolchain
  ./android-configure "$NDK" "$API" arm64
else
  echo "== reusing existing configuration in out/ (pass --clean for a full rebuild)"
fi

# Confirm the alignment flags actually reached the generated link rule. Silent
# success here is what makes a 4 KB artifact look fine until a device refuses it.
missing=0
for f in out/libnode.target.mk; do
  for flag in max-page-size=16384 common-page-size=16384; do
    grep -q "$flag" "$f" || { echo "  WARN  $flag absent from $f" >&2; missing=1; }
  done
done
[ "$missing" = 0 ] && echo "== link flags present in out/libnode.target.mk"

# --------------------------------------------------------------- compile ----
echo "== make -j$JOBS"
make -j"$JOBS"

# ---------------------------------------------------------------- collect ---
for cand in out/Release/lib.target/libnode.so out/Release/obj.target/libnode.so; do
  if [ -f "$cand" ]; then
    mkdir -p out_android/arm64-v8a
    cp "$cand" out_android/arm64-v8a/libnode.so
    break
  fi
done

# 剥掉 .symtab/.strtab（约 19 MB）：运行时用不到，但会让仓库和 APK 白胖 20 MB。
# 动态符号（napi_*、node::*）全在 .dynsym 里，-lnode 链接与 dlsym 都不受影响；
# LOAD 段的 p_align 与偏移一致性也不受影响（已实测 bionic 10/10）。
# 带符号版另存一份，供 ndk-stack 还原 native 崩溃栈。
STRIP="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"
if [ -x "$STRIP" ] && [ -f out_android/arm64-v8a/libnode.so ]; then
  cp out_android/arm64-v8a/libnode.so out_android/arm64-v8a/libnode.symbols.so
  "$STRIP" --strip-unneeded out_android/arm64-v8a/libnode.so
  echo "== stripped -> $(du -h out_android/arm64-v8a/libnode.so | cut -f1)" \
       "(symbols kept in libnode.symbols.so)"
fi

verify out_android/arm64-v8a/libnode.so
echo
echo "Install into the app with:"
echo "  cp $(pwd)/out_android/arm64-v8a/libnode.so \\"
echo "     $(cd "$(dirname "$0")/.." && pwd)/android/runtime/src/main/jniLibs/arm64-v8a/libnode.so"
