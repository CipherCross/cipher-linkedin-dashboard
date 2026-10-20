import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { GraduationCap, MessagesSquare, Play, Rocket, Sparkles } from 'lucide-react'
import {
  TrainingError,
  coachTraining,
  type CoachTrainingClient,
  type PromptVersion,
  type TrainingCase,
  type TrainingCaseDetail,
  type TrainingRun,
  type TrainingState,
} from '../lib/coachTraining'
import { useToast } from '../lib/ToastContext'
import {
  Badge, Button, Dialog, EmptyState, InlineError, PageHeader, SelectField, Tabs, TextField, useDirtyGuard,
} from '../ui'
import { CaseList, AddCaseDialog } from '../components/coach-training/CaseList'
import { CaseThread } from '../components/coach-training/CaseThread'
import { HistoryDialog } from '../components/coach-training/HistoryDialog'
import { PromptPane } from '../components/coach-training/PromptPane'
import { RunReview, type FeedbackChange } from '../components/coach-training/RunReview'
import { Skeleton } from '../components/Skeleton'

type SideTab = 'set' | 'prompt'
const RUN_CONCURRENCY = 4

const caseName = (c: Pick<TrainingCase, 'full_name' | 'profile_url'>) =>
  c.full_name || c.profile_url.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '') || 'LinkedIn contact'

/** The run to show for a version: the latest on the case's current cut, else
 *  the latest on any cut. Runs arrive newest first. */
function runFor(runs: readonly TrainingRun[], versionId: number, cut: number | null): TrainingRun | null {
  return runs.find((r) => r.version_id === versionId && r.cut_after_message_id === cut)
    ?? runs.find((r) => r.version_id === versionId)
    ?? null
}

/**
 * Coach training: improve the AI coach's prompt on real conversations. Pick
 * conversations, read the coach's take on each with the working prompt, mark
 * and comment, then let the AI turn the feedback into a new version — or edit
 * the prompt by hand. Publish makes a version the one every coach runs.
 */
export function CoachTraining({ client = coachTraining }: { client?: CoachTrainingClient }) {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const selectedCaseId = Number(params.get('case')) || null
  const [state, setState] = useState<TrainingState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sideTab, setSideTab] = useState<SideTab>('set')
  const [detail, setDetail] = useState<TrainingCaseDetail | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [running, setRunning] = useState<ReadonlySet<number>>(new Set())
  const [viewVersionId, setViewVersionId] = useState<number | null>(null)
  const [compareVersionId, setCompareVersionId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [general, setGeneral] = useState('')
  const [busy, setBusy] = useState<null | 'save' | 'instruct' | 'improve' | 'publish' | 'restore' | 'cut'>(null)
  const [dialog, setDialog] = useState<null | 'add' | 'history' | 'publish'>(null)
  const [roundResult, setRoundResult] = useState<{ n: number; changelog: string[]; unaddressed: string[] } | null>(null)
  const autoRan = useRef(new Set<string>())

  const working = state?.working ?? null
  const draftDirty = !!working && draft.trim() !== (working.prompt ?? '').trim()
  const { guard, prompt: discardPrompt } = useDirtyGuard(draftDirty)

  const fail = useCallback((e: unknown, what: string) => {
    if (e instanceof TrainingError && e.code === 'STALE_REVISION') {
      toast.error('Someone changed the prompt meanwhile — the latest version is loaded.')
    } else {
      toast.error(`${what}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [toast])

  const reloadState = useCallback(async () => {
    try {
      const next = await client.state()
      setState(next)
      setLoadError(null)
      return next
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [client])

  useEffect(() => { void reloadState() }, [reloadState])

  // A new working version replaces the editor's text; a hand edit in
  // progress is never overwritten because every path that creates a version
  // first asks to discard it.
  const workingId = working?.id
  useEffect(() => { if (working) setDraft(working.prompt ?? '') }, [workingId]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadDetail = useCallback(async (caseId: number) => {
    try {
      const next = await client.caseDetail(caseId)
      setDetail((prev) => (prev && prev.case.id !== caseId ? prev : next))
      setDetailError(null)
      return next
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [client])

  useEffect(() => {
    setDetail(null)
    setDetailError(null)
    setViewVersionId(null)
    setCompareVersionId(null)
    if (selectedCaseId) void loadDetail(selectedCaseId)
  }, [selectedCaseId, loadDetail])

  const select = (caseId: number | null) => {
    const next = new URLSearchParams(params)
    if (caseId) next.set('case', String(caseId))
    else next.delete('case')
    setParams(next, { replace: true })
  }

  /** Run the given cases on a version, a few at a time; each card shows its own progress. */
  const runCases = useCallback(async (caseIds: readonly number[], versionId: number) => {
    const queue = [...caseIds]
    setRunning((prev) => new Set([...prev, ...queue]))
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          await client.run(id, versionId)
        } catch (e) {
          fail(e, 'The coach run failed')
        } finally {
          setRunning((prev) => { const next = new Set(prev); next.delete(id!); return next })
          if (id === selectedCaseId) void loadDetail(id)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(RUN_CONCURRENCY, queue.length) }, worker))
    void reloadState()
  }, [client, fail, loadDetail, reloadState, selectedCaseId])

  // Opening a conversation shows the working prompt's take on it: run it once
  // when there is none for the current cut.
  useEffect(() => {
    if (!detail || !working) return
    const cut = detail.case.cut_after_message_id
    const has = detail.runs.some((r) => r.version_id === working.id && r.cut_after_message_id === cut)
    const key = `${detail.case.id}|${working.id}|${cut ?? 0}`
    if (has || running.has(detail.case.id) || autoRan.current.has(key) || detail.thread.length === 0) return
    autoRan.current.add(key)
    void runCases([detail.case.id], working.id)
  }, [detail, working, running, runCases])

  const viewedVersionId = viewVersionId ?? working?.id ?? null
  const viewedRun = detail && viewedVersionId ? runFor(detail.runs, viewedVersionId, detail.case.cut_after_message_id) : null
  const compareRun = detail && compareVersionId ? runFor(detail.runs, compareVersionId, detail.case.cut_after_message_id) : null

  const versionOptions = useMemo(() => {
    if (!state) return []
    const ran = new Set(detail?.runs.map((r) => r.version_id) ?? [])
    return state.versions.filter((v) => v.id === state.working.id || ran.has(v.id))
  }, [state, detail])

  const onFeedback = async (run: TrainingRun, change: FeedbackChange) => {
    try {
      const { feedback } = await client.feedback({ runId: run.id, ...change })
      setDetail((prev) => prev && ({
        ...prev,
        feedback: [...prev.feedback.filter((f) => f.id !== feedback.id), feedback],
      }))
      void reloadState()
    } catch (e) {
      fail(e, "Couldn't save the mark")
      if (selectedCaseId) void loadDetail(selectedCaseId)
    }
  }

  /** After a new working version: re-run the conversations the round learned from. */
  const afterNewVersion = async (n: number, rerun: readonly number[]) => {
    const next = await reloadState()
    setViewVersionId(null)
    setCompareVersionId(null)
    if (next && rerun.length) void runCases(rerun.filter((id) => id !== selectedCaseId), next.working.id)
    toast.success(`Prompt v${n} is the working version.`)
  }

  const improve = () => guard(async () => {
    if (!state) return
    setDraft(state.working.prompt ?? '')
    setBusy('improve')
    const learnedFrom = state.cases.filter((c) => c.pending_feedback > 0).map((c) => c.id)
    try {
      const moved = await client.improve(state.revision, general)
      setGeneral('')
      setRoundResult({ n: moved.n, changelog: moved.changelog ?? [], unaddressed: moved.unaddressed ?? [] })
      await afterNewVersion(moved.n, learnedFrom)
    } catch (e) {
      fail(e, "Couldn't improve the prompt")
      void reloadState()
    } finally {
      setBusy(null)
    }
  })

  const instruct = async (instruction: string): Promise<boolean> => {
    if (!state || !instruction) return false
    setBusy('instruct')
    try {
      const moved = await client.instruct(state.revision, instruction)
      setRoundResult({ n: moved.n, changelog: moved.changelog ?? [], unaddressed: moved.unaddressed ?? [] })
      await afterNewVersion(moved.n, [])
      return true
    } catch (e) {
      fail(e, "Couldn't apply the instruction")
      void reloadState()
      return false
    } finally {
      setBusy(null)
    }
  }

  const saveManual = async () => {
    if (!state) return
    setBusy('save')
    try {
      const moved = await client.saveManual(state.revision, draft)
      if (moved.unchanged) return
      await afterNewVersion(moved.n, [])
    } catch (e) {
      fail(e, "Couldn't save the prompt")
      void reloadState()
    } finally {
      setBusy(null)
    }
  }

  const restore = (version: PromptVersion) => guard(async () => {
    if (!state) return
    setBusy('restore')
    try {
      const moved = await client.revert(state.revision, version.id)
      setDialog(null)
      await afterNewVersion(moved.n, [])
    } catch (e) {
      fail(e, "Couldn't restore the version")
      void reloadState()
    } finally {
      setBusy(null)
    }
  })

  const publish = async () => {
    if (!state) return
    setBusy('publish')
    try {
      const moved = await client.publish(state.revision, state.working.id)
      setDialog(null)
      await reloadState()
      toast.success(`Prompt v${moved.n} is live for every coach.`)
    } catch (e) {
      fail(e, "Couldn't publish")
      void reloadState()
    } finally {
      setBusy(null)
    }
  }

  const setCut = async (messageId: number | null) => {
    if (!detail) return
    setBusy('cut')
    try {
      await client.setCut(detail.case.id, messageId)
      await loadDetail(detail.case.id)
      void reloadState()
    } catch (e) {
      fail(e, "Couldn't set the cut")
    } finally {
      setBusy(null)
    }
  }

  const archive = async (c: TrainingCase) => {
    try {
      await client.archiveCase(c.id)
      if (c.id === selectedCaseId) select(null)
      void reloadState()
    } catch (e) {
      fail(e, "Couldn't remove the conversation")
    }
  }

  if (loadError && !state) {
    return (
      <div className="coach-training-page">
        <PageHeader title="Coach training" />
        <InlineError title="Coach training could not load." message={loadError} onRetry={() => void reloadState()} />
      </div>
    )
  }
  if (!state || !working) {
    return (
      <div className="coach-training-page">
        <PageHeader title="Coach training" />
        <Skeleton height={480} radius="var(--radius-card)" />
      </div>
    )
  }

  const published = state.published
  const workingIsLive = published?.id === working.id
  const pendingTotal = state.pending.feedback
  const selectedCase = state.cases.find((c) => c.id === selectedCaseId) ?? detail?.case ?? null

  return (
    <div className="coach-training-page">
      <div className="coach-training-head">
        <PageHeader
          title="Coach training"
          context={
            <span className="inline-flex items-center gap-app-sm">
              <Badge tone="success">Live: {published ? `v${published.n}` : 'built-in prompt'}</Badge>
              <Badge tone="accent">Working: v{working.n}</Badge>
            </span>
          }
          actions={
            <Button
              variant="primary"
              icon={<Rocket aria-hidden="true" />}
              disabled={workingIsLive || draftDirty}
              title={draftDirty ? 'Save or discard your hand edit first' : undefined}
              onClick={() => setDialog('publish')}
            >
              {workingIsLive ? `v${working.n} is live` : `Publish v${working.n}`}
            </Button>
          }
        />
      </div>

      <div className="coach-training-workspace" data-side={sideTab}>
        <section className="coach-training-pane" aria-label="Training">
          <div className="coach-training-pane-head">
            <Tabs
              label="Training"
              value={sideTab}
              onChange={setSideTab}
              items={[
                { id: 'set', label: 'Conversations', count: state.cases.length },
                { id: 'prompt', label: `Prompt v${working.n}`, count: state.leaks.length || undefined },
              ]}
            />
          </div>
          {sideTab === 'set' ? (
            <CaseList
              cases={state.cases}
              maxCases={state.max_cases}
              workingN={working.n}
              selectedId={selectedCaseId}
              running={running}
              onSelect={select}
              onAdd={() => setDialog('add')}
              onArchive={(c) => void archive(c)}
              onRunAll={() => void runCases(state.cases.filter((c) => !c.run_id && !running.has(c.id)).map((c) => c.id), working.id)}
            />
          ) : (
            <PromptPane
              state={state}
              draft={draft}
              onDraftChange={setDraft}
              saving={busy === 'save'}
              instructing={busy === 'instruct'}
              onSave={() => void saveManual()}
              onInstruct={instruct}
              onOpenHistory={() => setDialog('history')}
              onGeneralizeLeaks={() => void instruct(
                'The overfitting check found these phrases copied from training conversations, comments or the playbook. '
                + 'Rewrite each as the general rule it stands for, without the copied wording: '
                + state.leaks.map((l) => `"${l.phrase}"`).join('; '),
              )}
            />
          )}
        </section>

        {detail && compareVersionId ? (
          <section className="coach-training-pane" aria-label="Compared version">
            <div className="coach-training-pane-head">
              <h2 className="coach-training-pane-title">
                Compared: v{state.versions.find((v) => v.id === compareVersionId)?.n}
              </h2>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setCompareVersionId(null)}>
                Show conversation
              </Button>
            </div>
            <div className="coach-training-pane-body flex flex-col gap-group">
              {compareRun
                ? <RunReview run={compareRun} feedback={detail.feedback} onFeedback={(change) => onFeedback(compareRun, change)} />
                : (
                  <div className="flex flex-col items-start gap-group">
                    <p className="m-0 text-app-meta text-app-text-muted">No run on that version for this conversation yet.</p>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Play aria-hidden="true" />}
                      loading={running.has(detail.case.id)}
                      onClick={() => void runCases([detail.case.id], compareVersionId)}
                    >
                      Run on v{state.versions.find((v) => v.id === compareVersionId)?.n}
                    </Button>
                  </div>
                )}
            </div>
          </section>
        ) : (
        <section className="coach-training-pane" aria-label="Conversation">
          <div className="coach-training-pane-head">
            <h2 className="coach-training-pane-title truncate">{selectedCase ? caseName(selectedCase) : 'Conversation'}</h2>
            {selectedCase?.headline && <span className="text-app-meta text-app-text-muted truncate">{selectedCase.headline}</span>}
          </div>
          <div className="coach-training-pane-body">
            {!selectedCaseId && (
              <EmptyState
                icon={MessagesSquare}
                title="Pick a conversation"
                hint={state.cases.length ? 'Choose one from the list to see the coach’s take on it.' : 'Add a conversation to start training.'}
                action={state.cases.length ? undefined : <Button variant="secondary" size="sm" onClick={() => setDialog('add')}>Add conversation</Button>}
              />
            )}
            {selectedCaseId && detailError && (
              <InlineError title="The conversation could not load." message={detailError} onRetry={() => void loadDetail(selectedCaseId)} />
            )}
            {selectedCaseId && !detail && !detailError && <Skeleton height={240} radius="var(--radius-card)" />}
            {detail && (
              <CaseThread
                thread={detail.thread}
                cutAfterMessageId={detail.case.cut_after_message_id}
                onCut={(id) => void setCut(id)}
                cutting={busy === 'cut'}
              />
            )}
          </div>
        </section>
        )}

        <section className="coach-training-pane" aria-label="Coach output">
          <div className="coach-training-pane-head">
            <Sparkles size={16} className="text-app-accent shrink-0" aria-hidden="true" />
            <h2 className="coach-training-pane-title">Coach</h2>
            {detail && versionOptions.length > 0 && (
              <SelectField
                label="Prompt version"
                labelHidden
                className="ml-auto coach-training-version-select"
                value={String(viewedVersionId ?? '')}
                onChange={(e) => setViewVersionId(Number(e.target.value))}
              >
                {versionOptions.map((v) => (
                  <option key={v.id} value={v.id}>v{v.n}{v.id === working.id ? ' (working)' : ''}{v.id === published?.id ? ' (live)' : ''}</option>
                ))}
              </SelectField>
            )}
          </div>
          <div className="coach-training-pane-body flex flex-col gap-group">
            {!detail && <p className="m-0 text-app-meta text-app-text-muted">The coach’s take on the selected conversation appears here.</p>}
            {detail && selectedCaseId && running.has(selectedCaseId) && !viewedRun && (
              <div className="flex flex-col gap-group" aria-hidden="true">
                <p className="m-0 text-app-meta text-app-text-muted">Running the coach on v{working.n}…</p>
                <Skeleton height={64} radius="var(--radius-card)" />
                {[0, 1, 2].map((i) => <Skeleton key={i} height={96} radius="var(--radius-card)" />)}
              </div>
            )}
            {detail && viewedVersionId && (
              <div className="flex items-center gap-app-sm flex-wrap">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Play aria-hidden="true" />}
                  loading={running.has(detail.case.id)}
                  loadingLabel="Running…"
                  onClick={() => void runCases([detail.case.id], viewedVersionId)}
                >
                  {viewedRun ? 'Run again' : 'Run'} on v{state.versions.find((v) => v.id === viewedVersionId)?.n ?? working.n}
                </Button>
                {state.versions.length > 1 && (
                  <SelectField
                    label="Compare with"
                    labelHidden
                    className="coach-training-version-select"
                    value={String(compareVersionId ?? '')}
                    onChange={(e) => setCompareVersionId(e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">Compare with…</option>
                    {state.versions.filter((v) => v.id !== viewedVersionId).map((v) => (
                      <option key={v.id} value={v.id}>v{v.n}</option>
                    ))}
                  </SelectField>
                )}
              </div>
            )}
            {detail && viewedRun && (
              <RunReview run={viewedRun} feedback={detail.feedback} onFeedback={(change) => onFeedback(viewedRun, change)} />
            )}
          </div>
        </section>
      </div>

      <form
        className="coach-training-bar"
        aria-label="Improve the prompt"
        onSubmit={(e) => { e.preventDefault(); improve() }}
      >
        <GraduationCap size={16} className="text-app-text-muted shrink-0" aria-hidden="true" />
        <span className="text-app-table whitespace-nowrap">
          {pendingTotal === 0
            ? 'No feedback waiting'
            : `${state.pending.comments} ${state.pending.comments === 1 ? 'comment' : 'comments'} · ${state.pending.good} good · ${state.pending.bad} bad across ${state.pending.cases} ${state.pending.cases === 1 ? 'conversation' : 'conversations'}`}
        </span>
        <TextField
          className="flex-1"
          label="General feedback"
          labelHidden
          placeholder="General feedback for this round (optional)"
          value={general}
          onChange={(e) => setGeneral(e.target.value)}
        />
        <Button
          type="submit"
          variant="primary"
          icon={<Sparkles aria-hidden="true" />}
          disabled={pendingTotal === 0 && !general.trim()}
          loading={busy === 'improve'}
          loadingLabel="Improving the prompt…"
        >
          Improve prompt
        </Button>
      </form>

      {dialog === 'add' && (
        <AddCaseDialog
          client={client}
          onClose={() => setDialog(null)}
          onAdded={(caseId) => {
            setDialog(null)
            setSideTab('set')
            select(caseId)
            void reloadState()
          }}
        />
      )}
      {dialog === 'history' && (
        <HistoryDialog
          client={client}
          state={state}
          restoring={busy === 'restore'}
          onClose={() => setDialog(null)}
          onRestore={(v) => restore(v)}
        />
      )}
      {dialog === 'publish' && (
        <Dialog
          title={`Publish prompt v${working.n}?`}
          size="sm"
          busy={busy === 'publish'}
          onRequestClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)} disabled={busy === 'publish'}>Cancel</Button>
              <Button variant="primary" loading={busy === 'publish'} onClick={() => void publish()}>Publish v{working.n}</Button>
            </>
          }
        >
          <p className="m-0 text-app-table">
            Every coach in the conversation workspace will use v{working.n}, replacing {published ? `v${published.n}` : 'the built-in prompt'}.
            Saved takes stay until someone opens the coach on a conversation; it then regenerates with v{working.n}.
          </p>
        </Dialog>
      )}
      {roundResult && (
        <Dialog
          title={`v${roundResult.n} — what changed`}
          size="md"
          onRequestClose={() => setRoundResult(null)}
          footer={<Button variant="primary" onClick={() => setRoundResult(null)}>Done</Button>}
        >
          <div className="flex flex-col gap-group text-app-table">
            {roundResult.changelog.length > 0
              ? <ul className="m-0 pl-app-lg flex flex-col gap-app-xs">{roundResult.changelog.map((line, i) => <li key={i}>{line}</li>)}</ul>
              : <p className="m-0 text-app-text-muted">No change was needed.</p>}
            {roundResult.unaddressed.length > 0 && (
              <div className="flex flex-col gap-app-xs">
                <strong>Not applied</strong>
                <ul className="m-0 pl-app-lg text-app-text-secondary">{roundResult.unaddressed.map((line, i) => <li key={i}>{line}</li>)}</ul>
              </div>
            )}
            <p className="m-0 text-app-meta text-app-text-muted">The conversations you marked are running on v{roundResult.n} now — check that the advice improved.</p>
          </div>
        </Dialog>
      )}
      {discardPrompt}
    </div>
  )
}
