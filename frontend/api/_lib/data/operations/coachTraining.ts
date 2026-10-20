/**
 * The coach's versioned prompt and its training workspace (ledger step 027).
 *
 * Read by two callers: the live coach (`/api/coach`, the published version) and
 * the training modes of the same endpoint. Every statement is a fixed text with
 * bound parameters; lists of ids cross as a JSON string, the way
 * `libraryWrites.ts` passes a patch, because `DataStoreParam` admits no objects.
 *
 * ## Concurrency
 *
 * `coach_prompt_state.revision` is the one optimistic lock. Every statement
 * that moves the working or published pointer names the revision the caller
 * saw, locks the state row, and answers no row when it has moved — the handler
 * turns that into a 409. A new version is written in the same statement as the
 * pointer move, so a refused move leaves no orphan version.
 *
 * ## No DELETE
 *
 * A case is archived, feedback is cleared (verdict and comment NULL), versions
 * and runs are append-only. Step 027 grants no DELETE.
 */

import type { NeonCommandOperation, NeonQueryOperation, NeonRow } from '../neon.js'

export const COACH_TRAINING_OPERATIONS = {
  promptState: 'coachTraining.promptState',
  versions: 'coachTraining.versions',
  version: 'coachTraining.version',
  cases: 'coachTraining.cases',
  caseById: 'coachTraining.caseById',
  caseRuns: 'coachTraining.caseRuns',
  runById: 'coachTraining.runById',
  caseFeedback: 'coachTraining.caseFeedback',
  pendingFeedback: 'coachTraining.pendingFeedback',
  consumedFeedback: 'coachTraining.consumedFeedback',
  leakSources: 'coachTraining.leakSources',
  searchConversations: 'coachTraining.searchConversations',
} as const

export const COACH_TRAINING_COMMANDS = {
  ensureSeed: 'coachTraining.ensureSeed',
  insertVersion: 'coachTraining.insertVersion',
  publish: 'coachTraining.publish',
  markConsumed: 'coachTraining.markConsumed',
  addCase: 'coachTraining.addCase',
  setCut: 'coachTraining.setCut',
  archiveCase: 'coachTraining.archiveCase',
  insertRun: 'coachTraining.insertRun',
  upsertFeedback: 'coachTraining.upsertFeedback',
} as const

const text = (row: NeonRow, column: string): string => String(row[column])
const nullableText = (row: NeonRow, column: string): string | null =>
  row[column] === null || row[column] === undefined ? null : String(row[column])
const nullableNumber = (row: NeonRow, column: string): number | null =>
  row[column] === null || row[column] === undefined ? null : Number(row[column])
const jsonArray = (row: NeonRow, column: string): unknown[] =>
  Array.isArray(row[column]) ? (row[column] as unknown[]) : []

// ---------------------------------------------------------------------------
// Prompt state and versions
// ---------------------------------------------------------------------------

export interface ScopeParams {
  readonly scope: string
  readonly [key: string]: string
}

export interface PromptStateRow {
  readonly scope: string
  readonly revision: number
  readonly working_version_id: number
  readonly working_n: number
  readonly working_prompt: string
  readonly published_version_id: number | null
  readonly published_n: number | null
  readonly published_prompt: string | null
  readonly published_at: string | null
  readonly published_by_name: string | null
}

export const promptStateOperation: NeonQueryOperation<PromptStateRow, ScopeParams> = {
  build: ({ params }) => ({
    text: `SELECT s.scope, s.revision, s.working_version_id, w.n AS working_n, w.prompt AS working_prompt,
                  s.published_version_id, p.n AS published_n, p.prompt AS published_prompt,
                  s.published_at, s.published_by_name
             FROM public.coach_prompt_state s
             JOIN public.coach_prompt_versions w ON w.id = s.working_version_id
             LEFT JOIN public.coach_prompt_versions p ON p.id = s.published_version_id
            WHERE s.scope = $1`,
    values: [params?.scope ?? 'global'],
  }),
  mapRow: (row) => ({
    scope: text(row, 'scope'),
    revision: Number(row.revision),
    working_version_id: Number(row.working_version_id),
    working_n: Number(row.working_n),
    working_prompt: text(row, 'working_prompt'),
    published_version_id: nullableNumber(row, 'published_version_id'),
    published_n: nullableNumber(row, 'published_n'),
    published_prompt: nullableText(row, 'published_prompt'),
    published_at: nullableText(row, 'published_at'),
    published_by_name: nullableText(row, 'published_by_name'),
  }),
}

export interface PromptVersionRow {
  readonly id: number
  readonly n: number
  readonly source: string
  readonly parent_id: number | null
  readonly changelog: unknown[]
  readonly unaddressed: unknown[]
  readonly note: string | null
  readonly created_by_name: string
  readonly created_at: string
  /** Only `coachTraining.version` carries the text; the history list does not. */
  readonly prompt: string | null
  readonly parent_prompt: string | null
}

const mapVersion = (row: NeonRow): PromptVersionRow => ({
  id: Number(row.id),
  n: Number(row.n),
  source: text(row, 'source'),
  parent_id: nullableNumber(row, 'parent_id'),
  changelog: jsonArray(row, 'changelog'),
  unaddressed: jsonArray(row, 'unaddressed'),
  note: nullableText(row, 'note'),
  created_by_name: text(row, 'created_by_name'),
  created_at: text(row, 'created_at'),
  prompt: nullableText(row, 'prompt'),
  parent_prompt: nullableText(row, 'parent_prompt'),
})

/** Newest first; `n` is unique per scope, so the order is total. */
export const versionsOperation: NeonQueryOperation<PromptVersionRow, ScopeParams> = {
  build: ({ params }) => ({
    text: `SELECT v.id, v.n, v.source, v.parent_id, v.changelog, v.unaddressed, v.note,
                  v.created_by_name, v.created_at, NULL::text AS prompt, NULL::text AS parent_prompt
             FROM public.coach_prompt_versions v
            WHERE v.scope = $1
            ORDER BY v.n DESC`,
    values: [params?.scope ?? 'global'],
  }),
  mapRow: mapVersion,
}

export interface VersionParams {
  readonly versionId: number
  readonly [key: string]: number
}

export const versionOperation: NeonQueryOperation<PromptVersionRow, VersionParams> = {
  build: ({ params }) => ({
    text: `SELECT v.id, v.n, v.source, v.parent_id, v.changelog, v.unaddressed, v.note,
                  v.created_by_name, v.created_at, v.prompt, p.prompt AS parent_prompt
             FROM public.coach_prompt_versions v
             LEFT JOIN public.coach_prompt_versions p ON p.id = v.parent_id
            WHERE v.id = $1`,
    values: [params?.versionId ?? null],
  }),
  mapRow: mapVersion,
}

/** Creates version 1 and the state row the first time a scope is used, from
 *  the app's built-in prompt. Racing callers both succeed; one writes. */
export interface EnsureSeedParams {
  readonly scope: string
  readonly prompt: string
  readonly actorName: string
  readonly [key: string]: string
}

export const ensureSeedOperation: NeonCommandOperation<void, EnsureSeedParams> = {
  build: ({ params, actor }) => {
    if (!params) throw new Error('coachTraining.ensureSeed requires parameters')
    return {
      text: `WITH v AS (
               INSERT INTO public.coach_prompt_versions
                      (scope, n, prompt, source, changelog, created_by, created_by_name)
               SELECT $1, 1, $2, 'seed', '["Seeded from the built-in coach prompt"]'::jsonb, $3::uuid, $4
                WHERE NOT EXISTS (SELECT 1 FROM public.coach_prompt_versions WHERE scope = $1)
               ON CONFLICT (scope, n) DO NOTHING
               RETURNING id
             )
             INSERT INTO public.coach_prompt_state (scope, working_version_id)
             SELECT $1, v.id FROM v
             ON CONFLICT (scope) DO NOTHING`,
      values: [params.scope, params.prompt, actor.actorId, params.actorName],
    }
  },
}

export interface InsertVersionParams {
  readonly scope: string
  readonly expectedRevision: number
  readonly prompt: string
  readonly source: string
  readonly parentId: number | null
  readonly changelog: string
  readonly unaddressed: string
  readonly note: string | null
  readonly actorName: string
  readonly [key: string]: string | number | null
}

export interface MovedPointer {
  readonly version_id: number
  readonly n: number
  readonly revision: number
}

const mapMoved = (rows: readonly NeonRow[]): MovedPointer | null => {
  const row = rows[0]
  return row ? { version_id: Number(row.version_id), n: Number(row.n), revision: Number(row.revision) } : null
}

/** A new version that becomes the working one — only if the state is still at
 *  the revision the caller saw. No row back means it moved. */
export const insertVersionOperation: NeonCommandOperation<MovedPointer | null, InsertVersionParams> = {
  build: ({ params, actor }) => {
    if (!params) throw new Error('coachTraining.insertVersion requires parameters')
    return {
      text: `WITH s AS (
               SELECT scope FROM public.coach_prompt_state
                WHERE scope = $1 AND revision = $2
                  FOR UPDATE
             ), v AS (
               INSERT INTO public.coach_prompt_versions
                      (scope, n, prompt, source, parent_id, changelog, unaddressed, note,
                       created_by, created_by_name)
               SELECT s.scope,
                      (SELECT coalesce(max(x.n), 0) + 1 FROM public.coach_prompt_versions x WHERE x.scope = s.scope),
                      $3, $4, $5::bigint, $6::jsonb, $7::jsonb, $8, $9::uuid, $10
                 FROM s
               RETURNING id, n
             ), u AS (
               UPDATE public.coach_prompt_state st
                  SET working_version_id = v.id, revision = st.revision + 1
                 FROM v
                WHERE st.scope = $1
               RETURNING st.revision
             )
             SELECT v.id AS version_id, v.n, u.revision FROM v, u`,
      values: [
        params.scope, params.expectedRevision, params.prompt, params.source, params.parentId,
        params.changelog, params.unaddressed, params.note, actor.actorId, params.actorName,
      ],
    }
  },
  mapResult: mapMoved,
}

export interface PublishParams {
  readonly scope: string
  readonly expectedRevision: number
  readonly versionId: number
  readonly actorName: string
  readonly [key: string]: string | number
}

export const publishOperation: NeonCommandOperation<MovedPointer | null, PublishParams> = {
  build: ({ params, actor }) => {
    if (!params) throw new Error('coachTraining.publish requires parameters')
    return {
      text: `UPDATE public.coach_prompt_state st
                SET published_version_id = v.id, revision = st.revision + 1,
                    published_at = now(), published_by = $4::uuid, published_by_name = $5
               FROM public.coach_prompt_versions v
              WHERE st.scope = $1 AND st.revision = $2 AND v.id = $3 AND v.scope = st.scope
             RETURNING v.id AS version_id, v.n, st.revision`,
      values: [params.scope, params.expectedRevision, params.versionId, actor.actorId, params.actorName],
    }
  },
  mapResult: mapMoved,
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface TrainingCaseRow {
  readonly id: number
  readonly instance_id: string
  readonly profile_url: string
  readonly campaign_id: string | null
  readonly cut_after_message_id: number | null
  readonly note: string | null
  readonly created_at: string
  readonly full_name: string | null
  readonly headline: string | null
  readonly message_count: number
  readonly last_in_at: string | null
  /** The latest run on the version asked about, if any. */
  readonly run_id: number | null
  readonly run_at: string | null
  readonly run_error: string | null
  readonly run_cut_after_message_id: number | null
  readonly pending_feedback: number
}

const CASE_COLUMNS = `c.id, c.instance_id, c.profile_url, c.campaign_id, c.cut_after_message_id, c.note, c.created_at,
       coalesce((SELECT l.full_name FROM public.leads l
                  WHERE l.instance_id = c.instance_id AND l.profile_url = c.profile_url AND l.full_name IS NOT NULL
                  ORDER BY l.added_at DESC NULLS LAST, l.id LIMIT 1), cc.full_name) AS full_name,
       coalesce((SELECT l.headline FROM public.leads l
                  WHERE l.instance_id = c.instance_id AND l.profile_url = c.profile_url AND l.headline IS NOT NULL
                  ORDER BY l.added_at DESC NULLS LAST, l.id LIMIT 1), cc.headline) AS headline,
       (SELECT count(*) FROM public.messages m
         WHERE m.instance_id = c.instance_id AND m.profile_url = c.profile_url) AS message_count,
       (SELECT max(m.sent_at) FROM public.messages m
         WHERE m.instance_id = c.instance_id AND m.profile_url = c.profile_url AND m.direction = 'in') AS last_in_at,
       r.id AS run_id, r.created_at AS run_at, r.error AS run_error, r.cut_after_message_id AS run_cut_after_message_id,
       (SELECT count(*) FROM public.coach_training_feedback f
         WHERE f.case_id = c.id AND f.consumed_by_version_id IS NULL
           AND (f.verdict IS NOT NULL OR f.comment IS NOT NULL)) AS pending_feedback`

const CASE_FROM = `FROM public.coach_training_cases c
  LEFT JOIN public.conversation_contacts cc
         ON cc.instance_id = c.instance_id AND cc.profile_url = c.profile_url
  LEFT JOIN LATERAL (
         SELECT r.id, r.created_at, r.error, r.cut_after_message_id
           FROM public.coach_training_runs r
          WHERE r.case_id = c.id AND r.version_id = $1
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT 1) r ON true`

const mapCase = (row: NeonRow): TrainingCaseRow => ({
  id: Number(row.id),
  instance_id: text(row, 'instance_id'),
  profile_url: text(row, 'profile_url'),
  campaign_id: nullableText(row, 'campaign_id'),
  cut_after_message_id: nullableNumber(row, 'cut_after_message_id'),
  note: nullableText(row, 'note'),
  created_at: text(row, 'created_at'),
  full_name: nullableText(row, 'full_name'),
  headline: nullableText(row, 'headline'),
  message_count: Number(row.message_count ?? 0),
  last_in_at: nullableText(row, 'last_in_at'),
  run_id: nullableNumber(row, 'run_id'),
  run_at: nullableText(row, 'run_at'),
  run_error: nullableText(row, 'run_error'),
  run_cut_after_message_id: nullableNumber(row, 'run_cut_after_message_id'),
  pending_feedback: Number(row.pending_feedback ?? 0),
})

export interface CasesParams {
  readonly versionId: number
  readonly [key: string]: number
}

/** Every active case, newest first, with its latest run on `versionId`. */
export const casesOperation: NeonQueryOperation<TrainingCaseRow, CasesParams> = {
  build: ({ params }) => ({
    text: `SELECT ${CASE_COLUMNS} ${CASE_FROM}
            WHERE c.archived_at IS NULL
            ORDER BY c.created_at DESC, c.id DESC`,
    values: [params?.versionId ?? null],
  }),
  mapRow: mapCase,
}

export interface CaseParams {
  readonly caseId: number
  readonly versionId: number
  readonly [key: string]: number
}

export const caseByIdOperation: NeonQueryOperation<TrainingCaseRow, CaseParams> = {
  build: ({ params }) => ({
    text: `SELECT ${CASE_COLUMNS} ${CASE_FROM}
            WHERE c.id = $2 AND c.archived_at IS NULL`,
    values: [params?.versionId ?? null, params?.caseId ?? null],
  }),
  mapRow: mapCase,
}

export interface AddCaseParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly campaignId: string | null
  readonly [key: string]: string | null
}

/** Adds a conversation to the set, or answers the case it already has. */
export const addCaseOperation: NeonCommandOperation<number | null, AddCaseParams> = {
  build: ({ params, actor }) => {
    if (!params) throw new Error('coachTraining.addCase requires parameters')
    return {
      text: `INSERT INTO public.coach_training_cases (instance_id, profile_url, campaign_id, created_by)
             SELECT $1, $2, $3, $4::uuid
              WHERE EXISTS (SELECT 1 FROM public.messages m WHERE m.instance_id = $1 AND m.profile_url = $2)
             ON CONFLICT (instance_id, profile_url) WHERE archived_at IS NULL
             DO UPDATE SET campaign_id = coalesce(EXCLUDED.campaign_id, coach_training_cases.campaign_id)
             RETURNING id`,
      values: [params.instanceId, params.profileUrl, params.campaignId, actor.actorId],
    }
  },
  mapResult: (rows) => (rows[0] ? Number(rows[0].id) : null),
}

export interface SetCutParams {
  readonly caseId: number
  readonly cutAfterMessageId: number | null
  readonly [key: string]: number | null
}

/** The cut must be a message of the case's own thread. */
export const setCutOperation: NeonCommandOperation<boolean, SetCutParams> = {
  build: ({ params }) => {
    if (!params) throw new Error('coachTraining.setCut requires parameters')
    return {
      text: `UPDATE public.coach_training_cases c
                SET cut_after_message_id = $2::bigint
              WHERE c.id = $1 AND c.archived_at IS NULL
                AND ($2::bigint IS NULL OR EXISTS (
                      SELECT 1 FROM public.messages m
                       WHERE m.id = $2::bigint AND m.instance_id = c.instance_id AND m.profile_url = c.profile_url))
             RETURNING c.id`,
      values: [params.caseId, params.cutAfterMessageId],
    }
  },
  mapResult: (rows) => rows.length > 0,
}

export interface CaseIdParams {
  readonly caseId: number
  readonly [key: string]: number
}

export const archiveCaseOperation: NeonCommandOperation<boolean, CaseIdParams> = {
  build: ({ params }) => ({
    text: `UPDATE public.coach_training_cases SET archived_at = now()
            WHERE id = $1 AND archived_at IS NULL
           RETURNING id`,
    values: [params?.caseId ?? null],
  }),
  mapResult: (rows) => rows.length > 0,
}

// ---------------------------------------------------------------------------
// Runs and feedback
// ---------------------------------------------------------------------------

export interface TrainingRunRow {
  readonly id: number
  readonly case_id: number
  readonly version_id: number
  readonly version_n: number
  readonly cut_after_message_id: number | null
  readonly thread_marker: string
  readonly output: Record<string, unknown> | null
  readonly model: string | null
  readonly error: string | null
  readonly created_at: string
}

const RUN_COLUMNS = `r.id, r.case_id, r.version_id, v.n AS version_n, r.cut_after_message_id, r.thread_marker,
       r.output, r.model, r.error, r.created_at`

const mapRun = (row: NeonRow): TrainingRunRow => ({
  id: Number(row.id),
  case_id: Number(row.case_id),
  version_id: Number(row.version_id),
  version_n: Number(row.version_n),
  cut_after_message_id: nullableNumber(row, 'cut_after_message_id'),
  thread_marker: text(row, 'thread_marker'),
  output: row.output && typeof row.output === 'object' ? (row.output as Record<string, unknown>) : null,
  model: nullableText(row, 'model'),
  error: nullableText(row, 'error'),
  created_at: text(row, 'created_at'),
})

/** Every run of a case, newest first. */
export const caseRunsOperation: NeonQueryOperation<TrainingRunRow, CaseIdParams> = {
  build: ({ params }) => ({
    text: `SELECT ${RUN_COLUMNS}
             FROM public.coach_training_runs r
             JOIN public.coach_prompt_versions v ON v.id = r.version_id
            WHERE r.case_id = $1
            ORDER BY r.created_at DESC, r.id DESC`,
    values: [params?.caseId ?? null],
  }),
  mapRow: mapRun,
}

export interface RunIdParams {
  readonly runId: number
  readonly [key: string]: number
}

export const runByIdOperation: NeonQueryOperation<TrainingRunRow, RunIdParams> = {
  build: ({ params }) => ({
    text: `SELECT ${RUN_COLUMNS}
             FROM public.coach_training_runs r
             JOIN public.coach_prompt_versions v ON v.id = r.version_id
            WHERE r.id = $1`,
    values: [params?.runId ?? null],
  }),
  mapRow: mapRun,
}

export interface InsertRunParams {
  readonly caseId: number
  readonly versionId: number
  readonly cutAfterMessageId: number | null
  readonly threadMarker: string
  readonly output: string | null
  readonly model: string | null
  readonly error: string | null
  readonly [key: string]: string | number | null
}

export const insertRunOperation: NeonCommandOperation<TrainingRunRow | null, InsertRunParams> = {
  build: ({ params, actor }) => {
    if (!params) throw new Error('coachTraining.insertRun requires parameters')
    return {
      text: `WITH r AS (
               INSERT INTO public.coach_training_runs
                      (case_id, version_id, cut_after_message_id, thread_marker, output, model, error, created_by)
               VALUES ($1, $2, $3::bigint, $4, $5::jsonb, $6, $7, $8::uuid)
               RETURNING *
             )
             SELECT ${RUN_COLUMNS} FROM r JOIN public.coach_prompt_versions v ON v.id = r.version_id`,
      values: [
        params.caseId, params.versionId, params.cutAfterMessageId, params.threadMarker,
        params.output, params.model, params.error, actor.actorId,
      ],
    }
  },
  mapResult: (rows) => (rows[0] ? mapRun(rows[0]) : null),
}

export interface TrainingFeedbackRow {
  readonly id: number
  readonly run_id: number
  readonly case_id: number
  readonly version_id: number
  readonly target: 'take' | 'idea' | 'issue'
  readonly target_index: number | null
  readonly verdict: 'good' | 'bad' | null
  readonly comment: string | null
  readonly consumed_by_version_id: number | null
  readonly created_by_name: string
  readonly updated_at: string
}

const FEEDBACK_COLUMNS = `f.id, f.run_id, f.case_id, f.version_id, f.target, f.target_index, f.verdict, f.comment,
       f.consumed_by_version_id, f.created_by_name, f.updated_at`

const mapFeedback = (row: NeonRow): TrainingFeedbackRow => ({
  id: Number(row.id),
  run_id: Number(row.run_id),
  case_id: Number(row.case_id),
  version_id: Number(row.version_id),
  target: text(row, 'target') as TrainingFeedbackRow['target'],
  target_index: nullableNumber(row, 'target_index'),
  verdict: nullableText(row, 'verdict') as TrainingFeedbackRow['verdict'],
  comment: nullableText(row, 'comment'),
  consumed_by_version_id: nullableNumber(row, 'consumed_by_version_id'),
  created_by_name: text(row, 'created_by_name'),
  updated_at: text(row, 'updated_at'),
})

export const caseFeedbackOperation: NeonQueryOperation<TrainingFeedbackRow, CaseIdParams> = {
  build: ({ params }) => ({
    text: `SELECT ${FEEDBACK_COLUMNS}
             FROM public.coach_training_feedback f
            WHERE f.case_id = $1 AND (f.verdict IS NOT NULL OR f.comment IS NOT NULL)
            ORDER BY f.id`,
    values: [params?.caseId ?? null],
  }),
  mapRow: mapFeedback,
}

export interface PendingFeedbackRow extends TrainingFeedbackRow {
  readonly instance_id: string
  readonly profile_url: string
  readonly version_n: number
  readonly run_cut_after_message_id: number | null
  readonly run_output: Record<string, unknown> | null
  readonly run_created_at: string
}

/** Everything an improve round would use, grouped by run in id order. */
export const pendingFeedbackOperation: NeonQueryOperation<PendingFeedbackRow> = {
  build: () => ({
    text: `SELECT ${FEEDBACK_COLUMNS}, c.instance_id, c.profile_url, v.n AS version_n,
                  r.cut_after_message_id AS run_cut_after_message_id, r.output AS run_output,
                  r.created_at AS run_created_at
             FROM public.coach_training_feedback f
             JOIN public.coach_training_runs r ON r.id = f.run_id
             JOIN public.coach_training_cases c ON c.id = f.case_id
             JOIN public.coach_prompt_versions v ON v.id = f.version_id
            WHERE f.consumed_by_version_id IS NULL
              AND (f.verdict IS NOT NULL OR f.comment IS NOT NULL)
              AND c.archived_at IS NULL
            ORDER BY f.run_id, f.id`,
  }),
  mapRow: (row) => ({
    ...mapFeedback(row),
    instance_id: text(row, 'instance_id'),
    profile_url: text(row, 'profile_url'),
    version_n: Number(row.version_n),
    run_cut_after_message_id: nullableNumber(row, 'run_cut_after_message_id'),
    run_output: row.run_output && typeof row.run_output === 'object' ? (row.run_output as Record<string, unknown>) : null,
    run_created_at: text(row, 'run_created_at'),
  }),
}

export interface ConsumedFeedbackRow {
  readonly version_id: number
  readonly version_n: number
  readonly parent_n: number | null
  readonly source: string
  readonly note: string | null
  readonly comments: string[]
}

/** The last six AI rounds and the comments each consumed, newest first — the
 *  editor's "already addressed" context. */
export const consumedFeedbackOperation: NeonQueryOperation<ConsumedFeedbackRow, ScopeParams> = {
  build: ({ params }) => ({
    text: `SELECT v.id AS version_id, v.n AS version_n, p.n AS parent_n, v.source, v.note,
                  coalesce((SELECT jsonb_agg(f.comment ORDER BY f.id)
                              FROM public.coach_training_feedback f
                             WHERE f.consumed_by_version_id = v.id AND f.comment IS NOT NULL), '[]'::jsonb) AS comments
             FROM public.coach_prompt_versions v
             LEFT JOIN public.coach_prompt_versions p ON p.id = v.parent_id
            WHERE v.scope = $1 AND v.source IN ('feedback', 'instruction')
            ORDER BY v.n DESC
            LIMIT 6`,
    values: [params?.scope ?? 'global'],
  }),
  mapRow: (row) => ({
    version_id: Number(row.version_id),
    version_n: Number(row.version_n),
    parent_n: nullableNumber(row, 'parent_n'),
    source: text(row, 'source'),
    note: nullableText(row, 'note'),
    comments: jsonArray(row, 'comments').map(String),
  }),
}

export interface MarkConsumedParams {
  readonly feedbackIds: string // JSON array of ids
  readonly versionId: number
  readonly [key: string]: string | number
}

export const markConsumedOperation: NeonCommandOperation<number, MarkConsumedParams> = {
  build: ({ params }) => {
    if (!params) throw new Error('coachTraining.markConsumed requires parameters')
    return {
      text: `UPDATE public.coach_training_feedback
                SET consumed_by_version_id = $2
              WHERE consumed_by_version_id IS NULL
                AND id IN (SELECT x::bigint FROM jsonb_array_elements_text($1::jsonb) x)`,
      values: [params.feedbackIds, params.versionId],
    }
  },
  mapResult: (_rows, rowCount) => rowCount,
}

export interface UpsertFeedbackParams {
  readonly runId: number
  readonly target: string
  readonly targetIndex: number | null
  readonly verdict: string | null
  readonly comment: string | null
  readonly actorName: string
  readonly [key: string]: string | number | null
}

/** One row per thing commented on. Consumed feedback is history: a write to it
 *  answers no row. */
export const upsertFeedbackOperation: NeonCommandOperation<TrainingFeedbackRow | null, UpsertFeedbackParams> = {
  build: ({ params, actor }) => {
    if (!params) throw new Error('coachTraining.upsertFeedback requires parameters')
    return {
      text: `INSERT INTO public.coach_training_feedback AS f
                    (run_id, case_id, version_id, target, target_index, verdict, comment, created_by, created_by_name)
             SELECT r.id, r.case_id, r.version_id, $2, $3::integer, $4, $5, $6::uuid, $7
               FROM public.coach_training_runs r
              WHERE r.id = $1
             ON CONFLICT (run_id, target, (coalesce(target_index, -1)))
             DO UPDATE SET verdict = EXCLUDED.verdict, comment = EXCLUDED.comment,
                           created_by = EXCLUDED.created_by, created_by_name = EXCLUDED.created_by_name
              WHERE f.consumed_by_version_id IS NULL
             RETURNING ${FEEDBACK_COLUMNS}`,
      values: [
        params.runId, params.target, params.targetIndex, params.verdict, params.comment,
        actor.actorId, params.actorName,
      ],
    }
  },
  mapResult: (rows) => (rows[0] ? mapFeedback(rows[0]) : null),
}

// ---------------------------------------------------------------------------
// Overfitting check and the conversation picker
// ---------------------------------------------------------------------------

export interface LeakSourceRow {
  readonly label: string
  readonly body: string
}

/** Texts the working prompt must not copy from: the active cases' threads,
 *  the comments, and the ideas marked good. */
export const leakSourcesOperation: NeonQueryOperation<LeakSourceRow> = {
  build: () => ({
    text: `SELECT 'conversation' AS label, m.body
             FROM public.coach_training_cases c
             JOIN public.messages m ON m.instance_id = c.instance_id AND m.profile_url = c.profile_url
            WHERE c.archived_at IS NULL AND coalesce(btrim(m.body), '') <> ''
           UNION ALL
           SELECT 'comment', f.comment
             FROM public.coach_training_feedback f
            WHERE f.comment IS NOT NULL
           UNION ALL
           SELECT 'liked idea', r.output -> 'ideas' -> f.target_index ->> 'message'
             FROM public.coach_training_feedback f
             JOIN public.coach_training_runs r ON r.id = f.run_id
            WHERE f.target = 'idea' AND f.verdict = 'good'
              AND r.output -> 'ideas' -> f.target_index ->> 'message' IS NOT NULL
           UNION ALL
           SELECT 'company description', concat_ws(' ', k.description, k.keywords)
             FROM public.coach_training_cases c
             JOIN public.lead_company_context k ON k.instance_id = c.instance_id AND k.profile_url = c.profile_url
            WHERE c.archived_at IS NULL AND k.found AND coalesce(k.description, k.keywords) IS NOT NULL
           UNION ALL
           SELECT 'company website', w.body
             FROM public.coach_training_cases c
             JOIN public.lead_company_context k ON k.instance_id = c.instance_id AND k.profile_url = c.profile_url
             JOIN public.company_site_snapshots w
               ON w.domain = lower(regexp_replace(regexp_replace(coalesce(k.website, ''), '^https?://(www\\.)?', '', 'i'), '[/:?#].*$', ''))
            WHERE c.archived_at IS NULL AND w.body IS NOT NULL
           UNION ALL
           SELECT 'lead profile', concat_ws(' ', p.about, p.positions::text)
             FROM public.coach_training_cases c
             JOIN public.lead_profiles p ON p.instance_id = c.instance_id AND p.profile_url = c.profile_url
            WHERE c.archived_at IS NULL
           UNION ALL
           SELECT 'our company text', b.our_company
             FROM public.playbook b
            WHERE b.our_company <> ''`,
  }),
  mapRow: (row) => ({ label: text(row, 'label'), body: text(row, 'body') }),
}

export interface ConversationSearchParams {
  readonly query: string
  readonly [key: string]: string
}

export interface ConversationSearchRow {
  readonly instance_id: string
  readonly profile_url: string
  readonly campaign_id: string | null
  readonly full_name: string | null
  readonly headline: string | null
  readonly message_count: number
  readonly hand_written: number
  readonly last_in_at: string | null
  readonly in_training: boolean
}

/** Conversations with at least one reply, newest reply first, optionally
 *  filtered by name, headline or company. Wildcards in the query are escaped. */
export const searchConversationsOperation: NeonQueryOperation<ConversationSearchRow, ConversationSearchParams> = {
  build: ({ params }) => ({
    text: `WITH conv AS (
             SELECT m.instance_id, m.profile_url,
                    max(m.sent_at) FILTER (WHERE m.direction = 'in') AS last_in_at,
                    count(*) AS message_count,
                    count(*) FILTER (WHERE m.direction = 'out' AND sa.method = 'none') AS hand_written
               FROM public.messages m
               LEFT JOIN public.message_step_attribution sa ON sa.message_id = m.id
              GROUP BY m.instance_id, m.profile_url
             HAVING max(m.sent_at) FILTER (WHERE m.direction = 'in') IS NOT NULL
           ), named AS (
             SELECT conv.*, l.campaign_id,
                    coalesce(l.full_name, cc.full_name) AS full_name,
                    coalesce(l.headline, cc.headline) AS headline,
                    l.company
               FROM conv
               LEFT JOIN LATERAL (
                      SELECT x.campaign_id, x.full_name, x.headline, x.company FROM public.leads x
                       WHERE x.instance_id = conv.instance_id AND x.profile_url = conv.profile_url
                       ORDER BY x.added_at DESC NULLS LAST, x.id LIMIT 1) l ON true
               LEFT JOIN public.conversation_contacts cc
                      ON cc.instance_id = conv.instance_id AND cc.profile_url = conv.profile_url
           )
           SELECT n.instance_id, n.profile_url, n.campaign_id, n.full_name, n.headline,
                  n.message_count, n.hand_written, n.last_in_at,
                  EXISTS (SELECT 1 FROM public.coach_training_cases c
                           WHERE c.instance_id = n.instance_id AND c.profile_url = n.profile_url
                             AND c.archived_at IS NULL) AS in_training
             FROM named n
            WHERE $1 = ''
               OR concat_ws(' ', n.full_name, n.headline, n.company, n.profile_url)
                  ILIKE '%' || replace(replace(replace($1, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
            ORDER BY n.last_in_at DESC, n.instance_id, n.profile_url`,
    values: [params?.query ?? ''],
  }),
  mapRow: (row) => ({
    instance_id: text(row, 'instance_id'),
    profile_url: text(row, 'profile_url'),
    campaign_id: nullableText(row, 'campaign_id'),
    full_name: nullableText(row, 'full_name'),
    headline: nullableText(row, 'headline'),
    message_count: Number(row.message_count ?? 0),
    hand_written: Number(row.hand_written ?? 0),
    last_in_at: nullableText(row, 'last_in_at'),
    in_training: row.in_training === true,
  }),
}
