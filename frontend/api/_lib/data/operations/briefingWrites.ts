/**
 * The briefing job machine and its reads, as named operations.
 *
 * The Supabase path drives `briefing_jobs` with PostgREST update-where-version
 * calls; these are the same statements with the optimistic predicates in the
 * SQL, which is where they belong: the version check is the collision defence,
 * and a claim that forgot its `WHERE version` is an operation nobody
 * registered, not a runtime accident.
 *
 * Every command here keys on `(briefing_date, briefing_kind, version)` and
 * bumps the version itself — callers pass the version they read, never the
 * next one they computed, so two writers cannot agree on what the next version
 * is before the database picks one.
 */

import type {
  NeonCommandOperation,
  NeonQueryOperation,
  NeonRow,
  NeonStatement,
} from '../neon.js'

import { AI_WRITE_OPERATIONS } from './aiWrites.js'

export interface BriefingJobRowShape {
  readonly briefing_date: string
  readonly briefing_kind: 'daily' | 'weekly'
  readonly status: string
  readonly version: number
  readonly attempt: number
  readonly seed: string | null
  readonly signals_block: string | null
  readonly prior_md: string | null
  readonly drafts: { label: string; text: string }[] | null
  readonly verified_text: string | null
  readonly error: string | null
  readonly updated_at: string
}

const JOB_COLUMNS = `briefing_date::text AS briefing_date, briefing_kind, status,
          version, attempt, seed, signals_block, prior_md, drafts,
          verified_text, error, updated_at`

function mapJobRow(row: NeonRow): BriefingJobRowShape {
  return {
    briefing_date: String(row.briefing_date),
    briefing_kind: row.briefing_kind === 'weekly' ? 'weekly' : 'daily',
    status: String(row.status),
    version: Number(row.version),
    attempt: Number(row.attempt),
    seed: row.seed === null ? null : String(row.seed),
    signals_block: row.signals_block === null ? null : String(row.signals_block),
    prior_md: row.prior_md === null ? null : String(row.prior_md),
    drafts: Array.isArray(row.drafts)
      ? (row.drafts as { label: string; text: string }[])
      : null,
    verified_text: row.verified_text === null ? null : String(row.verified_text),
    error: row.error === null ? null : String(row.error),
    updated_at: String(row.updated_at),
  }
}

export interface JobKeyParams {
  readonly briefingDate: string
  readonly briefingKind: string
  readonly [key: string]: string | number
}

export const briefingEnsureJobOperation: NeonCommandOperation<
  void,
  JobKeyParams
> = {
  build: ({ params }): NeonStatement => {
    if (!params) throw new Error('briefing.ensureJob requires parameters')
    return {
      text: `INSERT INTO public.briefing_jobs (briefing_date, briefing_kind)
             VALUES ($1::date, $2::text)
             ON CONFLICT (briefing_date, briefing_kind) DO NOTHING`,
      values: [params.briefingDate, params.briefingKind],
    }
  },
}

export const briefingJobRowOperation: NeonQueryOperation<
  BriefingJobRowShape,
  JobKeyParams
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT ${JOB_COLUMNS}
             FROM public.briefing_jobs
            WHERE briefing_date = $1::date AND briefing_kind = $2::text`,
    values: [params?.briefingDate ?? null, params?.briefingKind ?? null],
  }),
  mapRow: mapJobRow,
}

export interface ClaimJobParams extends JobKeyParams {
  readonly expectedStatus: string
  readonly expectedVersion: number
  readonly nextStatus: string
}

export const briefingClaimJobOperation: NeonCommandOperation<
  BriefingJobRowShape | null,
  ClaimJobParams
> = {
  build: ({ params }): NeonStatement => {
    if (!params) throw new Error('briefing.claimJob requires parameters')
    return {
      text: `UPDATE public.briefing_jobs
                SET status = $3::text,
                    version = version + 1,
                    attempt = attempt + 1,
                    error = NULL,
                    updated_at = now()
              WHERE briefing_date = $1::date
                AND briefing_kind = $2::text
                AND status = $4::text
                AND version = $5::bigint
              RETURNING ${JOB_COLUMNS}`,
      values: [
        params.briefingDate,
        params.briefingKind,
        params.nextStatus,
        params.expectedStatus,
        params.expectedVersion,
      ],
    }
  },
  mapResult: (rows) => (rows.length === 1 ? mapJobRow(rows[0]) : null),
}

export interface FinishStageParams extends JobKeyParams {
  readonly nextStatus: string
  readonly expectedVersion: number
  /**
   * The stage's payload as jsonb text. Which of the five artefact columns move
   * is decided by key presence — investigate stores seed/signals_block/prior_md/
   * drafts, verify stores verified_text, structure stores nothing.
   */
  readonly patch: string
}

export const briefingFinishStageOperation: NeonCommandOperation<
  { updated: number },
  FinishStageParams
> = {
  build: ({ params }): NeonStatement => {
    if (!params) throw new Error('briefing.finishStage requires parameters')
    return {
      text: `UPDATE public.briefing_jobs
                SET seed = CASE WHEN $3::jsonb ? 'seed' THEN $3::jsonb ->> 'seed' ELSE seed END,
                    signals_block = CASE WHEN $3::jsonb ? 'signals_block' THEN $3::jsonb ->> 'signals_block' ELSE signals_block END,
                    prior_md = CASE WHEN $3::jsonb ? 'prior_md' THEN $3::jsonb ->> 'prior_md' ELSE prior_md END,
                    drafts = CASE WHEN $3::jsonb ? 'drafts' THEN $3::jsonb -> 'drafts' ELSE drafts END,
                    verified_text = CASE WHEN $3::jsonb ? 'verified_text' THEN $3::jsonb ->> 'verified_text' ELSE verified_text END,
                    status = $4::text,
                    attempt = 0,
                    version = version + 1,
                    updated_at = now()
              WHERE briefing_date = $1::date
                AND briefing_kind = $2::text
                AND version = $5::bigint`,
      values: [
        params.briefingDate,
        params.briefingKind,
        params.patch,
        params.nextStatus,
        params.expectedVersion,
      ],
    }
  },
  mapResult: (_rows, rowCount) => ({ updated: rowCount }),
}

export interface FailStageParams extends JobKeyParams {
  /** Decided by the handler: the start status to retry from, or 'error'. */
  readonly nextStatus: string
  readonly message: string
  readonly expectedVersion: number
}

export const briefingFailStageOperation: NeonCommandOperation<
  { updated: number },
  FailStageParams
> = {
  build: ({ params }): NeonStatement => {
    if (!params) throw new Error('briefing.failStage requires parameters')
    return {
      text: `UPDATE public.briefing_jobs
                SET status = $3::text,
                    error = $4::text,
                    version = version + 1,
                    updated_at = now()
              WHERE briefing_date = $1::date
                AND briefing_kind = $2::text
                AND version = $5::bigint`,
      values: [
        params.briefingDate,
        params.briefingKind,
        params.nextStatus,
        params.message,
        params.expectedVersion,
      ],
    }
  },
  mapResult: (_rows, rowCount) => ({ updated: rowCount }),
}

export const briefingResetJobOperation: NeonCommandOperation<
  BriefingJobRowShape | null,
  JobKeyParams & { expectedVersion: number; [key: string]: string | number }
> = {
  build: ({ params }): NeonStatement => {
    if (!params) throw new Error('briefing.resetJob requires parameters')
    return {
      text: `UPDATE public.briefing_jobs
                SET status = 'pending',
                    attempt = 0,
                    version = version + 1,
                    seed = NULL,
                    signals_block = NULL,
                    prior_md = NULL,
                    drafts = NULL,
                    verified_text = NULL,
                    error = NULL,
                    updated_at = now()
              WHERE briefing_date = $1::date
                AND briefing_kind = $2::text
                AND version = $3::bigint
              RETURNING ${JOB_COLUMNS}`,
      values: [params.briefingDate, params.briefingKind, params.expectedVersion],
    }
  },
  mapResult: (rows) => (rows.length === 1 ? mapJobRow(rows[0]) : null),
}

export const briefingStaleErrorOperation: NeonCommandOperation<
  { updated: number },
  JobKeyParams & { message: string; expectedVersion: number; [key: string]: string | number }
> = {
  build: ({ params }): NeonStatement => {
    if (!params) throw new Error('briefing.staleError requires parameters')
    return {
      text: `UPDATE public.briefing_jobs
                SET status = 'error',
                    error = $3::text,
                    version = version + 1,
                    updated_at = now()
              WHERE briefing_date = $1::date
                AND briefing_kind = $2::text
                AND version = $4::bigint`,
      values: [
        params.briefingDate,
        params.briefingKind,
        params.message,
        params.expectedVersion,
      ],
    }
  },
  mapResult: (_rows, rowCount) => ({ updated: rowCount }),
}

export interface UpsertBriefingParams {
  readonly briefingDate: string
  readonly briefingKind: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly headline: string
  readonly summary: string
  readonly changes: string
  readonly sections: string
  readonly actions: string
  readonly risks: string
  readonly metrics: string
  readonly model: string
  readonly createdAt: string
  readonly [key: string]: string
}

export const briefingUpsertBriefingOperation: NeonCommandOperation<
  void,
  UpsertBriefingParams
> = {
  build: ({ params }): NeonStatement => {
    if (!params) throw new Error('briefing.upsertBriefing requires parameters')
    return {
      text: `INSERT INTO public.briefings
                    (briefing_date, briefing_kind, period_start, period_end,
                     headline, summary, changes, sections, actions, risks,
                     metrics, model, created_at)
             VALUES ($1::date, $2::text, $3::date, $4::date,
                     $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
                     $11::jsonb, $12, $13::timestamptz)
             ON CONFLICT (briefing_date, briefing_kind) DO UPDATE
                SET period_start = EXCLUDED.period_start,
                    period_end = EXCLUDED.period_end,
                    headline = EXCLUDED.headline,
                    summary = EXCLUDED.summary,
                    changes = EXCLUDED.changes,
                    sections = EXCLUDED.sections,
                    actions = EXCLUDED.actions,
                    risks = EXCLUDED.risks,
                    metrics = EXCLUDED.metrics,
                    model = EXCLUDED.model,
                    created_at = EXCLUDED.created_at`,
      values: [
        params.briefingDate,
        params.briefingKind,
        params.periodStart,
        params.periodEnd,
        params.headline,
        params.summary,
        params.changes,
        params.sections,
        params.actions,
        params.risks,
        params.metrics,
        params.model,
        params.createdAt,
      ],
    }
  },
}

export interface PriorBriefingRow {
  readonly briefing_date: string
  readonly headline: string | null
  readonly summary: string | null
  readonly changes: { text: string; trend?: string }[]
  readonly sections: { title: string; body: string }[]
  readonly actions: { text: string; priority?: string }[]
  readonly risks: { kind?: string; severity?: string; text: string }[]
}

function mapBriefingRow(row: NeonRow): PriorBriefingRow {
  const arr = (value: unknown): never[] | any[] =>
    Array.isArray(value) ? (value as any[]) : []
  return {
    briefing_date: String(row.briefing_date),
    headline: row.headline === null ? null : String(row.headline),
    summary: row.summary === null ? null : String(row.summary),
    changes: arr(row.changes),
    sections: arr(row.sections),
    actions: arr(row.actions),
    risks: arr(row.risks),
  }
}

export const briefingPriorOperation: NeonQueryOperation<
  PriorBriefingRow,
  JobKeyParams
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT briefing_date::text AS briefing_date, headline, summary,
                  changes, sections, actions, risks
             FROM public.briefings
            WHERE briefing_kind = $2::text AND briefing_date < $1::date
            ORDER BY briefing_date DESC`,
    values: [params?.briefingDate ?? null, params?.briefingKind ?? null],
  }),
  mapRow: mapBriefingRow,
}

export const briefingWeeklyReferenceOperation: NeonQueryOperation<
  PriorBriefingRow,
  JobKeyParams
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT briefing_date::text AS briefing_date, headline, summary,
                  changes, sections, actions, risks
             FROM public.briefings
            WHERE briefing_kind = 'weekly' AND briefing_date = $1::date`,
    values: [params?.briefingDate ?? null],
  }),
  mapRow: mapBriefingRow,
}

// --- the team-context preload reads -----------------------------------------

export interface CampaignContextRow {
  readonly id: string
  readonly name: string
  readonly instance_id: string
  readonly briefing_context: string | null
  readonly briefing_context_updated_at: string | null
}

export const briefingCampaignsContextOperation: NeonQueryOperation<CampaignContextRow> = {
  build: (): NeonStatement => ({
    text: `SELECT id, name, instance_id, briefing_context, briefing_context_updated_at
             FROM public.campaigns
            ORDER BY name`,
    values: [],
  }),
  mapRow: (row): CampaignContextRow => ({
    id: String(row.id),
    name: String(row.name),
    instance_id: String(row.instance_id),
    briefing_context: row.briefing_context === null ? null : String(row.briefing_context),
    briefing_context_updated_at:
      row.briefing_context_updated_at === null
        ? null
        : String(row.briefing_context_updated_at),
  }),
}

export const briefingInstancesListOperation: NeonQueryOperation<{
  id: string
  label: string | null
  account_name: string | null
}> = {
  build: (): NeonStatement => ({
    text: `SELECT id, label, account_name FROM public.instances ORDER BY id`,
    values: [],
  }),
  mapRow: (row) => ({
    id: String(row.id),
    label: row.label === null ? null : String(row.label),
    account_name: row.account_name === null ? null : String(row.account_name),
  }),
}

export const briefingHypothesesListOperation: NeonQueryOperation<{
  id: number
  name: string
  description: string | null
}> = {
  build: (): NeonStatement => ({
    text: `SELECT id::text AS id, name, description
             FROM public.hypotheses
            WHERE archived = false
            ORDER BY name`,
    values: [],
  }),
  mapRow: (row) => ({
    id: Number(row.id),
    name: String(row.name),
    description: row.description === null ? null : String(row.description),
  }),
}

export const briefingAssignmentsOperation: NeonQueryOperation<{
  hypothesis_id: number
  campaign_id: string
}> = {
  build: (): NeonStatement => ({
    text: `SELECT hypothesis_id::text AS hypothesis_id, campaign_id FROM public.hypothesis_campaigns`,
    values: [],
  }),
  mapRow: (row) => ({
    hypothesis_id: Number(row.hypothesis_id),
    campaign_id: String(row.campaign_id),
  }),
}

export const briefingAssignedSearchesOperation: NeonQueryOperation<{
  name: string
  hypothesis_id: number | null
  description: string | null
  notes: string | null
}> = {
  build: (): NeonStatement => ({
    text: `SELECT name, hypothesis_id::text AS hypothesis_id, description, notes
             FROM public.saved_searches
            WHERE archived = false AND hypothesis_id IS NOT NULL
            ORDER BY name`,
    values: [],
  }),
  mapRow: (row) => ({
    name: String(row.name),
    hypothesis_id: row.hypothesis_id === null ? null : Number(row.hypothesis_id),
    description: row.description === null ? null : String(row.description),
    notes: row.notes === null ? null : String(row.notes),
  }),
}

export const briefingRecentAnnotationsOperation: NeonQueryOperation<
  {
    instance_id: string | null
    campaign_id: string | null
    note: string
    noted_at: string
  },
  { since: string; [key: string]: string }
> = {
  build: ({ params }): NeonStatement => ({
    text: `SELECT instance_id, campaign_id, note, noted_at::text AS noted_at
             FROM public.annotations
            WHERE noted_at >= $1::timestamptz
            ORDER BY noted_at DESC
            LIMIT 100`,
    values: [params?.since ?? null],
  }),
  mapRow: (row) => ({
    instance_id: row.instance_id === null ? null : String(row.instance_id),
    campaign_id: row.campaign_id === null ? null : String(row.campaign_id),
    note: String(row.note),
    noted_at: String(row.noted_at),
  }),
}

/**
 * The four context reads again, as guard SQL — and the reason they exist twice.
 *
 * The operations above are direct statements, and they are correct for the
 * human path: `app_runtime` holds `SELECT` on `campaigns`, `hypotheses`,
 * `hypothesis_campaigns` and `annotations`. The cron half has no human and runs
 * as `app_system`, which ledger step 007 gave **no** privilege on any of those
 * four — a direct statement is refused with 42501. Their only route is
 * `public.ai_execute_sql`, whose owner `app_ai_runner` reads every business
 * table SELECT-only, and the guard takes its query as text.
 *
 * So the text lives here rather than in `aiSystem.ts`: a column added to the
 * direct read and forgotten in the guard read would give the two principals
 * different team context for the same briefing, and the only defence against
 * that is the two statements sitting where one edit sees both. `saved_searches`
 * needs no twin — it is inside the 007 grant, so both principals run the direct
 * `briefingAssignedSearchesOperation`.
 *
 * **The 1000-row cap**, stated per query rather than assumed away. The guard
 * aggregates at most 1000 rows and does not say it truncated:
 *
 * - `campaigns` — one row per campaign per account. Dozens fleet-wide; three
 *   orders of magnitude of headroom.
 * - `hypotheses` — live (non-archived) go-to-market hypotheses, a hand-curated
 *   list in the tens.
 * - `hypothesis_campaigns` — unique on `campaign_id`, so it is bounded ABOVE by
 *   the campaign count. It cannot reach the cap before `campaigns` does.
 * - `annotations` — the only one that could grow without bound, and the only
 *   one carrying its own `LIMIT 100`. The cap is unreachable by construction.
 *
 * Two representational notes, because these rows reach a model. The direct
 * operations cast bigint ids to text and map them with `Number`; the guard
 * leaves them as jsonb numbers, which is the same JavaScript number, so the
 * `hypothesis_id` joins in `composeTeamContext` behave identically. And
 * `briefing_context_updated_at` crosses as an ISO string either way — the
 * driver normalizes `timestamptz`, and `to_jsonb` renders it — differing only
 * in the `Z`/`+00:00` spelling of a value the model reads as prose.
 */
export const BRIEFING_CONTEXT_GUARD_SQL = {
  campaignsContext: `
select id, name, instance_id, briefing_context, briefing_context_updated_at
from campaigns
order by name
`.trim(),
  hypothesesList: `
select id, name, description
from hypotheses
where archived = false
order by name
`.trim(),
  assignments: `
select hypothesis_id, campaign_id
from hypothesis_campaigns
`.trim(),
  // `now() - interval '30 days'` rather than a bound parameter, because the
  // guard's signature is `ai_execute_sql(text)` and there is nowhere to bind
  // one. The window is the same 30 days the Supabase and direct paths compute
  // in JavaScript, evaluated one layer down instead.
  recentAnnotations: `
select instance_id, campaign_id, note, noted_at
from annotations
where noted_at >= now() - interval '30 days'
order by noted_at desc
limit 100
`.trim(),
} as const

export const BRIEFING_WRITE_COMMANDS = {
  ensureJob: AI_WRITE_OPERATIONS.briefingEnsureJob,
  claimJob: AI_WRITE_OPERATIONS.briefingClaimJob,
  finishStage: AI_WRITE_OPERATIONS.briefingFinishStage,
  failStage: AI_WRITE_OPERATIONS.briefingFailStage,
  resetJob: AI_WRITE_OPERATIONS.briefingResetJob,
  staleError: AI_WRITE_OPERATIONS.briefingStaleError,
  upsertBriefing: AI_WRITE_OPERATIONS.briefingUpsertBriefing,
} as const

export const BRIEFING_WRITE_OPERATIONS = {
  jobRow: AI_WRITE_OPERATIONS.briefingJobRow,
  prior: AI_WRITE_OPERATIONS.briefingPrior,
  weeklyReference: AI_WRITE_OPERATIONS.briefingWeeklyReference,
  campaignsContext: AI_WRITE_OPERATIONS.briefingCampaignsContext,
  instancesList: AI_WRITE_OPERATIONS.briefingInstancesList,
  hypothesesList: AI_WRITE_OPERATIONS.briefingHypothesesList,
  assignments: AI_WRITE_OPERATIONS.briefingAssignments,
  assignedSearches: AI_WRITE_OPERATIONS.briefingAssignedSearches,
  recentAnnotations: AI_WRITE_OPERATIONS.briefingRecentAnnotations,
} as const
