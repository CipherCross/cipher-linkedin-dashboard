// MCP server exposing the same SQL tooling as /api/chat, so external
// MCP clients (Claude Desktop, Claude Code, etc.) can analyze the data too.
// Endpoint: https://<deployment>/api/mcp (Streamable HTTP transport).
// Tool names/descriptions/input shapes come from _lib/tools.ts's `toolDefs`
// so the two surfaces (chat's AI-SDK tools and this MCP server) can't drift.
//
// The whole MCP surface is machine-authenticated because every tool runs as the
// AI store's `app_system` principal. MCP clients cannot inherit the SPA's user
// session.
import { createMcpHandler } from 'mcp-handler'
import {
  SCHEMA_DOC,
  executeNamedSql,
  executeSql,
} from './_lib/core.js'
import { executeSaveSearchAsSystem, toolDefs } from './_lib/tools.js'
import {
  getCampaignConversations,
  getSequence,
  getThread,
  listLeads,
  listReplies,
  searchMessages,
} from './_lib/aiContext.js'
import { guardMachine } from './_lib/auth.js'

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

// The `server` object handed to the createMcpHandler construction callback.
type McpServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0]

/** Register the READ-ONLY analytics and context tools. */
function registerReadOnlyTools(server: McpServer) {
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
    async () => asText(await executeNamedSql('weeklyFunnel'))
  )

  server.tool(
    toolDefs.campaign_overview.name,
    toolDefs.campaign_overview.description,
    toolDefs.campaign_overview.inputShape,
    async () => asText(await executeNamedSql('campaignOverview'))
  )

  server.tool(
    toolDefs.pipeline_overview.name,
    toolDefs.pipeline_overview.description,
    toolDefs.pipeline_overview.inputShape,
    async () => asText(await executeNamedSql('pipelineOverview'))
  )

  server.tool(
    toolDefs.hypothesis_overview.name,
    toolDefs.hypothesis_overview.description,
    toolDefs.hypothesis_overview.inputShape,
    async () => asText(await executeNamedSql('hypothesisOverview'))
  )

  server.tool(
    toolDefs.get_sequence.name,
    toolDefs.get_sequence.description,
    toolDefs.get_sequence.inputShape,
    async (args) => asText(await getSequence(args))
  )

  server.tool(
    toolDefs.get_thread.name,
    toolDefs.get_thread.description,
    toolDefs.get_thread.inputShape,
    async (args) => asText(await getThread(args))
  )

  server.tool(
    toolDefs.campaign_conversations.name,
    toolDefs.campaign_conversations.description,
    toolDefs.campaign_conversations.inputShape,
    async (args) => asText(await getCampaignConversations(args))
  )

  server.tool(
    toolDefs.search_messages.name,
    toolDefs.search_messages.description,
    toolDefs.search_messages.inputShape,
    async (args) => asText(await searchMessages(args))
  )

  server.tool(
    toolDefs.list_leads.name,
    toolDefs.list_leads.description,
    toolDefs.list_leads.inputShape,
    async (args) => asText(await listLeads(args))
  )

  server.tool(
    toolDefs.list_replies.name,
    toolDefs.list_replies.description,
    toolDefs.list_replies.inputShape,
    async (args) => asText(await listReplies(args))
  )
}

const serverOptions = {
  serverInfo: { name: 'linkedin-campaign-db', version: '1.0.0' },
}
const handlerOptions = {
  basePath: '/api',
  maxDuration: 60,
  verboseLogs: false,
}

const adminHandler = createMcpHandler(
  (server) => {
    registerReadOnlyTools(server)
    // The one write tool, exposed only over the admin handler.
    server.tool(
      toolDefs.save_search.name,
      toolDefs.save_search.description,
      toolDefs.save_search.inputShape,
      // MCP authenticates with MCP_SECRET — a machine caller with no human
      // actor, and none is invented. The write runs as `app_system` under
      // ledger step 007's system write path; the gate is MCP_SECRET.
      async (args) => asText(await executeSaveSearchAsSystem(args))
    )
  },
  serverOptions,
  handlerOptions
)

async function authenticatedHandler(req: Request) {
  const denied = await guardMachine(req, 'MCP_SECRET')
  if (denied) return denied
  return adminHandler(req)
}

const GET = (req: Request) => authenticatedHandler(req)
const POST = (req: Request) => authenticatedHandler(req)
const DELETE = (req: Request) => authenticatedHandler(req)

export { GET, POST, DELETE }
