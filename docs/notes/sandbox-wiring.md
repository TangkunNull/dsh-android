# 沙箱接线核验（ADR-0001 §5）

核验命令（Node 必须 ≥ 24.2）：`$N24 .../@deepseek-ai/dsh/lib/bin.js --profile android --dump-config`，
`N24=` 你的 Node 24 可执行文件路径。

## 1. 组合成立，但 dump 看不到 env 差异

不设 env 与 `DSH_SANDBOX_ANDROID=landlock`（另加 `DSH_SANDBOX_RUNNER=…`）两次 dump **字节一致**，
stderr 均为空。原因不是 env 没生效，而是 `--dump-config` **不求值 `!!js`**，表达式被原样打印。
用 loader 的 `evaluate()`（`cordis-plugin-loader/lib/index.js:360`）对目标行求值后：

| 行 | 不设 env | `=landlock` |
|---|---|---|
| `sandbox`（dsh-sandbox-local） | disabled | disabled |
| `sandbox-android`（insert） | **disabled** | **ENABLED** |
| `bash-sandbox` | disabled | **ENABLED** |
| `bash-local`（insert） | **ENABLED** | disabled |
| `fs-sandbox` | **ENABLED** | **ENABLED**（唯一的无条件恢复） |
| `fs-local` | 不存在 | 不存在（两行争 `ctx.fs`，整块删掉） |
| `permission` | disabled | **ENABLED** |

`sandbox-policy.mode` 两侧都是 `workspace-write`（`DSH_PERMISSION_MODE` 可覆盖）。

## 2. `insert` 行内支持 `disabled`；`fs-sandbox` 不怕缺 `/tmp`

`applyPatches()` 先 `structuredClone(insert)` 再挂进树，条目构造时 `_resolveDisabled()` 逐条求值
（`cordis-plugin-loader/lib/index.js:477`）；上表两行的翻转就是证据，无需拆成两处。
`fs-sandbox` 的 `checkedTarget()` → `writableRoots()` → `isPathUnder()`：先走纯字符串 `isLexicallyUnder`，
仅词法不匹配才 `statIfPresent(root)`，root 缺失即 `false`。全程不 stat `/tmp`。

## 3. 已知缺口：审批卡

Flutter 侧没有审批卡 → `ctx.waterfall('approval/request')` 无应答者 → 兜底 `'unavailable'` →
`approveEscalation()` 抛错：escalation 结构上存在、实际不可用。缺件是 `approval/request` 的客户端
处理器 + 一张「允许本次以 danger-full-access 运行」的卡片。
另：dump 必须用 Node ≥ 24.2，Node 22 上 `import.meta.main` 为 undefined，静默 exit 0。
