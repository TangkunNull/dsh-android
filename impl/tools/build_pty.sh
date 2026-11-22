#!/usr/bin/env bash
# 编译 PTY 桥（N-API 模块），产两份：
#
#   impl/android/pty/src/main/cpp/dsh_pty.c
#     -> impl/android/runtime/src/main/jniLibs/arm64-v8a/libdsh_pty.so  (bionic, 进 APK)
#     -> impl/.artifacts/libdsh_pty_host.so                             (glibc, 本机测试)
#
# 为什么不能像 sandbox-runner 那样只编 Android 版：那个是独立可执行文件，本机
# 跑不了 arm64 就只能靠 qemu 且 qemu 下的 PTY 语义不可信。这里 host 版是同一份
# .c，forkpty 在 glibc 和 bionic 上行为一致，于是 PTY 的完整链路（spawn、读写、
# 窗口尺寸、退出码、信号）可以在本机真跑 —— 这是这个文件存在的最大理由。
#
# 为什么不链 libnode：N-API 模块的 napi_*/uv_* 符号由宿主进程（libnode）在
# dlopen 时解析。链上去会在进程里出现第二份 libuv，两个 loop 各自转。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
impl=$(cd "$here/.." && pwd)

src="$impl/android/pty/src/main/cpp/dsh_pty.c"
inc="$impl/android/runtime/src/main/cpp/node/include"
jni_dir="$impl/android/runtime/src/main/jniLibs/arm64-v8a"
out_so="$jni_dir/libdsh_pty.so"
art_dir="$impl/.artifacts"
out_host="$art_dir/libdsh_pty_host.so"

NDK_ROOT=${ANDROID_NDK_ROOT:-/root/android-ndk/android-ndk-r27c}
TOOLCHAIN="$NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64"
CC_ANDROID="$TOOLCHAIN/bin/aarch64-linux-android24-clang"
HOST_CC=${HOST_CC:-cc}

die() { echo "错误：$*" >&2; exit 1; }

[ -f "$src" ] || die "找不到源文件 $src"
[ -f "$inc/node_api.h" ] || die "找不到 N-API 头 $inc/node_api.h"
[ -x "$CC_ANDROID" ] || die "找不到 NDK 编译器 $CC_ANDROID"

CFLAGS=(-O2 -Wall -Wextra -Wno-unused-parameter -std=c11 -fPIC -shared)
# 16 KB 页：我们自己的段按 16 KB 对齐。真正的门禁在 build_apk.sh 里查。
LDFLAGS_ANDROID=(-Wl,-z,max-page-size=16384)

mkdir -p "$jni_dir" "$art_dir"

build_android() {
  local tmp
  tmp=$(mktemp "$jni_dir/.pty.XXXXXX")
  echo "== arm64-v8a (bionic)：$out_so"
  # bionic 把 forkpty 放在 libc，没有独立的 libutil —— 不要 -lutil。
  "$CC_ANDROID" "${CFLAGS[@]}" "${LDFLAGS_ANDROID[@]}" -I"$inc" "$src" -o "$tmp" \
    || { rm -f "$tmp"; return 1; }
  chmod 0755 "$tmp"
  mv -f "$tmp" "$out_so"
}

build_host() {
  local tmp
  tmp=$(mktemp "$art_dir/.pty-host.XXXXXX")
  echo "== host (glibc)：$out_host"
  # glibc 的 forkpty 在 libutil。
  "$HOST_CC" "${CFLAGS[@]}" -I"$inc" "$src" -o "$tmp" -lutil || { rm -f "$tmp"; return 1; }
  chmod 0755 "$tmp"
  mv -f "$tmp" "$out_host"
}

build_android
build_host

echo
for f in "$out_so" "$out_host"; do
  if command -v file >/dev/null 2>&1; then
    printf '  %-40s %s\n' "$(basename "$f")" "$(file -b "$f" | cut -c1-60)"
  fi
  ls -l "$f" | awk '{ printf "  %-40s %s bytes\n", "", $5 }'
done

# 导出符号自证：模块必须导出 napi_register_module_v1，否则 dlopen 之后
# require 拿到的是空对象，而报错会发生在调用方（「spawn is not a function」）。
for f in "$out_so" "$out_host"; do
  if command -v readelf >/dev/null 2>&1; then
    readelf -sW "$f" | grep -q napi_register_module_v1 \
      || die "$(basename "$f") 没有 napi_register_module_v1，不是有效的 N-API 模块"
  fi
done
echo "== 两份都导出 napi_register_module_v1"
