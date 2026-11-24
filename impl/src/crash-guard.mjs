// 第三方插件代码的崩溃隔离。
//
// ── 问题 ────────────────────────────────────────────────────────────────────
// `dsh-client-ui-open-in-app` 在 apply() 之后由定时器/微任务抛
// `Cannot read properties of null (reading 'set')`（client.js:434）。apply 本身
// 是同步返回的，所以 `apply()` 外面那层 try/catch 和 `.catch()` 都够不着它：
// 它在 `unhandledRejection` 里，Node 的默认行为是**杀进程**。
//
// 在设备上这意味着「装了一个坏插件 → 整个后端起不来」，而日志里只有一行
// 看不出归属的 TypeError。在构建期这意味着「扫 60 个插件，第 37 个把构建机
// 的 node 干掉，前 36 个的结论丢失」。
//
// ── 为什么不能简单地挂一个全局监听 ─────────────────────────────────────────
// `process.on('uncaughtException')` 一旦存在，Node 就不再因为未捕获异常退出。
// 常驻监听 = 把真正的宿主 bug 也一起吞掉，最后表现为"进程活着但什么都不工作"，
// 比崩溃更难查。所以这里的两条规则是硬约束：
//
//   1. **只在窗口内生效**：`withCrashGuard()` 进出时安装/摘除。没有活跃窗口时
//      监听器根本不在，Node 的默认行为完整保留。
//   2. **只吞属于自己的**：靠 `err.stack` 里有没有当前插件的目录路径判定。
//
// ── 2025-01 P0 修订：非插件错误不再在处理器里 throw ─────────────────────────
// 原来的实现：归因失败 → `throw err`。这在 uncaughtException 处理器里抛出
// 等于让 Node 立刻按默认方式退出 —— 而 react-reconciler 0.34.0 的 Suspense
// retry 节流定时器（completeRootWhenReady）恰好是一条"错误栈里只有依赖库
// 内部帧"的路径（缺 `suspendOnActiveViewTransition` 字段那次就是这样）：
// 一次性的 TypeError 被放大成整个 node 进程死亡，QA 复现见
// tools/regress-p0-suspend-crash.test.mjs。
//
// 现在的语义：归因失败 ≠ 吞掉，也 ≠ 杀进程。错误先记进 `pendingFatal`，
// 等**异步窗口关闭**时从 `withCrashGuard` 的返回路径以普通异常重新抛出 ——
// 调用方（loadPluginAsync 等）接住它、记进自己的 errors，进程照常活着。
// "宿主 bug 必须冒头"这条硬约束由重新抛出保证，只是抛的**地点**从进程
// 死亡通道挪到了正常的调用栈上。

/** 正在执行的第三方代码窗口。 */
const guards = new Set();

/** 窗口内发生、但归不到任何插件错误（宿主/依赖库自己的），等窗口关闭时重抛。 */
const pendingFatal = [];
//
// 窗口在 apply 之后再多活一个宏任务（`setImmediate`），因为 unhandledRejection
// 要等微任务队列排空才触发 —— 不留这一拍，恰好漏掉最常见的那一类。

let installed = false;

function stageOf(guard) {
  return typeof guard.stage === 'function' ? guard.stage() : (guard.stage ?? 'uncaught');
}

function stackOf(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.stack || err.message || err);
}

/** 这条错误是不是某个活跃窗口里的插件抛的。 */
export function attributable(err) {
  const stack = stackOf(err);
  for (const guard of guards) {
    for (const dir of guard.dirs) {
      if (dir && stack.includes(dir)) return guard;
    }
    // classic 插件跑在 vm 里，`filename` 传的是 `<包名>/client.js`（相对路径），
    // 栈里根本没有绝对目录 —— open-in-app 那次就是这样漏掉的。包名也认。
    // 长度下限 4：`'x'` 这种短标签会命中任何含 x 的栈（/cjs/x.js），把宿主错误
    // 算到插件头上比不归因更糟。
    if (guard.label && guard.label.length >= 4 && stack.includes(guard.label)) return guard;
  }
  return null;
}

const onUncaught = (err) => {
  const guard = attributable(err);
  if (!guard) {
    // 不是插件抛的：记账（窗口关闭时非致命重抛）。在 uncaughtException
    // 处理器里 throw 会让 Node 立刻按默认方式退出 —— 那是把一次性错误放大
    // 成进程级死亡，正是 P0 崩溃的放大器，不能在这里抛。
    pendingFatal.push(err);
    for (const g of guards) g.seen += 1;
    return;
  }
  guard.errors.push({
    stage: stageOf(guard),
    message: String(err?.message ?? err),
    stack: err?.stack,
  });
  guard.seen += 1;
};

const onRejection = (reason) => {
  const guard = attributable(reason);
  if (!guard) {
    // 同 onUncaught：记账，不在此处 throw。
    pendingFatal.push(reason);
    for (const g of guards) g.seen += 1;
    return;
  }
  const stage = stageOf(guard);
  guard.errors.push({
    stage: `${stage}:async`,
    message: String(reason?.message ?? reason),
    stack: reason?.stack,
  });
  guard.seen += 1;
};

function install() {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
}

function uninstall() {
  if (!installed) return;
  installed = false;
  process.removeListener('uncaughtException', onUncaught);
  process.removeListener('unhandledRejection', onRejection);
}

function detachAll() {
  guards.clear();
  pendingFatal.length = 0;
  uninstall();
}

function open(opts) {
  const guard = {
    label: opts.label ?? '?',
    dirs: (opts.dirs ?? []).filter(Boolean),
    errors: opts.errors ?? [],
    stage: opts.stage ?? null,
    seen: 0,
  };
  guards.add(guard);
  install();
  return guard;
}

function close(guard) {
  guards.delete(guard);
  if (guards.size === 0) uninstall();
}

/**
 * 把事件循环放干两轮（check + timers 各一次）。
 *
 * 一轮不够：`setTimeout(fn, 0)` 被 clamp 到 1ms，而 `setImmediate` 在同一次循环
 * 的 check 相位就跑完了 —— 插件的定时器回调会在窗口关闭**之后**才执行，那时
 * 已经没有监听器，于是它照样杀掉进程。两轮把「本轮排进来的定时器」都放完。
 */
async function drainEventLoop() {
  for (let i = 0; i < 2; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * 在一个"归因窗口"里执行第三方代码。
 *
 * @param {object} opts
 * @param {string} opts.label     插件 id（只用于诊断）
 * @param {string[]} opts.dirs    该插件的目录（绝对路径，用于归因）
 * @param {Array} opts.errors     收集错误的目标数组（与 loadPlugin 返回值里的是同一个）
 * @param {string|Function} [opts.stage] 错误归类前缀（'import' / 'apply' / 'runtime'…）；
 *                                       传函数则每次取当前阶段，导入期与 apply 期能分清
 * @param {Function} fn           要执行的代码
 * @returns {Promise<*>} fn 的返回值
 */
export async function withCrashGuard(opts, fn) {
  const guard = open(opts);
  try {
    return await fn();
  } finally {
    await drainEventLoop();
    close(guard);
    // 窗口内归因失败的错误在这里非致命重抛：从这里出去是普通的 promise
    // rejection / throw，调用方的 try/catch 接得住、记得上 —— 宿主 bug 冒头
    // 了，但不再走 uncaughtException 的死亡通道。
    // 还有更早的窗口开着（classic 插件的同步窗口会多活一个宏任务）时没法等
    // 它：把错误记进那些窗口的 errors（调用方持有数组，看得见），改为记账。
    if (pendingFatal.length > 0) {
      if (guards.size > 0) {
        const recorded = pendingFatal.splice(0);
        for (const g of guards) {
          for (const e of recorded) {
            g.errors.push({ stage: 'unattributed', message: String(e?.message ?? e), stack: e?.stack });
          }
        }
      } else {
        const pending = pendingFatal.splice(0);
        throw pending[0];
      }
    }
  }
}

/**
 * 同步版本的窗口，给 classic 插件（`__ModuleLoader__` 那条路）用。
 *
 * 它不能 await，所以窗口在"放干一轮事件循环"之后才关：先 `setTimeout(0)` 让
 * apply 里排下的定时器先跑，再 `setImmediate` 收尾。归因仍然按目录判定，所以
 * 同时加载多个插件不会互相串。
 */
export function withCrashGuardSync(opts, fn) {
  const guard = open(opts);
  try {
    return fn();
  } finally {
    setTimeout(() => setImmediate(() => {
      close(guard);
      // 同步窗口没法把错误重新抛给调用方（fn 早已返回，这里跑在定时器回调
      // 里，throw 就是又一次进程死亡）。归因失败的钱只能记进这个窗口的
      // errors —— 调用方持有数组，错误可见；再挂一条 process warning 保证
      // 不被静默吞掉。
      if (pendingFatal.length > 0) {
        const recorded = pendingFatal.splice(0);
        for (const e of recorded) {
          guard.errors.push({ stage: 'unattributed:sync', message: String(e?.message ?? e), stack: e?.stack });
          process.emitWarning(String(e?.message ?? e), { detail: e?.stack ?? '', code: 'DSH_UNATTRIBUTED_ERROR' });
        }
      }
    }), 0);
  }
}

/** 测试/诊断：当前有几个窗口在。0 表示宿主进程处于"默认崩溃行为"。 */
export const activeGuards = () => guards.size;

/** 测试/诊断：监听器是否装着（装着 = Node 不再默认因未捕获异常退出）。 */
export const isInstalled = () => installed;

/** 测试用：强制清空（只在测试里调，避免窗口泄漏到下一个用例）。 */
export function __reset() {
  detachAll();
}

export default { withCrashGuard, withCrashGuardSync, attributable, activeGuards, isInstalled };
