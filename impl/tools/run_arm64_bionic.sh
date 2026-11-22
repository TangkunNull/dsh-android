#!/usr/bin/env bash
# Runs the native runner test on **arm64 Android (bionic)** without a device.
#
# There is no /dev/kvm in this environment, so the APK cannot be installed in an
# emulator. But "no hypervisor" is not "no way to execute": qemu-user emulates
# the arm64 instruction set in software, and the only thing it lacks is an
# Android userspace. That can be taken from an SDK system image — the bionic
# linker64 and /system/lib64 are all a dynamically linked arm64 binary needs.
#
# What this proves:
#   * libnode.so is a loadable arm64 Android shared library (bionic's linker
#     accepts it, resolves libc++_shared, runs its init_array),
#   * node/V8 actually initialize and execute JS on bionic,
#   * argv/env/cwd, stdout/stderr separation, natural exit and node::Stop
#     behave the same way they do on the host build.
#
# What it does NOT prove:
#   * JNI through ART (this path is JNI-free; the Java side is not exercised),
#   * 16 KB page behaviour: qemu-user's guest page size is fixed at 4 KB, so a
#     16 KB kernel's mmap/segment rounding is not simulated,
#   * that the APK installs and launches on a real device.
#
# Usage:
#   ./run_arm64_bionic.sh <ndk-dir> <system-image-dir> [--cases 1,2,10]
#
# <system-image-dir> is e.g.
#   $ANDROID_HOME/system-images/android-28/default/arm64-v8a
set -euo pipefail

NDK=${1:?usage: run_arm64_bionic.sh <ndk> <system-image-dir> [--cases ...]}
IMG_DIR=${2:?usage: run_arm64_bionic.sh <ndk> <system-image-dir> [--cases ...]}
CASES="1,2,3,4,5,6,7,8,9,10"
shift 2
while [ $# -gt 0 ]; do
  case $1 in
    --cases) CASES=$2; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
cpp="$here/../android/runtime/src/main/cpp"
jni="$here/../android/runtime/src/main/jniLibs/arm64-v8a"
NDK=$(cd "$NDK" && pwd)
IMG_DIR=$(cd "$IMG_DIR" && pwd)
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
CXX="$TOOLCHAIN/bin/aarch64-linux-android24-clang++"
ROOT=${ROOT:-/tmp/dsh-bionic}
QEMU=${QEMU:-$(command -v qemu-aarch64-static || command -v qemu-aarch64)}

[ -x "$QEMU" ] || { echo "qemu-aarch64 not found: apt-get install qemu-user-static" >&2; exit 1; }
[ -f "$jni/libnode.so" ] || { echo "missing $jni/libnode.so" >&2; exit 1; }

# --------------------------------------------------------------- the binary --
# Same sources as the host test; only the target differs. This is the point:
# if the runner had host assumptions, they show up here as a bionic failure.
build_binary() {
  mkdir -p "$ROOT"
  echo "== building arm64 test binary"
  "$CXX" -O2 -std=c++20 -fPIE -pie \
    -I "$cpp/node/include" -I "$cpp/node/include/node" \
    "$cpp/host_runner_test.cc" "$cpp/node_runner.cc" \
    -L "$jni" -lnode -llog -ldl -lm -lc++_shared \
    -Wl,--no-undefined -Wl,-z,max-page-size=16384 \
    -o "$ROOT/host_runner_test"
  "$TOOLCHAIN/bin/llvm-readelf" -d "$ROOT/host_runner_test" | awk '/NEEDED/ {print "   " $5}'
}

# ---------------------------------------------------------------- the rootfs --
# The SDK ships system.img wrapped in a GPT (and, from API 29 on, as a `super`
# image with liblp metadata). We only take the one partition that matters and
# read it with debugfs, so no loop device or mount is required — this sandbox
# has neither.
extract_rootfs() {
  local img="$IMG_DIR/system.img"
  [ -f "$img" ] || { echo "missing $img" >&2; exit 1; }
  mkdir -p "$ROOT/root/system/bin" "$ROOT/root/system/lib64" "$ROOT/root/system/etc"

  local geom
  geom=$(python3 - "$img" <<'PY'
import struct, sys
p = sys.argv[1]
f = open(p, 'rb')
f.seek(512)
h = f.read(92)
skip = 0
if h[:8] == b'EFI PART':
    lba, n, sz = struct.unpack_from('<QII', h, 0x48)
    f.seek(lba * 512)
    for _ in range(n):
        e = f.read(sz)
        if e[:16] == b'\0' * 16:
            continue
        first, last = struct.unpack_from('<QQ', e, 0x20)
        skip = first * 512
        break
else:
    # Plain image: find the ext4 superblock magic on a sector boundary.
    f.seek(0, 2)
    total = f.tell()
    for off in range(0, min(total, 64 << 20), 4096):
        f.seek(off + 0x438)
        if f.read(2) == b'\x53\xef':
            skip = off
            break
print(skip)
PY
)
  echo "== system partition at byte offset $geom"

  local fs="$ROOT/system_fs.img"
  if [ ! -f "$fs" ]; then
    dd if="$img" of="$fs" bs=512 skip=$((geom / 512)) status=none
  fi

  echo "== extracting linker64 + /system/lib64 (bionic userspace)"
  debugfs -R "dump /system/bin/linker64 $ROOT/root/system/bin/linker64"  "$fs" 2>/dev/null
  debugfs -R "dump /system/etc/ld.config.txt $ROOT/root/system/etc/ld.config.txt" "$fs" 2>/dev/null || true
  rm -rf "$ROOT/root/system/lib64"; mkdir -p "$ROOT/root/system/lib64"
  debugfs -R "rdump /system/lib64 $ROOT/root/system/lib64" "$fs" 2>/dev/null
  # rdump recreates the directory name inside the target.
  if [ -d "$ROOT/root/system/lib64/lib64" ]; then
    mv "$ROOT/root/system/lib64/lib64"/* "$ROOT/root/system/lib64"/
    rmdir "$ROOT/root/system/lib64/lib64"
  fi
  chmod +x "$ROOT/root/system/bin/linker64"
  echo "   $(ls "$ROOT/root/system/lib64" | wc -l) libraries"
}

install_payload() {
  cp "$jni/libnode.so" "$ROOT/root/system/lib64/libnode.so"
  cp "$TOOLCHAIN/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" \
     "$ROOT/root/system/lib64/libc++_shared.so"
  cp "$ROOT/host_runner_test" "$ROOT/root/system/bin/host_runner_test"
}

run_cases() {
  local pass=0 fail=0
  for c in ${CASES//,/ }; do
    local out rc
    out=$(cd "$ROOT/root" && timeout 300 "$QEMU" -L "$ROOT/root" \
            "$ROOT/root/system/bin/host_runner_test" --case "$c" 2>&1) && rc=0 || rc=$?
    local verdict
    verdict=$(printf '%s\n' "$out" | grep -E '^(PASS|FAIL)' | tail -1)
    if [ -n "$verdict" ] && [ "${verdict#PASS}" != "$verdict" ]; then
      pass=$((pass + 1)); echo "  ok    case $c  $verdict"
    else
      fail=$((fail + 1)); echo "  FAIL  case $c (rc=$rc)"
      printf '%s\n' "$out" | grep -vE '^WARNING|^linker:' | tail -8 | sed 's/^/        /'
    fi
  done
  echo
  echo "== $pass passed, $fail failed"
  [ "$fail" = 0 ]
}

build_binary
if [ ! -x "$ROOT/root/system/bin/linker64" ]; then
  extract_rootfs
else
  echo "== reusing rootfs at $ROOT/root"
fi
install_payload
run_cases
