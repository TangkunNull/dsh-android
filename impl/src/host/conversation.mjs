// @deepseek-ai/dsh-client-ui-conversation — message stream, bubbles, thinking,
// tool cards, approvals, composer. Layout comes from the desktop component; only
// the pixels are decided by Flutter.
import * as React from 'react';
import { T, Button, IconButton, Badge, Spinner, Icon, Card, Divider, Row, cx } from './primitives.mjs';
import { Markdown, CodeBlock } from './ui-renderer.mjs';

const h = React.createElement;

const ROLE_META = {
  user: { label: '你', align: 'flex-end', bg: 'rgba(59,130,246,0.10)', fg: T.fg, maxWidth: '86%' },
  assistant: { label: 'dsh', align: 'flex-start', bg: 'transparent', fg: T.fg, maxWidth: '100%' },
  system: { label: '系统', align: 'center', bg: T.bg2, fg: T.fg3, maxWidth: '100%' },
  tool: { label: '工具', align: 'flex-start', bg: 'transparent', fg: T.fg2, maxWidth: '100%' },
};

export function TypingDots({ size = 4 }) {
  return h('div', { className: 'dsh-typing', style: { display: 'flex', alignItems: 'center', gap: 3, paddingTop: 6, paddingBottom: 6 } },
    [0, 1, 2].map((i) => h('span', { key: i, style: { width: size, height: size, borderRadius: size, backgroundColor: T.fg3, opacity: 1 - i * 0.25 } })));
}

export function StreamingCursor() {
  return h('span', { className: 'dsh-cursor', style: { display: 'inline-block', width: 2, height: 14, marginLeft: 2, backgroundColor: T.brand } });
}

export function Message({
  role = 'assistant', content = '', name, timestamp, status, actions, avatar,
  streaming, children, className, style,
}) {
  const meta = ROLE_META[role] || ROLE_META.assistant;
  const isUser = role === 'user';
  return h('div', {
    className: cx('dsh-message', `dsh-message-${role}`, className),
    'data-role': role,
    'data-streaming': streaming ? 'true' : undefined,
    style: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: meta.align, width: '100%', ...style },
  },
  (name || role !== 'user') && role !== 'system'
    ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      avatar,
      h('span', { style: { fontSize: 11, color: T.fg3 } }, name || meta.label),
      timestamp ? h('span', { style: { fontSize: 11, color: T.fg3, opacity: 0.7 } }, timestamp) : null)
    : null,
  h('div', {
    style: {
      maxWidth: meta.maxWidth, paddingLeft: isUser ? 12 : 0, paddingRight: isUser ? 12 : 0,
      paddingTop: isUser ? 8 : 0, paddingBottom: isUser ? 8 : 0,
      borderRadius: isUser ? 14 : 0, backgroundColor: meta.bg, color: meta.fg,
    },
  },
  typeof content === 'string' && content
    ? (isUser ? h('span', { style: { fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, content) : h(Markdown, { text: content }))
    : null,
  children,
  streaming ? h(StreamingCursor, null) : null),
  status === 'error' ? h('span', { style: { fontSize: 11, color: T.danger } }, '生成失败') : null,
  actions ? h('div', { style: { display: 'flex', gap: 2, marginTop: 2 } }, actions) : null);
}

export function Thinking({ text = '', open = false, onToggle, durationMs, streaming }) {
  return h('div', {
    className: 'dsh-thinking',
    'data-open': open ? 'true' : 'false',
    style: { display: 'flex', flexDirection: 'column', borderRadius: 10, borderWidth: 1, borderColor: T.border2, backgroundColor: T.bg2 },
  },
  h('button', {
    className: 'dsh-thinking-head',
    onClick: onToggle,
    style: { display: 'flex', alignItems: 'center', gap: 6, padding: 8, backgroundColor: 'transparent', borderWidth: 0, textAlign: 'left' },
  },
  h(Icon, { name: open ? 'chevronDown' : 'chevronRight', size: 12, color: T.fg3 }),
  streaming ? h(Spinner, { size: 12, color: T.fg3 }) : null,
  h('span', { style: { flexGrow: 1, fontSize: 12, color: T.fg2 } },
    streaming ? '正在思考' : `思考过程${durationMs ? ` · ${(durationMs / 1000).toFixed(1)}s` : ''}`)),
  open ? h('div', { style: { paddingLeft: 10, paddingRight: 10, paddingBottom: 10, paddingTop: 0 } },
    h('span', { style: { fontSize: 12.5, lineHeight: 1.6, color: T.fg2, whiteSpace: 'pre-wrap' } }, text)) : null);
}

const TOOL_STATUS = {
  running: { tone: 'brand', label: '运行中' },
  ok: { tone: 'ok', label: '完成' },
  error: { tone: 'danger', label: '失败' },
  pending: { tone: 'neutral', label: '待执行' },
  denied: { tone: 'warn', label: '已拒绝' },
};

export function ToolCall({ name = 'tool', args, result, status = 'ok', error, durationMs, open = false, onToggle, className }) {
  const st = TOOL_STATUS[status] || TOOL_STATUS.ok;
  const argText = typeof args === 'string' ? args : args ? JSON.stringify(args, null, 2) : '';
  const resText = typeof result === 'string' ? result : result ? JSON.stringify(result, null, 2) : '';
  return h('div', {
    className: cx('dsh-tool', className),
    'data-status': status,
    style: { display: 'flex', flexDirection: 'column', borderRadius: 10, borderWidth: 1, borderColor: T.border, backgroundColor: T.bg1, overflow: 'hidden' },
  },
  h('button', {
    className: 'dsh-tool-head',
    onClick: onToggle,
    style: { display: 'flex', alignItems: 'center', gap: 8, padding: 9, backgroundColor: 'transparent', borderWidth: 0, textAlign: 'left' },
  },
  h(Icon, { name: 'spark', size: 13, color: T.fg3 }),
  h('span', { style: { fontSize: 13, fontWeight: 500, color: T.fg, fontFamily: 'monospace' } }, name),
  status === 'running' ? h(Spinner, { size: 11, color: T.brand }) : null,
  h('span', { style: { flexGrow: 1 } }),
  durationMs ? h('span', { style: { fontSize: 11, color: T.fg3 } }, `${durationMs}ms`) : null,
  h(Badge, { tone: st.tone }, st.label),
  h(Icon, { name: open ? 'chevronDown' : 'chevronRight', size: 12, color: T.fg3 })),
  open ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 9, borderTopWidth: 1, borderTopColor: T.border2 } },
    argText ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      h('span', { style: { fontSize: 11, color: T.fg3 } }, '参数'),
      h(CodeBlock, { code: argText, lang: 'json', showHeader: false, maxHeight: 200 })) : null,
    resText ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
      h('span', { style: { fontSize: 11, color: T.fg3 } }, '结果'),
      h(CodeBlock, { code: resText, lang: status === 'error' ? 'text' : 'json', showHeader: false, maxHeight: 260 })) : null,
    error ? h('span', { style: { fontSize: 12, color: T.danger } }, String(error.message || error)) : null) : null);
}

export function Approval({ title = '需要确认', detail, command, risk = 'normal', onAllow, onDeny, allowLabel = '允许', denyLabel = '拒绝', className }) {
  const tone = risk === 'high' ? T.danger : risk === 'low' ? T.ok : T.warn;
  return h('div', {
    className: cx('dsh-approval', className),
    'data-risk': risk,
    style: { display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: tone, backgroundColor: 'rgba(245,158,11,0.06)' },
  },
  h(Row, { gap: 6, align: 'center' },
    h(Icon, { name: 'warning', size: 14, color: tone }),
    h('span', { style: { fontSize: 13, fontWeight: 600, color: T.fg } }, title)),
  detail ? h('span', { style: { fontSize: 12.5, color: T.fg2, lineHeight: 1.5 } }, detail) : null,
  command ? h(CodeBlock, { code: command, lang: 'sh', showHeader: false, maxHeight: 160 }) : null,
  h(Row, { gap: 8, justify: 'flex-end' },
    h(Button, { variant: 'ghost', size: 'sm', onClick: onDeny }, denyLabel),
    h(Button, { variant: risk === 'high' ? 'danger' : 'primary', size: 'sm', onClick: onAllow }, allowLabel)));
}

export function ErrorNotice({ message, detail, onRetry, className }) {
  return h('div', {
    className: cx('dsh-error', className),
    style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)', backgroundColor: 'rgba(239,68,68,0.06)' },
  },
  h(Row, { gap: 6, align: 'center' },
    h(Icon, { name: 'warning', size: 13, color: T.danger }),
    h('span', { style: { flexGrow: 1, fontSize: 12.5, color: T.danger } }, message || '出错了')),
  detail ? h('span', { style: { fontSize: 11.5, color: T.fg3, fontFamily: 'monospace' } }, detail) : null,
  onRetry ? h(Row, { justify: 'flex-end' }, h(Button, { size: 'sm', variant: 'outline', onClick: onRetry }, '重试')) : null);
}

export function MessageList({ messages = [], streaming = false, onRetry, gap = 14, className }) {
  return h('div', {
    className: cx('dsh-messages', className),
    style: { display: 'flex', flexDirection: 'column', gap, paddingTop: 8, paddingBottom: 8 },
  }, messages.map((m, i) => {
    const isLast = i === messages.length - 1;
    if (m.kind === 'thinking') return h(Thinking, { key: m.id ?? i, ...m });
    if (m.kind === 'tool') return h(ToolCall, { key: m.id ?? i, ...m });
    if (m.kind === 'approval') return h(Approval, { key: m.id ?? i, ...m });
    if (m.kind === 'error') return h(ErrorNotice, { key: m.id ?? i, message: m.content, onRetry });
    return h(Message, {
      key: m.id ?? i,
      role: m.role, content: m.content, name: m.name, timestamp: m.timestamp, status: m.status,
      streaming: streaming && isLast && m.role === 'assistant',
    });
  }));
}

export function Composer({
  value = '', onChange, onSend, onStop, streaming, placeholder = '给 dsh 发消息…',
  left, right, attachments, disabled, hint, className, style,
}) {
  const canSend = !disabled && (String(value).trim().length > 0 || attachments?.length);
  return h('div', {
    className: cx('dsh-composer', className),
    style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 14, borderWidth: 1, borderColor: T.border, backgroundColor: T.bg1, boxShadow: '0 2px 12px rgba(0,0,0,0.06)', ...style },
  },
  attachments?.length ? h(Row, { gap: 6, wrap: true }, attachments.map((a, i) => h(Badge, { key: i, tone: 'neutral' }, a.name || a))) : null,
  h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 6 } },
    left,
    h('textarea', {
      className: 'dsh-composer-input',
      value: value,
      placeholder,
      rows: 1,
      onChange: (e) => onChange?.(e?.target?.value ?? e),
      onKeyDown: (e) => { if (e?.key === 'Enter' && !e?.shiftKey) onSend?.(); },
      style: { flexGrow: 1, minHeight: 24, maxHeight: 132, paddingTop: 4, paddingBottom: 4, fontSize: 14, lineHeight: 1.5, color: T.fg, backgroundColor: 'transparent', borderWidth: 0, whiteSpace: 'pre-wrap' },
    }),
    right),
  h(Row, { gap: 6, align: 'center' },
    h('span', { style: { flexGrow: 1, fontSize: 11, color: T.fg3 } }, hint || ''),
    streaming
      ? h(IconButton, { icon: h(Icon, { name: 'stop', size: 14, color: T.fg }), label: '停止', active: true, onClick: onStop, size: 30 })
      : h(IconButton, {
        icon: h(Icon, { name: 'send', size: 15, color: canSend ? T.inv : T.fg3 }),
        label: '发送', onClick: canSend ? onSend : undefined, size: 30,
        style: { backgroundColor: canSend ? T.brand : T.bg3, borderRadius: 15 },
      })));
}

export function EmptyChat({ title = '开始新的对话', description, suggestions = [], onPick }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 32 } },
    h('span', { style: { fontSize: 15, fontWeight: 600, color: T.fg } }, title),
    description ? h('span', { style: { fontSize: 12.5, color: T.fg3, textAlign: 'center' } }, description) : null,
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 360, marginTop: 8 } },
      suggestions.map((s, i) => h(Card, { key: i, padding: 10 }, h('button', {
        onClick: () => onPick?.(s),
        style: { width: '100%', textAlign: 'left', fontSize: 13, color: T.fg, backgroundColor: 'transparent', borderWidth: 0 },
      }, s)))));
}

export { Divider };

export default {
  MessageList, Message, Thinking, ToolCall, Approval, ErrorNotice, Composer,
  EmptyChat, StreamingCursor, TypingDots,
};
