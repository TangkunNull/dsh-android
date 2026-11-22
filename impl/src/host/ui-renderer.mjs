// @deepseek-ai/dsh-client-ui-renderer — content rendering (Markdown, code, diff,
// tables, images). Everything here is layout + text; there is no HTML anywhere.
import * as React from 'react';
import { parseMarkdown, renderInline } from './md.mjs';
import { highlight, TOKEN_COLORS, normalizeLang } from './highlight.mjs';
import { T, cx } from './primitives.mjs';

const h = React.createElement;

const BASE = 14;
const LINE = 1.62;

const blockStyle = {
  display: 'block',
  fontSize: BASE,
  lineHeight: LINE,
  color: T.fg,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const HEADING_SIZE = { 1: 22, 2: 19, 3: 17, 4: 15, 5: 14, 6: 13 };

function Block({ children, style }) {
  return h('div', { style: { ...blockStyle, ...style } }, children);
}

export function CodeBlock({ code, lang = '', showHeader = true, maxHeight }) {
  const tokens = highlight(code, lang);
  const lines = String(code ?? '').split('\n').length;
  return h('div', {
    className: 'md-codeblock',
    'data-lang': normalizeLang(lang) || 'text',
    style: {
      display: 'flex', flexDirection: 'column',
      borderRadius: 10, overflow: 'hidden', backgroundColor: '#282c34',
      borderWidth: 1, borderColor: 'rgba(0,0,0,0.10)',
    },
  },
  showHeader ? h('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, paddingRight: 8, paddingTop: 6, paddingBottom: 6, backgroundColor: 'rgba(255,255,255,0.04)' },
  },
  h('span', { style: { fontSize: 11, color: '#9aa4b2', textTransform: 'uppercase', letterSpacing: 0.6 } }, normalizeLang(lang) || 'text'),
  h('button', {
    className: 'md-copy',
    onClick: () => globalThis.__dshCopy?.(code),
    style: { fontSize: 11, color: '#9aa4b2', backgroundColor: 'transparent', borderWidth: 0, padding: 4 },
  }, '复制')) : null,
  h('div', {
    style: { maxHeight, overflowX: 'auto', overflowY: maxHeight ? 'auto' : undefined, padding: 12 },
  },
  h('span', {
    style: {
      fontSize: 12.5, lineHeight: 1.55, fontFamily: 'monospace', whiteSpace: 'pre',
      color: TOKEN_COLORS.plain, display: 'block',
    },
  }, tokens.map((t, i) => h('span', { key: i, style: { color: TOKEN_COLORS[t.t] || TOKEN_COLORS.plain } }, t.v))),
  h('span', { style: { display: 'none' } }, `${lines} lines`)));
}

export function InlineCode({ children }) {
  return h('span', {
    style: { fontFamily: 'monospace', fontSize: '0.92em', paddingLeft: 3, paddingRight: 3, borderRadius: 4, backgroundColor: 'rgba(127,127,127,0.14)', color: '#b45309' },
  }, children);
}

export function DiffView({ patch = '', filename }) {
  const lines = String(patch).replace(/\r\n?/g, '\n').split('\n');
  let adds = 0;
  let dels = 0;
  for (const l of lines) { if (/^\+[^+]/.test(l)) adds += 1; if (/^-[^-]/.test(l)) dels += 1; }
  return h('div', {
    className: 'md-diff',
    style: { display: 'flex', flexDirection: 'column', borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: T.border, backgroundColor: T.bg1 },
  },
  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: 8, backgroundColor: T.bg2, borderBottomWidth: 1, borderBottomColor: T.border2 } },
    h('span', { style: { flexGrow: 1, fontSize: 12, fontFamily: 'monospace', color: T.fg2 } }, filename || 'diff'),
    h('span', { style: { fontSize: 11, color: T.ok } }, `+${adds}`),
    h('span', { style: { fontSize: 11, color: T.danger } }, `-${dels}`)),
  h('div', { style: { display: 'flex', flexDirection: 'column', padding: 8, overflowX: 'auto' } },
    lines.map((l, i) => {
      const add = /^\+/.test(l) && !/^\+\+\+/.test(l);
      const del = /^-/.test(l) && !/^---/.test(l);
      const meta = /^(@@|\+\+\+|---|diff |index )/.test(l);
      return h('span', {
        key: i,
        style: {
          display: 'block', fontSize: 12, lineHeight: 1.5, fontFamily: 'monospace', whiteSpace: 'pre',
          color: meta ? '#56b6c2' : add ? '#1a7f37' : del ? '#cf222e' : T.fg2,
          backgroundColor: add ? 'rgba(26,127,55,0.09)' : del ? 'rgba(207,34,46,0.08)' : 'transparent',
        },
      }, l || ' ');
    })));
}

export function DataTable({ head = [], rows = [] }) {
  const cols = Math.max(head.length, ...rows.map((r) => r.length), 1);
  const cell = { flexGrow: 1, flexBasis: 0, minWidth: 80, paddingLeft: 8, paddingRight: 8, paddingTop: 6, paddingBottom: 6, fontSize: 12.5, color: T.fg };
  return h('div', {
    className: 'md-table',
    style: { display: 'flex', flexDirection: 'column', borderRadius: 8, borderWidth: 1, borderColor: T.border, overflowX: 'auto' },
  },
  h('div', { style: { display: 'flex', backgroundColor: T.bg2, borderBottomWidth: 1, borderBottomColor: T.border } },
    Array.from({ length: cols }, (_, i) => h('span', { key: i, style: { ...cell, fontWeight: 600, color: T.fg2 } }, head[i] ?? ''))),
  rows.map((r, ri) => h('div', {
    key: ri,
    style: { display: 'flex', borderBottomWidth: ri === rows.length - 1 ? 0 : 1, borderBottomColor: T.border2, backgroundColor: ri % 2 ? 'transparent' : T.bg2 },
  }, Array.from({ length: cols }, (_, ci) => h('span', { key: ci, style: cell }, renderInline(r[ci] ?? '', `c${ri}-${ci}`))))));
}

export function ImageBlock({ src, alt = '', caption }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
    h('img', { src, alt, style: { maxWidth: '100%', borderRadius: 8, backgroundColor: T.bg3 } }),
    caption || alt ? h('span', { style: { fontSize: 11, color: T.fg3, textAlign: 'center' } }, caption || alt) : null);
}

export function MathBlock({ formula }) {
  return h('div', {
    className: 'md-math-block',
    style: { padding: 12, borderRadius: 8, backgroundColor: T.bg2, borderWidth: 1, borderColor: T.border2 },
  }, h('span', { style: { fontFamily: 'monospace', fontSize: 13, color: '#7c3aed', whiteSpace: 'pre-wrap' } }, formula));
}

/** Markdown -> native blocks. `maxCodeHeight` keeps long snippets from eating
 *  the whole transcript. */
export function Markdown({ text, maxCodeHeight = 320, className }) {
  const blocks = parseMarkdown(text);
  if (!blocks.length) return null;
  return h('div', { className: cx('md', className), style: { display: 'flex', flexDirection: 'column', gap: 8 } },
    blocks.map((b, i) => renderBlock(b, i, maxCodeHeight)));
}

function renderBlock(b, key, maxCodeHeight) {
  switch (b.type) {
    case 'heading':
      return h(Block, { key, style: { fontSize: HEADING_SIZE[b.level] || 14, fontWeight: b.level <= 3 ? 600 : 500, lineHeight: 1.35, marginTop: b.level <= 2 ? 6 : 2 } }, renderInline(b.text, `h${key}`));
    case 'paragraph':
      return h(Block, { key }, renderInline(b.text, `p${key}`));
    case 'code':
      return h(CodeBlock, { key, code: b.text, lang: b.lang, maxHeight: maxCodeHeight });
    case 'hr':
      return h('div', { key, style: { height: 1, width: '100%', backgroundColor: T.border2 } });
    case 'quote':
      return h('div', {
        key,
        style: { display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: T.border, opacity: 0.9 },
      }, b.children.map((cb, i) => renderBlock(cb, `${key}-${i}`, maxCodeHeight)));
    case 'ul':
    case 'ol': {
      const items = b.items.map((it, i) => {
        const marker = b.type === 'ol' ? `${b.start + i}.` : '•';
        const inner = [
          h(Block, { key: 'text' }, renderInline(it.text, `li${key}-${i}`)),
          ...(it.children || []).map((cb, ci) => renderBlock(cb, `${key}-${i}-${ci}`, maxCodeHeight)),
        ];
        return h('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
          h('span', { style: { fontSize: BASE, lineHeight: LINE, color: T.fg3, minWidth: 18, textAlign: 'right' } }, marker),
          h('div', { style: { flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 4 } }, inner));
      });
      return h('div', { key, style: { display: 'flex', flexDirection: 'column', gap: 4 } }, items);
    }
    case 'table':
      return h(DataTable, { key, head: b.head, rows: b.rows });
    default:
      return null;
  }
}

export default { Markdown, CodeBlock, InlineCode, DiffView, DataTable, ImageBlock, MathBlock };
