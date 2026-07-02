import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { supabase } from '../lib/supabase'
import { adminPost } from '../lib/admin'
import { useToast } from '../lib/ToastContext'
import { shortDate } from '../lib/format'
import { Skeleton } from '../components/Skeleton'

// The single global playbook: one Markdown document that grounds the AI
// conversation coach (/api/coach) for every account. Read here with the anon
// key; saved through /api/playbook (service-role + admin secret). See migration
// 022_playbook — this replaces the old per-instance structured playbook.

const PLACEHOLDER = `# Playbook

## Product
What we sell, in one or two lines.

## Value proposition
The concrete outcome a prospect gets.

## Tone
e.g. warm, concise, no jargon.

## Primary call to action
e.g. a 15-minute call.

## Do
- Answer a direct question before pitching
- Keep messages short

## Don't
- Send walls of text
- Stack multiple asks in one message`

export function Playbook() {
  const toast = useToast()
  const [content, setContent] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [preview, setPreview] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) {
      setMsg('Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
      setLoaded(true)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase!
        .from('playbook')
        .select('content,updated_at')
        .maybeSingle()
      if (cancelled) return
      if (error) setMsg(`Couldn't load playbook: ${error.message}`)
      else {
        setContent(data?.content ?? '')
        setSavedAt(data?.updated_at ?? null)
      }
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function save() {
    setBusy(true)
    try {
      const res = await adminPost('/api/playbook', { content })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(res.status === 401 ? 'Wrong admin secret.' : `Save failed: ${out.error ?? res.status}`)
      } else {
        setSavedAt(new Date().toISOString())
        setDirty(false)
        toast.success('Playbook saved — the coach uses it on the next analysis.')
      }
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="playbook-head">
        <div>
          <h1>Playbook</h1>
          <div className="muted small">
            One Markdown document that grounds the AI conversation coach for every account.
            {savedAt && ` · last saved ${shortDate(savedAt)}`}
            {dirty && ' · unsaved changes'}
          </div>
        </div>
        <div className="controls">
          {/* the toggle only matters on narrow screens; wide shows both panes */}
          <button className="link-btn playbook-toggle" onClick={() => setPreview((p) => !p)}>
            {preview ? 'Edit' : 'Preview'}
          </button>
          <button
            className="btn-accent icon-btn"
            onClick={save}
            disabled={busy || !loaded || !dirty}
          >
            {dirty && !busy && <span className="unsaved-dot" />}
            {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </header>

      <div className="card playbook-editor">
        {!loaded ? (
          <div className="sk-lines" aria-busy="true">
            {['40%', '92%', '88%', '70%', '95%', '64%', '90%', '80%', '55%', '86%'].map((w, i) => (
              <Skeleton key={i} width={w} height={13} />
            ))}
          </div>
        ) : (
          <div className={`playbook-panes ${preview ? 'show-preview' : 'show-edit'}`}>
            <div className="playbook-pane playbook-edit-pane">
              <textarea
                value={content}
                spellCheck={false}
                placeholder={PLACEHOLDER}
                onChange={(e) => {
                  setDirty(true)
                  setContent(e.target.value)
                }}
              />
            </div>
            <div className="playbook-pane playbook-preview-pane">
              <div className="playbook-preview chat-md">
                {content.trim() ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                ) : (
                  <p className="muted">Nothing to preview yet — write the playbook on the left.</p>
                )}
              </div>
            </div>
          </div>
        )}
        {msg && (
          <div className="playbook-actions">
            <span className="muted small">{msg}</span>
          </div>
        )}
      </div>
    </>
  )
}
