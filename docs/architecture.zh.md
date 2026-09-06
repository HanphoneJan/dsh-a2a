# dsh-a2a 架构

Agent2Agent（A2A）v1.0.1 双端插件，用于 DeepSeek Harness。

[English](architecture.md) · **中文**

本参考描述已交付的插件。设计讨论（中文，v1.0 多实例）见 [design.md](design.md)；接线相关的 implemented Agent Note 在 harness checkout 中。

## 总览

插件以一条 Cordis 行（id `a2a`）挂载到任何装有标准宿主服务的 DSH profile 上。核心抽象是**server 实例**：一套可复用的框架——端点 + 身份/技能宣告 + preset 绑定 + 鉴权——入站方向每实例一份、出站连接每份一份。

```
┌─ GUI（浏览器, settings.section "A2A 连接"） ─────────────────────────────┐
│  入站 server 实例（创建/preset/技能/鉴权/启停/编辑）                       │
│  出站 server 实例（创建/URL/preset/鉴权/超时/启停）                       │
│  任务（按实例查看/取消）· 入站对端监控                                    │
└───────────────────────────────────────┬─────────────────────────────────┘
                                        │ loopback-only /a2a/api
┌─ Host 半区 ───────────────────────────▼─────────────────────────────────┐
│  InboundServerManager    每实例：preset 化会话池 + A2AServer +           │
│                            A2aRoutes（独立端点 + 卡片路由）              │
│  OutboundServerManager   每实例：OutboundAgentRegistry（独立 agent 存储）│
│                            + 远端 A2AClient + 工具                       │
│  A2aDomain（tasks/contexts/agents/identity/inbound_servers/             │
│            outbound_servers）· ctx.a2a facade                           │
└─────────────────────────────────────────────────────────────────────────┘
```

## 设计决策

1. **协议层直接实现** — JSON-RPC/SSE 手写，对齐官方 A2A v1.0.1 规范（以 `.research/A2A` 为权威）：PascalCase 方法（`SendMessage` 等）、`TASK_STATE_*` / `ROLE_*` 枚举、完整 `AgentCard` 结构（`supportedInterfaces`、`capabilities`、`securitySchemes`、`skills`）、规范错误码表。
2. **包身份** — `@hanphone/dsh-a2a`，经 `dsh plugin add` 安装（npm 或本地 tarball）。
3. **多实例、GUI 管理（v1.0）** — 实例在设置面板创建、编辑、启停，持久化于 `a2a` 域而非插件配置。插件 `Config` 只承载宿主级默认值（`baseUrl`、`subagentProvider`、`defaultTimeoutMs`）。
4. **preset 绑定实例（语义已确认）** — 入站实例的 preset 组装执行其任务的每个会话；出站实例的 preset 命名与远端对话时 DSH 给本地衔接会话的组合（P0 运行时衔接为文档化扩展点；该值是持久化元数据并展示在 GUI）。
5. **技能宣告取代工具白名单（已确认）** — AgentCard 技能即创建者声明；创建留空默认取所绑 preset 展示名（否则内置 `chat`）。v0.2 `deriveSkills` 机制删除。
6. **旧配置直接删除不迁移（已确认）** — `server.enabled` / `client.agents` 等不再被读取。

## 协议面

已实现方法：`SendMessage`（含 `return_immediately` / `history_length` / `accepted_output_modes`）、`SendStreamingMessage`（SSE）、`GetTask`（含 `historyLength`）、`ListTasks`（含 `contextId` / `status` / `pageSize` / `pageToken`）、`CancelTask`、`SubscribeToTask`（SSE；终态任务按规范应答）、`GetExtendedAgentCard`。Push 通知方法在方法面声明并按 `PushNotificationNotSupported` 应答。序列化按 ADR-001 ProtoJSON（`TASK_STATE_*` / `ROLE_USER` / `ROLE_AGENT`，camelCase 字段）；传输校验 `A2A-Version` 头；错误使用规范错误码表。

## 入站半区

### InboundServerManager

`InboundServerManager` 拥有活跃实例集。每个持久化 `InboundServerRecord`（`inbound_servers` 表）在启动时成为一个活实例：

- preset 化 `ContextSessionPool`（装有 `agents` 时）——会话按 `record.preset` 经 `agentPresets.resolve` + `mount` 组装，否则用部署默认；
- 共享 `TaskStore` 上的 `A2AServer`，带独立端点（`/a2a/<id>`）与卡片路由（`/a2a/<id>/agent-card.json`）；
- `A2aRoutes` 注册（启停）、`ExecutorSet`（session/subagent）、`LiveInboundRegistry`（对端监控）。

管理器拥有完整生命周期：`add`（持久化 + 组装 + 启用）、`update`（持久化 + 重建卡片 + 换装）、`setEnabled`（路由启停）、`remove`（dispose + 反持久化）。技能默认值（`defaultSkillFor`）在创建时应用：声明技能原样，否则 preset 展示名，否则 `chat`。

### 任务生命周期

```
POST /a2a/<id> (SendMessage)
  → parseRpc（JSON-RPC 2.0、A2A-Version、按实例鉴权）
  → server.ensureTask(message)
      contextId + skill（metadata.skill ?? 'chat'）；任务记录来源 serverId
      → store.create → taskId a2a-<uuid>、SUBMITTED（急切持久化）
  → gate(input)
      按实例的宣告技能白名单
      ctx.waterfall('a2a/inbound-task', decision)   # 否决/审计
  → runTask(record)
      WORKING → executor.execute(...)               # 事件 → store + SSE
      成功 → artifact 'result' → COMPLETED
      失败 → FAILED（携带执行器错误）
  → 取消路径：CancelTask / facade → abort signal → CANCELED
```

SubscribeToTask / SendStreamingMessage 在订阅时补发当前状态帧，然后流式推送更新与终态任务。

### 执行器

- **session** — 每个 `contextId` 一个 DSH 会话，按实例 preset 组装；结果 = 落定回复。
- **subagent** — 委托 `ctx.subagents`，工具调用过程以 `artifact` 事件流式回传。没有 agent 循环时 server 仍以可读拒绝应答。

### 任务存储与域

任务与绑定存于 `a2a` 存储域（`DomainFacility.open` → `Domain` → 类型化 `KvTable`），JSON 编码记录。表：`tasks`（每条记录带可选来源实例 `serverId`）、`contexts`、`agents`（按实例的出站 agent 记录）、`identity`、`inbound_servers`、`outbound_servers`。`DomainTaskStore` 自持写链可见的活跃视图，使同步读能看到自身写入。

## 出站半区

### OutboundServerManager

`OutboundServerManager` 拥有活跃连接集。每个持久化 `OutboundServerRecord`（`outbound_servers` 表）在启动时成为一个 `OutboundAgentRegistry`，带独立按实例 `AgentStore`（`agents` 表，键 `out:<id>`）。管理器拥有完整生命周期：`add`（持久化 + 连接）、`setEnabled`、`refresh`、`remove`（dispose + 反持久化）；`viewFor` 折合注册表视图与记录（GUI 读 `OutboundServerView`，含 `preset`）。

### 工具

每个已连接实例的每个技能经 `registerAgentTools` 映射为模型工具 `a2a__<name>__<skill>`（规范化、冲突哈希）。执行工具以稳定 per-caller contextId 运行 `A2AClient.sendMessage` 并返回落定任务文本。P0 出站工具直接调用远端；preset 化本地衔接会话组装为文档化扩展点。

## GUI 面板

- **浏览器半区**（`src/client/`）— React 插件，经 `ctx.slots.inject` 注册为 `settings.section`（"A2A 连接"），由 DSH web shell 加载其客户端 bundle。渲染入站/出站 server 列表（含 preset 选择器、技能宣告表单、鉴权 env 输入）与任务/对端视图。
- **回环 API**（`/a2a/api`）— GET 返回快照（入站/出站 server 视图、任务、对端）；`GET /a2a/api/presets` 返回 agent-preset 名单供选择器使用；POST 派发控制动作（inbound.create/update/remove/enable/disable、outbound.create/remove/enable/disable/refresh、task.cancel、inbound.close）。非回环调用 403。GUI、`/a2a` 命令与 `ctx.a2a` 消费方共用同一 facade 实现。

## 安全模型

- 每个入站实例的 Bearer token 是**环境变量名**（`authTokenEnv`），启动时解析；绝不落配置明文。
- GUI 面板 API 仅**回环**；远程对端无法驱动。
- AgentCard 只声明安全方案，绝不暴露 token 值。

## 存储后端说明

默认组合把 `a2a` 域路由到 JSON 后端。可在同一 patch 层把域路由到 `storage-sqlite` 以启用 SQLite。

## 独立项目

该包刻意**不是** harness checkout 的 workspace 成员：自带 `package.json` 与依赖图，`@deepseek-ai/*` 为 peer 依赖，`zod` 为唯一自有运行时依赖。它通过项目引用消费 harness 源码图的已构建 `lib/types` 声明做类型检查；全新 checkout 需先构建宿主聚合。

## P1 / 明确不做

- push notifications（仅方法面声明）；
- 出站 preset 衔接会话组装接缝（P0 时 preset 为持久化元数据）；
- OAuth 2.0 / 每客户端凭据、gRPC 绑定；
- 互操作 conformance 套件（以规范审计 + 交叉测试替代）；
- 入站对端历史持久化（对端按设计是活跃连接的瞬时记录）。

## 测试

- `tests/unit/` — 协议常量、JSON-RPC/SSE 帧、卡片组装与技能默认值、store（含写链可见性回归）、执行器解析、A2A server（dispatch、gate、auth、cancel、streaming）、入站注册表、出站 client 与注册表（stub fetch）、面板 API。
- `tests/composition/` — 在真实 Cordis `Context` 上以 stub 宿主服务跑 `apply()`：多实例组装、按实例路由注册、宣告技能门禁、`a2a/inbound-task` 否决、任务持久化、出站工具注册、实例 CRUD/删除。