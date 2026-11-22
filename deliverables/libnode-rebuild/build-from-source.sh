#!/usr/bin/env bash
# 自编 libnode.so —— 只在「预编译版满足不了」时才需要跑。
#
# 什么时候真的需要自编：
#   1. 要 **full-icu**（中文/多语言 Intl 格式化）。上游 full flavor 只给
#      small-icu（en 数据 + 完整 Unicode 属性表），中文日期数字仍会按 en 输出。
#      full-icu 会把 ICU 全量数据（各语言 ~25 MB）编进 so，APK 再大一圈。
#   2. 要改 V8 编译选项（如 pointer compression、snapshot 策略）。
#   3. 上游 tag 与你设备的 V8 版本不再匹配（升级 Node 时）。
#
# 不需要自编的情况：只是想要 Intl 可用、SQLite 可用、inspector 可用 ——
# 上游 full 预编译都有，直接用 use-prebuilt.sh，别浪费 20 小时。
#
# 机器要求（实测参考）：
#   * 32 核 / 64 GB 内存 → 约 1.5~2 小时
#   * 16 核 / 32 GB 内存 → 约 3~4 小时
#   * 4 核 / 8 GB 内存  → 约 26 小时，且 -j4 以上会 OOM（不推荐）
#   * 磁盘 30 GB（源码 ~700 MB + 构建中间产物 ~15 GB + 产物）
#
# 依赖：curl、tar、python3、make、g++（构建 host 工具链用）、unzip、binutils
#       Ubuntu/Debian:
#         sudo apt install -y build-essential python3 curl unzip binutils
#
# 用法：
#   ./build-from-source.sh <ndk-dir> [--intl full-icu|small-icu|none] [--jobs N]
#                                    [--out /path/to/libnode.so]
#
# 例：
#   ./build-from-source.sh ~/android-ndk-r27c --intl full-icu --jobs 32
set -euo pipefail

usage() { sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 1 ] || usage
NDK=$1; shift

INTL=full-icu
JOBS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 8)
OUT_SO=""
TAG="v24.20.0-0"

while [ $# -gt 0 ]; do
  case $1 in
    --intl) INTL=$2; shift 2 ;;
    --jobs) JOBS=$2; shift 2 ;;
    --tag)  TAG=$2;  shift 2 ;;
    --out)  OUT_SO=$2; shift 2 ;;
    -h|--help) usage ;;
    *) echo "未知选项: $1" >&2; usage ;;
  esac
done

NDK=$(cd "$NDK" && pwd) || { echo "NDK 路径不存在: $NDK" >&2; exit 1; }

# NDK 版本：上游 v24.20.0-0 用 r27 构建。跨大版本链接器行为不同（libc++ 版本、
# --no-undefined 默认值），产物可能加载失败且构建期不报错 —— 至少提示一句。
NDK_REV=""
[ -f "$NDK/source.properties" ] && NDK_REV=$(sed -n 's/^Pkg.Revision *= *//p' "$NDK/source.properties" | head -1)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK=${WORK:-$HOME/libnode-build}
SRC=$WORK/src
API=24

# 空间：源码 ~700 MB + 中间产物 ~15 GB + 两份产物，25 GB 是下限
mkdir -p "$WORK"
AVAIL_KB=$(df -Pk "$WORK" 2>/dev/null | awk 'NR==2{print $4}')
if [ "${AVAIL_KB:-0}" -lt $((25 * 1024 * 1024)) ]; then
  echo "磁盘不足：$WORK 可用 $(df -Ph "$WORK" 2>/dev/null | awk 'NR==2{print $4}')，至少需要 25 GB。" >&2
  echo "换盘：WORK=/data/libnode-build $0 $*" >&2
  exit 1
fi

# 内存：V8 的 ICU 绑定层单文件峰值约 1.5 GB，jobs 超过 内存GB/1.5 就会 OOM 被杀
MEM_GB=$(awk '/MemTotal/{printf "%d", $2/1048576}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$MEM_GB" -gt 0 ]; then
  SAFE=$((MEM_GB * 2 / 3))
  [ "$SAFE" -lt 2 ] && SAFE=2
  if [ "$JOBS" -gt "$SAFE" ]; then
    echo "   ⚠ jobs=$JOBS 超过安全值 $SAFE（${MEM_GB} GB 内存），可能被 OOM killer 杀掉；已降到 $SAFE" >&2
    JOBS=$SAFE
  fi
fi

echo "== 配置"
echo "   NDK    : $NDK${NDK_REV:+ (r$NDK_REV)}"
echo "   源码   : digidem/nodejs-mobile $TAG"
echo "   intl   : $INTL"
echo "   jobs   : $JOBS"
echo "   API    : $API (arm64)"
echo "   工作区 : $WORK"

if [ -z "$NDK_REV" ]; then
  echo "   ⚠ $NDK 下没有 source.properties，不像标准 NDK 目录" >&2
elif [ "${NDK_REV%%.*}" != "27" ]; then
  echo "   ⚠ 上游用 r27 构建，你这台是 r$NDK_REV。能编过，但产物要与设备侧一致才最稳。" >&2
fi

# ---------------------------------------------------------------- 取源码 ----
if [ ! -f "$SRC/src/node_version.h" ]; then
  echo "== 下载源码（约 100 MB）"
  mkdir -p "$WORK"
  TAR="$WORK/nodejs-mobile-$TAG.tar.gz"
  if [ ! -f "$TAR" ] || [ "$(stat -c%s "$TAR" 2>/dev/null || echo 0)" -lt 10000000 ]; then
    UP="https://github.com/digidem/nodejs-mobile/archive/refs/tags/$TAG.tar.gz"
    for base in "https://ghfast.top/" "https://gh-proxy.com/" ""; do
      echo "   尝试 ${base:-直连}…"
      if curl -fL --retry 2 --connect-timeout 15 --max-time 1800 -o "$TAR.part" "${base}${UP}"; then
        mv "$TAR.part" "$TAR"; break
      fi
      rm -f "$TAR.part"
    done
  fi
  [ -f "$TAR" ] || { echo "下载失败：手动下载 $TAG.tar.gz 放到 $TAR" >&2; exit 1; }
  rm -rf "$SRC"; mkdir -p "$SRC"
  tar xzf "$TAR" -C "$SRC" --strip-components=1
fi
cd "$SRC"

# ------------------------------------------------------------ 版本硬校验 ----
# 版本错了，产物在设备上会读错 V8 内部布局（addon 按偏移取 Realm/context）。
# 这种失败不会在构建期报错，只在启动时崩 —— 所以先卡死。
NODE_VER=$(grep -E '^#define NODE_MAJOR_VERSION' src/node_version.h | awk '{print $3}')
NODE_MIN=$(grep -E '^#define NODE_MINOR_VERSION' src/node_version.h | awk '{print $3}')
NODE_PAT=$(grep -E '^#define NODE_PATCH_VERSION' src/node_version.h | awk '{print $3}')
GOT="v$NODE_VER.$NODE_MIN.$NODE_PAT"
WANT="v${TAG#v}"
WANT=${WANT%-*}          # v24.20.0-0 -> v24.20.0
echo "== 源码版本 $GOT（目标 $WANT）"
[ "$GOT" = "$WANT" ] || { echo "版本不匹配：设备上跑的是 $WANT，用别的版本编出来的 so 不能替换。" >&2; exit 1; }

# ------------------------------------------------------------ intl 开关 ----
# digidem 的 android_configure.py 里 full flavor 固定 `intl = "small-icu"`，
# 没有对外开放。要 full-icu 就把它改成读环境变量（用 python 改，不用 sed：
# 那行的引号嵌套会让 sed 生成语法错误的 Python）。
if grep -q 'intl = "small-icu"' android_configure.py; then
  python3 - "$INTL" <<'PY'
import sys, re, pathlib
p = pathlib.Path('android_configure.py')
s = p.read_text()
s = s.replace('intl = "small-icu"',
              'intl = os.environ.get("NODEJS_MOBILE_INTL", "small-icu")  # patched by dsh')
p.write_text(s)
print('   patched android_configure.py: intl 改为读 NODEJS_MOBILE_INTL')
PY
fi
export NODEJS_MOBILE_INTL="$INTL"
export NODEJS_MOBILE_FLAVOR=full

# --------------------------------------------------- 链接参数（对齐/名字）----
# 上游 full flavor 本身已经 16 KB 对齐且带 SONAME（下载版实测 0x4000 +
# soname libnode.so），这里再显式给一遍，避免上游将来回退配置时静默降级。
# 两个 -z 参数都必须有：max-page-size 决定 p_align，common-page-size 保证
# 段文件偏移与虚拟地址同余（只设前者会得到一个校验不过的 ELF）。
export LDFLAGS="-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384 -Wl,-soname,libnode.so"

# ------------------------------------------------------------ 配置/编译 ----
# 上次用别的参数编过的话，out/ 里的 .o 与配置都不作数 —— 必须重配。
# 不做这一步的后果：--intl full-icu 静默复用 small-icu 的配置，白跑 20 小时。
FP="$WORK/.config-fingerprint"
WANT_FP="$TAG|$INTL|$API|$NDK"
if [ -f "$FP" ] && [ "$(cat "$FP" 2>/dev/null)" != "$WANT_FP" ]; then
  echo "== 配置参数已变：$(cat "$FP") → $WANT_FP"
  echo "   清掉旧 out/ 与 config.gypi（上一个 intl/flavor 的中间产物不能复用）"
  rm -rf "$SRC/out" "$SRC/config.gypi"
fi
printf '%s' "$WANT_FP" > "$FP"

if [ ! -f out/Makefile ] || ! grep -q 'OS.: .android' config.gypi 2>/dev/null; then
  echo "== configure"
  rm -rf android-toolchain
  ./android-configure "$NDK" "$API" arm64
else
  echo "== 复用已有配置（删掉 $SRC/out 可全量重来）"
fi

# configure 后硬校验：intl 没生效就必须停，不能等到 20 小时后才发现产物是错的。
# 判据来自 Node 的 configure.py：small-icu 写 icu_small=true，full-icu 写 false。
ICU_SMALL=$(grep -oE "'icu_small': '[a-z]+'" config.gypi 2>/dev/null | sed "s/.*: '//;s/'//")
I18N=$(grep -oE "'v8_enable_i18n_support': [0-9]+" config.gypi 2>/dev/null | awk '{print $2}')
echo "   config: icu_small=${ICU_SMALL:-?} v8_enable_i18n_support=${I18N:-?}"
case "$INTL" in
  full-icu)
    [ "$ICU_SMALL" = "false" ] || {
      echo "✗ --intl full-icu 未生效（config 里 icu_small=${ICU_SMALL:-缺失}，应为 false）。" >&2
      echo "  android_configure.py 的补丁没打上？检查 $SRC/android_configure.py 第 96 行附近。" >&2
      exit 1
    } ;;
  small-icu)
    [ "$ICU_SMALL" = "true" ] || {
      echo "✗ --intl small-icu 未生效（icu_small=${ICU_SMALL:-缺失}，应为 true）。" >&2
      exit 1
    } ;;
  none)
    [ "$I18N" = "0" ] || {
      echo "✗ --intl none 未生效（v8_enable_i18n_support=${I18N:-缺失}，应为 0）。" >&2
      exit 1
    } ;;
esac
echo "   config: intl=$INTL ✓"

echo "== make -j$JOBS（首次全量：32 核约 1.5~2 小时；中断后重跑同一条命令可续编）"
make -j"$JOBS"

# ---------------------------------------------------------------- 收集 ----
CAND=""
for c in out/Release/lib.target/libnode.so out/Release/obj.target/libnode.so; do
  [ -f "$c" ] && { CAND=$c; break; }
done
[ -n "$CAND" ] || { echo "没找到 libnode.so" >&2; exit 1; }

mkdir -p "$WORK/out"
cp "$CAND" "$WORK/out/libnode.so"

# 体积是"到底编出了哪一版"的第二重证据（第一重是 configure 后的 icu_small）。
# 参考值来自上游预编译：none 66 MB / small-icu 84 MB / full-icu 约 110 MB。
SZ_MB=$(( $(stat -c%s "$WORK/out/libnode.so") / 1048576 ))
echo "   产物体积 ${SZ_MB} MB"
case "$INTL" in
  full-icu)  [ "$SZ_MB" -lt 95 ] && echo "   ⚠ full-icu 通常 ≥ 95 MB，这份偏小，确认 ICU 数据是否编进去了" >&2 ;;
  small-icu) [ "$SZ_MB" -gt 95 ] && echo "   ⚠ small-icu 通常 ≈ 84 MB，这份偏大" >&2 ;;
esac

echo
echo "== 校验"
bash "$HERE/verify-libnode.sh" "$WORK/out/libnode.so"

if [ -n "$OUT_SO" ]; then
  mkdir -p "$(dirname "$OUT_SO")"
  cp "$WORK/out/libnode.so" "$OUT_SO"
  echo "== 已写出 $OUT_SO"
fi

echo
echo "产物：$WORK/out/libnode.so"
echo "回填：cp \"$WORK/out/libnode.so\" <项目>/impl/android/runtime/src/main/jniLibs/arm64-v8a/libnode.so"
echo "然后重建 probe 与 app，并递增 versionCode。"
