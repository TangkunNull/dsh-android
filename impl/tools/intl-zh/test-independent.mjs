/**
 * zh.mjs 的**独立**验证脚本（独立实现，不复用 test.mjs 的任何断言）。
 *
 * 设计原则：
 *   1. 期望值来自「原生 ICU」而不是工程师的测试文件：只要能找到同时被两边覆盖的
 *      格式，就用原生 zh-CN 的输出做差分基准（本机是 full-icu，是天然的 oracle）。
 *      找不到的（补丁刻意改形状的地方）才硬编码，并把硬编码值用原生 en-US 的
 *      formatToParts 再交叉验一遍（数字来自 tzdata，不来自补丁）。
 *   2. 一个断言失败不影响后面的断言：收集所有失败，最后统一汇报，避免「第一个
 *      bug 挡住后面十个」。
 *   3. 关键断言都打印 actual，报告里能原样贴。
 *
 * 跑法：
 *   DSH_INTL_ZH=force node impl/tools/intl-zh/test-independent.mjs
 *   DSH_INTL_ZH=force node impl/tools/intl-zh/test-independent.mjs --quiet   # 只打失败
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(HERE, 'test-independent.mjs');
const ZH_PATH = path.join(HERE, 'zh.mjs');
const POLYFILL = path.join(HERE, '..', '..', 'vendor', 'intl-polyfill', 'intl-polyfill.mjs');
const QUIET = process.argv.includes('--quiet');
const STAGE = process.env.QA_STAGE || 'main';
const MODE = String(process.env.DSH_INTL_ZH ?? '').trim().toLowerCase();

// ===========================================================================
// 0. 打补丁**之前**的现场快照 —— 必须在 import zh.mjs 之前抓
// ===========================================================================
const SNAP = {
  dtf: globalThis.Intl?.DateTimeFormat,
  tls: Date.prototype.toLocaleString,
  tlds: Date.prototype.toLocaleDateString,
  tlts: Date.prototype.toLocaleTimeString,
  dateProtoKeys: Object.keys(Date.prototype).slice(),
  dateProtoNames: Object.getOwnPropertyNames(Date.prototype).slice(),
  dateProtoDescs: Object.getOwnPropertyDescriptors(Date.prototype),
  intlNames: Object.getOwnPropertyNames(globalThis.Intl ?? {}).slice(),
  dateEnum: (() => { const out = []; for (const k in new Date(0)) out.push(k); return out; })(),
  datePropKeys: Object.keys(new Date(0)).slice(),
};
const N = SNAP.dtf; // 原生构造器，全程当参照系用

// ===========================================================================
// 极简断言框架
// ===========================================================================
const R = { pass: 0, fail: 0, failures: [] };
const CUR = { group: '' };

function group(name) {
  CUR.group = name;
  if (!QUIET) console.log(`\n## ${name}`);
}

function ok(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    R.pass += 1;
    if (!QUIET) console.log(`  ok   ${label} => ${a}`);
  } else {
    R.fail += 1;
    R.failures.push({ group: CUR.group, label, expected: e, actual: a });
    console.log(`  FAIL ${label}\n         期望: ${e}\n         实际: ${a}`);
  }
}

function okTrue(label, cond, detail) {
  if (cond) {
    R.pass += 1;
    if (!QUIET) console.log(`  ok   ${label}${detail ? ' => ' + detail : ''}`);
  } else {
    R.fail += 1;
    R.failures.push({ group: CUR.group, label, expected: 'true', actual: String(detail ?? cond) });
    console.log(`  FAIL ${label}${detail ? '\n         ' + detail : ''}`);
  }
}

function okThrows(label, fn, ctorName) {
  let got = 'did-not-throw';
  try { got = 'returned:' + JSON.stringify(fn()); } catch (e) { got = e.constructor.name; }
  ok(label, got, ctorName);
}

/** 求值成 {v} 或 {e:'RangeError'}，用于「原生 vs 补丁」差分。 */
function ev(fn) {
  try { return { v: fn() }; } catch (e) { return { e: e.constructor.name, m: e.message }; }
}

function diff(label, mine, theirs, note) {
  const a = JSON.stringify(mine);
  const b = JSON.stringify(theirs);
  if (a === b) {
    R.pass += 1;
    if (!QUIET) console.log(`  same ${label} => ${a}`);
  } else {
    R.fail += 1;
    R.failures.push({ group: CUR.group, label, expected: b, actual: a, note });
    console.log(`  DIFF ${label}\n         原生: ${b}\n         补丁: ${a}`);
  }
}

// ===========================================================================
// 工具：独立 oracle —— 只用原生 ICU 的 formatToParts 取数字，格式自己拼
// ===========================================================================
const p2 = (v) => String(Math.trunc(Number(v))).padStart(2, '0');

function nativeParts(ms, tz) {
  const dtf = new N('en-US', {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false, timeZone: tz,
  });
  const bag = {};
  for (const p of dtf.formatToParts(new Date(ms))) if (p.type !== 'literal') bag[p.type] = p.value;
  return bag;
}

/** 期望的 `Y/M/D HH:mm:ss`，数字全部来自原生 tzdata，不来自补丁。 */
function oracleDateTime(ms, tz) {
  const b = nativeParts(ms, tz);
  const h = ((Number(b.hour) % 24) + 24) % 24; // en-US h24 在 0 点给 "24"
  return `${b.year}/${b.month}/${b.day} ${p2(h)}:${p2(b.minute)}:${p2(b.second)}`;
}

const TZ = 'Asia/Shanghai';
const T_1430 = Date.UTC(2026, 10, 20, 6, 30, 0);      // 上海 2026-11-20 14:30
const T_MID = Date.UTC(2026, 10, 20, 16, 0, 0);       // 上海 2026-11-21 00:00

// ===========================================================================
// B 阶段：共存性（Intl 完全不存在 → 先 polyfill 再 zh.mjs）
// 独立进程跑，因为有 delete globalThis.Intl 这种不可逆操作。
// ===========================================================================
if (STAGE === 'coexist') {
  const pre = { hasIntl: typeof globalThis.Intl !== 'undefined' };
  delete globalThis.Intl;
  const deleted = typeof globalThis.Intl === 'undefined';

  let polyErr = null;
  try {
    await import(pathToFileURL(POLYFILL).href);
  } catch (e) {
    polyErr = e;
  }
  const polyOk = typeof globalThis.Intl?.DateTimeFormat === 'function';
  // polyfill 的「原生」输出：此时还没打中文补丁，拿它当透传基准。
  const polyTLS = Date.prototype.toLocaleString;
  const polyEnUS = polyOk ? polyTLS.call(new Date(T_1430), 'en-US', { timeZone: TZ }) : null;
  const polyZhCN = polyOk ? polyTLS.call(new Date(T_1430), 'zh-CN', { timeZone: TZ }) : null;

  group(`B 共存性（mode=${MODE || 'auto'}）：Intl 先被 delete，再装 formatjs polyfill，再装 zh.mjs`);
  ok('delete globalThis.Intl 生效', deleted, true);
  okTrue('polyfill import 不抛异常', polyErr === null, polyErr ? String(polyErr.message) : 'ok');
  ok('polyfill 之后 Intl.DateTimeFormat 可用', polyOk, true);
  ok('polyfill 的 en-US 基准可用（非中文）', /AM|PM/.test(String(polyEnUS)), true);

  let zhErr = null;
  let info = null;
  let modUrl = null;
  try {
    modUrl = pathToFileURL(ZH_PATH).href + '?coexist=1';
    const mod = await import(modUrl);
    info = mod.__info;
  } catch (e) {
    zhErr = e;
  }
  okTrue('zh.mjs import 不抛异常（small-icu/none 共存的关键）', zhErr === null, zhErr ? String(zhErr.stack) : 'ok');
  okTrue('__info.enabled 为 true（polyfill 无 zh 数据 → 必须接管）', info?.enabled === true, JSON.stringify(info));

  const tlsAfter = Date.prototype.toLocaleString;
  ok('Date.prototype.toLocaleString 被替换', tlsAfter !== polyTLS, true);
  okTrue('Intl.DateTimeFormat 被替换', globalThis.Intl.DateTimeFormat !== SNAP.dtf, 'replaced');

  // 最关键：最终输出必须是中文
  const got = ev(() => new Date(T_1430).toLocaleString('zh-CN', { timeZone: TZ }));
  ok('共存后 toLocaleString(zh-CN) 输出中文格式', got.v, '2026/11/20 14:30:00');
  const gotNoLocale = ev(() => new Date(T_1430).toLocaleString(undefined, { timeZone: TZ }));
  ok('共存后 toLocaleString() 无 locale 也是中文', gotNoLocale.v, '2026/11/20 14:30:00');
  const gotIntl = ev(() => new globalThis.Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: TZ }).format(new Date(T_1430)));
  ok('共存后 Intl 年月日', gotIntl.v, '2026年11月20日');
  okTrue('共存后输出无 AM/PM', !/AM|PM/.test(String(got.v)), String(got.v));

  // 透传仍要落到 polyfill 上（不能把 en 用户改成中文）
  const enGot = ev(() => new Date(T_1430).toLocaleString('en-US', { timeZone: TZ }));
  ok('共存后 en-US 仍透传给 polyfill', enGot.v, polyEnUS);

  // 幂等：再 import 一次（新 URL = 新模块实例）
  const fmtBefore = globalThis.Intl.DateTimeFormat;
  const again = await import(modUrl + '&twice=1');
  ok('二次 import 的 info.enabled', again.__info?.enabled, true);
  ok('二次 import 不重复包装 toLocaleString', Date.prototype.toLocaleString === tlsAfter, true);
  ok('二次 import 不重复包装 Intl.DateTimeFormat', globalThis.Intl.DateTimeFormat === fmtBefore, true);
  ok('二次 import 后输出不变', ev(() => new Date(T_1430).toLocaleString('zh-CN', { timeZone: TZ })).v, '2026/11/20 14:30:00');

  // polyfill 自带的 zh-CN 探测结果（解释 __info.reason 是否符合预期）
  okTrue('polyfill 的 zh-CN 自身不含汉字（这正是要打补丁的原因）',
    !/[\u4e00-\u9fff]/.test(String(polyZhCN)), JSON.stringify(polyZhCN));

  console.log(`\n[coexist] pass=${R.pass} fail=${R.fail}`);
  process.exit(R.fail === 0 ? 0 : 1);
}

// ===========================================================================
// 生产路径：small-icu（Intl 在、只有 en 数据）+ auto 自检 → 必须自己接管
// 本机是 full-icu，用「所有 locale 一律按 en-US 构造」的 Proxy 模拟 small-icu 的
// 可观测行为。必须在 import zh.mjs 之前装好。
// ===========================================================================
if (STAGE === 'smallicu') {
  const Real = globalThis.Intl.DateTimeFormat;
  globalThis.Intl.DateTimeFormat = new Proxy(Real, {
    construct: (t, args) => Reflect.construct(t, ['en-US', args[1]]),
    apply: (t, _this, args) => Reflect.construct(t, ['en-US', args[1]]),
  });
  const simBase = Date.prototype.toLocaleString;
  const simEnUS = simBase.call(new Date(T_1430), 'en-US', { timeZone: TZ });

  const mod = await import(pathToFileURL(ZH_PATH).href + '?sim=1');
  group('C small-icu + auto（真机 full 构建的实际路径）');
  ok('__info.enabled', mod.__info.enabled, true);
  ok('__info.reason', mod.__info.reason, 'small-icu: Intl present but only en locale data');
  ok('接管后输出中文', new Date(T_1430).toLocaleString('zh-CN', { timeZone: TZ }), '2026/11/20 14:30:00');
  ok('Intl 年月日', new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: TZ }).format(new Date(T_1430)), '2026年11月20日');
  ok('en-US 仍透传给（被模拟的）原生', new Date(T_1430).toLocaleString('en-US', { timeZone: TZ }), simEnUS);
  console.log(`\n[smallicu] pass=${R.pass} fail=${R.fail}`);
  process.exit(R.fail === 0 ? 0 : 1);
}

// ===========================================================================
// 保命阀：DSH_INTL_ZH=0 → 必须一个字都不改
// ===========================================================================
if (STAGE === 'off') {
  const before = { tls: Date.prototype.toLocaleString, dtf: globalThis.Intl.DateTimeFormat };
  const mod = await import(pathToFileURL(ZH_PATH).href + '?off=1');
  group('D DSH_INTL_ZH=0 保命阀');
  ok('__info.enabled', mod.__info.enabled, false);
  ok('__info.reason', mod.__info.reason, 'DSH_INTL_ZH=0');
  ok('Date.prototype.toLocaleString 未被替换', Date.prototype.toLocaleString === before.tls, true);
  ok('Intl.DateTimeFormat 未被替换', globalThis.Intl.DateTimeFormat === before.dtf, true);
  ok('zh-CN 仍是原生结果（未接管）',
    new Date(T_1430).toLocaleString('zh-CN', { timeZone: TZ }),
    before.tls.call(new Date(T_1430), 'zh-CN', { timeZone: TZ }));
  console.log(`\n[off] pass=${R.pass} fail=${R.fail}`);
  process.exit(R.fail === 0 ? 0 : 1);
}

// ===========================================================================
// 主阶段
// ===========================================================================
if (MODE !== 'force') {
  console.error('本脚本必须在 DSH_INTL_ZH=force 下跑（auto 在完整 ICU 桌面会整体跳过，测不到逻辑）');
  process.exit(2);
}

const zhMod = await import(pathToFileURL(ZH_PATH).href);
const info = zhMod.__info;

/** Intl 构造器路径（空 options = 只有日期，规范如此） */
const zhFmt = (opts, ms, tz = TZ) =>
  new Intl.DateTimeFormat('zh-CN', { ...opts, timeZone: tz }).format(new Date(ms));
/** Date 方法路径（空 options = 日期+时间） */
const zhDT = (ms, tz = TZ) => new Date(ms).toLocaleString('zh-CN', { timeZone: tz });

group('0 环境');
ok('__info.enabled', info.enabled, true);
ok('__info.reason', info.reason, 'DSH_INTL_ZH=force');

// ---------------------------------------------------------------------------
group('A1 时区换算（UTC → Asia/Shanghai）');
ok('UTC 06:30 → 上海 14:30', zhDT(T_1430), '2026/11/20 14:30:00');
ok('对照独立 oracle（原生 tzdata 取数字）', zhDT(T_1430), oracleDateTime(T_1430, TZ));
ok('UTC 16:00 → 次日 00:00（不能出现 24:00）', zhDT(T_MID), '2026/11/21 00:00:00');
ok('对照 oracle（午夜）', zhDT(T_MID), oracleDateTime(T_MID, TZ));
okTrue('午夜输出不含 "24"', !/24/.test(zhDT(T_MID)), zhDT(T_MID));
ok('午夜日期确实进位到 21 日', zhFmt({ year: 'numeric', month: 'numeric', day: 'numeric' }, T_MID), '2026/11/21');
ok('午夜只给小时', zhFmt({ hour: 'numeric' }, T_MID), '0时');
ok('午夜 2-digit 小时', zhFmt({ hour: '2-digit', minute: '2-digit' }, T_MID), '00:00');
ok('UTC 时区输出（回到 06:30）', zhDT(T_1430, 'UTC'), '2026/11/20 06:30:00');
ok('Intl 空 options 只有日期（与规范一致）', zhFmt({}, T_1430), '2026/11/20');

// ---------------------------------------------------------------------------
group('A2 极端时区');
// Pacific/Kiritimati = UTC+14：UTC 19 日 10:00 = 当地 20 日 00:00（正好跨日）
const T_KIRI_MID = Date.UTC(2026, 10, 19, 10, 0, 0);
ok('Kiritimati(+14) UTC 10:00 → 当地次日 00:00', zhDT(T_KIRI_MID, 'Pacific/Kiritimati'), '2026/11/20 00:00:00');
ok('Kiritimati(+14) 对照 oracle', zhDT(T_KIRI_MID, 'Pacific/Kiritimati'), oracleDateTime(T_KIRI_MID, 'Pacific/Kiritimati'));
ok('Kiritimati(+14) 前一分钟 = 23:59 前一天', zhDT(T_KIRI_MID - 60000, 'Pacific/Kiritimati'), '2026/11/19 23:59:00');
// Pacific/Niue = UTC-11
ok('Niue(-11) UTC 06:30 → 当地前一天 19:30', zhDT(T_1430, 'Pacific/Niue'), '2026/11/19 19:30:00');
ok('Niue(-11) 对照 oracle', zhDT(T_1430, 'Pacific/Niue'), oracleDateTime(T_1430, 'Pacific/Niue'));
// 负偏移跨月：UTC 2026-11-01T00:30Z → Niue 10-31 13:30
ok('Niue(-11) 跨月回退', zhDT(Date.UTC(2026, 10, 1, 0, 30), 'Pacific/Niue'), '2026/10/31 13:30:00');
// 印度 +5:30 半小时偏移
ok('Asia/Kolkata(+05:30)', zhDT(T_1430, 'Asia/Kolkata'), '2026/11/20 12:00:00');
// 尼泊尔 +5:45
ok('Asia/Kathmandu(+05:45)', zhDT(T_1430, 'Asia/Kathmandu'), '2026/11/20 12:15:00');
// America/New_York 2026-03-08 07:00Z：EST(-5) 02:00 跳过 → EDT(-4) 03:00
const T_DST = Date.UTC(2026, 2, 8, 7, 0, 0);
ok('NY DST 切换日 07:00Z → 03:00（不是 02:00）', zhDT(T_DST, 'America/New_York'), '2026/3/8 03:00:00');
ok('NY DST 切换日对照 oracle', zhDT(T_DST, 'America/New_York'), oracleDateTime(T_DST, 'America/New_York'));
ok('NY DST 切换前一秒 06:59:59Z → 01:59:59', zhDT(T_DST - 1000, 'America/New_York'), '2026/3/8 01:59:59');
// 秋季回拨 2026-11-01：05:30Z = 01:30 EDT，06:30Z = 01:30 EST（同一墙上时间，靠时区名区分）
const FALL1 = Date.UTC(2026, 10, 1, 5, 30);
const FALL2 = Date.UTC(2026, 10, 1, 6, 30);
ok('NY 回拨 05:30Z 墙上时间 01:30', zhDT(FALL1, 'America/New_York'), '2026/11/1 01:30:00');
ok('NY 回拨 06:30Z 墙上时间也是 01:30（重复小时）', zhDT(FALL2, 'America/New_York'), '2026/11/1 01:30:00');
const n1 = zhFmt({ hour: 'numeric', minute: 'numeric', timeZoneName: 'short' }, FALL1, 'America/New_York');
const n2 = zhFmt({ hour: 'numeric', minute: 'numeric', timeZoneName: 'short' }, FALL2, 'America/New_York');
okTrue('回拨前后时区名不同（EDT vs EST，证明偏移算对了）', n1 !== n2, `${JSON.stringify(n1)} vs ${JSON.stringify(n2)}`);
ok('DST 切换日日期不串（03-07）', zhDT(Date.UTC(2026, 2, 7, 12, 0), 'America/New_York'), '2026/3/7 07:00:00');

// ---------------------------------------------------------------------------
group('A3 闰日');
const LEAP = Date.UTC(2024, 1, 29, 12, 0, 0); // 上海 20:00
ok('2024-02-29 20:00', zhDT(LEAP), '2024/2/29 20:00:00');
ok('闰日对照 oracle', zhDT(LEAP), oracleDateTime(LEAP, TZ));
ok('闰日 年月日风格', zhFmt({ dateStyle: 'long' }, LEAP), '2024年2月29日');
ok('闰日星期（2024-02-29 是周四）', zhFmt({ weekday: 'long' }, LEAP), '星期四');
ok('闰日 2-digit 补零', zhFmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, LEAP), '2024/02/29');
// 闰日边界：当地 2024-02-29 00:00（UTC 02-28 16:00）
ok('闰日当地零点', zhDT(Date.UTC(2024, 1, 28, 16, 0), TZ), '2024/2/29 00:00:00');
// 非闰年 2023-02-29 会进位到 3/1
ok('2023 无 2/29（构造即进位 3/1）', zhFmt({ dateStyle: 'short' }, Date.UTC(2023, 1, 29, 4, 0), TZ), '2023/3/1');

// ---------------------------------------------------------------------------
group('A4 locale 透传（逐字符等于原生；force 模式下也必须透传）');
const d0 = new Date(T_1430);
const CASES = [
  ['toLocaleString(en-US)', () => d0.toLocaleString('en-US', { timeZone: TZ }), () => SNAP.tls.call(d0, 'en-US', { timeZone: TZ })],
  ['toLocaleString(en-GB)', () => d0.toLocaleString('en-GB', { timeZone: TZ }), () => SNAP.tls.call(d0, 'en-GB', { timeZone: TZ })],
  ['toLocaleString(de-DE)', () => d0.toLocaleString('de-DE', { timeZone: TZ }), () => SNAP.tls.call(d0, 'de-DE', { timeZone: TZ })],
  ['toLocaleString(ja-JP)', () => d0.toLocaleString('ja-JP', { timeZone: TZ }), () => SNAP.tls.call(d0, 'ja-JP', { timeZone: TZ })],
  ['toLocaleString(fr-FR, dateStyle full)', () => d0.toLocaleString('fr-FR', { dateStyle: 'full', timeZone: TZ }), () => SNAP.tls.call(d0, 'fr-FR', { dateStyle: 'full', timeZone: TZ })],
  ['toLocaleDateString(en-GB)', () => d0.toLocaleDateString('en-GB', { timeZone: TZ }), () => SNAP.tlds.call(d0, 'en-GB', { timeZone: TZ })],
  ['toLocaleTimeString(de-DE)', () => d0.toLocaleTimeString('de-DE', { timeZone: TZ }), () => SNAP.tlts.call(d0, 'de-DE', { timeZone: TZ })],
  ['toLocaleString(["en-US"]) 数组', () => d0.toLocaleString(['en-US'], { timeZone: TZ }), () => SNAP.tls.call(d0, ['en-US'], { timeZone: TZ })],
  ['toLocaleString(["de-DE","en-US"]) 数组', () => d0.toLocaleString(['de-DE', 'en-US'], { timeZone: TZ }), () => SNAP.tls.call(d0, ['de-DE', 'en-US'], { timeZone: TZ })],
  ['toLocaleString(en, hour12:true)', () => d0.toLocaleString('en', { hour: 'numeric', hour12: true, timeZone: TZ }), () => SNAP.tls.call(d0, 'en', { hour: 'numeric', hour12: true, timeZone: TZ })],
  ['Intl(en-US).dateStyle long', () => new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: TZ }).format(d0), () => new N('en-US', { dateStyle: 'long', timeZone: TZ }).format(d0)],
  ['Intl(en-GB).timeStyle medium', () => new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium', timeZone: TZ }).format(d0), () => new N('en-GB', { timeStyle: 'medium', timeZone: TZ }).format(d0)],
  ['Intl(ja-JP).weekday long', () => new Intl.DateTimeFormat('ja-JP', { weekday: 'long', timeZone: TZ }).format(d0), () => new N('ja-JP', { weekday: 'long', timeZone: TZ }).format(d0), true],
  ['Intl(en-US).formatToParts 逐 part', () => JSON.stringify(new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: TZ }).formatToParts(d0)), () => JSON.stringify(new N('en-US', { dateStyle: 'full', timeZone: TZ }).formatToParts(d0))],
  ['Intl(en-US).resolvedOptions().locale', () => new Intl.DateTimeFormat('en-US', { timeZone: TZ }).resolvedOptions().locale, () => new N('en-US', { timeZone: TZ }).resolvedOptions().locale],
  ['Intl(en-US).resolvedOptions().timeZone', () => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' }).resolvedOptions().timeZone, () => new N('en-US', { timeZone: 'America/New_York' }).resolvedOptions().timeZone],
  ['Intl(en-US) 无 options', () => new Intl.DateTimeFormat('en-US').format(d0), () => new N('en-US').format(d0)],
  ['Intl(en-US) 无 new 调用', () => Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeZone: TZ }).format(d0), () => N('en-US', { dateStyle: 'short', timeZone: TZ }).format(d0)],
];
for (const [label, mine, theirs, cjk] of CASES) {
  const a = ev(mine);
  const b = ev(theirs);
  const norm = (x) => (x.e ? `throw:${x.e}` : x.v);
  // 不允许「补丁返回了中文」这种伪装透传；ja-JP 本身就有汉字，跳过这条守卫
  if (!cjk) {
    okTrue(`${label} 未出现汉字（确实是透传）`, !/[\u4e00-\u9fff]/.test(String(norm(a))), String(norm(a)).slice(0, 60));
  }
  ok(label, norm(a), norm(b));
}

// ---------------------------------------------------------------------------
group('A5 非法 / 异常输入（与原生逐项对照，格式取两边一致的 dateStyle:short）');
const INVALID_INPUTS = [
  ['new Date("x")', new Date('x')],
  ['NaN', NaN],
  ['undefined', undefined],
  ['null', null],
  ['1234567890 数字时间戳', 1234567890],
  ['0', 0],
  ['-1', -1],
  ['true', true],
  ['"2026-11-20T06:30:00Z" 字符串', '2026-11-20T06:30:00Z'],
  ['{} 空对象', {}],
];
const nativeShort = new N('zh-CN', { dateStyle: 'short', timeZone: 'UTC' });
const mineShort = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeZone: 'UTC' });
for (const [label, input] of INVALID_INPUTS) {
  const a = ev(() => mineShort.format(input));
  const b = ev(() => nativeShort.format(input));
  const norm = (x) => (x.e ? `throw:${x.e}` : x.v);
  diff(`format(${label})`, norm(a), norm(b));
}
// formatToParts 同一条边界
diff('formatToParts(new Date("x"))',
  ev(() => JSON.stringify(mineShort.formatToParts(new Date('x')))).e ?? 'ok',
  ev(() => JSON.stringify(nativeShort.formatToParts(new Date('x')))).e ?? 'ok');
// Date.prototype 版本：规范要求返回字符串 'Invalid Date'，不抛
const badDate = new Date('x');
ok('new Date("x").toLocaleString(zh-CN)', badDate.toLocaleString('zh-CN'), 'Invalid Date');
ok('new Date("x").toLocaleString() 无 locale', badDate.toLocaleString(), 'Invalid Date');
ok('new Date("x").toLocaleDateString()', badDate.toLocaleDateString(), 'Invalid Date');
ok('new Date("x").toLocaleTimeString()', badDate.toLocaleTimeString(), 'Invalid Date');
ok('对照原生（同为 Invalid Date）', SNAP.tls.call(badDate, 'en-US'), 'Invalid Date');
// this 不是 Date
okThrows('toLocaleString.call({}) 抛 TypeError', () => Date.prototype.toLocaleString.call({}, 'zh-CN'), 'TypeError');
okThrows('toLocaleString.call(null) 抛 TypeError', () => Date.prototype.toLocaleString.call(null, 'zh-CN'), 'TypeError');
okThrows('原生 toLocaleString.call({}) 也抛 TypeError', () => SNAP.tls.call({}, 'en-US'), 'TypeError');
// 非法 timeZone / dateStyle：必须与原生抛同类异常
okThrows('非法 timeZone 抛 RangeError', () => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Mars/Olympus' }), 'RangeError');
okThrows('原生非法 timeZone 也抛 RangeError', () => new N('zh-CN', { timeZone: 'Mars/Olympus' }), 'RangeError');
okThrows('非法 dateStyle 抛 RangeError', () => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'nope' }), 'RangeError');
okThrows('dateStyle 与 year 混用抛 TypeError', () => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', year: 'numeric' }), 'TypeError');
okThrows('原生 dateStyle 与 year 混用也抛 TypeError', () => new N('zh-CN', { dateStyle: 'short', year: 'numeric' }), 'TypeError');
okThrows('timeStyle 与 hour 混用抛 TypeError', () => new Intl.DateTimeFormat('zh-CN', { timeStyle: 'short', hour: 'numeric' }), 'TypeError');

// ---------------------------------------------------------------------------
group('A6 不带 new 调用 Intl.DateTimeFormat');
// 先记录原生的真实行为（本任务书假设「原生会抛 TypeError」，这一点需要实测）
const nativeNoNew = ev(() => N('en-US').format(new Date(T_1430)));
const mineNoNew = ev(() => Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeZone: TZ }).format(new Date(T_1430)));
ok('原生支持不带 new（ECMA-402 允许）', nativeNoNew.e ? `throw:${nativeNoNew.e}` : 'object-ok', 'object-ok');
ok('补丁版不带 new 也不抛，且返回中文', mineNoNew.e ? `throw:${mineNoNew.e}` : mineNoNew.v, '2026/11/20');
okTrue('不带 new 的返回是 DateTimeFormat 实例',
  (() => { try { return Intl.DateTimeFormat('zh-CN') instanceof Intl.DateTimeFormat; } catch { return false; } })(), 'true');
okTrue('补丁只换 DateTimeFormat，其他 Intl 构造器仍在',
  ['NumberFormat', 'Collator', 'RelativeTimeFormat', 'PluralRules', 'ListFormat', 'DisplayNames']
    .every((k) => typeof Intl[k] === 'function' && (k === 'DisplayNames' || Intl[k].name === k)),
  ['NumberFormat', 'Collator', 'RelativeTimeFormat', 'PluralRules', 'ListFormat', 'DisplayNames'].map((k) => `${k}:${typeof Intl[k]}`).join(' '));

// ---------------------------------------------------------------------------
group('A7 getter 语义（format 必须是稳定引用）');
const fA = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeZone: TZ });
ok('f.format === f.format', fA.format === fA.format, true);
const g1 = fA.format;
const g2 = fA.format;
ok('两次取值同一引用', g1 === g2, true);
okTrue('format 是 accessor（原型上是 getter）',
  typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fA), 'format')?.get === 'function', 'accessor');
ok('脱离 this 调用 format', g1(new Date(T_1430)), '2026/11/20');
ok('不同实例的 format 不共享', fA.format === new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeZone: TZ }).format, false);
// 原生也是每次返回同一函数（对齐检查）
const nf = new N('en-US', { dateStyle: 'short' });
ok('原生 f.format === f.format 同样为 true', nf.format === nf.format, true);

// ---------------------------------------------------------------------------
group('A8 resolvedOptions');
const ro = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', timeZone: 'America/New_York' }).resolvedOptions();
ok('locale', ro.locale, 'zh-CN');
ok('timeZone', ro.timeZone, 'America/New_York');
ok('calendar', ro.calendar, 'gregory');
ok('numberingSystem', ro.numberingSystem, 'latn');
ok('month 回显', ro.month, 'long');
// 无 hour 字段的 formatter：原生 resolvedOptions() 根本不返回 hourCycle，
// 补丁严格对齐原生 → 'hourCycle' in ro 必须为 false（不能用 includes(undefined) 判）。
ok('无 hour 时 resolvedOptions 不含 hourCycle 键（与原生一致）', 'hourCycle' in ro, false);
// 含 hour 字段的 formatter：才应该有合法的 hourCycle。
const roHour = new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', minute: 'numeric', timeZone: TZ }).resolvedOptions();
okTrue('含 hour 时 hourCycle 合法', ['h11', 'h12', 'h23', 'h24'].includes(roHour.hourCycle), roHour.hourCycle);
const roDefault = new Intl.DateTimeFormat('zh-CN').resolvedOptions();
ok('默认 timeZone 与原生默认一致', roDefault.timeZone, new N('en-US').resolvedOptions().timeZone);
okTrue('resolvedOptions 无 undefined 值', Object.values(ro).every((v) => v !== undefined), JSON.stringify(ro));

// ---------------------------------------------------------------------------
group('A9 原型污染 / 属性描述符');
ok('Object.keys(Date.prototype) 前后一致', JSON.stringify(Object.keys(Date.prototype)), JSON.stringify(SNAP.dateProtoKeys));
ok('Object.getOwnPropertyNames(Date.prototype) 前后一致', JSON.stringify(Object.getOwnPropertyNames(Date.prototype)), JSON.stringify(SNAP.dateProtoNames));
ok('for...in new Date() 前后一致', JSON.stringify((() => { const o = []; for (const k in new Date(0)) o.push(k); return o; })()), JSON.stringify(SNAP.dateEnum));
ok('Object.keys(new Date()) 前后一致', JSON.stringify(Object.keys(new Date(0))), JSON.stringify(SNAP.datePropKeys));
ok('Object.getOwnPropertyNames(Intl) 前后一致', JSON.stringify(Object.getOwnPropertyNames(Intl)), JSON.stringify(SNAP.intlNames));
for (const m of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
  const d = Object.getOwnPropertyDescriptor(Date.prototype, m);
  ok(`${m}.enumerable === false`, d.enumerable, false);
  ok(`${m}.writable === true`, d.writable, true);
  ok(`${m}.configurable === true`, d.configurable, true);
  ok(`${m}.name 保持`, d.value.name, m);
}
// 任务书原话「length 不应被改成 0」有误：原生三个 toLocale* 的 length 本来就是 0，
// 正确要求是「补丁后仍与原生一致」。原先那条 `!== 0` 与本条自相矛盾，已删除，
// 改为一次性比对三个方法的 length（并覆盖 toLocaleDateString / toLocaleTimeString）。
ok('补丁后三个 toLocale* 的 length 均与原生一致',
  ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].map((m) => Date.prototype[m].length),
  ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'].map((m) => SNAP.dateProtoDescs[m].value.length));
ok('补丁后 toLocaleString.length 与原生一致', Date.prototype.toLocaleString.length, SNAP.dateProtoDescs.toLocaleString.value.length);
ok('Intl.DateTimeFormat.length 未变', Intl.DateTimeFormat.length, SNAP.dtf.length);
ok('Intl.DateTimeFormat.name 未变', Intl.DateTimeFormat.name, SNAP.dtf.name);

// ---------------------------------------------------------------------------
group('A10 幂等');
const tlsBefore = Date.prototype.toLocaleString;
const dtfBefore = Intl.DateTimeFormat;
const twice = await import(pathToFileURL(ZH_PATH).href + '?twice=1');
ok('二次 import 的 __info.enabled', twice.__info?.enabled, true);
ok('二次 import 不重复包装 toLocaleString', Date.prototype.toLocaleString === tlsBefore, true);
ok('二次 import 不重复包装 Intl.DateTimeFormat', Intl.DateTimeFormat === dtfBefore, true);
ok('二次 import 后输出不变', new Date(T_1430).toLocaleString('zh-CN', { timeZone: TZ }), '2026/11/20 14:30:00');
ok('Symbol.for 标记存在', typeof globalThis[Symbol.for('dsh.intl.zh')], 'object');
ok('标记 installed=true', globalThis[Symbol.for('dsh.intl.zh')].installed, true);
// 同 URL 再 import（ESM 缓存命中）也不能变
const sameUrl = await import(pathToFileURL(ZH_PATH).href);
ok('同 URL 二次 import 返回同一命名空间', sameUrl === zhMod, true);

// ---------------------------------------------------------------------------
group('A11 额外攻击面（任务书没要求，但插件真会这么写）');
ok('formatRange 中文', new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeZone: TZ }).formatRange(new Date(T_1430), new Date(T_1430 + 86400000)), '2026年11月20日 – 2026年11月21日');
okTrue('formatRangeToParts 有 startRange/endRange',
  (() => { const p = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeZone: TZ }).formatRangeToParts(new Date(T_1430), new Date(T_1430 + 86400000)); return p.some((x) => x.source === 'startRange') && p.some((x) => x.source === 'endRange'); })(), 'true');
ok('formatToParts 拼回去等于 format',
  new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeZone: TZ }).formatToParts(new Date(T_1430)).map((p) => p.value).join(''),
  '2026年11月20日星期五');
ok('Date 子类可用', (() => { class D extends Date { } return new D(T_1430).toLocaleString('zh-CN', { timeZone: TZ }); })(), '2026/11/20 14:30:00');
ok('跨 module 复制的 formatter 可复用', (() => { const f = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeZone: TZ }); return f.format(new Date(T_1430)) + '/' + f.format(new Date(T_1430)); })(), '2026/11/20/2026/11/20');
okThrows('formatRange 传非法值抛 RangeError', () => new Intl.DateTimeFormat('zh-CN', {}).formatRange(new Date('x'), new Date()), 'RangeError');

// 请求的字段是否真的出现在 formatToParts 里（抓「字段被静默丢弃」）
group('A12 字段完整性：请求了什么，formatToParts 里就必须有对应 type');
const FIELD_SWEEP = [
  {}, { dateStyle: 'short' }, { dateStyle: 'medium' }, { dateStyle: 'full' },
  { timeStyle: 'short' }, { timeStyle: 'medium' }, { timeStyle: 'long' },
  { dateStyle: 'full', timeStyle: 'full' },
  { year: 'numeric' }, { year: '2-digit' }, { month: 'numeric' }, { month: '2-digit' },
  { month: 'long' }, { month: 'short' }, { month: 'narrow' },
  { day: 'numeric' }, { day: '2-digit' },
  { weekday: 'long' }, { weekday: 'short' }, { weekday: 'narrow' },
  { hour: 'numeric' }, { hour: '2-digit' }, { minute: 'numeric' }, { second: 'numeric' },
  { hour: 'numeric', minute: 'numeric' }, { hour: '2-digit', minute: '2-digit' },
  { hour: 'numeric', minute: 'numeric', second: 'numeric' },
  { hour: 'numeric', second: 'numeric' },          // 无 minute
  { minute: 'numeric', second: 'numeric' },        // 无 hour
  { dayPeriod: 'long', hour: 'numeric' },
  { era: 'short', year: 'numeric' },
  { year: 'numeric', month: 'long', day: 'numeric' },
  { year: 'numeric', month: 'numeric', day: 'numeric' },
  { year: 'numeric', month: '2-digit', day: '2-digit' },
  { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' },
  { timeZoneName: 'short' }, { timeZoneName: 'long' },
  { hour: 'numeric', minute: 'numeric', timeZoneName: 'short' },
  { hour: 'numeric', minute: 'numeric', second: 'numeric', fractionalSecondDigits: 3 },
  { hour12: true, hour: 'numeric', minute: 'numeric' },
  { hourCycle: 'h11', hour: 'numeric', minute: 'numeric' },
  { hourCycle: 'h24', hour: 'numeric' },
];
const STYLE_DATE = { short: ['year', 'month', 'day'], medium: ['year', 'month', 'day'], long: ['year', 'month', 'day'], full: ['year', 'month', 'day', 'weekday'] };
const STYLE_TIME = { short: ['hour', 'minute'], medium: ['hour', 'minute', 'second'], long: ['hour', 'minute', 'second', 'timeZoneName'], full: ['hour', 'minute', 'second', 'timeZoneName'] };
function requiredTypes(opts) {
  const t = new Set();
  if (opts.dateStyle) STYLE_DATE[opts.dateStyle].forEach((x) => t.add(x));
  if (opts.timeStyle) STYLE_TIME[opts.timeStyle].forEach((x) => t.add(x));
  for (const k of ['year', 'month', 'day', 'weekday', 'hour', 'minute', 'second', 'dayPeriod', 'timeZoneName', 'era']) {
    if (opts[k] !== undefined) t.add(k);
  }
  if (opts.fractionalSecondDigits !== undefined) t.add('fractionalSecond');
  return [...t];
}
const diffs = [];
for (const opts of FIELD_SWEEP) {
  const o = { ...opts, timeZone: TZ };
  const label = JSON.stringify(opts);
  const mine = ev(() => {
    const p = new Intl.DateTimeFormat('zh-CN', o).formatToParts(new Date(T_1430));
    return { types: [...new Set(p.map((x) => x.type))].filter((x) => x !== 'literal'), text: p.map((x) => x.value).join('') };
  });
  const nat = ev(() => new N('zh-CN', o).format(new Date(T_1430)));
  const missing = mine.v ? requiredTypes(opts).filter((t) => !mine.v.types.includes(t)) : ['<throw>'];
  if (missing.length > 0) {
    R.fail += 1;
    R.failures.push({ group: CUR.group, label: `字段丢失 ${label}`, expected: requiredTypes(opts).join(','), actual: `missing=${missing.join(',')} 输出=${JSON.stringify(mine.v?.text ?? mine.e)}` });
    console.log(`  FAIL ${label} 请求字段 ${JSON.stringify(requiredTypes(opts))} 中缺失 ${JSON.stringify(missing)}  → 实际输出 ${JSON.stringify(mine.v?.text ?? mine.e)}`);
  } else {
    R.pass += 1;
    if (!QUIET) console.log(`  ok   ${label} => ${JSON.stringify(mine.v.text)}`);
  }
  if (nat.e || nat.v !== mine.v?.text) {
    diffs.push({ opts: label, native: nat.e ? `throw:${nat.e}` : nat.v, mine: mine.v?.text ?? `throw:${mine.e}` });
  }
}

// 与原生 zh-CN 的差分清单（不判失败，只披露；便于人眼复核哪些差异是「约定」哪些是「丢信息」）
group('A13 与原生 zh-CN 的差分清单（披露用，不计入 pass/fail）');
console.log(`  共 ${FIELD_SWEEP.length} 组 option，其中 ${diffs.length} 组输出与原生 zh-CN 不同：`);
for (const d of diffs) {
  console.log(`  · ${d.opts}`);
  console.log(`      原生: ${JSON.stringify(d.native)}`);
  console.log(`      补丁: ${JSON.stringify(d.mine)}`);
}

// ---------------------------------------------------------------------------
group('A14 默认路径与原生 zh-CN 逐字符一致（本机 full-icu 可直接当 oracle）');
for (const [label, opts] of [
  ['toLocaleString 默认', null],
  ['dateStyle full', { dateStyle: 'full' }],
  ['dateStyle medium', { dateStyle: 'medium' }],
  ['dateStyle short', { dateStyle: 'short' }],
  ['timeStyle medium', { timeStyle: 'medium' }],
  ['weekday long', { weekday: 'long' }],
  ['年月日 long月', { year: 'numeric', month: 'long', day: 'numeric' }],
  ['2-digit 补零', { year: 'numeric', month: '2-digit', day: '2-digit' }],
]) {
  const o = opts ? { ...opts, timeZone: TZ } : { timeZone: TZ };
  const mine = ev(() => new Date(T_1430).toLocaleString('zh-CN', o));
  const nat = ev(() => SNAP.tls.call(new Date(T_1430), 'zh-CN', o));
  diff(`默认路径 ${label}`, mine.v ?? `throw:${mine.e}`, nat.v ?? `throw:${nat.e}`);
}
// resolvedOptions 的键集合差异（披露，不判失败）
const roMine = Object.keys(new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short' }).resolvedOptions()).sort();
const roNat = Object.keys(new N('zh-CN', { dateStyle: 'short' }).resolvedOptions()).sort();
console.log(`  · resolvedOptions 键集合：原生 ${JSON.stringify(roNat)}`);
console.log(`                            补丁 ${JSON.stringify(roMine)}`);

// ---------------------------------------------------------------------------
group('A15 本轮 5 处修复的独立验证（format 缺参 / 字段组合 / formatRange 同日）');

/**
 * 不传参 / 传 undefined 调 format：既要不抛，又要落回「当刻」。
 * 判据：调用前后各取一次 format(new Date()) 作候选集，结果必须落在集合内
 * （避开跨秒/跨日抖动，不需要 sleep，也不依赖机器时钟的绝对值）。
 */
function probeNoArg(fmt, useUndefined) {
  const before = fmt.format(new Date());
  const got = useUndefined ? ev(() => fmt.format(undefined)) : ev(() => fmt.format());
  const after = fmt.format(new Date());
  const set = [...new Set([before, after])];
  const pass = got.e === undefined && set.includes(got.v);
  const detail = got.e ? `throw:${got.e}` : `${JSON.stringify(got.v)} ∈ ${JSON.stringify(set)}`;
  return { pass, detail };
}

// 只含日期：证明「不抛 + 落回今天」
const fNoArg = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeZone: TZ });
const pNoArg = probeNoArg(fNoArg, false);
okTrue('fmt.format()（不传参）不抛且返回当刻日期', pNoArg.pass, pNoArg.detail);
const pUndef = probeNoArg(fNoArg, true);
okTrue('fmt.format(undefined) 不抛且返回当刻日期', pUndef.pass, pUndef.detail);

// 含时间：证明「返回的是当前时间」而不是某个固定串（dateStyle 看不出时分秒）
const fNoArgTime = new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium', timeZone: TZ });
const pNoArgTime = probeNoArg(fNoArgTime, false);
okTrue('fmt.format()（含时分秒）返回当刻时间', pNoArgTime.pass, pNoArgTime.detail);

// {hour, second} 无 minute：小时、分钟、秒都必须保留，且要是**真值**。
// 用秒≠0 的时刻，才能把 hour / minute / second 三个数字区分开（14:00:00 说明不了问题）。
// 注：补丁会给完整 hh:mm:ss（14:30:45）—— 编造一个 00 分钟等于输出不存在的时刻，
//     比多显示一个未请求的字段危险。原生是省略 minute 输出畸形串 "14时 (秒: 45)"，
//     两者形状不同，本条断言「hour 与 second 均正确出现」并披露差异。
const T_HMS = Date.UTC(2026, 10, 20, 6, 30, 45); // 上海 14:30:45
const hmsOracle = nativeParts(T_HMS, TZ);
const hms = ev(() => new Intl.DateTimeFormat('zh-CN', { hour: 'numeric', second: 'numeric', timeZone: TZ }).format(new Date(T_HMS)));
okTrue(`{hour:numeric, second:numeric} 含小时与秒（应为 ${p2(hmsOracle.hour)}:__:${p2(hmsOracle.second)}）`,
  hms.e === undefined
    && /^\d{2}:\d{2}:\d{2}$/.test(hms.v)
    && hms.v.startsWith(`${p2(hmsOracle.hour)}:`)
    && hms.v.endsWith(`:${p2(hmsOracle.second)}`),
  hms.e ? `throw:${hms.e}` : hms.v);
console.log(`  · 披露：{hour,second} 未请求 minute 时补丁输出完整 hh:mm:ss（分钟为真实值 ${p2(hmsOracle.minute)}），原生则给 "14时 (秒: 45)" 畸形串 —— 形状差异，字段不丢`);

// {dayPeriod, hour}：14:30 上海 → 下午
const dp = ev(() => new Intl.DateTimeFormat('zh-CN', { dayPeriod: 'long', hour: 'numeric', timeZone: TZ }).format(new Date(T_1430)));
okTrue('{dayPeriod:long, hour:numeric} 含 上午/下午 且 14:30 判为下午',
  dp.e === undefined && /上午|下午/.test(dp.v) && dp.v.includes('下午'), dp.e ? `throw:${dp.e}` : dp.v);

// {era, year}
const era = ev(() => new Intl.DateTimeFormat('zh-CN', { era: 'short', year: 'numeric', timeZone: TZ }).format(new Date(T_1430)));
okTrue('{era:short, year:numeric} 含 公元', era.e === undefined && /公元/.test(era.v), era.e ? `throw:${era.e}` : era.v);

// formatRange 同一天 +1 小时：完整日期只能出现一次（不能 "2026年11月20日 – 2026年11月20日"）
const RANGE_END = T_1430 + 3600000;
const occ = (s, re) => (String(s).match(re) || []).length;
const rLong = ev(() => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long', timeZone: TZ }).formatRange(new Date(T_1430), new Date(RANGE_END)));
ok('formatRange(同日 +1h) 完整日期只出现一次', rLong.e ? `throw:${rLong.e}` : occ(rLong.v, /2026年11月20日/g), 1);
const rBoth = ev(() => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ }).formatRange(new Date(T_1430), new Date(RANGE_END)));
ok('formatRange(同日 +1h，带时间) 日期只出现一次', rBoth.e ? `throw:${rBoth.e}` : occ(rBoth.v, /2026年11月20日/g), 1);
okTrue('formatRange(同日 +1h，带时间) 两端时间都出现',
  rBoth.e === undefined && /14:30/.test(rBoth.v) && /15:30/.test(rBoth.v), rBoth.v);

// ---------------------------------------------------------------------------
group('B 共存性（子进程：delete Intl → polyfill → zh.mjs）');
for (const [label, env] of [
  ['force', { DSH_INTL_ZH: 'force', QA_STAGE: 'coexist' }],
  ['auto（真机 none 构建的实际路径）', { DSH_INTL_ZH: '', QA_STAGE: 'coexist' }],
]) {
  const res = spawnSync(process.execPath, [SELF, '--quiet'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  okTrue(`共存性子进程 ${label} 通过（exit ${res.status}）`, res.status === 0, out.split('\n').filter((l) => l.trim()).slice(-6).join(' | '));
}

group('C/D 子进程：small-icu+auto（生产路径）与 DSH_INTL_ZH=0（保命阀）');
for (const [label, env] of [
  ['small-icu + auto', { DSH_INTL_ZH: '', QA_STAGE: 'smallicu' }],
  ['DSH_INTL_ZH=0', { DSH_INTL_ZH: '0', QA_STAGE: 'off' }],
]) {
  const res = spawnSync(process.execPath, [SELF, '--quiet'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  okTrue(`子进程 ${label} 通过（exit ${res.status}）`, res.status === 0, out.split('\n').filter((l) => l.trim()).slice(-6).join(' | '));
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n=== 合计：pass=${R.pass} fail=${R.fail} ===`);
if (R.fail > 0) {
  console.log('失败清单：');
  for (const f of R.failures) console.log(` - [${f.group}] ${f.label}: 期望 ${f.expected} / 实际 ${f.actual}`);
}
process.exit(R.fail === 0 ? 0 : 1);
