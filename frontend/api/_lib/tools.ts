// Tool definitions for the chat endpoint (Vercel AI SDK). The same operations
// are exposed over MCP in /api/mcp.ts.
import { tool } from 'ai'
import { z } from 'zod'
import {
  CAMPAIGN_OVERVIEW_SQL,
  PIPELINE_OVERVIEW_SQL,
  SCHEMA_DOC,
  WEEKLY_FUNNEL_SQL,
  executeSql,
} from './core.js'

export const tools = {
  run_sql: tool({
    description:
      'Run a read-only SQL query (SELECT/WITH only) against the campaign Postgres database. ' +
      'Call this whenever you need data to answer a question — funnel cohorts, segments, ' +
      'time series, message texts, anything in the schema. Returns JSON rows (capped at 200). ' +
      'Prefer aggregations over raw row dumps.',
    inputSchema: z.object({
      query: z.string().describe('A single SELECT or WITH ... SELECT statement.'),
      purpose: z
        .string()
        .optional()
        .describe('One short sentence on what this query checks (shown to the user).'),
    }),
    execute: async ({ query }) => executeSql(query),
  }),

  get_schema: tool({
    description:
      'Get the full database schema with column descriptions and analysis guidance. ' +
      'Call this before writing SQL if you are unsure about a table or column.',
    inputSchema: z.object({}),
    execute: async () => SCHEMA_DOC,
  }),

  weekly_funnel: tool({
    description:
      'Cohort funnel by invite week (last 16 weeks): invites, accepted, replied, ' +
      'acceptance_rate, reply_rate_of_accepted, avg_days_to_reply. The right starting point ' +
      'for questions like "why did the recent invite spike not produce replies?". ' +
      'Remember recent cohorts are still maturing.',
    inputSchema: z.object({}),
    execute: async () => executeSql(WEEKLY_FUNNEL_SQL),
  }),

  campaign_overview: tool({
    description:
      'Per-campaign funnel rollup (campaign_metrics joined with account names): totals, ' +
      'acceptance rate, reply rate, last activity. Good first call to see what exists.',
    inputSchema: z.object({}),
    execute: async () => executeSql(CAMPAIGN_OVERVIEW_SQL),
  }),

  pipeline_overview: tool({
    description:
      'Current MANUAL CRM pipeline snapshot: how many leads sit in each stage/substatus ' +
      'per campaign (with account name), how many are stale (>14 days in-stage), plus a ' +
      "summary count of untriaged replies (replied but not yet in the pipeline). Use this " +
      'for questions about calls, proposals, clients, or who needs triage — NOT the ' +
      'invite/reply milestones.',
    inputSchema: z.object({}),
    execute: async () => executeSql(PIPELINE_OVERVIEW_SQL),
  }),
}
