// Tool definitions for the chat endpoint (Vercel AI SDK). The same operations
// are exposed over MCP in /api/mcp.ts, which imports `toolDefs` below so the
// two surfaces share one description/schema per tool instead of drifting.
import { tool } from 'ai'
import { z } from 'zod'
import {
  CAMPAIGN_OVERVIEW_SQL,
  HYPOTHESIS_OVERVIEW_SQL,
  PIPELINE_OVERVIEW_SQL,
  SCHEMA_DOC,
  WEEKLY_FUNNEL_SQL,
  db,
  executeSql,
} from './core.js'
import { validateSearch } from './savedSearch.js'

export interface ToolDef {
  name: string
  description: string
  inputShape: Record<string, z.ZodTypeAny>
}

/** Single source of truth for tool name/description/input shape, consumed by
 *  both the AI-SDK `tools` export below and /api/mcp.ts's `server.tool` calls. */
export const toolDefs = {
  run_sql: {
    name: 'run_sql',
    description:
      'Run a read-only SQL query (SELECT/WITH only) against the campaign Postgres database. ' +
      'Call this whenever you need data to answer a question — funnel cohorts, segments, ' +
      'time series, message texts, anything in the schema. Returns JSON rows (capped at 200). ' +
      'Prefer aggregations over raw row dumps. Call get_schema first if unsure about tables/columns.',
    inputShape: {
      query: z.string().describe('A single SELECT or WITH ... SELECT statement.'),
      purpose: z
        .string()
        .optional()
        .describe('One short sentence on what this query checks (shown to the user).'),
    },
  },

  get_schema: {
    name: 'get_schema',
    description:
      'Get the full database schema with column descriptions and analysis guidance. ' +
      'Call this before writing SQL if you are unsure about a table or column.',
    inputShape: {},
  },

  weekly_funnel: {
    name: 'weekly_funnel',
    description:
      'Cohort funnel by invite week (last 16 weeks): invites, accepted, replied, ' +
      'acceptance_rate, reply_rate_of_accepted, avg_days_to_reply. The right starting point ' +
      'for questions like "why did the recent invite spike not produce replies?". ' +
      'Remember recent cohorts are still maturing.',
    inputShape: {},
  },

  campaign_overview: {
    name: 'campaign_overview',
    description:
      'Per-campaign funnel rollup (campaign_metrics joined with account names): totals, ' +
      'acceptance rate, reply rate, last activity. Good first call to see what exists.',
    inputShape: {},
  },

  pipeline_overview: {
    name: 'pipeline_overview',
    description:
      'Current MANUAL CRM pipeline snapshot: how many leads sit in each stage/substatus ' +
      'per campaign (with account name), how many are stale (>14 days in-stage), plus a ' +
      "summary count of untriaged replies (replied but not yet in the pipeline). Use this " +
      'for questions about calls, proposals, clients, or who needs triage — NOT the ' +
      'invite/reply milestones.',
    inputShape: {},
  },

  hypothesis_overview: {
    name: 'hypothesis_overview',
    description:
      'Per-hypothesis rollup: ICP name, #campaigns, and the funnel (invited, connected, ' +
      'replied, connect_rate, reply_rate) — DEDUPED by person across the hypothesis\'s ' +
      'campaigns (a shared person across two campaigns of one hypothesis counts once, ' +
      'taking their earliest milestone). The right first call for "which hypothesis is ' +
      'winning" or "how is ICP X performing" questions; use run_sql for deeper drilldowns ' +
      '(per-campaign breakdown, cohorts, keyword lists) once you know which hypothesis.',
    inputShape: {},
  },

  save_search: {
    name: 'save_search',
    description:
      'Create or modify a saved sourcing search in the Search Library (saved_searches) — ' +
      'a shared filter RECIPE for a platform (Apollo, Sales Navigator, esun, …), not an ' +
      'executed search. Omit `id` to CREATE a new search; pass an existing `id` to MODIFY ' +
      'it (only the fields you pass change — partial patch). To modify, first `run_sql` ' +
      'the current row (select * from saved_searches where id = …) so you know its id and ' +
      "current values. Confirm the details with the user before creating a new search. " +
      'There is no delete: to retire a search, set archived:true (reversible). Returns the ' +
      'full saved row, or an error message if validation fails or the (platform, name) ' +
      'already exists.',
    inputShape: {
      id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Omit to create; pass to modify an existing search.'),
      name: z.string().min(1).max(120),
      platform: z
        .string()
        .min(1)
        .max(60)
        .describe("e.g. 'Apollo', 'Sales Navigator', 'esun' — free text"),
      description: z.string().max(2000).optional(),
      include_keywords: z.array(z.string().max(120)).max(50).optional(),
      exclude_keywords: z.array(z.string().max(120)).max(50).optional(),
      boolean_query: z
        .string()
        .max(5000)
        .optional()
        .describe('Platform-syntax boolean string, e.g. ("VP Sales" OR "Head of Sales") NOT intern'),
      filters: z
        .record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
        )
        .optional(),
      notes: z.string().max(2000).optional(),
      author: z
        .string()
        .max(100)
        .optional()
        .describe('Who this search belongs to, if the user said'),
      archived: z.boolean().optional(),
    },
  },
} satisfies Record<string, ToolDef>

// Insert-or-partial-patch a saved_searches row via the service-role client.
// SHARED WRITE PATH: this is the same logic /api/playbook's save_search action runs
// (validation via the same _lib/savedSearch module, same insert/update semantics) —
// keep the two in sync. The AI's read-only SQL guard (ai_execute_sql) is NOT touched;
// this write goes straight through db().
//
// SECURITY: /api/chat is UNAUTHENTICATED, so exposing this tool there is an open
// write path. Accepted under the project's deferred-auth posture only because it is
// bounded — one table, validated+capped fields, soft-archive (no hard delete). Flag
// for the future auth pass.
export async function executeSaveSearch(input: {
  id?: number
  [k: string]: unknown
}): Promise<{ ok: true; search: unknown } | string> {
  const { id, ...rest } = input
  const isUpdate = id !== undefined && id !== null
  const normalized = validateSearch(rest, !isUpdate)
  if (typeof normalized === 'string') return `Invalid search: ${normalized}`

  const supa = db()
  if (isUpdate) {
    if (Object.keys(normalized).length === 0) {
      return 'Nothing to update — provide at least one field to change.'
    }
    const { data, error } = await supa
      .from('saved_searches')
      .update(normalized)
      .eq('id', id)
      .select()
      .single()
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        return 'A search with that name already exists for this platform — pick a different name or update that row by its id.'
      }
      if ((error as { code?: string }).code === 'PGRST116') {
        return `No saved search with id ${id}.`
      }
      return `Save failed: ${error.message}`
    }
    return { ok: true, search: data }
  }

  const { data, error } = await supa
    .from('saved_searches')
    .insert(normalized)
    .select()
    .single()
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return 'A search with that name already exists for this platform — update the existing search (pass its id) instead of creating a duplicate.'
    }
    return `Save failed: ${error.message}`
  }
  return { ok: true, search: data }
}

export const tools = {
  run_sql: tool({
    description: toolDefs.run_sql.description,
    inputSchema: z.object(toolDefs.run_sql.inputShape),
    execute: async ({ query }) => executeSql(query),
  }),

  get_schema: tool({
    description: toolDefs.get_schema.description,
    inputSchema: z.object(toolDefs.get_schema.inputShape),
    execute: async () => SCHEMA_DOC,
  }),

  weekly_funnel: tool({
    description: toolDefs.weekly_funnel.description,
    inputSchema: z.object(toolDefs.weekly_funnel.inputShape),
    execute: async () => executeSql(WEEKLY_FUNNEL_SQL),
  }),

  campaign_overview: tool({
    description: toolDefs.campaign_overview.description,
    inputSchema: z.object(toolDefs.campaign_overview.inputShape),
    execute: async () => executeSql(CAMPAIGN_OVERVIEW_SQL),
  }),

  pipeline_overview: tool({
    description: toolDefs.pipeline_overview.description,
    inputSchema: z.object(toolDefs.pipeline_overview.inputShape),
    execute: async () => executeSql(PIPELINE_OVERVIEW_SQL),
  }),

  hypothesis_overview: tool({
    description: toolDefs.hypothesis_overview.description,
    inputSchema: z.object(toolDefs.hypothesis_overview.inputShape),
    execute: async () => executeSql(HYPOTHESIS_OVERVIEW_SQL),
  }),

  save_search: tool({
    description: toolDefs.save_search.description,
    inputSchema: z.object(toolDefs.save_search.inputShape),
    execute: async (input) => executeSaveSearch(input),
  }),
}
