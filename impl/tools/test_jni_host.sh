#!/usr/bin/env bash
# Exercises the JNI bridge from a real JVM, without Android.
#
# jni_bridge.cc only depends on jni.h, so it can be built as a host .so and
# driven by any JVM. That covers the part the host runner test misses by design:
# argument marshalling, attaching the pipe-reader threads to the VM, UTF-8 line
# conversion (including surrogate pairs), and callback delivery.
#
# It still does not cover ART itself — symbol lookup, thread attach and object
# references follow the same spec, but ART's linker namespace and the Android
# process model are not exercised here.
#
# Usage: ./test_jni_host.sh [workdir]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
src="$here/../android/runtime/src/main/cpp"
jnitest="$here/jni_test"
work=${1:-/tmp/dsh_jni_test}
mkdir -p "$work"

JAVA_HOME=${JAVA_HOME:-/root/.sdkman/candidates/java/current}
[ -x "$JAVA_HOME/bin/javac" ] || { echo "javac not found at $JAVA_HOME" >&2; exit 1; }

host_include=${NODE_INCLUDE:-/usr/include/node}
host_libdir=${NODE_LIBDIR:-/usr/lib/x86_64-linux-gnu}
[ -f "$host_include/node.h" ] || { echo "node headers missing (apt-get install libnode-dev)" >&2; exit 1; }

echo "== building host JNI library"
g++ -std=c++17 -O1 -g -Wall -Wextra -Wno-deprecated-declarations \
  -fPIC -shared -pthread \
  -I"$host_include" \
  -I"$JAVA_HOME/include" -I"$JAVA_HOME/include/linux" \
  "$src/jni_bridge.cc" "$src/node_runner.cc" \
  -L"$host_libdir" -lnode -luv -lpthread -ldl \
  -o "$work/libdsh_node_host.so"

echo "== compiling java harness"
rm -rf "$work/classes"; mkdir -p "$work/classes"
"$JAVA_HOME/bin/javac" -d "$work/classes" "$jnitest"/ai/dsh/runtime/*.java

echo "== exported JNI entry points"
nm -D --defined-only "$work/libdsh_node_host.so" | grep -E "Java_ai_dsh|JNI_OnLoad" | awk '{print "   " $3}'

status=0
for c in 1 2 3; do
  LD_LIBRARY_PATH="$host_libdir:${LD_LIBRARY_PATH:-}" \
    "$JAVA_HOME/bin/java" -cp "$work/classes" ai.dsh.runtime.NodeRuntimeJniTest \
      "$work/libdsh_node_host.so" "$c" "$work/run$c" || status=1
  # The JVM's own stdout is captured by the runtime, so the harness reports
  # through a file instead; print it once the process has exited.
  if [ -f "$work/run$c/report.txt" ]; then
    echo
    cat "$work/run$c/report.txt"
  else
    echo "  FAIL  case $c produced no report (check the exit code)" >&2
    status=1
  fi
done

echo
if [ "$status" = 0 ]; then echo "== all JNI cases passed"; else echo "== JNI cases failed"; fi
exit "$status"
