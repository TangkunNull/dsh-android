#!/usr/bin/env bash
# 用 NDK 交叉编译 node-addon-require-builtin 的 android-arm64 原生绑定。
#
# 背景：dsh-app-boot 的 host preparation 硬依赖 node-addon-require-builtin
# （用它访问 Node 内部模块做解析/拦截）。npm 上游只发布 darwin/linux/win 变体，
# 没有 android-arm64；而 Android 上 process.platform === 'android'，
# loader 按 node-addon-require-builtin-<platform>-<arch> 找包必然落空
# （设备日志：No usable native binding found for node-addon-require-builtin-android-arm64）。
#
# 上游源码开源（MIT）：github.com/deepseek-ai/dsh-node-addon-require-builtin。
# 本脚本从源码直接用 NDK clang++ 编译（802 行 C++ 的单个 Node-API addon，
# 不走 node-gyp —— Android 上 node-gyp 折腾且没必要）。产物落到
# vendor/prebuilt/node-addon-require-builtin-android-arm64/，由
# pack-runtime.mjs 注入 runtime.zip。
#
# 用法：./tools/build-require-builtin-android.sh [ndk-dir] [node-src-dir]
#   ndk-dir     默认 /root/android-tools/sdk/ndk/27.2.12479018
#   node-src-dir 默认 /root/dl/node-src（与 build_libnode_android.sh 用的同一份，
#               保证 NAPI 头文件与设备上的 libnode 版本一致）
#
# 静态前置（已核验，libnode.so 须导出这些符号，bionic dlsym 才能找到）：
#   _ZN2v82V810GetVersionEv
#   _ZN2v87Context29GetNumberOfEmbedderDataFieldsEv
#   _ZN2v87Context37SlowGetAlignedPointerFromEmbedderDataEi   (老 V8 fallback)
#   _ZN2v87Isolate10GetCurrentEv
#   _ZN2v87Isolate17GetCurrentContextEv
#   _ZNK4node14PrincipalRealm22builtin_module_requireEv
set -euo pipefail

NDK=${1:-/root/android-tools/sdk/ndk/27.2.12479018}
NODE_SRC=${2:-/root/dl/node-src}
# 用于 -lnode 的 libnode.so（与本机 jniLibs 里那份同源，须带 SONAME=libnode.so）
LIBNODE_DIR=${LIBNODE_DIR:-"$(cd "$(dirname "$0")/.." && pwd)/android/runtime/src/main/jniLibs/arm64-v8a"}
SRC_REPO=${NARB_SRC:-/tmp/dsh-narb/packages/native}   # 上游仓库检出位置
OUT_ROOT="$(cd "$(dirname "$0")/.." && pwd)/vendor/prebuilt/node-addon-require-builtin-android-arm64"

if [ ! -d "$SRC_REPO/src" ]; then
  echo "上游源码不在 $SRC_REPO —— 先克隆：" >&2
  echo "  git clone --depth 1 https://github.com/deepseek-ai/dsh-node-addon-require-builtin.git \$(dirname $SRC_REPO)" >&2
  exit 1
fi

CXX="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android29-clang++"
NODE_ADDON_API=${NODE_ADDON_API_DIR:-$(find /tmp/dshcli/node_modules/node-addon-api -maxdepth 0 2>/dev/null || true)}
# 能力检查而不是存在检查：本地 dshcli 里的老版本能编译大半文件，却缺
# string_view 重载（String::New(env, std::string_view)），错误藏在最后一屏。
if [ ! -f "$NODE_ADDON_API/napi.h" ] || ! grep -q 'std::string_view& val' "$NODE_ADDON_API/napi-inl.h" 2>/dev/null; then
  # 拉最新的（支持 string_view）
  TMP=$(mktemp -d)
  npm pack node-addon-api@latest --pack-destination "$TMP" >/dev/null
  tar xzf "$TMP"/node-addon-api-*.tgz -C "$TMP" --strip-components=1
  NODE_ADDON_API="$TMP"
fi

echo "== compiling android-arm64 require_builtin.node (napi-v9, static libc++)"
mkdir -p "$OUT_ROOT/prebuilt"
# -lnode（DT_NEEDED libnode.so）是关键：Android 上 libnode 由 System.loadLibrary
# 加载（dlopen 不带 RTLD_GLOBAL），其 napi_* 符号对后续 dlopen 的 addon 不可见
# （设备日志：cannot locate symbol "napi_create_type_error"）。把 libnode 声明为
# addon 的 DT_NEEDED 依赖后，bionic 沿依赖图解析符号，直接复用已加载的实例。
# 前提：libnode.so 必须带 SONAME（patchelf --set-soname libnode.so，见 07-harmonyos.md）。
# 产品身份：这份源码同时编 require-builtin 与 internal-loader 两个产品
# （product_config.h），缺省是 internal-loader —— 不传这个宏，加载器的
# getNativeBindingInfo() 校验会报 "expected require-builtin, got
# internal-loader"（实测）。
"$CXX" -shared -fPIC -std=c++17 -Os -static-libstdc++ \
  -I"$NODE_SRC/src" -I"$NODE_SRC/deps/v8/include" -I"$NODE_SRC/deps/uv/include" \
  -I"$NODE_ADDON_API" \
  -DNAPI_VERSION=9 \
  -DNODE_ADDON_API_DISABLE_CPP_EXCEPTIONS \
  -DNARB_PRODUCT=NARB_PRODUCT_REQUIRE_BUILTIN \
  -fno-exceptions -fvisibility=hidden \
  -Wl,--no-as-needed -L"$LIBNODE_DIR" -lnode \
  $(ls "$SRC_REPO"/src/*.cc "$SRC_REPO"/src/runtime_context/*.cc "$SRC_REPO"/src/runtime_probe/*.cc) \
  -o "$OUT_ROOT/prebuilt/android-arm64-napi-v9.node"

RE="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf"
echo "== verify: ELF arch / NEEDED / exported symbols"
"$RE" -d "$OUT_ROOT/prebuilt/android-arm64-napi-v9.node" | grep NEEDED
"$RE" -d "$OUT_ROOT/prebuilt/android-arm64-napi-v9.node" | grep -q 'libnode.so' \
  || { echo "FATAL: addon 没有链接上 libnode.so（DT_NEEDED 缺失）——可见性修复未生效" >&2; exit 1; }
"$RE" --dyn-syms "$OUT_ROOT/prebuilt/android-arm64-napi-v9.node" | grep napi_register_module_v1
ls -la "$OUT_ROOT/prebuilt/"
echo "== done. 下一步：node tools/pack-runtime.mjs 重打 runtime.zip"
