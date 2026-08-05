/**
 * The sourcing library's write vocabulary: the ICP layer, hypotheses, saved
 * searches, a campaign's briefing context and the singleton playbook.
 *
 * ## The problem this module had to solve first
 *
 * `api/playbook.ts` serves nine of its thirteen actions from two generic
 * helpers, `saveEntity(supa, table, bodyKey, …)` and `deleteEntity(supa, table,
 * …)`, which take the **table name as a string** and a validated patch whose key
 * set varies per request. That is exactly what a named-operation allowlist may
 * not express: one registry entry whose relation and column list are decided at
 * run time is not an allowlist, it is a query builder with extra steps.
 *
 * So the generic pair becomes one operation per (entity, verb) — fifteen of
 * them, plus four singletons. The registry gets longer and every entry names one
 * relation and one fixed column list, which is the property the whole design is
 * for. The **handler** keeps the generic shape (see `neonLibraryWrites.ts`):
 * genericity in TypeScript over a closed set of operation names costs nothing,
 * genericity in SQL over a table name costs the allowlist.
 *
 * ## How a partial-column UPDATE is expressed without a dynamic column list
 *
 * The Supabase path sends `.update(normalized)` where `normalized` holds only
 * the keys the caller supplied, so an absent key means "leave it alone" and an
 * explicit `null` means "clear it". Reproducing that with a fixed statement
 * needs a way to tell those two apart, which is why the patch crosses as
 * **jsonb** and every column is assigned from
 *
 * ```sql
 * col = CASE WHEN $2::jsonb ? 'col' THEN <extract> ELSE col END
 * ```
 *
 * `?` is key *presence*, so an explicit `null` takes the `THEN` branch and
 * clears the column while an absent key takes the `ELSE` and assigns the column
 * from itself. Three alternatives lost:
 *
 * - **`COALESCE(new, col)`** — the obvious answer, and wrong here. It cannot
 *   clear a column, because "absent" and "null" both arrive as SQL NULL. It is
 *   right in `conversationWrites.backfillMilestones` precisely because that
 *   statement must *never* clear anything, and this one must.
 * - **One statement per key subset** — combinatorial, and unreviewable.
 * - **`jsonb_populate_record`** — one expression for the whole row, but it
 *   resolves an absent key to NULL rather than to the column's current value, so
 *   a partial patch would blank every field it did not mention.
 *
 * The cost is that the patch crosses the store boundary as a JSON **string**,
 * for the reason `pipelineWrites.setInstanceConfig` records: `DataStoreParam`
 * deliberately does not admit arbitrary objects, so no adapter has to guess an
 * encoding. The handler already holds a validated object and `JSON.stringify` is
 * free.
 *
 * `text[]` columns extract as `ARRAY(SELECT jsonb_array_elements_text(…))`,
 * which yields `{}` for an absent key without naming the table's default a
 * second time — a set-returning function over NULL returns no rows, and `ARRAY`
 * of no rows is the empty array. That is why the INSERTs below carry no default
 * literals for the five NOT NULL array columns.
 *
 * ## Conflicts and dangling references are answers, not failures
 *
 * A duplicate name is a 409 and a missing parent is a 400 on the Supabase path,
 * derived from SQLSTATE 23505 / 23503. Neither is caught here: the driver
 * classifies both into `DataStoreConstraintError` (see `contracts.ts`), and the
 * handler maps `kind` to the status. Doing it in the statement instead — an
 * `ON CONFLICT DO NOTHING` whose zero row count means "conflict" — was rejected
 * because it makes an UPDATE's rename conflict inexpressible (there is no
 * `ON CONFLICT` for UPDATE) and it collides with the zero row count that already
 * means "unknown id".
 *
 * ## Why `updated_at` appears nowhere below
 *
 * `icps`, `icp_personas`, `icp_industries`, `hypotheses`, `saved_searches` and
 * `campaigns` all carry `touch_updated_at` BEFORE UPDATE triggers in baseline
 * step `003`, and that trigger deliberately *overrides* a manually supplied
 * stamp. The one exception is `playbook`, which has no trigger, so its upsert
 * sets the column — matching the Supabase path, which sets it on every one of
 * these tables and is silently ignored on six of them.
 */

import type { NeonCommandOperation, NeonRow } from '../neon.js'

import {
  mapHypothesisRow,
  mapIcpIndustryRow,
  mapIcpPersonaRow,
  mapIcpRow,
  mapSavedSearchRow,
  nullableText,
  type HypothesisRow,
  type IcpIndustryRow,
  type IcpPersonaRow,
  type IcpRow,
  type SavedSearchRow,
} from './library.js'

export const LIBRARY_WRITE_COMMANDS = {
  insertIcp: 'library.insertIcp',
  updateIcp: 'library.updateIcp',
  deleteIcp: 'library.deleteIcp',
  insertPersona: 'library.insertPersona',
  updatePersona: 'library.updatePersona',
  deletePersona: 'library.deletePersona',
  insertIndustry: 'library.insertIndustry',
  updateIndustry: 'library.updateIndustry',
  deleteIndustry: 'library.deleteIndustry',
  insertHypothesis: 'library.insertHypothesis',
  updateHypothesis: 'library.updateHypothesis',
  deleteHypothesis: 'library.deleteHypothesis',
  insertSavedSearch: 'library.insertSavedSearch',
  updateSavedSearch: 'library.updateSavedSearch',
  deleteSavedSearch: 'library.deleteSavedSearch',
  setHypothesisCampaigns: 'library.setHypothesisCampaigns',
  assignSearchHypothesis: 'library.assignSearchHypothesis',
  saveCampaignContext: 'library.saveCampaignContext',
  savePlaybook: 'library.savePlaybook',
} as const

/**
 * One row, or none, plus the count that says which.
 *
 * Every save and every delete below answers in this shape, so the handler's
 * `rowCount === 0 → 404` is one line written once rather than nineteen times.
 */
export interface EntityWriteResult<TRow> {
  readonly rowCount: number
  readonly row: TRow | null
}

/** The patch, as JSON text. See the module header on why it is a string. */
export interface EntityPatchParams {
  readonly patchJson: string
  readonly [key: string]: string
}

export interface EntityUpdateParams {
  readonly id: number
  readonly patchJson: string
  readonly [key: string]: string | number
}

export interface EntityIdParams {
  readonly id: number
  readonly [key: string]: number
}

const mapOne =
  <TRow>(mapRow: (row: NeonRow) => TRow) =>
  (rows: readonly NeonRow[], rowCount: number): EntityWriteResult<TRow> => ({
    rowCount,
    row: rows[0] ? mapRow(rows[0]) : null,
  })

/** `col = CASE WHEN patch ? 'col' THEN <extract> ELSE col END`, once. */
const patched = (column: string, extract: string): string =>
  `${column} = CASE WHEN $2::jsonb ? '${column}' THEN ${extract} ELSE ${column} END`

const text = (column: string, param = '$2') => `${param}::jsonb->>'${column}'`
const textArrayOf = (column: string, param = '$2') =>
  `ARRAY(SELECT jsonb_array_elements_text(${param}::jsonb->'${column}'))`
const boolOf = (column: string, param = '$2') =>
  `(${param}::jsonb->>'${column}')::boolean`
const bigintOf = (column: string, param = '$2') =>
  `(${param}::jsonb->>'${column}')::bigint`
const intOf = (column: string, param = '$2') =>
  `(${param}::jsonb->>'${column}')::integer`
const jsonOf = (column: string, param = '$2') => `${param}::jsonb->'${column}'`

const patchedText = (column: string) => patched(column, text(column))
const patchedTextArray = (column: string) => patched(column, textArrayOf(column))

// ---------------------------------------------------------------------------
// icps
// ---------------------------------------------------------------------------

const ICP_RETURNING = `RETURNING id::text AS id,
          name,
          airtable_url,
          main_product,
          core_sphere,
          secondary_sphere,
          product_stage,
          monetization,
          features_note,
          purchase_triggers,
          features,
          company_countries,
          company_headcount,
          company_age,
          apollo_industries,
          funding,
          dev_team_availability,
          dev_team_location,
          exclude_keywords,
          archived,
          created_at,
          updated_at`

const ICP_TEXT_COLUMNS = [
  'airtable_url',
  'main_product',
  'core_sphere',
  'secondary_sphere',
  'product_stage',
  'monetization',
  'features_note',
  'company_headcount',
  'company_age',
  'funding',
  'dev_team_availability',
  'dev_team_location',
]

const ICP_ARRAY_COLUMNS = [
  'purchase_triggers',
  'features',
  'company_countries',
  'apollo_industries',
  'exclude_keywords',
]

/**
 * The insert takes `$1` rather than `$2` so the update's `$1` can be the id and
 * both statements can share the extractor helpers. `name` is NOT NULL and the
 * validator has already required it on a create, so it is extracted
 * unconditionally — a create that reached here without one is a defect and the
 * NOT NULL is the right place for it to surface.
 */
const INSERT_ICP_SQL = `INSERT INTO public.icps
            (name, ${ICP_TEXT_COLUMNS.join(', ')},
             ${ICP_ARRAY_COLUMNS.join(', ')}, archived)
     VALUES (${text('name', '$1')},
             ${ICP_TEXT_COLUMNS.map((column) => text(column, '$1')).join(',\n             ')},
             ${ICP_ARRAY_COLUMNS.map((column) => textArrayOf(column, '$1')).join(',\n             ')},
             COALESCE(${boolOf('archived', '$1')}, false))
  ${ICP_RETURNING}`

const UPDATE_ICP_SQL = `UPDATE public.icps
      SET ${[
        patchedText('name'),
        ...ICP_TEXT_COLUMNS.map(patchedText),
        ...ICP_ARRAY_COLUMNS.map(patchedTextArray),
        patched('archived', boolOf('archived')),
      ].join(',\n          ')}
    WHERE id = $1::bigint
  ${ICP_RETURNING}`

export const insertIcpOperation: NeonCommandOperation<
  EntityWriteResult<IcpRow>,
  EntityPatchParams
> = {
  build: ({ params }) => ({
    text: INSERT_ICP_SQL,
    values: [params?.patchJson ?? '{}'],
  }),
  mapResult: mapOne(mapIcpRow),
}

export const updateIcpOperation: NeonCommandOperation<
  EntityWriteResult<IcpRow>,
  EntityUpdateParams
> = {
  build: ({ params }) => ({
    text: UPDATE_ICP_SQL,
    values: [params?.id ?? 0, params?.patchJson ?? '{}'],
  }),
  mapResult: mapOne(mapIcpRow),
}

// ---------------------------------------------------------------------------
// icp_personas
// ---------------------------------------------------------------------------

const PERSONA_RETURNING = `RETURNING id::text AS id,
          icp_id::text AS icp_id,
          kind,
          job_titles,
          age_range,
          location,
          background,
          profile_status,
          connections_note,
          followers_note,
          sort,
          created_at,
          updated_at`

const PERSONA_TEXT_COLUMNS = [
  'age_range',
  'location',
  'background',
  'profile_status',
  'connections_note',
  'followers_note',
]

const INSERT_PERSONA_SQL = `INSERT INTO public.icp_personas
            (icp_id, kind, job_titles, ${PERSONA_TEXT_COLUMNS.join(', ')}, sort)
     VALUES (${bigintOf('icp_id', '$1')},
             ${text('kind', '$1')},
             ${textArrayOf('job_titles', '$1')},
             ${PERSONA_TEXT_COLUMNS.map((column) => text(column, '$1')).join(',\n             ')},
             COALESCE(${intOf('sort', '$1')}, 0))
  ${PERSONA_RETURNING}`

const UPDATE_PERSONA_SQL = `UPDATE public.icp_personas
      SET ${[
        patched('icp_id', bigintOf('icp_id')),
        patchedText('kind'),
        patchedTextArray('job_titles'),
        ...PERSONA_TEXT_COLUMNS.map(patchedText),
        patched('sort', intOf('sort')),
      ].join(',\n          ')}
    WHERE id = $1::bigint
  ${PERSONA_RETURNING}`

export const insertPersonaOperation: NeonCommandOperation<
  EntityWriteResult<IcpPersonaRow>,
  EntityPatchParams
> = {
  build: ({ params }) => ({
    text: INSERT_PERSONA_SQL,
    values: [params?.patchJson ?? '{}'],
  }),
  mapResult: mapOne(mapIcpPersonaRow),
}

export const updatePersonaOperation: NeonCommandOperation<
  EntityWriteResult<IcpPersonaRow>,
  EntityUpdateParams
> = {
  build: ({ params }) => ({
    text: UPDATE_PERSONA_SQL,
    values: [params?.id ?? 0, params?.patchJson ?? '{}'],
  }),
  mapResult: mapOne(mapIcpPersonaRow),
}

// ---------------------------------------------------------------------------
// icp_industries
// ---------------------------------------------------------------------------

const INDUSTRY_RETURNING = `RETURNING id::text AS id,
          icp_id::text AS icp_id,
          name,
          include_keywords,
          created_at,
          updated_at`

const INSERT_INDUSTRY_SQL = `INSERT INTO public.icp_industries
            (icp_id, name, include_keywords)
     VALUES (${bigintOf('icp_id', '$1')},
             ${text('name', '$1')},
             ${textArrayOf('include_keywords', '$1')})
  ${INDUSTRY_RETURNING}`

const UPDATE_INDUSTRY_SQL = `UPDATE public.icp_industries
      SET ${[
        patched('icp_id', bigintOf('icp_id')),
        patchedText('name'),
        patchedTextArray('include_keywords'),
      ].join(',\n          ')}
    WHERE id = $1::bigint
  ${INDUSTRY_RETURNING}`

export const insertIndustryOperation: NeonCommandOperation<
  EntityWriteResult<IcpIndustryRow>,
  EntityPatchParams
> = {
  build: ({ params }) => ({
    text: INSERT_INDUSTRY_SQL,
    values: [params?.patchJson ?? '{}'],
  }),
  mapResult: mapOne(mapIcpIndustryRow),
}

export const updateIndustryOperation: NeonCommandOperation<
  EntityWriteResult<IcpIndustryRow>,
  EntityUpdateParams
> = {
  build: ({ params }) => ({
    text: UPDATE_INDUSTRY_SQL,
    values: [params?.id ?? 0, params?.patchJson ?? '{}'],
  }),
  mapResult: mapOne(mapIcpIndustryRow),
}

// ---------------------------------------------------------------------------
// hypotheses
// ---------------------------------------------------------------------------

const HYPOTHESIS_RETURNING = `RETURNING id::text AS id,
          name,
          icp_id::text AS icp_id,
          description,
          archived,
          created_at,
          updated_at`

const INSERT_HYPOTHESIS_SQL = `INSERT INTO public.hypotheses
            (name, icp_id, description, archived)
     VALUES (${text('name', '$1')},
             ${bigintOf('icp_id', '$1')},
             ${text('description', '$1')},
             COALESCE(${boolOf('archived', '$1')}, false))
  ${HYPOTHESIS_RETURNING}`

const UPDATE_HYPOTHESIS_SQL = `UPDATE public.hypotheses
      SET ${[
        patchedText('name'),
        patched('icp_id', bigintOf('icp_id')),
        patchedText('description'),
        patched('archived', boolOf('archived')),
      ].join(',\n          ')}
    WHERE id = $1::bigint
  ${HYPOTHESIS_RETURNING}`

export const insertHypothesisOperation: NeonCommandOperation<
  EntityWriteResult<HypothesisRow>,
  EntityPatchParams
> = {
  build: ({ params }) => ({
    text: INSERT_HYPOTHESIS_SQL,
    values: [params?.patchJson ?? '{}'],
  }),
  mapResult: mapOne(mapHypothesisRow),
}

export const updateHypothesisOperation: NeonCommandOperation<
  EntityWriteResult<HypothesisRow>,
  EntityUpdateParams
> = {
  build: ({ params }) => ({
    text: UPDATE_HYPOTHESIS_SQL,
    values: [params?.id ?? 0, params?.patchJson ?? '{}'],
  }),
  mapResult: mapOne(mapHypothesisRow),
}

// ---------------------------------------------------------------------------
// saved_searches
// ---------------------------------------------------------------------------

const SEARCH_RETURNING = `RETURNING id::text AS id,
          name,
          platform,
          description,
          include_keywords,
          exclude_keywords,
          boolean_query,
          filters,
          notes,
          author,
          archived,
          hypothesis_id::text AS hypothesis_id,
          created_at,
          updated_at`

const SEARCH_TEXT_COLUMNS = ['description', 'boolean_query', 'notes', 'author']

/**
 * `filters` is the one `jsonb` column in the slice, so it extracts with `->`
 * rather than `->>` and needs no cast. Its NOT NULL `'{}'` default is restated
 * as a `COALESCE` here because — unlike a `text[]` — an absent key gives SQL
 * NULL rather than an empty container.
 */
const INSERT_SEARCH_SQL = `INSERT INTO public.saved_searches
            (name, platform, ${SEARCH_TEXT_COLUMNS.join(', ')},
             include_keywords, exclude_keywords, filters, archived)
     VALUES (${text('name', '$1')},
             ${text('platform', '$1')},
             ${SEARCH_TEXT_COLUMNS.map((column) => text(column, '$1')).join(',\n             ')},
             ${textArrayOf('include_keywords', '$1')},
             ${textArrayOf('exclude_keywords', '$1')},
             COALESCE(${jsonOf('filters', '$1')}, '{}'::jsonb),
             COALESCE(${boolOf('archived', '$1')}, false))
  ${SEARCH_RETURNING}`

const UPDATE_SEARCH_SQL = `UPDATE public.saved_searches
      SET ${[
        patchedText('name'),
        patchedText('platform'),
        ...SEARCH_TEXT_COLUMNS.map(patchedText),
        patchedTextArray('include_keywords'),
        patchedTextArray('exclude_keywords'),
        patched('filters', jsonOf('filters')),
        patched('archived', boolOf('archived')),
      ].join(',\n          ')}
    WHERE id = $1::bigint
  ${SEARCH_RETURNING}`

export const insertSavedSearchOperation: NeonCommandOperation<
  EntityWriteResult<SavedSearchRow>,
  EntityPatchParams
> = {
  build: ({ params }) => ({
    text: INSERT_SEARCH_SQL,
    values: [params?.patchJson ?? '{}'],
  }),
  mapResult: mapOne(mapSavedSearchRow),
}

export const updateSavedSearchOperation: NeonCommandOperation<
  EntityWriteResult<SavedSearchRow>,
  EntityUpdateParams
> = {
  build: ({ params }) => ({
    text: UPDATE_SEARCH_SQL,
    values: [params?.id ?? 0, params?.patchJson ?? '{}'],
  }),
  mapResult: mapOne(mapSavedSearchRow),
}

/**
 * `assign_search` is not a `save_search` with one key in the patch, and keeping
 * it separate is deliberate. Its `hypothesis_id` is *required* and explicitly
 * nullable — "unassign" is `null`, not an absent key — so routing it through the
 * presence-tested patch would make the one payload whose null carries meaning
 * indistinguishable from a no-op. It also answers a dangling `hypothesis_id`
 * with 400 while `save_search` never touches the column at all.
 */
export interface AssignSearchParams {
  readonly searchId: number
  readonly hypothesisId: number | null
  readonly [key: string]: number | null
}

const ASSIGN_SEARCH_SQL = `UPDATE public.saved_searches
      SET hypothesis_id = $2::bigint
    WHERE id = $1::bigint
  ${SEARCH_RETURNING}`

export const assignSearchHypothesisOperation: NeonCommandOperation<
  EntityWriteResult<SavedSearchRow>,
  AssignSearchParams
> = {
  build: ({ params }) => ({
    text: ASSIGN_SEARCH_SQL,
    values: [params?.searchId ?? 0, params?.hypothesisId ?? null],
  }),
  mapResult: mapOne(mapSavedSearchRow),
}

// ---------------------------------------------------------------------------
// The four deletes, and why they are four and not one.
// ---------------------------------------------------------------------------

/**
 * Five near-identical statements that differ only in a relation name is exactly
 * the shape the generic `deleteEntity(supa, table, …)` had, and the temptation
 * is to keep it as one operation parameterized by table. The registry forbids
 * that for a reason worth restating: an allowlist entry whose relation is a
 * run-time string authorizes every relation. So they are written out, and the
 * repetition is the point.
 *
 * The children go with the parent by `ON DELETE CASCADE` in the baseline
 * (`icp_personas`, `icp_industries`, `hypothesis_campaigns`), not by a second
 * statement here.
 */
const deleteById = (
  relation: string,
): NeonCommandOperation<EntityWriteResult<{ readonly id: number }>, EntityIdParams> => ({
  build: ({ params }) => ({
    text: `DELETE FROM ${relation} WHERE id = $1::bigint RETURNING id::text AS id`,
    values: [params?.id ?? 0],
  }),
  mapResult: (rows, rowCount) => ({
    rowCount,
    row: rows[0] ? { id: Number(rows[0].id) } : null,
  }),
})

export const deleteIcpOperation = deleteById('public.icps')
export const deletePersonaOperation = deleteById('public.icp_personas')
export const deleteIndustryOperation = deleteById('public.icp_industries')
export const deleteHypothesisOperation = deleteById('public.hypotheses')
export const deleteSavedSearchOperation = deleteById('public.saved_searches')

// ---------------------------------------------------------------------------
// set_hypothesis_campaigns
// ---------------------------------------------------------------------------

/**
 * The one operation here that calls a baseline function rather than writing a
 * table, for the reason migration 043 gave it one: replacing a hypothesis's
 * campaign set is a delete plus an insert, and a campaign must never be visible
 * as belonging to neither hypothesis or to both. `set_hypothesis_campaigns`
 * (step `003`, `SECURITY DEFINER`, `GRANT EXECUTE … TO app_runtime`) does both
 * in one statement and raises `unknown hypothesis id` itself.
 *
 * That last part is why this returns the raised text's *presence* rather than
 * catching it: the handler needs a 404 for an unknown hypothesis and a 400 for a
 * dangling campaign id, and the function distinguishes them — the first as a
 * `raise exception`, the second as an ordinary 23503 the driver already
 * classifies. So the exception surfaces, and `neonLibraryWrites.ts` maps it.
 */
export interface SetHypothesisCampaignsParams {
  readonly hypothesisId: number
  readonly campaignIds: readonly string[]
  readonly [key: string]: number | readonly string[]
}

const SET_HYPOTHESIS_CAMPAIGNS_SQL = `SELECT public.set_hypothesis_campaigns($1::bigint, $2::text[])`

export const setHypothesisCampaignsOperation: NeonCommandOperation<
  { readonly ok: true },
  SetHypothesisCampaignsParams
> = {
  build: ({ params }) => ({
    text: SET_HYPOTHESIS_CAMPAIGNS_SQL,
    values: [params?.hypothesisId ?? 0, params?.campaignIds ?? []],
  }),
  mapResult: () => ({ ok: true }),
}

// ---------------------------------------------------------------------------
// save_campaign_context
// ---------------------------------------------------------------------------

/**
 * The empty string clears the column, which is the Supabase path's behaviour
 * (`context || null`) restated in SQL with `NULLIF` so the rule lives in one
 * place rather than in whichever caller happened to trim the value.
 *
 * `briefing_context_updated_at` is set here rather than by a trigger: it is not
 * `updated_at`, it dates *this* column specifically, and `/api/briefing` reads
 * it to decide whether the context it embedded is stale.
 */
export interface SaveCampaignContextParams {
  readonly campaignId: string
  readonly context: string
  readonly [key: string]: string
}

export interface CampaignContextResult {
  readonly rowCount: number
  readonly row: {
    readonly id: string
    readonly briefing_context: string | null
    readonly briefing_context_updated_at: string | null
  } | null
}

const SAVE_CAMPAIGN_CONTEXT_SQL = `UPDATE public.campaigns
      SET briefing_context = NULLIF($2, ''),
          briefing_context_updated_at = now()
    WHERE id = $1
RETURNING id, briefing_context, briefing_context_updated_at`

export const saveCampaignContextOperation: NeonCommandOperation<
  CampaignContextResult,
  SaveCampaignContextParams
> = {
  build: ({ params }) => ({
    text: SAVE_CAMPAIGN_CONTEXT_SQL,
    values: [params?.campaignId ?? '', params?.context ?? ''],
  }),
  mapResult: (rows, rowCount): CampaignContextResult => ({
    rowCount,
    row: rows[0]
      ? {
          id: String(rows[0].id),
          briefing_context: nullableText(rows[0].briefing_context),
          briefing_context_updated_at: nullableText(
            rows[0].briefing_context_updated_at,
          ),
        }
      : null,
  }),
}

// ---------------------------------------------------------------------------
// the legacy playbook save
// ---------------------------------------------------------------------------

/**
 * The singleton. `id` is a `boolean` with a `CHECK (id)` constraint, so there is
 * exactly one row and `ON CONFLICT (id)` is the whole upsert.
 *
 * This is the only statement in the module that stamps `updated_at` by hand,
 * because `playbook` is the one table here with no `touch_updated_at` trigger —
 * and the coach embeds the document's age in its prompt, so the stamp is load
 * bearing rather than bookkeeping.
 */
export interface SavePlaybookParams {
  readonly content: string
  readonly [key: string]: string
}

const SAVE_PLAYBOOK_SQL = `INSERT INTO public.playbook (id, content, updated_at)
     VALUES (true, $1, now())
ON CONFLICT (id) DO UPDATE
        SET content = EXCLUDED.content,
            updated_at = EXCLUDED.updated_at
  RETURNING updated_at`

export const savePlaybookOperation: NeonCommandOperation<
  { readonly updated_at: string },
  SavePlaybookParams
> = {
  build: ({ params }) => ({
    text: SAVE_PLAYBOOK_SQL,
    values: [params?.content ?? ''],
  }),
  mapResult: (rows) => ({ updated_at: String(rows[0]?.updated_at ?? '') }),
}
