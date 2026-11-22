#!/usr/bin/env bash
# 交叉编译 landlock 沙箱启动器，并从**同一份 .c** 产出一个 host 对照二进制。
#
#   impl/android/runtime/src/main/cpp/sandbox_runner.c
#     -> impl/android/runtime/src/main/jniLibs/arm64-v8a/libdsh-sandbox-runner.so  (bionic, 进 APK)
#     -> impl/.artifacts/sandbox-runner-host                                        (glibc, 只给本机契约测试)
#
# 为什么不是一个 app 内的 CMake target：这个 runner 是被 exec 的**预编译产物**，
# 跟 JNI 桥无关。走 src/main/cpp/CMakeLists.txt 会让 AGP 把它当 JNI 库再编一次，
# 两个构建系统抢同一个输出。
#
# 为什么动态链接 bionic：静态版 2.2 MB，动态版约 10 KB；NDK 也不推荐 app 里静态
# 链 bionic（每个进程一份 libc，跨 so 的 errno/TLS 语义也容易出岔子）。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
impl=$(cd "$here/.." && pwd)

src="$impl/android/runtime/src/main/cpp/sandbox_runner.c"
jni_dir="$impl/android/runtime/src/main/jniLibs/arm64-v8a"
out_so="$jni_dir/libdsh-sandbox-runner.so"
art_dir="$impl/.artifacts"
out_host="$art_dir/sandbox-runner-host"

# NDK r27c；arm64 最低 API 24（与 runtime/build.gradle 的约定一致的低位）。
NDK_ROOT=${ANDROID_NDK_ROOT:-/root/android-ndk/android-ndk-r27c}
TOOLCHAIN="$NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64"
CC_ANDROID="$TOOLCHAIN/bin/aarch64-linux-android24-clang"
HOST_CC=${HOST_CC:-cc}

CFLAGS=(-O2 -Wall -Wextra -Werror -std=c11)
# -fPIE -pie：产物是 ELF 可执行文件（ET_DYN + PT_INTERP），只是名字必须叫
# lib*.so —— Android 只允许从 nativeLibraryDir exec 这个命名的文件。
# max-page-size=16384：Android 15+ 的 16 KB 页要求。
LDFLAGS_ANDROID=(-fPIE -pie -Wl,-z,max-page-size=16384)

die() { echo "错误：$*" >&2; exit 1; }

[ -f "$src" ] || die "找不到源文件 $src"
[ -x "$CC_ANDROID" ] || die "找不到 NDK 交叉编译器 $CC_ANDROID
  请设置 ANDROID_NDK_ROOT 指向 NDK r27c（或任何带 aarch64-linux-android24-clang 的 NDK），
  例如：ANDROID_NDK_ROOT=/opt/android-ndk ./build_sandbox_runner.sh"
command -v "$HOST_CC" >/dev/null 2>&1 || die "找不到 host 编译器 $HOST_CC（可用 HOST_CC 覆盖）"
command -v file >/dev/null 2>&1 || echo "警告：没有 file 命令，下面跳过 ELF 类型自证" >&2

mkdir -p "$jni_dir" "$art_dir"

# 先编到临时文件再 mv：重复执行是幂等的，中途失败也不会留下半截 .so。
build_android() {
  local tmp
  tmp=$(mktemp "$jni_dir/.runner.XXXXXX")
  echo "== arm64-v8a (bionic)：$out_so"
  "$CC_ANDROID" "${CFLAGS[@]}" "${LDFLAGS_ANDROID[@]}" "$src" -o "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 0755 "$tmp"
  mv -f "$tmp" "$out_so"
}

# host 版只用于本机契约测试（node --test），不进 APK。
build_host() {
  local tmp
  tmp=$(mktemp "$art_dir/.runner-host.XXXXXX")
  echo "== host (glibc)：$out_host"
  "$HOST_CC" "${CFLAGS[@]}" "$src" -o "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 0755 "$tmp"
  mv -f "$tmp" "$out_host"
}

build_android
build_host

echo
for f in "$out_so" "$out_host"; do
  if command -v file >/dev/null 2>&1; then
    printf '%s\n' "$(file -b "$f")" | sed "s|^|  类型  |"
  fi
  ls -l "$f" | awk '{ printf "  大小  %s  %s\n", $5, $9 }'
done
[ -s "$out_so" ] || die "产物为空：$out_so"
[ -s "$out_host" ] || die "产物为空：$out_host"
echo "== 完成"
