# iframe 用法扫描

> 生成：`node tools/ability-scan.mjs`。扫的是 `fixtures/plugins/*/client.js` 里
> `createElement("iframe", {…})` 的调用点，不是整包 grep —— react-dom 的
> `possibleStandardNames` 表里也有 `srcDoc`，整包 grep 会把每个 React 应用都算成
> iframe 使用者。

样本：1 个插件有 iframe 调用点。

| 插件 | 行 | 类型 | sandbox | 片段 |
|---|---|---|---|---|
| dsh-plugin-core-demo | 10877 | src | — | `{ className: "dshpc-fb__frame", src: url }` |
| dsh-plugin-core-demo | 56041 | srcdoc | yes | `{ className: "dshpc-fb__frame", sandbox: "", srcDoc: doc2 }` |
| dsh-plugin-core-demo | 56093 | src | — | `{ className: "dshpc-fb__frame", src: url }` |

## 结论

- **srcdoc**：1 个插件（能渲染，走 `src/frame.mjs`）
- **外链 src**：1 个插件（要真去加载一个 URL，仍不支持）
- 两类都有的插件按两种都记。

`core-demo` 是样本里唯一有 iframe 调用点的插件，它的文件预览栏有三种模态：

- **HTML 预览**走 `srcDoc: doc`，其中 `doc` 来自 `buildStaticHtml`：
  `new DOMParser().parseFromString(...)` 消毒（删禁用标签、剥危险属性、插 CSP）
  之后整段塞进 `sandbox=""` 的 iframe。这条链路的两个前置 —— `DOMParser`（
  `src/dom.mjs` 的 `DshDOMParser`）与 srcdoc 物化（§11）—— 都已实现。
- **PDF / Office 预览**走 `src: url`（blob / 工作区 URL），需要真的去加载一个
  网页，仍不支持。

所以它在矩阵里既可能是 A（HTML 预览）也可能是 B（PDF 预览），取决于当前渲染
的是哪一路；分级器按渲染结果判定（`countFrames`），不再按静态 cap 猜。
