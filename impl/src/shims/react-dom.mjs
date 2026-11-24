// `react-dom` 的最小替身：只给「渲染到 IR」这一条路提供语义。
//
// 为什么不是真的 react-dom：真包在模块顶层就摸 `document`、`window` 和
// DOM 事件系统，而我们的宿主是自研 reconciler（`reconciler.mjs`），根本没有
// DOM。插件用到的 react-dom 符号只有 `createPortal`（primitives 里 Modal /
// Tooltip / Menu 三处），其余全部为 0（已 grep 全量 client-ui 包确认）。
//
// 语义选择：portal 的语义是「渲染到主树之外的一个容器」。IR 里没有多个根，
// 所以这里把它降级成**内联渲染**——children 直接留在调用处。代价是弹层在
// 文档流里的层级不对（Flutter 侧靠 z-order 修正），收益是不丢内容。
// 直接返回 null 才是真正的错误做法：那个弹窗会静默消失且没有任何日志。

export function createPortal(children) {
  return children;
}

export function flushSync(fn) {
  return fn();
}

export function findDOMNode() {
  return null;
}

export function unmountComponentAtNode() {
  return false;
}

export default { createPortal, flushSync, findDOMNode, unmountComponentAtNode };
