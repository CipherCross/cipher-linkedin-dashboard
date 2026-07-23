import { useEffect, useMemo, useState } from 'react'
import {
  CalendarCheck2,
  CalendarClock,
  CheckCircle2,
  History,
  Loader2,
  RotateCcw,
  SkipForward,
  UserRound,
  XCircle,
} from 'lucide-react'
import { useData } from '../lib/DataContext'
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
  const [historyVersion, setHistoryVersion] = useState(0)

  const key = followUpKey(lead.instance_id, lead.profile_url)
  const state = useMemo(
    () => followUpStateMap(data?.followUpStates ?? []).get(key) ?? null,
    [data?.followUpStates, key],
  )
  const members = actions.members
  const activeMembers = members.filter((member) => member.active)
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
    if (!supabase) return
    setHistoryLoading(true)
    setHistoryError(null)
    let query = supabase
      .from('follow_up_events')
      .select('*')
      .eq('instance_id', lead.instance_id)
      .eq('profile_url', lead.profile_url)
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(50)
    if (append && events.length) query = query.lt('id', events[events.length - 1].id)
    const { data: rows, error: loadError } = await query
    if (loadError) {
      setHistoryError(loadError.message)
    } else {
      const page = (rows ?? []) as FollowUpEvent[]
      setEvents((previous) => append ? [...previous, ...page] : page)
      setHasMore(page.length === 50)
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
      <div className="follow-panel">
        <div className="follow-panel-head">
          <button className="link-btn" onClick={onBack}>← Conversation</button>
        </div>
        <div className="banner warn">
          Apply database migration 046 to enable follow-up tracking.
        </div>
      </div>
    )
  }

  const active = activeFollowUp(state)
  const nextDateMin = mode === 'complete' || mode === 'skip'
    ? nextBusinessDate()
    : businessDateKey()

  return (
    <div className="follow-panel">
      <div className="follow-panel-head">
        <button className="link-btn" onClick={onBack}>← Conversation</button>
        <span className="follow-panel-title"><CalendarCheck2 size={16} /> Follow-up</span>
      </div>

      <label className="filter-field">
        <span className="filter-label">Who am I</span>
        <select value={actions.actor} onChange={(event) => actions.setActor(event.target.value)}>
          <option value="">— pick —</option>
          {activeMembers.map((member) => (
            <option key={member.id} value={member.name}>{member.name}</option>
          ))}
        </select>
      </label>

      <section className={`follow-current ${active ? 'active' : 'inactive'}`}>
        {active && state ? (
          <>
            <div>
              <div className="filter-label">Next follow-up</div>
              <div className={`follow-current-date ${state.next_follow_up_date! < businessDateKey() ? 'overdue' : ''}`}>
                {followUpDueLabel(state)}
              </div>
              <div className="muted small">{formatCalendarDate(state.next_follow_up_date!)}</div>
            </div>
            <div className="follow-current-owner">
              <UserRound size={14} />
              <span>{owner?.name ?? 'Unassigned'}</span>
            </div>
          </>
        ) : (
          <div>
            <div className="follow-current-date">No follow-up scheduled</div>
            <div className="muted small">Create the next action for this LinkedIn conversation.</div>
          </div>
        )}
      </section>

      {mode === 'overview' && (
        <div className="follow-actions-grid">
          {active ? (
            <>
              <button className="btn accent" onClick={() => resetForm('complete')}>
                <CheckCircle2 size={15} /> Complete
              </button>
              <button className="btn" onClick={() => resetForm('reschedule')}>
                <CalendarClock size={15} /> Reschedule
              </button>
              <button className="btn" onClick={() => resetForm('reassign')}>
                <UserRound size={15} /> Reassign
              </button>
              <button className="btn" onClick={() => resetForm('skip')}>
                <SkipForward size={15} /> Skip
              </button>
              <button className="btn danger" onClick={() => resetForm('cancel')}>
                <XCircle size={15} /> Cancel
              </button>
            </>
          ) : (
            <button className="btn accent" onClick={() => resetForm('schedule')}>
              <CalendarCheck2 size={15} /> Schedule follow-up
            </button>
          )}
        </div>
      )}

      {mode !== 'overview' && (
        <section className="follow-form">
          <div className="follow-form-title">
            {mode === 'schedule' && 'Schedule follow-up'}
            {mode === 'reschedule' && 'Choose a new date'}
            {mode === 'reassign' && 'Change task owner'}
            {mode === 'complete' && 'Complete follow-up'}
            {mode === 'skip' && 'Skip follow-up'}
            {mode === 'cancel' && 'Cancel follow-up'}
          </div>

          {(mode === 'complete' || mode === 'skip') && (
            <div className="follow-import-nudge">
              <div>
                <strong>Did you send or receive new messages?</strong>
                <div className="muted small">Import the LinkedIn history before recording the outcome.</div>
              </div>
              <button
                className="link-btn"
                onClick={() => onImport(mode as 'complete' | 'skip')}
              >
                Import history
              </button>
            </div>
          )}

          {(mode === 'skip' || mode === 'cancel') && (
            <label className="filter-field">
              <span className="filter-label">
                Reason {mode === 'skip' ? '(required)' : '(optional)'}
              </span>
              <textarea
                value={reason}
                maxLength={1000}
                rows={3}
                placeholder={mode === 'skip' ? 'Why is this being skipped?' : 'Why cancel this task?'}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          )}

          {(mode === 'schedule' || mode === 'reschedule') && (
            <label className="filter-field">
              <span className="filter-label">Date</span>
              <input
                type="date"
                value={date}
                min={businessDateKey()}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
          )}

          {(mode === 'complete' || mode === 'skip') && (
            <label className="filter-field">
              <span className="filter-label">Next follow-up (optional)</span>
              <input
                type="date"
                value={date}
                min={nextDateMin}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
          )}

          {(mode === 'schedule' || mode === 'reassign' || ((mode === 'complete' || mode === 'skip') && date)) && (
            <label className="filter-field">
              <span className="filter-label">Owner</span>
              <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
                <option value="">Choose owner…</option>
                {activeMembers.map((member) => (
                  <option key={member.id} value={String(member.id)}>{member.name}</option>
                ))}
              </select>
            </label>
          )}

          {error && <div className="banner conv-error">{error}</div>}

          <div className="follow-form-actions">
            <button className="btn" disabled={busy} onClick={() => setMode('overview')}>
              Back
            </button>
            <button
              className={`btn ${mode === 'cancel' ? 'danger' : 'accent'}`}
              disabled={
                busy ||
                (mode === 'skip' && !reason.trim()) ||
                ((mode === 'schedule' || mode === 'reassign') && !ownerId) ||
                ((mode === 'schedule' || mode === 'reschedule') && !date) ||
                ((mode === 'complete' || mode === 'skip') && !!date && !ownerId)
              }
              onClick={() => void submit()}
            >
              {busy && <Loader2 size={14} className="spin" />}
              {mode === 'complete' ? 'Mark completed' :
                mode === 'skip' ? 'Skip with reason' :
                  mode === 'cancel' ? 'Cancel follow-up' :
                    mode === 'reassign' ? 'Save owner' :
                      mode === 'reschedule' ? 'Save new date' : 'Schedule'}
            </button>
          </div>
        </section>
      )}

      <section className="follow-history">
        <div className="follow-history-head">
          <span><History size={15} /> History</span>
          <button className="link-btn" onClick={() => setHistoryVersion((version) => version + 1)}>
            <RotateCcw size={12} /> Refresh
          </button>
        </div>
        {historyError && <div className="banner conv-error">{historyError}</div>}
        {!events.length && !historyLoading && (
          <div className="muted small">No follow-up history yet.</div>
        )}
        <div className="follow-timeline">
          {events.map((event) => (
            <div className={`follow-event ${event.event_kind}`} key={event.id}>
              <span className="follow-event-dot" aria-hidden="true" />
              <div>
                <div className="follow-event-title">
                  {EVENT_LABEL[event.event_kind]}
                  {event.new_due_date ? ` · ${formatCalendarDate(event.new_due_date)}` : ''}
                </div>
                {event.event_kind === 'rescheduled' && event.previous_due_date && (
                  <div className="muted small">
                    From {formatCalendarDate(event.previous_due_date)}
                  </div>
                )}
                {event.event_kind === 'reassigned' && (
                  <div className="muted small">
                    {event.previous_owner_name ?? 'Unassigned'} → {event.new_owner_name ?? 'Unassigned'}
                  </div>
                )}
                {event.reason && <div className="small follow-event-reason">{event.reason}</div>}
                <div className="muted small">
                  {event.actor} · {new Date(event.occurred_at).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
        </div>
        {historyLoading && <div className="muted small">Loading history…</div>}
        {hasMore && !historyLoading && (
          <button className="link-btn" onClick={() => void loadHistory(true)}>Load more</button>
        )}
      </section>
    </div>
  )
}
