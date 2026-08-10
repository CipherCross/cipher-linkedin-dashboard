/**
 * The manual CRM write vocabulary: stage moves, notes, the demographics
 * override, and the notebook config blob.
 *
 * ## Why these are in their own module rather than in `pipeline.ts`
 *
 * `pipeline.ts`'s header is an essay about *read* semantics — keyset order,
 * delta watermarks, which errors a truncated audit log may tolerate. Write
 * semantics are a different subject: what must commit together, which audit row
 * pairs with which mutation, and what a zero row count means. `identity.ts`
 * mixes both, and that works only because it is small and single-subject. These
 * are neither.
 *
 * ## The pairing rule, which is the whole point of this module
 *
 * Four of the actions here are really *two* writes that must not come apart:
 *
 * | mutation | its audit row |
 * |---|---|
 * | `leads.pipeline_stage` moves | `pipeline_events` `kind='stage'` |
 * | `leads.assigned_to` moves | `pipeline_events` `kind='assignment'` |
 * | `leads.gender` override | `lead_gender_reviews` |
 *
 * On the Supabase path each pair is two PostgREST calls, and the second one
 * failing is reported as `event_error` or `review_error` **inside a 200**. So
 * today a stage can move with no audit row and the caller is told `ok: true`.
 * That matters more than it sounds: `pipeline_events` is not a log the dashboard
 * displays, it is what "ever reached stage X" is *reconstructed* from, so a
 * missing row silently lowers a funnel number for good. There is no repair path,
 * because nothing records that the row is missing.
 *
 * Here both writes are `execute` calls inside one `DataStore.transaction`, so
 * the audit row failing rolls the mutation back and the caller gets an error
 * instead of a false success. `tests/pipelineWrites.neon.test.ts` proves it by
 * failing the second write on purpose and then showing the first one absent.
 *
 * **The cost of that, measured rather than asserted:** a pair is two round trips
 * inside the transaction instead of one, on top of the driver's `BEGIN` and its
 * `set_config` preamble. `tests/pairedWriteLatency.neon.test.ts` runs both
 * against the live pooled endpoint and the answer is stable across runs:
 *
 * | | p50 | p90 |
 * |---|---|---|
 * | two operations in one transaction | **197–201 ms** | 252–285 ms |
 * | one CTE statement doing both writes | **156–159 ms** | 241–247 ms |
 *
 * So the extra round trip costs **≈41 ms, a factor of 1.26** — three runs of 15,
 * same region, same minute. The alternative is one round trip and equally
 * atomic, and it was rejected because it puts two operations' SQL in one
 * allowlist entry, which is exactly the coupling the named-operation registry
 * exists to prevent. 41 ms is a human clicking a board once, not a fan-out; if
 * this ever became a fan-out the trade would be worth re-taking, which is why
 * the measurement is a test that keeps running rather than a number in a
 * document.
 *
 * ## No `authorize` hooks, for the reason `identity.ts` gives
 *
 * A hook may only ever narrow what the database already permits, so adding one
 * would create a second, weaker authorization path that can drift from the RLS
 * policy. Every relation touched here carries `FOR ALL TO app_runtime` with a
 * `WITH CHECK` that re-derives the actor from `app.actor_id` — so an INSERT by a
 * non-member fails the check, not a hook. The endpoints still refuse early to
 * shape a clean 403 instead of a raw SQLSTATE, and the live suite proves the
 * database refuses independently of them.
 */

import type { NeonCommandOperation, NeonQueryOperation, NeonRow } from '../neon.js'

export const PIPELINE_WRITE_OPERATIONS = {
  /** Current pipeline columns of one lead, read to build the audit row. */
  leadPipelineFields: 'pipeline.leadPipelineFields',
  /** Current assignee of one lead, locked before changing assignment. */
  leadAssignment: 'pipeline.leadAssignment',
  /** One target assignee in this database's roster, never another provider's. */
  teamMemberById: 'pipeline.teamMemberById',
  /** Current demographics columns, read to snapshot what the human reviewed. */
  leadDemographics: 'pipeline.leadDemographics',
  /** The acting member's own display name, for the audit row's `actor` text. */
  actorDisplayName: 'pipeline.actorDisplayName',
} as const

export const PIPELINE_WRITE_COMMANDS = {
  setStage: 'pipeline.setStage',
  appendStageEvent: 'pipeline.appendStageEvent',
  setAssignment: 'pipeline.setAssignment',
  appendAssignmentEvent: 'pipeline.appendAssignmentEvent',
  addNote: 'pipeline.addNote',
  deleteNote: 'pipeline.deleteNote',
  setGender: 'pipeline.setGender',
  appendGenderReview: 'pipeline.appendGenderReview',
  setInstanceConfig: 'pipeline.setInstanceConfig',
} as const

const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value)

const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

// ---------------------------------------------------------------------------
// The two reads that exist only to build an audit row.
// ---------------------------------------------------------------------------

export interface LeadPipelineFieldsRow {
  readonly id: string
  readonly pipeline_stage: string | null
  readonly pipeline_substatus: string | null
  readonly lost_reason: string | null
}

export interface LeadByIdParams {
  readonly leadId: string
  readonly [key: string]: string
}

/**
 * Read inside the write transaction, **and with `FOR UPDATE`**.
 *
 * The first half is the difference from the Supabase path, where the "what was
 * the stage before?" read is its own call: two concurrent stage moves there can
 * both read the same previous stage and write two audit rows claiming the same
 * origin, so the reconstructed history forks.
 *
 * Reading it inside the writing transaction does not by itself fix that —
 * Postgres default isolation is READ COMMITTED, so both transactions can still
 * read the same row before either writes. The `UPDATE` that follows does take a
 * row lock, so the second transaction blocks *there*; but by then it has already
 * decided what its audit row says, and it says the stage came from a value that
 * is no longer true. `pipeline_events` is what "ever reached stage X" is
 * reconstructed from, so that is a wrong history rather than a stale one.
 *
 * `FOR UPDATE` moves the lock to the read, which is where the decision is taken.
 * The second transaction blocks before it reads, and resumes seeing the first
 * one's result — so the two audit rows chain instead of forking. Three notes:
 *
 * - **No deadlock is introduced.** One row, locked first, and every stage move
 *   takes it in the same order.
 * - **It serializes concurrent moves of the *same* lead only.** Different leads
 *   are different rows and do not contend.
 * - **`leadDemographics` deliberately does not get the same treatment.**
 *   `set_gender` updates by `(instance_id, profile_url)` while reading by lead
 *   id, so locking the row it read would leave a concurrent writer that read a
 *   *sibling* row of the same person unblocked — a lock that looks like a fix
 *   and is not one. Closing that properly means locking the person, and the
 *   right instrument is the advisory lock the import already uses. Recorded as a
 *   Known limit rather than half-done.
 */
const LEAD_PIPELINE_FIELDS_SQL = `SELECT l.id::text AS id,
          l.pipeline_stage,
          l.pipeline_substatus,
          l.lost_reason
     FROM public.leads l
    WHERE l.id = $1::uuid
      FOR UPDATE`

export const leadPipelineFieldsOperation: NeonQueryOperation<
  LeadPipelineFieldsRow,
  LeadByIdParams
> = {
  build: ({ params }) => ({
    text: LEAD_PIPELINE_FIELDS_SQL,
    values: [params?.leadId ?? ''],
  }),
  mapRow: (row: NeonRow): LeadPipelineFieldsRow => ({
    id: String(row.id),
    pipeline_stage: nullableText(row.pipeline_stage),
    pipeline_substatus: nullableText(row.pipeline_substatus),
    lost_reason: nullableText(row.lost_reason),
  }),
}

export interface LeadDemographicsRow {
  readonly id: string
  readonly instance_id: string
  readonly profile_url: string
  readonly gender: string | null
  readonly gender_confidence: number | null
  readonly demo_model: string | null
  readonly gender_model_version: string | null
}

const LEAD_DEMOGRAPHICS_SQL = `SELECT l.id::text AS id,
          l.instance_id,
          l.profile_url,
          l.gender,
          l.gender_confidence,
          l.demo_model,
          l.gender_model_version
     FROM public.leads l
    WHERE l.id = $1::uuid`

export const leadDemographicsOperation: NeonQueryOperation<
  LeadDemographicsRow,
  LeadByIdParams
> = {
  build: ({ params }) => ({
    text: LEAD_DEMOGRAPHICS_SQL,
    values: [params?.leadId ?? ''],
  }),
  mapRow: (row: NeonRow): LeadDemographicsRow => ({
    id: String(row.id),
    instance_id: String(row.instance_id),
    profile_url: String(row.profile_url),
    gender: nullableText(row.gender),
    gender_confidence: nullableNumber(row.gender_confidence),
    demo_model: nullableText(row.demo_model),
    gender_model_version: nullableText(row.gender_model_version),
  }),
}

// ---------------------------------------------------------------------------
// Who is acting, by name.
// ---------------------------------------------------------------------------

export interface ActorDisplayNameRow {
  readonly name: string
}

/**
 * `pipeline_events.actor` and `lead_notes.author` are **text names**, snapshotted
 * at the time of the action so the log stays readable with no roster and no join,
 * and stays readable after the member leaves. So a write needs a name, and the
 * question is where it comes from.
 *
 * **From this database, keyed on `team_members.user_id`.** Two alternatives lost:
 *
 * - *Reuse the Supabase principal's name*, which the endpoint already holds. It
 *   is one fewer round trip and it is wrong in a way that would not show up for
 *   months: the audit trail of a Neon write would be sourced from Supabase, so
 *   the two providers could disagree about who did something and the row on Neon
 *   would be the one that was wrong.
 * - *Carry the name in the `ActorContext`.* `resolveActor` deliberately returns
 *   `actorId` and `role` and nothing else, because everything it returns becomes
 *   something the resolver is trusted for. A display name is presentation data;
 *   putting it there would widen the one function that runs with no actor
 *   published.
 *
 * **The key is the uuid, never the bigint.** `team_members.id` is the colliding
 * id space N-B2 measured — the same integer denotes different people on the two
 * providers. `user_id` is the canonical uuid, which is also what `app.actor_id`
 * holds and what every RLS policy compares against, so this lookup cannot pick
 * the wrong person. That is why it is a roster read this session is allowed to
 * make while `leads.assigned_to` remains blocked.
 */
const ACTOR_DISPLAY_NAME_SQL = `SELECT tm.name
     FROM public.team_members tm
    WHERE tm.user_id = $1::uuid AND tm.active`

export interface ActorDisplayNameParams {
  readonly actorId: string
  readonly [key: string]: string
}

export const actorDisplayNameOperation: NeonQueryOperation<
  ActorDisplayNameRow,
  ActorDisplayNameParams
> = {
  build: ({ params }) => ({
    text: ACTOR_DISPLAY_NAME_SQL,
    values: [params?.actorId ?? ''],
  }),
  mapRow: (row: NeonRow): ActorDisplayNameRow => ({ name: String(row.name) }),
}

// ---------------------------------------------------------------------------
// assign.
// ---------------------------------------------------------------------------

/**
 * Assignment is keyed on this database's `team_members.id`, so both the lead
 * and the candidate member must be read through the same actor-scoped store.
 * The lead lock serializes competing assignments before either audit event is
 * built, preserving a truthful `from_assignee` chain just as stage moves do.
 */
export interface LeadAssignmentRow {
  readonly id: string
  readonly assigned_to: number | null
}

const LEAD_ASSIGNMENT_SQL = `SELECT l.id::text AS id, l.assigned_to
     FROM public.leads l
    WHERE l.id = $1::uuid
      FOR UPDATE`

export const leadAssignmentOperation: NeonQueryOperation<
  LeadAssignmentRow,
  LeadByIdParams
> = {
  build: ({ params }) => ({
    text: LEAD_ASSIGNMENT_SQL,
    values: [params?.leadId ?? ''],
  }),
  mapRow: (row: NeonRow): LeadAssignmentRow => ({
    id: String(row.id),
    assigned_to: nullableNumber(row.assigned_to),
  }),
}

export interface TeamMemberByIdRow {
  readonly id: number
  readonly name: string
  readonly active: boolean
}

export interface TeamMemberByIdParams {
  readonly memberId: number
  readonly [key: string]: number
}

const TEAM_MEMBER_BY_ID_SQL = `SELECT tm.id, tm.name, tm.active
     FROM public.team_members tm
    WHERE tm.id = $1::bigint`

export const teamMemberByIdOperation: NeonQueryOperation<
  TeamMemberByIdRow,
  TeamMemberByIdParams
> = {
  build: ({ params }) => ({
    text: TEAM_MEMBER_BY_ID_SQL,
    values: [params?.memberId ?? 0],
  }),
  mapRow: (row: NeonRow): TeamMemberByIdRow => ({
    id: Number(row.id),
    name: String(row.name),
    active: row.active === true,
  }),
}

export interface SetAssignmentParams {
  readonly leadId: string
  readonly memberId: number | null
  readonly [key: string]: string | number | null
}

const SET_ASSIGNMENT_SQL = `UPDATE public.leads
      SET assigned_to = $2::bigint
    WHERE id = $1::uuid
RETURNING id`

export const setAssignmentOperation: NeonCommandOperation<
  DeleteResult,
  SetAssignmentParams
> = {
  build: ({ params }) => ({
    text: SET_ASSIGNMENT_SQL,
    values: [params?.leadId ?? '', params?.memberId ?? null],
  }),
  mapResult: (_rows, rowCount): DeleteResult => ({ rowCount }),
}

export interface AppendAssignmentEventParams {
  readonly leadId: string
  readonly actor: string
  readonly fromAssignee: string | null
  readonly toAssignee: string | null
  readonly [key: string]: string | null
}

const APPEND_ASSIGNMENT_EVENT_SQL = `INSERT INTO public.pipeline_events
            (lead_id, kind, actor, from_assignee, to_assignee)
     VALUES ($1::uuid, 'assignment', $2, $3, $4)
  RETURNING id::text AS id, occurred_at`

export const appendAssignmentEventOperation: NeonCommandOperation<
  AppendEventResult,
  AppendAssignmentEventParams
> = {
  build: ({ params }) => ({
    text: APPEND_ASSIGNMENT_EVENT_SQL,
    values: [
      params?.leadId ?? '',
      params?.actor ?? '',
      params?.fromAssignee ?? null,
      params?.toAssignee ?? null,
    ],
  }),
  mapResult: (rows): AppendEventResult => ({
    id: String(rows[0]?.id ?? ''),
    occurred_at: String(rows[0]?.occurred_at ?? ''),
  }),
}

// ---------------------------------------------------------------------------
// set_stage.
// ---------------------------------------------------------------------------

/**
 * What happens to `pipeline_stage_changed_at`, which is the only subtle part.
 *
 * Time-in-stage is derived from it, so it must move when the stage moves and
 * hold still when only the substatus is edited — otherwise a label change resets
 * the clock and every stage-duration number is wrong. Three outcomes, and the
 * caller names which one it wants rather than the statement guessing from the
 * other parameters:
 *
 * - `clear` — the lead left the pipeline (`stage = null`), so the timestamp goes
 *   with it.
 * - `set` — the stage itself moved; the caller's instant is written.
 * - `keep` — a substatus-only or `lost_reason`-only edit; the column is assigned
 *   from itself, which is a no-op write rather than a skipped one, so the
 *   statement's shape does not change with the case.
 */
export type StageChangedAtMode = 'clear' | 'set' | 'keep'

export interface SetStageParams {
  readonly leadId: string
  readonly stage: string | null
  readonly substatus: string | null
  readonly lostReason: string | null
  readonly changedAtMode: StageChangedAtMode
  readonly changedAt: string | null
  readonly [key: string]: string | null
}

export interface SetStageResult {
  readonly rowCount: number
  readonly row: {
    readonly id: string
    readonly pipeline_stage: string | null
    readonly pipeline_substatus: string | null
    readonly lost_reason: string | null
    readonly pipeline_stage_changed_at: string | null
  } | null
}

const SET_STAGE_SQL = `UPDATE public.leads
      SET pipeline_stage = $2,
          pipeline_substatus = $3,
          lost_reason = $4,
          pipeline_stage_changed_at = CASE $5::text
              WHEN 'clear' THEN NULL
              WHEN 'set' THEN $6::timestamptz
              ELSE pipeline_stage_changed_at
          END
    WHERE id = $1::uuid
RETURNING id::text AS id,
          pipeline_stage,
          pipeline_substatus,
          lost_reason,
          pipeline_stage_changed_at`

export const setStageOperation: NeonCommandOperation<SetStageResult, SetStageParams> =
  {
    build: ({ params }) => ({
      text: SET_STAGE_SQL,
      values: [
        params?.leadId ?? '',
        params?.stage ?? null,
        params?.substatus ?? null,
        params?.lostReason ?? null,
        params?.changedAtMode ?? 'keep',
        params?.changedAt ?? null,
      ],
    }),
    mapResult: (rows, rowCount): SetStageResult => ({
      rowCount,
      row: rows[0]
        ? {
            id: String(rows[0].id),
            pipeline_stage: nullableText(rows[0].pipeline_stage),
            pipeline_substatus: nullableText(rows[0].pipeline_substatus),
            lost_reason: nullableText(rows[0].lost_reason),
            pipeline_stage_changed_at: nullableText(
              rows[0].pipeline_stage_changed_at,
            ),
          }
        : null,
    }),
  }

export interface AppendStageEventParams {
  readonly leadId: string
  readonly actor: string
  readonly fromStage: string | null
  readonly toStage: string | null
  readonly fromSubstatus: string | null
  readonly toSubstatus: string | null
  readonly lostReason: string | null
  readonly [key: string]: string | null
}

export interface AppendEventResult {
  readonly id: string
  readonly occurred_at: string
}

const APPEND_STAGE_EVENT_SQL = `INSERT INTO public.pipeline_events
            (lead_id, kind, actor, from_stage, to_stage,
             from_substatus, to_substatus, lost_reason)
     VALUES ($1::uuid, 'stage', $2, $3, $4, $5, $6, $7)
  RETURNING id::text AS id, occurred_at`

export const appendStageEventOperation: NeonCommandOperation<
  AppendEventResult,
  AppendStageEventParams
> = {
  build: ({ params }) => ({
    text: APPEND_STAGE_EVENT_SQL,
    values: [
      params?.leadId ?? '',
      params?.actor ?? '',
      params?.fromStage ?? null,
      params?.toStage ?? null,
      params?.fromSubstatus ?? null,
      params?.toSubstatus ?? null,
      params?.lostReason ?? null,
    ],
  }),
  mapResult: (rows): AppendEventResult => ({
    id: String(rows[0]?.id ?? ''),
    occurred_at: String(rows[0]?.occurred_at ?? ''),
  }),
}

// ---------------------------------------------------------------------------
// add_note / delete_note.
// ---------------------------------------------------------------------------

export interface AddNoteParams {
  readonly leadId: string
  readonly author: string
  readonly body: string
  readonly [key: string]: string
}

export interface LeadNoteResult {
  readonly rowCount: number
  readonly row: {
    readonly id: number
    readonly lead_id: string
    readonly author: string | null
    readonly body: string
    readonly created_at: string
  } | null
}

/**
 * `INSERT … SELECT … FROM leads WHERE id = $1`, not `INSERT … VALUES`.
 *
 * The Supabase path checks the lead exists in its own call and then inserts, so
 * a lead deleted between the two yields a foreign-key error with a 500 rather
 * than the 404 the caller was promised. Selecting the parent in the insert makes
 * "unknown lead" a **zero row count** instead of an error, in one statement:
 * there is no window to lose the lead in, and the handler maps 0 to 404 without
 * having to read a SQLSTATE.
 */
const ADD_NOTE_SQL = `INSERT INTO public.lead_notes (lead_id, author, body)
     SELECT l.id, $2, $3
       FROM public.leads l
      WHERE l.id = $1::uuid
  RETURNING id, lead_id::text AS lead_id, author, body, created_at`

const mapNote = (rows: readonly NeonRow[], rowCount: number): LeadNoteResult => ({
  rowCount,
  row: rows[0]
    ? {
        id: Number(rows[0].id),
        lead_id: String(rows[0].lead_id),
        author: nullableText(rows[0].author),
        body: String(rows[0].body),
        created_at: String(rows[0].created_at),
      }
    : null,
})

export const addNoteOperation: NeonCommandOperation<LeadNoteResult, AddNoteParams> =
  {
    build: ({ params }) => ({
      text: ADD_NOTE_SQL,
      values: [params?.leadId ?? '', params?.author ?? '', params?.body ?? ''],
    }),
    mapResult: mapNote,
  }

export interface DeleteNoteParams {
  readonly noteId: number
  readonly [key: string]: number
}

export interface DeleteResult {
  readonly rowCount: number
}

const DELETE_NOTE_SQL = `DELETE FROM public.lead_notes
    WHERE id = $1::bigint
RETURNING id`

export const deleteNoteOperation: NeonCommandOperation<
  DeleteResult,
  DeleteNoteParams
> = {
  build: ({ params }) => ({
    text: DELETE_NOTE_SQL,
    values: [params?.noteId ?? 0],
  }),
  mapResult: (_rows, rowCount): DeleteResult => ({ rowCount }),
}

// ---------------------------------------------------------------------------
// set_gender.
// ---------------------------------------------------------------------------

/**
 * Keyed by `(instance_id, profile_url)`, so it updates the person and not the
 * row — the same human reached from two campaigns is two `leads` rows with one
 * gender, and an SDR who corrects it on one board expects the other to agree.
 * The Supabase path does the same thing; it is restated here because the
 * parameter is a lead id and the `WHERE` is not.
 *
 * **The rolling-deploy fallback is gone, and that is a measurement rather than a
 * simplification.** The Supabase handler retries with a narrower patch on
 * SQLSTATE 42703, because migration 041 supported the override before 048 added
 * `gender_inferred_at` / `gender_model_version`, and a deployment could be mid
 * roll. The portable baseline has all four columns in step `001` by
 * construction — checked in `001_portable_business_baseline.sql`, `public.leads`
 * — so on this path there is no version of the schema the retry could rescue,
 * and a retry that can never fire is a branch nothing tests.
 *
 * `gender_model_version` is set to NULL on both branches, matching the Supabase
 * handler: a human override has no model version, and clearing it is what stops
 * a later backfill treating the row as machine-labelled at some version.
 */
export interface SetGenderParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly gender: string | null
  readonly confidence: number | null
  readonly demoModel: string | null
  readonly inferredAt: string | null
  readonly [key: string]: string | number | null
}

export interface SetGenderResult {
  readonly rowCount: number
  readonly rows: readonly {
    readonly id: string
    readonly gender: string | null
    readonly gender_confidence: number | null
    readonly gender_inferred_at: string | null
    readonly gender_model_version: string | null
    readonly demo_model: string | null
    readonly demo_inferred_at: string | null
    readonly birth_year_min: number | null
    readonly birth_year_max: number | null
  }[]
}

const SET_GENDER_SQL = `UPDATE public.leads
      SET gender = $3,
          gender_confidence = $4::real,
          demo_model = $5,
          demo_inferred_at = $6::timestamptz,
          gender_inferred_at = $6::timestamptz,
          gender_model_version = NULL
    WHERE instance_id = $1 AND profile_url = $2
RETURNING id::text AS id,
          gender,
          gender_confidence,
          gender_inferred_at,
          gender_model_version,
          demo_model,
          demo_inferred_at,
          birth_year_min,
          birth_year_max`

export const setGenderOperation: NeonCommandOperation<
  SetGenderResult,
  SetGenderParams
> = {
  build: ({ params }) => ({
    text: SET_GENDER_SQL,
    values: [
      params?.instanceId ?? '',
      params?.profileUrl ?? '',
      params?.gender ?? null,
      params?.confidence ?? null,
      params?.demoModel ?? null,
      params?.inferredAt ?? null,
    ],
  }),
  mapResult: (rows, rowCount): SetGenderResult => ({
    rowCount,
    rows: rows.map((row) => ({
      id: String(row.id),
      gender: nullableText(row.gender),
      gender_confidence: nullableNumber(row.gender_confidence),
      gender_inferred_at: nullableText(row.gender_inferred_at),
      gender_model_version: nullableText(row.gender_model_version),
      demo_model: nullableText(row.demo_model),
      demo_inferred_at: nullableText(row.demo_inferred_at),
      birth_year_min: nullableNumber(row.birth_year_min),
      birth_year_max: nullableNumber(row.birth_year_max),
    })),
  }),
}

export interface AppendGenderReviewParams {
  readonly leadId: string
  readonly instanceId: string
  readonly profileUrl: string
  readonly action: 'set' | 'clear'
  readonly predictedGender: string | null
  readonly predictedConfidence: number | null
  readonly predictedModel: string | null
  readonly predictedVersion: string | null
  readonly reviewedGender: string | null
  readonly reviewer: string
  readonly [key: string]: string | number | null
}

const APPEND_GENDER_REVIEW_SQL = `INSERT INTO public.lead_gender_reviews
            (lead_id, instance_id, profile_url, action,
             predicted_gender, predicted_confidence, predicted_model,
             predicted_version, reviewed_gender, reviewer)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::real, $7, $8, $9, $10)
  RETURNING id::text AS id`

export const appendGenderReviewOperation: NeonCommandOperation<
  { readonly id: string },
  AppendGenderReviewParams
> = {
  build: ({ params }) => ({
    text: APPEND_GENDER_REVIEW_SQL,
    values: [
      params?.leadId ?? '',
      params?.instanceId ?? '',
      params?.profileUrl ?? '',
      params?.action ?? 'set',
      params?.predictedGender ?? null,
      params?.predictedConfidence ?? null,
      params?.predictedModel ?? null,
      params?.predictedVersion ?? null,
      params?.reviewedGender ?? null,
      params?.reviewer ?? '',
    ],
  }),
  mapResult: (rows) => ({ id: String(rows[0]?.id ?? '') }),
}

// ---------------------------------------------------------------------------
// set_instance_config.
// ---------------------------------------------------------------------------

/**
 * The config blob crosses the store boundary as a **JSON string**, cast to
 * `jsonb` in the statement.
 *
 * `DataStoreParam` admits strings, numbers, booleans, null, timestamps and
 * arrays of those — deliberately not arbitrary objects, so that no adapter has
 * to decide how to serialize one. Widening the contract for this single caller
 * would let every future operation pass a shape whose encoding is the driver's
 * guess. The handler already serializes the blob to size-check it, so the string
 * is free.
 *
 * The bootstrap-key strip stays in the handler rather than moving here: it is a
 * product rule about what an operator may set remotely, and an operation that
 * silently dropped keys would make an endpoint's own validation untestable.
 */
export interface SetInstanceConfigParams {
  readonly instanceId: string
  readonly configJson: string
  readonly [key: string]: string
}

const SET_INSTANCE_CONFIG_SQL = `UPDATE public.instances
      SET config = $2::jsonb,
          config_updated_at = now()
    WHERE id = $1
RETURNING id`

export const setInstanceConfigOperation: NeonCommandOperation<
  DeleteResult,
  SetInstanceConfigParams
> = {
  build: ({ params }) => ({
    text: SET_INSTANCE_CONFIG_SQL,
    values: [params?.instanceId ?? '', params?.configJson ?? '{}'],
  }),
  mapResult: (_rows, rowCount): DeleteResult => ({ rowCount }),
}
