// Resolve hooks for ESM-shaped plugins (task A-4).
//
// Most client halves are classic scripts calling __ModuleLoader__.load(), but a
// growing minority ship as ES modules with real `import` statements. Those die
// instantly under vm.runInContext ("Cannot use import statement outside a
// module"), so the harness registers a resolve hook that redirects every host
// specifier to the module file that implements it.
//
// This file runs on the loader thread: it may only use serialisable state passed
// through `initialize()`, which is why the table is a plain {spec: fileUrl} map.
let TABLE = Object.create(null);

export function initialize(data) {
  TABLE = Object.assign(Object.create(null), data?.map || {});
}

export async function resolve(specifier, context, next) {
  const hit = TABLE[specifier];
  // 不要硬写 `format: 'module'`：表里既有真的 ESM（官方 ui 包）也有 CJS
  // （react/jsx-runtime 指向 react/cjs/*.js）。强制 module 会让 CJS 走 ESM
  // 语义，named export 只能探测到 default，于是官方包一句
  // `import { Fragment } from "react/jsx-runtime"` 直接报
  // "does not provide an export named 'Fragment'"。交给 Node 按文件判定。
  if (hit) return { url: hit, shortCircuit: true };
  return next(specifier, context);
}

// CSS 是浏览器才有的模块类型，Node 既不能解析也不该解析。官方 primitives 里
// 有一句 `import "katex/dist/katex.min.css"`，不放行就是整个包加载失败（错误
// 指向 .css 扩展名，看不出根因）。样式本身由 `css.mjs` 从 document 里收集，
// 这里只要「让 import 成功且不产生副作用」。
const CSS = /\.css$/;

export async function load(url, context, next) {
  if (CSS.test(new URL(url).pathname)) {
    return { format: 'module', source: 'export default "";', shortCircuit: true };
  }
  return next(url, context);
}
