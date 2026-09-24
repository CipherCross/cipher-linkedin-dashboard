import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, X } from 'lucide-react'
import { authPost } from '../lib/api'
import { useToast } from '../lib/ToastContext'
import { normalizeForDedup, parseLinkedInThread } from '../lib/parseLinkedInThread'
import type { Lead } from '../lib/types'
import {
  Badge, Button, Checkbox, IconButton, InlineError, RadioGroup, TextField, TextareaField,
} from '../ui'

// Paste → preview → save flow for a LinkedIn thread copied with the mouse.
// Rendered inside the ConversationDrawer in place of the thread, so the lead
// identity (instance / campaign / profile) is already fixed. Saved rows go
// through /api/import (admin-role conversation_import action,
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

// Complete class strings for the three-step progress rail, matching the
// state-machine styling of the sibling CSV importer (UnifiedApolloCsvImport).
const STEP_TEXT_CLASS = {
  active: 'text-app-text',
  done: 'text-app-text-secondary',
  todo: 'text-app-text-muted',
} as const

const STEP_NUMBER_CLASS = {
  active: 'bg-app-accent border-app-accent text-app-on-accent',
  done: 'bg-app-success-subtle border-app-success-border text-app-success',
  todo: 'bg-app-surface-2 border-app-border text-app-text-muted',
} as const

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
  onDirtyChange,
}: {
  lead: Lead
  accountName: string | null
  existing: ExistingMsg[] | null
  onImported: (result: SaveResult) => void
  onClose: () => void
  /** Pasted or parsed text that has not been saved yet — the drawer asks before
   *  closing over it. */
  onDirtyChange?: (dirty: boolean) => void
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

  const dirty = result === null && (text.trim() !== '' || blocks !== null)
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

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
      const res = await authPost('/api/import', {
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
    <ol className="flex items-center gap-app-sm list-none mt-0 mx-0 mb-1 p-0" aria-label="Import history progress">
      {['Paste', 'Review', 'Import'].map((label, i) => {
        const n = i + 1
        const state = n === step ? 'active' : n < step ? 'done' : 'todo'
        return (
          <li
            key={label}
            className={[
              'inline-flex items-center gap-1.5 text-[length:var(--text-xs)] font-semibold',
              STEP_TEXT_CLASS[state],
              i > 0 ? "before:content-[''] before:inline-block before:w-4 before:h-px before:bg-app-border before:mr-1.5" : '',
            ].filter(Boolean).join(' ')}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <span
              className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded-full border text-[length:var(--text-2xs)] ${STEP_NUMBER_CLASS[state]}`}
            >
              {state === 'done' ? <CheckCircle2 size={12} aria-hidden="true" /> : n}
            </span>
            {label}
          </li>
        )
      })}
    </ol>
  )

  if (result) {
    return (
      <div className="flex-1 overflow-y-auto pt-app-md px-app-lg pb-app-lg flex flex-col gap-2.5">
        {stepsHeader}
        <div>
          Imported <strong>{result.inserted}</strong> new message{result.inserted === 1 ? '' : 's'}
          {result.skipped > 0 && (
            <span className="text-app-text-muted"> · {result.skipped} skipped (already saved)</span>
          )}
        </div>
        {result.milestones && (
          <div className="text-app-meta text-app-text-muted">
            Lead milestones set: {Object.keys(result.milestones).join(', ').replace(/_at/g, '')}
          </div>
        )}
        {result.milestone_error && (
          <InlineError title="Messages saved, but milestone update failed." message={result.milestone_error} />
        )}
        <div className="flex items-center gap-app-md flex-wrap">
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto pt-app-md px-app-lg pb-app-lg flex flex-col gap-2.5">
      {stepsHeader}
      {!blocks && (
        <>
          <div className="text-app-meta text-app-text-muted">
            Open the conversation on LinkedIn, select the whole thread with the mouse, copy, and
            paste it below. Messages already in the dashboard are detected and skipped.
          </div>
          <TextareaField
            label="Paste the LinkedIn thread"
            labelHidden
            className="[&_textarea]:min-h-[220px]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'Anastasia Prokopenko   4:15 PM\nHello Igor,\n…'}
            autoFocus
          />
          {error && <InlineError title="Could not parse the thread." message={error} />}
          <div className="flex items-center gap-app-md flex-wrap">
            <Button variant="primary" onClick={parse} disabled={!text.trim()}>
              Preview
            </Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </>
      )}

      {blocks && (
        <>
          {warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-app-sm p-app-md border border-app-warning-border rounded-control bg-app-warning-subtle text-app-warning text-app-table"
            >
              <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
          {senders.length > 1 && (
            <RadioGroup
              legend="Sent by us"
              name="import-us"
              row
              value={usSender}
              onChange={pickUs}
              options={senders.map((s) => ({ value: s, label: s }))}
            />
          )}
          {blocks.map((b) => (
            <div
              className={`border border-app-border rounded-md px-2.5 py-app-sm bg-app-bg flex flex-col gap-1.5 ${b.include ? '' : 'opacity-50'}`}
              key={b.key}
            >
              <div className="flex items-center gap-app-sm flex-wrap">
                <Checkbox
                  label={<span className="sr-only">Include message from {b.sender}</span>}
                  checked={b.include}
                  onChange={(e) => patch(b.key, { include: e.target.checked })}
                  title={isDup(b) ? 'Already saved — check to import anyway' : 'Include in import'}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => patch(b.key, { direction: b.direction === 'out' ? 'in' : 'out' })}
                  title="Flip who sent this message"
                >
                  {b.direction === 'out' ? 'Us →' : '← Them'}
                </Button>
                <span className="truncate flex-1 min-w-0 text-app-text-muted" title={b.sender}>{b.sender}</span>
                {isDup(b) && <Badge tone="neutral">already saved</Badge>}
                {b.dateInferred && <Badge tone="warning">date guessed</Badge>}
                {b.outOfOrder && <Badge tone="warning">earlier than previous</Badge>}
                {/\n\s*\n/.test(b.body) && (
                  <Button variant="ghost" size="sm" onClick={() => split(b.key)} title="One block per paragraph">
                    Split
                  </Button>
                )}
                <IconButton label="Remove message" icon={<X size={18} aria-hidden="true" />} onClick={() => remove(b.key)} />
              </div>
              <TextField
                label={`Time for the message from ${b.sender}`}
                labelHidden
                type="datetime-local"
                className="max-w-[220px]"
                value={b.localTime}
                onChange={(e) => patch(b.key, { localTime: e.target.value })}
              />
              <TextareaField
                label={`Message text from ${b.sender}`}
                labelHidden
                value={b.body}
                rows={Math.min(6, b.body.split('\n').length + 1)}
                onChange={(e) => patch(b.key, { body: e.target.value })}
              />
            </div>
          ))}
          {error && <InlineError title="Could not save the messages." message={error} />}
          <div className="flex items-center gap-app-md flex-wrap">
            <Button
              variant="primary"
              onClick={save}
              loading={saving}
              loadingLabel="Saving the messages"
              disabled={included.length === 0}
            >
              {saving ? 'Saving…' : `Save ${included.length} message${included.length === 1 ? '' : 's'}`}
            </Button>
            <span className="text-app-meta text-app-text-muted flex-1">
              {dupCount > 0 ? `${dupCount} already saved` : ''}
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                if (edited && !window.confirm('Discard your edits and go back to the paste step? Direction, time and split changes will be lost.')) return
                setBlocks(null)
                setEdited(false)
              }}
              disabled={saving}
            >
              Back
            </Button>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
