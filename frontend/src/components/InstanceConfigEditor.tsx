import { useEffect, useRef, useState } from 'react'
import type { Instance } from '../lib/types'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { instanceName } from '../lib/leads'
import { authPost } from '../lib/api'
import { useAuth } from '../lib/AuthContext'
import { Button, SelectField, TextField, TextareaField, useDirtyGuard } from '../ui'

// Per-instance config editor for the Health page. Writes the `config` override
// blob via /api/pipeline (action `set_instance_config`); the sync agent merges
// it over the notebook's local
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
  { key: 'notify_url', label: 'Notify URL', placeholder: 'https://<app>.vercel.app/api/notify-replies' },
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
  const { isAdmin } = useAuth()
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
  const { guard, prompt } = useDirtyGuard(dirty && !busy)

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

  // Warn on tab close / reload while there are unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  // Closing with unsaved edits asks first (Keep editing / Discard changes);
  // discarding resets to the last-saved baseline so reopening doesn't
  // resurrect it.
  const close = () => {
    const c = (inst.config ?? {}) as Record<string, unknown>
    setText(initText(c))
    setBool(initBool(c))
    setRawText('')
    setRaw(false)
    setMsg(null)
    setDirty(false)
    setOpen(false)
  }

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
      const res = await authPost('/api/pipeline', {
        action: 'set_instance_config',
        instance_id: inst.id,
        config,
      })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(res.status === 401 || res.status === 403 ? 'Admin access required.' : `Save failed: ${out.error ?? res.status}`)
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
      <div>
        <div className="flex items-center gap-inline flex-wrap">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(true)}
            disabled={!isAdmin}
            title={isAdmin ? 'Edit remote config' : 'Admin access required'}
          >
            {isAdmin ? 'Configure' : 'Admin only'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setViewRaw((v) => !v)}>
            {viewRaw ? 'Hide raw' : 'View raw'}
          </Button>
          {pending && <span className="text-app-meta text-app-text-muted">pending next sync</span>}
        </div>
        {viewRaw && (
          // The literal stored override blob (not the editor's reconstructed
          // view) so the true persisted config is auditable at a glance.
          <pre className="mt-app-sm mx-0 mb-0 p-app-sm border border-app-border rounded-md bg-app-bg font-mono text-app-meta text-app-text-secondary whitespace-pre-wrap [word-break:break-word] max-h-80 overflow-y-auto">
            {hasConfig
              ? JSON.stringify(cfg, null, 2)
              : 'No online config — this notebook runs on its local config.yaml.'}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div className="p-pane border border-app-border rounded-md bg-app-bg flex flex-col gap-group">
      {raw ? (
        <TextareaField
          label="Raw config (JSON)"
          value={rawText}
          spellCheck={false}
          rows={Math.min(20, Math.max(6, rawText.split('\n').length + 1))}
          onChange={(e) => { setDirty(true); setRawText(e.target.value) }}
          className="[&_textarea]:font-mono"
        />
      ) : (
        <div className="grid grid-cols-1 gap-app-sm">
          {TEXT_FIELDS.map((f) => (
            <TextField
              key={f.key}
              label={f.label}
              value={text[f.key]}
              placeholder={f.placeholder}
              onChange={(e) => { setDirty(true); setText({ ...text, [f.key]: e.target.value }) }}
            />
          ))}
          {BOOL_FIELDS.map((f) => (
            <SelectField
              key={f.key}
              label={f.label}
              value={bool[f.key]}
              onChange={(e) => { setDirty(true); setBool({ ...bool, [f.key]: e.target.value as Tri }) }}
            >
              <option value="default">Default (local)</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </SelectField>
          ))}

          {Object.keys(passthrough()).length > 0 && (
            <div className="text-app-meta text-app-text-muted">
              + {Object.keys(passthrough()).join(', ')} (edit via Advanced)
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-inline flex-wrap">
        <Button variant="primary" size="sm" loading={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button variant="secondary" size="sm" onClick={toggleRaw} disabled={busy}>
          {raw ? 'Structured' : 'Advanced (raw JSON)'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => guard(close)} disabled={busy}>
          Close
        </Button>
        {msg && <span className="text-app-meta text-app-danger" role="alert">{msg}</span>}
      </div>
      {prompt}
    </div>
  )
}
