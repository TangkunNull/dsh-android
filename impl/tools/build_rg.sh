#!/usr/bin/env bash
# 把 aarch64 版 ripgrep 投放成 APK 内可 exec 的 nativeLibraryDir 条目。
#
#   npm:@vscode/ripgrep-linux-arm64/bin/rg
#     -> impl/android/runtime/src/main/jniLibs/arm64-v8a/librg.so  (进 APK)
#
# 为什么是这一份二进制而不是 node_modules 里 @vscode/ripgrep 的解析结果：
#   * `@vscode/ripgrep` 按 `process.platform-process.arch` 选包，Android 上
#     Node 报 linux-arm64，所以平台包是对的；但它在 node_modules 里，而
#     dataDir 是 noexec —— 从那里 execve 必然 EACCES。
#   * VS Code 发布的 rg 是 **静态链接**（`ldd` 报 "not a dynamic executable"），
#     这一点是它能跑在 bionic 上的唯一原因：glibc 动态版在 Android 上没有
#     libc.so.6。换一份非静态的构建会直接死在 execve 之后。
#   * LOAD 段 Align=0x10000（64 KB），满足 16 KB 页内核的要求。
#
# 为什么叫 librg.so：Android 只允许从 nativeLibraryDir exec 匹配 `lib*.so`
# 的文件。内容是 ELF 可执行文件，后缀是给加载器看的（与 libdsh-sandbox-runner.so
# 同一套约定）。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
impl=$(cd "$here/.." && pwd)

jni_dir="$impl/android/runtime/src/main/jniLibs/arm64-v8a"
out_so="$jni_dir/librg.so"
pkg="@vscode/ripgrep-linux-arm64"
ver=${RG_VERSION:-1.18.0}

die() { echo "错误：$*" >&2; exit 1; }

command -v npm >/dev/null 2>&1 || die "找不到 npm（需要它从 registry 取 $pkg）"
command -v readelf >/dev/null 2>&1 || die "找不到 readelf（binutils），无法自证 ELF 属性"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "== 获取 $pkg@$ver"
(cd "$work" && npm pack "$pkg@$ver" --silent >/dev/null 2>&1) || die "npm pack $pkg@$ver 失败"
tgz=$(find "$work" -maxdepth 1 -name '*.tgz' | head -1)
[ -n "$tgz" ] || die "没有拿到 tarball"
tar xzf "$tgz" -C "$work"
src="$work/package/bin/rg"
[ -f "$src" ] || die "tarball 里没有 package/bin/rg"

# ── 三条属性必须成立，缺一条就说明上游换过构建方式 ──────────────────────────
echo "== 校验 ELF 属性"

hdr=$(readelf -h "$src")
echo "$hdr" | grep -q 'Machine:.*AArch64' || die "不是 aarch64：$(echo "$hdr" | grep Machine)"
echo "  Machine   AArch64"

# 静态：没有 PT_INTERP，也没有 dynamic section。
if readelf -lW "$src" | grep -q 'INTERP'; then
  die "带 PT_INTERP（动态链接），bionic 上找不到指定的 loader，execve 必失败"
fi
echo "  Linkage   static（无 PT_INTERP）"

# 16 KB 页：所有 LOAD 段的 Align 都要 >= 0x4000。
min_align=$(readelf -lW "$src" | awk '$1=="LOAD"{print $NF}' | sort -u | head -1)
case "$min_align" in
  0x4000|0x10000|0x20000|0x40000|0x80000|0x100000) echo "  LOAD Align $min_align" ;;
  *) die "LOAD 段对齐 $min_align 小于 0x4000，16 KB 页内核会拒绝映射" ;;
esac

# ET_EXEC 与 ET_DYN 都接受：PIE 强制只对走 linker 的动态可执行文件生效，
# 静态 ELF 由内核直接加载。留个记录，免得以后误以为漏了 -pie。
etype=$(echo "$hdr" | awk '/Type:/{print $2}')
echo "  Type      $etype（静态 ELF，不经 linker）"

# ── 投放 ───────────────────────────────────────────────────────────────────
mkdir -p "$jni_dir"
tmp=$(mktemp "$jni_dir/.rg.XXXXXX")
cp "$src" "$tmp"
chmod 0755 "$tmp"
mv -f "$tmp" "$out_so"

echo
ls -l "$out_so" | awk '{ printf "  产物  %s  %s\n", $5, $9 }'
[ -s "$out_so" ] || die "产物为空"
echo "== 完成"
