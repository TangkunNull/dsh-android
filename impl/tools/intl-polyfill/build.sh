#!/usr/bin/env bash
# 重建 Intl polyfill 单文件产物：impl/vendor/intl-polyfill/intl-polyfill.mjs
#
# 什么时候需要重跑：升级 formatjs 包、或要加新 locale（当前只装 en）。
# 平时不用跑 —— 产物已进 git，pack-runtime.mjs 直接读它。
#
# 用法：./build.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../../vendor/intl-polyfill/intl-polyfill.mjs"

cd "$HERE"

echo "== 安装 formatjs polyfill 依赖"
npm install --no-audit --no-fund --silent \
  @formatjs/intl-getcanonicallocales \
  @formatjs/intl-locale \
  @formatjs/intl-pluralrules \
  @formatjs/intl-numberformat \
  @formatjs/intl-datetimeformat \
  @formatjs/intl-displaynames \
  @formatjs/intl-listformat \
  @formatjs/intl-durationformat \
  @formatjs/intl-segmenter \
  @formatjs/intl-supportedvaluesof \
  esbuild

echo "== 打包成单文件 ESM"
npx esbuild entry.mjs \
  --bundle --format=esm --platform=neutral --target=es2022 --minify \
  --outfile="$OUT"

echo "== 产物："
ls -lh "$OUT"

echo "== 自检：删掉 globalThis.Intl 后装载，确认 9 个 API 就位"
node --input-type=module -e "
delete globalThis.Intl;
await import('file://$OUT');
const apis = ['DateTimeFormat','DurationFormat','Segmenter','ListFormat','NumberFormat','PluralRules','DisplayNames','Locale','supportedValuesOf'];
const missing = apis.filter(k => typeof Intl[k] !== 'function');
if (missing.length) { console.error('缺失:', missing.join(',')); process.exit(1); }
const tz = Intl.supportedValuesOf('timeZone');
console.log('OK 9/9 API 就位，时区', tz.length, '个，含 Asia/Shanghai:', tz.includes('Asia/Shanghai'));
"
