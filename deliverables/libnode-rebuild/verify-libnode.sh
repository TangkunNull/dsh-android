#!/usr/bin/env bash
# 校验一份 libnode.so 是否能安全替换进 dsh 的 Android 运行时。
#
# 用法：./verify-libnode.sh <path/to/libnode.so>
#
# 为什么需要这个脚本：libnode 不是"随便一个 arm64 so 就能换"。dsh 的
# node-addon-require-builtin 会直接读 V8 内部结构（Realm vptr、embedder
# data slot），版本或构建配置一变就可能读错地址；JNI 桥 libdsh_node.so 也
# 按符号名调用 node::Start。任何一项不匹配，失败形态都是"装上去之后启动
# 崩溃"，而不是构建报错 —— 所以必须在构建期硬门禁。
set -uo pipefail

SO=${1:-}
[ -n "$SO" ] || { echo "用法: $0 <libnode.so>" >&2; exit 2; }
[ -f "$SO" ] || { echo "文件不存在: $SO" >&2; exit 2; }

NDK=${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}
READELF=""
for c in "$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf" \
         "$(command -v llvm-readelf 2>/dev/null)" \
         "$(command -v readelf 2>/dev/null)"; do
  [ -n "$c" ] && [ -x "$c" ] && { READELF=$c; break; }
done
[ -n "$READELF" ] || { echo "找不到 readelf/llvm-readelf（装 binutils 或设 ANDROID_NDK_HOME）" >&2; exit 2; }

fail=0
note() { printf '  %-22s %s\n' "$1" "$2"; }
bad()  { printf '  %-22s \033[31m%s\033[0m\n' "$1" "$2"; fail=1; }

echo "== $SO"
echo "   体积 $(ls -lh "$SO" | awk '{print $5}')（$(stat -c%s "$SO" 2>/dev/null || stat -f%z "$SO") 字节）"

# 1) 版本必须与设备完全一致：Node 24.20.0 / V8 13.6.233.17-node.53
#    设备侧证据来自 dsh-probe 设备日志里的 native runtime fingerprint。
NODE_V=$(strings "$SO" | grep -oE '^v24\.[0-9]+\.[0-9]+$' | head -1)
# V8 版本是四段：13.6.233.17-node.53（前三个点分数字 + 第四段 + node.N）
V8_V=$(strings "$SO" | grep -oE '13\.[0-9]+\.[0-9]+\.[0-9]+-node\.[0-9]+' | head -1)
[ "$NODE_V" = "v24.20.0" ] && note "Node 版本" "v24.20.0" || bad "Node 版本" "${NODE_V:-未找到}（需要 v24.20.0）"
[ "$V8_V" = "13.6.233.17-node.53" ] && note "V8 版本" "13.6.233.17-node.53" \
  || bad "V8 版本" "${V8_V:-未找到}（设备是 13.6.233.17-node.53，不一致会让 addon 读错 V8 内部布局）"

# 2) SONAME：addon 以 DT_NEEDED libnode.so 复用进程内实例，缺 SONAME 会让
#    bionic 无法按名字匹配已加载的库（设备实测就是这么卡住的）。
SONAME=$("$READELF" -d "$SO" 2>/dev/null | grep -o 'Library soname: \[.*\]' | sed 's/.*\[//;s/\]//')
[ "$SONAME" = "libnode.so" ] && note "SONAME" "libnode.so" \
  || bad "SONAME" "${SONAME:-缺失}（用 patchelf --set-soname libnode.so 补）"

# 3) 16 KB 页对齐：Play 从 2025-11 起要求；4 KB 页设备也接受 0x4000。
ALIGNS=$("$READELF" -lW "$SO" 2>/dev/null | awk '/LOAD/{print $NF}' | sort -u | tr '\n' ' ')
case "$ALIGNS" in
  *0x4000*) note "LOAD 对齐" "$ALIGNS" ;;
  *) bad "LOAD 对齐" "$ALIGNS（需要 0x4000，只能重新链接，无法事后 patch）" ;;
esac

# 4) NAPI 符号：addon 需要 37 个，lite 与 full 都应导出 145 个。
NAPI=$("$READELF" --dyn-syms -W "$SO" 2>/dev/null | grep ' napi_' | grep -vc ' UND ')
[ "${NAPI:-0}" -ge 140 ] && note "napi_* 导出" "$NAPI 个" \
  || bad "napi_* 导出" "$NAPI 个（应有 145，少了说明符号被隐藏/裁剪）"

# 5) ICU：full 版应有，lite 版没有。总数用于判断"到底换成了哪一版"。
ICU=$("$READELF" --dyn-syms -W "$SO" 2>/dev/null | grep -cE ' (icu_[0-9]+|u_strlen|ucol_open)')
SQLITE=$("$READELF" --dyn-syms -W "$SO" 2>/dev/null | grep -c 'sqlite3_')
if [ "$ICU" -gt 0 ]; then
  note "ICU 符号" "$ICU 个（full：Intl 原生可用）"
else
  note "ICU 符号" "0 个（lite：需要运行时 Intl polyfill）"
fi
[ "$SQLITE" -gt 0 ] && note "sqlite3 符号" "$SQLITE 个（全文搜索可用）" || note "sqlite3 符号" "0 个（lite：全文搜索不可用）"

# 6) 依赖的共享库必须在 APK 里能解析：bionic 自带的 + App 自带的 libc++_shared。
echo "   依赖:"
"$READELF" -d "$SO" 2>/dev/null | grep NEEDED | sed 's/.*\[//;s/\]//' | while read -r l; do
  case "$l" in
    libc.so|libm.so|libdl.so|liblog.so|libc++_shared.so) printf '     %-20s ok（bionic 或 APK 内自带）\n' "$l" ;;
    *) printf '     %-20s \033[33m需自行确认 APK 内有这一份\033[0m\n' "$l" ;;
  esac
done

echo
if [ "$fail" -eq 0 ]; then
  echo "结论：可以替换。sha256 = $(sha256sum "$SO" | cut -d' ' -f1)"
else
  echo "结论：不能直接用，见上面的红字。" >&2
fi
exit "$fail"
