/**
 * A2A settings dashboard — browser half.
 *
 * Registers one `settings.section` ("A2A 连接") managing the multi-instance
 * A2A composition across three tabs: inbound server instances (create/edit,
 * each with its own agent preset — skills derive automatically — and an
 * optional bearer token), outbound server connections (two-phase
 * discover→connect, auth, preset, timeout), and connection/task activity.
 *
 * Styling lives in dashboard.css.ts, built entirely on the product's
 * `--dsw-alias-*` design tokens with `@container` responsiveness. All data and
 * controls sit behind the host's loopback-only `/a2a/api` route; this half is
 * a thin read/write client with no protocol knowledge.
 * @module dsh-a2a/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { createElement, useEffect, useState, type ReactElement } from 'react'
import { injectDashboardStyles } from './dashboard.css.ts'

/** Services this plugin needs from the client runtime. */
export const inject = ['slots']

const NS = 'a2a'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => injectDashboardStyles(), `${NS}: dashboard styles`)
  // settings.section is declared at runtime by ui-settings-general; slots.inject
  // defers registration until that declaration exists and follows its lifetime.
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'a2a',
      order: 90,
      label: () => 'A2A 连接',
      inject: () => ({}),
    },
    A2aSection,
  ))
}

/** Wire types — mirror the host's src/api.ts + src/service.ts views. */
export interface SkillView {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface InboundServerView {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly version: string
  readonly endpointPath: string
  readonly preset?: string
  readonly authTokenEnv?: string
  readonly cardPath: string
  readonly cardUrl?: string
  readonly enabled: boolean
  readonly skills: readonly SkillView[]
}

export interface OutboundServerView {
  readonly id: string
  readonly name: string
  readonly agentCardUrl: string
  readonly preset?: string
  readonly enabled: boolean
  readonly timeoutMs: number
  readonly state: string
  readonly skillCount: number
  readonly toolCount: number
  readonly lastError?: string
}

export interface PresetView {
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** Whether this preset is the deployment default when none is named. */
  readonly isDefault?: boolean
}

export interface ApiSnapshot {
  readonly inbounds: readonly InboundServerView[]
  readonly outbounds: readonly OutboundServerView[]
  readonly tasks: readonly unknown[]
  readonly peers: readonly unknown[]
}

interface DiscoverPreview {
  readonly name: string
  readonly version?: string
  readonly description?: string
  readonly endpoint: string
  readonly skills: readonly SkillView[]
}

interface InboundPeerView {
  readonly id: string
  readonly label: string
  readonly source?: string | null
  readonly firstSeen?: string
  readonly lastSeen?: string
  readonly taskCount: number
  readonly activeTaskIds: readonly string[]
  readonly streaming: boolean
}

interface TaskView {
  readonly id: string
  readonly contextId?: string
  readonly serverId?: string
  readonly status?: { readonly state: string }
  readonly metadata?: { readonly skill?: string }
}

async function fetchSnapshot(): Promise<ApiSnapshot> {
  const res = await fetch('/a2a/api', { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`)
  return (await res.json()) as ApiSnapshot
}

async function fetchPresets(): Promise<PresetView[]> {
  const res = await fetch('/a2a/api/presets', { headers: { accept: 'application/json' } })
  if (!res.ok) return []
  return (await res.json()) as PresetView[]
}

async function postControl(payload: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly message: string; readonly preview?: unknown }> {
  const res = await fetch('/a2a/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return (await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }))) as { ok: boolean; message: string; preview?: unknown }
}

function dotState(state: string): string {
  if (state === 'connected') return 'connected'
  if (state === 'reconnecting' || state === 'disabled') return 'disabled'
  if (state === 'failed') return 'failed'
  return 'connected'
}

function presetLabel(presets: readonly PresetView[], id: string | undefined): string {
  if (id === undefined) return '—'
  return presets.find((p) => p.id === id)?.name ?? id
}

type SectionProps = PropsRuntime<'settings.section'>

export function A2aSection(_props: SectionProps): ReactElement {
  const [snap, setSnap] = useState<ApiSnapshot | undefined>(undefined)
  const [presets, setPresets] = useState<readonly PresetView[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'inbound' | 'outbound' | 'activity'>('inbound')

  // Inbound create/edit form.
  const [editingIn, setEditingIn] = useState<string | null>(null)
  const [inName, setInName] = useState('')
  const [inDesc, setInDesc] = useState('')
  const [inVersion, setInVersion] = useState('1.0.0')
  const [inPreset, setInPreset] = useState('')
  const [inToken, setInToken] = useState('')
  const [inClearAuth, setInClearAuth] = useState(false)

  // Outbound add/edit form (two-phase).
  const [editingOut, setEditingOut] = useState<string | null>(null)
  const [outName, setOutName] = useState('')
  const [outUrl, setOutUrl] = useState('')
  const [outPreset, setOutPreset] = useState('')
  const [outTimeout, setOutTimeout] = useState('60000')
  const [outToken, setOutToken] = useState('')
  const [discovered, setDiscovered] = useState<DiscoverPreview | null>(null)
  const [discovering, setDiscovering] = useState(false)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const [next, presetRows] = await Promise.all([fetchSnapshot(), fetchPresets()])
        if (alive) {
          setSnap(next)
          setPresets(presetRows)
          // Default an unset preset picker to the deployment default (if any).
          const def = presetRows.find((p) => p.isDefault)?.id
          setInPreset((current) => current === '' && def !== undefined ? def : current)
          setOutPreset((current) => current === '' && def !== undefined ? def : current)
          setError(undefined)
        }
      } catch (err) {
        if (alive) setError((err as Error).message)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const control = async (payload: Record<string, unknown>): Promise<{ ok: boolean; message: string; preview?: unknown }> => {
    setBusy(true)
    try {
      const result = await postControl(payload)
      if (!result.ok) setError(result.message)
      else setNotice(result.message)
      setSnap(await fetchSnapshot())
      return result
    } catch (err) {
      setError((err as Error).message)
      return { ok: false, message: (err as Error).message }
    } finally {
      setBusy(false)
    }
  }

  const beginCreateInbound = (): void => {
    setEditingIn(null)
    setInName('')
    setInDesc('')
    setInVersion('1.0.0')
    setInPreset(presets.find((p) => p.isDefault)?.id ?? '')
    setInToken('')
    setInClearAuth(false)
  }

  const beginEditInbound = (v: InboundServerView): void => {
    setEditingIn(v.id)
    setInName(v.name)
    setInDesc(v.description)
    setInVersion(v.version)
    setInPreset(v.preset ?? presets.find((p) => p.isDefault)?.id ?? '')
    setInToken('')
    setInClearAuth(false)
  }

  const submitInbound = async (): Promise<void> => {
    if (!inName.trim() || busy) return
    const base = {
      name: inName.trim(),
      description: inDesc.trim() || 'An A2A inbound server',
      version: inVersion.trim() || '1.0.0',
      ...(inPreset !== '' ? { preset: inPreset } : {}),
    }
    const done = editingIn === null
      ? await control({ action: 'inbound.create', ...base })
      : await control({ action: 'inbound.update', id: editingIn, ...base })
    if (!done.ok) return
    // The id-echoed create response carries `id`, but the generic control
    // result drops it; resolve the target from the fresh snapshot.
    let targetId = editingIn
    if (targetId === null) {
      const fresh = await fetchSnapshot()
      const newest = fresh.inbounds[0]
      targetId = newest?.id ?? null
    }
    if (targetId === null) return
    if (inToken.trim().length > 0) await control({ action: 'inbound.setAuth', id: targetId, token: inToken.trim() })
    else if (inClearAuth) await control({ action: 'inbound.setAuth', id: targetId })
    beginCreateInbound()
  }

  const doDiscover = async (): Promise<void> => {
    if (!outUrl.trim() || discovering) return
    setDiscovering(true)
    setDiscovered(null)
    try {
      const result = await postControl({ action: 'outbound.discover', agentCardUrl: outUrl.trim(), ...(outToken.trim() !== '' ? { token: outToken.trim() } : {}) })
      if (result.ok && result.preview !== undefined) {
        const preview = result.preview as DiscoverPreview
        setDiscovered(preview)
        setOutName((v) => v || preview.name)
        setError(undefined)
      } else {
        setError(result.message)
      }
    } finally {
      setDiscovering(false)
    }
  }

  const submitOutbound = async (): Promise<void> => {
    if (!outName.trim() || !outUrl.trim() || busy) return
    const timeout = Number.parseInt(outTimeout, 10)
    const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : undefined
    if (editingOut !== null) {
      const updated = await control({
        action: 'outbound.update',
        id: editingOut,
        ...(outName.trim() !== '' ? { name: outName.trim() } : {}),
        ...(outPreset !== '' ? { preset: outPreset } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      })
      if (!updated.ok) return
      if (outToken.trim().length > 0) await control({ action: 'outbound.setAuth', id: editingOut, token: outToken.trim() })
      resetOutboundForm()
      return
    }
    const created = await control({
      action: 'outbound.create',
      name: outName.trim(),
      agentCardUrl: outUrl.trim(),
      ...(outPreset !== '' ? { preset: outPreset } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    if (!created.ok) return
    const fresh = await fetchSnapshot()
    const newest = fresh.outbounds[0]
    if (newest !== undefined && outToken.trim().length > 0) {
      await control({ action: 'outbound.setAuth', id: newest.id, token: outToken.trim() })
    }
    resetOutboundForm()
  }

  const beginEditOutbound = (v: OutboundServerView): void => {
    setEditingOut(v.id)
    setOutName(v.name)
    setOutUrl(v.agentCardUrl)
    setOutPreset(v.preset ?? presets.find((p) => p.isDefault)?.id ?? '')
    setOutTimeout(String(v.timeoutMs))
    setOutToken('')
    setDiscovered(null)
  }

  const resetOutboundForm = (): void => {
    setEditingOut(null)
    setOutName('')
    setOutUrl('')
    setOutPreset(presets.find((p) => p.isDefault)?.id ?? '')
    setOutTimeout('60000')
    setOutToken('')
    setDiscovered(null)
  }

  const inbounds = snap?.inbounds ?? []
  const outbounds = snap?.outbounds ?? []
  const peers = (snap?.peers ?? []) as readonly InboundPeerView[]
  const tasks = (snap?.tasks ?? []) as readonly TaskView[]

  const h = (text: string, count?: number): ReactElement => createElement(
    'div', { className: 'dsh-a2a-h3' },
    text,
    count !== undefined ? createElement('span', { className: 'dsh-a2a-count' }, String(count)) : null,
  )
  const empty = (text: string): ReactElement => createElement('div', { className: 'dsh-a2a-empty' }, text)

  return createElement(
    'div',
    { className: 'dsh-a2a-root' },
    createElement(
      'div',
      { className: 'dsh-a2a-section' },
      createElement('p', { className: 'dsh-a2a-intro' }, '管理本 DSH 的 A2A 连接：入站 server 把 DSH 作为 Agent 发布（每个绑定一个 agent preset，技能自动派生）；出站 server 连接并调用远程 A2A Agent。'),
      error !== undefined ? createElement('div', { className: 'dsh-a2a-notice dsh-a2a-error' }, `加载失败：${error}`) : null,
      notice !== undefined ? createElement('div', { className: 'dsh-a2a-notice' }, notice) : null,
      // ── tabs ─────────────────────────────────────────────────────────
      createElement('div', { className: 'dsh-a2a-tabs' },
        createElement('button', { className: 'dsh-a2a-tab', 'data-active': String(tab === 'inbound'), onClick: () => setTab('inbound') }, `入站 Servers（${inbounds.length}）`),
        createElement('button', { className: 'dsh-a2a-tab', 'data-active': String(tab === 'outbound'), onClick: () => setTab('outbound') }, `出站 Servers（${outbounds.length}）`),
        createElement('button', { className: 'dsh-a2a-tab', 'data-active': String(tab === 'activity'), onClick: () => setTab('activity') }, `连接与任务（${peers.length}）`),
      ),

      // ══ tab: inbound servers ══════════════════════════════════════════
      tab === 'inbound'
        ? createElement('div', { className: 'dsh-a2a-stack' },
            createElement('div', { className: 'dsh-a2a-crew' },
              h('入站 Servers', inbounds.length),
              inbounds.length === 0
                ? empty('还没有入站 server。创建一个即可对外发布 A2A 端点。')
                : createElement('div', { className: 'dsh-a2a-card-list' },
                    ...inbounds.map((v) =>
                      createElement('div', { className: 'dsh-a2a-card', key: v.id },
                        createElement('div', { className: 'dsh-a2a-card-head' },
                          createElement('span', { 'data-state': v.enabled ? 'connected' : 'disabled', className: 'dsh-a2a-dot' }),
                          createElement('span', { className: 'dsh-a2a-card-name' }, v.name),
                          createElement('span', { className: 'dsh-a2a-badge' }, presetLabel(presets, v.preset)),
                          createElement('span', { className: 'dsh-a2a-auth' }, v.authTokenEnv !== undefined ? '· 已配置鉴权' : '· 匿名'),
                        ),
                        createElement('div', { className: 'dsh-a2a-card-sub dsh-a2a-mono' }, `${v.endpointPath} · ${v.cardUrl ?? v.cardPath}`),
                        v.skills.length > 0
                          ? createElement('div', null, ...v.skills.map((s) => createElement('span', { className: 'dsh-a2a-skill', key: s.id, title: s.description ?? '' }, s.name)))
                          : null,
                        createElement('div', { className: 'dsh-a2a-btn-row' },
                          createElement('button', { className: 'dsh-a2a-btn', disabled: busy, onClick: () => { void control({ action: v.enabled ? 'inbound.disable' : 'inbound.enable', id: v.id }) } }, v.enabled ? '停用' : '启用'),
                          createElement('button', { className: 'dsh-a2a-btn', disabled: busy, onClick: () => beginEditInbound(v) }, '编辑'),
                          createElement('button', { className: 'dsh-a2a-btn', disabled: busy, onClick: () => { void control({ action: 'inbound.remove', id: v.id }); if (editingIn === v.id) beginCreateInbound() } }, '删除'),
                        ),
                      ),
                    ),
                  ),
            ),
            createElement('div', { className: 'dsh-a2a-card' },
              h(editingIn !== null ? '编辑入站 Server' : '新建入站 Server'),
              createElement('form', { className: 'dsh-a2a-form', onSubmit: (ev: { preventDefault(): void }) => { ev.preventDefault(); void submitInbound() } },
                createElement('input', { className: 'dsh-a2a-input', value: inName, placeholder: '名称', onChange: (e: { target: { value: string } }) => setInName(e.target.value) }),
                createElement('input', { className: 'dsh-a2a-input', value: inVersion, placeholder: '版本', style: { width: '76px' }, onChange: (e: { target: { value: string } }) => setInVersion(e.target.value) }),
                createElement('select', { className: 'dsh-a2a-select', value: inPreset, onChange: (e: { target: { value: string } }) => setInPreset(e.target.value) },
                  ...presets.map((p) => createElement('option', { value: p.id, key: p.id, title: p.description ?? p.id }, p.name ?? p.id)),
                ),
                createElement('input', { className: 'dsh-a2a-input', type: 'password', value: inToken, placeholder: editingIn !== null ? 'Bearer Token（留空不改，填写则更新）' : 'Bearer Token（可选）', onChange: (e: { target: { value: string } }) => setInToken(e.target.value) }),
                createElement('button', { className: 'dsh-a2a-btn dsh-a2a-btn-primary', type: 'submit', disabled: busy || !inName.trim() }, editingIn !== null ? '保存修改' : '创建 Server'),
                editingIn !== null ? createElement('button', { className: 'dsh-a2a-btn', type: 'button', disabled: busy, onClick: () => beginCreateInbound() }, '取消') : null,
              ),
              editingIn !== null && (snap?.inbounds.find((x) => x.id === editingIn)?.authTokenEnv) !== undefined
                ? createElement('div', { className: 'dsh-a2a-form' },
                    createElement('label', { className: 'dsh-a2a-hint' }, '已配置鉴权。'),
                    createElement('button', { className: 'dsh-a2a-btn', type: 'button', disabled: busy, onClick: () => { setInClearAuth(true); void submitInbound() } }, '清除鉴权'),
                  )
                : null,
              createElement('div', { className: 'dsh-a2a-form' },
                createElement('input', { className: 'dsh-a2a-input', value: inDesc, placeholder: '描述', style: { flex: 1, minWidth: '220px' }, onChange: (e: { target: { value: string } }) => setInDesc(e.target.value) }),
              ),
              createElement('div', { className: 'dsh-a2a-hint' }, '技能由所绑 preset 自动派生（一切皆插件）；Bearer Token 可留空（匿名）。'),
            ),
          )
        : null,

      // ══ tab: outbound servers ═════════════════════════════════════════
      tab === 'outbound'
        ? createElement('div', { className: 'dsh-a2a-stack' },
            createElement('div', { className: 'dsh-a2a-crew' },
              h('出站 Servers', outbounds.length),
              outbounds.length === 0
                ? empty('还没有出站 server。添加一个远端 A2A 连接即可把其技能注册为模型工具。')
                : createElement('div', { className: 'dsh-a2a-card-list' },
                    ...outbounds.map((v) =>
                      createElement('div', { className: 'dsh-a2a-card', key: v.id },
                        createElement('div', { className: 'dsh-a2a-card-head' },
                          createElement('span', { 'data-state': dotState(v.state), className: 'dsh-a2a-dot' }),
                          createElement('span', { className: 'dsh-a2a-card-name' }, v.name),
                          createElement('span', { className: 'dsh-a2a-badge' }, presetLabel(presets, v.preset)),
                          createElement('span', { className: 'dsh-a2a-auth' }, `· ${v.state} · 工具 ${v.toolCount}/${v.skillCount}`),
                        ),
                        createElement('div', { className: 'dsh-a2a-card-sub dsh-a2a-mono' }, v.agentCardUrl),
                        v.lastError !== undefined ? createElement('div', { className: 'dsh-a2a-notice dsh-a2a-error' }, v.lastError) : null,
                        createElement('div', { className: 'dsh-a2a-btn-row' },
                          createElement('button', { className: 'dsh-a2a-btn', disabled: busy, onClick: () => { void control({ action: v.enabled ? 'outbound.disable' : 'outbound.enable', id: v.id }) } }, v.enabled ? '停用' : '启用'),
                          createElement('button', { className: 'dsh-a2a-btn', disabled: busy, onClick: () => { void control({ action: 'outbound.refresh', id: v.id }) } }, '刷新'),
                          createElement('button', { className: 'dsh-a2a-btn', disabled: busy, onClick: () => beginEditOutbound(v) }, '编辑'),
                          createElement('button', { className: 'dsh-a2a-btn', disabled: busy, onClick: () => { void control({ action: 'outbound.remove', id: v.id }); if (editingOut === v.id) resetOutboundForm() } }, '删除'),
                        ),
                      ),
                    ),
                  ),
            ),
            createElement('div', { className: 'dsh-a2a-card' },
              h(editingOut !== null ? '编辑出站 Server' : '添加出站 Server'),
              createElement('form', { className: 'dsh-a2a-form', onSubmit: (ev: { preventDefault(): void }) => { ev.preventDefault(); void doDiscover() } },
                createElement('input', { className: 'dsh-a2a-input', value: outName, placeholder: '名称', onChange: (e: { target: { value: string } }) => setOutName(e.target.value) }),
                createElement('input', { className: 'dsh-a2a-input', value: outUrl, placeholder: '远端 AgentCard URL', style: { flex: 1, minWidth: '220px' }, onChange: (e: { target: { value: string } }) => { setOutUrl(e.target.value); setDiscovered(null) } }),
                createElement('input', { className: 'dsh-a2a-input', type: 'password', value: outToken, placeholder: 'Bearer Token（可选）', onChange: (e: { target: { value: string } }) => setOutToken(e.target.value) }),
                createElement('select', { className: 'dsh-a2a-select', value: outPreset, onChange: (e: { target: { value: string } }) => setOutPreset(e.target.value) },
                  ...presets.map((p) => createElement('option', { value: p.id, key: p.id, title: p.description ?? p.id }, p.name ?? p.id)),
                ),
                createElement('input', { className: 'dsh-a2a-input', value: outTimeout, placeholder: '超时 ms', style: { width: '90px' }, onChange: (e: { target: { value: string } }) => setOutTimeout(e.target.value) }),
                editingOut === null
                  ? createElement('button', { className: 'dsh-a2a-btn', type: 'submit', disabled: busy || discovering || !outUrl.trim() }, discovering ? '读取中…' : '导入')
                  : null,
                createElement('button', { className: 'dsh-a2a-btn dsh-a2a-btn-primary', type: 'button', disabled: busy || (editingOut === null && discovered === null) || !outName.trim() || !outUrl.trim(), onClick: () => { void submitOutbound() } },
                  editingOut !== null ? '保存修改' : '连接'),
                editingOut !== null ? createElement('button', { className: 'dsh-a2a-btn', type: 'button', disabled: busy, onClick: () => resetOutboundForm() }, '取消') : null,
              ),
              discovered !== null
                ? createElement('div', { className: 'dsh-a2a-preview' },
                    createElement('div', { className: 'dsh-a2a-preview-head' },
                      createElement('span', { 'data-state': 'connected', className: 'dsh-a2a-dot' }),
                      createElement('span', { className: 'dsh-a2a-preview-name' }, discovered.name),
                      discovered.version !== undefined ? createElement('span', { className: 'dsh-a2a-preview-meta dsh-a2a-mono' }, `v${discovered.version}`) : null,
                    ),
                    discovered.description !== undefined ? createElement('div', { className: 'dsh-a2a-preview-desc' }, discovered.description) : null,
                    discovered.skills.length > 0
                      ? createElement('div', { className: 'dsh-a2a-skill-list' },
                          createElement('div', { className: 'dsh-a2a-skill-list-title' }, `Skills（${discovered.skills.length}）`),
                          ...discovered.skills.map((s) => createElement('div', { key: s.id }, `• ${s.name}${s.description !== undefined ? ` — ${s.description}` : ''}`)),
                        )
                      : null,
                    createElement('div', { className: 'dsh-a2a-preview-meta dsh-a2a-mono' }, `端点 ${discovered.endpoint}`),
                    createElement('div', { className: 'dsh-a2a-btn-row' },
                      createElement('button', { className: 'dsh-a2a-btn dsh-a2a-btn-primary', disabled: busy || !outName.trim(), onClick: () => { void submitOutbound() } }, '连接'),
                      createElement('button', { className: 'dsh-a2a-btn', disabled: busy, onClick: () => { setDiscovered(null); setOutUrl('') } }, '取消'),
                    ),
                  )
                : createElement('div', { className: 'dsh-a2a-hint' }, editingOut === null ? '输入远端 AgentCard URL 并点击「导入」，将读取其名称、描述、技能与端点；确认后建立连接。' : '保存将应用名称/Preset/超时与 Token 修改，并重建连接。'),
            ),
          )
        : null,

      // ══ tab: activity (inbound peers + tasks) ═════════════════════════
      tab === 'activity'
        ? createElement('div', { className: 'dsh-a2a-stack' },
            createElement('div', { className: 'dsh-a2a-crew' },
              h('入站连接（谁在调用本服务）', peers.length),
              peers.length === 0
                ? empty('暂无入站连接。其他 A2A 客户端调用本 DSH 的端点后会显示在这里。')
                : createElement('div', { className: 'dsh-a2a-table-wrap' },
                    createElement('table', { className: 'dsh-a2a-table' },
                      createElement('thead', null, createElement('tr', null,
                        createElement('th', null, '来源'),
                        createElement('th', null, '任务'),
                        createElement('th', null, '流式'),
                        createElement('th', null, '首次 / 最近'),
                        createElement('th', null, '操作'),
                      )),
                      createElement('tbody', null,
                        ...peers.map((p) => createElement('tr', { key: p.id },
                          createElement('td', null, p.source ?? p.label),
                          createElement('td', null, `${p.taskCount}（活跃 ${p.activeTaskIds.length}）`),
                          createElement('td', null, p.streaming ? '●' : '—'),
                          createElement('td', null, createElement('span', { className: 'dsh-a2a-card-sub' }, `${p.firstSeen ?? ''} / ${p.lastSeen ?? ''}`)),
                          createElement('td', null, createElement('button', { className: 'dsh-a2a-btn', disabled: busy, onClick: () => { void control({ action: 'inbound.close', id: p.id }) } }, '关闭')),
                        )),
                      ),
                    ),
                  ),
            ),
            createElement('div', { className: 'dsh-a2a-crew' },
              h('任务', tasks.length),
              tasks.length === 0
                ? empty('暂无任务。')
                : createElement('div', { className: 'dsh-a2a-table-wrap' },
                    createElement('table', { className: 'dsh-a2a-table' },
                      createElement('thead', null, createElement('tr', null,
                        createElement('th', null, 'ID'),
                        createElement('th', null, '技能'),
                        createElement('th', null, '来源'),
                        createElement('th', null, '状态'),
                        createElement('th', null, '操作'),
                      )),
                      createElement('tbody', null,
                        ...tasks.slice(-20).reverse().map((t) => createElement('tr', { key: t.id },
                          createElement('td', null, createElement('span', { className: 'dsh-a2a-card-sub dsh-a2a-mono' }, t.id)),
                          createElement('td', null, t.metadata?.skill ?? '-'),
                          createElement('td', null, t.serverId ?? '-'),
                          createElement('td', null, t.status?.state ?? '-'),
                          createElement('td', null, createElement('button', { className: 'dsh-a2a-btn', disabled: busy, onClick: () => { void control({ action: 'task.cancel', id: t.id }) } }, '取消')),
                        )),
                      ),
                    ),
                  ),
            ),
          )
        : null,

      createElement('div', { className: 'dsh-a2a-footer' }, '每 3 秒自动刷新。'),
    ),
  )
}