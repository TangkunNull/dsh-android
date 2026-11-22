/**
 * zh.mjs 的断言测试。
 *
 * 三种跑法（都必须在 /workspace/dsh-android 下执行）：
 *
 *   DSH_INTL_ZH=force node impl/tools/intl-zh/test.mjs   # 完整断言（桌面完整 ICU 也走这条）
 *   DSH_INTL_ZH=0     node impl/tools/intl-zh/test.mjs   # 只验证「关掉后不生效」
 *   node impl/tools/intl-zh/test.mjs                     # auto：桌面跳过、设备打补丁
 *
 * force 模式自己会 fork 出 `0` 和 auto 两个子进程跑一遍，所以一条命令就能覆盖
 * 全部 5 组断言；分开跑是为了在 CI 上能单独定位。
 *
 * 断言里的期望值全部是**中文格式的硬编码**（这是本任务的契约），唯一例外是时区
 * 缩写 —— 那个值来自 ICU 版本（CST / GMT+8 都可能），所以从原生 formatter 现取。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(HERE, 'test.mjs');
const MODE = String(process.env.DSH_INTL_ZH ?? '').trim().toLowerCase();
const SIM = String(process.env.DSH_INTL_ZH_SIM ?? '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// 可选的 small-icu 模拟（本机是完整 ICU，没有这条就没法验证 auto 分支真的会打补丁）
//
// 做法：把 Intl.DateTimeFormat 包成「忽略请求的 locale、一律按 en-US 构造」。
// 这正是 small-icu 的可观测行为 —— API 在、时区在、zh-CN 静默按 en 输出。
// 必须在 import zh.mjs 之前装好，所以放在模块最前面。
// ---------------------------------------------------------------------------
if (SIM === 'small-icu') {
  const Real = globalThis.Intl.DateTimeFormat;
  globalThis.Intl.DateTimeFormat = new Proxy(Real, {
    construct(target, args) { return Reflect.construct(target, ['en-US', args[1]]); },
    apply(target, _thisArg, args) { return Reflect.construct(target, ['en-US', args[1]]); },
    get(target, prop, receiver) { return Reflect.get(target, prop, receiver); },
  });
  console.log('[intl-zh] 已启用 small-icu 模拟：所有 locale 一律按 en-US 输出');
}

// 必须在 import zh.mjs 之前抓住原生实现：打补丁之后 Intl.DateTimeFormat 已经是
// Proxy 了，拿它当「英文基准」会自己套自己。这个是**参照系**，不是被测对象。
const NativeRef = globalThis.Intl.DateTimeFormat;
const nativeDateToLocaleString = Date.prototype.toLocaleString;

const TZ = 'Asia/Shanghai';
/** UTC 06:30 = 上海 14:30，同一天。 */
const T_1430 = Date.UTC(2026, 10, 20, 6, 30, 0);
/** UTC 16:00 = 上海 次日 00:00，用来验证 24 点归一化。 */
const T_MIDNIGHT = Date.UTC(2026, 10, 20, 16, 0, 0);

const zhMod = await import(pathToFileURL(path.join(HERE, 'zh.mjs')).href);
const info = zhMod.__info;

let passed = 0;
function ok(name, actual, expected) {
  assert.equal(actual, expected, `${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  passed += 1;
  console.log('  ok  ', name, '=>', JSON.stringify(actual));
}
function okMatch(name, actual, re) {
  assert.match(actual, re, `${name}: 期望匹配 ${re}，实际 ${JSON.stringify(actual)}`);
  passed += 1;
  console.log('  ok  ', name, '=>', JSON.stringify(actual));
}
function okTrue(name, cond) {
  assert.ok(cond, `${name}: 断言失败`);
  passed += 1;
  console.log('  ok  ', name);
}

console.log(`[intl-zh] mode=${MODE || 'auto'} __info=${JSON.stringify(info)}`);

// ---------------------------------------------------------------------------
// 参照值：原生 ICU 的英文输出（用来验证「非中文 locale 必须原样透传」）
// ---------------------------------------------------------------------------
// 参照值用**未被补丁的原生方法**算出来：注意 toLocaleString 的默认字段是
// 日期+时间，而 `new Intl.DateTimeFormat('en-US')` 的默认只有日期，两者不能混用。
const nativeEnUS = nativeDateToLocaleString.call(new Date(T_1430), 'en-US', { timeZone: TZ });
const nativeTzName = (() => {
  const parts = new NativeRef('en-US', { timeZone: TZ, timeZoneName: 'short' }).formatToParts(new Date(T_1430));
  const hit = parts.find((p) => p.type === 'timeZoneName');
  return hit ? hit.value : 'GMT+8';
})();

const nativeHasZh = (() => {
  try {
    const s = new NativeRef('zh-CN', { month: 'long', timeZone: 'UTC' })
      .format(new Date(Date.UTC(2020, 0, 15)));
    return /[\u4e00-\u9fff]/.test(s);
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// 组 5：DSH_INTL_ZH=0 → 必须完全不生效
// ---------------------------------------------------------------------------
if (MODE === '0' || MODE === 'false' || MODE === 'off') {
  console.log('\n[5] DSH_INTL_ZH=0 关闭补丁');
  ok('__info.enabled', info.enabled, false);
  ok('__info.reason', info.reason, 'DSH_INTL_ZH=0');
  // 关掉之后 zh-CN 请求应落到原生：完整 ICU 下是「原生中文」，small-icu 下是英文。
  // 无论哪种，都必须**等于未打补丁的原生结果**，这才叫「没接管」。
  ok('toLocaleString(zh-CN) 未被接管',
    new Date(T_1430).toLocaleString('zh-CN', { timeZone: TZ }),
    nativeDateToLocaleString.call(new Date(T_1430), 'zh-CN', { timeZone: TZ }));
  ok('Intl.DateTimeFormat 未被替换', globalThis.Intl.DateTimeFormat === NativeRef, true);
  ok('Date.prototype.toLocaleString 未被替换',
    Date.prototype.toLocaleString === nativeDateToLocaleString, true);
  console.log(`\n[intl-zh] ${passed} 项通过（mode=0）`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// auto 模式：桌面完整 ICU 应整体跳过
// ---------------------------------------------------------------------------
if (MODE !== 'force') {
  console.log('\n[auto] 自检模式');
  ok('__info.enabled 与原生能力相反', info.enabled, !nativeHasZh);
  if (nativeHasZh) {
    ok('__info.reason', info.reason, 'native ICU already has zh data');
    okMatch('原生 zh-CN 输出是中文',
      new NativeRef('zh-CN', { month: 'long', timeZone: TZ }).format(new Date(T_1430)),
      /[\u4e00-\u9fff]/);
    console.log('\n[intl-zh] 原生 ICU 已有中文数据，补丁整体跳过（桌面 node 的预期结果）');
  } else {
    // small-icu（真机或本脚本的模拟）下 auto 必须自己打上补丁，顺手验几条关键的。
    ok('small-icu 下必须启用', info.enabled, true);
    ok('small-icu 下 reason', info.reason, 'small-icu: Intl present but only en locale data');
    ok('small-icu 下 toLocaleString',
      new Date(T_1430).toLocaleString('zh-CN', { timeZone: TZ }),
      '2026/11/20 14:30:00');
    ok('small-icu 下 年月日',
      new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: TZ })
        .format(new Date(T_1430)),
      '2026年11月20日');
    ok('small-icu 下 午夜',
      new Date(T_MIDNIGHT).toLocaleString('zh-CN', { timeZone: TZ }),
      '2026/11/21 00:00:00');
    ok('small-icu 下 en-US 仍透传',
      new Date(T_1430).toLocaleString('en-US', { timeZone: TZ }),
      nativeDateToLocaleString.call(new Date(T_1430), 'en-US', { timeZone: TZ }));
  }
  console.log(`\n[intl-zh] ${passed} 项通过（mode=auto${SIM ? ' sim=' + SIM : ''}）`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 组 1：force 模式下的中文输出
// ---------------------------------------------------------------------------
assert.equal(info.enabled, true, '__info.enabled 必须是 true（force）');

console.log('\n[1] 中文输出（force）');
ok('__info.reason', info.reason, 'DSH_INTL_ZH=force');
okMatch('__info.sample 是中文格式', info.sample, /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/);

// 1.1 无参 toLocaleString 之后的形状：日期 + 时间
ok('Date#toLocaleString(zh-CN)',
  new Date(T_1430).toLocaleString('zh-CN', { timeZone: TZ }),
  '2026/11/20 14:30:00');

// 1.2 年月日风格
ok('Intl 年月日',
  new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: TZ })
    .format(new Date(T_1430)),
  '2026年11月20日');

// 1.3 星期
ok('Intl weekday long',
  new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: TZ }).format(new Date(T_1430)),
  '星期五');
ok('Intl weekday short',
  new Intl.DateTimeFormat('zh-CN', { weekday: 'short', timeZone: TZ }).format(new Date(T_1430)),
  '周五');

// 1.4 24 点归一化：UTC 16:00 → 上海次日 00:00，en-US 的 h24 在这种时刻会吐 "24"
ok('午夜 24 点归一化',
  new Date(T_MIDNIGHT).toLocaleString('zh-CN', { timeZone: TZ }),
  '2026/11/21 00:00:00');

// 1.5 斜杠风格 + 补零
ok('斜杠 numeric（不补零）',
  new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: TZ })
    .format(new Date(Date.UTC(2026, 0, 5, 6, 30))),
  '2026/1/5');
ok('斜杠 2-digit（补零）',
  new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ })
    .format(new Date(Date.UTC(2026, 0, 5, 6, 30))),
  '2026/01/05');

// 1.6 单字段
ok('只有月份 long', new Intl.DateTimeFormat('zh-CN', { month: 'long', timeZone: TZ }).format(new Date(T_1430)), '11月');
ok('只有月份 short', new Intl.DateTimeFormat('zh-CN', { month: 'short', timeZone: TZ }).format(new Date(T_1430)), '11月');
ok('只有日', new Intl.DateTimeFormat('zh-CN', { day: 'numeric', timeZone: TZ }).format(new Date(T_1430)), '20日');
ok('只有年', new Intl.DateTimeFormat('zh-CN', { year: 'numeric', timeZone: TZ }).format(new Date(T_1430)), '2026年');

// 1.7 时间
ok('时分', new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(T_1430)), '14:30');
ok('时分秒 2-digit',
  new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ })
    .format(new Date(T_1430)),
  '14:30:00');
ok('时分秒 numeric 也要补零',
  new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', minute: 'numeric', second: 'numeric', timeZone: TZ })
    .format(new Date(T_1430)),
  '14:30:00');

// 1.8 dateStyle / timeStyle
ok('dateStyle short', new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeZone: TZ }).format(new Date(T_1430)), '2026/11/20');
ok('dateStyle medium', new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: TZ }).format(new Date(T_1430)), '2026年11月20日');
ok('dateStyle long', new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeZone: TZ }).format(new Date(T_1430)), '2026年11月20日');
ok('dateStyle full 含星期', new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeZone: TZ }).format(new Date(T_1430)), '2026年11月20日星期五');
ok('timeStyle short', new Intl.DateTimeFormat('zh-CN', { timeStyle: 'short', timeZone: TZ }).format(new Date(T_1430)), '14:30');
ok('timeStyle medium', new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium', timeZone: TZ }).format(new Date(T_1430)), '14:30:00');
// 时区缩写取自原生 timeZoneName:'short' 的 part 值：不同 ICU 版本可能是 CST 或 GMT+8。
ok('timeStyle long 带时区缩写',
  new Intl.DateTimeFormat('zh-CN', { timeStyle: 'long', timeZone: TZ }).format(new Date(T_1430)),
  `14:30:00 ${nativeTzName}`);
ok('dateStyle + timeStyle 用一个空格连接',
  new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'medium', timeZone: TZ }).format(new Date(T_1430)),
  '2026年11月20日星期五 14:30:00');

// 1.9 全空 options
ok('全空 options = 只有日期',
  new Intl.DateTimeFormat('zh-CN', { timeZone: TZ }).format(new Date(T_1430)),
  '2026/11/20');
ok('toLocaleDateString 无 options',
  new Date(T_1430).toLocaleDateString('zh-CN', { timeZone: TZ }),
  '2026/11/20');
ok('toLocaleTimeString 无 options',
  new Date(T_1430).toLocaleTimeString('zh-CN', { timeZone: TZ }),
  '14:30:00');

// 1.10 resolvedOptions / formatToParts / formatRange
const fmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: TZ });
ok('resolvedOptions().locale', fmt.resolvedOptions().locale, 'zh-CN');
ok('resolvedOptions().timeZone', fmt.resolvedOptions().timeZone, TZ);
ok('resolvedOptions().month 回显', fmt.resolvedOptions().month, 'long');
ok('formatRange', fmt.formatRange(new Date(T_1430), new Date(T_1430 + 86400000)), '2026年11月20日 – 2026年11月21日');
okTrue('formatToParts 返回数组', Array.isArray(fmt.formatToParts(new Date(T_1430))));
ok('formatToParts 拼回去等于 format',
  fmt.formatToParts(new Date(T_1430)).map((p) => p.value).join(''),
  '2026年11月20日');

// 1.11 取方法再调用（真实代码里很常见：`const fn = fmt.format`）
const detached = fmt.format;
ok('detached format()', detached(new Date(T_1430)), '2026年11月20日');

// 1.12 不带 new 调用 + instanceof + 静态方法
ok('不带 new 构造', Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeZone: TZ }).format(new Date(T_1430)), '2026/11/20');
okTrue('中文实例 instanceof Intl.DateTimeFormat', fmt instanceof Intl.DateTimeFormat);
okTrue('supportedLocalesOf 仍在', typeof Intl.DateTimeFormat.supportedLocalesOf === 'function');
okTrue('supportedLocalesOf 可用', Intl.DateTimeFormat.supportedLocalesOf(['en-US']).includes('en-US'));

// 1.13 非法日期：Intl 抛 RangeError，Date 方法返回 'Invalid Date'（与规范一致）
assert.throws(() => fmt.format(new Date(NaN)), RangeError);
passed += 1;
console.log('  ok   Intl.format(NaN) 抛 RangeError');
ok('Date#toLocaleString(NaN)', new Date(NaN).toLocaleString('zh-CN'), 'Invalid Date');

// ---------------------------------------------------------------------------
// 组 2：不传 locale（默认 locale）也应是中文
// ---------------------------------------------------------------------------
console.log('\n[2] 默认 locale（不传 locales 参数）');
okMatch('toLocaleString() 无参', new Date(T_1430).toLocaleString(), /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/);
okMatch('toLocaleTimeString() 无参', new Date(T_1430).toLocaleTimeString(), /^\d{2}:\d{2}:\d{2}$/);
okMatch('toLocaleDateString() 无参', new Date(T_1430).toLocaleDateString(), /^\d{4}\/\d{1,2}\/\d{1,2}$/);
okMatch('new Intl.DateTimeFormat() 无 locale', new Intl.DateTimeFormat(undefined, { timeZone: TZ }).format(new Date(T_1430)), /^\d{4}\/\d{1,2}\/\d{1,2}$/);
// 插件里最常见的写法：`new Date(x).toLocaleString()` —— 不能出现 AM/PM 或英文月份
okTrue('默认输出不含 AM/PM', !/AM|PM/.test(new Date(T_1430).toLocaleString()));

// ---------------------------------------------------------------------------
// 组 3：非中文 locale 必须原样透传（最重要 —— 不能把英文用户也改了）
// ---------------------------------------------------------------------------
console.log('\n[3] 非中文 locale 原样透传');
ok('toLocaleString(en-US)', new Date(T_1430).toLocaleString('en-US', { timeZone: TZ }), nativeEnUS);
ok('Intl.DateTimeFormat(en-US)',
  new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: TZ }).format(new Date(T_1430)),
  new NativeRef('en-US', { dateStyle: 'long', timeZone: TZ }).format(new Date(T_1430)));
// ja-JP / de-DE 与中文格式明显不同，能真正区分「透传」和「被接管」。
ok('toLocaleString(ja-JP) 透传',
  new Date(T_1430).toLocaleString('ja-JP', { timeZone: TZ }),
  nativeDateToLocaleString.call(new Date(T_1430), 'ja-JP', { timeZone: TZ }));
ok('toLocaleString(de-DE) 透传',
  new Date(T_1430).toLocaleString('de-DE', { timeZone: TZ }),
  nativeDateToLocaleString.call(new Date(T_1430), 'de-DE', { timeZone: TZ }));
okTrue('de-DE 输出确实不是中文格式',
  !/^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/.test(new Date(T_1430).toLocaleString('de-DE', { timeZone: TZ })));
okTrue('en-US 实例 instanceof 原生', new Intl.DateTimeFormat('en-US') instanceof NativeRef);
okTrue('en-US 实例 instanceof 包装后', new Intl.DateTimeFormat('en-US') instanceof Intl.DateTimeFormat);

// ---------------------------------------------------------------------------
// 组 3b：Proxy 不变量 —— 曾有一版补丁在这里挂掉 11 个插件
//
// `Intl.DateTimeFormat.prototype` 是 non-writable、non-configurable 的自有数据
// 属性。ECMAScript 要求 Proxy 的 get 陷阱对这类属性必须原样返回 target 上的值，
// 返回别的（哪怕只是个等价的原型对象）会让引擎直接抛 TypeError。
//
// 这条在桌面 node 上曾长期测不到：完整 ICU 下补丁自检直接跳过，makeProxy 根本
// 不执行。所以断言必须在 force 模式下跑，且要真的去读一次 prototype。
// ---------------------------------------------------------------------------
console.log('\n[3b] Proxy 不变量（原型属性必须原样透传）');
let proto = null;
let protoErr = null;
try {
  proto = Intl.DateTimeFormat.prototype;
} catch (e) {
  protoErr = e;
}
ok('读取 Intl.DateTimeFormat.prototype 不抛错', protoErr === null ? 'ok' : String(protoErr.message).slice(0, 60), 'ok');
okTrue('prototype 是原生 DateTimeFormat 的原型', proto !== null && Object.prototype.toString.call(proto) === '[object Intl.DateTimeFormat]');
okTrue('prototype 上 formatToParts 可用（@js-temporal 依赖它）', typeof proto?.formatToParts === 'function');
const zhInst = new Intl.DateTimeFormat('zh-CN');
okTrue('中文实例的原型链包含原生 prototype', proto.isPrototypeOf(zhInst));
okTrue('中文实例 instanceof 包装后为真', zhInst instanceof Intl.DateTimeFormat);
okTrue('中文实例 instanceof 原生构造函数为真（原型链穿过原生 prototype）', zhInst instanceof NativeRef);


// ---------------------------------------------------------------------------
// 组 4：幂等 —— 再 import 一次（不同 URL 后缀 = 新模块实例）不能重复包装
// ---------------------------------------------------------------------------
console.log('\n[4] 幂等');
const before = Date.prototype.toLocaleString;
const again = await import(pathToFileURL(path.join(HERE, 'zh.mjs')).href + '?again=1');
ok('二次 import 的 __info.enabled', again.__info.enabled, true);
ok('二次 import 不重复包装 Date.prototype', Date.prototype.toLocaleString === before, true);
ok('二次 import 后输出不变', new Date(T_1430).toLocaleString('zh-CN', { timeZone: TZ }), '2026/11/20 14:30:00');

console.log(`\n[intl-zh] ${passed} 项通过（mode=force）`);

// ---------------------------------------------------------------------------
// fork 出另外两种模式，一条命令覆盖组 5 与 auto 自检
// ---------------------------------------------------------------------------
function runChild(label, env) {
  const res = spawnSync(process.execPath, [SELF], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    console.error(`\n[intl-zh] 子进程失败：${label}（exit ${res.status}）`);
    process.exit(1);
  }
  console.log(`  ok   子进程 ${label} 通过`);
}

console.log('\n[5] 子进程：DSH_INTL_ZH=0 / auto / auto+small-icu 模拟');
runChild('DSH_INTL_ZH=0', { DSH_INTL_ZH: '0' });
runChild('auto', { DSH_INTL_ZH: '' });
runChild('auto + small-icu 模拟', { DSH_INTL_ZH: '', DSH_INTL_ZH_SIM: 'small-icu' });

console.log('\n[intl-zh] 全部通过');
