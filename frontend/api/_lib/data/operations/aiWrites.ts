/**
 * The AI layer's human-actor operations: the reads and writes behind
 * `coach.ts`, the demographics path of `classify.ts`, the admin path of
 * `briefing.ts` and the chat's `save_search`.
 *
 * ## Which half of the AI layer these belong to
 *
 * The AI layer splits by actor. Guard reads run as `app_system` through the AI
 * store (`operations/ai.ts`). Human operations run as `app_runtime` in the
 * shared store. Reply sentiment/intent operations were retired at manual-review
 * cutover; compatibility exports below fail closed until the integration worker
 * removes their registry entries. Demographics remains the only classifier
 * operation in this module.
 *
 * ## Rules, same as every module registered in `index.ts`
 *
 * One named operation per read or write; SQL owned here; parameters bound,
 * never interpolated. Partial patches use the jsonb key-presence `CASE` shape
 * S14 chose for the same problem — key presence distinguishes "leave it
 * alone" from "clear it", and a `COALESCE` cannot express the difference.
 */

import type {
  NeonCommandOperation,
  NeonQueryOperation,
  NeonRow,
  NeonStatement,
} from '../neon.js'

export const AI_WRITE_OPERATIONS = {
  // coach.ts
  coachExisting: 'coach.existing',
  coachUpsert: 'coach.upsert',
  coachPlaybook: 'coach.playbook',
  coachHypothesisAssignment: 'coach.hypothesisAssignment',
  coachHypothesisIcp: 'coach.hypothesisIcp',
  coachIcpDetail: 'coach.icpDetail',
  coachIcpPersonas: 'coach.icpPersonas',
  coachActionableProfiles: 'coach.actionableProfiles',
  coachIssuesByInstance: 'coach.issuesByInstance',
  coachDigestUpsert: 'coach.digestUpsert',
  // classify.ts (demographics only; reply AI is retired after manual-review cutover)
  // Deprecated compatibility names. The corresponding builders below fail closed.
  classifyPendingReplies: 'classify.pendingReplies',
  classifyThreadContext: 'classify.threadContext',
  classifyWriteLabels: 'classify.writeLabels',
  classifyRemainingCount: 'classify.remainingCount',
  classifyAutoAdvance: 'classify.autoAdvance',
  classifyGenderBatch: 'classify.genderBatch',
  classifyWriteGender: 'classify.writeGender',
  classifyGenderBacklog: 'classify.genderBacklog',
  classifyReclassify: 'classify.reclassify',
  // briefing.ts (admin POST)
  briefingEnsureJob: 'briefing.ensureJob',
  briefingJobRow: 'briefing.jobRow',
  briefingClaimJob: 'briefing.claimJob',
  briefingFinishStage: 'briefing.finishStage',
  briefingFailStage: 'briefing.failStage',
  briefingResetJob: 'briefing.resetJob',
  briefingStaleError: 'briefing.staleError',
  briefingUpsertBriefing: 'briefing.upsertBriefing',
  briefingPrior: 'briefing.prior',
  briefingWeeklyReference: 'briefing.weeklyReference',
  briefingCampaignsContext: 'briefing.campaignsContext',
  briefingInstancesList: 'briefing.instancesList',
  briefingHypothesesList: 'briefing.hypothesesList',
  briefingAssignments: 'briefing.assignments',
  briefingAssignedSearches: 'briefing.assignedSearches',
  briefingRecentAnnotations: 'briefing.recentAnnotations',
} as const

const text = (row: NeonRow, column: string): string => String(row[column])
const nullableText = (row: NeonRow, column: string): string | null =>
  row[column] === null || row[column] === undefined ? null : String(row[column])

export interface CoachThreadKeyParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly [key: string]: string
}

// ---------------------------------------------------------------------------
// coach.ts — reads, then the two upserts
// ---------------------------------------------------------------------------

export interface CoachingRow {
  readonly next_action: string | null
  readonly issues: unknown[]
  readonly tips: unknown[]
  readonly summary: string | null
  readonly last_msg_marker: string | null
  readonly coached_at: string | null
  readonly model: string | null
}

export const coachExistingOperation: NeonQueryOperation<
  CoachingRow,
  CoachThreadKeyParams
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT next_action, issues, tips, summary, last_msg_marker, coached_at, model
             FROM public.conversation_coaching
            WHERE instance_id = $1 AND profile_url = $2`,
    values: [params?.instanceId ?? null, params?.profileUrl ?? null],
  }),
  mapRow: (row): CoachingRow => ({
    next_action: nullableText(row, 'next_action'),
    issues: Array.isArray(row.issues) ? (row.issues as unknown[]) : [],
    tips: Array.isArray(row.tips) ? (row.tips as unknown[]) : [],
    summary: nullableText(row, 'summary'),
    last_msg_marker: nullableText(row, 'last_msg_marker'),
    coached_at: nullableText(row, 'coached_at'),
    model: nullableText(row, 'model'),
  }),
}

export interface CoachUpsertParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly nextAction: string
  readonly issues: string
  readonly tips: string
  readonly summary: string
  readonly lastMsgMarker: string
  readonly coachedAt: string
  readonly model: string
  readonly [key: string]: string
}

export const coachUpsertOperation: NeonCommandOperation<
  void,
  CoachUpsertParams
> = {
  build: ({ params }): NeonStatement => {
    if (!params) throw new Error('coach.upsert requires parameters')
    return {
      text: `INSERT INTO public.conversation_coaching
                    (instance_id, profile_url, next_action, issues, tips, summary,
                     last_msg_marker, coached_at, model)
             VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
             ON CONFLICT (instance_id, profile_url) DO UPDATE
                SET next_action = EXCLUDED.next_action,
                    issues = EXCLUDED.issues,
                    tips = EXCLUDED.tips,
                    summary = EXCLUDED.summary,
                    last_msg_marker = EXCLUDED.last_msg_marker,
                    coached_at = EXCLUDED.coached_at,
                    model = EXCLUDED.model`,
      values: [
        params.instanceId,
        params.profileUrl,
        params.nextAction,
        params.issues,
        params.tips,
        params.summary,
        params.lastMsgMarker,
        params.coachedAt,
        params.model,
      ],
    }
  },
}

/**
 * The singleton playbook, and the one operation in this module with two callers.
 *
 * `/api/coach` grounds its analysis on it and reads `content` alone. The
 * **Playbook page** reads the same row through the dispatching read endpoint,
 * which allowlists this name rather than declaring a second operation over one
 * table — the argument the roster slice settled: a second spelling of one read is
 * a second thing to keep correct. What the page needs beyond the coach is
 * `updated_at`, so the projection carries it and the coach ignores it.
 *
 * Two details the second caller adds:
 *
 * - **`ORDER BY id`.** Ornamental on its own terms — `playbook_singleton` is a
 *   CHECK that `id` is true, so there is at most one row — but the read endpoint
 *   wraps every query in `LIMIT/OFFSET`, and "ordered" is a property its guard
 *   suite asserts over the whole slice rather than reasoning about row counts
 *   case by case.
 * - **An empty page means the row has never been written**, not that the
 *   relation is missing. The table ships in the baseline's first artifact with no
 *   seeded row, so `items[0] ?? null` is the caller's correct reading, and the
 *   endpoint does *not* tolerate an absent relation here. See `coaching.ts`.
 */
export const coachPlaybookOperation: NeonQueryOperation<{
  content: string
  updated_at: string
}> = {
  build: (): NeonStatement => ({
    text: `SELECT content, updated_at FROM public.playbook WHERE id = true ORDER BY id`,
    values: [],
  }),
  mapRow: (row) => ({
    content: text(row, 'content'),
    updated_at: String(row.updated_at),
  }),
}

export interface HypothesisAssignmentRow {
  readonly hypothesis_id: number
}

export const coachHypothesisAssignmentOperation: NeonQueryOperation<
  HypothesisAssignmentRow,
  { campaignId: string; [key: string]: string }
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT hypothesis_id FROM public.hypothesis_campaigns WHERE campaign_id = $1`,
    values: [params?.campaignId ?? null],
  }),
  mapRow: (row): HypothesisAssignmentRow => ({
    hypothesis_id: Number(row.hypothesis_id),
  }),
}

export interface HypothesisIcpRow {
  readonly name: string
  readonly icp_id: number | null
}

export const coachHypothesisIcpOperation: NeonQueryOperation<
  HypothesisIcpRow,
  { hypothesisId: number; [key: string]: number }
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT name, icp_id FROM public.hypotheses WHERE id = $1`,
    values: [params?.hypothesisId ?? null],
  }),
  mapRow: (row): HypothesisIcpRow => ({
    name: text(row, 'name'),
    icp_id: row.icp_id === null ? null : Number(row.icp_id),
  }),
}

export interface IcpDetailRow {
  readonly name: string
  readonly main_product: string | null
  readonly core_sphere: string | null
  readonly secondary_sphere: string | null
  readonly purchase_triggers: string[] | null
}

export const coachIcpDetailOperation: NeonQueryOperation<
  IcpDetailRow,
  { icpId: number; [key: string]: number }
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT name, main_product, core_sphere, secondary_sphere, purchase_triggers
             FROM public.icps WHERE id = $1`,
    values: [params?.icpId ?? null],
  }),
  mapRow: (row): IcpDetailRow => ({
    name: text(row, 'name'),
    main_product: nullableText(row, 'main_product'),
    core_sphere: nullableText(row, 'core_sphere'),
    secondary_sphere: nullableText(row, 'secondary_sphere'),
    purchase_triggers:
      row.purchase_triggers === null ? null : (row.purchase_triggers as string[]),
  }),
}

export interface CoachIcpPersonaRow {
  readonly kind: string
  readonly job_titles: string[]
  readonly background: string | null
}

export const coachIcpPersonasOperation: NeonQueryOperation<
  CoachIcpPersonaRow,
  { icpId: number; [key: string]: number }
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT kind, job_titles, background
             FROM public.icp_personas
            WHERE icp_id = $1
            ORDER BY sort`,
    values: [params?.icpId ?? null],
  }),
  mapRow: (row): CoachIcpPersonaRow => ({
    kind: text(row, 'kind'),
    job_titles: Array.isArray(row.job_titles) ? (row.job_titles as string[]) : [],
    background: nullableText(row, 'background'),
  }),
}

export interface ActionableProfileRow {
  readonly profile_url: string
  readonly direction: string
}

/**
 * The digest's walk of an account's messages, newest first. The handler pages
 * it and keeps each profile's FIRST direction, which is the newest message's —
 * the same computation the Supabase path does over `.range()` pages. The order
 * is total (`sent_at DESC, id DESC`) because synced batches stamp equal times.
 */
export const coachActionableProfilesOperation: NeonQueryOperation<
  ActionableProfileRow,
  { instanceId: string; [key: string]: string }
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT profile_url, direction
             FROM public.messages
            WHERE instance_id = $1
            ORDER BY sent_at DESC, id DESC`,
    values: [params?.instanceId ?? null],
  }),
  mapRow: (row): ActionableProfileRow => ({
    profile_url: text(row, 'profile_url'),
    direction: text(row, 'direction'),
  }),
}

export const coachIssuesByInstanceOperation: NeonQueryOperation<
  { issues: unknown[] },
  { instanceId: string; [key: string]: string }
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT issues FROM public.conversation_coaching WHERE instance_id = $1`,
    values: [params?.instanceId ?? null],
  }),
  mapRow: (row) => ({
    issues: Array.isArray(row.issues) ? (row.issues as unknown[]) : [],
  }),
}

export interface DigestUpsertParams {
  readonly instanceId: string
  readonly summary: string
  readonly patterns: string
  readonly computedAt: string
  readonly model: string
  readonly [key: string]: string
}

export const coachDigestUpsertOperation: NeonCommandOperation<
  void,
  DigestUpsertParams
> = {
  build: ({ params }): NeonStatement => {
    if (!params) throw new Error('coach.digestUpsert requires parameters')
    return {
      text: `INSERT INTO public.coaching_digest
                    (instance_id, summary, patterns, computed_at, model)
             VALUES ($1, $2, $3::jsonb, $4, $5)
             ON CONFLICT (instance_id) DO UPDATE
                SET summary = EXCLUDED.summary,
                    patterns = EXCLUDED.patterns,
                    computed_at = EXCLUDED.computed_at,
                    model = EXCLUDED.model`,
      values: [
        params.instanceId,
        params.summary,
        params.patterns,
        params.computedAt,
        params.model,
      ],
    }
  },
}

// ---------------------------------------------------------------------------
// classify.ts — the demographics phase
// ---------------------------------------------------------------------------

/**
 * Compatibility surface for the pre-cutover registry.  These names remain
 * exported until the integration worker removes them from `index.ts` and
 * `aiSystem.ts`; every builder fails before a connection or mutation, so an
 * old worker cannot regain an AI reply write path during a rolling deploy.
 */
export interface PendingReplyRow {
  readonly id: number
  readonly instance_id: string
  readonly profile_url: string
  readonly body: string | null
  readonly sent_at: string
  readonly sentiment: string | null
  readonly classified_model: string | null
}
export interface ClassifyParams { readonly taxonomyVersion: string; readonly [key: string]: string }
export interface ThreadContextRow {
  readonly instance_id: string
  readonly profile_url: string
  readonly direction: string
  readonly body: string | null
  readonly sent_at: string
}
export interface ThreadContextParams {
  readonly instances: string[]
  readonly profiles: string[]
  readonly [key: string]: string[]
}
export interface WriteLabelsParams {
  readonly messageId: number
  readonly applySentiment: boolean
  readonly sentiment: string | null
  readonly reason: string | null
  readonly intentLevel: string | null
  readonly intentReason: string
  readonly now: string
  readonly model: string
  readonly taxonomyVersion: string
  readonly [key: string]: string | number | boolean | null
}
export interface ReclassifyParams extends WriteLabelsParams { readonly hasSentiment: boolean; readonly hasIntent: boolean }
export interface ReclassifyResult { readonly id: number | null; readonly sentiment: string | null; readonly intent_level: string | null }

const REPLY_AI_DISABLED = (): never => {
  throw new Error('reply AI classification is disabled; use manual reply review')
}

export const classifyPendingRepliesOperation: NeonQueryOperation<PendingReplyRow, ClassifyParams> = {
  build: REPLY_AI_DISABLED,
  mapRow: REPLY_AI_DISABLED,
}
export const classifyThreadContextOperation: NeonQueryOperation<ThreadContextRow, ThreadContextParams> = {
  build: REPLY_AI_DISABLED,
  mapRow: REPLY_AI_DISABLED,
}
export const classifyWriteLabelsOperation: NeonCommandOperation<{ updated: number }, WriteLabelsParams> = {
  build: REPLY_AI_DISABLED,
  mapResult: REPLY_AI_DISABLED,
}
export const classifyRemainingCountOperation: NeonQueryOperation<{ remaining: number }, ClassifyParams> = {
  build: REPLY_AI_DISABLED,
  mapRow: REPLY_AI_DISABLED,
}
export const classifyAutoAdvanceOperation: NeonCommandOperation<{ advanced: number }> = {
  build: REPLY_AI_DISABLED,
  mapResult: REPLY_AI_DISABLED,
}
export const classifyReclassifyOperation: NeonCommandOperation<ReclassifyResult, ReclassifyParams> = {
  build: REPLY_AI_DISABLED,
  mapResult: REPLY_AI_DISABLED,
}

export interface GenderBatchRow {
  readonly id: string
  readonly instance_id: string
  readonly profile_url: string
  readonly full_name: string | null
  readonly headline: string | null
}

export interface GenderBatchParams {
  readonly genderVersion: string
  /** Per-instance bucket ceiling. */
  readonly bucketLimit: number
  /** Global batch ceiling. */
  readonly batchLimit: number
  readonly [key: string]: string | number
}

/**
 * The fair gender batch, as one statement. The Supabase path selects a bucket
 * per instance and then round-robins across buckets in instance order,
 * deduplicating each person by `(instance_id, profile_url)`; this reproduces
 * that: `rn` is the position inside each instance's bucket (oldest lead
 * first), the `DISTINCT ON` keeps a person's earliest bucket position, and the
 * final `rn, instance_id` order is the round-robin interleaving. The portable
 * baseline carries every v2 lifecycle column by construction, so there is no
 * legacy ladder here — see S14's design call 6 for the same argument.
 */
export const classifyGenderBatchOperation: NeonQueryOperation<
  GenderBatchRow,
  GenderBatchParams
> = {
  build: ({ params }): NeonStatement => ({
    text: `WITH bucketed AS (
              SELECT id, instance_id, profile_url, full_name, headline,
                     row_number() OVER (
                       PARTITION BY instance_id ORDER BY added_at, id
                     ) AS rn
                FROM public.leads
               WHERE (demo_model IS NULL OR demo_model <> 'manual')
                 AND (gender_inferred_at IS NULL
                      OR gender_model_version IS NULL
                      OR gender_model_version <> $1::text)
             ),
             dedup AS (
              SELECT DISTINCT ON (instance_id, profile_url) *
                FROM bucketed
               ORDER BY instance_id, profile_url, rn
             )
             SELECT id::text, instance_id, profile_url, full_name, headline
               FROM dedup
              WHERE rn <= $2::bigint
              ORDER BY rn, instance_id, profile_url
              LIMIT $3::bigint`,
    values: [
      params?.genderVersion ?? null,
      params?.bucketLimit ?? null,
      params?.batchLimit ?? null,
    ],
  }),
  mapRow: (row): GenderBatchRow => ({
    id: text(row, 'id'),
    instance_id: text(row, 'instance_id'),
    profile_url: text(row, 'profile_url'),
    full_name: nullableText(row, 'full_name'),
    headline: nullableText(row, 'headline'),
  }),
}

export interface WriteGenderParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly gender: string
  readonly confidence: number
  readonly now: string
  readonly model: string
  readonly genderVersion: string
  readonly [key: string]: string | number
}

export const classifyWriteGenderOperation: NeonCommandOperation<
  { updated: number },
  WriteGenderParams
> = {
  build: ({ params }): NeonStatement => {
    if (!params) throw new Error('classify.writeGender requires parameters')
    return {
      // A person may sit in several campaigns on the same account; one
      // evaluation persists across every row, keyed exactly as the Supabase
      // path's chained `.eq()` pair.
      text: `UPDATE public.leads
                SET gender = $3::text,
                    gender_confidence = $4::real,
                    gender_inferred_at = $5::timestamptz,
                    gender_model_version = $6::text,
                    demo_inferred_at = $5::timestamptz,
                    demo_model = $7::text
              WHERE instance_id = $1 AND profile_url = $2`,
      values: [
        params.instanceId,
        params.profileUrl,
        params.gender,
        params.confidence,
        params.now,
        params.genderVersion,
        params.model,
      ],
    }
  },
  mapResult: (_rows, rowCount) => ({ updated: rowCount }),
}

export const classifyGenderBacklogOperation: NeonQueryOperation<
  { remaining: number },
  { genderVersion: string; [key: string]: string }
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT count(*)::int AS remaining
             FROM public.leads
            WHERE (demo_model IS NULL OR demo_model <> 'manual')
              AND (gender_inferred_at IS NULL
                   OR gender_model_version IS NULL
                   OR gender_model_version <> $1::text)`,
    values: [params?.genderVersion ?? null],
  }),
  mapRow: (row) => ({ remaining: Number(row.remaining) }),
}
