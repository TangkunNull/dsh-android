// 最小复刻：原 P0 崩溃链（suspendOnActiveViewTransition is not a function）。
// 修好 host config 之前，本脚本以退出码 1 死亡、栈顶是
//   at completeRootWhenReady (react-reconciler.development.js:15817)
//   at listOnTimeout (node:internal/timers)
// —— 与 QA 在设备侧复现的栈完全一致。修复后：进程存活，retry 提交完成。
import * as React from 'react';
import { createRoot } from '../../src/reconciler.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 步骤 1+2 的载体：挂起一次、promise resolve 后重试的组件（插件里 Suspense
// 数据加载的常态）。
let resolveP;
const pending = new Promise((r) => { resolveP = r; });
pending.settled = false;
function Suspy() {
  if (!pending.settled) throw pending; // 抛 promise = 挂起，reconciler 会挂 ping
  return null;
}

const container = { children: [], onCommit: null };
// 步骤 1：挂起 → fallback 提交，reconciler 记下 globalMostRecentFallbackTime。
createRoot(container).render(
  React.createElement(React.Suspense, { fallback: React.createElement('box') }, React.createElement(Suspy)),
);
console.log('fallback committed, children=', container.children.length);

// 步骤 2：promise resolve → 边界 ping → retry lanes 进入 pending。
pending.settled = true;
resolveP();

// 步骤 3（对齐设备侧"重算导出与重试定时器重叠"）：立刻再起一个 root 做一次
// sync 渲染 —— flushSync 分支会把 root 上 pending 的 retry lanes 一起冲掉，
// 渲染完成时 lanes ⊆ retry 掩码且距 fallback < 300ms → 提交被 scheduleTimeout
// 延迟（旧代码在这里排下崩溃定时器，等它触发时"窗口"早已换了人）。
const other = { children: [], onCommit: null };
createRoot(other).render(React.createElement('box'));

// 步骤 4：等节流定时器触发。旧代码：进程在这里死；新代码：提交完成。
await sleep(500);
console.log('survived, children=', container.children.length);
process.exit(0);
