import { useEffect, useState } from 'react'
import { AlertTriangle, History, Sparkles } from 'lucide-react'
import { PROMPT_SOURCE_LABEL, type TrainingState } from '../../lib/coachTraining'
import { Badge, Button, Textarea, TextareaField, relativeTime } from '../../ui'

/**
 * The working prompt: edited by hand (Save creates a version), changed by a
 * direct instruction to the AI, or replaced from History. What the working
 * version changed, and what it could not apply, sits under the editor.
 */
export function PromptPane({
  state,
  draft,
  onDraftChange,
  saving,
  instructing,
  onSave,
  onInstruct,
  onOpenHistory,
  onGeneralizeLeaks,
}: {
  state: TrainingState
  draft: string
  onDraftChange: (value: string) => void
  saving: boolean
  instructing: boolean
  onSave: () => void
  onInstruct: (instruction: string) => Promise<boolean>
  onOpenHistory: () => void
  onGeneralizeLeaks: () => void
}) {
  const working = state.working
  const dirty = draft.trim() !== (working.prompt ?? '').trim()
  const [instruction, setInstruction] = useState('')
  useEffect(() => { setInstruction('') }, [working.id])
  const when = relativeTime(working.created_at)

  return (
    <div className="coach-training-pane-body flex flex-col gap-group">
      <div className="flex items-center gap-app-sm flex-wrap">
        <Badge tone="accent">Working v{working.n}</Badge>
        <span className="text-app-meta text-app-text-muted" title={when.title}>
          {PROMPT_SOURCE_LABEL[working.source]} · {working.created_by_name} · {when.label}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto" icon={<History aria-hidden="true" />} onClick={onOpenHistory}>
          History ({state.versions.length})
        </Button>
      </div>

      {state.leaks.length > 0 && (
        <div className="flex flex-col items-start gap-app-sm p-card rounded-card bg-app-warning-subtle text-app-warning" role="status">
          <span className="inline-flex items-center gap-app-sm font-semibold text-app-table">
            <AlertTriangle size={16} aria-hidden="true" />
            {state.leaks.length} {state.leaks.length === 1 ? 'phrase was' : 'phrases were'} copied from the training data
          </span>
          <ul className="m-0 pl-app-lg text-app-meta">
            {state.leaks.slice(0, 4).map((leak, i) => (
              <li key={i}>“{leak.phrase}” <span className="opacity-80">— from a {leak.source}</span></li>
            ))}
          </ul>
          <Button variant="secondary" size="sm" loading={instructing} onClick={onGeneralizeLeaks}>Generalize these</Button>
        </div>
      )}

      <Textarea
        aria-label="Coach prompt"
        className="coach-training-prompt"
        value={draft}
        spellCheck={false}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <div className="flex items-center gap-app-sm">
        <Button variant="primary" size="sm" disabled={!dirty || !draft.trim()} loading={saving} onClick={onSave}>
          Save as v{state.versions[0] ? state.versions[0].n + 1 : working.n + 1}
        </Button>
        {dirty && (
          <Button variant="ghost" size="sm" disabled={saving} onClick={() => onDraftChange(working.prompt ?? '')}>
            Discard edit
          </Button>
        )}
        {dirty && <span className="text-app-meta text-app-text-muted">Unsaved changes</span>}
      </div>

      <form
        className="flex flex-col gap-stack"
        onSubmit={async (e) => {
          e.preventDefault()
          if (await onInstruct(instruction.trim())) setInstruction('')
        }}
      >
        <TextareaField
          label="Tell the AI what to change"
          rows={3}
          value={instruction}
          disabled={dirty}
          placeholder="e.g. Add a rule: when the prospect asks about price, answer with a range before proposing a call."
          help={dirty ? 'Save or discard your hand edit first.' : 'Creates a new version; your feedback is not used.'}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="self-start"
          icon={<Sparkles aria-hidden="true" />}
          disabled={!instruction.trim() || dirty}
          loading={instructing}
          loadingLabel="Rewriting the prompt…"
        >
          Apply instruction
        </Button>
      </form>

      {(working.changelog.length > 0 || working.unaddressed.length > 0) && (
        <section className="flex flex-col gap-stack" aria-label={`What v${working.n} changed`}>
          <h3 className="m-0 text-app-meta font-semibold uppercase tracking-[var(--tracking-caps)] text-app-text-muted">
            What v{working.n} changed
          </h3>
          <ul className="m-0 pl-app-lg text-app-table flex flex-col gap-app-xs">
            {working.changelog.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
          {working.unaddressed.length > 0 && (
            <>
              <h3 className="m-0 text-app-meta font-semibold uppercase tracking-[var(--tracking-caps)] text-app-text-muted">Not applied</h3>
              <ul className="m-0 pl-app-lg text-app-table text-app-text-secondary flex flex-col gap-app-xs">
                {working.unaddressed.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  )
}
