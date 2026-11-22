// One selector engine, two adapters.
//
// The same CSS reaches us through two doors: `querySelector` on the shadow DOM
// and `resolveStyle` on the IR tree. Writing the matcher twice guarantees they
// drift, so the matcher only knows a tiny adapter interface:
//
//   { tag, id, classes[], attr(name), parent(), prev(), index(), count(), children() }
//
// dom.mjs implements it over real elements, css.mjs over IR nodes.

const CACHE = new Map();

const COMPOUND_RE = /(\*)|(^[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([^\]]*)\]|::?([\w-]+)(\([^)]*\))?/g;

function splitTop(str, sep) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of str) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseAttr(raw) {
  const m = raw.match(/^\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*([iIsS])?)?\s*$/);
  if (!m) return { name: raw.trim(), op: null, value: null };
  return { name: m[1], op: m[2] || null, value: m[3] ?? m[4] ?? m[5] ?? null, ci: (m[6] || '').toLowerCase() === 'i' };
}

function parseCompound(src) {
  const comp = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  COMPOUND_RE.lastIndex = 0;
  let m;
  while ((m = COMPOUND_RE.exec(src))) {
    if (m[1]) comp.tag = '*';
    else if (m[2]) comp.tag = m[2].toLowerCase();
    else if (m[3]) comp.id = m[3];
    else if (m[4]) comp.classes.push(m[4]);
    else if (m[5] !== undefined) comp.attrs.push(parseAttr(m[5]));
    else if (m[6]) comp.pseudos.push({ name: m[6].toLowerCase(), arg: m[7] ? m[7].slice(1, -1) : null });
  }
  return comp;
}

/** "a > .b + c" -> [{comp:a}, {comb:'>',comp:.b}, {comb:'+',comp:c}] */
export function parseComplex(src) {
  const tokens = src.trim().replace(/\s*([>+~])\s*/g, '$1').split(/\s+|(?=[>+~])|(?<=[>+~])/).filter(Boolean);
  const chain = [];
  let comb = ' ';
  for (const tok of tokens) {
    if (tok === '>' || tok === '+' || tok === '~') { comb = tok; continue; }
    chain.push({ comb, comp: parseCompound(tok) });
    comb = ' ';
  }
  return chain;
}

export function parseSelectorList(sel) {
  const key = String(sel);
  if (CACHE.has(key)) return CACHE.get(key);
  const parsed = splitTop(key, ',').map((s) => parseComplex(s)).filter((c) => c.length);
  if (CACHE.size > 4000) CACHE.clear();
  CACHE.set(key, parsed);
  return parsed;
}

// --- matching --------------------------------------------------------------

function nthMatch(expr, index) {
  if (index < 1) return false;
  const e = String(expr).trim().toLowerCase();
  if (e === 'odd') return index % 2 === 1;
  if (e === 'even') return index % 2 === 0;
  const m = e.match(/^([+-]?\d*)n\s*(?:([+-])\s*(\d+))?$/);
  if (m) {
    const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : Number(m[1]);
    const b = m[2] ? Number(m[2] + m[3]) : 0;
    if (a === 0) return index === b;
    const n = (index - b) / a;
    return Number.isInteger(n) && n >= 0;
  }
  return index === Number(e);
}

function attrMatch(node, a) {
  const v = node.attr(a.name);
  if (v == null) return false;
  if (!a.op) return true;
  const lhs = a.ci ? String(v).toLowerCase() : String(v);
  const rhs = a.ci && a.value != null ? a.value.toLowerCase() : a.value;
  switch (a.op) {
    case '=': return lhs === rhs;
    case '~=': return lhs.split(/\s+/).includes(rhs);
    case '^=': return rhs !== '' && lhs.startsWith(rhs);
    case '$=': return rhs !== '' && lhs.endsWith(rhs);
    case '*=': return rhs !== '' && lhs.includes(rhs);
    case '|=': return lhs === rhs || lhs.startsWith(`${rhs}-`);
    default: return false;
  }
}

// Interaction states can never be true during a static render.
const NEVER = new Set(['hover', 'active', 'focus-visible', 'focus-within', 'target', 'visited', 'focus']);

function pseudoMatch(node, p) {
  const idx = () => node.index();
  switch (p.name) {
    case 'not': return !parseSelectorList(p.arg).some((c) => matchesChain(c, node));
    case 'is': case 'where': case 'matches': return parseSelectorList(p.arg).some((c) => matchesChain(c, node));
    case 'has': return (node.children?.() || []).some((c) => parseSelectorList(p.arg).some((cc) => matchesChain(cc, c))
      || (node.children?.() || []).some((gc) => parseSelectorList(p.arg).some((cc) => matchesChain(cc, gc))));
    case 'first-child': return idx() === 1;
    case 'last-child': return idx() > 0 && idx() === node.count();
    case 'only-child': return node.count() === 1;
    case 'first-of-type': case 'last-of-type': case 'nth-of-type': return true; // over-match on purpose
    case 'nth-child': return nthMatch(p.arg, idx());
    case 'nth-last-child': return idx() > 0 && nthMatch(p.arg, node.count() - idx() + 1);
    case 'empty': return (node.children?.() || []).length === 0;
    case 'root': return node.parent() == null;
    case 'disabled': { const v = node.attr('disabled'); return v != null && v !== 'false'; }
    case 'enabled': { const v = node.attr('disabled'); return v == null || v === 'false'; }
    case 'checked': { const v = node.attr('checked') ?? node.attr('aria-checked'); return v === '' || v === 'true'; }
    case 'read-only': return node.attr('readonly') != null;
    case 'read-write': return node.attr('readonly') == null;
    case 'required': return node.attr('required') != null;
    case 'link': case 'any-link': return node.attr('href') != null;
    default: return NEVER.has(p.name) ? false : true;
  }
}

export function matchCompound(comp, node) {
  if (!node) return false;
  if (comp.tag && comp.tag !== '*' && comp.tag !== String(node.tag || '').toLowerCase()) return false;
  if (comp.id && comp.id !== node.id) return false;
  if (comp.classes.length) {
    const cls = node.classes || [];
    if (!comp.classes.every((c) => cls.includes(c))) return false;
  }
  for (const a of comp.attrs) if (!attrMatch(node, a)) return false;
  for (const p of comp.pseudos) if (!pseudoMatch(node, p)) return false;
  return true;
}

export function matchesChain(chain, node, i = chain.length - 1) {
  if (!node || i < 0) return false;
  if (!matchCompound(chain[i].comp, node)) return false;
  if (i === 0) return true;
  const comb = chain[i].comb;
  if (comb === '>') {
    const p = node.parent();
    return !!p && matchesChain(chain, p, i - 1);
  }
  if (comb === '+') {
    const s = node.prev();
    return !!s && matchesChain(chain, s, i - 1);
  }
  if (comb === '~') {
    let s = node.prev();
    while (s) { if (matchesChain(chain, s, i - 1)) return true; s = s.prev(); }
    return false;
  }
  let p = node.parent();
  while (p) { if (matchesChain(chain, p, i - 1)) return true; p = p.parent(); }
  return false;
}

export function matchesSelector(node, sel) {
  return parseSelectorList(sel).some((c) => matchesChain(c, node));
}

/** Specificity: (ids, classes/attrs/pseudo-classes, tags). */
export function specificity(sel) {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const chain of parseSelectorList(sel)) {
    for (const { comp } of chain) {
      if (comp.id) a += 1;
      b += comp.classes.length + comp.attrs.length + comp.pseudos.filter((p) => p.name !== 'where').length;
      if (comp.tag && comp.tag !== '*') c += 1;
    }
  }
  return a * 10000 + b * 100 + c;
}
