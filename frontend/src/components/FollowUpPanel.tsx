import { useEffect, useMemo, useState } from 'react'
import {
  CalendarCheck2,
  CalendarClock,
  CheckCircle2,
  History,
  RotateCcw,
  SkipForward,
  UserRound,
  XCircle,
} from 'lucide-react'
import { useData } from '../lib/DataContext'
import { followUpHistorySeek } from '../lib/conversationPaging'
import { fetchNeonFollowUpHistory, resolveReadPath } from '../lib/dashboardReads'
import {
  actorMember,
  activeFollowUp,
  businessDateKey,
  followUpDueLabel,
  followUpKey,
  followUpStateMap,
  formatCalendarDate,
} from '../lib/followUps'
import { supabase } from '../lib/supabase'
import { useFollowUpActions } from '../lib/useFollowUpActions'
import { Button, InlineError, Panel, SelectField, TextField, TextareaField } from '../ui'
import type { FollowUpEvent, Lead } from '../lib/types'

type FormMode = 'overview' | 'schedule' | 'reschedule' | 'reassign' | 'complete' | 'skip' | 'cancel'

const EVENT_LABEL: Record<FollowUpEvent['event_kind'], string> = {
  scheduled: 'Scheduled',
  rescheduled: 'Rescheduled',
  reassigned: 'Reassigned',
  completed: 'Completed',
  skipped: 'Skipped',
  canceled: 'Canceled',
}

// Complete class strings, so Tailwind's source scan sees them — the timeline
// dot is the one place colour stands for an event kind, and it always sits
// beside the kind's own word (`EVENT_LABEL`), never alone.
const EVENT_DOT_TONE: Record<FollowUpEvent['event_kind'], string> = {
  scheduled: 'bg-app-accent',
  rescheduled: 'bg-app-accent',
  reassigned: 'bg-app-text-muted',
  completed: 'bg-app-success',
  skipped: 'bg-app-warning',
  canceled: 'bg-app-warning',
}

/** One "load more" step. Both paths ask for the same page size, so the panel
 *  behaves identically whichever answers. */
const HISTORY_PAGE = 50

function nextBusinessDate(): string {
  const [year, month, day] = businessDateKey().split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

export function FollowUpPanel({
  lead,
  initialAction,
  onBack,
  onImport,
  onCompleted,
}: {
  lead: Lead
  initialAction?: 'complete' | 'skip'
  onBack: () => void
  onImport: (returnTo: 'complete' | 'skip') => void
  onCompleted: () => void
}) {
  const { data } = useData()
  const actions = useFollowUpActions()
  const [mode, setMode] = useState<FormMode>(initialAction ?? 'overview')
  const [date, setDate] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [events, setEvents] = useState<FollowUpEvent[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  // The Neon path's "load more" position. The server's opaque cursor replaces
  // the client-side seek entirely; it stays null on the Supabase path, which
  // seeks from the last row it already holds.
  const [historyCursor, setHistoryCursor] = useState<string | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)

  const key = followUpKey(lead.instance_id, lead.profile_url)
  const state = useMemo(
    () => followUpStateMap(data?.followUpStates ?? []).get(key) ?? null,
    [data?.followUpStates, key],
  )
  const members = actions.members
  // Owner *options* come from the assignable roster, never from the display one:
  // an `owner_id` chosen here is written back through `/api/pipeline`, which
  // resolves it against the other provider when the roster is Neon's.
  // `members` below still resolves the current owner's name, which is the read
  // this slice fixed.
  const activeMembers = actions.assignableMembers.filter((member) => member.active)
  const owner = state?.owner_id != null
    ? members.find((member) => member.id === state.owner_id)
    : undefined
  const me = actorMember(actions.actor, members)
  const preferredOwnerId =
    [state?.owner_id, lead.assigned_to, me?.id].find(
      (id) => id != null && activeMembers.some((member) => member.id === id),
    ) ?? null

  const resetForm = (nextMode: FormMode) => {
    setMode(nextMode)
    setError(null)
    setReason('')
    if (nextMode === 'schedule') {
      setDate(businessDateKey())
      setOwnerId(String(preferredOwnerId ?? ''))
    } else if (nextMode === 'reschedule') {
      setDate(state?.next_follow_up_date ?? businessDateKey())
      setOwnerId(String(state?.owner_id ?? ''))
    } else if (nextMode === 'reassign') {
      setDate('')
      setOwnerId(String(state?.owner_id ?? ''))
    } else if (nextMode === 'complete' || nextMode === 'skip') {
      setDate('')
      setOwnerId(String(preferredOwnerId ?? ''))
    } else {
      setDate('')
      setOwnerId('')
    }
  }

  const loadHistory = async (append = false) => {
    setHistoryLoading(true)
    setHistoryError(null)
    // The Neon path pages on the server's own cursor, which is a ROW comparison
    // over the whole `(occurred_at, id)` sort key — so the seek and the order
    // cannot disagree, and the client holds no seek logic at all.
    if ((await resolveReadPath()) === 'neon') {
      try {
        const page = await fetchNeonFollowUpHistory(
          lead.instance_id,
          lead.profile_url,
          HISTORY_PAGE,
          append ? historyCursor : null,
        )
        setEvents((previous) => (append ? [...previous, ...page.events] : page.events))
        setHistoryCursor(page.nextCursor)
        setHasMore(page.hasMore && page.nextCursor !== null)
      } catch (e) {
        setHistoryError(e instanceof Error ? e.message : String(e))
      }
      setHistoryLoading(false)
      return
    }
    if (!supabase) {
      setHistoryLoading(false)
      return
    }
    let query = supabase
      .from('follow_up_events')
      .select('*')
      .eq('instance_id', lead.instance_id)
      .eq('profile_url', lead.profile_url)
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(HISTORY_PAGE)
    // Seek on the whole sort key, not on `id` alone. `occurred_at` is
    // transaction-start time and `id` is insert time, so two overlapping writes
    // can commit with the two orders inverted; an `id`-only predicate then skips
    // the row this order says comes next. See `followUpHistorySeek`.
    if (append && events.length) query = query.or(followUpHistorySeek(events[events.length - 1]))
    const { data: rows, error: loadError } = await query
    if (loadError) {
      setHistoryError(loadError.message)
    } else {
      const page = (rows ?? []) as FollowUpEvent[]
      setEvents((previous) => append ? [...previous, ...page] : page)
      setHasMore(page.length === HISTORY_PAGE)
    }
    setHistoryLoading(false)
  }

  useEffect(() => {
    if (initialAction) resetForm(initialAction)
    else setMode('overview')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, initialAction])

  useEffect(() => {
    setEvents([])
    setHistoryCursor(null)
    void loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, historyVersion])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'schedule') {
        if (!date || !ownerId) throw new Error('Choose a date and owner.')
        await actions.schedule(lead, Number(ownerId), date)
      } else {
        if (!state || !activeFollowUp(state)) throw new Error('This follow-up is no longer active.')
        if (mode === 'reschedule') {
          if (!date) throw new Error('Choose a new date.')
          await actions.reschedule(lead, state, date)
        } else if (mode === 'reassign') {
          if (!ownerId) throw new Error('Choose an owner.')
          await actions.reassign(lead, state, Number(ownerId))
        } else if (mode === 'complete') {
          await actions.complete(
            lead,
            state,
            date ? { ownerId: Number(ownerId), date } : null,
          )
        } else if (mode === 'skip') {
          if (!reason.trim()) throw new Error('Explain why this follow-up is being skipped.')
          await actions.skip(
            lead,
            state,
            reason.trim(),
            date ? { ownerId: Number(ownerId), date } : null,
          )
        } else if (mode === 'cancel') {
          await actions.cancel(lead, state, reason.trim() || undefined)
        }
      }
      onCompleted()
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError))
    } finally {
      setBusy(false)
    }
  }

  if (!data?.followUpsAvailable) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-app-lg flex flex-col gap-app-md">
        <Button variant="ghost" size="sm" onClick={onBack}>← Conversation</Button>
        <InlineError
          title="Follow-up tracking unavailable"
          message="Apply database migration 046 to enable follow-up tracking."
        />
      </div>
    )
  }

  const active = activeFollowUp(state)
  const nextDateMin = mode === 'complete' || mode === 'skip'
    ? nextBusinessDate()
    : businessDateKey()
  const submitDisabled =
    busy ||
    (mode === 'skip' && !reason.trim()) ||
    ((mode === 'schedule' || mode === 'reassign') && !ownerId) ||
    ((mode === 'schedule' || mode === 'reschedule') && !date) ||
    ((mode === 'complete' || mode === 'skip') && !!date && !ownerId)
  const submitLabel = mode === 'complete' ? 'Mark completed' :
    mode === 'skip' ? 'Skip with reason' :
      mode === 'cancel' ? 'Cancel follow-up' :
        mode === 'reassign' ? 'Save owner' :
          mode === 'reschedule' ? 'Save new date' : 'Schedule'

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-app-lg flex flex-col gap-app-lg">
      <div className="flex items-center justify-between gap-app-sm">
        <Button variant="ghost" size="sm" onClick={onBack}>← Conversation</Button>
        <span className="inline-flex items-center gap-app-xs font-semibold text-app-text">
          <CalendarCheck2 size={16} aria-hidden="true" /> Follow-up
        </span>
      </div>

      <div className="text-app-meta text-app-text-muted" title="Audit identity comes from your login">
        Working as <strong className="text-app-text font-semibold">{actions.actor}</strong>
      </div>

      <Panel>
        {active && state ? (
          <div className="flex items-start justify-between gap-app-md">
            <div className="flex flex-col gap-app-xs">
              <div className="text-app-meta text-app-text-muted">Next follow-up</div>
              <div className={`text-app-body font-bold ${state.next_follow_up_date! < businessDateKey() ? 'text-app-danger' : 'text-app-text'}`}>
                {followUpDueLabel(state)}
              </div>
              <div className="text-app-meta text-app-text-muted">{formatCalendarDate(state.next_follow_up_date!)}</div>
            </div>
            <div className="inline-flex items-center gap-app-xs text-app-table shrink-0">
              <UserRound size={14} aria-hidden="true" />
              <span>{owner?.name ?? 'Unassigned'}</span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-app-xs">
            <div className="text-app-body font-bold text-app-text">No follow-up scheduled</div>
            <div className="text-app-meta text-app-text-muted">Create the next action for this LinkedIn conversation.</div>
          </div>
        )}
      </Panel>

      {mode === 'overview' && (
        <div className="flex flex-wrap gap-app-sm">
          {active ? (
            <>
              <Button variant="primary" icon={<CheckCircle2 size={15} aria-hidden="true" />} onClick={() => resetForm('complete')}>
                Complete
              </Button>
              <Button variant="secondary" icon={<CalendarClock size={15} aria-hidden="true" />} onClick={() => resetForm('reschedule')}>
                Reschedule
              </Button>
              <Button variant="secondary" icon={<UserRound size={15} aria-hidden="true" />} onClick={() => resetForm('reassign')}>
                Reassign
              </Button>
              <Button variant="secondary" icon={<SkipForward size={15} aria-hidden="true" />} onClick={() => resetForm('skip')}>
                Skip
              </Button>
              <Button variant="danger" icon={<XCircle size={15} aria-hidden="true" />} onClick={() => resetForm('cancel')}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="primary" icon={<CalendarCheck2 size={15} aria-hidden="true" />} onClick={() => resetForm('schedule')}>
              Schedule follow-up
            </Button>
          )}
        </div>
      )}

      {mode !== 'overview' && (
        <section className="flex flex-col gap-app-md">
          <div className="font-bold text-app-text">
            {mode === 'schedule' && 'Schedule follow-up'}
            {mode === 'reschedule' && 'Choose a new date'}
            {mode === 'reassign' && 'Change task owner'}
            {mode === 'complete' && 'Complete follow-up'}
            {mode === 'skip' && 'Skip follow-up'}
            {mode === 'cancel' && 'Cancel follow-up'}
          </div>

          {(mode === 'complete' || mode === 'skip') && (
            <div className="flex flex-col items-start gap-app-xs p-app-md rounded-control border border-app-border bg-app-surface-2">
              <div>
                <strong className="text-app-text">Did you send or receive new messages?</strong>
                <div className="text-app-meta text-app-text-muted">Import the LinkedIn history before recording the outcome.</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => onImport(mode as 'complete' | 'skip')}>
                Import history
              </Button>
            </div>
          )}

          {(mode === 'skip' || mode === 'cancel') && (
            <TextareaField
              label="Reason"
              required={mode === 'skip'}
              value={reason}
              maxLength={1000}
              rows={3}
              placeholder={mode === 'skip' ? 'Why is this being skipped?' : 'Why cancel this task?'}
              onChange={(event) => setReason(event.target.value)}
            />
          )}

          {(mode === 'schedule' || mode === 'reschedule') && (
            <TextField
              type="date"
              label="Date"
              required
              value={date}
              min={businessDateKey()}
              onChange={(event) => setDate(event.target.value)}
            />
          )}

          {(mode === 'complete' || mode === 'skip') && (
            <TextField
              type="date"
              label="Next follow-up (optional)"
              value={date}
              min={nextDateMin}
              onChange={(event) => setDate(event.target.value)}
            />
          )}

          {(mode === 'schedule' || mode === 'reassign' || ((mode === 'complete' || mode === 'skip') && date)) && (
            <SelectField
              label="Owner"
              required={mode === 'schedule' || mode === 'reassign'}
              value={ownerId}
              help={actions.memberWritesBlockedReason ?? undefined}
              onChange={(event) => setOwnerId(event.target.value)}
            >
              <option value="">Choose owner…</option>
              {activeMembers.map((member) => (
                <option key={member.id} value={String(member.id)}>{member.name}</option>
              ))}
            </SelectField>
          )}

          {error && <InlineError title="Couldn't save this follow-up." message={error} />}

          <div className="flex justify-end gap-app-sm">
            <Button variant="secondary" disabled={busy} onClick={() => setMode('overview')}>
              Back
            </Button>
            <Button
              variant={mode === 'cancel' ? 'danger' : 'primary'}
              loading={busy}
              loadingLabel={`${submitLabel}…`}
              disabled={submitDisabled}
              onClick={() => void submit()}
            >
              {submitLabel}
            </Button>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-app-md pt-app-lg border-t border-app-border">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-app-xs font-semibold text-app-text">
            <History size={15} aria-hidden="true" /> History
          </span>
          <Button variant="ghost" size="sm" icon={<RotateCcw size={12} aria-hidden="true" />} onClick={() => setHistoryVersion((version) => version + 1)}>
            Refresh
          </Button>
        </div>
        {historyError && (
          <InlineError
            title="Could not load follow-up history."
            message={historyError}
            onRetry={() => setHistoryVersion((version) => version + 1)}
            busy={historyLoading}
          />
        )}
        {!events.length && !historyLoading && (
          <p className="m-0 text-app-meta text-app-text-muted">No follow-up history yet.</p>
        )}
        <div className="flex flex-col">
          {events.map((event, index) => (
            <div className="relative grid grid-cols-[14px_1fr] gap-app-sm pb-app-md" key={event.id}>
              <span className={`relative z-10 mt-[3px] w-[11px] h-[11px] rounded-full ${EVENT_DOT_TONE[event.event_kind]}`} aria-hidden="true" />
              {index < events.length - 1 && (
                <span className="absolute left-[5px] top-[11px] bottom-0 w-px bg-app-border" aria-hidden="true" />
              )}
              <div>
                <div className="text-app-table font-semibold">
                  {EVENT_LABEL[event.event_kind]}
                  {event.new_due_date ? ` · ${formatCalendarDate(event.new_due_date)}` : ''}
                </div>
                {event.event_kind === 'rescheduled' && event.previous_due_date && (
                  <div className="text-app-meta text-app-text-muted">
                    From {formatCalendarDate(event.previous_due_date)}
                  </div>
                )}
                {event.event_kind === 'reassigned' && (
                  <div className="text-app-meta text-app-text-muted">
                    {event.previous_owner_name ?? 'Unassigned'} → {event.new_owner_name ?? 'Unassigned'}
                  </div>
                )}
                {event.reason && <div className="text-app-table whitespace-pre-wrap my-app-xs">{event.reason}</div>}
                <div className="text-app-meta text-app-text-muted">
                  {event.actor} · {new Date(event.occurred_at).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
        </div>
        {historyLoading && <p className="m-0 text-app-meta text-app-text-muted">Loading history…</p>}
        {hasMore && !historyLoading && (
          <Button variant="ghost" size="sm" onClick={() => void loadHistory(true)}>Load more</Button>
        )}
      </section>
    </div>
  )
}
