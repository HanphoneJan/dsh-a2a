---
name: 文档
description: @hanphone/dsh-a2a A2A 插件的公开手册——安装、概念、运维、HTTP API 与排障
create-time: 2026-10-19
update-time: 2026-10-24
version: v0.5.0
relative-docs:
  - docs/architecture.zh.md
  - docs/harness-compatibility.zh.md
  - docs/testing.zh.md
---

# dsh-a2a 文档

[English](README.md) · **中文**

`@hanphone/dsh-a2a` 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
的 Agent2Agent（A2A）v1.0.1 双端插件：入站 server 把 DSH agent 发布给其他 A2A
客户端，出站连接把远端 A2A 技能映射为 DSH 内的模型工具。

这份手册描述 **v0.5.0** 在 DeepSeek Harness **0.2.1-rc.2** 上的当前行为。

## 从这里开始

| 文档 | 回答什么 |
|---|---|
| [快速开始](guide/getting-started.zh.md) | 怎么安装、发布第一个 agent、调用一个远端 agent？ |
| [核心概念](guide/concepts.zh.md) | 入站/出站、preset、技能、任务、上下文、能力分别是什么？ |
| [运维指南](guide/operations.zh.md) | GUI 和 `/a2a` 命令怎么用？配置、存储、安全怎么管？ |
| [HTTP API 与 A2A 协议](reference/http-api.zh.md) | 面板 API 有哪些动作？线上端点和协议长什么样？ |
| [排障](guide/troubleshooting.zh.md) | 任务为空、出站失败、工具看不到，分别怎么查？ |

## 深入文档

| 文档 | 读者 |
|---|---|
| [架构](architecture.zh.md) | 维护者与插件作者：manager、执行器、路由、存储、安全 |
| [Harness 兼容性](harness-compatibility.zh.md) | 跨 DSH 版本升级的维护者：耦合面、流程与当前状态 |
| [测试](testing.zh.md) | 贡献者：测试分层、hermetic e2e 冒烟，以及为什么 stub 测试不够 |

## 事实来源

文档冲突时，以 `src/` 下实际运行的代码与 `tests/` 下的测试为准，其次看本手册的
参考页，最后看顶层 README 与深入文档。手册由人工维护，可能滞后于代码；每页都标注了
核对时的版本，如果观察与文档不一致，请以代码为准，并带着版本和你执行的命令提 issue。

## 版本与兼容性

- 插件：`@hanphone/dsh-a2a` `0.5.0`
- 已核对：DeepSeek Harness `0.2.1-rc.2`（CI 同时覆盖 `0.2.1-alpha.2` 与 `0.1.7-rc.2`）
- 协议：A2A `1.0.1` 的 JSON-RPC 绑定（本实现声明的协议版本为 `1.0`）

peer 范围与验证流程见 [Harness 兼容性](harness-compatibility.zh.md)。
