---
name: 核心概念
description: A2A 模型、入站 server、出站连接、preset、技能、任务、上下文、执行器与 AgentCard
update-time: 2026-10-25
---

# 核心概念

[English](concepts.md) · **中文**

本页定义手册使用的术语。精确字段见 [HTTP API 参考](../reference/http-api.zh.md)，
运维配置见[运维指南](operations.zh.md)。

## 一句话理解 A2A

Agent2Agent（A2A）是让一个 agent 通过 HTTP + JSON-RPC 调用另一个 agent 的协议。
**server** 发布 AgentCard，描述身份、端点与技能；**client** 读取卡片，向端点发消息，
等待任务落定或订阅更新。本插件实现 A2A `1.0.1` 的 JSON-RPC 绑定，声明协议版本
`1.0`；不实现 gRPC 与 HTTP+JSON 绑定。

## 两个方向

| 方向 | 谁调用谁 | 插件面 |
|---|---|---|
| **入站** | 远端 A2A 客户端调用这个 DSH | 每个被发布的 agent 一个**入站 server** |
| **出站** | 这个 DSH 调用远端 A2A agent | 每张远端卡片一个**出站连接** |

两个方向互相独立。一个 profile 可以有任意多个入站与出站，也可以指向其他 DSH 实例
或非 DSH 的 A2A agent。

## 入站 server

一个入站 server 实例就是一个被发布的 agent，拥有：

- **端点** `/a2a/<id>`；
- **AgentCard** `/a2a/<id>/agent-card.json`；
- 卡片上的**名称**、描述与版本；
- 一个 **agent preset**，决定该端点背后每个 DSH 会话如何组装；
- 从该 preset 派生的**技能**；
- 可选的 **Bearer Token**；
- **启用**标志，决定路由是否注册。

实例在面板或 `/a2a` 命令里创建、编辑、启停、删除，并且持久化。重启后会重新组装，
并重新注册已启用的实例。

## 出站连接

一个出站连接就是“这个 DSH 可以调用的一个远端 agent”，拥有：

- 远端 **AgentCard URL**；
- 本地**名称**，会成为工具名的一段；
- 导入的**技能**，每个注册成一个模型工具；
- 可选 **Bearer Token**；
- 调用该远端的**超时**；
- 可选 **preset**（记录用元数据，见下）；
- **启用**标志。

连接时读取卡片、导入技能，并为每个启用的技能注册一个工具。连接失败会保留在面板里，
显示 `lastError`，可以刷新或编辑。

出站 `preset` 会持久化并显示在面板里，但当前工具直接调用远端：还没有从它组装本地
衔接会话。

## Preset 与技能

**Preset** 是 DSH 的 agent 预设：命名的一套指令、工具、技能与模型默认值组合。
入站实例绑定一个 preset，并为每个 A2A 上下文用它组装一个新的 DSH 会话。

**技能是派生的，不是手写的。** 创建、更新与启动时，插件：

1. 解析 preset 及其 standing scope key（`agentPresets.standingKeyFor`）；
2. 列出该 preset 可见的技能（`ctx.skills.list({ scope })`）；
3. 把 `invocation.modelInvocable` 不为 `false` 的条目宣告到 AgentCard。

preset 或 skills 服务不可用，或目录为空时，卡片回退到内置的单个 `chat` 技能。
请求省略 `message.metadata.skill` 时也默认路由到 `chat`。请求的技能不在宣告集合内，
会在执行前被门禁拒绝。

同一个门禁还会把每个入站任务交给 `a2a/inbound-task` waterfall，策略插件可以在那里
否决任务。

## 任务与上下文

入站 `SendMessage` 会创建一个**任务**：

- 任务 id 为 `a2a-<uuid>`；
- 上下文 id 由调用方提供或自动生成；
- 任务记录技能、输入 parts、状态、artifacts、时间戳，以及接收它的入站实例。

状态使用 A2A 词汇（`TASK_STATE_*`）；完整状态表（含哪些是终态）见
[协议参考](../reference/http-api.zh.md#25-任务状态)。

**上下文**是一条对话。插件为每个 `(实例, contextId)` 保留一个活跃 DSH 会话，id 固定为
`a2a-<实例 id>-<contextId>`。在同一实例上复用 `contextId` 会复用该会话；不同上下文
或不同入站实例会打开不同会话。

会话句柄只在内存里。面板的**关闭**会取消该上下文的活跃任务并释放活跃句柄；
同一上下文的下一个任务会重新打开一个新句柄。任务与 context→session 绑定会持久化，
所以重启保留任务历史，但不会复活会话。

## 执行器

入站侧有一层执行器接缝，两个实现：

- **session**——在上下文的 DSH 会话上跑一轮，返回最后一条 assistant 文本。
  这是所有技能的默认路径。
- **subagent**——把任务委托给 `ctx.subagents`。只有挂载 `agents` 与
  `ctx.subagents` 时才会接线，但当前技能→执行器表只把 `chat` 绑到 `session`，
  未知技能也默认 `session`；今天没有公开配置能选中 `subagent`。

## AgentCard

卡片是实例记录、对外 base URL 与端点路径的纯函数：身份字段、固定的 DeepSeek
provider、capabilities、输入/输出模式、派生技能，以及一个 JSON-RPC
`supportedInterfaces` 条目。配置 token 时只增加 `bearer` 方案声明，绝不含密钥值。

卡片在实例的 `cardPath` 提供。实例**不使用** `/.well-known/agent-card.json`；
请用面板给出的完整 per-instance URL。精确 JSON 形状见
[协议参考](../reference/http-api.zh.md#27-agentcard)。

## 信任边界

面板控制面仅回环；协议端点使用每实例 Bearer Token，token 以凭据引用形式保存。见
[运维指南：访问与安全](operations.zh.md#访问与安全)。

## 没有实现什么

只提供 JSON-RPC 绑定；push notification、OAuth、mTLS 与按客户端凭据都没有实现。
完整清单见 [HTTP API：当前限制](../reference/http-api.zh.md#4-当前限制)。
