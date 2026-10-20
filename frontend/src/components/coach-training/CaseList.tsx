import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Loader2, MessageSquareText, Plus, Search, X } from 'lucide-react'
import { coachTraining, type ConversationHit, type TrainingCase } from '../../lib/coachTraining'
import { Button, Dialog, EmptyState, IconButton, InlineError, TextField, relativeTime } from '../../ui'

const displayName = (c: { full_name: string | null; profile_url: string }) =>
  c.full_name || c.profile_url.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '') || 'LinkedIn contact'

/** The training set: conversations the working prompt is checked against. */
export function CaseList({
  cases,
  maxCases,
  workingN,
  selectedId,
  running,
  onSelect,
  onAdd,
  onArchive,
  onRunAll,
}: {
  cases: TrainingCase[]
  maxCases: number
  workingN: number
  selectedId: number | null
  running: ReadonlySet<number>
  onSelect: (id: number) => void
  onAdd: () => void
  onArchive: (c: TrainingCase) => void
  onRunAll: () => void
}) {
  const notRun = cases.filter((c) => !c.run_id && !running.has(c.id)).length
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="coach-training-pane-body flex flex-col gap-stack">
        <div className="flex items-center gap-app-sm">
          <Button variant="secondary" size="sm" icon={<Plus aria-hidden="true" />} onClick={onAdd} disabled={cases.length >= maxCases}>
            Add conversation
          </Button>
          <span className="text-app-meta text-app-text-muted ml-auto">{cases.length}/{maxCases}</span>
        </div>
        {cases.length === 0 ? (
          <EmptyState
            icon={MessageSquareText}
            title="No conversations yet"
            hint="Add a few real conversations — the coach's advice on them is what you will judge."
          />
        ) : (
          <ul className="list-none m-0 p-0 flex flex-col" aria-label="Training conversations">
            {cases.map((c) => {
              const selected = c.id === selectedId
              const isRunning = running.has(c.id)
              return (
                <li key={c.id} className="coach-training-case" data-selected={selected ? 'true' : 'false'}>
                  <Button
                    variant="ghost"
                    className="coach-training-case__open"
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onSelect(c.id)}
                  >
                    <span className="flex flex-col items-start min-w-0 text-left">
                      <span className="font-semibold truncate max-w-full">{displayName(c)}</span>
                      <span className="text-app-meta text-app-text-muted truncate max-w-full">{c.headline || `${c.message_count} messages`}</span>
                      <span className="inline-flex items-center gap-app-xs text-app-meta text-app-text-muted">
                        {isRunning ? (
                          <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Running v{workingN}…</>
                        ) : c.run_error ? (
                          <><CircleAlert size={14} className="text-app-danger" aria-hidden="true" /> Run failed</>
                        ) : c.run_id ? (
                          <><CircleCheck size={14} className="text-app-success" aria-hidden="true" /> Ran on v{workingN}</>
                        ) : (
                          <>Not run on v{workingN}</>
                        )}
                        {c.cut_after_message_id && <span>· cut</span>}
                        {c.pending_feedback > 0 && <span>· {c.pending_feedback} marked</span>}
                      </span>
                    </span>
                  </Button>
                  <IconButton
                    className="coach-training-case__remove"
                    label={`Remove ${displayName(c)} from training`}
                    icon={<X aria-hidden="true" />}
                    onClick={() => onArchive(c)}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {cases.length > 0 && (
        <div className="coach-training-pane-foot">
          <Button variant="secondary" size="sm" disabled={notRun === 0} onClick={onRunAll}>
            {notRun === 0 ? `All ran on v${workingN}` : `Run ${notRun} on v${workingN}`}
          </Button>
        </div>
      )}
    </div>
  )
}

/** Pick a conversation with a reply to add to the training set. */
export function AddCaseDialog({
  onClose,
  onAdded,
  client = coachTraining,
}: {
  onClose: () => void
  onAdded: (caseId: number) => void
  client?: Pick<typeof coachTraining, 'search' | 'addCase'>
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ConversationHit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      client.search(query)
        .then((r) => { if (!cancelled) { setResults(r.results); setError(null) } })
        .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    }, query ? 250 : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, client])

  const add = async (hit: ConversationHit) => {
    const key = `${hit.instance_id}|${hit.profile_url}`
    setAdding(key)
    try {
      const { case_id } = await client.addCase(hit)
      onAdded(case_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setAdding(null)
    }
  }

  return (
    <Dialog
      title="Add a conversation"
      description="Conversations with at least one reply, newest reply first."
      size="lg"
      onRequestClose={onClose}
    >
      <div className="flex flex-col gap-group">
        <TextField
          label="Search"
          labelHidden
          placeholder="Name, headline or company"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {error && <InlineError title="Couldn't load conversations." message={error} />}
        {results === null && !error && <p className="m-0 text-app-meta text-app-text-muted">Loading…</p>}
        {results && results.length === 0 && (
          <EmptyState kind={query ? 'no-match' : 'empty'} icon={Search} title={query ? 'No conversation matches' : 'No replied conversations yet'} />
        )}
        {results && results.length > 0 && (
          <ul className="list-none m-0 p-0 flex flex-col" aria-label="Conversations">
            {results.map((hit) => {
              const key = `${hit.instance_id}|${hit.profile_url}`
              const when = relativeTime(hit.last_in_at)
              return (
                <li key={key} className="coach-training-hit">
                  <span className="flex flex-col min-w-0">
                    <span className="font-semibold truncate">{displayName(hit)}</span>
                    <span className="text-app-meta text-app-text-muted truncate">
                      {[hit.headline, `${hit.message_count} messages`, `${hit.hand_written} hand-written`].filter(Boolean).join(' · ')}
                    </span>
                    <span className="text-app-meta text-app-text-muted" title={when.title}>Last reply {when.label}</span>
                  </span>
                  {hit.in_training ? (
                    <span className="text-app-meta text-app-text-muted ml-auto">In training</span>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="ml-auto"
                      loading={adding === key}
                      disabled={adding !== null}
                      aria-label={`Add ${displayName(hit)}`}
                      onClick={() => void add(hit)}
                    >
                      Add
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
