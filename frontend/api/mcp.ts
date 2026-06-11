// MCP server exposing the same Supabase SQL tooling as /api/chat, so external
// MCP clients (Claude Desktop, Claude Code, etc.) can analyze the data too.
// Endpoint: https://<deployment>/api/mcp (Streamable HTTP transport).
import { createMcpHandler } from 'mcp-handler'
import { z } from 'zod'
import {
  CAMPAIGN_OVERVIEW_SQL,
  SCHEMA_DOC,
  WEEKLY_FUNNEL_SQL,
  executeSql,
} from './_lib/core.js'

function asText(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  }
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      'run_sql',
      'Run a read-only SQL query (SELECT/WITH only) against the LinkedIn campaign ' +
        'Postgres database. Returns JSON rows (capped at 200). Call get_schema first ' +
        'if unsure about tables/columns.',
      { query: z.string().describe('A single SELECT or WITH ... SELECT statement.') },
      async ({ query }) => asText(await executeSql(query))
    )

    server.tool(
      'get_schema',
      'Get the full database schema with column descriptions and analysis guidance.',
      {},
      async () => asText(SCHEMA_DOC)
    )

    server.tool(
      'weekly_funnel',
      'Cohort funnel by invite week (last 16 weeks): invites, accepted, replied, rates, ' +
        'avg days to reply. Starting point for invite-vs-reply trend questions.',
      {},
      async () => asText(await executeSql(WEEKLY_FUNNEL_SQL))
    )

    server.tool(
      'campaign_overview',
      'Per-campaign funnel rollup with account names: totals, acceptance rate, reply rate.',
      {},
      async () => asText(await executeSql(CAMPAIGN_OVERVIEW_SQL))
    )
  },
  {
    serverInfo: { name: 'linkedin-campaign-db', version: '1.0.0' },
  },
  {
    basePath: '/api',
    maxDuration: 60,
    verboseLogs: false,
  }
)

export { handler as GET, handler as POST, handler as DELETE }
