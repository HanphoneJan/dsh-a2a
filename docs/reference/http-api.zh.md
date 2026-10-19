---
name: HTTP API 与 A2A 协议
description: 仅回环面板动作、入站 JSON-RPC 端点、SSE 流式、任务状态、错误码、AgentCard 与出站工具契约
create-time: 2026-10-19
update-time: 2026-10-19
version: v0.3.8
relative-docs:
  - docs/guide/getting-started.zh.md
  - docs/guide/concepts.zh.md
  - docs/architecture.zh.md
---

# HTTP API 与 A2A 协议

[English](http-api.md) · **中文**

本页是 `0.3.8` 的线上参考，分两部分：

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
| `GET /a2a/api` | 快照：`{ inbounds, outbounds, tasks, peers, sessions }` |
| `GET /a2a/api/presets` | Agent preset 名单：`[{ id, name?, description?, isDefault? }]` |

快照样例（值已缩写）：

```json
{
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
      "toolCount": 1
    }
  ],
  "tasks": [],
  "peers": [],
  "sessions": []
}
```

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
| `inbound.close` | `id`（对端 id） | — |

#### 出站

| 动作 | 必填 | 可选 |
|---|---|---|
| `outbound.create` | `name`、`agentCardUrl` | `bearerTokenEnv`、`preset`、`enabled`、`timeoutMs` |
| `outbound.update` | `id` | `name`、`preset`、`timeoutMs` |
| `outbound.remove` | `id` | — |
| `outbound.enable` / `outbound.disable` | `id` | — |
| `outbound.refresh` | `id` | — |
| `outbound.setAuth` | `id` | `token`（省略或空串表示清除） |
| `outbound.discover` | `agentCardUrl` | `token` |

#### 任务与会话

| 动作 | 必填 | 效果 |
|---|---|---|
| `task.cancel` | `id`（任务 id） | 中止并标记任务为取消 |
| `session.cancel` | `id`（context id） | 取消该上下文的活跃任务 |
| `session.close` | `id`（context id） | 取消活跃任务并释放活跃会话句柄 |

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
| `ListTasks` | 无（参数被忽略） | 返回 store 里的全部任务 |
| `CancelTask` | `id` | 取消非终态任务；终态任务返回 `TASK_CANCEL_NOT_ALLOWED` |
| `SubscribeToTask` | `id` | 对已有任务先补发当前状态，再流到终态；需要 SSE |
| `GetExtendedAgentCard` | 无 | 返回同一张 AgentCard |

不支持的方法（包括 push notification 配置方法）返回 `METHOD_NOT_FOUND`。
卡片宣告 `capabilities.pushNotifications: false`。

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

- `parts` 可以是文本、文件或数据；session 执行器用 `partsToText` 渲染为文本，
  文件变成 URL/名称，数据变成 JSON。
- `metadata.skill` 选择宣告的技能；省略默认 `chat`，不在宣告集合里会被门禁拒绝。
- `contextId` 是对话键。复用即复用活跃 DSH 会话；省略则生成新上下文。
- `messageId` 运行时可选；任务身份由服务端生成。

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

帧是未命名的 SSE `data:` 行。每个 payload 是 `StreamResponse`：

- `{ "statusUpdate": { taskId, contextId, status } }`
- `{ "artifactUpdate": { taskId, contextId, artifact, lastChunk } }`
- `{ "task": { ... } }`（最终落定任务）

`SubscribeToTask` 用同一传输，先补发当前状态，再流到终态。

#### 2.4.1 流里到底有什么

默认 `session` 执行器跑一轮，把最终回复作为一个 artifact 返回。它的流是**生命周期**，
不是 token 级：

- 初始 `statusUpdate`，状态 `TASK_STATE_WORKING`，带 task id；
- `subagent` 执行器会在子任务结束时发一个 `artifactUpdate`；
- 最终 `task`，带 artifact。

模型的推理与工具调用不会投影到 A2A；DSH Web UI 单独展示。以落定任务为准，不要以中间帧为准。

#### 2.4.2 断连与重连

客户端断连**不会**取消任务。`SendMessage` 与 `SendStreamingMessage` 都会把执行器跑完并持久化任务；
SSE 订阅只负责投递。

- 从第一帧 `statusUpdate` 里记下 `taskId`。重连时用 `GetTask` 轮询，或 `SubscribeToTask` 从当前状态继续流。
- `SubscribeToTask` 会补发当前状态并推送后续帧；它**不会**补发错过的中间帧，也没有
  `Last-Event-ID` 或事件游标。
- `SendMessage` 只在任务落定后返回任务。如果连接在响应前断开，客户端拿不到 task id。
  没有幂等键：重发相同的 `messageId`/`taskId` 会创建新任务，不是续传。
  需要恢复就用流式并持久化 id，或用 `ListTasks` 查最近任务。
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

工具用稳定的 per-caller `contextId` 发 A2A `SendMessage`，等待任务，返回 artifact 文本。
`FAILED` 任务抛工具错误并带远端消息；`INPUT_REQUIRED` 与 `AUTH_REQUIRED` 以文本返回，
让模型自行处理。

## 4. 当前限制

这些是 `0.3.8` 的已知或有意行为，不要假设相反：

- `SendMessage` 总是阻塞；声明的 `returnImmediately` 未生效。
- `historyLength` 未生效；`GetTask` 不返回 history 数组。
- `ListTasks` 忽略过滤与分页，返回整个任务 store。
- 未实现 push notifications；push 配置方法返回 `METHOD_NOT_FOUND`。
- 只实现 JSON-RPC 绑定（没有 gRPC 或 HTTP+JSON）。
- 没有 OAuth、mTLS、按客户端凭据或限流。
- 出站 `preset` 只是持久化元数据；出站工具背后还没有本地衔接会话。
- `subagent` 执行器存在，但默认技能表不会选中它。
