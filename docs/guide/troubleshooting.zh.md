---
name: 排障
description: 空回复、401、卡片不可达、出站连接失败、工具缺失、版本预检与存储冲突的排查
create-time: 2026-10-19
update-time: 2026-10-19
version: v0.3.7
relative-docs:
  - docs/guide/getting-started.zh.md
  - docs/reference/http-api.zh.md
  - docs/testing.zh.md
---

# 排障

[English](troubleshooting.md) · **中文**

按这个顺序排查，每一步都缩小一层：

1. **插件挂载了吗？** `/a2a status` 能返回快照。
2. **实例存在且启用吗？** `/a2a inbound list` / `outbound list`。
3. **卡片可达吗？** `curl <cardUrl>`。
4. **协议端点可达吗？** 用一个极短 prompt 发 `SendMessage`。
5. **任务状态是什么？** `/a2a tasks`、`/a2a task get <id>`。
6. **宿主日志与会话日志？** DSH 日志与 `$DSH_HOME/sessions`。
7. **版本与兼容性？** 见 §7。

## 1. `(no reply)` 或空 artifact

任务 `COMPLETED` 但 artifact 是 `(no reply)`，表示入站 session 执行器结束时没有 assistant 消息。
`0.3.6` 里这是已知 bug：执行器交给 agent 的消息 source 是
`{ kind: 'plugin', plugin: 'a2a' }`。JSONL v4 session codec 拒绝 `kind: 'plugin'`；
写入在 session handle 的后台 flush 中失败，agent loop 吞掉错误，任务以 `COMPLETED` 落定但没有回复。
**`0.3.7` 已修复**，改用生产者自己的 `{ kind: 'a2a' }`。

如果 `0.3.7` 仍然空回复：

1. 确认已安装版本：
   ```sh
   node -p "require('/path/to/profile/node_modules/@hanphone/dsh-a2a/package.json').version"
   ```
   必须是 `0.3.7` 或更新。不是的话重装并重启 `dsh web`。
2. 看任务状态与状态消息：
   ```text
   /a2a task get <taskId>
   ```
   `TASK_STATE_FAILED` 会带错误消息；`COMPLETED` 但 artifact 为空，问题更可能在模型/会话层。
3. 面板 **连接与任务 → 入站会话**，找到对应 `contextId`，看是运行中还是空闲。
4. 检查 preset 的模型 provider：未认证或配错的 provider 可能产生空的 assistant 消息。
   用同一个 preset 在普通 DSH 会话里试一下。
5. 查 DSH 宿主日志里的 `a2a` 警告，以及 `$DSH_HOME/sessions/...` 下
   `a2a-<contextId>` 的会话日志。

如果任务是 `CANCELED`，说明调用方或面板取消了它；在同一 `contextId` 上发新任务即可重开会话。

## 2. 入站请求返回 401

实例配置了 Bearer Token，而请求不匹配。

- 请求带上 `Authorization: Bearer <token>`。
- Token 每次请求先读凭据服务，再读进程环境。检查托管变量名：
  - 入站：`A2A_INBOUND_<ID>`（大写，非字母数字替换为 `_`）；
  - 出站：`A2A_OUTBOUND_<ID>`。
- 面板的入站卡片显示是否已配置鉴权。用 **编辑** 设置新 token，或用 **清除鉴权** 移除。
- 流式请求在写 `200` 之前鉴权；`401` 是干净状态，不是坏掉的流。

## 3. AgentCard 404 或 connection refused

- 实例可能被**停用**：`/a2a inbound list` 与面板显示启用状态。启用后重试。
- 用面板给出的**per-instance** 卡片路径（`/a2a/<id>/agent-card.json`）。
  实例不使用 `/.well-known/agent-card.json`。
- 确认 web server 正在你调用的地址上监听：
  ```sh
  curl -v http://127.0.0.1:3080/a2a/<id>/agent-card.json
  ```
- 如果卡片 URL 走公网/反向代理，确认代理转发了 `/a2a/` 前缀，并保留了 web app 期望的
  `Host` 头。

## 4. 出站连接是 `failed`

面板会显示 `lastError`，常见原因：

| 症状 | 检查 |
|---|---|
| `HTTP 401` | 远端要求 token；编辑连接并设置 |
| `HTTP 404` | 卡片 URL 错了；用远端完整的 per-instance 卡片路径 |
| `invalid agent card` | URL 返回 HTML 或非卡片 JSON；确认 content-type 和形状 |
| `no JSON-RPC interface` | 卡片没有带 JSON-RPC URL 的 `supportedInterfaces` 条目 |
| timeout | 调大连接的 `timeoutMs`，或检查网络可达性 |
| TLS/DNS 错误 | 检查远端证书/主机名与本地网络 |

修好后点 **刷新**（或调 `outbound.refresh`）。失败记录会保留，直接编辑即可，不必删除重建。

## 5. 远端技能缺失或模型不调用工具

- 确认连接是 `connected`，且 `skillCount > 0`、`toolCount > 0`。
  卡片没有技能就注册零个工具，这是设计行为。
- 工具名是 `a2a__<连接名>__<技能 id>`，规范化为 `[A-Za-z0-9_-]`，截断到 64 字符。
  远端名称含空格或标点时，检查模型工具列表里的实际名称，或让模型列出工具。
- 工具参数是 `{ "prompt": "..." }`，不是裸字符串。
- 工具调用失败时读返回错误：`FAILED` 远端任务会抛带远端消息的工具错误；
  `INPUT_REQUIRED` / `AUTH_REQUIRED` 以文本返回。
- 重命名连接会改变工具前缀。改名后刷新/重新编辑。

## 6. 工具调用返回远端错误

远端 agent 的任务落到了非终态或失败。用远端自己的 `GetTask`/面板查看，或读工具错误文本：

- `(remote agent returned no output)`——远端完成但没有 artifact。
- `Remote agent task failed: ...`——远端报告 `TASK_STATE_FAILED`。
- `[remote agent INPUT_REQUIRED] ...`——远端需要更多输入；发后续 prompt。
- `[remote agent AUTH_REQUIRED] ...`——远端需要认证；更新连接 token。

## 7. `incompatible-version` 或插件没加载

DSH 0.1.7+ 在导入插件前会评估 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer 范围。
拒绝表示运行时 harness 超出声明范围。

- 升级插件和/或 harness 到受支持的组合。
- 在 `package.json` 查看精确范围，在
  [Harness 兼容性](../harness-compatibility.zh.md) 查看验证记录。
- `dsh plugin allow-version ... --accept-risk` 是精确版本的应急豁免，不是测试的替代品。
- 不要在没有跑兼容性流程（typecheck、tests、build、e2e）的情况下放宽 peer 范围。

## 8. 两个 DSH 进程抢同一份存储

`a2a` 域是挂在 `DSH_HOME` 下的单一存储（默认 JSON）。两个进程共享同一个 home 会写同一个域，
可能互相覆盖实例/任务。一个 `DSH_HOME` 只跑一个写者；双实例测试请用独立 home 与端口。
hermetic e2e 就是这么做的。

## 9. 流式行为异常

- 流式要求 `POST` 带 `Accept: text/event-stream`。不带就按非流式 JSON-RPC 处理。
- 流式路径只接受 `SendStreamingMessage` 与 `SubscribeToTask`；其他方法返回 method-not-found 错误帧。
- 帧是未命名的 `data:` 行；用 `curl -N`，不要缓冲。
- `SendMessage` 即使调用方期待流式也仍然阻塞；要流式就显式选流式方法。
- `returnImmediately` 与 `historyLength` 在 `0.3.7` 未生效。

## 10. 已知限制

- 没有 push notifications、gRPC、HTTP+JSON 绑定、OAuth、mTLS 或限流。
- `ListTasks` 返回全部任务，忽略过滤/分页。
- `GetTask` 不返回 history 数组。
- 活跃会话与对端只在内存；只有任务、绑定、实例跨重启保留。
- `subagent` 执行器不会被默认技能表选中。
- 出站 `preset` 只是元数据；还没有本地衔接会话。
- `0.3.7` 的 `/a2a inbound create` 与 `/a2a outbound create` 需要一个 `_` 占位符
  （见[运维指南](operations.zh.md#3-a2a-命令参考)）；优先用面板。

## 11. bug 报告里带什么

请附上：

- 插件版本（`0.3.7`）、harness 版本、操作系统；
- 精确的命令或面板操作；
- 任务 JSON（`/a2a task get <id>`）与 AgentCard；
- 入站是否配置鉴权、请求是否带 header（**不要贴 token**）；
- 相关宿主日志；如果怀疑会话层，附 `a2a-<contextId>` 的会话日志路径；
- 出站问题附远端卡片 URL 形状（可脱敏主机名）与 `lastError` 文本。

这些路径的自动防线见[测试](../testing.zh.md)。如果你在贡献修复，把失败断言加到能看见它的那一层：
类型契约加镜像检查，持久化会话形状加真实持久化集成，发布产物路径加 e2e 冒烟。
