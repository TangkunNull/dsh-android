#!/usr/bin/env bash
# 构建两个 app 模块，并校验那些「错了也不报错」的点。
#
#   bash impl/tools/build_apk.sh            # 探针宿主 ai.dsh.probe（默认，行为与旧版一致）
#   bash impl/tools/build_apk.sh flutter    # Flutter 壳 ai.dsh.app（主产品）
#   bash impl/tools/build_apk.sh all        # 两个都构建
#
# 探针宿主（impl/android，AGP 8.5.2 + Gradle 8.7）验证的是 libnode/解压/沙箱探测这条
# 底层通路：native 库打进去了、JNI 库真的链着 libnode、服务真的在自己的进程里。
# 链接本身就是最强的检查：CMake 传 -Wl,--no-undefined，缺 node/v8 符号时构建就失败，
# 而不是等到没人盯着的时候在设备上 dlopen 失败。
#
# Flutter 壳（impl/app/android，AGP 7.4.2 + Gradle 7.6.3，Flutter 3.0 的硬约束）才是
# 交付给用户的 UI。它的坑不在代码，在工具链：必须 JDK 17、必须覆盖 aapt2、必须指定
# target-platform。这三件事错一个，报错信息都指向别处，所以在脚本里前置拦。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
android="$here/../android"
flutter_app="$here/../app"
GRADLE=${GRADLE:-/root/gradle-dist/gradle-8.7/bin/gradle}
SDK=${ANDROID_SDK_ROOT:-/root/android-tools/sdk}
AAPT2="$SDK/build-tools/35.0.0/aapt2"
ZIPALIGN="$SDK/build-tools/35.0.0/zipalign"

# 失败时指明是哪一步，不要让人从一屏 gradle 日志里猜。
STEP=初始化
step() { STEP=$1; printf '\n===== %s =====\n' "$STEP"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
trap 'code=$?; if [ "$code" -ne 0 ]; then printf "\n构建失败：步骤「%s」（退出码 %s）\n" "$STEP" "$code" >&2; fi; exit "$code"' ERR

# 临时目录统一登记，`all` 下两个分支各建一个，最后一个 EXIT 兜底删干净。
tmpdirs=()
cleanup() { for d in "${tmpdirs[@]}"; do rm -rf "$d"; done; }
trap cleanup EXIT

# ── 探针宿主（默认目标，逻辑保持原样）───────────────────────────────────────
build_probe() {
  export JAVA_HOME=${JAVA_HOME:-/root/.sdkman/candidates/java/current}
  export ANDROID_HOME=${ANDROID_HOME:-/root/android-tools/sdk}
  export ANDROID_SDK_ROOT="$ANDROID_HOME"

  # The harness runs from assets, so src/ and assets/ drifting apart means the APK
  # ships last week's protocol code and the failure looks like a host bug. Fail
  # here instead.
  step "harness assets in sync with src/"
  node "$here/sync-harness-assets.mjs" --check

  step "gradle :app:assembleDebug (探针宿主 ai.dsh.probe)"
  cd "$android"
  "$GRADLE" :app:assembleDebug --console=plain "$@"

  apk="$android/app/build/outputs/apk/debug/app-debug.apk"
  [ -f "$apk" ] || fail "APK not produced"

  work=$(mktemp -d)
  tmpdirs+=("$work")
  unzip -q -o "$apk" "lib/*" "assets/*" -d "$work"

  echo
  echo "== packaged native libraries"
  ls -la "$work/lib/arm64-v8a/"

  echo
  echo "== harness entry + protocol modules packaged"
  # harness.js lives INSIDE runtime.zip, not as a bare asset: the unpacker is the
  # only consumer, and a bare copy would be a second source of truth that nothing
  # reads. So the check opens the zip rather than looking for a loose file.
  [ -f "$work/assets/runtime.zip" ] || fail "  assets/runtime.zip missing"
  for f in harness.js node/host/bridge-server.mjs node/host/protocol/session-link.mjs \
           node/host/protocol/transport-inproc.mjs runtime.json; do
    if unzip -l "$work/assets/runtime.zip" "$f" >/dev/null 2>&1; then
      echo "  ok    runtime.zip!$f"
    else
      fail "  $f missing from runtime.zip"
    fi
  done
  # A bare copy under assets/ means someone re-added the old extraction path.
  if [ -f "$work/assets/harness.js" ]; then
    fail "  bare assets/harness.js present — remove it, it is the second source of truth"
  fi

  echo
  echo "== required libs present"
  for lib in libnode.so libdsh_node.so libc++_shared.so; do
    if [ -f "$work/lib/arm64-v8a/$lib" ]; then
      echo "  ok    $lib"
    else
      fail "  $lib missing from the APK"
    fi
  done

  READELF="$ANDROID_HOME/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf"
  [ -x "$READELF" ] || READELF=$(command -v llvm-readelf)

  echo
  echo "== libdsh_node.so -> libnode.so"
  "$READELF" -d "$work/lib/arm64-v8a/libdsh_node.so" | grep -q "libnode.so" \
    && echo "  ok    DT_NEEDED includes libnode.so" \
    || fail "  libdsh_node.so does not depend on libnode.so"

  # libnode.so 的 napi_* 导出数：被 --strip-all 剥过头时 .dynsym 也没了，症状是
  # 装机后 dlsym 找不到 napi_*，只报一句没有行号的 UnsatisfiedLinkError。145 是 full 版基线。
  napi=$("$READELF" --dyn-syms -W "$work/lib/arm64-v8a/libnode.so" 2>/dev/null \
         | awk '/ napi_/ && !/ UND /' | wc -l | tr -d ' ')
  [ "${napi:-0}" -ge 140 ] \
    && echo "  ok    napi_* 导出 $napi 个" \
    || fail "  libnode.so 只导出 ${napi:-0} 个 napi_*（应有 145；strip 过头或放错了库）"

  echo
  echo "== page alignment (16 KB)"
  # A 4 KB-aligned LOAD segment is not a warning: on an Android 15 device with
  # 16 KB pages the linker refuses the library outright, and with jniLibs
  # useLegacyPackaging the failure surfaces as a bare UnsatisfiedLinkError with
  # no mention of alignment. So this gate is hard by default; --allow-misaligned
  # exists only for local experiments with the old prebuilt libnode.
  bad=0
  for lib in libdsh_node.so libnode.so libc++_shared.so; do
    f="$work/lib/arm64-v8a/$lib"
    [ -f "$f" ] || continue
    aligns=$("$READELF" -lW "$f" | awk '/LOAD/ {print $NF}' | sort -u | tr '\n' ' ')
    printf '  %-18s %s\n' "$lib" "$aligns"
    case "$aligns" in
      *0x4000*) : ;;
      *) bad=1 ;;
    esac
  done
  if [ "$bad" = 1 ]; then
    if [ "${ALLOW_MISALIGNED:-0}" = 1 ]; then
      echo "  WARN  some libraries are not 16 KB aligned (ALLOW_MISALIGNED=1)"
    else
      echo "  FAIL  at least one library is not 16 KB aligned." >&2
      echo "        Rebuild it: tools/build_libnode_android.sh <ndk> <node-src> --clean" >&2
      exit 1
    fi
  fi

  echo
  echo "== zipalign -c -P 16 (uncompressed .so at 16 KB boundaries)"
  [ -x "$ZIPALIGN" ] || ZIPALIGN=$(command -v zipalign || true)
  if [ -n "$ZIPALIGN" ]; then
    if "$ZIPALIGN" -c -P 16 -v 4 "$apk" >/tmp/zipalign_check.txt 2>&1; then
      echo "  ok    $(grep -c 'OK' /tmp/zipalign_check.txt || true) entries verified"
    else
      echo "  FAIL  zip entries are misaligned:" >&2
      tail -5 /tmp/zipalign_check.txt | sed 's/^/        /' >&2
      exit 1
    fi
  else
    echo "  skip  zipalign not found"
  fi

  echo
  echo "== harness process"
  "$AAPT2" dump xmltree "$apk" --file AndroidManifest.xml \
    | grep -A4 "E: service" | grep -E "HarnessService|:harness" | sed 's/^/  /'

  echo
  echo "APK: $apk ($(du -h "$apk" | cut -f1))"
}

# ── Flutter 壳（主产品）────────────────────────────────────────────────────
build_flutter() {
  # 1) JDK 17。机器默认是 20，Gradle 7.6.3 不支持；它报的是
  #    "Unsupported class file major version 64"，跟 JDK 三个字毫无关系。
  step "检查 JDK 17"
  JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
  [ -x "$JAVA_HOME/bin/java" ] || fail "没有 $JAVA_HOME/bin/java，装 openjdk-17-jdk"
  jv=$("$JAVA_HOME/bin/java" -version 2>&1 | awk -F'"' '/version/ {print $2}')
  case "$jv" in
    17.*) echo "  ok    $JAVA_HOME ($jv)" ;;
    *) fail "需要 JDK 17，当前是 ${jv:-未知}（Gradle 7.6.3 只支持到 19，20 会报 major version 64）" ;;
  esac
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$PATH"

  # 2) SDK。aapt2 的覆盖在 impl/app/android/gradle.properties 里，这里只兜住
  #    SDK 路径本身；不覆盖 aapt2 时 AGP 7.4 读不了 API 35 的 android.jar。
  export ANDROID_SDK_ROOT=${ANDROID_SDK_ROOT:-/root/android-tools/sdk}
  export ANDROID_HOME="$ANDROID_SDK_ROOT"
  [ -x "$AAPT2" ] || fail "找不到 $AAPT2（aapt2 覆盖依赖 build-tools 35.0.0）"
  grep -q '^android\.aapt2FromMavenOverride=' "$flutter_app/android/gradle.properties" \
    || fail "gradle.properties 缺少 android.aapt2FromMavenOverride"
  echo "  ok    aapt2 override -> $(grep '^android\.aapt2FromMavenOverride=' "$flutter_app/android/gradle.properties" | cut -d= -f2)"

  # 3) jniLibs 里的 librg.so。不在这里自动构建：build_rg.sh 要访问 npm registry，
  #    构建脚本不该在离线机器上因为取不到包而失败。缺了就直接说清楚怎么补。
  step "librg.so / libdsh_pty.so 已在 jniLibs（build_rg.sh / build_pty.sh 的产物）"
  librg="$android/runtime/src/main/jniLibs/arm64-v8a/librg.so"
  [ -f "$librg" ] || fail "缺 $librg —— 先跑 tools/build_rg.sh（需要 npm registry）"
  echo "  ok    $(stat -c %s "$librg" 2>/dev/null || stat -f %z "$librg") bytes"

  libpty="$android/runtime/src/main/jniLibs/arm64-v8a/libdsh_pty.so"
  [ -f "$libpty" ] || fail "缺 $libpty —— 先跑 tools/build_pty.sh（NDK 交叉编译，不联网）"
  echo "  ok    libdsh_pty.so $(stat -c %s "$libpty" 2>/dev/null || stat -f %z "$libpty") bytes"

  # 4) zip 与 manifest 一致。先确认 runtime.zip 是当前输入打的，再编 APK；
  #    否则 APK 里装的是上一版闭包，问题要等到设备上才暴露。
  step "runtime.zip 与 manifest 一致 (pack-runtime --check)"
  node "$here/pack-runtime.mjs" --check

  # 5) 构建。--target-platform 不能省：缺了它 Flutter 会请求 armeabi_v7a_debug
  #    的引擎构件，本机缓存里没有，报错是一堆下载失败。
  step "flutter build apk --debug --target-platform android-arm64"
  [ -x /opt/flutter/bin/flutter ] || fail "没有 /opt/flutter/bin/flutter"
  ( cd "$flutter_app" && /opt/flutter/bin/flutter build apk --debug --target-platform android-arm64 )

  apk="$flutter_app/build/app/outputs/flutter-apk/app-debug.apk"
  [ -f "$apk" ] || fail "Flutter APK not produced: $apk"

  work=$(mktemp -d)
  tmpdirs+=("$work")
  unzip -q -o "$apk" "lib/*" "assets/*" -d "$work"
  libdir="$work/lib/arm64-v8a"

  echo
  echo "== packaged native libraries"
  ls -la "$libdir/"

  # 5a) runtime.zip 必须在，且必须是 Stored：它自己已经 deflate 过一次，
  #     APK 再压一遍只是浪费安装时的 CPU，还让 unzip -l 看不出真实体积。
  echo
  echo "== assets/runtime.zip present and Stored"
  [ -f "$work/assets/runtime.zip" ] || fail "assets/runtime.zip missing from the APK"
  line=$(unzip -lv "$apk" assets/runtime.zip | awk '$NF=="assets/runtime.zip"')
  echo "  $line"
  case "$line" in
    *Stored*) echo "  ok    Stored（未二次压缩）" ;;
    *) fail "assets/runtime.zip 不是 Stored（method=$(echo "$line" | awk '{print $2}')）" ;;
  esac

  # 5b) libnode.so 在。62 MB 的那个（strip 后），缺了整个宿主就是空壳。
  #     符号表没了不影响运行：dynsym 里 napi_*/node::* 全在，-lnode 链接与 dlsym 照常。
  echo
  echo "== libnode.so present"
  [ -f "$libdir/libnode.so" ] || fail "lib/arm64-v8a/libnode.so missing"
  echo "  ok    libnode.so ($(du -h "$libdir/libnode.so" | cut -f1))"

  # 库被 strip 过头（--strip-all）时 .dynsym 也没了，症状是装机后 dlsym 找不到
  # napi_*，报一句没有行号的 UnsatisfiedLinkError。145 个是 full 版的基线。
  napi=$("$READELF" --dyn-syms -W "$libdir/libnode.so" 2>/dev/null | awk '/ napi_/ && !/ UND /' | wc -l | tr -d ' ')
  [ "${napi:-0}" -ge 140 ] \
    && echo "  ok    napi_* 导出 $napi 个" \
    || fail "  libnode.so 只导出 ${napi:-0} 个 napi_*（应有 145；strip 过头或放错了库）"

  # 5c) 前台服务类型合规。targetSdk 35 下缺它，startForeground 在 Android 14+
  #     直接抛 MissingForegroundServiceTypeException。
  echo
  echo "== manifest: foregroundServiceType + FOREGROUND_SERVICE_SPECIAL_USE"
  tree=$("$AAPT2" dump xmltree "$apk" --file AndroidManifest.xml)
  echo "$tree" | grep -q 'foregroundServiceType' \
    && echo "  ok    foregroundServiceType 已声明" \
    || fail "manifest 缺 foregroundServiceType"
  echo "$tree" | grep -q 'FOREGROUND_SERVICE_SPECIAL_USE' \
    && echo "  ok    FOREGROUND_SERVICE_SPECIAL_USE 已声明" \
    || fail "manifest 缺 FOREGROUND_SERVICE_SPECIAL_USE"
  echo "$tree" | grep -o 'foregroundServiceType=0x[0-9a-f]*' | sort -u | sed 's/^/  /' || true

  # 5d) 页对齐。自家 4 个 .so 是硬门禁；libflutter.so 单独报——它是 Flutter 3.0
  #     引擎自带的预编译产物，4 KB 对齐由上游决定，本项目改不了（升 Flutter 才动得
  #     了，而 AGP 7.4 又钉住了 Flutter 版本）。把它当硬门禁等于这条分支永远红。
  echo
  echo "== page alignment (16 KB): 自家 4 个 .so 必须 0x4000"
  READELF="$ANDROID_SDK_ROOT/ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf"
  [ -x "$READELF" ] || READELF=$(command -v llvm-readelf)
  bad=0
  for lib in libnode.so libdsh_node.so libc++_shared.so libdsh-sandbox-runner.so libdsh_pty.so; do
    f="$libdir/$lib"
    [ -f "$f" ] || fail "$lib missing from the APK"
    aligns=$("$READELF" -lW "$f" | awk '/LOAD/ {print $NF}' | sort -u | tr '\n' ' ')
    printf '  %-26s %s\n' "$lib" "$aligns"
    case "$aligns" in
      *0x4000*) : ;;
      *) bad=1 ;;
    esac
  done
  [ "$bad" = 0 ] || fail "自家 .so 有不是 0x4000 的（16 KB 页设备上会直接拒绝加载）"

  # 5d-2) librg.so 是**外来**的静态可执行镜像，判据和上面不同：
  #       它必须仍然是无 PT_INTERP 的静态 ELF。AGP 的 strip 一旦把 PT_LOAD 拆坏，
  #       这里看不出来（对齐还是对的），但真机上 execve 之后立刻 SIGSEGV——所以
  #       对齐、静态、架构三条一起查，并且要求它没被改小（strip 过会掉字节）。
  echo
  echo "== librg.so (静态 ripgrep，真机 execve 的唯一途径)"
  rgf="$libdir/librg.so"
  [ -f "$rgf" ] || fail "librg.so missing from the APK（先跑 tools/build_rg.sh）"
  rgbytes=$(stat -c %s "$rgf" 2>/dev/null || stat -f %z "$rgf")
  printf '  %-26s %s bytes\n' "librg.so" "$rgbytes"
  [ "$rgbytes" -gt 4000000 ] || fail "librg.so 只有 $rgbytes 字节，像是被 strip 过（源 4771240）"
  if "$READELF" -lW "$rgf" | grep -q INTERP; then
    fail "librg.so 带 PT_INTERP：动态链接的 rg 在 bionic 上找不到 loader，execve 必失败"
  fi
  echo "  ok    静态（无 PT_INTERP）"
  rga=$("$READELF" -lW "$rgf" | awk '/LOAD/ {print $NF}' | sort -u | tr '\n' ' ')
  printf '  %-26s %s\n' "librg.so LOAD align" "$rga"
  case "$rga" in
    *0x10000*|*0x20000*|*0x40000*|*0x80000*) echo "  ok    ≥16 KB 对齐" ;;
    *0x4000*) echo "  ok    16 KB 对齐" ;;
    *) fail "librg.so 的 LOAD 对齐 $rga 小于 0x4000" ;;
  esac
  "$READELF" -h "$rgf" | grep -q 'AArch64' || fail "librg.so 不是 aarch64"

  # Flutter 引擎不在我们手里，只报事实，不当门禁。
  if [ -f "$libdir/libflutter.so" ]; then
    fa=$("$READELF" -lW "$libdir/libflutter.so" | awk '/LOAD/ {print $NF}' | sort -u | tr '\n' ' ')
    printf '  %-26s %s\n' "libflutter.so" "$fa"
    case "$fa" in
      *0x4000*) echo "  ok    libflutter.so 也是 0x4000" ;;
      *) echo "  WARN  libflutter.so 只有 4 KB 对齐（Flutter 3.0 引擎现状，16 KB 页设备会拒绝加载）" ;;
    esac
  fi

  # 6) 产物落 out/，与探针的 out/dsh-app-debug.apk 并排。
  step "复制产物到 out/dsh-flutter-debug.apk"
  mkdir -p "$here/../../out"
  cp -f "$apk" "$here/../../out/dsh-flutter-debug.apk"

  echo
  echo "APK: $apk ($(du -h "$apk" | cut -f1))"
  echo "OUT: $here/../../out/dsh-flutter-debug.apk"
}

# ── 参数分派 ───────────────────────────────────────────────────────────────
# 第一个参数只认 probe/flutter/all；其他一律当 gradle 参数传给探针，
# 这样 `build_apk.sh --stacktrace` 这类旧用法不会突然变成「未知目标」。
target=probe
case "${1:-}" in
  probe|flutter|all) target=$1; shift ;;
esac

case "$target" in
  probe)   build_probe "$@" ;;
  flutter) build_flutter ;;
  all)     build_probe "$@"; build_flutter ;;
esac
