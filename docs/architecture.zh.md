---
name: 架构
description: Cordis 插件、入站与出站 manager、任务存储、会话层与浏览器半区如何组成
update-time: 2026-10-25
---

# 架构

[English](architecture.md) · **中文**

本页说明已交付代码的组织：一条插件行、两个 manager、一个存储域和浏览器半区。
术语见[核心概念](guide/concepts.zh.md)，线上细节见
[HTTP API 参考](reference/http-api.zh.md)。

## 总览

插件以一条 Cordis 行（id `a2a`）挂载到任何装有标准宿主服务的 DSH profile 上。
核心抽象是 **server 实例**：一套可复用的框架——端点 + 身份/技能宣告 + preset
绑定 + 鉴权——入站方向每实例一份、出站连接每份一份。

```
┌─ GUI（浏览器, settings.section "A2A 连接"） ─────────────────────────────┐
│  入站实例（创建/preset/技能/鉴权/启停/编辑）                              │
│  出站实例（创建/URL/preset/鉴权/超时/启停）                               │
│  指标 · 对端 · 会话 · 任务（查看/取消）                                   │
└───────────────────────────────────────┬─────────────────────────────────┘
                                        │ 仅回环 /a2a/api
┌─ Host 半区 ───────────────────────────▼─────────────────────────────────┐
│  InboundServerManager    每实例：preset 化会话池 + A2AServer +           │
│                            A2aRoutes（独立端点 + 卡片路由）              │
│  OutboundServerManager   每实例：OutboundAgentRegistry（独立 agent 存储）│
│                            + 远端 A2AClient + 工具                       │
│  A2aDomain（tasks/contexts/agents/inbound_servers/outbound_servers）     │
│  A2aMetrics · ctx.a2a facade · /a2a 命令                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

插件只注入 `storageDomain`。其他宿主服务都是探测式可选；缺少某个只会让对应能力空闲，
不会让插件挂掉。逐服务影响见[运维指南：宿主服务](guide/operations.zh.md#宿主服务)。

## 模块地图

| 路径 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：`Config`、服务探测、manager 组装、面板路由、卸载 |
| `src/service.ts` | `ctx.a2a` facade，命令、面板和其他插件共用 |
| `src/api.ts` | 仅回环 `/a2a/api` 的快照、读取与控制动作 |
| `src/commands.ts` | `/a2a` 聊天命令 |
| `src/protocol.ts` | A2A 类型、方法、任务状态、错误码、ProtoJSON 辅助 |
| `src/jsonrpc.ts` | JSON-RPC 帧与解析辅助 |
| `src/update.ts` | 版本读取与 npm/GitHub 更新检查 |
| `src/servers/inbound-manager.ts` | 入站实例生命周期、技能派生、作用域存储 |
| `src/servers/outbound-manager.ts` | 出站实例生命周期、自动刷新、每实例 registry |
| `src/server/a2a-server.ts` | JSON-RPC 分发、任务生命周期、SSE、限流、鉴权检查 |
| `src/server/routes.ts` | HTTP 绑定：卡片与端点路由、请求体上限、启停 |
| `src/server/card.ts` | 纯函数式 AgentCard 组装 |
| `src/server/store.ts` | `a2a` 域定义、`DomainTaskStore`、`MemoryTaskStore`、`ScopedTaskStore` |
| `src/server/exec/` | 会话池、session/subagent 执行器、附件准入 |
| `src/server/executor.ts` | 执行器契约与技能→执行器解析 |
| `src/server/session-registry.ts` | 按上下文的会话视图与 SSE 流计数 |
| `src/server/inbound-registry.ts` | 活跃入站对端注册表 |
| `src/server/metrics.ts` | 计数器与有界审计环 |
| `src/outbound/calls.ts` | A2A 客户端：卡片发现、发送/轮询/流式、取消、重试 |
| `src/outbound/registry.ts` | 已连接 agent、每实例视图、工具 disposer |
| `src/outbound/tools.ts` | 远端技能对应的模型工具 |
| `src/client/` | React 设置页、样式、更新状态格式化 |

## 插件形态

`apply()` 打开 `a2a` 域，构建两个 manager，注册 facade、可选的 `/a2a` 命令和
面板路由，并返回会拆除所有实例的 disposer。`Config` 只承载宿主级默认值；实例经
facade 创建并持久化在域里。

该包刻意**不是** harness checkout 的 workspace 成员：自带 `package.json`，
`@deepseek-ai/*` 为 peer 依赖，`zod` 是唯一自有运行时依赖；它通过项目引用消费
harness 源码图的已构建 `lib/types` 声明来做类型检查。构建产出宿主的
`lib/index.js` 与浏览器的 `lib/client.js`；浏览器 bundle 由
`scripts/build-client.mjs` 包装成 `window.__ModuleLoader__.load` 契约。

## 入站半区

### Manager 与实例

`InboundServerManager` 拥有活跃实例集。每个持久化 `InboundServerRecord`
（`inbound_servers` 表）在启动时成为一个活实例：

- 挂载 `agents` 时的 `ContextSessionPool`，按有效 preset（`record.preset` 或部署
  默认）组装；
- 该实例 `ScopedTaskStore` 之上的 `A2AServer`，带自己的端点路径与卡片路径；
- `A2aRoutes` 注册、`ExecutorSet`、`LiveInboundRegistry` 与
  `ContextSessionRegistry`。

管理器拥有 `add`、`update`、`setEnabled`、`setAuth`、`remove`。`add` 派生技能、
解析 token、组装、持久化并启用；`update` 持久化 patch、重新派生技能与鉴权，然后在
保留路由状态的前提下换装活实例；`setEnabled` 注册或注销路由并持久化启用标志；
`remove` dispose 并写入空 tombstone。

### 技能与门禁

技能在添加、更新和启动时派生：preset 的 standing scope key
（`agentPresets.standingKeyFor`）加 `ctx.skills.list({ scope })`，筛选
`invocation.modelInvocable !== false`。服务缺失、挂载失败或目录为空时回退到内置
`chat`。

实例门禁先检查请求的技能在派生集合内，再把 `a2a/inbound-task` 作为 waterfall
分发。监听者可以设置 `rejected.reason` 否决任务；门禁同时记录日志。

### 请求管线

```
POST /a2a/<id> (SendMessage)
  → routes：请求体上限，然后 A2AServer.preflight（限流、Bearer 鉴权）
  → A2A-Version 检查
  → parseRpc（JSON-RPC 2.0）
  → gate（宣告技能 + a2a/inbound-task）
  → ensureTask
      contextId + skill（metadata.skill ?? 'chat'）
      messageId 重放 → 返回原任务
      taskId 续接 → 在非终态且空闲的任务上替换 parts
      否则 store.create → taskId a2a-<uuid>、SUBMITTED
  → runTask
      WORKING → executor.execute → 事件写入 store 与 SSE
      成功 → COMPLETED 带 'result' artifact；失败 → FAILED
      INPUT_REQUIRED / AUTH_REQUIRED 让任务保持中断
  → 取消：CancelTask 或 facade abort → CANCELED
```

任务访问按 `serverId` 限定：别的实例的任务与不存在的任务无法区分。上下文绑定带实例
id 命名空间，因此两个实例可以复用同一个客户端 `contextId` 而不共享会话。

服务端还执行配置的每任务超时与每实例并发上限。超时把任务落为 `FAILED`；超配额任务
以可读消息失败。限流按来源地址、在进程内执行。

### 会话层

每个 `(实例, contextId)` 保留一个 DSH 会话，id 固定为
`a2a-<实例 id>-<contextId>`。会话池经 `agents` 创建会话并挂载 preset；若该会话 id
已存在则恢复。同一上下文的多轮是串行的。

某上下文的会话首次打开时，会话池经任务存储持久化 `contextId → sessionId` 绑定。
持久化失败只记日志，绝不让任务失败。

`SessionView` 行按 `(serverId, contextId)` 聚合。任务计数、running/idle 与时间戳来自
持久任务存储；流式来自每实例的 SSE 计数；`live` 来自会话池句柄。因此重启后行以降级
形态保留，没有 agent 循环时也能渲染。`closeSession` 中止该上下文的非终态任务并释放
句柄；下一个任务会重新打开。关闭不是墓碑。

每个 A2A server 给自己创建的任务盖上实例 id，会话与任务视图因此能把一行归到某个
入站实例。

## 存储

`openDomain` 在路由后的存储后端上打开 `a2a` 域（`tasks`、`contexts`、`agents`、
`inbound_servers`、`outbound_servers`）。记录是 JSON 字符串；域的 `version` 守护
格式变化。

`DomainTaskStore` 在域之上保留活跃内存视图，让同步读在排队中的域写入落盘前就能看到
自己的写入。`ScopedTaskStore` 追加每实例过滤，并给上下文绑定加命名空间。后端选择与
运维注意见[运维指南：存储](guide/operations.zh.md#存储)。

## 出站半区

`OutboundServerManager` 为每个持久化 `OutboundServerRecord`
（`outbound_servers` 表）拥有一个 `OutboundAgentRegistry`。每个 registry 在
`agents` 表上有自己的 agent 存储（键 `out:<id>`）和自己的工具 disposer。

生命周期：`add` 持久化记录后连接；`setEnabled` 切换活跃连接的工具并持久化标志；
`refresh` 重读卡片；`update` 持久化 patch 并重建连接；`setAuth` 写入或清除凭据并
重建；`remove` dispose 并反持久化。启用的实例按配置间隔刷新卡片。

每个启用的技能由 `registerAgentTools` 注册为一个模型工具。工具用稳定的 per-caller
上下文 id 发消息；远端卡片宣告流式时走流式；传播调用方 abort（任务 id 已知后发
`CancelTask`）；对瞬时传输/5xx 失败重试。连接失败会以 `failed` 与 `lastError`
保留在视图里，可编辑或刷新。

## 浏览器半区

`src/client/` 经 `ctx.slots.inject` 注册一个 `settings.section`（`A2A 连接`），由
DSH web shell 加载。它只是 `/a2a/api` 的读写客户端：不含协议知识，也从不直接访问
A2A 端点。宿主喂给它实例、任务、对端、会话、preset、指标与更新结果的快照。样式基于
宿主 `--dsw-alias-*` token，写在 `dashboard.css.ts`。

GUI、`/a2a` 命令与 `ctx.a2a` 消费方都调用同一个 facade 实现，所以状态不会互相矛盾。
面板每 3 秒轮询快照；版本条只问一次，并把更新结果缓存 6 小时。

## 信任边界

面板控制面仅回环；协议端点使用每实例 Bearer Token，token 保存在凭据层。完整访问
模型见[运维指南：访问与安全](guide/operations.zh.md#访问与安全)。
