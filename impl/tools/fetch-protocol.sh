#!/usr/bin/env bash
# Fetch the authoritative dsh wire-protocol type declarations from npm.
#
# Why this exists: A-9 must speak dsh's real loopback protocol, not an invented
# one. spec.md says "reuse the original loopback protocol", and the only source
# of truth for what that protocol *is* is the published `@deepseek-ai/*` packages.
# They ship `.d.ts` (contract) next to `.js` (implementation); we vendor only the
# declarations so the repo carries the contract without copying their code.
#
# The snapshot is versioned by these pins. When dsh publishes a new rc, bump a
# pin, re-run, and the diff shows exactly which wire surface moved.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${1:-protocol}"
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

# package -> version pin. Bump deliberately; a floating tag would let the
# contract move under us and turn protocol tests into noise.
declare -A PINS=(
  ["dsh-host-apiproxy"]="0.0.1-rc.1"
  ["dsh-client-connection"]="0.0.1-rc.1"
  ["dsh-session"]="0.0.1-rc.1"
  ["dsh-api-remotes"]="0.0.1-rc.1"
  # The question/answer contract. `dsh-user-interaction` is an internal
  # monorepo name that was never published (404); apiproxy's .d.ts still
  # imports it, which is exactly how a search for the type ends in the wrong
  # place. The published package is `dsh-user-questions`.
  ["dsh-user-questions"]="0.2.2-rc.1"
  ["dsh-tool-ask-user"]="0.2.2-rc.1"
)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$OUT"

for pkg in "${!PINS[@]}"; do
  ver="${PINS[$pkg]}"
  name="@deepseek-ai/$pkg"
  dest="$OUT/$pkg"
  mkdir -p "$dest"

  url="$REGISTRY/$name/-/$pkg-$ver.tgz"
  echo "== $name@$ver"
  if ! curl -fsSL "$url" -o "$work/$pkg.tgz"; then
    echo "   fetch failed: $url" >&2
    exit 1
  fi
  mkdir -p "$work/$pkg"
  tar xzf "$work/$pkg.tgz" -C "$work/$pkg" --strip-components=1

  # Contracts only: .d.ts files, plus package.json for the version stamp.
  ( cd "$work/$pkg" && find lib -name '*.d.ts' -print0 2>/dev/null ) \
    | while IFS= read -r -d '' f; do
        mkdir -p "$dest/$(dirname "$f")"
        cp "$work/$pkg/$f" "$dest/$f"
      done

  python3 - "$work/$pkg/package.json" "$dest/PIN.json" "$name" "$ver" <<'PY'
import json, sys
src, out, name, ver = sys.argv[1:5]
d = json.load(open(src))
json.dump({"name": name, "version": d.get("version", ver), "description": d.get("description")},
          open(out, "w"), indent=2, ensure_ascii=False)
PY
  echo "   $(find "$dest" -name '*.d.ts' | wc -l) declaration files"
done

echo
echo "Protocol snapshot written to $OUT/ (declarations only, no upstream code)."
echo "Read $OUT/README.md for the wire summary."
