import { useEffect, useMemo, useState } from 'react'
import {
  PROMPT_SOURCE_LABEL, coachTraining, lineDiff, type PromptVersion, type TrainingState,
} from '../../lib/coachTraining'
import { Badge, Button, Dialog, InlineError, relativeTime } from '../../ui'

/** Every version, newest first: what it changed, a diff against its parent,
 *  and Restore (a new version with the old text). */
export function HistoryDialog({
  state,
  onClose,
  onRestore,
  restoring,
  client = coachTraining,
}: {
  state: TrainingState
  onClose: () => void
  onRestore: (version: PromptVersion) => void
  restoring: boolean
  client?: Pick<typeof coachTraining, 'version'>
}) {
  const [selectedId, setSelectedId] = useState(state.working.id)
  const [detail, setDetail] = useState<PromptVersion | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setError(null)
    client.version(selectedId)
      .then((r) => { if (!cancelled) setDetail(r.version) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [selectedId, client])

  const diff = useMemo(
    () => (detail?.prompt != null ? lineDiff(detail.parent_prompt ?? '', detail.prompt) : []),
    [detail],
  )

  return (
    <Dialog title="Prompt history" size="xl" onRequestClose={onClose} bodyClassName="p-0 overflow-hidden">
      <div className="coach-training-history">
        <ol className="list-none m-0 p-0 overflow-y-auto border-r border-app-border" aria-label="Versions">
          {state.versions.map((v) => {
            const when = relativeTime(v.created_at)
            return (
              <li key={v.id}>
                <Button
                  variant="ghost"
                  className="coach-training-version"
                  aria-current={v.id === selectedId ? 'true' : undefined}
                  onClick={() => setSelectedId(v.id)}
                >
                  <span className="flex flex-col items-start gap-app-xs text-left min-w-0">
                    <span className="inline-flex items-center gap-app-xs">
                      <strong>v{v.n}</strong>
                      {v.id === state.working.id && <Badge tone="accent">Working</Badge>}
                      {v.id === state.published?.id && <Badge tone="success">Live</Badge>}
                    </span>
                    <span className="text-app-meta text-app-text-muted truncate max-w-full" title={when.title}>
                      {PROMPT_SOURCE_LABEL[v.source]} · {v.created_by_name} · {when.label}
                    </span>
                  </span>
                </Button>
              </li>
            )
          })}
        </ol>
        <div className="overflow-y-auto p-dialog flex flex-col gap-group">
          {error && <InlineError title="Couldn't load this version." message={error} />}
          {!detail && !error && <p className="m-0 text-app-meta text-app-text-muted">Loading…</p>}
          {detail && (
            <>
              <div className="flex items-center gap-app-sm">
                <h3 className="m-0 text-app-subsection font-semibold">v{detail.n} · {PROMPT_SOURCE_LABEL[detail.source]}</h3>
                {detail.id !== state.working.id && (
                  <Button variant="secondary" size="sm" className="ml-auto" loading={restoring} onClick={() => onRestore(detail)}>
                    Restore as a new version
                  </Button>
                )}
              </div>
              {detail.note && <p className="m-0 text-app-table text-app-text-secondary whitespace-pre-wrap">{detail.note}</p>}
              {detail.changelog.length > 0 && (
                <ul className="m-0 pl-app-lg text-app-table flex flex-col gap-app-xs">
                  {detail.changelog.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              )}
              {detail.unaddressed.length > 0 && (
                <div className="flex flex-col gap-app-xs">
                  <span className="text-app-meta font-semibold text-app-text-muted">Not applied</span>
                  <ul className="m-0 pl-app-lg text-app-table text-app-text-secondary">
                    {detail.unaddressed.map((line, i) => <li key={i}>{line}</li>)}
                  </ul>
                </div>
              )}
              <pre className="coach-training-diff" aria-label={detail.parent_prompt === null ? 'Prompt' : `Changes from the previous version`}>
                {diff.map((line, i) => (
                  <span key={i} data-kind={line.kind}>
                    {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '− ' : '  '}{line.text}{'\n'}
                  </span>
                ))}
              </pre>
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}
