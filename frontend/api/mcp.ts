// MCP server exposing the same Supabase SQL tooling as /api/chat, so external
// MCP clients (Claude Desktop, Claude Code, etc.) can analyze the data too.
// Endpoint: https://<deployment>/api/mcp (Streamable HTTP transport).
// Tool names/descriptions/input shapes come from _lib/tools.ts's `toolDefs`
// so the two surfaces (chat's AI-SDK tools and this MCP server) can't drift.
import { createMcpHandler } from 'mcp-handler'
import {
  CAMPAIGN_OVERVIEW_SQL,
  PIPELINE_OVERVIEW_SQL,
  SCHEMA_DOC,
  WEEKLY_FUNNEL_SQL,
  executeSql,
} from './_lib/core.js'
import { toolDefs } from './_lib/tools.js'

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
      toolDefs.run_sql.name,
      toolDefs.run_sql.description,
      toolDefs.run_sql.inputShape,
      async ({ query }) => asText(await executeSql(query))
    )

    server.tool(
      toolDefs.get_schema.name,
      toolDefs.get_schema.description,
      toolDefs.get_schema.inputShape,
      async () => asText(SCHEMA_DOC)
    )

    server.tool(
      toolDefs.weekly_funnel.name,
      toolDefs.weekly_funnel.description,
      toolDefs.weekly_funnel.inputShape,
      async () => asText(await executeSql(WEEKLY_FUNNEL_SQL))
    )

    server.tool(
      toolDefs.campaign_overview.name,
      toolDefs.campaign_overview.description,
      toolDefs.campaign_overview.inputShape,
      async () => asText(await executeSql(CAMPAIGN_OVERVIEW_SQL))
    )

    server.tool(
      toolDefs.pipeline_overview.name,
      toolDefs.pipeline_overview.description,
      toolDefs.pipeline_overview.inputShape,
      async () => asText(await executeSql(PIPELINE_OVERVIEW_SQL))
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
