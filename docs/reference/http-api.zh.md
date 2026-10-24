---
name: HTTP API 与 A2A 协议
description: 仅回环面板动作、入站 JSON-RPC 端点、SSE 流式、任务状态、错误码、AgentCard 与出站工具契约
create-time: 2026-10-19
update-time: 2026-10-24
version: v0.5.0
relative-docs:
  - docs/guide/getting-started.zh.md
  - docs/guide/concepts.zh.md
  - docs/architecture.zh.md
---

# HTTP API 与 A2A 协议

[English](http-api.md) · **中文**

本页是 `0.5.0` 的线上参考，分两部分：

1. 面板使用的**仅回环控制 API**（`/a2a/api`）；
2. 入站 server 发布的 **A2A 端点**（`/a2a/<id>`）。

控制 API 是控制面；A2A 端点是对外协议面。两者分开：远端客户端能调入站端点，
但驱动不了面板。

## 1. 面板 API

基础路径：`/a2a/api`。它挂在 profile 的 web server 上，只接受回环来源
（`127.0.0.1`、`::1`、`::ffff:127.0.0.1`）；其他来源 `403`。

### 1.1 读接口

| 方法与路径 | 返回 |
|---|---|
| `GET /a2a/api` | 快照：`{ version, inbounds, outbounds, tasks, peers, sessions }` |
| `GET /a2a/api/presets` | Agent preset 名单：`[{ id, name?, description?, isDefault? }]` |
| `GET /a2a/api/update` | 插件版本与更新检查结果（见下）；`?refresh=1` 绕过缓存 |
| `GET /a2a/api/card?id=<inbound>` | 单个入站 AgentCard |
| `GET /a2a/api/task?id=<task>` | 单条任务 |
| `GET /a2a/api/session?contextId=<id>&serverId=<instance>` | 单个会话视图 |
| `GET /a2a/api/metrics` | 指标快照 |

`version` 是已安装的插件版本，随快照返回，因此面板在第一次网络请求之前就能显示它。
`outbounds[].agentVersion` 是连接存活时远端 AgentCard 宣告的版本。`GET /a2a/api`
还接受 `taskLimit`、`taskOffset`、`taskState`、`taskContextId`、`taskServerId`
控制任务页。

快照样例（值已缩写）：

```json
{
  "version": "0.5.0",
  "inbounds": [
    {
      "id": "e2e-b-ade6a7ad",
      "name": "b-server",
      "description": "B inbound",
      "version": "0.1.0",
      "endpointPath": "/a2a/e2e-b-ade6a7ad",
      "preset": "standard",
      "cardPath": "/a2a/e2e-b-ade6a7ad/agent-card.json",
      "cardUrl": "http://127.0.0.1:3081/a2a/e2e-b-ade6a7ad",
      "enabled": true,
      "skills": [{ "id": "chat", "name": "chat", "description": "..." }]
    }
  ],
  "outbounds": [
    {
      "id": "out-2c6d9dbd-cf6",
      "name": "b",
      "agentCardUrl": "http://127.0.0.1:3081/a2a/e2e-b-ade6a7ad/agent-card.json",
      "enabled": true,
      "timeoutMs": 60000,
      "state": "connected",
      "skillCount": 1,
      "toolCount": 1,
      "agentVersion": "1.0.0"
    }
  ],
  "tasks": [],
  "peers": [],
  "sessions": []
}
```

`GET /a2a/api/update` 返回：

```json
{
  "ok": true,
  "current": "0.5.0",
  "latest": "0.5.1",
  "hasUpdate": true,
  "ahead": false,
  "error": null,
  "source": "npm",
  "repoUrl": "https://github.com/HanphoneJan/dsh-a2a",
  "checkedAt": 1790000000000,
  "cached": false,
  "runtime": { "node": "24.20.0", "platform": "linux", "arch": "x64", "profile": "web" }
}
```

它同时查询 npm registry 的 `latest` 标签与插件 manifest 中 GitHub 仓库的
`package.json`，取其中更高的版本。结果缓存 6 小时；`?refresh=1` 绕过缓存。
`runtime` 带 Node 版本、平台/架构，以及宿主 export 的 `DSH_PROFILE`（当前
profile），面板据此生成对应 profile 的更新命令。两条源都查不到时仍返回
`200`，但 `ok: false`、`latest: null` 并带 `error`——查询失败绝不会显示成
「已是最新」。检查是只读的：不安装、不重启、不改 profile。

### 1.2 控制动作

`POST /a2a/api`，body 里的 `action` 为下列之一。

#### 入站

| 动作 | 必填 | 可选 |
|---|---|---|
| `inbound.create` | `name`、`description`、`version` | `endpointPath`、`preset`、`authTokenEnv`、`enabled` |
| `inbound.update` | `id` | `name`、`description`、`version`、`endpointPath`、`preset`、`authTokenEnv` |
| `inbound.remove` | `id` | — |
| `inbound.enable` / `inbound.disable` | `id` | — |
| `inbound.setAuth` | `id` | `token`（省略或空串表示清除） |
| `inbound.sendTest` | `id`、`text` | `contextId`、`skill` |
| `inbound.close` | `id`（对端 id） | — |

#### 出站

| 动作 | 必填 | 可选 |
|---|---|---|
| `outbound.create` | `name`、`agentCardUrl` | `bearerTokenEnv`、`preset`、`enabled`、`timeoutMs`、`disabledSkills`、`skillOverrides` |
| `outbound.update` | `id` | `name`、`preset`、`timeoutMs`、`disabledSkills`、`skillOverrides` |
| `outbound.remove` | `id` | — |
| `outbound.enable` / `outbound.disable` | `id` | — |
| `outbound.refresh` | `id` | — |
| `outbound.setAuth` | `id` | `token`（省略或空串表示清除） |
| `outbound.discover` | `agentCardUrl` | `token` |

#### 任务与会话

| 动作 | 必填 | 效果 |
|---|---|---|
| `task.cancel` | `id`（任务 id） | 中止并标记任务为取消 |
| `session.cancel` | `id`（context id） | 取消该上下文的活跃任务；可选 `serverId` 限定实例 |
| `session.close` | `id`（context id） | 取消活跃任务并释放活跃会话句柄；可选 `serverId` |

### 1.3 响应与状态码

成功的控制动作返回 `200`：

```json
{ "ok": true, "message": "inbound server \"b-server\" created", "id": "b-server-..." }
```

`inbound.create` 与 `outbound.create` 带 `id`；`outbound.discover` 带
`preview`（远端名称、版本、描述、端点、技能）。失败动作返回 `409`：
`{ ok: false, message, ... }`。

| 状态 | 含义 |
|---|---|
| `200` | 动作成功，或读取成功 |
| `400` | body 不是合法 JSON |
| `403` | 调用方不是回环 |
| `405` | 方法不是 `GET`/`POST` |
| `413` | 请求体超过配置上限 |
| `409` | 动作失败（如未知 id、连接失败） |

### 1.4 示例

创建入站实例：

```sh
curl -sS -X POST http://127.0.0.1:3080/a2a/api \
  -H 'content-type: application/json' \
  -d '{
    "action": "inbound.create",
    "name": "reports",
    "description": "Reporting agent",
    "version": "0.1.0",
    "preset": "standard",
    "enabled": true
  }'
```

设置 Bearer Token：

```sh
curl -sS -X POST http://127.0.0.1:3080/a2a/api \
  -H 'content-type: application/json' \
  -d '{ "action": "inbound.setAuth", "id": "reports-1a2b3c4d", "token": "s3cr3t" }'
```

只发现远端卡片、不建立连接：

```sh
curl -sS -X POST http://127.0.0.1:3080/a2a/api \
  -H 'content-type: application/json' \
  -d '{ "action": "outbound.discover", "agentCardUrl": "https://remote.example/a2a/x/agent-card.json" }'
```

创建连接：

```sh
curl -sS -X POST http://127.0.0.1:3080/a2a/api \
  -H 'content-type: application/json' \
  -d '{
    "action": "outbound.create",
    "name": "remote",
    "agentCardUrl": "https://remote.example/a2a/x/agent-card.json",
    "timeoutMs": 60000
  }'
```

## 2. A2A 端点

一个入站实例发布：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/a2a/<id>/agent-card.json` | `GET` | AgentCard JSON |
| `/a2a/<id>` | `POST` | JSON-RPC 端点 |

端点按实例的 `endpointPath`（默认 `/a2a/<id>`）前缀注册。停用实例会注销两条路由。

### 2.1 鉴权

没有 token 时不需要 `Authorization`。配置 token 后，每个请求必须带：

```http
Authorization: Bearer <token>
```

缺失或错误返回 `401` 和 `WWW-Authenticate: Bearer`。流式请求在写 `200` SSE 头之前先鉴权，
所以 `401` 仍是干净的 HTTP 状态。

### 2.2 方法

端点说 A2A `1.0.1` 的 JSON-RPC 绑定，方法名为 PascalCase。

| 方法 | 参数 | 行为 |
|---|---|---|
| `SendMessage` | `message` | 创建任务并**阻塞到终态/中断态**；返回任务 |
| `SendStreamingMessage` | `message` | 创建任务并流式推送；需要 `Accept: text/event-stream` |
| `GetTask` | `id` | 返回一个任务 |
| `ListTasks` | `contextId`、`status`、`pageSize`、`pageToken`、`statusTimestampAfter`、`includeArtifacts`、`historyLength` | 按条件过滤、游标分页，按最近更新倒序；响应含 `totalSize` |
| `CancelTask` | `id` | 取消非终态任务；终态任务返回 `TASK_CANCEL_NOT_ALLOWED` |
| `SubscribeToTask` | `id` | 对非终态任务补发当前 Task 并流到终态；终态任务返回 `UNSUPPORTED_OPERATION`；支持进程内 `Last-Event-ID` 回放 |
| `GetExtendedAgentCard` | 无 | 返回同一张 AgentCard |

不支持的方法返回 `METHOD_NOT_FOUND`；由于卡片宣告
`capabilities.pushNotifications: false`，push notification 配置方法返回
`PUSH_NOTIFICATION_NOT_SUPPORTED`（`-32003`）。

### 2.3 消息形状

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "optional-uuid",
      "contextId": "optional-uuid",
      "role": "ROLE_USER",
      "parts": [{ "text": "hello" }],
      "metadata": { "skill": "chat" }
    }
  }
}
```

- `parts` 可以是文本、文件或数据。文本与数据进入 DSH 提示词；带 `raw` 的图片/文件
  （`raw` + `mediaType`/`filename`）会经宿主 attachment store 准入，作为真实附件进入会话；
  只有 URL 的文件 part 仍按文本处理（服务端不会主动抓取远端 URL）。
- `metadata.skill` 选择宣告的技能；省略默认 `chat`，不在宣告集合里会被门禁拒绝。
- `contextId` 是对话键。复用即复用活跃 DSH 会话；省略则生成新上下文。
- `messageId` 是幂等键：重发同一 id 返回原任务，不会重复执行。`taskId` 用于继续
  非终态任务；终态任务会拒绝后续消息；对仍在运行的任务续接会返回
  `UNSUPPORTED_OPERATION`，不会静默丢弃。
- `SendMessage` 返回 `result: { "task": ... }`（直接消息响应为 `{ "message": ... }`），
  与规范 oneof 一致。
- 每个请求可带 `A2A-Version`（header 或 query）。不支持的版本返回
  `VERSION_NOT_SUPPORTED`（`-32007`）；响应会带 `A2A-Version: 1.0`。

### 2.4 流式

带 `Accept: text/event-stream` 发送：

```sh
curl -N http://127.0.0.1:3080/a2a/<id> \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": "2",
    "method": "SendStreamingMessage",
    "params": { "message": { "role": "ROLE_USER", "parts": [{ "text": "hello" }] } }
  }'
```

每个 SSE 事件是 JSON-RPC result envelope（可选带 `id:` 行用于
`Last-Event-ID` 回放）：

```text
id: 7
data: {"jsonrpc":"2.0","id":2,"result":{"artifactUpdate":{...}}}
```

首帧是当前 `task`，之后是 `statusUpdate` / `artifactUpdate`。增量 artifact
带 `append: true`；省略/false 表示替换。错误帧使用 JSON-RPC error envelope
（`data: {"jsonrpc":"2.0","id":...,"error":{...}}`）。

`SubscribeToTask` 用同一传输，先发送当前 Task，再流到终态。终态任务返回
`UNSUPPORTED_OPERATION`；带 `Last-Event-ID` 时发送快照并只回放非 artifact 帧，
避免 append 分片重复。

#### 2.4.1 流里到底有什么

默认 `session` 执行器会把实时 assistant 文本增量投影为 `artifactUpdate` 分片
（`lastChunk: false`），最后再发一个 `lastChunk: true` 收尾。工具调用增量会作为
`data` part 放在 `tool-call-<id>` artifact 里。流形状：

- 初始 `task`，带当前状态和 task id；
- 零个或多个 `artifactUpdate`，承载 assistant/工具进度；
- 最终 `task`，带完整 artifacts。

推理增量故意不投影。以落定任务为准。

#### 2.4.2 断连与重连

客户端断连**不会**取消任务。`SendMessage` 与 `SendStreamingMessage` 都会把执行器跑完并持久化任务；
SSE 订阅只负责投递。

- 每个流帧都带 SSE `id:`。重连时用 `SubscribeToTask` + `Last-Event-ID: <id>`：
  服务端先发当前 Task 快照，再只回放 status 帧（artifact 分片已在快照里）；
  日志有界（每任务 200 帧）且仅存在于当前进程。
- `SendMessage` 只在任务落定后返回任务。如果连接在响应前断开，用同一
  `messageId` 重试（幂等），或用 `ListTasks` 找回任务。继续中断任务时带上原 `taskId`。
- 复用 `contextId` 延续活跃 DSH 对话；任务续传与对话连续性是两件事。新的 `contextId` 开启新对话。
- DSH 进程重启会保留任务与 context 绑定，但不保留活跃会话或 SSE 订阅。
  进程死亡时处于 `TASK_STATE_WORKING` 的任务没有崩溃恢复，可能一直停在该状态。

### 2.5 任务状态

| 状态 | 终态？ | 含义 |
|---|---|---|
| `TASK_STATE_SUBMITTED` | 否 | 任务已记录，未开始 |
| `TASK_STATE_WORKING` | 否 | 执行器运行中 |
| `TASK_STATE_INPUT_REQUIRED` | 否（中断） | 远端 agent 需要更多输入 |
| `TASK_STATE_AUTH_REQUIRED` | 否（中断） | 远端 agent 需要认证 |
| `TASK_STATE_COMPLETED` | 是 | 完成，带 artifacts |
| `TASK_STATE_FAILED` | 是 | 执行失败；状态消息带错误 |
| `TASK_STATE_CANCELED` | 是 | 调用方或面板取消 |
| `TASK_STATE_REJECTED` | 是 | 执行前被拒绝 |

### 2.6 错误码

| 码 | 名称 |
|---|---|
| `-32700` | `PARSE_ERROR` |
| `-32600` | `INVALID_REQUEST` |
| `-32601` | `METHOD_NOT_FOUND` |
| `-32602` | `INVALID_PARAMS` |
| `-32603` | `INTERNAL_ERROR` |
| `-32001` | `TASK_NOT_FOUND` |
| `-32002` | `TASK_CANCEL_NOT_ALLOWED` |
| `-32003` | `PUSH_NOTIFICATION_NOT_SUPPORTED` |
| `-32004` | `UNSUPPORTED_OPERATION` |
| `-32005` | `CONTENT_TYPE_NOT_SUPPORTED` |
| `-32006` | `STREAMING_NOT_SUPPORTED` |
| `-32007` | `VERSION_NOT_SUPPORTED` |
| `-32008` | `INVALID_AGENT_RESPONSE` |
| `-32040` | `UNAUTHORIZED`（HTTP 401 映射） |

当前 dispatch 实际使用其中一部分：`INVALID_REQUEST`、`INVALID_PARAMS`、
`METHOD_NOT_FOUND`、`INTERNAL_ERROR`、`TASK_NOT_FOUND`、
`TASK_CANCEL_NOT_ALLOWED` 与 `401` 映射。

### 2.7 AgentCard

```json
{
  "name": "reports",
  "description": "Reporting agent",
  "version": "0.1.0",
  "provider": { "url": "https://deepseek.com", "organization": "DeepSeek" },
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "extendedAgentCard": true,
    "stateTransitionHistory": false
  },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [{ "id": "chat", "name": "chat", "description": "..." }],
  "supportedInterfaces": [
    {
      "url": "http://127.0.0.1:3080/a2a/<id>",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ]
}
```

配置 Bearer 时，卡片额外带 `bearer` 安全方案与要求，但绝不含 token 值。

## 3. 出站工具契约

每个已连接远端技能变成一个模型工具：

```text
a2a__<连接名>__<技能 id>
```

名称规范化为 `[A-Za-z0-9_-]`（其他字符变 `_`），截断到 64 字符，冲突时加哈希区分。参数 schema：

```json
{
  "prompt": "要发给远端 agent 的任务或指令。"
}
```

工具用稳定的 per-caller `contextId` 发 A2A 消息；远端卡片支持流式时走流式，
会把调用方 abort 传下去（拿到 task id 后本地取消还会发 `CancelTask`），并对瞬时传输/5xx
失败重试。`FAILED` 任务抛工具错误并带远端消息；`INPUT_REQUIRED` 与 `AUTH_REQUIRED`
以文本返回并带上远端 `taskId`，模型可用 `taskId` 继续。

## 4. 当前限制

这些是 `0.5.0` 的已知或有意行为，不要假设相反：

- `SendMessage` 默认阻塞；`configuration.returnImmediately: true` 会在启动任务后立即返回。`historyLength` 已应用于 `GetTask`、`SendMessage` 和 `ListTasks`（history 从持久化任务输入/输出重建，不是逐轮完整 transcript）。
- `acceptedOutputModes` 只接受文本模式；排除文本的请求返回 `CONTENT_TYPE_NOT_SUPPORTED`。
- 未实现 push notifications；push 配置方法返回 `PUSH_NOTIFICATION_NOT_SUPPORTED`（`-32003`）。
- 只实现 JSON-RPC 绑定（没有 gRPC 或 HTTP+JSON）。
- 没有 OAuth、mTLS 或按客户端凭据；限流是进程内、按来源、可配置的，没有分布式配额。
- SSE 事件日志在内存里：`Last-Event-ID` 只支持同一进程内重连恢复，不支持重启恢复。
- 出站 `preset` 目前仍是未来本地衔接会话的持久化元数据；出站工具直接调用远端。
- `subagent` 执行器存在，但默认技能表不会选中它。
