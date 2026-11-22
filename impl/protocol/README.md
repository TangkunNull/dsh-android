# dsh 线协议参考（快照 `0.0.1-rc.1`）

一页纸，给写 `src/host/protocol/` 的人和半年后回来查的人。每条结论都能落回 `protocol/**/*.d.ts`；快照里没有实现代码，所以"host 到底怎么处理"只写到声明敢写的那一步。

## 1. 这份快照是什么

| 包 | 它是什么 |
| --- | --- |
| `@deepseek-ai/dsh-host-apiproxy` | `ApiProxy` 契约层（`api/`）、fetch 载体对、host 侧网关插件 |
| `@deepseek-ai/dsh-client-connection` | HTTP 上行 / WS 下行客户端、双流重连控制器、`/api` 信任栅栏 |
| `@deepseek-ai/dsh-session` | 事件溯源会话库；`SessionEvent` 定义在这里 |
| `@deepseek-ai/dsh-api-remotes` | 远端 BFF 组装与 Host Agent/Session 查找策略 |

四包同为 `0.0.1-rc.1`，共 68 个 `.d.ts`，由 [`tools/fetch-protocol.sh`](../tools/fetch-protocol.sh) 从 npm 拉取后固化。**只存声明不存实现**：上游把 `.d.ts`（契约）和 `.js`（实现）一起发，我们要的是"必须说对的那一层"——路径、字段、错误码、状态机；实现细节每个 rc 都在动，抄进来就变成要维护的分叉。

**怎么更新**：改脚本里的 `PINS` 数组 → 重跑 → diff 就是"线协议动了哪些地方"的清单。（各包目录下的 `PIN.json` 是拉取产物，别手改。）

> 声明文件是接口描述，不是行为规范。字段名、可空性、枚举取值以 `.d.ts` 为准；某个方法在什么条件下返回哪个错误、流何时关闭、重连期间积压怎么排——这些只有真 host 能确认。

## 2. 传输总览

**上行 HTTP，下行单工 WebSocket。客户端不在 WS 上写任何东西。**

```text
 Android 客户端                                    dsh host
      │ ① POST /api/<method>   ClientRequest         │
      │ ────────────────────────────────────────────▶│
      │ ◀────────────────────────────────────────────│ ② ServerResponse（同一 POST 响应体）
      │ ③ WS /api/events.mux + /api/events.host      │
      │ ◀────────────────────────────────────────────│    ServerRequest，单向 host→client
      │ ④ POST /api/respond    ClientResponse ──────▶│    HTTP 体是 RpcReceipt
```

路径常量只有三个（`api-path.d.ts`）：`API_PATH = "/api"`、`MUX_EVENTS_PATH = "/api/events.mux"`、`HOST_EVENTS_PATH = "/api/events.host"`。方法名就是路径段：`session.list` → `POST /api/session.list`。

> Client messages are a protocol violation: upstream traffic remains on HTTP. —— `websocket-downlink.d.ts`

## 3. 四象限消息模型

| 象限 | `type` | 谁发起 | 载体 | `rpcId` 谁 mint |
| --- | --- | --- | --- | --- |
| `ClientRequest` | `'client-request'` | 客户端 | `POST /api/<method>` 请求体 | 客户端，每次调用一个新 id |
| `ServerResponse` | `'server-response'` | host | 同一个 POST 的响应体 | 回显对应请求 |
| `ServerRequest` | `'server-request'` | host | 下行 WS 帧 | 可答复帧用稳定逻辑 id；纯推送每次新 mint |
| `ClientResponse` | `'client-response'` | 客户端 | `POST /api/respond` 请求体 | **回显，绝不新造** |

四个象限共享 `{ type, rpcId, ... }`；`RpcMessage` 是权威联合，靠 `switch (message.type)` 收窄。

**为什么 respond 必须回显 rpcId**：这是唯一的关联手段。question 的答复 payload 里连资源 id 都没有（"with no resource id in the payload (rpcId suffices)"）；approval 的 `approvalId` 只是核心审计关联，线缆关联仍由回显的 rpcId 决定（"wire correlation is governed by the echoed rpcId"）。新造一个 id，host 认不出这是对哪次挂起请求的答复，只能丢。

## 4. `RpcResult` 与错误模型

```ts
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code; message; details } }
```

方法不抛业务异常，成功失败都在 `result` 一个槽里；载体异常由 `transportError(e)` 折成 `code: 'internal'`。

> HTTP status describes only the carrier —— `rpc.d.ts`

所以**不要用 HTTP 状态码做分支**：真正要读的是 `result.ok`。同理 `POST /api/respond` 的响应体是 `RpcReceipt = {accepted:true} | {accepted:false, reason:'not-pending'|'bad-response'}`——它属于载体层、不是 `RpcMessage`，只说"答复收没收到"，不说业务结果。

| 归类 | 错误码 · `details` | 可重试？ | 错误码 · `details` | 可重试？ |
| --- | --- | --- | --- | --- |
| 客户端错误（改请求，别重试） | `bad-request` · `issues` | 否 | `session-not-found` · `sessionId` | 否 |
| | `workspace-invalid-path` · `path` | 否 | `directory-unreadable` · `path` | 否 |
| | `agent-preset-not-found` · `agentPreset`,`available` | 否 | `unknown-command` · `{}` | 否 |
| 状态冲突（先重读） | `session-conflict` · `sessionId`,`requestedCwd`,`existingCwd?` | 换 cwd 或复用 id | `agent-preset-locked` · `sessionId`,`agentPreset` | 否（已开跑） |
| | `settings-conflict` · `ns`,`expected`,`actual` | 是：重读 revision 再写 | `workspace-name-conflict` · `name` | 否 |
| 可等待 / 换路 | `agent-busy` · `reason` | 是（稍后） | `model-unavailable` · `provider`,`model` | 换模型，原样重试无用 |
| | `workspace-attach-failed` · `sessionId`,`workspaceId` | 否（会话已发布） | | |
| 终止性 | `internal` · `{}` | 仅当幂等 | `cancelled` · `{}` | 否（调用方取消的） |

全集 39 个键在 `RpcErrorDetailsMap`；加一个码 = 那里加一行 + schema 加一个分支。`details` 恒存在（`internal` 明写 `{}`），可放心解引用。

## 5. 方法清单

53 个 client-request 方法。`respond` 不在表里——它是 `client-response`，不是一元方法。签名一律 `RpcRequest<P> → Promise<RpcResponse<T>>`。

| 方法 | 一句话 | 方法 | 一句话 | 方法 | 一句话 |
| --- | --- | --- | --- | --- | --- |
| `session.list` | 列会话，updatedAt 降序 | `session.search` | 跨会话搜消息，≤20 会话 | `session.create` | 建会话 + 空闲 agent，可幂等重试 |
| `session.history` | 读一页历史（按消息边界切） | `session.models` | 模型目录；`routable` 才决定能否起回合 | `session.selectModel` | 设定 provider/model[/reasoningEffort] |
| `session.rename` | 追加 `session/title` 锁定标题 | `session.fork` | 从某回合前缀 fork 新会话 | `session.prompt` | 发消息（queue/steer），见下 |
| `session.attachment` | 取会话日志引用过的图片字节 | `session.updateQueue` | 对待发项 edit/remove/steer | `session.cancel` | 停当前回合，保留队列，见下 |
| `subagent.list` | 直接子会话目录 + `parentAvailable` 提示 | `subagent.history` | 读子会话历史，不激活 agent | `subagent.prompt` | 向 continuable 子 agent 投人类消息 |
| `subagent.interrupt` | 中断子 agent 当前回合（fire-and-return） | `host.describe` | 一次性宿主快照，见下 | `host.pickDirectory` | 系统目录器，取消返回 null（`native`） |
| `host.listDirectory` | 列一层目录（`browse`） | `host.createDirectory` | 在既有父目录下建子目录 | `host.openPath` | 交给系统默认应用打开 |
| `workspace.list` | 工作区（durable 序）+ 归档集 | `workspace.create` | 在既有目录上建/幂等取（不 mkdir） | `workspace.rename` | 改标题，trim 后非空 |
| `workspace.delete` | 只删注册，目录与日志不动 | `workspace.insertSessionBefore` | 会话在工作区内重排 | `workspace.archiveSession` | 加入归档集，返回新全量 |
| `command.list` | 该 agent 的有效命令目录 | `command.execute` | 执行一行斜杠命令，结果走 mux | `skill.list` | 该会话项目的 skill 目录 |
| `agentPreset.list` | 花名册 + `authorable`/`hasDocument` | `agentPreset.select` | 仅 blank 会话可换组装 | `agentPreset.read` | 读组装文本（特权） |
| `agentPreset.copy` | 复制现有 preset（唯一授权写） | `agentPreset.openDocument` | 把用户 preset 目录交给打开器 | `agentPreset.remove` | 删用户 preset；shipped 拒绝 |
| `goal.create` | 建并武装目标 | `goal.edit` | 改目标/轮数，不动阶段 | `goal.pause` | 暂停并解除自动续跑 |
| `goal.resume` | 恢复并重新武装 | `goal.complete` | 标记完成并解除武装 | `goal.clear` | 清当前目标，留墓碑 |
| `settings.describe` | 红化值 + schema（loopback-only） | `settings.openDocument` | 打开设置文档（请求不带路径） | `settings.update` | 合并 patch 进用户层 |
| `settings.replace` | 整段替换用户段（重置路径） | `settings.mutate` | 按路径 op 编辑（安全删字段） | `credentials.describe` | 批量读 ref 状态，永不含值 |
| `credentials.set` | 写可写层；被遮蔽则 `credential-rejected` | `credentials.unset` | 从可写层删，幂等 | `llm.providers` | 可配置 provider 目录 + 活/休眠 |
| `llm.models` | host 级模型目录 | `llm.discoverModels` | 问草案端点有哪些模型，不落盘 | | |

三个高频方法（`RequestPayload` / `ResponseValue`，取自 `sessions.d.ts`、`host.d.ts`）：

```ts
// session.prompt —— content 恰好一个以 / 开头的文本块时按斜杠命令处理
payload: { sessionId: SessionId; mode: 'queue' | 'steer'; content: PromptContentPart[] }
value:   { accepted: true; command?: { kind: 'success'; text?: string } }
//   PromptContentPart = { type:'text'; text } | { type:'image'; mediaType; data; name? }
// session.cancel
payload: { sessionId: SessionId }   value: { accepted: true }
// host.describe
payload: {}   value: { version: string; cwd: string; provider?: string; model?: string; attachedSessions: number }
```

## 6. 事件流

`MuxFrame`（`/api/events.mux`，9 个变体）：

| 帧 | 一句话 | 帧 | 一句话 |
| --- | --- | --- | --- |
| `session/event` | SessionEvent 直通，可带 `view` | `session/subscribed` | 已接入，`lastSeq` 是当前水位 |
| `approval/requested` | 要答复（见下） | `approval/resolved` | 审批已定，带 `outcome` |
| `question/requested` | 要答复（见下） | `question/resolved` | answered / cancelled |
| `session/queue` | 待发队列全量快照 | `session/projection` | 某投影单元值变了，带 `seq` 水位 |
| `stream/error` | 这条流自己出错（`RpcError`） | | |

`HostFrame`（`/api/events.host`，13 个变体）：

| 帧 | 一句话 | 帧 | 一句话 |
| --- | --- | --- | --- |
| `host/session-added` | 会话出现，带 blank/父/origin/cwd/preset | `host/session-removed` | 会话没了 |
| `host/session-status` | running 翻转 | `host/agent-error` | 没有回合位置的实时失败 |
| `host/workspace-changed` | 工作区全量快照，客户端 upsert | `host/workspace-removed` | 注册删除，不碰目录/日志 |
| `host/archived-sessions-changed` | 归档集全量 | `host/commands-changed` | 命令表变了，重取 `command.list` |
| `host/session-preset-changed` | 该 blank 会话换了 preset，重取它的目录 | `host/settings-changed` | 命名空间变了，重取 `settings.describe` |
| `host/credentials-changed` | 某 ref 变了（值永不上线） | `host/models-changed` | provider 拓扑变了，重取 llm.* |
| `stream/error` | 这条流自己出错 | | |

三件必须记住的事：

**(a) `session/subscribed {lastSeq}` 是缺口修复的锚。** 本地已收最大 seq 与它比，落后就 `session.history` 补。`mux` 的 `since` 在 v1 是摆设——"resume hook, unimplemented in v1 (ignored if passed); reconnection = reopen the stream + refetch history"（`events.d.ts`）。

**(b) `approval/requested` 是可答复 server-request，rpcId 稳定，重连会重放。** 打开 mux 时 "replays each session's still-pending approval/question requested frames (rpcId reused verbatim — the refresh-recovery baseline)"。答复 `value` = `{ sessionId, approvalId, outcome: 'allowed-once' | 'rejected' }`；`cancelled`/`unavailable` 是 host 侧结局，客户端给不出来。

**(c) `question/requested` 同样必须答复，否则回合挂死。** 一次 `ask()` 一批问题、一个答复：`value` = `{ sessionId, answer: AskUserQuestionAnswer }`，回显该帧 rpcId，不拆成多问多答。

## 7. 连接语义

- **只有两态，且首帧前不发状态**：`ConnectionState = 'connected' | 'reconnecting'`。没有 `connecting`/`idle`/`offline`/`error`。初次建立前 `onStateChange` 一次都不触发（"The initial pre-connect span reports nothing — the UI treats 'no state yet' as connecting, not as an outage"）；重复状态去重，只在变化时发。
- **重连无上限、首连也算一次成功**：`ConnectionConfig` 只有 `backoffBaseMs` / `backoffFactor` / `backoffMaxMs` / `streamOpenTimeoutMs`，没有 attempt 上限、没有终态。指数量退避带抖动（实际延迟在 cap/2..cap）；两流都 open 且 `describe` 成功后发 `onConnected`，首连和每次重连成功都发。
- **`streamOpenTimeoutMs` 是兜底，不是超时失败**：严格握手要等 mux+host 两条流 open 再跑 describe；载体（比如不听话的代理）永不 fire onOpen 时不能把连接卡死——超时后这一代照样按 `connected` 前进，落后帧交给实时缺口修复。
- **pump 是拉模式，sink 异常隔离**：没人 for-await 就没人读 socket；业务层抛异常只记日志，不许拖死 pump 或影响重连。

**不要自作聪明加 `offline` / `error` 终态。** 协议里没有这两个词，加一个就得自己发明"从终态怎么回来"的迁移规则，而真实实现是永远重连。（`src/host/connection.mjs` 现有的 `VALID = ['idle','connecting','connected','reconnecting','offline','error']` 是 UI 药丸桩，不是协议状态，别当依据。）

## 8. 信任边界

`ConnectionRpcAuthority` 只有两档（`rpc.d.ts`）：`'trusted-host'` | `'loopback'`，注册 channel 时静态声明——`handle()` 挂绝对前缀（如 `/rpc`），`intercept('/api', ...)` 在共享通道上抢占端点。

- `loopback`：只认本机回环。
- `trusted-host`：回环 **或** 部署在 `trustedHosts` 里声明的 authority（精确 `host:port`，或省端口的 `host` 匹配任意端口）。
- `isLoopbackHostname(hostname)`：`localhost`、IPv6 回环（带方括号）、任意 `127/8`；只看归一化 hostname，不看端口。
- 另一层 Host 头栅栏（`isTrustedApiRequest`）防 DNS rebinding 与跨站；`settings.describe`、`agentPreset` 授权写这类特权方法用空 trust 列表，等于钉死 loopback。

> Network reachability and authentication stay out of scope: binding policy belongs to the webserver config, and this fence is not an auth layer. —— `api-request-trust.d.ts`

> **上面那句 "this fence is not an auth layer" 说的是 Host 头 trust fence，不是整个 web 层的认证。** 实测 `dsh web`（0.2.2-rc.1，见下方 §实测记录）另有一层 token→cookie：没有 cookie 时 `/api/*` 一律 `401 unauthorized`，与 method 是否存在无关。

### 实测记录：`dsh web` 的认证与 API 分层（2026-11-18，Node 24.22.3）

用 `@deepseek-ai/dsh@0.2.2-rc.1` 在本机起 `dsh web --no-open --port 0`，得到
`http://127.0.0.1:<port>/?token=<tok>`，随后实测：

| 请求 | 结果 |
|------|------|
| `POST /api/session.list`（无 cookie，token 放 query） | `401 unauthorized` |
| 同上，`Authorization: Bearer <tok>` | `401` |
| 同上，`x-dsh-token: <tok>` | `401` |
| `GET /?token=<tok>` | `303 See Other` + `Set-Cookie: dsh-auth-<hash>=v1.<payload>.<sig>`（`HttpOnly; SameSite=Strict; Max-Age=30d`） |
| `POST /api/session.list`（带该 cookie） | `404 not found` |

两条结论：

1. **认证存在**，形式是 `GET /?token=` 换签名 cookie，cookie 名里的 `<hash>` 与 value 里的 `authority` 绑定 `host:port`。所以「同设备任意 App 连上 127.0.0.1 就能调 `session.prompt`」是错的——还差一个 token。token 打印在启动输出里，也走 `DSH_WEB_URL` / runtime-context，同用户可读，但这已经不是"裸奔"。
2. **~~`/api/<method>` 在 web profile 上不存在~~ —— 这条 2026-11-18 当天被自己推翻，见下方更正。**

#### 更正：`/api/` 路由是存在的，错的是 endpoint 写法

上表最后一行 `404 not found` 的真实原因不是"gateway 没有 rpc-map"，而是 **method 名用了点号**。`dsh-client-connection` 的 `endpointFromPath("/api", pathname)` 只把 `/api/<ns>/<method>` 解析成 endpoint，得到的字符串是 `session/list`；`/api/session.list` 解析出的 endpoint 在 gateway 的 `claimsEndpoint` 里不命中，于是落回 `404 not found`。

`0.2.2-rc.1` 的 gateway **自带 26 个方法**，全部是 `<namespace>/<method>` 形态，与 apiproxy 那套 `session.list` 是平行命名而非平行 API 层：

| namespace | 方法 |
| --- | --- |
| `session` | `attachment` `cancel` `canOpenWorkspacePath` `control` `create` `events` `follow` `fork` `initializeDefaultModel` `list` `modelCatalog` `observeEvent` `observeProjections` `observeState` `openWorkspacePath` `page` `projections` `prompt` `rename` `search` `selectModel` `state` `updateQueue` `wait` `workspacePathApplications` |
| `skills` | `list` |
| `fileReferences` | `list` |

同时在 `POST /api/session/list` 上实测拿到 `{"ok":true,"value":{"items":[...]}}`，`GET /?token=` 换 cookie 后完整链路可跑（`tools/probe-suite.mjs`，14/14）。所以**不存在"要么退回 apiproxy、要么改协议"的二选一**：gateway 这条路是通的，写法要按上面的分层与信封来。

真正的版本门槛在别处：`@deepseek-ai/dsh/lib/bin.js` 用 `if (import.meta.main) await runCli()`，而 `import.meta.main` 是 **Node 24** 才有的 API。用 Node 18（nodejs-mobile 的版本）或 22 跑 `dsh web` 会**静默退出 0、一行输出都没有**——因为主流程根本没被调用。详见 `../../docs/notes/node-version.md`。

**Android 侧的处理（A-10）**：没有去改协议，而是换了一条链路。dsh host 仍听 loopback，但只有 `:harness` 进程连它；Flutter 与 `:harness` 之间走 **unix domain socket**，路径在 `filesDir`（目录 0700、socket 0600、token 握手）。Android 的目录权限保证了别的 App 连 `open()` 都做不到。代价是每个平台都要自己解决这一层，好处是不必等上游加认证。

## 9. 与本地实现的对应关系

`impl/src/host/protocol/` 已落地（`codec` / `normalize` / `transport` / `session-link`），IPC 边缘见 `impl/src/host/bridge-server.mjs`；"未实现" = 端上没有对应物。

| 协议概念 | 我们的位置 | 协议概念 | 我们的位置 |
| --- | --- | --- | --- |
| `API_PATH`/`MUX_EVENTS_PATH`/`HOST_EVENTS_PATH` | `transport.mjs`（常量） | 四象限信封编解码 | `codec.mjs` |
| `RpcResult` 解包 + `RpcError`→本地错误 | `codec.mjs` | `RpcReceipt`（respond 回执） | `codec.mjs` |
| 单向下行 WS 连接与帧解码 | `transport.mjs` | `ConnectionState` 两态 + 无上限重连 | `transport.mjs` |
| `MuxFrame`/`HostFrame` 分派到会话 | `session-link.mjs` | `session/subscribed.lastSeq` 缺口修复 | `session-link.mjs` |
| `approval/question` 答复（回显 rpcId） | `session-link.mjs` | `SessionEvent` 13 型折叠成视图（插件可 merge 扩展） | `normalize.mjs` |
| `ToolEventView`/`StreamChunk`/`ApprovalOutcome` | **未实现**（属未拉取的包） | 会话投影（`session/projection`） | **未实现** |
| `settings.*`/`credentials.*`/`llm.*`/`agentPreset.*` | **未实现**（端上无配置面） | `host.pickDirectory`/`openPath` 等 native 能力 | **未实现** |

---

## 10. gateway 时代的两种 carrier（Android 用第二种）

上面 §2–§9 描述的是 `dsh-host-apiproxy` 那一层（`/api/<method>` + `POST` 信封 + 双流 WS）。真 `dsh web` 装的是 `dsh-api-gateway`（Typert），端点是**斜杠**形态 `/api/<namespace>/<method>`，细节见 [gateway-typert.md](./gateway-typert.md)。

同一个 gateway 有两个物理载体，endpoint 语义完全相同：

| | HTTP + WS | 进程内（in-process） |
|---|---|---|
| unary | `POST /api/session/list` | `gateway.invoke({namespace,method,args,peer})` |
| stream | `WS /api/remote.mux` 的 `open` 帧 | `gateway.stream({...})` → async iterable |
| 身份 | `GET /?token=` 换 cookie → 认证 peer | `connection.createPeer({principal:{kind:'owner'}})` |
| 需要端口 | 是 | **否** |
| Android 适用 | 调试时用（PC 可以连进来） | **产品路径** |

gateway 的注释写明了这一点：`invoke()` / `stream()` *"without assuming a physical carrier"*；`createPeer()` *"Create one in-process Peer owned by the Context"*。

**为什么 Android 走进程内**：libnode 一个进程只能有一个 runtime（libuv 的 default loop 是进程级全局），所以 dsh 与 Flutter 桥必须同进程。同进程之间再架一层 loopback HTTP，多出来的是端口、token、cookie jar 和一份重复的失败模式，换不到任何隔离。

实测脚本：`impl/tools/probe-inproc.mjs`（`session/list` → `create` → `state` → `follow` → `prompt`，5/5）。

> 注意 `invoke` 的 `args` 键是**方法形参名**：`session/list` 是 `_request`，`session/create` 是 `request`，无参是 `{}`。这条在 HTTP 与进程内两条路径上都一样，写错会得到 `gateway/signature-invalid`。
