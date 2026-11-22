/**
 * dsh-intl-zh —— 给 small-icu 的 Node 补上中文日期
 *
 * ## 为什么需要这个模块
 *
 * 设备上的 libnode 是 nodejs-mobile 的 full flavor，编译参数是
 * `--with-intl=small-icu`。small-icu 的语义很容易误判：
 *
 *   - `globalThis.Intl` **存在**，API 齐全；
 *   - 时区数据库**完整**（IANA tzdata 全量编进去了）；
 *   - 但 locale 文字数据只有 `en` + `root`（`icu_locales = "en,root"`）。
 *
 * 所以 `new Intl.DateTimeFormat('zh-CN', {...}).format(d)` 不报错、不抛异常，
 * 静默按 en 的规则吐出 `November 20, 2026`。dsh 的插件（React 渲染跑在 Node 里）
 * 大量用 `toLocaleString()` / `toLocaleTimeString()`，于是中文用户的界面上出现
 * 一堆英文月份名。
 *
 * 换 full-icu 要重编 libnode（26 小时）并给 APK 加 ~25 MB。这里换个便宜思路：
 * **时区换算交给原生做，文字替换自己做**。原生 `formatToParts()` 在指定时区下
 * 给出的数字是可靠的（tzdata 完整），拿到数字后按 zh-CN 的排版规则拼字符串。
 * 夏令时、跨日边界、`timeZone: 'Asia/Shanghai'` 全部自动正确，不需要我们碰
 * 任何时间算术。
 *
 * ## 覆盖范围
 *
 *   1. `Intl.DateTimeFormat`（构造函数 + 实例方法 + 静态 supportedLocalesOf）
 *   2. `Date.prototype.toLocaleString / toLocaleDateString / toLocaleTimeString`
 *   3. 只处理 zh-* 与「不传 locale」两种情况，其余 locale 原样透传给原生
 *
 * 刻意**不动**的东西（改了只增风险，收益为零）：
 *   - `Number.prototype.toLocaleString`：zh-CN 与 en-US 的千分位/小数点完全一致；
 *   - `Intl.NumberFormat` / `Intl.Collator` / `Intl.RelativeTimeFormat`：
 *     不属于日期问题，且 collator 的排序权重不是拼字符串能补的。
 *
 * ## 开关
 *
 *   - `DSH_INTL_ZH=0`      强制不启用（保命阀，出问题不用重新打包 runtime）
 *   - `DSH_INTL_ZH=force`  强制启用（在完整 ICU 的桌面 node 上测补丁逻辑本身）
 *   - 默认                自检：原生能输出汉字就整体跳过，否则打补丁
 *
 * 桌面 node（完整 ICU）上 import 这个模块是空操作，`__info.enabled === false`。
 *
 * ## 幂等
 *
 * 重复 import / 重复安装不会重复包装：状态挂在 `Symbol.for('dsh.intl.zh')` 上，
 * 这个 key 跨模块实例共享（runtime.zip 里只有一个副本，但 bundle 复制出来的
 * 多份副本也能认出彼此）。
 */

const MARK = Symbol.for('dsh.intl.zh');
const LOCALE = 'zh-CN';

/** 星期日的英文名是 `formatToParts` 在 en-US 下给出的 weekday part 值。 */
const EN_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * 纪元名：原生 `era: 'short'`（en-US）给 `AD` / `BC`。
 *
 * zh-CN 的 CLDR 数据里 short 与 long 都是「公元 / 公元前」（中文没有更短的写法），
 * 所以不必区分 `fields.era` 的取值，一律用同一张表。
 */
const ERA_TEXT = { AD: '公元', CE: '公元', BC: '公元前', BCE: '公元前' };

const WEEKDAY_LONG = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_NARROW = ['日', '一', '二', '三', '四', '五', '六'];

/** 会被 `resolvedOptions()` 原样回显的字段（其余 key 一律丢弃）。 */
const ECHO_FIELDS = [
  'weekday', 'era', 'year', 'month', 'day', 'dayPeriod', 'hour', 'minute', 'second',
  'fractionalSecondDigits', 'timeZoneName', 'dateStyle', 'timeStyle',
];

/**
 * `dateStyle` / `timeStyle` 展开成具体字段。
 *
 * zh-CN 的 CLDR 模式：
 *   short  → `y/M/d`
 *   medium → `y年M月d日`
 *   long   → `y年M月d日`（中文没有「长月份名」这一档，与 medium 同）
 *   full   → `y年M月d日EEEE`
 *
 * 月份用 `long` 表示「走 年月日 排版」，用 `numeric` 表示「走 1/5 斜杠排版」——
 * 这是我的排版开关，见 composeDate()。
 *
 * timeStyle 的 long/full 在中文里是 `zzzz` / `zzzzz`（中国标准时间），small-icu
 * 拿不到中文时区名，统一降级成 `short`（CST / GMT+8），见 nativePartsOptions()。
 */
const DATE_STYLE_FIELDS = {
  short: { year: 'numeric', month: 'numeric', day: 'numeric' },
  medium: { year: 'numeric', month: 'long', day: 'numeric' },
  long: { year: 'numeric', month: 'long', day: 'numeric' },
  full: { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' },
};

const TIME_STYLE_FIELDS = {
  short: { hour: 'numeric', minute: '2-digit' },
  medium: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  long: { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' },
  full: { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' },
};

/**
 * 默认字段表：[required, defaults]。
 *
 * `dtf` 是 `Intl.DateTimeFormat` 构造：空 options 只补日期（`2026/11/20`），
 * 而 `Date.prototype.toLocaleString` 空 options 要补日期+时间。两者不一样，
 * 这是规范里 InitializeDateTimeFormat 与 toLocaleString 的差异，不是笔误。
 */
const DATE_METHOD_DEFAULTS = {
  dtf: ['any', 'date'],
  datetime: ['any', 'all'],
  date: ['date', 'date'],
  time: ['time', 'time'],
};

// ---- 原生实现，必须在打补丁之前抓住 ------------------------------------
const NativeDateTimeFormat = globalThis.Intl?.DateTimeFormat;
const nativeToLocaleString = Date.prototype.toLocaleString;
const nativeToLocaleDateString = Date.prototype.toLocaleDateString;
const nativeToLocaleTimeString = Date.prototype.toLocaleTimeString;

// ---------------------------------------------------------------------------
// 自检与环境变量
// ---------------------------------------------------------------------------

/**
 * 原生 ICU 到底认不认中文？
 *
 * 判据很朴素：让原生格式化一个中文月份，看有没有汉字。完整 ICU 会给「十一月」
 * 或「11月」，small-icu 会给「November」或「11」——后者没有汉字。
 *
 * 用 try 包住：某些裁剪构建里 `zh-CN` 会直接抛 RangeError（locale 不在
 * 白名单里），那也算「没有中文数据」。
 */
function icuHasChinese() {
  try {
    const probe = new NativeDateTimeFormat('zh-CN', { month: 'long', timeZone: 'UTC' })
      .format(new Date(Date.UTC(2020, 0, 15)));
    return /[\u4e00-\u9fff]/.test(probe);
  } catch {
    return false;
  }
}

/** 读 `DSH_INTL_ZH`：'off' | 'force' | 'auto'。 */
function readSwitch() {
  const raw = process.env ? process.env.DSH_INTL_ZH : undefined;
  const v = (raw === undefined || raw === null ? '' : String(raw)).trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return 'off';
  if (v === 'force') return 'force';
  return 'auto';
}

// ---------------------------------------------------------------------------
// locale 判定
// ---------------------------------------------------------------------------

/** 取 locales 的第一项（字符串化）；不传或空数组返回 null 表示「用默认 locale」。 */
function firstLocaleTag(locales) {
  if (locales === undefined || locales === null) return null;
  const list = Array.isArray(locales) ? locales : [locales];
  if (list.length === 0) return null;
  const first = list[0];
  if (first === undefined || first === null) return null;
  return String(first);
}

/**
 * 该不该接管这次调用？
 *
 * 返回 `LOCALE` → 由我们输出中文；返回 `null` → 原样交给原生。
 *
 * 「不传 locale」= 用进程默认 locale = 我们要换掉的那个东西，所以也算中文目标。
 * 显式给了非 zh 的 locale（`en-US`、`ja-JP`…）必须透传 —— 不能把英文用户也改了。
 *
 * zh-TW / zh-HK / zh-Hant 也走这条分支：small-icu 下它们本来也是英文输出，
 * 给简体中文至少是中文。这是有意的取舍，见文件末尾「已知局限」。
 */
function pickLocale(locales) {
  const tag = firstLocaleTag(locales);
  if (tag === null) return LOCALE;
  return /^zh(-|$)/i.test(tag.replace(/_/g, '-')) ? LOCALE : null;
}

// ---------------------------------------------------------------------------
// options 归一化
// ---------------------------------------------------------------------------

/**
 * ECMA-402 ToDateTimeOptions 的忠实实现。
 *
 * 关键是 `needDefaults` 是**跨两个类别**的单一开关：只要用户给了任意一个日期
 * 字段或任意一个时间字段，就不补默认值。所以
 * `new Intl.DateTimeFormat('zh-CN', { hour: 'numeric' })` 只出「14时」而不是
 * 「2026/11/20 14时」——真实 ICU 就是这个行为。
 */
function toDateTimeOptions(options, required, defaults) {
  const out = { ...options };
  let needDefaults = true;
  if (required === 'date' || required === 'any') {
    for (const k of ['weekday', 'year', 'month', 'day']) {
      if (out[k] !== undefined) { needDefaults = false; break; }
    }
  }
  if (needDefaults && (required === 'time' || required === 'any')) {
    for (const k of ['dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits']) {
      if (out[k] !== undefined) { needDefaults = false; break; }
    }
  }
  if (needDefaults && (defaults === 'date' || defaults === 'all')) {
    out.year = 'numeric';
    out.month = 'numeric';
    out.day = 'numeric';
  }
  if (needDefaults && (defaults === 'time' || defaults === 'all')) {
    out.hour = 'numeric';
    out.minute = 'numeric';
    out.second = 'numeric';
  }
  return out;
}

/** `dateStyle` / `timeStyle` 的取值必须合法，否则与原生一样抛 RangeError。 */
function pickStyle(table, value, name) {
  const hit = Object.prototype.hasOwnProperty.call(table, value) ? table[value] : null;
  if (hit === null) {
    throw new RangeError(`Value ${String(value)} out of range for Intl.DateTimeFormat options property ${name}`);
  }
  return hit;
}

/**
 * `dateStyle` 与单个日期字段不能混用，`timeStyle` 与单个时间字段不能混用，
 * 原生会抛 TypeError。我们照抛，免得调用方以为「混着写也没事」。
 */
function assertNoStyleConflict(o) {
  if (o.dateStyle !== undefined) {
    for (const k of ['weekday', 'year', 'month', 'day']) {
      if (o[k] !== undefined) {
        throw new TypeError(`Can't set option ${k} when dateStyle is used`);
      }
    }
  }
  if (o.timeStyle !== undefined) {
    for (const k of ['dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits', 'timeZoneName']) {
      if (o[k] !== undefined) {
        throw new TypeError(`Can't set option ${k} when timeStyle is used`);
      }
    }
  }
}

/**
 * 把用户 options 变成「一组确定要输出的字段」。
 *
 * @param {object|undefined} options 用户传的 options（可能是 undefined / null）
 * @param {string} kind 'dtf'（构造 Intl.DateTimeFormat）| 'datetime' | 'date' | 'time'
 * @return {object} 展开后的字段表（含 timeZone / hour12 等原样保留的 key）
 */
function normalizeOptions(options, kind) {
  const raw = options === undefined || options === null ? {} : { ...options };
  const hasStyle = raw.dateStyle !== undefined || raw.timeStyle !== undefined;

  if (hasStyle) {
    assertNoStyleConflict(raw);
    const out = { ...raw };
    if (raw.dateStyle !== undefined) {
      Object.assign(out, pickStyle(DATE_STYLE_FIELDS, raw.dateStyle, 'dateStyle'));
    }
    if (raw.timeStyle !== undefined) {
      Object.assign(out, pickStyle(TIME_STYLE_FIELDS, raw.timeStyle, 'timeStyle'));
    }
    return out;
  }

  const spec = DATE_METHOD_DEFAULTS[kind] ?? DATE_METHOD_DEFAULTS.datetime;
  return toDateTimeOptions(raw, spec[0], spec[1]);
}

/**
 * `resolvedOptions()` 该回显哪些字段。
 *
 * 和排版用的字段表刻意分开：`dateStyle` / `timeStyle` 在内部会展开成 year/month/day
 * 之类的具体字段（排版需要），但原生 `resolvedOptions()` 对这类 formatter **只回显
 * `dateStyle` 自己** —— 把展开结果也塞进去就是在撒谎（`["calendar","dateStyle",
 * "locale","numberingSystem","timeZone"]` 才是原生的键集合）。
 *
 * 反过来，**不传 options** 时自动补上的 year/month/day 是「真的 format 字段」，
 * 原生会回显，我们照做。
 */
function resolveEchoFields(options, fields) {
  const raw = options === undefined || options === null ? {} : options;
  const hasStyle = raw.dateStyle !== undefined || raw.timeStyle !== undefined;
  const out = {};
  for (const k of ECHO_FIELDS) {
    if (raw[k] !== undefined) {
      out[k] = raw[k];
    } else if (!hasStyle && fields[k] !== undefined) {
      out[k] = fields[k];
    }
  }
  if (raw.hour12 !== undefined) out.hour12 = Boolean(raw.hour12);
  return out;
}

// ---------------------------------------------------------------------------
// 排版
// ---------------------------------------------------------------------------

/** 两位补零；入参可能是 '5' / '05' / 5。 */
function pad2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  return String(Math.trunc(n)).padStart(2, '0');
}

/**
 * 12 小时制还是 24 小时制？zh-CN 默认 h23。
 *
 * `dayPeriod` 显式请求时按 12 小时制展示：`{ dayPeriod: 'long', hour: 'numeric' }`
 * 的语义就是「要上下午」，而 `下午14时` 自相矛盾。显式给了 `hour12` / `hourCycle`
 * 时仍以它们为准（用户说了算）。
 */
function resolveTwelveHour(fields) {
  if (fields.hour12 !== undefined) return Boolean(fields.hour12);
  const hc = fields.hourCycle;
  if (hc === 'h11' || hc === 'h12') return true;
  if (hc === 'h23' || hc === 'h24') return false;
  if (fields.dayPeriod !== undefined) return true;
  return false;
}

/**
 * 给原生 formatter 的 options：只用来「取数字」。
 *
 * 三条约束：
 *   1. 强制 `en-US` + `hour12: false` —— 拿稳定的阿拉伯数字，别指望 locale 文字；
 *   2. `weekday` 一律要 `long`，因为后面要靠英文长名反查星期几（不自己算星期，
 *      避免时区边界上和原生对不齐）；
 *   3. `timeZoneName` 统一降级成 `short`：small-icu 没有中文时区名，long 只会
 *      拿到「China Standard Time」，比「CST」更糟。
 */
function nativePartsOptions(fields) {
  const out = { hour12: false };
  if (fields.timeZone !== undefined) out.timeZone = fields.timeZone;
  // 纪元必须真的问原生要（`AD` / `BC`），不能自己从年份推 —— 公元前后的分界在
  // 1 年而不是 0 年，自己算只会多一个 off-by-one 的来源。
  if (fields.era !== undefined) out.era = 'short';
  if (fields.year !== undefined) out.year = fields.year;
  // 月份一律要数字：zh-CN 里 long/short/narrow 全都排成 `{数字}月`，月份汉字表
  // 反而是不想要的（完整 ICU 给的是「十一月」，与本任务的输出契约不符）。
  // numeric / 2-digit 原样保留 —— 那个决定补不补零。
  if (fields.month !== undefined) {
    out.month = fields.month === '2-digit' ? '2-digit' : 'numeric';
  }
  if (fields.day !== undefined) out.day = fields.day;
  if (fields.weekday !== undefined) out.weekday = 'long';
  if (fields.hour !== undefined) out.hour = 'numeric';
  // 「要秒」= 排版会走 `hh:mm:ss` 形状，中间那段必须是**真实分钟值**。原生在这种
  // 组合（hour + second，无 minute）下只吐 `hour=14 second=45`，minute 缺席；这里
  // 补问一次 minute，免得 composeTime 拿不到值只能编造 `00`（那会输出不存在的时刻）。
  const wantsSubHour = fields.second !== undefined || fields.fractionalSecondDigits !== undefined;
  if (fields.minute !== undefined || (fields.hour !== undefined && wantsSubHour)) {
    out.minute = 'numeric';
  }
  if (wantsSubHour) {
    out.second = 'numeric';
  }
  if (fields.fractionalSecondDigits !== undefined) {
    out.fractionalSecondDigits = fields.fractionalSecondDigits;
  }
  if (fields.timeZoneName !== undefined) out.timeZoneName = 'short';
  return out;
}

function lit(value) {
  return { type: 'literal', value };
}

/**
 * 原生给出的纪元值 → 中文。`AD` → `公元`，`BC` → `公元前`。
 *
 * 认不出来（别的 ICU 版本可能给 `CE` / 空串）就退回原值，绝不让字段凭空消失：
 * 用户请求了 era，输出里就必须有 era。
 */
function eraName(raw) {
  if (raw === undefined || raw === null) return '';
  const key = String(raw).toUpperCase();
  return Object.prototype.hasOwnProperty.call(ERA_TEXT, key) ? ERA_TEXT[key] : String(raw);
}

/**
 * 日期段排版。规则来自真机 ICU zh-CN 的实测（见 tools/intl-zh/test.mjs 的注释）：
 *
 *   月份选项决定排版风格：
 *     numeric / 2-digit  → 斜杠风格 `2026/1/5`（数字原样，不额外补零）
 *     long / short / narrow → 年月日风格 `2026年1月5日`
 *   只有月份时（无年无日）：`1月` —— 这是 ICU 的行为，不是我们发明的。
 *   只有日时：`5日`。只有年时：`2026年`。
 *   纪元最前（`公元2026年`），星期跟在日期后面、**不加分隔符**
 *   （`2026年11月20日星期五`，dateStyle:'full' 就是这样）。
 */
function composeDate(out, fields, bag) {
  const hasY = fields.year !== undefined;
  const hasM = fields.month !== undefined;
  const hasD = fields.day !== undefined;
  const monthIsName = hasM && fields.month !== 'numeric' && fields.month !== '2-digit';

  // 纪元是日期的前缀（原生：`公元2026年`），位置固定在年之前、月份之前。
  if (fields.era !== undefined) {
    const era = eraName(bag.era);
    if (era !== '') out.push({ type: 'era', value: era });
  }

  if (hasM && monthIsName) {
    if (hasY) { out.push({ type: 'year', value: bag.year }); out.push(lit('年')); }
    out.push({ type: 'month', value: bag.month }); out.push(lit('月'));
    if (hasD) { out.push({ type: 'day', value: bag.day }); out.push(lit('日')); }
  } else if (hasM && (hasY || hasD)) {
    if (hasY) { out.push({ type: 'year', value: bag.year }); out.push(lit('/')); }
    out.push({ type: 'month', value: bag.month });
    if (hasD) { out.push(lit('/')); out.push({ type: 'day', value: bag.day }); }
  } else if (hasM) {
    out.push({ type: 'month', value: bag.month }); out.push(lit('月'));
  } else {
    if (hasY) { out.push({ type: 'year', value: bag.year }); out.push(lit('年')); }
    if (hasD) { out.push({ type: 'day', value: bag.day }); out.push(lit('日')); }
  }

  if (fields.weekday !== undefined) {
    const idx = EN_WEEKDAYS.indexOf(bag.weekday);
    if (idx >= 0) {
      const table = fields.weekday === 'narrow' ? WEEKDAY_NARROW
        : fields.weekday === 'short' ? WEEKDAY_SHORT
          : WEEKDAY_LONG;
      out.push({ type: 'weekday', value: table[idx] });
    }
  }
}

/**
 * 时间段排版。
 *
 *   有分钟/秒时小时补两位：`14:05`（即使 hour 选项是 numeric，ICU 也补零）；
 *   只有小时时用「时」：`14时` / `0时`（不补零）；
 *   只有分钟：`5`（不补零）；分钟+秒：`30:00`（补零）。
 *
 * 时/分/秒是**三个独立开关**：`{ hour, second }`（没有 minute）必须出
 * `14:30:45` —— 不能让秒被吞掉，也**不能编造** minute：既然要显示
 * `hh:mm:ss` 形状，中间那段就必须是真实分钟值。补 `00` 会输出一个不存在的时刻
 * （真实 14:30:45 显示成 14:00:45），比丢字段更危险 —— 用户会把它当成真实时间。
 * 多显示一个未请求的字段是良性的，编造数据则不是。
 *
 * 只请求 hour 时不进 `hh:mm` 形状（`14时`），所以这里的 `mm` 只在
 * `showSecond` 为真（或用户自己要了 minute）时才会被用到。
 *
 * 12 小时制（`hour12: true` / hourCycle h11|h12 / 显式 dayPeriod，见
 * resolveTwelveHour）加「上午/下午」前缀：`下午2:30`，0 点显示 `上午12:00`（与 ICU
 * 一致）。显式 `hour12: false` 又非要 `dayPeriod` 时仍会出上下午，但小时按 24 小时写 ——
 * 那是用户自己要求的矛盾组合，我们只保证两个字段都在。
 */
function composeTime(out, fields, bag, twelveHour) {
  const hasH = fields.hour !== undefined;
  const hasM = fields.minute !== undefined;
  const hasS = fields.second !== undefined;
  const hasFrac = fields.fractionalSecondDigits !== undefined;
  const showSecond = hasS || hasFrac;
  // 显式要 dayPeriod 就必须出上下午，不能只在 twelveHour 分支里自己算（P3）。
  const showPeriod = twelveHour || fields.dayPeriod !== undefined;

  /** 小数秒。`fractionalSecondDigits` 请求了才出，值由原生给（含前导零）。 */
  const pushFractionalSecond = () => {
    if (!hasFrac) return;
    out.push(lit('.'));
    out.push({ type: 'fractionalSecond', value: bag.fractionalSecond ?? '' });
  };

  if (hasH) {
    let h = Number(bag.hour);
    if (!Number.isFinite(h)) h = 0;
    // en-US 的 h24 在 0 点会吐 "24"；normalize 掉，别让界面出现 24:00。
    h = ((Math.trunc(h) % 24) + 24) % 24;

    if (showPeriod) out.push({ type: 'dayPeriod', value: h < 12 ? '上午' : '下午' });

    const withClock = hasM || showSecond;
    if (twelveHour) {
      // 12 小时制下面跟不补零按 hour 选项来（原生：`下午2:30` / `下午02:30`）。
      const h12 = h % 12 === 0 ? 12 : h % 12;
      out.push({ type: 'hour', value: fields.hour === '2-digit' ? pad2(h12) : String(h12) });
      if (!withClock) out.push(lit('时'));
    } else {
      out.push({ type: 'hour', value: withClock ? pad2(h) : String(h) });
      if (!withClock) out.push(lit('时'));
    }

    if (withClock) {
      out.push(lit(':'));
      // 分钟段永远用真实值：`{ hour, second }` 要出 `14:30:45` 而不是 `14:00:45`。
      // （`withClock` 只在「有 minute」或「要显示秒」时为真，`{ hour }` 不受影响。）
      out.push({ type: 'minute', value: pad2(bag.minute) });
    }
    if (showSecond) {
      out.push(lit(':'));
      out.push({ type: 'second', value: pad2(bag.second) });
      pushFractionalSecond();
    }
    return;
  }

  if (hasM) {
    if (showSecond) {
      out.push({ type: 'minute', value: pad2(bag.minute) });
      out.push(lit(':'));
      out.push({ type: 'second', value: pad2(bag.second) });
      pushFractionalSecond();
    } else {
      out.push({ type: 'minute', value: String(Number(bag.minute)) });
    }
    return;
  }

  if (showSecond) {
    out.push({ type: 'second', value: String(Number(bag.second)) });
    pushFractionalSecond();
  }
}

function partsToString(parts) {
  let s = '';
  for (const p of parts) s += p.value;
  return s;
}

/**
 * 把「日期段 + 时间段」拼成完整 part 数组。
 *
 * 与 `_segments()` 拆开是因为 formatRange 需要**先拿到两端的段**再决定怎么折叠，
 * 不能先拼成字符串再拆回来。放在模块级而不是实例方法：它不读实例状态。
 */
function joinSegments({ date, time }) {
  const out = [];
  for (const p of date) out.push(p);
  if (date.length > 0 && time.length > 0) out.push(lit(' '));
  for (const p of time) out.push(p);

  // 兜底：理论上原生一定给出请求过的字段，但不同 ICU 版本在极端 option 组合下
  // 可能少给一个 part。丢掉空值，别让界面出现字符串 "undefined"。
  const clean = [];
  for (const p of out) {
    if (p.value === undefined || p.value === null) continue;
    clean.push(p);
  }
  if (clean.length === 0) clean.push(lit(''));
  return clean;
}

// ---------------------------------------------------------------------------
// 中文 formatter
// ---------------------------------------------------------------------------

class ZhFormatter {
  /**
   * @param {string|string[]|undefined} locales 仅用于判定走不走中文分支
   * @param {object|undefined} options 用户 options
   * @param {string} [kind] 'dtf'（默认）| 'datetime' | 'date' | 'time'。
   *     由 Proxy 转发时永远是 undefined（构造陷阱只透传两个参数），所以外部调用方
   *     无法改变它；只有 cachedFormatter 会显式传。
   */
  constructor(locales, options, kind = 'dtf') {
    this._fields = normalizeOptions(options, kind);
    // 回显用字段与排版用字段不是一回事，见 resolveEchoFields()。
    this._echo = resolveEchoFields(options, this._fields);
    // 原生 formatter 只负责「在目标时区取出数字」。它同时也负责校验
    // timeZone / 取值合法性 —— 非法 timeZone 在这里抛 RangeError，与原生一致。
    this._native = new NativeDateTimeFormat('en-US', nativePartsOptions(this._fields));
    this._timeZone = this._native.resolvedOptions().timeZone;
    this._twelveHour = resolveTwelveHour(this._fields);
    this._hasTimeZoneName = this._fields.timeZoneName !== undefined;
    this._format = null;
  }

  /**
   * 与原生一致：`format` 是 accessor，取出来的函数自带绑定。
   * 插件里有 `const fn = fmt.format; fn(date)` 这种用法，普通方法会丢 this。
   */
  get format() {
    if (this._format === null) {
      this._format = (date) => this._render(date);
    }
    return this._format;
  }

  formatToParts(date) {
    return this._parts(toValidTime(date));
  }

  formatRange(start, end) {
    return partsToString(this._rangeParts(toValidTime(start), toValidTime(end)));
  }

  formatRangeToParts(start, end) {
    return this._rangeParts(toValidTime(start), toValidTime(end));
  }

  resolvedOptions() {
    const f = this._fields;
    const out = {
      locale: LOCALE,
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: this._timeZone,
    };
    // 只回填「用户真的要求过」的字段，不做 style 展开（见 resolveEchoFields）。
    Object.assign(out, this._echo);
    // hourCycle 只在「和小时有关」的 formatter 上出现（原生：纯日期没有这个键）。
    if (f.hourCycle !== undefined) {
      out.hourCycle = f.hourCycle;
    } else if (f.hour !== undefined) {
      out.hourCycle = this._twelveHour ? 'h12' : 'h23';
    }
    return out;
  }

  // ---- 内部：数字采集与拼接 ---------------------------------------------

  /** 原生取数是唯一可信来源：数字来自 tzdata，文字来自我们。 */
  _bag(t) {
    const bag = Object.create(null);
    for (const p of this._native.formatToParts(t)) {
      if (p.type !== 'literal') bag[p.type] = p.value;
    }
    // ICU 在个别 option 组合下会把 fractionalSecond 从 pattern 里丢掉（实测
    // `hour + second` 没有 minute 时，原生只给 `14时 (秒: 0)` 这种畸形输出）。
    // 小数秒与时区无关（tzdata 的偏移都是整秒），直接从毫秒数补出来，
    // 比让请求过的字段凭空消失好。
    const digits = this._fields.fractionalSecondDigits;
    if (digits !== undefined && !bag.fractionalSecond) {
      const ms = ((Math.trunc(t) % 1000) + 1000) % 1000;
      bag.fractionalSecond = String(ms).padStart(3, '0').slice(0, digits);
    }
    return bag;
  }

  /**
   * 日期段与时间段分开产出（各自已是 complete 的 part 数组）。
   *
   * 分开是为了 formatRange：能单独判断「日期一样、只有时刻不同」并折叠。
   * 时区名归到时间段末尾（`14:30:00 CST`）；真实 ICU zh 是前缀 `GMT+8 14:30`，
   * 这里选后缀是任务约定的形状，且后缀在「日期 时间 时区」里读起来更顺。
   */
  _segments(t) {
    const bag = this._bag(t);
    const date = [];
    composeDate(date, this._fields, bag);
    const time = [];
    composeTime(time, this._fields, bag, this._twelveHour);
    if (this._hasTimeZoneName && bag.timeZoneName) {
      if (time.length > 0) time.push(lit(' '));
      time.push({ type: 'timeZoneName', value: bag.timeZoneName });
    }
    return { date, time };
  }

  _parts(t) {
    return joinSegments(this._segments(t));
  }

  /**
   * 区间排版：只折叠两种界面上真会遇到的情况。
   *
   *   1. 两端渲染结果逐字符相同 → 只出一份（同一天的 dateStyle 区间）；
   *   2. 日期段相同、只有时刻不同 → 日期只出一次：
   *      `2026年11月20日 14:30 – 15:30`；时区名两边相同则并到末尾出一次。
   *
   * 其余退回 `A – B`：不折叠只是不够漂亮，折叠错了才是 bug，所以不做 ICU 那种
   * 逐字段模式匹配（要维护一张 zh 的区间模式表，收益不抵风险）。
   */
  _rangeParts(start, end) {
    // 每端只取一次数。原来先调 _parts() 再调 _segments()，而 _parts() 内部就依赖
    // _segments()，一次 formatRange 要跑四遍原生 formatToParts。
    const segA = this._segments(start);
    const segB = this._segments(end);
    const partsA = joinSegments(segA);
    const partsB = joinSegments(segB);
    const textA = partsToString(partsA);
    if (textA === partsToString(partsB)) {
      return partsA.map((p) => ({ ...p, source: 'shared' }));
    }

    const dateA = partsToString(segA.date);
    const clockA = splitTimeZone(segA.time);
    const clockB = splitTimeZone(segB.time);
    const sameDate = dateA !== '' && dateA === partsToString(segB.date);
    const sameClock = partsToString(clockA.clock) === partsToString(clockB.clock);
    const sameZone = partsToString(clockA.tz) === partsToString(clockB.tz);

    if (sameDate && !sameClock && sameZone) {
      const out = segA.date.map((p) => ({ ...p, source: 'shared' }));
      out.push({ type: 'literal', value: ' ', source: 'shared' });
      for (const p of clockA.clock) out.push({ ...p, source: 'startRange' });
      out.push({ type: 'literal', value: ' – ', source: 'shared' });
      for (const p of clockB.clock) out.push({ ...p, source: 'endRange' });
      for (const p of clockA.tz) out.push({ ...p, source: 'shared' });
      return out;
    }

    const out = partsA.map((p) => ({ ...p, source: 'startRange' }));
    out.push({ type: 'literal', value: ' – ', source: 'shared' });
    for (const p of partsB) out.push({ ...p, source: 'endRange' });
    return out;
  }

  _render(date) {
    return partsToString(this._parts(toValidTime(date)));
  }
}

/**
 * 把时间段拆成「时刻」与「尾部时区名」两半（时区名前面可能带一个分隔空格）。
 * 区间折叠时要能只共享时区名、各自展开时刻。
 */
function splitTimeZone(parts) {
  const last = parts[parts.length - 1];
  if (last === undefined || last.type !== 'timeZoneName') return { clock: parts, tz: [] };
  let cut = parts.length - 1;
  if (cut > 0 && parts[cut - 1].type === 'literal') cut -= 1;
  return { clock: parts.slice(0, cut), tz: parts.slice(cut) };
}

/**
 * Date / number / 可转数字的值 → 毫秒数，与原生 ToNumber 行为一致。
 *
 * 唯一的例外是 ECMA-402 的约定：date 参数为 `undefined`（含 `format()` 完全不传参、
 * `format(undefined)`）等价于 `Date.now()`。**只对 undefined**：`null` → 0（1970）、
 * `{}` → NaN → RangeError、`Number(undefined)` 式的 NaN 透传都是原生行为，不能改。
 */
function toTimeValue(value) {
  if (value === undefined) return Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return Number(value);
}

/**
 * 同 `toTimeValue`，但非法时间按原生抛 RangeError。
 *
 * 四个调用点（format / formatToParts / formatRange / formatRangeToParts）原本各写
 * 一遍同样的判断，漏一处就成了「一处抛、一处静默」的不一致。
 */
function toValidTime(value) {
  const t = toTimeValue(value);
  if (Number.isNaN(t)) throw new RangeError('Invalid time value');
  return t;
}

// ---------------------------------------------------------------------------
// 包装 Intl.DateTimeFormat
// ---------------------------------------------------------------------------

/**
 * formatter 缓存。
 *
 * 插件在每次 React 渲染时都会调 `toLocaleString()`，每次都新建一个原生
 * formatter 是浪费（原生构造器要解析 options、查 tzdata）。缓存的键是「归一化之后
 * 的字段表」，所以 `undefined`、`{}`、`{ dateStyle: 'short' }` 之外的重复调用
 * 都能命中。上限 64 条，超了整表清空 —— 日期 options 的组合数本来就很少，
 * 不做 LRU 也够。
 */
const formatterCache = new Map();

/** 归一化 + 缓存查找；Date 方法与 Intl 走同一套。 */
function cachedFormatter(kind, options) {
  const fields = normalizeOptions(options, kind);
  let key = kind;
  for (const k of Object.keys(fields).sort()) key += `|${k}=${String(fields[k])}`;
  let fmt = formatterCache.get(key);
  if (fmt === undefined) {
    if (formatterCache.size >= 64) formatterCache.clear();
    fmt = new ZhFormatter(LOCALE, options, kind);
    formatterCache.set(key, fmt);
  }
  return fmt;
}

// 让中文实例的原型链穿过原生 prototype：`new ZhFormatter() instanceof
// Intl.DateTimeFormat` 因此为真，且 `ZhFormatter.prototype.format` 仍优先命中自己的实现。
Object.setPrototypeOf(ZhFormatter.prototype, NativeDateTimeFormat.prototype);

/**
 * 用 Proxy 包原生构造函数。
 *
 * 为什么不直接替换成普通函数：`Intl.DateTimeFormat.prototype`、静态方法
 * `supportedLocalesOf`、`instanceof` 都得能用。Proxy 把未拦截的属性原样转发，
 * 只拦两处：
 *   - construct / apply：判断该走中文还是原样透传；
 *   - Symbol.hasInstance：中文实例与原生实例都算「是 DateTimeFormat」。
 *
 * `prototype` 绝不能拦。ECMAScript 的 [[Get]] 有一条不变量：若 target 上是
 * non-writable、non-configurable 的自有数据属性，陷阱必须原样返回该值。
 * `Intl.DateTimeFormat.prototype` 正是这种属性，拦截它会让引擎直接抛
 * TypeError（不是我们的代码能 catch 的那种，是 Proxy 内部机制）。
 *
 * 真实代价：`@js-temporal/polyfill` 在模块顶层读
 * `Intl.DateTimeFormat.prototype`，抛出
 *   TypeError: 'get' on proxy: property 'prototype' is a read-only and
 *   non-configurable data property ... (expected '#<DateTimeFormat>' but got
 *   '#<ZhFormatter>')
 * 导致 session-persistence-jsonl、subagent、tool-subagent、session-controller
 * 等 11 个条目全部 import 失败。桌面 node 是完整 ICU，patch 自检直接跳过，
 * 所以本地测试与 QA 断言都没覆盖到这条路径。
 */
function makeProxy() {
  return new Proxy(NativeDateTimeFormat, {
    construct(target, args) {
      if (pickLocale(args[0]) === null) return Reflect.construct(target, args);
      return new ZhFormatter(args[0], args[1]);
    },
    apply(target, thisArg, args) {
      // 原生不带 new 调用也返回 formatter，行为对齐。
      if (pickLocale(args[0]) === null) return Reflect.apply(target, thisArg, args);
      return new ZhFormatter(args[0], args[1]);
    },
    get(target, prop, receiver) {
      if (prop === Symbol.hasInstance) {
        return (value) => value instanceof ZhFormatter || value instanceof NativeDateTimeFormat;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// ---------------------------------------------------------------------------
// 包装 Date.prototype
// ---------------------------------------------------------------------------

/**
 * `Date.prototype.toLocale*String` 的统一实现。
 *
 * 注意两个与 Intl 不同的地方（都是规范要求）：
 *   - 非法日期返回字符串 `'Invalid Date'`，不抛异常（`Intl.DateTimeFormat` 才抛）；
 *   - `this` 不是 Date 时抛 TypeError。
 *   - 默认字段按方法区分：toLocaleString 是日期+时间，toLocaleDateString 只有日期。
 */
function patchDateMethod(methodName, kind, nativeFn) {
  const patched = {
    [methodName](locales, options) {
      if (!(this instanceof Date)) throw new TypeError('this is not a Date object');
      if (pickLocale(locales) === null) return nativeFn.call(this, locales, options);
      const t = this.getTime();
      if (Number.isNaN(t)) return 'Invalid Date';
      return cachedFormatter(kind, options)._render(t);
    },
  }[methodName];
  // 规范里这三个方法声明的 length 都是 0（`Date.prototype.toLocaleString.length === 0`），
  // 而对象字面量的方法会自动带 2 个形参。改回去，否则「看 length 判 AP 差异」的
  // 工具链（以及一些 polyfill 探测）会以为我们换了签名。
  Object.defineProperty(patched, 'length', { value: 0, configurable: true });
  Object.defineProperty(Date.prototype, methodName, {
    value: patched,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

function install() {
  const previous = globalThis[MARK];
  if (previous && previous.info) return previous.info;

  const mode = readSwitch();
  const nativeZh = icuHasChinese();

  let enabled = false;
  let reason = '';
  if (typeof NativeDateTimeFormat !== 'function') {
    reason = 'Intl.DateTimeFormat unavailable (no ICU build); fallback polyfill should have run first';
  } else if (mode === 'off') {
    reason = 'DSH_INTL_ZH=0';
  } else if (mode === 'force') {
    enabled = true;
    reason = 'DSH_INTL_ZH=force';
  } else if (nativeZh) {
    reason = 'native ICU already has zh data';
  } else {
    enabled = true;
    reason = 'small-icu: Intl present but only en locale data';
  }

  if (!enabled) {
    const info = { enabled: false, reason, sample: new Date(0).toLocaleString() };
    globalThis[MARK] = { installed: false, info };
    return info;
  }

  globalThis.Intl.DateTimeFormat = makeProxy();
  patchDateMethod('toLocaleString', 'datetime', nativeToLocaleString);
  patchDateMethod('toLocaleDateString', 'date', nativeToLocaleDateString);
  patchDateMethod('toLocaleTimeString', 'time', nativeToLocaleTimeString);

  const info = {
    enabled: true,
    reason,
    sample: new Date(0).toLocaleString(),
  };
  globalThis[MARK] = { installed: true, info };
  return info;
}

/**
 * 本模块是 side-effect 模块：import 即打补丁。唯一导出给 harness 打日志用。
 *
 * 已知局限（都是刻意不覆盖的，写在这里免得后人当 bug 查）：
 *   1. `Intl.NumberFormat` / `Collator` / `RelativeTimeFormat` 未处理 —— 不属于
 *      日期问题，且 collator 的排序权重拼不出来；
 *   2. `numberingSystem`（如 `hanidec`、`arab`）被忽略，一律输出拉丁数字；
 *   3. `calendar` 只支持 gregory，其他日历退化成公历显示；
 *   4. `timeZoneName: 'long'` 拿不到中文名，统一降级成 `short`（CST / GMT+8）；
 *   5. `hourCycle: 'h24'` 按 h23 处理（0 点显示 00 而不是 24）；
 *   6. `month: 'long'` 输出 `11月`（而不是 ICU 完整数据里的 `十一月`）—— 与任务的
 *      输出约定一致，也避免维护一张月份汉字表；
 *   7. `zh-TW` / `zh-Hant` 也输出简体中文（small-icu 下它们本来只会输出英文）；
 *   8. `dayPeriod` 只做两分（`上午` / `下午`），不区分 CLDR 的 `凌晨/早上/中午/晚上`；
 *   9. `era` 只有 `公元` / `公元前`（中文 CLDR 里 short 与 long 同形，不必分档）；
 *  10. `formatRange` 只折叠两种情形：两端完全相同、同日只有时刻不同。其余退回
 *      `A – B`（信息不丢，只是不紧凑）—— 逐字段折叠要维护一张 zh 区间模式表，
 *      折叠错了比不折叠糟得多。
 */
export const __info = install();
