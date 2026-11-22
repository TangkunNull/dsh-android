// What a plugin's client half actually asks the browser for.
//
// `plugin.mjs` classifies capabilities with a regex over the bundle, which is
// deliberately blunt: it answers "does this plugin touch <iframe>" and nothing
// more. That was enough while every one of them was unsupported, but the matrix
// now distinguishes srcdoc (we can render it) from an external src (we cannot),
// so the blunt answer is no longer the useful one.
//
// This scanner looks at the *call sites* instead: `createElement('iframe', {...})`
// / `jsx('iframe', {...})` and the props that follow. react-dom's
// `possibleStandardNames` table also mentions `srcDoc`, so plain grep over the
// bundle reports every React app as an iframe user — that table is filtered out
// by requiring an actual element creation.
import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', 'fixtures', 'plugins');

const entryOf = (d) => {
  const p = join(root, d, 'package.json');
  if (existsSync(p)) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8'));
      if (pkg.entry) return join(root, d, pkg.entry);
    } catch { /* fall through */ }
  }
  return join(root, d, 'client.js');
};

/** `createElement("iframe", {…})` in source, `(0, react.createElement)("iframe", {…})`
 *  after a CJS bundle rewrite — the call may be detached from its callee by `)(`. */
const CALL = /(?:createElement|_?jsx)\)?\(\s*["']iframe["']\s*,\s*\{/g;

/** Walk braces from `{` back to its `}` so props are read to the end, not 200 chars. */
function propsAt(src, openBrace) {
  let depth = 0;
  for (let i = openBrace; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(openBrace, i + 1);
    }
  }
  return src.slice(openBrace, openBrace + 400);
}

export function scanFile(file) {
  const src = readFileSync(file, 'utf8');
  const sites = [];
  CALL.lastIndex = 0;
  let m;
  while ((m = CALL.exec(src))) {
    const brace = src.indexOf('{', m.index + m[0].length - 1);
    const props = propsAt(src, brace);
    const line = src.slice(0, m.index).split('\n').length;
    const kind = /\bsrcDoc\s*:/.test(props) ? 'srcdoc' : /\bsrc\s*:/.test(props) ? 'src' : 'unknown';
    const sandbox = /\bsandbox\s*:/.test(props);
    sites.push({ line, kind, sandbox, snippet: props.replace(/\s+/g, ' ').slice(0, 120) });
  }
  // `contenteditable` / `video` / `audio` use the same blunt detection as
  // plugin.mjs; only iframe needs the call-site treatment here.
  return { file, sites };
}

const dirs = readdirSync(root).filter((d) => existsSync(entryOf(d)));
const rows = [];
for (const d of dirs.sort()) {
  const { sites } = scanFile(entryOf(d));
  if (!sites.length) continue;
  const kinds = [...new Set(sites.map((s) => s.kind))];
  rows.push({ plugin: d, sites });
  void kinds;
}

const summary = { srcdoc: 0, src: 0, unknown: 0, plugins: rows.length };
for (const r of rows) {
  const kinds = new Set(r.sites.map((s) => s.kind));
  for (const k of kinds) summary[k] += 1;
}

const lines = [];
lines.push('# iframe 用法扫描');
lines.push('');
lines.push('> 生成：`node tools/ability-scan.mjs`。扫的是 `fixtures/plugins/*/client.js` 里');
lines.push('> `createElement("iframe", {…})` 的调用点，不是整包 grep —— react-dom 的');
lines.push('> `possibleStandardNames` 表里也有 `srcDoc`，整包 grep 会把每个 React 应用都算成');
lines.push('> iframe 使用者。');
lines.push('');
lines.push(`样本：${rows.length} 个插件有 iframe 调用点。`);
lines.push('');
lines.push('| 插件 | 行 | 类型 | sandbox | 片段 |');
lines.push('|---|---|---|---|---|');
for (const r of rows) {
  for (const s of r.sites) {
    lines.push(`| ${r.plugin} | ${s.line} | ${s.kind} | ${s.sandbox ? 'yes' : '—'} | \`${s.snippet.replace(/\|/g, '\\|')}\` |`);
  }
}
lines.push('');
lines.push('## 结论');
lines.push('');
lines.push(`- **srcdoc**：${summary.srcdoc} 个插件（能渲染，走 \`src/frame.mjs\`）`);
lines.push(`- **外链 src**：${summary.src} 个插件（要真去加载一个 URL，仍不支持）`);
lines.push(`- 两类都有的插件按两种都记。`);
lines.push('');
lines.push('`core-demo` 是样本里唯一有 iframe 调用点的插件，它的文件预览栏有三种模态：');
lines.push('');
lines.push('- **HTML 预览**走 `srcDoc: doc`，其中 `doc` 来自 `buildStaticHtml`：');
lines.push('  `new DOMParser().parseFromString(...)` 消毒（删禁用标签、剥危险属性、插 CSP）');
lines.push('  之后整段塞进 `sandbox=""` 的 iframe。这条链路的两个前置 —— `DOMParser`（');
lines.push('  `src/dom.mjs` 的 `DshDOMParser`）与 srcdoc 物化（§11）—— 都已实现。');
lines.push('- **PDF / Office 预览**走 `src: url`（blob / 工作区 URL），需要真的去加载一个');
lines.push('  网页，仍不支持。');
lines.push('');
lines.push('所以它在矩阵里既可能是 A（HTML 预览）也可能是 B（PDF 预览），取决于当前渲染');
lines.push('的是哪一路；分级器按渲染结果判定（`countFrames`），不再按静态 cap 猜。');
lines.push('');

const out = join(here, '..', '..', 'docs', 'evidence', 'iframe-usage.md');
writeFileSync(out, lines.join('\n'));
console.log(lines.join('\n'));
console.log(`\n写入 ${out}`);
