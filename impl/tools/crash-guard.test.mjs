// 崩溃隔离的契约：只在窗口内、只吞自己的。
//
// 这两条是硬约束，不是"最好有"：
//   * 常驻的 uncaughtException 监听会把宿主的真 bug 一起吞掉，最后表现为
//     "进程活着但什么都不工作"，比崩溃更难查；
//   * 归因错了，一个插件的错误会被记到另一个插件头上，报告直接失去意义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  withCrashGuard, withCrashGuardSync, attributable, activeGuards, isInstalled, __reset,
} from '../src/crash-guard.mjs';

const PLUGIN_DIR = join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'dsh-client-ui-open-in-app');
const OTHER_DIR = join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme');

/** 造一个"栈里带某个目录"的错误，比真去跑一个插件稳定得多。 */
function errorFrom(dir, message = 'boom') {
  const err = new Error(message);
  err.stack = `${err.name}: ${err.message}\n    at run (${dir}/client.js:434:15)`;
  return err;
}

test('窗口外没有任何监听器：宿主保留默认崩溃语义', () => {
  __reset();
  assert.equal(activeGuards(), 0);
  assert.equal(isInstalled(), false);
});

test('窗口内装上监听、结束后摘掉（不留常驻监听）', async () => {
  __reset();
  await withCrashGuard({ label: 'test-plugin', dirs: [PLUGIN_DIR] }, async () => {
    assert.equal(isInstalled(), true);
    assert.equal(activeGuards(), 1);
  });
  assert.equal(isInstalled(), false);
  assert.equal(activeGuards(), 0);
});

/**
 * 用子进程验证"进程没死"这件事。
 *
 * 为什么不能在测试进程里直接验：node:test 自己挂了 uncaughtException /
 * unhandledRejection 监听，任何漏到顶层的异常都会把**当前用例**判失败，即使我们
 * 的监听器已经把它记下来了 —— 于是"隔离生效"和"测试红"同时成立，测了个寂寞。
 * 子进程里没有那个监听，退出码就是答案：0 = 活下来了。
 */
function runIsolated(body) {
  const script = `
import { withCrashGuard } from ${JSON.stringify(new URL('../src/crash-guard.mjs', import.meta.url).href)};
/** 栈里带插件目录的错误，等价于"插件代码抛的"。 */
const makeError = (dir, message) => {
  const err = new Error(message);
  err.stack = 'Error: ' + message + '\\n    at run (' + dir + '/client.js:434:15)';
  return err;
};
const errors = [];
await withCrashGuard({ label: 'open-in-app', dirs: [${JSON.stringify(PLUGIN_DIR)}], errors, stage: 'apply' }, async () => {
  ${body}
});
// 再等一拍，确认延迟抛出的错误已经被记下
await new Promise((r) => setTimeout(r, 20));
console.log(JSON.stringify(errors));
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
}

test('apply 之后由定时器抛的错被归到当前插件，进程活下来', () => {
  const r = runIsolated(`
    setTimeout(() => { throw makeError(${JSON.stringify(PLUGIN_DIR)}, 'Cannot read properties of null'); }, 0);
  `);
  assert.equal(r.status, 0, `子进程没活下来：${r.stderr}`);
  const errors = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Cannot read properties of null/);
  assert.equal(errors[0].stage, 'apply');
});

test('未处理的 Promise 拒绝同样被归到当前插件，stage 标成 :async', () => {
  const r = runIsolated(`
    Promise.reject(makeError(${JSON.stringify(PLUGIN_DIR)}, 'late rejection'));
  `);
  assert.equal(r.status, 0, `子进程没活下来：${r.stderr}`);
  const errors = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(errors.length, 1);
  assert.equal(errors[0].stage, 'apply:async');
});

test('归因：栈里没有插件路径的错误不算任何插件的', () => {
  __reset();
  const errors = [];
  // 宿主自己抛的错（栈里只有 node_modules/react-reconciler）
  const mine = new Error('scheduleTimeout is not a function');
  mine.stack = 'Error: scheduleTimeout\n    at performWorkOnRoot (/app/node_modules/react-reconciler/cjs/x.js:1:1)';
  const guard = withCrashGuardSync({ label: 'test-plugin', dirs: [PLUGIN_DIR], errors }, () => {});
  assert.equal(attributable(mine), null, '宿主错误不能被算到插件头上');
  assert.equal(errors.length, 0);
  void guard;
  __reset();
});

test('两个插件同时有窗口时，错误各归各家（按目录区分）', () => {
  __reset();
  const a = [];
  const b = [];
  withCrashGuardSync({ label: 'plugin-a', dirs: [PLUGIN_DIR], errors: a }, () => {});
  withCrashGuardSync({ label: 'plugin-b', dirs: [OTHER_DIR], errors: b }, () => {});
  assert.equal(attributable(errorFrom(PLUGIN_DIR)).label, 'plugin-a');
  assert.equal(attributable(errorFrom(OTHER_DIR)).label, 'plugin-b');
  __reset();
  assert.equal(activeGuards(), 0);
});

test('classic 插件在 vm 里跑，栈里只有包名 —— 也要能归因', () => {
  __reset();
  const errors = [];
  withCrashGuardSync({ label: '@deepseek-ai/dsh-client-ui-open-in-app', dirs: [PLUGIN_DIR], errors }, () => {});
  // vm 的 filename 是 "<包名>/client.js"，没有绝对目录
  const vmErr = new Error('Cannot read properties of null (reading \'set\')');
  vmErr.stack = "TypeError: Cannot read properties of null\n    at run (@deepseek-ai/dsh-client-ui-open-in-app/client.js:434:15)";
  assert.equal(attributable(vmErr).label, '@deepseek-ai/dsh-client-ui-open-in-app');
  __reset();
});

test('同步窗口再抛出的异常照旧向上传播（隔离不改变 throw 语义）', () => {
  __reset();
  assert.throws(() => withCrashGuardSync({ label: 'test-plugin', dirs: [PLUGIN_DIR] }, () => {
    throw new Error('plugin threw synchronously');
  }), /plugin threw synchronously/);
  __reset();
});
