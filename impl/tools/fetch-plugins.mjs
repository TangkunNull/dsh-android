// Fetch real plugin client bundles into fixtures/plugins/ for the G3 matrix.
//
// npm is the source of truth (D3): the published tarball contains the built
// client half even when the repo does not. We read the manifest first, then pull
// exactly one file per plugin — 20 plugins is ~2 MB, not 200 MB of tarballs.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outRoot = join(here, '..', 'fixtures', 'plugins');

const QUERIES = ['dsh-plugin', 'dsh client plugin', 'deepseek harness plugin', 'dsh ui plugin'];
const TARGET = Number(process.env.TARGET || 24);
const MAX_BYTES = 4 * 1024 * 1024;

const slug = (name) => name.replace(/^@/, '').replace(/[^\w.-]+/g, '-').toLowerCase();

async function json(url, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', 'user-agent': 'dsh-native-p3' } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

async function text(url, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return null;
    return Buffer.from(buf).toString('utf8');
  } catch { return null; } finally { clearTimeout(t); }
}

function clientPath(pkg) {
  const ex = pkg.exports;
  const fromExports = typeof ex === 'object' && ex && (ex['./client'] || ex['./client.js']);
  const path = typeof fromExports === 'string'
    ? fromExports
    : fromExports?.default || fromExports?.import || null;
  if (path) return path.replace(/^\.\//, '');
  const dshClient = pkg.dsh?.client;
  if (typeof dshClient === 'string') return dshClient.replace(/^\.\//, '');
  if (dshClient?.entry) return String(dshClient.entry).replace(/^\.\//, '');
  return null;
}

async function searchAll() {
  const names = new Set();
  for (const q of QUERIES) {
    const res = await json(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=250`);
    for (const o of res?.objects || []) names.add(o.package.name);
  }
  return [...names];
}

/** Download a file and every relative module it imports (2 levels deep). ESM
 *  plugins ship their panel as sibling files; fetching only the entry gives a
 *  module graph with holes. */
async function fetchTree(name, ver, entryRel, into) {
  const seen = new Set();
  const queue = [[entryRel, 0]];
  let bytes = 0;
  let fetched = 0;
  while (queue.length && fetched < 28) {
    const [rel, depth] = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const urls = [
      `https://unpkg.com/${name}@${ver}/${rel}`,
      `https://cdn.jsdelivr.net/npm/${name}@${ver}/${rel}`,
    ];
    let code = null;
    for (const u of urls) { code = await text(u); if (code) break; }
    if (!code) continue;
    const dest = join(into, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, code);
    bytes += code.length;
    fetched += 1;
    if (depth >= 4 || !/\.(mjs|js|jsx|ts)$/.test(rel)) continue;
    const specRe = /(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
    let m;
    while ((m = specRe.exec(code))) {
      const resolved = posix.normalize(posix.join(posix.dirname(rel), m[1]));
      if (!seen.has(resolved)) queue.push([resolved, depth + 1]);
    }
  }
  return { bytes, fetched };
}

async function fetchOne(name) {
  const latest = await json(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}/latest`);
  if (!latest) return null;
  const dsh = latest.dsh || {};
  if (!dsh.client && !latest.exports?.['./client']) return null; // not a client plugin
  const rel = clientPath(latest);
  if (!rel) return null;
  const ver = latest.version;
  const dir = join(outRoot, slug(name));
  mkdirSync(dir, { recursive: true });
  const { bytes, fetched } = await fetchTree(name, ver, rel, dir);
  if (!bytes) return null;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name, version: ver, description: latest.description, dsh: latest.dsh,
    dependencies: latest.dependencies, entry: rel,
    source: `https://unpkg.com/${name}@${ver}/${rel}`,
  }, null, 2));
  if (rel !== 'client.js') { /* entry recorded in package.json */ }
  return { name, version: ver, bytes, files: fetched, dir, inject: latest.dsh?.client?.inject || [] };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      const r = await fn(items[idx], idx);
      if (r) out.push(r);
    }
  });
  await Promise.all(workers);
  return out;
}

const names = await searchAll();
console.log(`候选包: ${names.length}`);
mkdirSync(outRoot, { recursive: true });

// Prefer names that look like plugins, then take the rest: search relevance is
// good but not perfect, and a mixed sample is more honest evidence.
const ranked = names.sort((a, b) => {
  const score = (n) => (/^dsh-plugin-/.test(n) ? 0 : /dsh/.test(n) ? 1 : 2);
  return score(a) - score(b) || a.length - b.length;
});

const picked = [];
for (let i = 0; i < ranked.length && picked.length < TARGET; i += 8) {
  const batch = ranked.slice(i, i + 8);
  const got = await pool(batch, 6, async (n) => {
    if (existsSync(join(outRoot, slug(n), 'client.js'))) return { name: n, cached: true };
    return fetchOne(n);
  });
  for (const g of got) if (g) picked.push(g);
  console.log(`  进度: ${picked.length}/${TARGET} (试了 ${Math.min(i + 8, ranked.length)} 个)`);
}

console.log(`\n取到 ${picked.length} 个插件产物:`);
for (const p of picked) console.log(`  ${p.name}@${p.version} ${p.bytes ? `${(p.bytes / 1024).toFixed(0)} KB` : '(cached)'}`);
