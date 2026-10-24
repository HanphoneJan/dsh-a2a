---
name: Documentation
description: Manual for @hanphone/dsh-a2a — installation, concepts, operations, HTTP API, troubleshooting, architecture, compatibility and testing
update-time: 2026-10-25
---

# dsh-a2a documentation

**English** · [中文](README.zh.md)

`@hanphone/dsh-a2a` is the A2A v1.0.1 dual-end plugin for DeepSeek Harness.
Inbound servers publish DSH agents; outbound connections expose remote A2A
skills as model tools.

The manual describes plugin `0.5.0` on DeepSeek Harness `0.2.1-rc.2`.

## Read this first

| Document | Answers |
|---|---|
| [Getting started](guide/getting-started.md) | Install, publish an inbound server, call it, and connect a remote agent |
| [Concepts](guide/concepts.md) | The vocabulary: instances, presets, skills, tasks, contexts, executors |
| [Operations](guide/operations.md) | Panel and `/a2a` reference, configuration, host services, storage, access |
| [HTTP API and protocol](reference/http-api.md) | Dashboard actions, JSON-RPC methods, SSE, states, errors, AgentCard |
| [Troubleshooting](guide/troubleshooting.md) | Diagnosing empty replies, 401s, failed connections and missing tools |

## Maintainer references

| Document | Audience |
|---|---|
| [Architecture](architecture.md) | How the host half, managers, stores and browser half fit together |
| [Harness compatibility](harness-compatibility.md) | Moving the plugin to another DSH release |
| [Testing](testing.md) | Test layers, the hermetic e2e, and what stubs cannot see |

## Versions and source of truth

- Plugin: `@hanphone/dsh-a2a` `0.5.0`
- Verified against: DeepSeek Harness `0.2.1-rc.2`; the e2e matrix also covers
  `0.2.1-alpha.2` and `0.1.7-rc.2`
- Protocol: A2A `1.0.1` JSON-RPC binding; the declared protocol version is `1.0`

When this manual and the code disagree, `src/` and `tests/` win. Each page is
checked against the versions above; report an observed mismatch with the
version and the command you ran.
