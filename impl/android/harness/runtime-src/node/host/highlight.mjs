// Syntax highlighting, tokenizer-only.
// A full grammar per language is not worth the bytes: fence languages in chat
// are overwhelmingly js/ts/py/sh/json/html/css, and a token-level regex pass
// gets ~95% of the visual result at ~2% of the cost.
const COMMON = {
  com: /^(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/,
  str: /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/,
  num: /^(0x[\da-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?)/,
};

const JS_KW = /^(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|in|of|try|catch|finally|throw|async|await|yield|import|export|from|default|delete|void|interface|type|enum|implements|public|private|protected|readonly|as|satisfies|declare|namespace)\b/;
const JS_LIT = /^(?:true|false|null|undefined|NaN|Infinity)\b/;
const JS_FN = /^([A-Za-z_$][\w$]*)(?=\s*\()/;
const JS_TYPE = /^([A-Z][\w$]*)/;
const JS_PROP = /^([A-Za-z_$][\w$]*)(?=\s*:)/;

const PY_KW = /^(?:def|class|return|if|elif|else|for|while|break|continue|import|from|as|try|except|finally|raise|with|lambda|yield|global|nonlocal|pass|assert|async|await|in|is|not|and|or)\b/;
const PY_LIT = /^(?:True|False|None|self)\b/;

const SH_KW = /^(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|echo|cd|source|set|unset|exit)\b/;
const SH_VAR = /^(\$\{[^}]*\}|\$[\w@#?*!-]+)/;

const CSS_PROP = /^([a-z-]+)(?=\s*:)/;

const KEYWORDS = {
  js: JS_KW, ts: JS_KW, jsx: JS_KW, tsx: JS_KW, json: /^(?:true|false|null)\b/, mjs: JS_KW, cjs: JS_KW,
  py: PY_KW, python: PY_KW, sh: SH_KW, bash: SH_KW, zsh: SH_KW, shell: SH_KW,
};

const ALIAS = {
  javascript: 'js', typescript: 'ts', tsx: 'tsx', jsx: 'jsx', node: 'js', mjs: 'js',
  python: 'py', bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  yml: 'yaml', 'c++': 'cpp', golang: 'go',
};

export const normalizeLang = (lang) => {
  const l = String(lang || '').toLowerCase().trim();
  return ALIAS[l] || l;
};

/** @returns {{t: string, v: string}[]} t ∈ plain|kw|lit|str|num|com|fn|type|prop|tag|attr|punct|add|del|meta */
export function highlight(code, lang) {
  const l = normalizeLang(lang);
  const src = String(code ?? '');
  if (!src) return [];
  if (l === 'diff' || l === 'patch') return highlightDiff(src);
  if (l === 'html' || l === 'xml' || l === 'svg' || l === 'vue') return highlightMarkup(src);

  const kw = KEYWORDS[l];
  const isCss = l === 'css' || l === 'scss' || l === 'less';
  const out = [];
  let rest = src;

  const push = (t, v) => { if (v) out.push({ t, v }); };

  while (rest.length) {
    let m;
    if (l === 'py' && (m = rest.match(/^#[^\n]*/))) { push('com', m[0]); rest = rest.slice(m[0].length); continue; }
    if (l === 'sh' && (m = rest.match(/^#[^\n]*/))) { push('com', m[0]); rest = rest.slice(m[0].length); continue; }
    if (isCss && (m = rest.match(/^\/\*[\s\S]*?\*\//))) { push('com', m[0]); rest = rest.slice(m[0].length); continue; }
    if (!isCss && (m = rest.match(COMMON.com))) { push('com', m[0]); rest = rest.slice(m[0].length); continue; }

    if (isCss && (m = rest.match(/^[.#][\w-]+/))) { push('type', m[0]); rest = rest.slice(m[0].length); continue; }
    if (isCss && (m = rest.match(CSS_PROP))) { push('prop', m[0]); rest = rest.slice(m[0].length); continue; }
    if (isCss && (m = rest.match(/^#[0-9a-fA-F]{3,8}\b/))) { push('num', m[0]); rest = rest.slice(m[0].length); continue; }

    if ((m = rest.match(COMMON.str))) { push('str', m[0]); rest = rest.slice(m[0].length); continue; }
    if (l === 'py' && (m = rest.match(/^(?:"""[\s\S]*?"""|'''[\s\S]*?''')/))) { push('str', m[0]); rest = rest.slice(m[0].length); continue; }
    if ((kw && (m = rest.match(kw))) || (l === 'json' && (m = rest.match(/^(?:true|false|null)\b/)))) { push('kw', m[0]); rest = rest.slice(m[0].length); continue; }
    if (l === 'py' && (m = rest.match(PY_LIT))) { push('lit', m[0]); rest = rest.slice(m[0].length); continue; }
    if ((l === 'js' || l === 'ts' || l === 'tsx' || l === 'jsx' || l === 'json') && (m = rest.match(JS_LIT))) { push('lit', m[0]); rest = rest.slice(m[0].length); continue; }
    if (l === 'sh' && (m = rest.match(SH_VAR))) { push('prop', m[0]); rest = rest.slice(m[0].length); continue; }
    if ((m = rest.match(COMMON.num))) { push('num', m[0]); rest = rest.slice(m[0].length); continue; }
    if ((l === 'js' || l === 'ts' || l === 'tsx' || l === 'jsx') && (m = rest.match(JS_FN))) { push('fn', m[0]); rest = rest.slice(m[0].length); continue; }
    if ((l === 'js' || l === 'ts' || l === 'tsx' || l === 'jsx') && (m = rest.match(JS_PROP))) { push('prop', m[0]); rest = rest.slice(m[0].length); continue; }
    if ((l === 'js' || l === 'ts' || l === 'tsx' || l === 'jsx' || l === 'go' || l === 'java' || l === 'cpp' || l === 'rs') && (m = rest.match(JS_TYPE))) { push('type', m[0]); rest = rest.slice(m[0].length); continue; }

    // Consume a run of uninteresting characters in one go.
    const plain = rest.match(/^[^\w"'`/$#]+/) || rest.match(/^[\w]+/) || [rest[0]];
    push('plain', plain[0]);
    rest = rest.slice(plain[0].length);
  }
  return mergePlain(out);
}

function highlightDiff(src) {
  return src.split('\n').map((line) => {
    if (/^(\+\+\+|---)/.test(line)) return { t: 'meta', v: line + '\n' };
    if (/^@@/.test(line)) return { t: 'meta', v: line + '\n' };
    if (/^\+/.test(line)) return { t: 'add', v: line + '\n' };
    if (/^-/.test(line)) return { t: 'del', v: line + '\n' };
    return { t: 'plain', v: line + '\n' };
  });
}

function highlightMarkup(src) {
  const out = [];
  const re = /(<!--[\s\S]*?-->)|(<\/?)([\w-:]+)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)(\s*\/?>)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: 'plain', v: src.slice(last, m.index) });
    if (m[1]) { out.push({ t: 'com', v: m[1] }); last = re.lastIndex; continue; }
    out.push({ t: 'punct', v: m[2] });
    out.push({ t: 'tag', v: m[3] });
    const attrRe = /([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?/g;
    let a;
    while ((a = attrRe.exec(m[4] || ''))) {
      out.push({ t: 'attr', v: a[1] });
      if (a[2]) out.push({ t: 'punct', v: a[2] });
      if (a[3]) out.push({ t: 'str', v: a[3] });
    }
    out.push({ t: 'punct', v: m[5] });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ t: 'plain', v: src.slice(last) });
  return out;
}

function mergePlain(tokens) {
  const out = [];
  for (const t of tokens) {
    if (t.t === 'plain' && out.length && out[out.length - 1].t === 'plain') out[out.length - 1].v += t.v;
    else out.push(t);
  }
  return out;
}

export const TOKEN_COLORS = {
  kw: '#c678dd',
  lit: '#d19a66',
  str: '#98c379',
  num: '#d19a66',
  com: '#7f848e',
  fn: '#61afef',
  type: '#e5c07b',
  prop: '#e06c75',
  tag: '#e06c75',
  attr: '#d19a66',
  punct: '#abb2bf',
  meta: '#56b6c2',
  add: '#98c379',
  del: '#e06c75',
  plain: '#abb2bf',
};

export default { highlight, normalizeLang, TOKEN_COLORS };
