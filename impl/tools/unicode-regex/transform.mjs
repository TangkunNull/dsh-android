// 把 JS 里的 \p{...} / \P{...}（Unicode 属性转义）转译成显式字符类。
//
// 为什么需要：这套运行时曾用 nodejs-mobile 的 --with-intl=none 构建，无 ICU 的
// V8 不认 Unicode property escapes —— 插件在 import 阶段就抛 "Invalid regular
// expression: /\p{White_Space}/u: Invalid property name"。现在换成带 small-icu
// 的构建，V8 本身认了，但转译保留：一是不依赖构建产物的 ICU 配置（换回 none
// 构建仍然能跑），二是转译语义等价、成本只落在打包期。
// 所以在打包阶段做标准转译（regexpu，Babel 官方插件），
// 让产物在不支持 \p{} 的 V8 上语义等价地跑起来。
//
// 两条路径：
//   1. 正则字面量 /^[\p{L}]+$/u        -> Babel 官方 unicode-property-regex 插件
//   2. 字符串形态 new RegExp('\\p{L}') -> 自定义插件改写字符串字面量/无插值模板
//      （execa 的 escape.js、zod v4 的 _emoji 都是这种写法，只靠路径 1 会漏）
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

let babel = null;
let literalPlugin = null;
let rewritePattern = null;

function load() {
  if (babel) return;
  const nm = (m) => require(path.join(HERE, 'node_modules', m));
  babel = nm('@babel/core');
  literalPlugin = nm('@babel/plugin-transform-unicode-property-regex');
  rewritePattern = nm('regexpu-core');
}

/** 便宜的前置判断：绝大多数文件不含 \p{，不必进 Babel。 */
export const hasUnicodePropertyEscape = (code) => /\\[pP]\{/.test(code);

/**
 * 字符串形态的正则：\p{...} 出现在字符串字面量或「无插值模板」里，
 * 最终被 new RegExp(str, flags) 使用。regexpu 直接重写 pattern 文本。
 */
function stringPatternPlugin() {
  const ESCAPE = /\\[pP]\{/;
  const rewrite = (value) => {
    if (!ESCAPE.test(value)) return null;
    // 只按 'u' 语义重写：重写结果只含 \u{...} 区间，带不带 u 标志都合法。
    return rewritePattern(value, 'u', { unicodePropertyEscapes: 'transform' });
  };
  return {
    name: 'dsh-unicode-property-in-string',
    visitor: {
      StringLiteral(p) {
        const out = rewrite(p.node.value);
        if (out != null) p.replaceWith({ type: 'StringLiteral', value: out });
      },
      TemplateLiteral(p) {
        // 有插值的模板不碰（无法静态确定 pattern）
        if (p.node.expressions.length !== 0) return;
        const out = rewrite(p.node.quasis[0].value.cooked ?? '');
        if (out != null) p.replaceWith({ type: 'StringLiteral', value: out });
      },
    },
  };
}

/**
 * 转译一段源码。
 * @returns {{ code: string, changed: boolean }}
 */
export function transpileUnicodeRegex(code, filename = 'input.js') {
  load();
  const out = babel.transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: 'unambiguous',
    compact: false,
    comments: true,
    plugins: [literalPlugin, stringPatternPlugin()],
  });
  return { code: out.code, changed: out.code !== code };
}

/** 转译后仍残留 \p{ 的位置（构建期断言用：有残留说明是非静态 pattern）。 */
export function remainingEscapes(code) {
  const hits = [];
  const re = /\\[pP]\{/g;
  let m;
  while ((m = re.exec(code))) {
    const line = code.slice(0, m.index).split('\n').length;
    hits.push({ index: m.index, line });
  }
  return hits;
}
