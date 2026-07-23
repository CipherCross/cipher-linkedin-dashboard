import { useMemo, useRef, useState } from 'react'
import { adminPost } from '../lib/admin'
import { useToast } from '../lib/ToastContext'
import { normalizeForDedup, parseLinkedInThread } from '../lib/parseLinkedInThread'
import type { Lead } from '../lib/types'

// Paste → preview → save flow for a LinkedIn thread copied with the mouse.
// Rendered inside the ConversationDrawer in place of the thread, so the lead
// identity (instance / campaign / profile) is already fixed. Saved rows go
// through /api/import (ADMIN_SECRET-guarded conversation_import action,
// service-role write).

/** The already-stored thread rows the dup check runs against — the drawer
 *  passes its fetched messages. */
interface ExistingMsg {
  direction: string
  body: string | null
}

interface Block {
  key: number
  sender: string
  body: string
  direction: 'in' | 'out'
  localTime: string // <input type="datetime-local"> value, browser-local
  include: boolean
  dateInferred: boolean
  outOfOrder: boolean
}

export interface SaveResult {
  inserted: number
  skipped: number
  milestones?: Record<string, string>
  milestone_error?: string
}

const normName = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** Which pasted sender is "us" (the account owner)? account_name is the
 *  authority; failing that, in a two-person thread the non-lead sender. */
function detectUs(senders: string[], accountName: string | null, leadName: string | null): string | null {
  if (accountName) {
    const hit = senders.find((s) => normName(s) === normName(accountName))
    if (hit) return hit
  }
  if (leadName && senders.length === 2) {
    const them = senders.find((s) => normName(s) === normName(leadName))
    if (them) return senders.find((s) => s !== them) ?? null
  }
  return null
}

const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ImportHistoryPanel({
  lead,
  accountName,
  existing,
  onImported,
  onClose,
}: {
  lead: Lead
  accountName: string | null
  existing: ExistingMsg[] | null
  onImported: (result: SaveResult) => void
  onClose: () => void
}) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [blocks, setBlocks] = useState<Block[] | null>(null)
  const [senders, setSenders] = useState<string[]>([])
  const [usSender, setUsSender] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<SaveResult | null>(null)
  // Set once the user tweaks the parsed blocks (direction, time, split, remove,
  // who-is-us) so "Back" can warn before throwing those edits away.
  const [edited, setEdited] = useState(false)
  const nextKey = useRef(0)

  // Dedup identities of what's already stored; recomputed live so edits to a
  // block's body/direction update its "already saved" badge immediately.
  const existingKeys = useMemo(
    () => new Set((existing ?? []).map((r) => `${r.direction}|${normalizeForDedup(r.body ?? '')}`)),
    [existing],
  )
  const isDup = (b: Pick<Block, 'direction' | 'body'>) =>
    existingKeys.has(`${b.direction}|${normalizeForDedup(b.body)}`)

  const parse = () => {
    setError(null)
    const res = parseLinkedInThread(text)
    if (!res.messages.length) {
      setWarnings(res.warnings)
      setError('Nothing parsed — paste the thread as copied from LinkedIn (names, times and messages).')
      return
    }
    const us = detectUs(res.senders, accountName, lead.full_name)
    const parsed = res.messages.map((m) => {
      const direction: 'in' | 'out' = us
        ? normName(m.sender) === normName(us) ? 'out' : 'in'
        : lead.full_name && normName(m.sender) === normName(lead.full_name) ? 'in' : 'out'
      const b = { direction, body: m.body }
      return {
        key: nextKey.current++,
        sender: m.sender,
        body: m.body,
        direction,
        localTime: toLocalInput(m.sentAt),
        include: !isDup(b),
        dateInferred: m.dateInferred,
        outOfOrder: m.outOfOrder,
      }
    })
    setSenders(res.senders)
    setUsSender(us)
    setWarnings(res.warnings)
    setBlocks(parsed)
    setEdited(false)
  }

  const patch = (key: number, p: Partial<Block>) => {
    setEdited(true)
    setBlocks((prev) => prev?.map((b) => (b.key === key ? { ...b, ...p } : b)) ?? prev)
  }

  const remove = (key: number) => {
    setEdited(true)
    setBlocks((prev) => prev?.filter((b) => b.key !== key) ?? prev)
  }

  // LinkedIn collapses rapid-fire messages under one header; LH2 synced them as
  // separate rows, so splitting is what makes the dup badges line up.
  const split = (key: number) => {
    setEdited(true)
    setBlocks(
      (prev) =>
        prev?.flatMap((b) => {
          if (b.key !== key) return [b]
          const parts = b.body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
          if (parts.length < 2) return [b]
          return parts.map((part) => ({
            ...b,
            key: nextKey.current++,
            body: part,
            include: !isDup({ direction: b.direction, body: part }),
          }))
        }) ?? prev,
    )
  }

  const pickUs = (sender: string) => {
    setEdited(true)
    setUsSender(sender)
    setBlocks(
      (prev) =>
        prev?.map((b) => ({
          ...b,
          direction: normName(b.sender) === normName(sender) ? ('out' as const) : ('in' as const),
        })) ?? prev,
    )
  }

  const included = blocks?.filter((b) => b.include) ?? []
  const dupCount = blocks?.filter((b) => isDup(b)).length ?? 0

  const save = async () => {
    if (!blocks) return
    const bad = included.find((b) => !b.body.trim() || Number.isNaN(new Date(b.localTime).getTime()))
    if (bad) {
      setError(`A selected message from ${bad.sender} has ${!bad.body.trim() ? 'no text' : 'an invalid time'}.`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await adminPost('/api/import', {
        action: 'conversation_import',
        instance_id: lead.instance_id,
        campaign_id: lead.campaign_id,
        profile_url: lead.profile_url,
        messages: included.map((b) => ({
          direction: b.direction,
          body: b.body,
          sent_at: new Date(b.localTime).toISOString(),
          // Re-checked despite the "already saved" badge = import anyway.
          ...(isDup(b) ? { force: true } : {}),
        })),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
      const saved = j as SaveResult
      setResult(saved)
      onImported(saved)
      toast.success(
        `Imported ${saved.inserted} message${saved.inserted === 1 ? '' : 's'}` +
          (saved.skipped ? ` · ${saved.skipped} skipped` : ''),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Which of the three stages the panel is on, for the numbered step header.
  const step = result ? 3 : blocks ? 2 : 1
  const stepsHeader = (
    <ol className="import-steps">
      {['Paste', 'Review', 'Import'].map((label, i) => {
        const n = i + 1
        return (
          <li key={label} className={n === step ? 'active' : n < step ? 'done' : ''}>
            <span className="import-step-n">{n}</span>
            {label}
          </li>
        )
      })}
    </ol>
  )

  if (result) {
    return (
      <div className="import-panel">
        {stepsHeader}
        <div>
          Imported <strong>{result.inserted}</strong> new message{result.inserted === 1 ? '' : 's'}
          {result.skipped > 0 && (
            <span className="muted"> · {result.skipped} skipped (already saved)</span>
          )}
        </div>
        {result.milestones && (
          <div className="muted small">
            Lead milestones set: {Object.keys(result.milestones).join(', ').replace(/_at/g, '')}
          </div>
        )}
        {result.milestone_error && (
          <div className="banner conv-error">Messages saved, but milestone update failed: {result.milestone_error}</div>
        )}
        <div className="import-foot">
          <button className="btn-accent" onClick={onClose}>Done</button>
        </div>
      </div>
    )
  }

  return (
    <div className="import-panel">
      {stepsHeader}
      {!blocks && (
        <>
          <div className="muted small">
            Open the conversation on LinkedIn, select the whole thread with the mouse, copy, and
            paste it below. Messages already in the dashboard are detected and skipped.
          </div>
          <textarea
            className="import-paste"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Anastasia Prokopenko   4:15 PM\nHello Igor,\n…'}
            autoFocus
          />
          {error && <div className="banner conv-error">{error}</div>}
          <div className="import-foot">
            <button className="btn-accent" onClick={parse} disabled={!text.trim()}>
              Preview
            </button>
            <button className="link-btn" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}

      {blocks && (
        <>
          {warnings.map((w, i) => (
            <div className="banner warn" key={i}>{w}</div>
          ))}
          {senders.length > 1 && (
            <div className="import-us small">
              <span className="muted">Sent by us:</span>
              {senders.map((s) => (
                <label key={s}>
                  <input
                    type="radio"
                    name="import-us"
                    checked={usSender === s}
                    onChange={() => pickUs(s)}
                  />{' '}
                  {s}
                </label>
              ))}
            </div>
          )}
          {blocks.map((b) => (
            <div className={`import-block ${b.include ? '' : 'excluded'}`} key={b.key}>
              <div className="import-block-head">
                <input
                  type="checkbox"
                  checked={b.include}
                  onChange={(e) => patch(b.key, { include: e.target.checked })}
                  title={isDup(b) ? 'Already saved — check to import anyway' : 'Include in import'}
                />
                <button
                  className={`import-dir ${b.direction}`}
                  onClick={() => patch(b.key, { direction: b.direction === 'out' ? 'in' : 'out' })}
                  title="Flip who sent this message"
                >
                  {b.direction === 'out' ? 'Us →' : '← Them'}
                </button>
                <span className="muted ellipsis grow" title={b.sender}>{b.sender}</span>
                {isDup(b) && <span className="import-flag dup">already saved</span>}
                {b.dateInferred && <span className="import-flag">date guessed</span>}
                {b.outOfOrder && <span className="import-flag">earlier than previous</span>}
                {/\n\s*\n/.test(b.body) && (
                  <button className="link-btn" onClick={() => split(b.key)} title="One block per paragraph">
                    Split
                  </button>
                )}
                <button className="conv-close" onClick={() => remove(b.key)} aria-label="Remove message">
                  ✕
                </button>
              </div>
              <input
                type="datetime-local"
                value={b.localTime}
                onChange={(e) => patch(b.key, { localTime: e.target.value })}
              />
              <textarea
                value={b.body}
                rows={Math.min(6, b.body.split('\n').length + 1)}
                onChange={(e) => patch(b.key, { body: e.target.value })}
              />
            </div>
          ))}
          {error && <div className="banner conv-error">{error}</div>}
          <div className="import-foot">
            <button className="btn-accent" onClick={save} disabled={saving || included.length === 0}>
              {saving ? 'Saving…' : `Save ${included.length} message${included.length === 1 ? '' : 's'}`}
            </button>
            <span className="muted small grow">
              {dupCount > 0 ? `${dupCount} already saved` : ''}
            </span>
            <button
              className="link-btn"
              onClick={() => {
                if (edited && !window.confirm('Discard your edits and go back to the paste step? Direction, time and split changes will be lost.')) return
                setBlocks(null)
                setEdited(false)
              }}
              disabled={saving}
            >
              Back
            </button>
            <button className="link-btn" onClick={onClose} disabled={saving}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  )
}
