// 复刻 crash-guard 的放大链：一个"栈里只有依赖库内部帧"的异步错误落在
// 归因窗口里。旧实现（reconciler 缺字段那次）：
//   onUncaught → attributable()==null → 在 uncaughtException 处理器里 throw
//   → Node 按默认方式退出（进程死亡，QA locate-run2.log 的栈顶
//   crash-guard.mjs:63）。新实现：错误从 withCrashGuard 的返回路径以普通
//   异常抛给调用方 —— 进程活着，错误冒头，对象不换。
import { withCrashGuard } from '../../src/crash-guard.mjs';

const RECONCILER_STACK = [
  'TypeError: suspendOnActiveViewTransition is not a function',
  '    at completeRootWhenReady (/app/node_modules/react-reconciler/cjs/react-reconciler.development.js:15817:13)',
  '    at listOnTimeout (node:internal/timers:594:17)',
  '    at process.processTimers (node:internal/timers:529:7)',
].join('\n');

const errors = [];
let caught = null;
try {
  await withCrashGuard(
    { label: 'dsh-client-ui-plugin-under-export', dirs: ['/plugins/dsh-client-ui-plugin-under-export'], errors, stage: 'apply' },
    async () => {
      // 定时器异步抛 —— 与生产一致：错误在窗口还开着时从 timers 相位冒出来。
      setTimeout(() => {
        const err = new TypeError('suspendOnActiveViewTransition is not a function');
        err.stack = RECONCILER_STACK;
        throw err;
      }, 5);
      await new Promise((r) => setTimeout(r, 30));
    },
  );
} catch (e) {
  caught = e;
}

// 进程活着走到这里本身就是半个结论；剩下验证"冒头"的质量。
if (!caught) {
  console.error('FAIL: unattributed error was swallowed, never rethrown to caller');
  process.exit(1);
}
console.log('caught-in-caller:', caught.message);
console.log('stack-head:', String(caught.stack).split('\n')[1]?.trim() ?? '');
console.log('guard-errors-recorded:', errors.length);
process.exit(0);
