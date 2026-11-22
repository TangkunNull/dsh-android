// Copies the Node modules the harness actually needs into the packaging input
// tree (`runtime-src/`, NOT `assets/`): AGP ships everything under assets into
// the APK, so a copy there would put harness.js in the package twice — once bare,
// once inside runtime.zip — and editing one while the device runs the other is
// the hardest kind of bug to see.
//
// Why copy instead of bundle: the harness runs inside libnode in a separate
// process, and a bundle destroys per-module stack traces — which is the only
// debugging surface that process has (no debugger, no REPL). Copying keeps
// `file:line` meaningful.
//
// `--check` exists so CI can fail when someone edits `src/` and forgets this
// step; without it the APK runs last week's protocol code and the failure looks
// like a host bug.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src', 'host');
const DEST = path.join(ROOT, 'android', 'harness', 'runtime-src', 'node', 'host');

/** Only what the entry point reaches; the UI renderer is not needed here. */
const FILES = [
  'bridge-server.mjs',
  'protocol/codec.mjs',
  'protocol/normalize.mjs',
  'protocol/transport.mjs',
  'protocol/transport-inproc.mjs',
  'protocol/session-link.mjs',
];

function readIfExists(p) {
  try { return fs.readFileSync(p); } catch { return null; }
}

export function plan() {
  return FILES.map((rel) => ({
    rel,
    from: path.join(SRC, rel),
    to: path.join(DEST, rel),
  }));
}

export function sync({ check = false } = {}) {
  const drift = [];
  for (const f of plan()) {
    const src = readIfExists(f.from);
    if (src === null) throw new Error(`missing source: ${f.from}`);
    const cur = readIfExists(f.to);
    if (check) {
      if (cur === null || !cur.equals(src)) drift.push(f.rel);
      continue;
    }
    fs.mkdirSync(path.dirname(f.to), { recursive: true });
    fs.writeFileSync(f.to, src);
  }
  if (check && drift.length > 0) {
    throw new Error(
      `harness assets are stale: ${drift.join(', ')}\nrun: node impl/tools/sync-harness-assets.mjs`,
    );
  }
  return { files: FILES.length, drift };
}

// Only run when invoked directly, so tests can import `plan()`.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const check = process.argv.includes('--check');
  try {
    const r = sync({ check });
    if (check) console.log(`harness assets ok (${r.files} files)`);
    else console.log(`copied ${r.files} files -> ${path.relative(ROOT, DEST)}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
