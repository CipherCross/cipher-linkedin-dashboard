// Tool definitions for the chat endpoint (Vercel AI SDK). The same operations
// are exposed over MCP in /api/mcp.ts, which imports `toolDefs` below so the
// two surfaces share one description/schema per tool instead of drifting.
import { tool } from 'ai'
import { z } from 'zod'
import {
  CAMPAIGN_OVERVIEW_SQL,
  PIPELINE_OVERVIEW_SQL,
  SCHEMA_DOC,
  WEEKLY_FUNNEL_SQL,
  executeSql,
} from './core.js'

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
} satisfies Record<string, ToolDef>

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
}
