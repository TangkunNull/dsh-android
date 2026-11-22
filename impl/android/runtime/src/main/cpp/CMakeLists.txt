cmake_minimum_required(VERSION 3.22.1)
project(dsh_node_runtime CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# libnode.so is prebuilt (nodejs-mobile, arm64-v8a) and arrives with its own v8
# and libuv headers. We compile against those exact headers: mixing a distro v8
# header with this binary would break struct layouts silently, which is the sort
# of bug that only shows up as a segfault deep inside v8.
add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
    IMPORTED_LOCATION ${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

add_library(dsh_node SHARED
    node_runner.cc
    jni_bridge.cc)

# Only node/include, never node/include/uv: that directory contains libuv's own
# errno.h, and putting it on the include path makes libc++'s <cerrno> resolve to
# it — every ECONNREFUSED-style constant disappears and the STL header fails to
# compile. uv.h finds its sub-headers through "uv/..." relative includes.
target_include_directories(dsh_node PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/node/include)

target_compile_options(dsh_node PRIVATE
    -Wall -Wextra -Wno-unused-parameter -Wno-deprecated-declarations)

target_link_libraries(dsh_node
    node
    android
    log)

# Google Play requires 16 KB page support since Nov 2025 (decisions.md §3.3).
# The prebuilt libnode.so here is still 4 KB-aligned, so the *loader* will use
# 4 KB pages for its segments regardless of this flag; setting it on our own
# library at least keeps our segments from being the ones that break on a 16 KB
# kernel. The real fix is rebuilding libnode — see tools/build_libnode_android.sh
# and the note in impl/README.md.
# --no-undefined: a shared library links happily with unresolved symbols, and
# the failure would only appear as a dlopen error on the device. Turning it into
# a link error is what makes "the JNI bridge resolves against libnode.so" a fact
# the build checks, not a claim in a document.
target_link_options(dsh_node PRIVATE
    "-Wl,--no-undefined"
    "-Wl,-z,max-page-size=16384")
