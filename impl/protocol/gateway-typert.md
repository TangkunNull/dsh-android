# dsh-api-gateway 线协议（`0.2.2-rc.1` Typert）

> 全部内容来自对 `@deepseek-ai/dsh@0.2.2-rc.1` 的**实测**（2026-11-18，Node 24.22.3），
> 可用 `impl/tools/probe-suite.mjs` 一键复跑（14/14 通过）。
> 与 `README.md` 描述的 `0.0.1-rc.1` apiproxy 快照是**两套并行的 API 层**，不要混用命名。

## 1. 为什么需要这份文档

`README.md` 记录的是 `dsh-host-apiproxy 0.0.1-rc.1`：`POST /api/<method>` + `{type:'client-request',rpcId,method,payload}` + WS 双流，方法名是 `session.list` 这种点号形态。

真 `dsh web`（0.2.2-rc.1）装的是 `dsh-api-gateway`，方法名是 `session/list` 这种**斜杠**形态。两者信封长得像、实际不通用：

| | apiproxy 0.0.1-rc.1 | gateway 0.2.2-rc.1 |
| --- | --- | --- |
| 方法名 | `session.list` | `session/list` |
| unary 传输 | `POST /api/session.list` | `POST /api/session/list` |
| 流传输 | WS `/api/events.mux` 等 | WS `/api/remote.mux`（单一路由多路复用） |
| 参数 | `payload` 直接是业务对象 | `payload.args` 按**形参名**装 |
| 认证 | 无（只有 Host 头栅栏） | `GET /?token=` 换 cookie，无 cookie `/api/*` 一律 401 |

## 2. 认证

```
GET http://127.0.0.1:3080/?token=<launch-token>
  → 303 See Other
    location: ./
    set-cookie: dsh-auth-<sha256(authority)>=v1.<base64 payload>.<sig>
                ; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
```

- `<launch-token>` 打印在 `dsh web` 的启动输出里（`dsh web: http://127.0.0.1:3080/?token=...`）。
- cookie 里的 `authority` 绑定 `host:port`，**换端口要重新换一次**。cookie 名后缀是 authority 的哈希，所以客户端不要硬编码名字，从 `Set-Cookie` 里取第一条 `dsh-auth-*`。
- 之后的 HTTP 与 WS 都只带这条 cookie。实测 `Authorization: Bearer <tok>` 和 `x-dsh-token: <tok>` **都仍是 401**。
- 无 token 访问 `/` 直接 401；带错误 token 也是 401。

## 3. unary（一次性请求/响应）：HTTP POST

```
POST /api/<namespace>/<method>
content-type: application/json
cookie: dsh-auth-...=v1....

{
  "type": "client-request",
  "rpcId": "<任意非空字符串>",
  "method": "<namespace>/<method>",   // 必须与 URL 里的 endpoint 完全一致
  "payload": { "args": { ... } }
}
```

成功：

```json
{"type":"server-response","rpcId":"...","result":{"ok":true,"value":{...}}}
```

失败（**HTTP 仍是 200**，错误在 `result.error` 里）：

```json
{"type":"server-response","rpcId":"...","result":{"ok":false,"error":{"code":"gateway/arguments-invalid","message":"...","details":{...}}}}
```

只有运输层问题才用非 200：`401`（无/错 cookie）、`403`（非 owner）、`404`（endpoint 形态不合法）、`415`（content-type 不是 JSON）、`400`（body 不是 JSON）。

### 3.1 `args` 的 key 是**方法形参名**

这是最容易踩的一条。生成器按源码形参名生成 args 字段，不做重命名：

| 方法 | 签名 | 正确 args |
| --- | --- | --- |
| `session/list` | `list(_request: SessionListRequest)` | `{"args":{"_request":{}}}` ← 注意下划线 |
| `session/create` | `create(request: SessionCreateRequest)` | `{"args":{"request":{...}}}` |
| `session/modelCatalog` | `modelCatalog()` | `{"args":{}}` |
| `fileReferences/list` | `list(agentId, query)` | `{"args":{"agentId":"...","query":"..."}}` |

`signal?: AbortSignal` 是传输层取消用的，**不进 args**。

猜错的报错会直接告诉你答案：

```
gateway/arguments-invalid: typert gateway: session/list: args fields do not match the descriptor: missing "_request"
gateway/arguments-invalid: typert gateway: skills/list: args fields do not match the descriptor: missing "request"; unexpected "_request"
```

## 4. stream（长驻流）：WebSocket `/api/remote.mux`

```js
const ws = new WebSocket('ws://127.0.0.1:3080/api/remote.mux', { headers: { cookie } })
ws.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/observeState', payload: { args: {...} } }))
```

客户端 → 服务端只认四种帧：

| type | 字段 | 用途 |
| --- | --- | --- |
| `open` | `streamId, endpoint, payload` | 开一条逻辑流 |
| `item` | `streamId, value?` | 上行载荷（`control` 这类双向流用） |
| `cancel` | `streamId` | 取消 |
| `end` | `streamId` | 正常收流 |

服务端 → 客户端：

| type | 字段 | 用途 |
| --- | --- | --- |
| `item` | `streamId, value?` | 一条业务数据 |
| `end` | `streamId` | 流结束 |
| `error` | `streamId, {code,message,details}` | 流失败 |

一个 WS 连接可承载多条流，靠 `streamId` 多路复用；`streamId` 由客户端铸造，非空字符串即可。

**unary 与 stream 严格分工**，走错会拒：

```
用 open 开 session/list    → gateway/signature-invalid: unary Remote methods cannot be opened through the stream carrier
用 POST 调 session/follow  → gateway/signature-invalid: stream Remote methods must be opened through the stream carrier
```

## 5. 方法清单

`stream` 列标记该方法必须走 WS。

| endpoint | args 形参 | 返回/帧 | stream |
| --- | --- | --- | --- |
| `session/list` | `_request: {cursor?}` | `{items: SessionSummary[]}` | |
| `session/create` | `request: {workspaceId?, cwd?, sessionId?, agentPreset?}` | `{sessionId, agentPreset}` | |
| `session/state` | `request: {sessionId}` | `SessionState` | |
| `session/page` | `request: {address, throughSeq?, beforeSeq?, maxMessages?, turnWindow?}` | `SessionPage {records, cursor, hasMore}` | |
| `session/events` | `request` 同上 | `SessionEventsPage`（带 cursor） | |
| `session/prompt` | `request: {requestId, sessionId, mode:'queue'\|'steer', content: PromptContentPart[], clientTimeZone?}` | `{accepted:true}` | |
| `session/cancel` | `request` | `SessionCancelValue` | |
| `session/rename` | `request: {sessionId, title}` | `{title, seq}` | |
| `session/modelCatalog` | 无 | `{default, routableProviders, groups, failures}` | |
| `session/selectModel` | `request: {sessionId, provider, model}` | `{selected}` | |
| `session/initializeDefaultModel` | 无 | `void` | |
| `session/projections` | `request: {sessionId}` | `SessionProjectionsValue` | |
| `session/search` | `request: {query}` | `{items, hasMore}` | |
| `session/fork` | `request` | `SessionForkValue` | |
| `session/attachment` | `request: {sessionId, attachment}` | `{attachment, data}` | |
| `session/updateQueue` | `request` | `SessionUpdateQueueValue` | |
| `session/wait` | `request` | `SessionWaitValue` | |
| `session/canOpenWorkspacePath` | 无 | `boolean` | |
| `session/openWorkspacePath` | `request: {path}` | `SessionOpenWorkspacePathValue` | |
| `session/workspacePathApplications` | `request: {path}` | `SessionWorkspacePathApplication[]` | |
| `session/observeState` | `request: {sessionId}` | `SessionState` 帧 | ✓ |
| `session/observeEvent` | `request: {address}` | `{type:'ready'}` 后接事件 | ✓ |
| `session/observeProjections` | `request` | `SessionProjectionFrame` | ✓ |
| `session/follow` | `request: {address, maxMessages?, turnWindow?, activate?, assistantStream?}` | 首帧 snapshot，后续增量 | ✓ |
| `session/control` | 无 | 双向控制帧 | ✓ |
| `skills/list` | `request` | `{skills: SkillEntry[]}` | |
| `fileReferences/list` | `agentId, query` | `FileReferenceCandidate[]` | |

`SessionAddress = {kind:'session', sessionId} | {kind:'subagent', parentSessionId, childSessionId, mode:'one-shot'|'continuable'|'unknown'}`

## 6. 关键返回形状（实测样本见 `impl/fixtures/gateway/`）

### 6.1 `session/modelCatalog`

```json
{"default":{"provider":"deepseek-official","model":"deepseek-flash"},
 "routableProviders":[],"groups":[],"failures":[]}
```

`routableProviders` 为空 = **没有任何可用凭据**，此时 `session/selectModel` 会被拒：

```
session/model-unavailable: Select an available model before sending a message.
```

UI 应该用 `routableProviders.length` 决定模型选择器是否可点，而不是猜。

### 6.2 `session/follow` 首帧（snapshot）

```json
{"type":"item","value":{
  "type":"snapshot",
  "header":{"version":4,"id":"session-...","createdAt":1794996329660,"cwd":"/tmp/x","isSeeded":false,"agentPreset":"standard"},
  "projections":{"asOfSeq":18,"values":{ ... 20 个投影 ... }},
  "cursor":18,
  "records":[...],
  "hasMore":false
}}
```

`projections.values` 的 20 个键（缺的键表示该能力未装）：

`sessionStats` `turnOutline` `userQuestions` `tokenUsage` `contextPressure` `title` `agentPreset` `goal` `modelSelection` `workingDirectory` `contextBreakdown` `inbox` `permissions` `subagentCatalog` `subagentTiming` `subagent` `todos` `plan` `sessionListMetadata` `imageLimits`

几个值得注意的：

- `contextPressure.contextWindow` → 实测 `1048576`（1M）。
- `permissions.currentValue` → `"workspace-write"`，对应 `approval/policy` 事件里的 `"ask"`。
- `modelSelection` → `{lastUsed, next}`，两个都是 `{provider, model}` 或 `null`。
- `turnOutline` → `[{turn, seq, prompt, response}]`，适合做侧栏大纲。

### 6.3 事件流（`session/page` 的 `records[]`）

每条是 `{type:'event', event:{type, seq, time, data}}`。实测一次「prompt → 失败」产生 18 条：

```
permission/preset → sandbox/mode → approval/policy
→ agent/inbox/spliced → turn/start → agent/inbox/spliced → step/start
→ system/message → user/message ×3 → request/header → request/context
→ session/title → session/title-llm-request
→ assistant/attempt（内含 stream chunk，含 finish.reason）
→ step/end → turn/end
```

`assistant/attempt.data.stream[]` 里是 LLM 的流式 chunk；`finish` chunk 带 `reason.kind: 'error'|'stop'|...`。

无凭据时整条链路的失败点在这里（不是 401，是业务事件）：

```json
{"kind":"error","failure":{"code":"MISSING_CREDENTIAL",
 "message":"llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment"}}
```

**含义**：harness 跑起来 ≠ 能对话。离线自跑的手机仍需要一份 DeepSeek API key（或一个本地模型适配器），这一层不属于 harness 移植范围，必须显式告知用户。

### 6.4 `ask_user_question` 工具的真实入参 schema

从 `request/header` 事件里取到的正本（`fixtures/gateway/ask-tool-schema.json`）：

```json
{
  "questions": [{
    "id": "string (required) — Stable id for this question; echoed in the answer.",
    "question": "string (required)",
    "header": "string (optional) — 短标题",
    "options": [{"label": "string (required)", "description": "string (optional)"}],
    "multi_select": "boolean (optional, default false)"
  }]
}
```

三条要点，和之前基于 `dsh-user-questions` 类型的实现有出入：

1. **问题有 `id`，且必填**（`required: ["id","question"]`）。缺 `id` 是上游数据坏了，客户端应当报错而不是"渲染但禁用提交"。
2. **选项没有 `id`**，只有 `label`/`description`；答复的 `selected` 装的是 **label**（与 `dsh-user-questions` 的 "Selected option labels" 一致）。
3. 字段名是 **`multi_select`** 下划线，不是 `multiSelect`；另有 `header` 字段可做卡片小标题。

跳过语义（工具描述原文）：*"An answer item with empty selected and no custom means the user skipped that question: continue without it, do not ask it again, and do not treat the skip as permission."*

## 7. 错误码

| code | 触发 | 客户端该做什么 |
| --- | --- | --- |
| `gateway/bad-request` | 信封非法 / `method` 与 URL endpoint 不一致 | 代码 bug，修客户端 |
| `gateway/arguments-invalid` | args 字段与形参名不匹配 | 报错信息里有缺失的名字 |
| `gateway/input-invalid` | 字段值没过边界校验（`details.field` 指名） | 校验入参 |
| `gateway/signature-invalid` | unary/stream 走错载体 | 换载体 |
| `gateway/invocation-unavailable` | 目标 Peer 已死 / 方法不可用 | 重连 |
| `gateway/interactions-forbidden` | 非 owner Peer 想答事件 | 权限问题 |
| `gateway/cancelled` | 调用方 abort | 正常取消 |
| `gateway/internal` | 载体内部异常 | 上报 |
| `session/model-unavailable` | 无可用模型路由 | 引导配置凭据 |

## 8. 与本地实现的对应关系

| 协议概念 | 我们这边 |
| --- | --- |
| `GET /?token=` → cookie | **未实现**（`transport.mjs` 目前只会连、不会换 token） |
| `POST /api/<ns>/<method>` + `{args}` | `codec.mjs` 的 `client-request` 信封可复用，endpoint 命名与 args 装载需改 |
| WS `/api/remote.mux` + `open/item/end` | `transport.mjs` 目前对的是 apiproxy 的双流，需重写为 mux |
| `session/follow` snapshot + 增量 | **未实现**；这是替代 `events.mux` 的主通路 |
| 20 个 projection | **未实现**（`normalize.mjs` 目前折叠的是 apiproxy 的 13 型 `SessionEvent`） |
| `ask_user_question` 真实 schema | `client.dart` 已按「无 option id + selected 装 label」实现；`header` 与 `multi_select` 命名待对齐 |

## 9. 复跑方式

```bash
# 1. 起 host（必须 Node ≥ 24，见 ../../docs/notes/node-version.md）
npx @deepseek-ai/dsh@0.2.2-rc.1 web --no-open
#    从输出里抄下 ?token= 后面那串

# 2. 跑协议矩阵
node impl/tools/probe-suite.mjs --token <launch-token> --verbose
#    → 14/14 通过
```
