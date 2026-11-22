#!/usr/bin/env bash
# Builds and runs the libnode runner against the host's libnode.so.
#
# Why a host build at all: this sandbox has no KVM, so the Android arm64 build
# cannot be executed here. node_runner.cc is platform-neutral on purpose — the
# same file is compiled by the NDK for the APK — so running it against the
# distro libnode is a real test of argv/env/cwd, stdout capture, natural exit and
# graceful shutdown. The JNI glue and the Android linker namespace are the only
# parts this cannot cover, and that is stated in impl/README.md rather than
# implied away.
#
# One case per process: libnode cannot be started twice in one process (node
# tears down its V8 platform on exit, and a second start crashes inside v8).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
src="$here/../android/runtime/src/main/cpp"
out="${1:-/tmp/node_runner_host_test}"

host_include=${NODE_INCLUDE:-/usr/include/node}
host_libdir=${NODE_LIBDIR:-/usr/lib/x86_64-linux-gnu}

if [ ! -f "$host_include/node.h" ]; then
  echo "node headers not found at $host_include (apt-get install libnode-dev)" >&2
  exit 1
fi

g++ -std=c++17 -O1 -g -Wall -Wextra -Wno-deprecated-declarations \
  -I"$host_include" \
  "$src/node_runner.cc" "$src/host_runner_test.cc" \
  -L"$host_libdir" -lnode -luv -lpthread -ldl \
  -o "$out"

status=0
for c in 1 2 3 4 5 6 7 8 9 10; do
  if ! LD_LIBRARY_PATH="$host_libdir" "$out" --case "$c"; then
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo
  echo "all 10 libnode host cases passed"
else
  echo
  echo "FAILURES above" >&2
fi
exit "$status"
