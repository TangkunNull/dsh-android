// dsh Android 运行时 Intl polyfill 入口。
//
// 背景：设备上的 libnode 来自 nodejs-mobile，其 android_configure 硬编码
// `--with-intl=none`，V8 编译时 v8_enable_i18n_support=0 —— 二进制里没有
// 任何 ICU 代码，`globalThis.Intl` 根本不存在（不是空对象）。dsh 的 13 个
// 插件直接依赖 Intl：@js-temporal/polyfill 用 Intl.DateTimeFormat 算时区
// 偏移、dsh-llm-deepseek 用 Intl.Segmenter 做字形切分、DurationFormat 用于
// 时长展示。缺了就是 `ReferenceError: Intl is not defined`，插件全部激活失败。
//
// 顺序不能乱（formatjs 官方要求）：Locale 基础设施 → 各 API → locale 数据。
// add-all-tz 必须紧跟 datetimeformat：Temporal 靠它拿到 449 个 IANA 时区的
// 历史偏移与 DST 规则；locale 数据只装 en（其余语言不装，省 180MB）。
import '@formatjs/intl-getcanonicallocales/polyfill-force.js';
import '@formatjs/intl-locale/polyfill-force.js';

import '@formatjs/intl-pluralrules/polyfill-force.js';
import '@formatjs/intl-pluralrules/locale-data/en.js';

import '@formatjs/intl-numberformat/polyfill-force.js';
import '@formatjs/intl-numberformat/locale-data/en.js';

import '@formatjs/intl-datetimeformat/polyfill-force.js';
import '@formatjs/intl-datetimeformat/add-all-tz.js';
import '@formatjs/intl-datetimeformat/locale-data/en.js';

import '@formatjs/intl-displaynames/polyfill-force.js';
import '@formatjs/intl-displaynames/locale-data/en.js';

import '@formatjs/intl-listformat/polyfill-force.js';
import '@formatjs/intl-listformat/locale-data/en.js';

// DurationFormat 与 Segmenter 的 en 数据内建在包里，不需要单独 import。
import '@formatjs/intl-durationformat/polyfill-force.js';
import '@formatjs/intl-segmenter/polyfill-force.js';

import '@formatjs/intl-supportedvaluesof/polyfill-force.js';
