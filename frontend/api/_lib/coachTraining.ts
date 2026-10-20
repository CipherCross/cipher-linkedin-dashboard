// The Coach training page's server: every `training.*` mode of POST /api/coach.
//
// The loop (ported from ~/work/humanizer, the Skill Trainer): the team runs the
// WORKING prompt version on real conversations, marks and comments on the
// output, and an editor model turns that feedback into a new working version.
// Publish makes a version the one every live coach runs. Hand edits, direct
// instructions and restores are versions too.
//
// Cases point at live conversations (owner decision 2026-10-20): a run reads the
// thread as it is at run time, up to the case's cut point, and records the
// marker of what it read so a later change can be shown. Runs never write
// `conversation_coaching`, so nothing the team sees changes until Publish.
//
// Every active team member may train and publish. The actor was resolved by
// the caller; RLS re-checks membership on every statement.
import {
  DataStoreSchemaError,
  type ActorContext,
  type DataStore,
} from './data/contracts.js'
import {
  COACH_TRAINING_COMMANDS,
  COACH_TRAINING_OPERATIONS,
  type ConsumedFeedbackRow,
  type ConversationSearchRow,
  type LeakSourceRow,
  type MovedPointer,
  type PendingFeedbackRow,
  type PromptStateRow,
  type PromptVersionRow,
  type TrainingCaseRow,
  type TrainingFeedbackRow,
  type TrainingRunRow,
} from './data/operations/index.js'
import {
  CONV_MODEL,
  DEFAULT_COACH_PROMPT,
  asOfForCut,
  composeCoachSystem,
  cutThread,
  renderThread,
  runCoach,
  scopeOf,
  threadMarkerOf,
  type Msg,
} from './coachCore.js'
import {
  COACH_SCOPE,
  actorName,
  allPages,
  firstRow,
  loadCoachThread,
  loadIcpForCampaign,
  loadPlaybook,
  loadPromptState,
} from './coachData.js'
import { editorInput, runEditor, type EarlierRound, type ReviewedCase } from './coachEditor.js'
import { findLeaks } from './coachLeaks.js'
import { loadCoachContext, renderContextBlocks } from './coachContext.js'

export const TRAINING_MODES = [
  'training.state',
  'training.version',
  'training.search',
  'training.case',
  'training.addCase',
  'training.setCut',
  'training.archiveCase',
  'training.run',
  'training.feedback',
  'training.improve',
  'training.instruct',
  'training.saveManual',
  'training.revert',
  'training.publish',
] as const

export type TrainingMode = (typeof TRAINING_MODES)[number]

export function isTrainingMode(mode: unknown): mode is TrainingMode {
  return typeof mode === 'string' && (TRAINING_MODES as readonly string[]).includes(mode)
}

/** Soft cap on the active training set: an improve round re-runs every case. */
export const MAX_ACTIVE_CASES = 25
const MAX_PROMPT = 40000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const bad = (error: string) => json({ error }, 400)
const stale = () => json({
  error: 'The prompt changed meanwhile (someone saved, improved or published). Reload to see the latest version.',
  code: 'STALE_REVISION',
}, 409)

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : null
}

/** The thread as the client draws it: what the coach reads, with ids. */
function clientThread(thread: readonly Msg[]) {
  return thread.map((m) => ({
    id: m.id ?? null,
    direction: m.direction,
    body: m.body,
    sent_at: m.sent_at,
    source: m.source,
    origin: m.origin,
    step_type: m.step_type,
    message_ordinal: m.message_ordinal,
  }))
}

class Training {
  constructor(private readonly store: DataStore, private readonly actor: ActorContext) {}

  // -- prompt state --------------------------------------------------------

  /** The state, creating version 1 from the built-in prompt on first use. */
  async state(): Promise<PromptStateRow | null> {
    const existing = await loadPromptState(this.store, this.actor)
    if (existing) return existing
    try {
      await this.store.transaction(this.actor, async (tx) => {
        await tx.execute({
          operation: COACH_TRAINING_COMMANDS.ensureSeed,
          params: { scope: COACH_SCOPE, prompt: DEFAULT_COACH_PROMPT, actorName: await actorName(tx) },
        })
      })
    } catch (error) {
      if (error instanceof DataStoreSchemaError) return null
      throw error
    }
    return loadPromptState(this.store, this.actor)
  }

  version(versionId: number) {
    return firstRow<PromptVersionRow>(this.store, this.actor, COACH_TRAINING_OPERATIONS.version, { versionId })
  }

  caseById(caseId: number, versionId: number) {
    return firstRow<TrainingCaseRow>(this.store, this.actor, COACH_TRAINING_OPERATIONS.caseById, { caseId, versionId })
  }

  /** A new working version, refused when the state moved since the caller read it. */
  async newVersion(args: {
    expectedRevision: number
    prompt: string
    source: 'feedback' | 'instruction' | 'manual' | 'revert'
    parentId: number
    changelog: readonly string[]
    unaddressed?: readonly string[]
    note?: string | null
    consumedFeedbackIds?: readonly number[]
  }): Promise<MovedPointer | null> {
    return this.store.transaction(this.actor, async (tx) => {
      const moved = await tx.execute<MovedPointer | null>({
        operation: COACH_TRAINING_COMMANDS.insertVersion,
        params: {
          scope: COACH_SCOPE,
          expectedRevision: args.expectedRevision,
          prompt: args.prompt,
          source: args.source,
          parentId: args.parentId,
          changelog: JSON.stringify(args.changelog),
          unaddressed: JSON.stringify(args.unaddressed ?? []),
          note: args.note ?? null,
          actorName: await actorName(tx),
        },
      })
      if (moved && args.consumedFeedbackIds?.length) {
        await tx.execute({
          operation: COACH_TRAINING_COMMANDS.markConsumed,
          params: { feedbackIds: JSON.stringify(args.consumedFeedbackIds), versionId: moved.version_id },
        })
      }
      return moved
    })
  }

  async earlierRounds(): Promise<EarlierRound[]> {
    const rows = await allPages<ConsumedFeedbackRow>(
      this.store, this.actor, COACH_TRAINING_OPERATIONS.consumedFeedback, { scope: COACH_SCOPE },
    )
    return rows.map((r) => ({
      from: r.parent_n,
      to: r.version_n,
      comments: r.comments,
      note: r.note,
      instruction: r.source === 'instruction',
    }))
  }

  // -- runs ----------------------------------------------------------------

  async run(
    caseRow: TrainingCaseRow,
    version: PromptVersionRow,
  ): Promise<{ ok: false; error: string } | { ok: true; run: (TrainingRunRow & { stale: boolean }) | null }> {
    const full = await loadCoachThread(this.store, this.actor, caseRow.instance_id, caseRow.profile_url)
    const thread = cutThread(full, caseRow.cut_after_message_id)
    if (!thread.length) return { ok: false, error: 'This conversation has no messages.' }
    const marker = threadMarkerOf(thread)
    let output: string | null = null
    let error: string | null = null
    try {
      const [playbook, icp, context] = await Promise.all([
        loadPlaybook(this.store, this.actor),
        loadIcpForCampaign(this.store, this.actor, caseRow.campaign_id),
        loadCoachContext(this.store, this.actor,
          { instance_id: caseRow.instance_id, profile_url: caseRow.profile_url }, { refresh: true })
          .catch(() => null),
      ])
      // A cut is coached at the moment the next message actually arrived, so
      // the gaps the coach sees are the ones the SDR faced.
      const asOf = asOfForCut(full, caseRow.cut_after_message_id)
      const result = await runCoach(
        composeCoachSystem(version.prompt ?? '', playbook, icp, context ? renderContextBlocks(context) : ''),
        thread, asOf,
      )
      output = JSON.stringify({ ...result, scope: scopeOf(thread) })
    } catch (e) {
      // A model failure is a result worth keeping on the card; a database one is not.
      if (e instanceof DataStoreSchemaError) throw e
      error = (e instanceof Error ? e.message : String(e)).slice(0, 500) || 'The coach failed.'
    }
    const run = await this.store.transaction(this.actor, (tx) => tx.execute<TrainingRunRow | null>({
      operation: COACH_TRAINING_COMMANDS.insertRun,
      params: {
        caseId: caseRow.id,
        versionId: version.id,
        cutAfterMessageId: caseRow.cut_after_message_id,
        threadMarker: marker,
        output,
        model: output ? CONV_MODEL : null,
        error,
      },
    }))
    return { ok: true, run: run ? { ...run, stale: false } : null }
  }
}

export async function handleTraining(
  mode: TrainingMode,
  body: Record<string, unknown>,
  store: DataStore,
  actor: ActorContext,
): Promise<Response> {
  const t = new Training(store, actor)
  const state = await t.state()
  if (!state) {
    return json({ error: 'Coach training is not set up on this database yet (ledger step 027).', code: 'NOT_MIGRATED' }, 503)
  }
  const expectedRevision = int(body.expected_revision)

  switch (mode) {
    case 'training.state': {
      const [working, versions, cases, pending, leakRows, playbook] = await Promise.all([
        t.version(state.working_version_id),
        allPages<PromptVersionRow>(store, actor, COACH_TRAINING_OPERATIONS.versions, { scope: COACH_SCOPE }),
        allPages<TrainingCaseRow>(store, actor, COACH_TRAINING_OPERATIONS.cases, { versionId: state.working_version_id }),
        allPages<PendingFeedbackRow>(store, actor, COACH_TRAINING_OPERATIONS.pendingFeedback),
        allPages<LeakSourceRow>(store, actor, COACH_TRAINING_OPERATIONS.leakSources),
        loadPlaybook(store, actor),
      ])
      const sources = leakRows.map((r) => ({ label: r.label, text: r.body }))
      if (playbook) sources.push({ label: 'playbook', text: playbook })
      return json({
        scope: COACH_SCOPE,
        revision: state.revision,
        working,
        published: state.published_version_id === null ? null : {
          id: state.published_version_id,
          n: state.published_n,
          published_at: state.published_at,
          published_by_name: state.published_by_name,
        },
        versions,
        cases,
        pending: {
          feedback: pending.length,
          comments: pending.filter((f) => f.comment).length,
          good: pending.filter((f) => f.verdict === 'good').length,
          bad: pending.filter((f) => f.verdict === 'bad').length,
          cases: new Set(pending.map((f) => f.case_id)).size,
        },
        leaks: findLeaks(working?.prompt ?? '', sources, [DEFAULT_COACH_PROMPT]),
        max_cases: MAX_ACTIVE_CASES,
      })
    }

    case 'training.version': {
      const versionId = int(body.version_id)
      if (!versionId) return bad('version_id is required')
      const version = await t.version(versionId)
      return version ? json({ version }) : json({ error: 'Version not found' }, 404)
    }

    case 'training.search': {
      const query = typeof body.query === 'string' ? body.query.trim().slice(0, 200) : ''
      const page = await store.query<ConversationSearchRow>(actor, {
        operation: COACH_TRAINING_OPERATIONS.searchConversations,
        params: { query },
        page: { limit: 30 },
      })
      return json({ results: page.items })
    }

    case 'training.case': {
      const caseId = int(body.case_id)
      if (!caseId) return bad('case_id is required')
      const caseRow = await t.caseById(caseId, state.working_version_id)
      if (!caseRow) return json({ error: 'Case not found' }, 404)
      const [thread, runs, feedback] = await Promise.all([
        loadCoachThread(store, actor, caseRow.instance_id, caseRow.profile_url),
        allPages<TrainingRunRow>(store, actor, COACH_TRAINING_OPERATIONS.caseRuns, { caseId }),
        allPages<TrainingFeedbackRow>(store, actor, COACH_TRAINING_OPERATIONS.caseFeedback, { caseId }),
      ])
      return json({
        case: caseRow,
        thread: clientThread(thread),
        runs: runs.map((r) => ({
          ...r,
          stale: threadMarkerOf(cutThread(thread, r.cut_after_message_id)) !== r.thread_marker,
        })),
        feedback,
      })
    }

    case 'training.addCase': {
      const instanceId = text(body.instance_id, 200)
      const profileUrl = text(body.profile_url, 2000)
      if (!instanceId || !profileUrl) return bad('instance_id and profile_url are required')
      const active = await allPages<TrainingCaseRow>(store, actor, COACH_TRAINING_OPERATIONS.cases, {
        versionId: state.working_version_id,
      })
      const already = active.find((c) => c.instance_id === instanceId && c.profile_url === profileUrl)
      if (already) return json({ case_id: already.id })
      if (active.length >= MAX_ACTIVE_CASES) {
        return json({ error: `The training set holds ${MAX_ACTIVE_CASES} conversations at most — remove one first.` }, 409)
      }
      const caseId = await store.transaction(actor, (tx) => tx.execute<number | null>({
        operation: COACH_TRAINING_COMMANDS.addCase,
        params: { instanceId, profileUrl, campaignId: text(body.campaign_id, 400) },
      }))
      return caseId ? json({ case_id: caseId }) : json({ error: 'That conversation has no messages.' }, 404)
    }

    case 'training.setCut': {
      const caseId = int(body.case_id)
      if (!caseId) return bad('case_id is required')
      const cut = body.cut_after_message_id === null ? null : int(body.cut_after_message_id)
      if (body.cut_after_message_id !== null && cut === null) return bad('cut_after_message_id must be a message id or null')
      const ok = await store.transaction(actor, (tx) => tx.execute<boolean>({
        operation: COACH_TRAINING_COMMANDS.setCut,
        params: { caseId, cutAfterMessageId: cut },
      }))
      return ok ? json({ ok: true }) : json({ error: 'Case or message not found' }, 404)
    }

    case 'training.archiveCase': {
      const caseId = int(body.case_id)
      if (!caseId) return bad('case_id is required')
      const ok = await store.transaction(actor, (tx) => tx.execute<boolean>({
        operation: COACH_TRAINING_COMMANDS.archiveCase,
        params: { caseId },
      }))
      return ok ? json({ ok: true }) : json({ error: 'Case not found' }, 404)
    }

    case 'training.run': {
      const caseId = int(body.case_id)
      const versionId = int(body.version_id) ?? state.working_version_id
      if (!caseId) return bad('case_id is required')
      const [caseRow, version] = await Promise.all([t.caseById(caseId, versionId), t.version(versionId)])
      if (!caseRow || !version) return json({ error: 'Case or version not found' }, 404)
      const result = await t.run(caseRow, version)
      if (!result.ok) return bad(result.error)
      return json({ run: result.run })
    }

    case 'training.feedback': {
      const runId = int(body.run_id)
      const target = body.target
      if (!runId) return bad('run_id is required')
      if (target !== 'take' && target !== 'idea' && target !== 'issue') return bad('target must be take, idea or issue')
      const targetIndex = target === 'take' ? null
        : typeof body.target_index === 'number' && Number.isInteger(body.target_index) && body.target_index >= 0
          ? body.target_index : -1
      if (targetIndex === -1) return bad('target_index is required for an idea or an issue')
      const verdict = body.verdict === 'good' || body.verdict === 'bad' ? body.verdict : null
      if (body.verdict != null && verdict === null) return bad('verdict must be good, bad or null')
      const comment = typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim().slice(0, 4000) : null
      const run = await firstRow<TrainingRunRow>(store, actor, COACH_TRAINING_OPERATIONS.runById, { runId })
      if (!run?.output) return json({ error: 'Run not found' }, 404)
      if (targetIndex !== null) {
        const list = (run.output as { ideas?: unknown[]; issues?: unknown[] })[target === 'idea' ? 'ideas' : 'issues']
        if (!Array.isArray(list) || targetIndex >= list.length) return bad('target_index is out of range')
      }
      const saved = await store.transaction(actor, async (tx) => tx.execute<TrainingFeedbackRow | null>({
        operation: COACH_TRAINING_COMMANDS.upsertFeedback,
        params: { runId, target, targetIndex, verdict, comment, actorName: await actorName(tx) },
      }))
      return saved
        ? json({ feedback: saved })
        : json({ error: 'This feedback was already used to improve the prompt and can no longer change.', code: 'CONSUMED' }, 409)
    }

    case 'training.improve': {
      if (!expectedRevision) return bad('expected_revision is required')
      if (expectedRevision !== state.revision) return stale()
      const general = typeof body.general === 'string' ? body.general.trim().slice(0, 8000) : ''
      const pending = await allPages<PendingFeedbackRow>(store, actor, COACH_TRAINING_OPERATIONS.pendingFeedback)
      if (!pending.length && !general) {
        return bad('Nothing to learn from yet: mark or comment on some coach output, or add general feedback.')
      }
      // One reviewed case per run, with the thread as that run read it.
      const byRun = new Map<number, PendingFeedbackRow[]>()
      for (const f of pending) byRun.set(f.run_id, [...(byRun.get(f.run_id) ?? []), f])
      const threads = new Map<string, Msg[]>()
      const cases: ReviewedCase[] = []
      for (const rows of byRun.values()) {
        const first = rows[0]
        const key = `${first.instance_id}|${first.profile_url}`
        if (!threads.has(key)) threads.set(key, await loadCoachThread(store, actor, first.instance_id, first.profile_url))
        const full = threads.get(key)!
        const thread = cutThread(full, first.run_cut_after_message_id)
        // The thread at the time its run saw it.
        const asOf = asOfForCut(full, first.run_cut_after_message_id, new Date(first.run_created_at))
        cases.push({
          conversation: renderThread(thread, asOf),
          promptVersion: first.version_n,
          output: (first.run_output ?? {}) as ReviewedCase['output'],
          feedback: rows.map((f) => ({ target: f.target, target_index: f.target_index, verdict: f.verdict, comment: f.comment })),
        })
      }
      const working = await t.version(state.working_version_id)
      if (!working?.prompt) return json({ error: 'Working version not found' }, 404)
      const edited = await runEditor(editorInput({
        currentPrompt: working.prompt,
        cases,
        general,
        earlier: await t.earlierRounds(),
      }), false)
      if (!edited.prompt || edited.prompt.length > MAX_PROMPT) return json({ error: 'The editor returned an unusable prompt. Try again.' }, 502)
      const moved = await t.newVersion({
        expectedRevision,
        prompt: edited.prompt,
        source: 'feedback',
        parentId: working.id,
        changelog: edited.changelog,
        unaddressed: edited.unaddressed,
        note: general || null,
        consumedFeedbackIds: pending.map((f) => f.id),
      })
      return moved ? json({ ...moved, changelog: edited.changelog, unaddressed: edited.unaddressed }) : stale()
    }

    case 'training.instruct': {
      if (!expectedRevision) return bad('expected_revision is required')
      if (expectedRevision !== state.revision) return stale()
      const instruction = text(body.instruction, 8000)
      if (!instruction) return bad('instruction is required')
      const working = await t.version(state.working_version_id)
      if (!working?.prompt) return json({ error: 'Working version not found' }, 404)
      const edited = await runEditor(editorInput({
        currentPrompt: working.prompt,
        instruction,
        earlier: await t.earlierRounds(),
      }), true)
      if (!edited.prompt || edited.prompt.length > MAX_PROMPT) return json({ error: 'The editor returned an unusable prompt. Try again.' }, 502)
      const moved = await t.newVersion({
        expectedRevision,
        prompt: edited.prompt,
        source: 'instruction',
        parentId: working.id,
        changelog: edited.changelog,
        unaddressed: edited.unaddressed,
        note: instruction,
      })
      return moved ? json({ ...moved, changelog: edited.changelog, unaddressed: edited.unaddressed }) : stale()
    }

    case 'training.saveManual': {
      if (!expectedRevision) return bad('expected_revision is required')
      const prompt = text(body.prompt, MAX_PROMPT)
      if (!prompt) return bad(`prompt is required (at most ${MAX_PROMPT} characters)`)
      if (prompt === state.working_prompt.trim()) {
        return json({ version_id: state.working_version_id, n: state.working_n, revision: state.revision, unchanged: true })
      }
      const moved = await t.newVersion({
        expectedRevision,
        prompt,
        source: 'manual',
        parentId: state.working_version_id,
        changelog: ['Edited by hand'],
      })
      return moved ? json(moved) : stale()
    }

    case 'training.revert': {
      if (!expectedRevision) return bad('expected_revision is required')
      const versionId = int(body.version_id)
      if (!versionId) return bad('version_id is required')
      const old = await t.version(versionId)
      if (!old?.prompt) return json({ error: 'Version not found' }, 404)
      const moved = await t.newVersion({
        expectedRevision,
        prompt: old.prompt,
        source: 'revert',
        parentId: state.working_version_id,
        changelog: [`Restored v${old.n}`],
      })
      return moved ? json(moved) : stale()
    }

    case 'training.publish': {
      if (!expectedRevision) return bad('expected_revision is required')
      const versionId = int(body.version_id) ?? state.working_version_id
      const moved = await store.transaction(actor, async (tx) => tx.execute<MovedPointer | null>({
        operation: COACH_TRAINING_COMMANDS.publish,
        params: { scope: COACH_SCOPE, expectedRevision, versionId, actorName: await actorName(tx) },
      }))
      return moved ? json(moved) : stale()
    }
  }
}
