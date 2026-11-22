# 02 · 协议

> 两条通道，两套方言，别混：Flutter↔`:harness` 是 NDJSON over unix socket；`:harness`↔dsh 是
> 同进程的 Typert gateway 调用。协议栈只写一遍，全在 Node。

## 1. 两条通道

| 通道 | 载体 | 载荷 | 实现 |
|---|---|---|---|
| Flutter ↔ harness | unix domain socket + NDJSON，token 握手 | `prompt` / `cancel` / `approval` 三个动词 + 后端事件 | `src/host/bridge-server.mjs`、`app/lib/unix_bridge.dart` |
| harness ↔ dsh | **同进程**，`gateway.invoke` / `gateway.stream` | Typert 方法 | `src/host/protocol/transport-inproc.mjs` |

同进程不是优化，是去掉了三样东西：端口、launch token、cookie。原先的
`http://127.0.0.1:7020` 是进程内自己给自己发网络包，多一套故障模式
（`transport-inproc.mjs:1-9`）。桌面调试没有「同进程的 dsh」，`DSH_BASE_URL` 的 HTTP 路径保留。

## 2. gateway（Typert，`0.2.2-rc.1`）

**认证**：`GET /?token=<launch-token>` → `303` + `Set-Cookie: dsh-auth-<hash>=…`；之后只带这条
cookie。`Authorization: Bearer` 与 `x-dsh-token` 都仍是 401（`probe-suite.mjs:14-16`）。

**unary**：`POST /api/<ns>/<method>`，body：

```json
{"type":"client-request","rpcId":"…","method":"<ns>/<method>","payload":{"args":{…}}}
```

**stream**：WS `/api/remote.mux`，客户端只发 `open`/`item`/`cancel`/`end`，服务端回
`item`/`end`/`error`；一个连接靠 `streamId` 多路复用。unary 与 stream 严格分工，走错返回
`gateway/signature-invalid`。

三个最容易踩的点：

| 点 | 事实 | 证据 |
|---|---|---|
| 端点分隔符是**斜杠** | `POST /api/session/list`；用点号（`/api/session.list`）→ **404** | `probe-suite.mjs:18-19, 202-205` |
| `args` 的 key 是**形参名** | `session/list` 要 `{"_request":{}}`（带下划线）；猜错报 `arguments-invalid` 并回显缺哪个 | `protocol/gateway-typert.md` §3.1 |
| 业务错误**不在 HTTP 状态** | `HTTP 200` + `result:{ok:false,error:{code,message}}`；非 200 只有 401/403/404/415/400 | 同上 §3 |

方法名与参数（节选，全集见 `impl/protocol/gateway-typert.md` §5）：

| endpoint | args | 返回 | stream |
|---|---|---|---|
| `session/list` | `_request:{cursor?}` | `{items}` | |
| `session/create` | `request:{workspaceId?,cwd?,sessionId?,agentPreset?}` | `{sessionId,agentPreset}` | |
| `session/page` | `request:{address,throughSeq?,beforeSeq?,maxMessages?}` | `{records,cursor,hasMore}` | |
| `session/prompt` | `request:{requestId,sessionId,mode,content[]}` | `{accepted:true}` | |
| `session/follow` | `request:{address,maxMessages?,activate?,assistantStream?}` | snapshot + 增量 | ✓ |

`session/follow` 首帧是 snapshot，`projections.values` 有 20 个键（`sessionStats` `turnOutline`
`userQuestions` `tokenUsage` `contextPressure` `title` `modelSelection` `todos` `plan` …）。
`routableProviders` 为空 = 没有可用凭据，此时 `session/selectModel` 会被拒。

**一次「prompt→失败」实测 18 条事件**：`permission/preset → sandbox/mode → approval/policy → turn/start →
… → assistant/attempt（stream chunk）→ turn/end`。无凭据时失败在业务事件里，不是 401：
`{"code":"MISSING_CREDENTIAL","message":"llm-deepseek: no API key for provider route…"}`。

## 3. 两套 API 方言

仓库里同时存在 apiproxy（`0.0.1-rc.1`，`protocol/` 快照）与 gateway（`0.2.2-rc.1`，真 `dsh web`）。
信封长得像，实际不通用：

| | apiproxy | gateway |
|---|---|---|
| 方法名 | `session.list` | `session/list` |
| unary | `POST /api/session.list` | `POST /api/session/list` |
| 流 | WS `/api/events.mux` + `/api/events.host` | WS `/api/remote.mux` |
| 参数 | `payload` 直接是业务对象 | `payload.args` 按形参名 |
| 认证 | 无 | token 换 cookie |

`session-link.mjs` 说 apiproxy 方言，gateway 说 Typert 方言，所以 `transport-inproc.mjs:45-100`
有一张显式对照表（点号方法 → 端点 + 形参装配 + 结果收敛）。表里没有的方法按「点号拆开、
payload 原样当 args」处理并记日志——猜形参名只会换来 `arguments-invalid`。

## 4. Flutter ↔ harness（NDJSON）

| 项 | 事实 |
|---|---|
| 路径 / 握手 | `filesDir/harness.sock`（目录 `0700`、socket `0600`）；连接后先发 token，握手前不推事件 |
| 帧 | 一行一条 JSON；半行截断要当错误，不能拼进下一条 |
| 重连 | 无上限；退避 `cap/2..cap` 抖动。没有「6 次失败即永久 offline」 |
| 背压 | 慢消费者触发截断时只丢整行，不产生半行 |
| 提问 | `question/requested` 是可答复的 server-request，不答 = host 永久挂起；整批答复 `{answers:[{id,selected[],custom?}]}`，缺 id 时提交按钮禁用 |

`session.prompt` 不套 RPC 超时，也不重试：它是 durable admission，立刻回 `{accepted:true}`，
内容只从流里来；取消走 `session/cancel`。重连后审批按 host 重放重建，客户端**先清空本地待审队列**，
否则会出现两张卡、第二张点了没反应。

## 5. 验证

真实 `dsh web` 的 14 条端点断言全过（`node tools/probe-suite.mjs --token <t>`）。单测：协议一致性 31
（`protocol.test.mjs`）、会话链接 16（`session-link.test.mjs`）、同进程方言 8（`transport-inproc.test.mjs`）、
NDJSON 桥 30（`bridge.test.mjs`）。

**未做**：App 内到真实 `dsh web` 的整链联调。现有证据是探针 + 严格执法的 mock host
（错包 400、WS 上写入即断、造 rpcId 串味），不是端到端。
