// Error isolation (B-8 / E-6): one plugin's render must never blank the page.
// React error boundaries do the catching; this module supplies the fallback card
// and the reporting hook into the plugin runtime.
import * as React from 'react';

const h = React.createElement;

const TONE = {
  render: { title: '插件渲染失败', color: '#ef4444', bg: 'rgba(239,68,68,0.06)' },
  capability: { title: '该功能在手机上不可用', color: '#f59e0b', bg: 'rgba(245,158,11,0.06)' },
  perf: { title: '插件已降级运行', color: '#f59e0b', bg: 'rgba(245,158,11,0.06)' },
  disabled: { title: '插件已禁用', color: '#6b7280', bg: 'rgba(107,114,128,0.06)' },
};

/** The user-facing placeholder. Deliberately self-contained: it cannot import
 *  the primitives package, because that package is a common failure source. */
export function ProblemCard({ title, detail, hint, tone = 'render', actionLabel, onAction }) {
  const t = TONE[tone] || TONE.render;
  return h('div', {
    className: 'dsh-problem',
    'data-tone': tone,
    style: {
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: 10, borderRadius: 10, borderWidth: 1, borderColor: t.color,
      backgroundColor: t.bg,
    },
  },
  h('span', { style: { fontSize: 12.5, fontWeight: 600, color: t.color } }, title || t.title),
  detail ? h('span', { style: { fontSize: 11.5, color: '#6b7280', lineHeight: 1.45 } }, detail) : null,
  hint ? h('span', { style: { fontSize: 11, color: '#9ca3af' } }, hint) : null,
  onAction
    ? h('button', {
      onClick: onAction,
      style: { alignSelf: 'flex-start', marginTop: 4, paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4, borderRadius: 6, borderWidth: 1, borderColor: t.color, backgroundColor: 'transparent', color: t.color, fontSize: 11.5 },
    }, actionLabel || '重试')
    : null);
}

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error: error || new Error('unknown render error') };
  }

  componentDidCatch(error, info) {
    this.props.onError?.(error, info);
  }

  reset() { this.setState({ error: null }); }

  render() {
    const { error } = this.state;
    if (error) {
      const { fallback, label } = this.props;
      if (typeof fallback === 'function') return fallback(error, () => this.reset());
      return h(ProblemCard, {
        tone: 'render',
        detail: `${label ? `${label}: ` : ''}${error.message || String(error)}`,
        hint: '其他功能不受影响。插件作者可在桌面端查看完整堆栈。',
        onAction: () => this.reset(),
      });
    }
    return this.props.children ?? null;
  }
}

/** Wrap one slot entry. Reports to the plugin runtime so repeated failures
 *  quarantine the plugin instead of retrying forever. */
export function pluginBoundary(Component, { pluginId, runtime, label, onError } = {}) {
  return function BoundedEntry(props) {
    return h(ErrorBoundary, {
      label: label || pluginId,
      fallback: (error, reset) => h(ProblemCard, {
        tone: 'render',
        title: '插件渲染失败',
        detail: `${label || pluginId}: ${error.message || String(error)}`,
        hint: '已隔离，不影响会话内容',
        onAction: reset,
      }),
      onError: (error, info) => {
        runtime?.fail?.(pluginId, error);
        onError?.(error, info);
      },
    }, h(Component, props));
  };
}

/** Shown when a plugin needs canvas/video/iframe before P3.5 lands, or when the
 *  native side has no bridge for the capability. */
export function CapabilityNotice({ capability, fallback }) {
  return h(ProblemCard, {
    tone: 'capability',
    detail: capability ? `该插件使用了 ${capability}，原生渲染层尚未接入。` : undefined,
    hint: fallback ? `降级显示：${fallback}` : '已使用占位区域，插件其余功能可正常使用。',
  });
}

export default { ErrorBoundary, pluginBoundary, ProblemCard, CapabilityNotice };
