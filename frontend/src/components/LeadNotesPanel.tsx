import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { fetchNeonLeadNotes, resolveReadPath } from '../lib/dashboardReads'
import { useToast } from '../lib/ToastContext'
import { usePipelineActions } from '../lib/usePipelineActions'
import { ago } from '../lib/format'
import type { Lead, LeadNote } from '../lib/types'
import { Button, IconButton, InlineError, TextareaField } from '../ui'
import { ConversationSection } from './ConversationSection'

/** Collapsible per-lead notes, the same band as the drawer's AI coach. Notes
 *  are fetched on first expand (authenticated client), newest first; add/delete are
 *  optimistic and revert on failure. */
export function LeadNotesPanel({ lead }: { lead: Lead }) {
  const toast = useToast()
  const { addNote, deleteNote, actor } = usePipelineActions()
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState<LeadNote[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  // Reset when the drawer switches leads.
  useEffect(() => {
    setOpen(false)
    setNotes(null)
    setError(null)
    setBody('')
  }, [lead.id])

  // Fetch on first expand.
  useEffect(() => {
    if (!open || notes !== null) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      // Both paths order newest first with NULL `created_at` first: PostgreSQL's
      // default for a bare `DESC` is NULLS FIRST and PostgREST emits the same
      // bare `DESC`, so a note written with no timestamp sorts identically on
      // either provider rather than first on one and last on the other.
      if ((await resolveReadPath()) === 'neon') {
        try {
          const rows = await fetchNeonLeadNotes(lead.id)
          if (cancelled) return
          setNotes(rows)
        } catch (e) {
          if (cancelled) return
          setError(e instanceof Error ? e.message : String(e))
        }
        setLoading(false)
        return
      }
      if (!supabase) {
        setError('Supabase is not configured.')
        setLoading(false)
        return
      }
      const { data, error: err } = await supabase
        .from('lead_notes')
        .select('id,lead_id,author,body,created_at')
        .eq('lead_id', lead.id)
        .order('created_at', { ascending: false })
      if (cancelled) return
      if (err) setError(err.message)
      else setNotes((data ?? []) as LeadNote[])
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open, notes, lead.id])

  const add = async () => {
    const text = body.trim()
    if (!text || busy) return
    setBusy(true)
    const temp: LeadNote = {
      id: -Date.now(),
      lead_id: lead.id,
      author: actor || null,
      body: text,
      created_at: new Date().toISOString(),
    }
    setNotes((prev) => [temp, ...(prev ?? [])])
    setBody('')
    try {
      const saved = await addNote(lead.id, text)
      setNotes((prev) => (prev ?? []).map((n) => (n.id === temp.id ? saved : n)))
    } catch (e) {
      setNotes((prev) => (prev ?? []).filter((n) => n.id !== temp.id))
      setBody(text)
      toast.error(`Couldn't add note: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (note: LeadNote) => {
    const prev = notes
    setNotes((list) => (list ?? []).filter((n) => n.id !== note.id))
    try {
      await deleteNote(note.id)
    } catch (e) {
      setNotes(prev)
      toast.error(`Couldn't delete note: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const count = notes?.length ?? 0

  return (
    <ConversationSection
      title={`Notes${count > 0 ? ` (${count})` : ''}`}
      open={open}
      onToggle={() => setOpen((o) => !o)}
    >
      {error && <InlineError title="Notes could not load." message={error} />}
      {loading && <p className="m-0 text-app-meta text-app-text-muted">Loading notes…</p>}

      <div className="flex gap-app-sm items-end mb-app-md">
        <TextareaField
          className="flex-1"
          label="Add a note"
          labelHidden
          rows={2}
          value={body}
          placeholder="Add a note…"
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              add()
            }
          }}
        />
        <Button variant="primary" size="sm" onClick={add} disabled={!body.trim() || busy}>
          Add
        </Button>
      </div>

      {notes && notes.length === 0 && !loading && (
        <p className="m-0 text-app-meta text-app-text-muted">No notes yet.</p>
      )}

      {notes && notes.length > 0 && (
        <ul className="list-none m-0 p-0 flex flex-col gap-app-sm">
          {notes.map((n) => (
            <li key={n.id} className="border-l-2 border-app-border pl-[9px]">
              <div className="text-app-table [overflow-wrap:anywhere] whitespace-pre-wrap">{n.body}</div>
              <div className="flex items-center gap-[5px] text-app-meta text-app-text-muted">
                <span>{n.author || '—'}</span>
                <span>· {ago(n.created_at)}</span>
                <IconButton
                  className="ml-auto"
                  tone="danger"
                  label="Delete note"
                  icon={<Trash2 size={16} aria-hidden="true" />}
                  onClick={() => remove(n)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </ConversationSection>
  )
}
