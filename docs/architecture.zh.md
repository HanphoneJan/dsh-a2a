# dsh-a2a 架构

Agent2Agent（A2A）v1.0 双端插件，用于 DeepSeek Harness。

[English](architecture.md) · **中文**

本参考描述已交付的插件。原始设计讨论（中文，v0.2）见 [design.md](design.md)；接线相关的 implemented Agent Note 在 harness checkout 中。

## 总览

插件以一条 Cordis 行（id `a2a`）挂载到任何装有标准宿主服务的 DSH profile 上，由三部分组成：

```
┌─ HTTP 面（profile webServer） ──────────────────────────────────────────┐
│  GET  /.well-known/agent-card.json   → AgentCard（派生 + 实时身份）     │
│  POST /a2a                           → A2A JSON-RPC（SendMessage, …）    │
│  POST /a2a (Accept: text/event-stream) → SSE 任务流                      │
│  GET/POST /a2a/api                   → 仅回环 GUI 面板 API              │
└────────────────────────────────────────────────────────────────────────┘
┌─ Host 半区 ────────────────────────────────────────────────────────────┐
│  入站：TaskStore → a2a/inbound-task 门禁 → ExecutorSet → SSE             │
│        InboundRegistry（对端追踪）+ identity（持久化卡片身份）           │
│  出站：AgentCard 注册表（持久化）→ A2AClient → ctx.tools 工具            │
│  服务：ctx.a2a facade（/a2a 命令与 /a2a/api 共用）                        │
└────────────────────────────────────────────────────────────────────────┘
┌─ 浏览器半区 ───────────────────────────────────────────────────────────┐
│  settings.section "A2A 连接"（React）→ fetch /a2a/api                  │
│  server 开关 · 身份编辑/引导 · agents · 入站对端 · 任务                   │
└────────────────────────────────────────────────────────────────────────┘
```

## 设计决策

已记录决策（设计文档的"定稿决定"，现已交付）：

1. **协议层直接实现** — JSON-RPC/SSE 手写，不依赖官方 A2A JS SDK，保持 conformance 控制权。
2. **包身份** — `@hanphone/dsh-a2a`，经 `dsh plugin add` 安装（npm 或本地 tarball）。
3. **双端 P0** — 入站服务端与出站客户端同等重要。
4. **装完即用** — 安装后两端默认启用；GUI 面板可随时关闭任一端。
5. **GUI 管理** — server 开关、服务身份、出站 agent CRUD、入站对端监控、任务查看/取消全部在设置面板中；改 `cordis.patch.yml` 保留为备用方式。

## 入站半区

### AgentCard 派生与身份

`deriveSkills(tools, { ids, exclude })` 读取实时 `ctx.tools` 注册表：

- 每个配置的 `ids` 必须能解析到已注册工具——缺失引用大声失败并列出全部缺失 id；
- 内置 `chat` 技能始终存在；
- `exclude` 在派生后去除 id（纵深防御）。

卡片**身份**（name/description/version）在有持久化 `identity` 记录时来自 `a2a` 域的该记录，否则来自组合默认值。从面板编辑身份会重建卡片（保留端点 URL 与安全方案）并经 `A2AServer.setCard` 换到 server 上；routes 每次请求重读 `server.card`，因此变更即时可见。身份跨重启持久化（域存储）。

### 任务生命周期

```
POST /a2a (SendMessage)
  → parseRpc（JSON-RPC 2.0、A2A-Version、鉴权）
  → server.ensureTask(message)
      contextId + skill（metadata.skill ?? 'chat'）
      → store.create → taskId a2a-<uuid>、SUBMITTED（急切持久化）
  → gate(input)
      技能白名单
      ctx.waterfall('a2a/inbound-task', decision)   # 否决/审计
  → runTask(record)
      WORKING → executor.execute(...)               # 事件 → store + SSE
      成功 → artifact 'result' → COMPLETED
      失败 → FAILED（携带执行器错误）
  → 取消路径：CancelTask / facade → abort signal → CANCELED
```

SubscribeToTask / SendStreamingMessage 在订阅时补发当前状态帧，然后流式推送更新与终态任务。

### 入站连接监控

`InboundRegistry`（内存）由 server 的 `onInbound` 钩子在每次 JSON-RPC 请求 / SSE 打开时喂入，按 socket 来源地址归组。每个对端记录首/末次活动、任务数、活跃任务 id、流式状态；任务落定后离开活跃集。`closePeer(id)` 经 facade 取消该对端的活跃任务并删除记录。面板列出这些对端并提供关闭控制；注册表为进程内（对端记录按设计属于活跃连接的瞬时描述）。

### 执行器

```ts
interface A2aExecutor {
  execute(task, opts: { signal, onEvent }): Promise<{ parts: Part[] }>
}
```

- **session** — 每个 `contextId` 一个 DSH 会话；结果 = 落定回复。
- **subagent** — 委托 `ctx.subagents`，把工具调用过程以 `artifact` 事件流式回传；结果 = 最终消息 + 步骤列表 artifact。

`config.server.executors: { <skillId>: 'session' | 'subagent' }`，默认 `session`。没有 agent 循环时 server 仍以可读拒绝应答。

### 任务存储

任务存于 `a2a` 存储域（`DomainFacility.open` → `Domain` → 类型化 `KvTable`），JSON 编码记录，表 `tasks`、`contexts`、`agents`、`identity`。写入走域写链；`DomainTaskStore` 自持写链可见的活跃视图，使同步读能看到自身写入。

## 出站半区

### 注册表

`agents` 表持久化 `OutboundAgentRecord`。启动时 `loadAll()` 恢复并连接每个启用 agent；声明的 `config.client.agents` 只 seed store 中缺失的名字（持久化记录保持运行时状态——禁用不重连、删除不复活）。

### 工具

每个已连接 agent 的每个技能经 `registerAgentTools` 映射为模型工具 `a2a__<name>__<skill>`（规范化、冲突哈希）。执行工具会以稳定 per-caller contextId 运行 `A2AClient.sendMessage` 并返回落定任务文本；`FAILED` 抛可读 `A2AError`，`INPUT_REQUIRED`/`AUTH_REQUIRED` 以文本呈现。

## GUI 面板

- **浏览器半区**（`src/client/`）— React 插件，经 `ctx.slots.inject` 注册为 `settings.section`（"A2A 连接"；插槽由 `ui-settings-general` 运行时声明），由 DSH web shell 经 `window.__ModuleLoader__` 加载（`lib/client.js`，external 来自浏览器模块表）。
- **回环 API**（`/a2a/api`）— GET 返回快照（server 状态、身份、任务、agents、入站对端）；POST 派发控制动作（server.enable/disable、identity.update、agent add/remove/enable/disable/refresh、inbound.close、task.cancel）。非回环调用 403。两边共用同一 `ctx.a2a` facade，GUI 与 `/a2a` 命令不可能分歧。

## 安全模型

- 入站 Bearer token 是**环境变量名**（`authTokenEnv`），启动时解析；绝不落配置明文。
- GUI 面板 API 仅**回环**；远程对端无法驱动。
- AgentCard 只声明安全方案，绝不暴露 token 值。

## 存储后端说明

默认组合把 `a2a` 域路由到 JSON 后端。设计中的 SQLite 要求可在同一 patch 层把域路由到 `storage-sqlite`。完整的 REAL 组合启动（SQLite + LLM 支撑 agent 循环经 loader-smoke）仍为 P1。

## 独立项目

该包刻意**不是** harness checkout 的 workspace 成员：自带 `package.json` 与依赖图，`@deepseek-ai/*` 为 peer 依赖，`zod` 为唯一自有运行时依赖。它通过项目引用消费 harness 源码图的已构建 `lib/types` 声明做类型检查；全新 checkout 需先构建宿主聚合。

## P1 / 明确不做

- push notifications；
- `INPUT_REQUIRED` ↔ 审批流；
- 被动出站结果注入；
- OAuth 2.0 / 每客户端凭据、gRPC 绑定；
- 互操作 conformance 套件；
- 入站对端历史持久化（对端按设计是活跃连接的瞬时记录）。

## 测试

- `tests/unit/` — 协议常量、JSON-RPC/SSE 帧、卡片派生与身份重建、store（含写链可见性回归）、执行器解析、A2A server（dispatch、gate、auth、cancel、streaming）、入站注册表、出站 client 与注册表（stub fetch）、面板 API。
- `tests/composition/` — 在真实 Cordis `Context` 上以 stub 宿主服务跑 `apply()`：组装、路由注册、技能门禁、`a2a/inbound-task` 否决、任务持久化、出站工具注册。