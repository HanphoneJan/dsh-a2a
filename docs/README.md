---
name: Documentation
description: Public manual for the @hanphone/dsh-a2a A2A plugin — installation, concepts, operations, HTTP API, and troubleshooting
create-time: 2026-10-19
update-time: 2026-10-19
version: v0.3.8
relative-docs:
  - docs/architecture.md
  - docs/harness-compatibility.md
  - docs/testing.md
---

# dsh-a2a documentation

**English** · [中文](README.zh.md)

`@hanphone/dsh-a2a` is an Agent2Agent (A2A) v1.0.1 dual-end plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It turns a
DSH profile into an A2A citizen: one or more **inbound servers** publish DSH
agents to other A2A clients, and one or more **outbound connections** expose
remote A2A skills as model tools inside DSH.

This manual is written for the people who install, operate, and troubleshoot
the plugin. It describes the current behavior of **v0.3.8** against DeepSeek
Harness **0.2.1-rc.2**. Internal design rationale lives in the architecture
and design documents linked below.

## Start here

| Document | What it answers |
|---|---|
| [Getting started](guide/getting-started.md) | How do I install it, publish my first agent, and call a remote one? |
| [Concepts](guide/concepts.md) | What are inbound/outbound, presets, skills, tasks, contexts, and capabilities? |
| [Operations](guide/operations.md) | How do I use the GUI and `/a2a` command, configure it, and manage storage and security? |
| [HTTP API and A2A protocol](reference/http-api.md) | What are the dashboard API actions and the wire-level endpoints? |
| [Troubleshooting](guide/troubleshooting.md) | Why is a task empty, an outbound connection failed, or a tool missing? |

## Deep dives

| Document | Audience |
|---|---|
| [Architecture](architecture.md) | Maintainers and plugin authors: managers, executors, routes, storage, security |
| [Harness compatibility](harness-compatibility.md) | Maintainers upgrading across DSH versions; includes the verification procedure and release record |
| [Testing](testing.md) | Contributors: the test pyramid, the hermetic e2e smoke, and why stub tests are not enough |
| [Design notes](design.md) | Historical design decisions (Chinese) |

## Source of truth

When documents disagree, use this order:

1. The running code under `src/` and the tests under `tests/`.
2. This manual's reference pages.
3. `README.md` and the deep-dive documents.

The manual is maintained by hand and may lag the code. Every page states the
version it was checked against; if a behavior differs from what you observe,
treat the code as authoritative and open an issue with the version and the
commands you ran.

## Version and compatibility

- Plugin: `@hanphone/dsh-a2a` `0.3.8`
- Verified against: DeepSeek Harness `0.2.1-rc.2` (also exercised in CI against
  `0.2.1-alpha.2` and `0.1.7-rc.2`)
- Protocol: A2A `1.0.1` JSON-RPC binding (the A2A version this implementation
  implements is `1.0`)

See [Harness compatibility](harness-compatibility.md) for the exact peer ranges
and the release evidence.
