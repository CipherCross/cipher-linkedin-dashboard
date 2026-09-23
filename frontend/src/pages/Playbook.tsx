import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { supabase } from '../lib/supabase'
import { fetchNeonPlaybook, resolveReadPath } from '../lib/dashboardReads'
import { authPost } from '../lib/api'
import { useToast } from '../lib/ToastContext'
import { shortDate } from '../lib/format'
import { Skeleton } from '../components/Skeleton'
import { useAuth } from '../lib/AuthContext'
import { Button, InlineError, PageHeader, Panel, SaveStatus, SegmentedControl, TextareaField } from '../ui'
import { COPY } from '../ui/labels'

// The single global playbook: one Markdown document that grounds the AI
// conversation coach (/api/coach) for every account. Read on whichever path the
// deployment serves — the signed-in Supabase client, or `coach.playbook` through
// the application API; saved through /api/playbook (service-role + admin role),
// which picks its own provider from NEON_WRITES_DEFAULT. See migration
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
  const { isAdmin } = useAuth()
  const toast = useToast()
  const [content, setContent] = useState('')
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [preview, setPreview] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  // Set on a failed load. While non-null the editor is locked so the user can't
  // type into an empty box and Save a fragment over the real playbook.
  const [loadError, setLoadError] = useState<string | null>(null)

  const reqId = useRef(0)

  const load = useCallback(async () => {
    const id = ++reqId.current

    // Both paths read the same singleton and mean the same thing by an absent
    // row: nobody has written a playbook yet, so the editor opens empty on its
    // placeholder. What they must not share is a *failure* rendered that way —
    // `loadError` locks the editor precisely so a blank box cannot be saved over
    // the real document, and both branches below set it on every failure.
    if ((await resolveReadPath()) === 'neon') {
      setLoaded(false)
      setLoadError(null)
      try {
        const doc = await fetchNeonPlaybook()
        if (id !== reqId.current) return
        setContent(doc?.content ?? '')
        setSavedAt(doc?.updated_at ?? null)
        setDirty(false)
      } catch (e) {
        if (id !== reqId.current) return
        setLoadError(`Couldn't load playbook: ${e instanceof Error ? e.message : String(e)}`)
      }
      setLoaded(true)
      return
    }

    if (!supabase) {
      setLoadError('Supabase is not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
      setLoaded(true)
      return
    }
    setLoaded(false)
    setLoadError(null)
    const { data, error } = await supabase
      .from('playbook')
      .select('content,updated_at')
      .maybeSingle()
    if (id !== reqId.current) return
    if (error) {
      setLoadError(`Couldn't load playbook: ${error.message}`)
    } else {
      setContent(data?.content ?? '')
      setSavedAt(data?.updated_at ?? null)
      setDirty(false)
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    load()
  }, [load])

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

  async function save() {
    setBusy(true)
    try {
      const res = await authPost('/api/playbook', { content })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(res.status === 401 || res.status === 403 ? 'Admin access required.' : `Save failed: ${out.error ?? res.status}`)
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
      <PageHeader
        title="Playbook"
        description="One Markdown document that grounds the AI conversation coach for every account."
      />

      <Panel className="playbook-editor">
        {/* Mode and save state stay in view while the document scrolls. */}
        <div className="sticky top-0 z-10 -mx-app-xl -mt-app-xl mb-app-lg px-app-xl py-app-md flex items-center gap-app-md flex-wrap bg-app-surface border-b border-app-border rounded-t-card">
          {/* Edit and Preview are explicit modes; at a width that fits both,
              the split below shows them side by side and this only marks
              which pane has focus. */}
          <SegmentedControl
            label="Editor mode"
            value={preview ? 'preview' : 'edit'}
            onChange={(mode) => setPreview(mode === 'preview')}
            items={[{ id: 'edit', label: 'Edit' }, { id: 'preview', label: 'Preview' }]}
          />
          <SaveStatus
            className="ml-auto"
            state={busy ? 'saving' : dirty ? 'dirty' : 'saved'}
            label={busy ? undefined : <>
              {savedAt ? `Last saved ${shortDate(savedAt)}` : 'Never saved'}
              {dirty && ` · ${COPY.unsavedChanges}`}
            </>}
          />
          <Button
            variant="primary"
            onClick={save}
            loading={busy}
            loadingLabel="Saving the playbook"
            disabled={!isAdmin || !loaded || !dirty || loadError != null}
            title={isAdmin ? undefined : 'Admin access required'}
          >
            {dirty ? 'Save changes' : COPY.saved}
          </Button>
        </div>

        {loadError && (
          <div className="mb-app-lg">
            <InlineError
              title={loadError}
              onRetry={load}
              retryLabel={loaded ? COPY.retry : COPY.loading}
              busy={!loaded}
            />
          </div>
        )}
        {!loaded ? (
          <div className="flex flex-col gap-2.5" aria-busy="true">
            {['40%', '92%', '88%', '70%', '95%', '64%', '90%', '80%', '55%', '86%'].map((w, i) => (
              <Skeleton key={i} width={w} height={13} />
            ))}
          </div>
        ) : (
          <div className={preview ? 'playbook-panes show-preview' : 'playbook-panes show-edit'}>
            <div className="playbook-pane playbook-edit-pane flex min-w-0 [&>*]:w-full">
              <TextareaField
                label="Playbook (Markdown)"
                labelHidden
                value={content}
                spellCheck={false}
                placeholder={PLACEHOLDER}
                disabled={loadError != null || !isAdmin}
                onChange={(e) => {
                  setDirty(true)
                  setContent(e.target.value)
                }}
              />
            </div>
            <div className="playbook-pane playbook-preview-pane flex min-w-0 [&>*]:w-full">
              <div className="playbook-preview chat-md max-w-[72ch] min-h-[520px] max-h-[72vh] p-app-lg border border-app-border rounded-control bg-app-surface overflow-y-auto">
                {content.trim() ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                ) : (
                  <p className="text-app-text-muted">Nothing to preview yet — write the playbook on the left.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </Panel>
    </>
  )
}
