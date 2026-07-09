import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/ToastContext'
import { usePipelineActions } from '../lib/usePipelineActions'
import { ago } from '../lib/format'
import type { Lead, LeadNote } from '../lib/types'

/** Collapsible per-lead notes, styled after the drawer's AI-coach panel. Notes
 *  are fetched on first expand (anon client), newest first; add/delete are
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
    <div className={`conv-coaching ${open ? 'open' : ''}`}>
      <div className="conv-coaching-head">
        <button
          className="conv-coaching-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <span className="conv-coaching-title">Notes{count > 0 ? ` (${count})` : ''}</span>
        </button>
      </div>

      {open && (
        <div className="conv-coaching-body">
          {error && <div className="banner conv-error">{error}</div>}
          {loading && <div className="muted small">Loading notes…</div>}

          <div className="note-add">
            <textarea
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
            <button className="btn accent sm" onClick={add} disabled={!body.trim() || busy}>
              Add
            </button>
          </div>

          {notes && notes.length === 0 && !loading && (
            <div className="muted small">No notes yet.</div>
          )}

          {notes && notes.length > 0 && (
            <ul className="note-list">
              {notes.map((n) => (
                <li key={n.id} className="note-item">
                  <div className="note-body small">{n.body}</div>
                  <div className="note-meta muted small">
                    <span>{n.author || '—'}</span>
                    <span>· {ago(n.created_at)}</span>
                    <button
                      className="note-del"
                      onClick={() => remove(n)}
                      aria-label="Delete note"
                      title="Delete note"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
