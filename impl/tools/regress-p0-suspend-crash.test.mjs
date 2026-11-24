// P0 回归：react-reconciler@0.34.0 host config 缺 `suspendOnActiveViewTransition`
// 导致的确定性进程崩溃。
//
// 原崩溃（QA 复现，chain-run1.log / locate-run2.log）：
//   TypeError: suspendOnActiveViewTransition is not a function
//       at completeRootWhenReady (react-reconciler.development.js:15817)
//       at listOnTimeout (node:internal/timers)
// 触发链（本文件 test 1 用最小脚本逐段复刻）：
//   1. 插件组件在 Suspense 里挂起 → fallback 提交，reconciler 记下
//      globalMostRecentFallbackTime；
//   2. 挂起的 promise resolve → 边界 ping → retry lanes 进入 pending；
//   3. 下一次 flushSync 渲染（下一个插件开始导出）把 retry lanes 一起冲掉，
//      渲染完成时 lanes ⊆ retry 掩码且距 fallback 提交 < 300ms →
//      completeRootWhenReady 被 scheduleTimeout 延迟；
//   4. 定时器在**另一个插件的导出窗口**里触发 → completeRootWhenReady 调
//      host config 里不存在的 suspendOnActiveViewTransition → TypeError；
//   5. 旧 crash-guard 把"归不到插件"的错误在 uncaughtException 处理器里
//      rethrow → Node 按默认方式退出 → 设备上整个后端进程死。
//
// 三个用例分别钉住：① 原崩溃链进程不死；② crash-guard 窗口内"归因失败"
// 不再走死亡通道、错误仍然冒头；③ host config 字段完整性（对着 0.34.0
// 源码的全部 `$$$config.X` 访问点比对，防止下一版再漏）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { hostConfig } from '../src/reconciler.mjs';

const IMPL = new URL('..', import.meta.url).pathname;
const RECONCILER_CJS = `${IMPL}node_modules/react-reconciler/cjs/react-reconciler.development.js`;

/** 用子进程跑崩溃脚本：node:test 自身的顶层监听会把"进程没死"掩盖成单用例失败。 */
function run(scriptUrl) {
  return spawnSync(process.execPath, [scriptUrl], {
    cwd: IMPL,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('原崩溃链复刻：fallback→retry→节流定时器，进程必须活、提交必须完成', () => {
  const r = run(new URL('./fixtures/repro-suspend-retry.mjs', import.meta.url).pathname);
  assert.equal(
    r.status, 0,
    `子进程死了（退出码 ${r.status}）——原 P0 崩溃复发了：\n${r.stderr}`,
  );
  assert.match(r.stderr, /^(?!\s*TypeError: suspendOnActiveViewTransition)/);
  assert.match(r.stdout, /fallback committed/);
  assert.match(r.stdout, /survived/);
  // retry 提交真的完成了：fallback 被边界内容替换（children 回到 0），不是
  // 靠"定时器再也没跑"蒙混过关。
  const last = r.stdout.trim().split('\n').pop();
  assert.match(last, /children= 0/);
});

test('crash-guard：窗口内"归不到插件"的错误不再杀进程，且必须冒头', () => {
  const r = run(new URL('./fixtures/repro-unattributed-guard.mjs', import.meta.url).pathname);
  assert.equal(
    r.status, 0,
    `子进程死了 —— crash-guard 又在处理器里 rethrow 了：\n${r.stderr}`,
  );
  assert.match(r.stdout, /caught-in-caller/);
  // 冒头验证：抛给调用方的必须是**原错误对象**（归属判断保留、对象不换）。
  assert.match(r.stdout, /suspendOnActiveViewTransition is not a function/);
  assert.match(r.stdout, /react-reconciler/); // 栈里保留 reconciler 内部帧
});

test('host config 字段审计：react-reconciler 0.34.0 访问的每个字段都有着落', () => {
  const src = fs.readFileSync(RECONCILER_CJS, 'utf8');
  const accessed = new Set(
    [...src.matchAll(/\$\$\$config\.([A-Za-z]+)/g)].map((m) => m[1]),
  );
  const provided = new Set(Object.keys(hostConfig));

  // 允许缺席的字段 = 被我们的功能开关关死的路径 + 从不调用的裸读取。
  // 每一条都要能指着源码行号说清"为什么够不到"。
  const gatedOff = {
    // supportsHydration=false：全部 dehydration 路径（cjs 13000+ 各 case）
    hydration: [
      'canHydrateActivityInstance', 'canHydrateFormStateMarker', 'canHydrateInstance',
      'canHydrateSuspenseInstance', 'canHydrateTextInstance', 'clearActivityBoundary',
      'clearActivityBoundaryFromContainer', 'clearSuspenseBoundary', 'clearSuspenseBoundaryFromContainer',
      'commitHydratedActivityInstance', 'commitHydratedContainer', 'commitHydratedInstance',
      'commitHydratedSuspenseInstance', 'describeHydratableInstanceForDevWarnings',
      'diffHydratedPropsForDevWarnings', 'diffHydratedTextForDevWarnings', 'finalizeHydratedChildren',
      'flushHydrationEvents', 'getFirstHydratableChild', 'getFirstHydratableChildWithinActivityInstance',
      'getFirstHydratableChildWithinContainer', 'getFirstHydratableChildWithinSingleton',
      'getFirstHydratableChildWithinSuspenseInstance', 'getNextHydratableInstanceAfterActivityInstance',
      'getNextHydratableInstanceAfterSuspenseInstance', 'getNextHydratableSibling',
      'getNextHydratableSiblingAfterSingleton', 'getSuspenseInstanceFallbackErrorDetails',
      'hideDehydratedBoundary', 'hydrateActivityInstance', 'hydrateHoistable', 'hydrateInstance',
      'hydrateSuspenseInstance', 'hydrateTextInstance', 'isFormStateMarkerMatching',
      'isSuspenseInstanceFallback', 'isSuspenseInstancePending', 'registerSuspenseInstanceRetry',
      'shouldDeleteUnhydratedTailInstances', 'unhideDehydratedBoundary',
      'validateHydratableInstance', 'validateHydratableTextInstance',
    ],
    // supportsPersistence=false：child-set / clone 全家（completeRoot persistence 分支）
    persistence: [
      'appendChildToContainerChildSet', 'cloneHiddenInstance', 'cloneHiddenTextInstance',
      'cloneInstance', 'cloneMutableInstance', 'cloneMutableTextInstance', 'createContainerChildSet',
      'finalizeContainerChildren', 'replaceContainerChildren',
    ],
    // supportsResources 缺省（falsy）：case 26 / hoistable 全家（preload*、suspend*）
    resources: [
      'acquireResource', 'createHoistableInstance', 'getHoistableRoot', 'getResource',
      'isHostHoistableType', 'mayResourceSuspendCommit', 'mountHoistable', 'preloadResource',
      'prepareToCommitHoistables', 'releaseResource', 'suspendResource', 'unmountHoistable',
    ],
    // supportsSingletons 缺省（falsy）：tag 27 单例（acquire/resolve/release）
    singletons: [
      'acquireSingletonInstance', 'isHostSingletonType', 'isSingletonScope',
      'releaseSingletonInstance', 'resolveSingletonInstance',
    ],
    // supportsTestSelectors 缺省（falsy）：`if (!supportsTestSelectors)` 早退（cjs 15314/21041/…）
    testSelectors: [
      'findFiberRoot', 'getBoundingRect', 'getTextContent', 'isHiddenSubtree',
      'matchAccessibilityRole', 'setFocusIfFocusable', 'setupIntersectionObserver',
      'supportsTestSelectors',
    ],
    // 裸读取（`$$$config.X;` 语句），reconciler 从不调用：devtools/埋点用
    bareReads: ['beforeActiveInstanceBlur', 'extraDevToolsConfig', 'supportsResources', 'supportsSingletons'],
  };

  const allowed = new Set(Object.values(gatedOff).flat());
  const missing = [...accessed].filter((n) => !provided.has(n) && !allowed.has(n));
  assert.deepEqual(
    missing, [],
    `host config 缺字段（react-reconciler 0.34.0 会访问）：${missing.join(', ')}`,
  );

  // P0 当事字段：必须是函数（源码 cjs:15817 按函数调用，返回值被丢弃）。
  assert.equal(typeof hostConfig.suspendOnActiveViewTransition, 'function');
});
