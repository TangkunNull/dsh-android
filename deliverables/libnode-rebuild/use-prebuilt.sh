#!/usr/bin/env bash
# 推荐路径：直接取上游 digidem/nodejs-mobile 的 full 预编译，替换本地 lite 版。
#
# 为什么优先这条：libnode 的 full flavor 上游已经编好并发布，和 lite 版出自
# 同一个 tag（v24.20.0-0）、同一套 NDK、同一份源码 —— 版本、V8 内部布局、
# NAPI 符号全部天然一致。自己编一份要 20+ 小时（4 核机器约 26 小时），
# 而且没有任何收益，除非你要 small-icu 之外的定制（见 build-from-source.sh）。
#
# 用法：
#   ./use-prebuilt.sh                      # 只下载并校验，不落盘
#   ./use-prebuilt.sh /path/to/dsh-android # 下载并替换到该项目
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="v24.20.0-0"
ASSET="nodejs-mobile-android-${TAG#v}.zip"
UPSTREAM="https://github.com/digidem/nodejs-mobile/releases/download/${TAG}/${ASSET}"
# 上游 release 资产不会重新打包，这个哈希是稳定的；不符时只警告，不阻断。
EXPECT_SHA256="c323bf14426e3b47f252cd78b167f293cf32748c440a2d573ad84de5c5e35a84"
JNI_REL="impl/android/runtime/src/main/jniLibs/arm64-v8a/libnode.so"

TARGET=${1:-}
WORK=${WORK:-/tmp/njm-full}
mkdir -p "$WORK"
cd "$WORK"

if [ ! -f "$ASSET" ] || [ "$(stat -c%s "$ASSET" 2>/dev/null || echo 0)" -lt 50000000 ]; then
  echo "== 下载 $ASSET（74 MB）"
  # github.com 直连在大陆很慢（实测 47 KB/s）；镜像快两个数量级。
  ok=0
  for base in "https://ghfast.top/" "https://gh-proxy.com/" ""; do
    echo "   尝试 ${base:-直连}…"
    if curl -fL --retry 2 --connect-timeout 15 --max-time 900 \
         -o "$ASSET.part" "${base}${UPSTREAM}"; then
      mv "$ASSET.part" "$ASSET"; ok=1; break
    fi
    rm -f "$ASSET.part"
  done
  [ "$ok" = 1 ] || { echo "下载失败：请手动下载后放到 $WORK/$ASSET" >&2; exit 1; }
fi

echo "== 校验 sha256"
GOT=$(sha256sum "$ASSET" | cut -d' ' -f1)
echo "   $GOT"
if [ "$GOT" != "$EXPECT_SHA256" ]; then
  echo "   ⚠ 与记录值不一致（可能是上游重发）。继续，但请人工确认 tag 仍是 $TAG。" >&2
fi

echo "== 解包"
rm -rf extracted && mkdir extracted
unzip -q "$ASSET" -d extracted
SRC_SO=$(find extracted -path "*arm64-v8a/libnode.so" | head -1)
[ -n "$SRC_SO" ] || { echo "压缩包里没找到 arm64-v8a/libnode.so" >&2; exit 1; }

echo "== 校验产物"
bash "$HERE/verify-libnode.sh" "$SRC_SO"

if [ -z "$TARGET" ]; then
  echo
  echo "产物就绪：$WORK/$SRC_SO"
  echo "要落地到项目，再跑一次并传入项目根目录："
  echo "  $0 /path/to/dsh-android"
  exit 0
fi

DEST="$TARGET/$JNI_REL"
[ -f "$DEST" ] || { echo "目标不存在：$DEST" >&2; exit 1; }
echo "== 备份原文件 -> ${DEST}.bak"
cp "$DEST" "${DEST}.bak"
echo "== 替换"
cp "$SRC_SO" "$DEST"
ls -lh "$DEST"
echo
echo "完成。接下来重建 APK（版本号记得递增）："
echo "  cd $TARGET/impl/android && gradle :app:assembleRelease"
echo "  cd $TARGET/impl/app    && flutter build apk --release"
echo
echo "注意：full 版自带 SONAME 与 16 KB 对齐，不需要再 patchelf。"
echo "      AGP 会在打包时 llvm-strip 掉调试符号（84 MB -> 63 MB），属正常。"
