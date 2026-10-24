---
name: 核心概念
description: A2A 模型、入站 server、出站连接、preset、技能、任务、上下文、执行器与安全模型
create-time: 2026-10-19
update-time: 2026-10-24
version: v0.5.0
relative-docs:
  - docs/architecture.zh.md
  - docs/guide/operations.zh.md
  - docs/reference/http-api.zh.md
---

# 核心概念

[English](concepts.md) · **中文**

本页定义手册后面会用到的术语，描述 `0.5.0` 的当前行为——也包括实现比协议更窄的地方。

## 1. 一句话理解 A2A

Agent2Agent（A2A）是让一个 agent 通过 HTTP + JSON-RPC 调用另一个 agent 的协议。
**server** 发布 AgentCard，描述身份、端点和技能；**client** 读取卡片，向端点发消息，
等待任务落定（或订阅流式更新）。本插件实现 A2A `1.0.1` 的 JSON-RPC 绑定，
声明协议版本 `1.0`；不实现 gRPC 或 HTTP+JSON 绑定。

## 2. 两个方向

| 方向 | 谁调用谁 | 插件面 |
|---|---|---|
| **入站** | 远端 A2A 客户端调用这个 DSH | 每个被发布的 agent 一个**入站 server** |
| **出站** | 这个 DSH 调用远端 A2A agent | 每张远端卡片一个**出站连接** |

两个方向互相独立。一个 profile 可以有任意多个入站和出站，也可以指向其他 DSH 实例或非 DSH 的 A2A agent。

## 3. 入站 server

一个入站 server 实例就是一个被发布的 agent，拥有：

- **端点** `/a2a/<id>`；
- **AgentCard** `/a2a/<id>/agent-card.json`；
- 卡片上的**名称**、描述、版本；
- 一个**agent preset**，决定该端点背后的 DSH 会话如何组装；
- 从该 preset 派生的**技能**；
- 可选的 **Bearer Token**；
- **启用**标志，决定路由是否注册。

实例在面板或 `/a2a` 命令里创建、编辑、启停、删除，并持久化；重启后会重新组装，
并重新注册已启用的实例。

## 4. 出站连接

一个出站连接就是“这个 DSH 可以调用的一个远端 agent”，拥有：

- 远端 **AgentCard URL**；
- 本地**名称**，会成为工具名的一段；
- 导入的**技能**，每个注册成一个模型工具；
- 可选 **Bearer Token**；
- 每个连接自己的**超时**；
- 可选 **preset**（持久化元数据，见 §7）；
- **启用**标志。

连接时插件读取卡片、导入技能、按技能注册工具。连接失败会保留在面板里，显示 `lastError`，
可以刷新或编辑。

## 5. Preset 与技能

**Preset** 是 DSH 的 agent 预设：命名的一套指令、工具、技能和模型默认值组合。
入站 server 绑定一个 preset，并为每个 A2A 上下文用该 preset 组装一个新的 DSH 会话。

**技能是派生的，不是手写的。** 创建/更新/启动时，插件：

1. 解析 preset 及其 standing scope；
2. 列出该 preset 能看到的技能；
3. 把其中模型可调用的条目宣告到 AgentCard。

如果 skills 服务或 preset 挂载不可用，卡片回退到内置的单个 `chat` 技能。
请求省略 `message.metadata.skill` 时，也默认路由到 `chat`。

如果请求的 `metadata.skill` 不在宣告集合里，技能门禁会在执行前拒绝。

## 6. 任务与上下文

入站 `SendMessage` 会创建一个**任务**：

- 任务 id 为 `a2a-<uuid>`；
- 上下文 id 由调用方提供或自动生成；
- 任务记录技能、输入 parts、状态、artifacts、时间戳，以及接收它的入站实例。

状态使用 A2A 词汇（`TASK_STATE_*`）；完整状态表（含哪些是终态）见
[协议参考](../reference/http-api.zh.md#25-任务状态)。

**上下文**是一条对话。插件为每个上下文保留**一个活跃 DSH 会话**，
id 固定为 `a2a-<contextId>`。复用同一个 `contextId` 就复用该会话；不同的
`contextId` 会打开不同会话。

会话句柄只在内存里。面板的**关闭**会取消该上下文所有活跃任务并释放活跃句柄；
同一 `contextId` 的下一个任务会重新打开一个新句柄。任务和 context→session 绑定会持久化，
所以重启保留任务历史，但不会复活会话。

## 7. 执行器

入站侧有一层执行器接缝，两个实现：

- **session**——在上下文的 DSH 会话上跑一轮，返回最后一条 assistant 文本。
  当前默认组合里所有技能都走它。
- **subagent**——把任务委托给配置的 subagent provider。实现存在，挂载了
  `ctx.subagents` 时会接线，但当前默认技能→执行器表只把 `chat` 绑到 `session`，
  未知技能也默认 `session`；今天没有公开配置能选中 `subagent`。

出站侧的 `preset` 字段会持久化并显示在面板里，但当前工具是直接调用远端：
背后还没有本地衔接会话的组装。把它当成前瞻性元数据，不是当前生效的路由规则。

## 8. AgentCard

卡片是实例记录 + 对外 base URL + 端点路径的纯函数：身份字段、固定的 DeepSeek
provider、capabilities、文本模式、派生技能，以及一个 JSON-RPC
`supportedInterfaces` 条目。配置 token 时只增加 `bearer` 方案声明，绝不含密钥值。

卡片在实例的 `cardPath` 提供。实例**不使用** `/.well-known/agent-card.json`；
请用面板给出的完整 per-instance URL。精确 JSON 形状见
[协议参考](../reference/http-api.zh.md#27-agentcard)。

## 9. 身份、存储与会话

持久状态在 `a2a` 存储域：

| 表 | 内容 |
|---|---|
| `tasks` | 任务记录，含来源实例 id |
| `contexts` | `contextId` → `sessionId` 绑定 |
| `agents` | 每个出站实例的 agent 记录 |
| `identity` | 旧版服务身份记录 |
| `inbound_servers` | 入站实例记录 |
| `outbound_servers` | 出站实例记录 |

默认后端是 profile 的 JSON 存储；`a2a` 域可以路由到 SQLite。见
[运维指南](operations.zh.md#7-存储)。

入站会话的工作目录在 `$DSH_HOME/a2a-sessions`。任务与实例跨重启保留；
活跃会话与流订阅不保留。

## 10. 安全模型

- **面板 API 仅回环。** `/a2a/api` 只接受 `127.0.0.1`、`::1`、`::ffff:127.0.0.1`；
  其他来源直接 `403`。远端 A2A 客户端能调协议端点，但永远驱动不了控制面板。
- **Bearer Token 是凭据引用，不是域数据。** 面板通过 harness 凭据服务把 token
  写到托管变量名（`A2A_INBOUND_<id>`、`A2A_OUTBOUND_<id>`）；实例记录只存变量名，
  AgentCard 只存方案。
- **分层解析。** 每次操作先读凭据服务，再读进程环境；外部 export 同名变量仍然兼容。
- **入站鉴权。** 配置 token 后，端点要求 `Authorization: Bearer <token>`，
  否则返回 `401` 和 `WWW-Authenticate: Bearer`。流式请求在写 `200` SSE 头之前先鉴权。
- **没有 OAuth、mTLS 或按客户端凭据。** 每个实例一个共享 Bearer Token。
  协议里的 push notification、gRPC、OAuth 能力均未实现。

## 11. 这个插件不是什么

不是模型代理、通用 HTTP 网关，也不会在入站与出站之间自动路由：两个方向需要你显式
连接。它不持久化活跃会话——只有任务和绑定是持久的。

协议与功能限制的完整列表见[协议参考](../reference/http-api.zh.md#4-当前限制)。
