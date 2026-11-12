/**
 * The Airtable mirror (ledger step 030): Companies and Contacts of every base
 * copied into Neon, the per-(base, table) sync cursor, and the lead <-> company
 * links derived from Contacts by LinkedIn slug or set by hand.
 *
 * Two principals run these: a member's "Sync from Airtable" / manual link
 * (app_runtime, active-member RLS) and the daily cron (app_system under the
 * system actor). Every statement is fixed text with bound parameters; batches
 * travel as one JSON array parameter.
 */

import type {
  NeonCommandOperation,
  NeonOperationRegistry,
  NeonQueryOperation,
  NeonRow,
} from '../neon.js'

export const AIRTABLE_MIRROR_OPERATIONS = {
  syncState: 'airtableMirror.syncState',
} as const

export const AIRTABLE_MIRROR_COMMANDS = {
  saveSyncState: 'airtableMirror.saveSyncState',
  upsertCompanies: 'airtableMirror.upsertCompanies',
  upsertContacts: 'airtableMirror.upsertContacts',
  refreshLinks: 'airtableMirror.refreshLinks',
  setManualLink: 'airtableMirror.setManualLink',
  clearManualLink: 'airtableMirror.clearManualLink',
} as const

export type AirtableTableKey = 'companies' | 'contacts'

const nullableText = (row: NeonRow, column: string): string | null =>
  row[column] === null || row[column] === undefined ? null : String(row[column])

export interface SyncStateRow {
  readonly base_key: string
  readonly table_key: AirtableTableKey
  readonly cursor: string | null
  readonly run_started_at: string | null
  readonly pending_offset: string | null
  readonly last_run_at: string | null
  readonly last_error: string | null
  readonly rows_upserted: number
}

export interface SyncStateKeyParams {
  readonly baseKey: string
  readonly tableKey: AirtableTableKey
  readonly [key: string]: string
}

export const syncStateOperation: NeonQueryOperation<SyncStateRow, SyncStateKeyParams> = {
  build: ({ params }) => ({
    text: `SELECT base_key, table_key, cursor, run_started_at, pending_offset, last_run_at,
                  last_error, rows_upserted
             FROM public.airtable_sync_state
            WHERE base_key = $1 AND table_key = $2`,
    values: [params?.baseKey ?? null, params?.tableKey ?? null],
  }),
  mapRow: (row) => ({
    base_key: String(row.base_key),
    table_key: String(row.table_key) as AirtableTableKey,
    cursor: nullableText(row, 'cursor'),
    run_started_at: nullableText(row, 'run_started_at'),
    pending_offset: nullableText(row, 'pending_offset'),
    last_run_at: nullableText(row, 'last_run_at'),
    last_error: nullableText(row, 'last_error'),
    rows_upserted: Number(row.rows_upserted ?? 0),
  }),
}

export interface SaveSyncStateParams {
  readonly baseKey: string
  readonly tableKey: AirtableTableKey
  readonly cursor: string | null
  readonly runStartedAt: string | null
  readonly pendingOffset: string | null
  readonly lastError: string | null
  readonly rowsUpserted: number
  readonly [key: string]: string | number | null
}

/** Writes the whole state row; `last_run_at` is the database clock. */
export const saveSyncStateOperation: NeonCommandOperation<void, SaveSyncStateParams> = {
  build: ({ params }) => {
    if (!params) throw new Error('airtableMirror.saveSyncState requires parameters')
    return {
      text: `INSERT INTO public.airtable_sync_state
                    (base_key, table_key, cursor, run_started_at, pending_offset, last_run_at,
                     last_error, rows_upserted)
             VALUES ($1, $2, $3::timestamptz, $4::timestamptz, left($5, 500), now(), left($6, 1000), $7)
             ON CONFLICT (base_key, table_key) DO UPDATE SET
               cursor = EXCLUDED.cursor, run_started_at = EXCLUDED.run_started_at,
               pending_offset = EXCLUDED.pending_offset, last_run_at = now(),
               last_error = EXCLUDED.last_error, rows_upserted = EXCLUDED.rows_upserted`,
      values: [
        params.baseKey, params.tableKey, params.cursor, params.runStartedAt,
        params.pendingOffset, params.lastError, params.rowsUpserted,
      ],
    }
  },
}

/** One company row as `airtableSync.ts` builds it from an Airtable record. */
export interface MirrorCompanyRow {
  readonly record_id: string
  readonly name: string | null
  readonly website: string | null
  readonly domain: string | null
  readonly linkedin_url: string | null
  readonly hq_country: string | null
  readonly industry: string | null
  readonly employees: number | null
  readonly founded_year: number | null
  readonly ai_niche: string | null
  readonly approve_status: string | null
  readonly description: string | null
  readonly summary: string | null
  readonly keywords: string | null
  readonly web_app_link: string | null
  readonly airtable_created: string | null
  readonly airtable_modified: string | null
  readonly fields: Record<string, unknown>
}

export interface MirrorContactRow {
  readonly record_id: string
  readonly persona_url: string | null
  readonly full_name: string | null
  readonly title: string | null
  readonly company_record_id: string | null
  readonly approve_status: string | null
  readonly readiness: string | null
  readonly technicality: string | null
  readonly airtable_created: string | null
  readonly airtable_modified: string | null
  readonly fields: Record<string, unknown>
}

export interface UpsertBatchParams {
  readonly baseKey: string
  /** JSON array of `MirrorCompanyRow` / `MirrorContactRow`. */
  readonly rows: string
  readonly [key: string]: string
}

const countResult = (_rows: readonly NeonRow[], rowCount: number): number => rowCount

export const upsertCompaniesOperation: NeonCommandOperation<number, UpsertBatchParams> = {
  build: ({ params }) => ({
    text: `INSERT INTO public.airtable_companies
                  (base_key, record_id, name, website, domain, linkedin_url, hq_country, industry,
                   employees, founded_year, ai_niche, approve_status, description, summary, keywords,
                   web_app_link, airtable_created, airtable_modified, fields, synced_at)
           SELECT $1, r.record_id, left(r.name, 500), left(r.website, 1000), left(r.domain, 253),
                  left(r.linkedin_url, 1000), left(r.hq_country, 200), left(r.industry, 500),
                  r.employees, r.founded_year, left(r.ai_niche, 500), left(r.approve_status, 100),
                  left(r.description, 20000), left(r.summary, 20000), left(r.keywords, 20000),
                  left(r.web_app_link, 1000), r.airtable_created, r.airtable_modified,
                  coalesce(r.fields, '{}'::jsonb), now()
             FROM jsonb_to_recordset($2::jsonb)
               AS r(record_id text, name text, website text, domain text, linkedin_url text,
                    hq_country text, industry text, employees integer, founded_year integer,
                    ai_niche text, approve_status text, description text, summary text,
                    keywords text, web_app_link text, airtable_created timestamptz,
                    airtable_modified timestamptz, fields jsonb)
           ON CONFLICT (base_key, record_id) DO UPDATE SET
             name = EXCLUDED.name, website = EXCLUDED.website, domain = EXCLUDED.domain,
             linkedin_url = EXCLUDED.linkedin_url, hq_country = EXCLUDED.hq_country,
             industry = EXCLUDED.industry, employees = EXCLUDED.employees,
             founded_year = EXCLUDED.founded_year, ai_niche = EXCLUDED.ai_niche,
             approve_status = EXCLUDED.approve_status, description = EXCLUDED.description,
             summary = EXCLUDED.summary, keywords = EXCLUDED.keywords,
             web_app_link = EXCLUDED.web_app_link, airtable_created = EXCLUDED.airtable_created,
             airtable_modified = EXCLUDED.airtable_modified, fields = EXCLUDED.fields,
             synced_at = now()`,
    values: [params?.baseKey ?? '', params?.rows ?? '[]'],
  }),
  mapResult: countResult,
}

/** `persona_slug` is derived in SQL so both sides of the match share one rule. */
export const upsertContactsOperation: NeonCommandOperation<number, UpsertBatchParams> = {
  build: ({ params }) => ({
    text: `INSERT INTO public.airtable_contacts
                  (base_key, record_id, persona_slug, persona_url, full_name, title,
                   company_record_id, approve_status, readiness, technicality,
                   airtable_created, airtable_modified, fields, synced_at)
           SELECT $1, r.record_id, left(public.linkedin_slug(r.persona_url), 300),
                  left(r.persona_url, 1000), left(r.full_name, 500), left(r.title, 1000),
                  r.company_record_id, left(r.approve_status, 100), left(r.readiness, 200),
                  left(r.technicality, 200), r.airtable_created, r.airtable_modified,
                  coalesce(r.fields, '{}'::jsonb), now()
             FROM jsonb_to_recordset($2::jsonb)
               AS r(record_id text, persona_url text, full_name text, title text,
                    company_record_id text, approve_status text, readiness text,
                    technicality text, airtable_created timestamptz,
                    airtable_modified timestamptz, fields jsonb)
           ON CONFLICT (base_key, record_id) DO UPDATE SET
             persona_slug = EXCLUDED.persona_slug, persona_url = EXCLUDED.persona_url,
             full_name = EXCLUDED.full_name, title = EXCLUDED.title,
             company_record_id = EXCLUDED.company_record_id,
             approve_status = EXCLUDED.approve_status, readiness = EXCLUDED.readiness,
             technicality = EXCLUDED.technicality, airtable_created = EXCLUDED.airtable_created,
             airtable_modified = EXCLUDED.airtable_modified, fields = EXCLUDED.fields,
             synced_at = now()`,
    values: [params?.baseKey ?? '', params?.rows ?? '[]'],
  }),
  mapResult: countResult,
}

export interface LinkRefreshResult {
  /** Distinct (instance, profile) people in `leads`. */
  readonly leads: number
  /** People with a slug-matched contact whose company is mirrored. */
  readonly matched: number
  /** Links inserted or re-pointed by this run. */
  readonly changed: number
  /** People with any link, manual ones included. */
  readonly linked: number
}

/**
 * Re-derives every 'contact_slug' link. A person matching contacts in two
 * bases takes the most recently modified contact. Manual links are never
 * touched (the ON CONFLICT update is gated on the stored method). A link whose
 * contact no longer matches is left as it was: nothing here deletes.
 */
export const refreshLinksOperation: NeonCommandOperation<LinkRefreshResult> = {
  build: () => ({
    text: `WITH people AS (
             SELECT DISTINCT l.instance_id, l.profile_url FROM public.leads l
           ), keyed AS (
             SELECT p.instance_id, p.profile_url, public.linkedin_slug(p.profile_url) AS slug
               FROM people p
           ), matched AS (
             SELECT DISTINCT ON (k.instance_id, k.profile_url)
                    k.instance_id, k.profile_url, c.base_key, c.company_record_id,
                    c.record_id AS contact_record_id
               FROM keyed k
               JOIN public.airtable_contacts c ON c.persona_slug = k.slug
               JOIN public.airtable_companies co
                 ON co.base_key = c.base_key AND co.record_id = c.company_record_id
              WHERE k.slug IS NOT NULL AND c.company_record_id IS NOT NULL
              ORDER BY k.instance_id, k.profile_url, c.airtable_modified DESC NULLS LAST,
                       c.base_key, c.record_id
           ), written AS (
             INSERT INTO public.lead_company_links
                    (instance_id, profile_url, base_key, company_record_id, contact_record_id,
                     method, linked_at)
             SELECT m.instance_id, m.profile_url, m.base_key, m.company_record_id,
                    m.contact_record_id, 'contact_slug', now()
               FROM matched m
             ON CONFLICT (instance_id, profile_url) DO UPDATE SET
               base_key = EXCLUDED.base_key, company_record_id = EXCLUDED.company_record_id,
               contact_record_id = EXCLUDED.contact_record_id, linked_at = now()
             WHERE public.lead_company_links.method = 'contact_slug'
               AND (public.lead_company_links.base_key, public.lead_company_links.company_record_id,
                    public.lead_company_links.contact_record_id)
                   IS DISTINCT FROM (EXCLUDED.base_key, EXCLUDED.company_record_id,
                                     EXCLUDED.contact_record_id)
             RETURNING 1
           )
           SELECT (SELECT count(*) FROM people)::int AS leads,
                  (SELECT count(*) FROM matched)::int AS matched,
                  (SELECT count(*) FROM written)::int AS changed,
                  -- The statement's snapshot predates its own inserts, so count the
                  -- union: every match ends up linked (or already was).
                  (SELECT count(*) FROM (SELECT instance_id, profile_url FROM public.lead_company_links
                                         UNION SELECT instance_id, profile_url FROM matched) x)::int AS linked`,
    values: [],
  }),
  mapResult: (rows) => ({
    leads: Number(rows[0]?.leads ?? 0),
    matched: Number(rows[0]?.matched ?? 0),
    changed: Number(rows[0]?.changed ?? 0),
    linked: Number(rows[0]?.linked ?? 0),
  }),
}

export interface ManualLinkParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly baseKey: string
  readonly recordId: string
  readonly [key: string]: string
}

export interface LinkRow {
  readonly base_key: string
  readonly record_id: string
  readonly method: 'contact_slug' | 'manual'
}

const mapLink = (rows: readonly NeonRow[]): LinkRow | null => {
  const row = rows[0]
  if (!row) return null
  return {
    base_key: String(row.base_key),
    record_id: String(row.company_record_id),
    method: String(row.method) as LinkRow['method'],
  }
}

/**
 * A member's link. Answers no row when the lead does not exist on that
 * instance or the company is not mirrored, so the caller can say 404.
 */
export const setManualLinkOperation: NeonCommandOperation<LinkRow | null, ManualLinkParams> = {
  build: ({ actor, params }) => {
    if (!params) throw new Error('airtableMirror.setManualLink requires parameters')
    return {
      text: `INSERT INTO public.lead_company_links
                    (instance_id, profile_url, base_key, company_record_id, contact_record_id,
                     method, linked_by, linked_at)
             SELECT $1, $2, co.base_key, co.record_id, NULL, 'manual',
                    (SELECT tm.id FROM public.team_members tm
                      WHERE tm.user_id = $5::uuid AND tm.active), now()
               FROM public.airtable_companies co
              WHERE co.base_key = $3 AND co.record_id = $4
                AND EXISTS (SELECT 1 FROM public.leads l
                             WHERE l.instance_id = $1 AND l.profile_url = $2)
             ON CONFLICT (instance_id, profile_url) DO UPDATE SET
               base_key = EXCLUDED.base_key, company_record_id = EXCLUDED.company_record_id,
               contact_record_id = NULL, method = 'manual', linked_by = EXCLUDED.linked_by,
               linked_at = now()
             RETURNING base_key, company_record_id, method`,
      values: [params.instanceId, params.profileUrl, params.baseKey, params.recordId, actor.actorId],
    }
  },
  mapResult: mapLink,
}

export interface ThreadKeyLinkParams {
  readonly instanceId: string
  readonly profileUrl: string
  readonly [key: string]: string
}

/** Drops a manual link only (RLS also refuses any other); the next refresh may re-derive one. */
export const clearManualLinkOperation: NeonCommandOperation<number, ThreadKeyLinkParams> = {
  build: ({ params }) => ({
    text: `DELETE FROM public.lead_company_links
            WHERE instance_id = $1 AND profile_url = $2 AND method = 'manual'`,
    values: [params?.instanceId ?? '', params?.profileUrl ?? ''],
  }),
  mapResult: countResult,
}

/**
 * Registers the sync on a registry: the application one (a member's sync and
 * manual link) and the AI one (the daily cron, which never links by hand).
 */
export function registerAirtableMirrorOperations(
  registry: NeonOperationRegistry,
  options: { readonly manualLinks: boolean },
): NeonOperationRegistry {
  registry.registerQuery(AIRTABLE_MIRROR_OPERATIONS.syncState, syncStateOperation)
  registry.registerCommand(AIRTABLE_MIRROR_COMMANDS.saveSyncState, saveSyncStateOperation)
  registry.registerCommand(AIRTABLE_MIRROR_COMMANDS.upsertCompanies, upsertCompaniesOperation)
  registry.registerCommand(AIRTABLE_MIRROR_COMMANDS.upsertContacts, upsertContactsOperation)
  registry.registerCommand(AIRTABLE_MIRROR_COMMANDS.refreshLinks, refreshLinksOperation)
  if (options.manualLinks) {
    registry.registerCommand(AIRTABLE_MIRROR_COMMANDS.setManualLink, setManualLinkOperation)
    registry.registerCommand(AIRTABLE_MIRROR_COMMANDS.clearManualLink, clearManualLinkOperation)
  }
  return registry
}
