import { useEffect, useRef, useState } from 'react'
import type { Instance } from '../lib/types'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { instanceName } from '../lib/leads'
import { adminPost } from '../lib/admin'

// Per-instance config editor for the Health page. Writes the `config` override
// blob via /api/config; the sync agent merges it over the notebook's local
// config.yaml on its next run (remote wins), so notebooks are reconfigured
// online with no local edits. Structured fields cover the routine keys; the
// Advanced raw-JSON box exposes everything else (e.g. the LH2 `mapping` SQL).
// (The AI coach's playbook is no longer per-instance — it's one global Markdown
// doc edited on the Playbook page; see migration 022_playbook.)

const TEXT_FIELDS: { key: string; label: string; placeholder?: string }[] = [
  { key: 'instance_label', label: 'Label' },
  { key: 'account_name', label: 'Account name' },
  { key: 'account_url', label: 'Account URL', placeholder: 'https://www.linkedin.com/in/…' },
  { key: 'account_avatar', label: 'Avatar URL' },
  { key: 'lh2_db_path', label: 'LH2 db path', placeholder: 'leave empty to auto-discover' },
]

const BOOL_FIELDS: { key: string; label: string }[] = [
  { key: 'auto_update', label: 'Auto-update' },
  { key: 'sync_steps', label: 'Sync steps' },
  { key: 'sync_messages', label: 'Sync messages' },
]

const TEXT_KEYS = new Set(TEXT_FIELDS.map((f) => f.key))
const BOOL_KEYS = new Set(BOOL_FIELDS.map((f) => f.key))

type Tri = 'default' | 'on' | 'off'

function initText(cfg: Record<string, unknown>) {
  const out: Record<string, string> = {}
  for (const f of TEXT_FIELDS) out[f.key] = cfg[f.key] != null ? String(cfg[f.key]) : ''
  return out
}
function initBool(cfg: Record<string, unknown>) {
  const out: Record<string, Tri> = {}
  for (const f of BOOL_FIELDS)
    out[f.key] = cfg[f.key] === true ? 'on' : cfg[f.key] === false ? 'off' : 'default'
  return out
}

export function InstanceConfigEditor({ inst }: { inst: Instance }) {
  const { refetch } = useData()
  const toast = useToast()
  const cfg = (inst.config ?? {}) as Record<string, unknown>

  const [open, setOpen] = useState(false)
  const [viewRaw, setViewRaw] = useState(false)
  const [raw, setRaw] = useState(false)
  const [text, setText] = useState(() => initText(cfg))
  const [bool, setBool] = useState(() => initBool(cfg))
  const [rawText, setRawText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  // True once the user edits a field. The form is seeded from props once; without
  // this guard, a background refetch (every 5 min) leaves the form on its initial
  // snapshot, and saving would silently overwrite any newer config.
  const [dirty, setDirty] = useState(false)

  // Re-seed the form when the underlying config changes (another save, or a sync
  // updated config_updated_at) — but only when there are no unsaved edits.
  const sig = `${inst.id}|${inst.config_updated_at ?? ''}`
  const lastSig = useRef(sig)
  useEffect(() => {
    if (sig === lastSig.current) return
    lastSig.current = sig
    if (dirty) return
    const c = (inst.config ?? {}) as Record<string, unknown>
    setText(initText(c))
    setBool(initBool(c))
    setRawText('')
  }, [sig, dirty, inst.config])

  // Keys present in config but not surfaced as structured fields (e.g. `mapping`)
  // are preserved so editing a field never drops them.
  const passthrough = () => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(cfg))
      if (!TEXT_KEYS.has(k) && !BOOL_KEYS.has(k)) out[k] = v
    return out
  }

  const buildFromFields = (): Record<string, unknown> => {
    const out = passthrough()
    for (const f of TEXT_FIELDS) {
      const v = text[f.key].trim()
      if (v) out[f.key] = v // empty = no override (fall back to local config.yaml)
    }
    for (const f of BOOL_FIELDS) {
      if (bool[f.key] === 'on') out[f.key] = true
      else if (bool[f.key] === 'off') out[f.key] = false // 'default' = omit
    }
    return out
  }

  const toggleRaw = () => {
    if (!raw) {
      setRawText(JSON.stringify(buildFromFields(), null, 2))
      setRaw(true)
    } else {
      // Coming back to fields: parse so the structured inputs reflect raw edits.
      try {
        const parsed = JSON.parse(rawText || '{}')
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          setText(initText(parsed))
          setBool(initBool(parsed))
          setRaw(false)
          setMsg(null)
        } else {
          setMsg('Raw config must be a JSON object.')
        }
      } catch {
        setMsg('Raw config is not valid JSON — fix it before switching back.')
      }
    }
  }

  async function save() {
    let config: unknown
    if (raw) {
      try {
        config = JSON.parse(rawText || '{}')
      } catch {
        setMsg('Invalid JSON.')
        return
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        setMsg('Config must be a JSON object.')
        return
      }
    } else {
      config = buildFromFields()
    }
    setBusy(true)
    setMsg(null)
    try {
      const res = await adminPost('/api/config', { instance_id: inst.id, config })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(res.status === 401 ? 'Wrong admin secret.' : `Save failed: ${out.error ?? res.status}`)
      } else {
        toast.success(`${instanceName(inst)} config saved — applies on the next sync (≤30 min).`)
        setDirty(false) // saved state is the new baseline; allow re-seeding from props
        refetch()
      }
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const pending =
    inst.config_updated_at != null &&
    (inst.last_sync_at == null ||
      new Date(inst.config_updated_at) > new Date(inst.last_sync_at))

  if (!open) {
    const hasConfig = cfg && Object.keys(cfg).length > 0
    return (
      <div className="config-toggle">
        <button className="link-btn" onClick={() => setOpen(true)}>
          Configure
        </button>
        {' · '}
        <button className="link-btn" onClick={() => setViewRaw((v) => !v)}>
          {viewRaw ? 'Hide raw' : 'View raw'}
        </button>
        {pending && <span className="config-pending"> · pending next sync</span>}
        {viewRaw && (
          // The literal stored override blob (not the editor's reconstructed
          // view) so the true persisted config is auditable at a glance.
          <pre className="config-view">
            {hasConfig
              ? JSON.stringify(cfg, null, 2)
              : 'No online config — this notebook runs on its local config.yaml.'}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div className="config-editor">
      {raw ? (
        <label className="config-raw">
          <span className="config-label">Raw config (JSON)</span>
          <textarea
            value={rawText}
            spellCheck={false}
            rows={Math.min(20, Math.max(6, rawText.split('\n').length + 1))}
            onChange={(e) => { setDirty(true); setRawText(e.target.value) }}
          />
        </label>
      ) : (
        <div className="config-fields">
          {TEXT_FIELDS.map((f) => (
            <label className="config-field" key={f.key}>
              <span className="config-label">{f.label}</span>
              <input
                type="text"
                value={text[f.key]}
                placeholder={f.placeholder}
                onChange={(e) => { setDirty(true); setText({ ...text, [f.key]: e.target.value }) }}
              />
            </label>
          ))}
          {BOOL_FIELDS.map((f) => (
            <label className="config-field" key={f.key}>
              <span className="config-label">{f.label}</span>
              <select
                value={bool[f.key]}
                onChange={(e) => { setDirty(true); setBool({ ...bool, [f.key]: e.target.value as Tri }) }}
              >
                <option value="default">Default (local)</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
          ))}

          {Object.keys(passthrough()).length > 0 && (
            <div className="muted small">
              + {Object.keys(passthrough()).join(', ')} (edit via Advanced)
            </div>
          )}
        </div>
      )}

      <div className="config-actions">
        <button className="btn-accent" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="link-btn" onClick={toggleRaw} disabled={busy}>
          {raw ? 'Structured' : 'Advanced (raw JSON)'}
        </button>
        <button className="link-btn" onClick={() => setOpen(false)} disabled={busy}>
          Close
        </button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
    </div>
  )
}
