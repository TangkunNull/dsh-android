// Markdown -> React. Not a spec-complete parser: it covers what chat output
// actually contains (headings, lists, fences, tables, quotes, inline marks) and
// degrades to plain text for everything else instead of dropping content.
import * as React from 'react';

const h = React.createElement;

// --- block parsing ---------------------------------------------------------

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const UL = /^(\s*)([-*+])\s+(.*)$/;
const OL = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{0,}:?\s*\|?\s*$/;

const indentOf = (s) => s.match(/^\s*/)[0].replace(/\t/g, '  ').length;

export function parseMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const [, , marker, lang] = fence;
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{3,}\\s*$`).test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1; // closing fence (or EOF while streaming)
      blocks.push({ type: 'code', lang: lang || '', text: body.join('\n') });
      continue;
    }

    const head = line.match(HEADING);
    if (head) { blocks.push({ type: 'heading', level: head[1].length, text: head[2].trim() }); i += 1; continue; }

    if (HR.test(line)) { blocks.push({ type: 'hr' }); i += 1; continue; }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) { body.push(lines[i].replace(QUOTE, '')); i += 1; }
      blocks.push({ type: 'quote', children: parseMarkdown(body.join('\n')) });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head2 = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(cells(lines[i])); i += 1; }
      blocks.push({ type: 'table', head: head2, rows });
      continue;
    }

    const ul = line.match(UL);
    const ol = line.match(OL);
    if (ul || ol) {
      const ordered = !!ol;
      const baseIndent = indentOf(line);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(UL) || lines[i].match(OL);
        if (!m) break;
        if (indentOf(lines[i]) < baseIndent) break;
        const content = m[3];
        const nested = [];
        i += 1;
        while (i < lines.length && lines[i].trim() && indentOf(lines[i]) > baseIndent) {
          nested.push(lines[i].slice(Math.min(indentOf(lines[i]), baseIndent + 2)));
          i += 1;
        }
        items.push({ text: content, children: nested.length ? parseMarkdown(nested.join('\n')) : null });
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', items, start: ordered ? Number((line.match(OL) || [])[2]) || 1 : 1 });
      continue;
    }

    // paragraph: consume until a blank line or another block starter
    const para = [];
    while (i < lines.length && lines[i].trim()
      && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !HR.test(lines[i])
      && !QUOTE.test(lines[i]) && !UL.test(lines[i]) && !OL.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) {
      para.push(lines[i]);
      i += 1;
    }
    if (para.length) blocks.push({ type: 'paragraph', text: para.join('\n') });
  }
  return blocks;
}

// --- inline parsing --------------------------------------------------------

const INLINE_RE = /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(([^)\s]+)[^)]*\)|\[([^\]]*)\]\(([^)\s]+)[^)]*\)|(\*\*|__)([\s\S]+?)\7|(\*|_)([\s\S]+?)\9|~~([\s\S]+?)~~|\$([^$\n]+)\$|(https?:\/\/[^\s<>)]+)/g;

export function parseInline(text) {
  const out = [];
  let last = 0;
  const src = String(text ?? '');
  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(src))) {
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) });
    if (m[1]) out.push({ t: 'code', v: m[2] });
    else if (m[3] !== undefined) out.push({ t: 'image', alt: m[3], src: m[4] });
    else if (m[5] !== undefined) out.push({ t: 'link', v: m[5], href: m[6] });
    else if (m[7]) out.push({ t: 'strong', v: m[8] });
    else if (m[9]) out.push({ t: 'em', v: m[10] });
    else if (m[11] !== undefined) out.push({ t: 'del', v: m[11] });
    else if (m[12] !== undefined) out.push({ t: 'math', v: m[12] });
    else if (m[13]) out.push({ t: 'autolink', href: m[13] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) });
  return out;
}

const COLORS = {
  code: '#b45309',
  link: 'var(--dsw-alias-brand-primary)',
  strong: undefined,
};

export function renderInline(text, keyPrefix = 'i') {
  const parts = parseInline(text);
  return parts.map((p, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (p.t) {
      case 'code':
        return h('span', { key, className: 'md-code', style: { fontFamily: 'monospace', fontSize: '0.92em', paddingLeft: 3, paddingRight: 3, paddingTop: 1, paddingBottom: 1, borderRadius: 4, backgroundColor: 'rgba(127,127,127,0.14)', color: COLORS.code } }, p.v);
      case 'strong': return h('span', { key, style: { fontWeight: 700 } }, p.v);
      case 'em': return h('span', { key, style: { fontStyle: 'italic' } }, p.v);
      case 'del': return h('span', { key, style: { textDecoration: 'line-through', opacity: 0.7 } }, p.v);
      case 'math': return h('span', { key, className: 'md-math', style: { fontFamily: 'monospace', color: '#7c3aed' } }, p.v);
      case 'link': return h('a', { key, href: p.href, className: 'md-link', style: { color: COLORS.link, textDecoration: 'underline' } }, p.v);
      case 'autolink': return h('a', { key, href: p.href, className: 'md-link', style: { color: COLORS.link, textDecoration: 'underline' } }, p.href);
      case 'image': return h('img', { key, src: p.src, alt: p.alt, className: 'md-image', style: { maxWidth: '100%', borderRadius: 8 } });
      default: {
        // Soft line breaks inside a paragraph are spaces, hard breaks (two spaces) are real.
        const lines = String(p.v).split('\n');
        if (lines.length === 1) return p.v;
        const nodes = [];
        lines.forEach((l, n) => {
          if (n > 0) nodes.push(h('br', { key: `${key}-br-${n}` }));
          nodes.push(l);
        });
        return h('span', { key }, nodes);
      }
    }
  });
}

export default { parseMarkdown, parseInline, renderInline };
