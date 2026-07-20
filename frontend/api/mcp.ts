// MCP server exposing the same Supabase SQL tooling as /api/chat, so external
// MCP clients (Claude Desktop, Claude Code, etc.) can analyze the data too.
// Endpoint: https://<deployment>/api/mcp (Streamable HTTP transport).
// Tool names/descriptions/input shapes come from _lib/tools.ts's `toolDefs`
// so the two surfaces (chat's AI-SDK tools and this MCP server) can't drift.
//
// READ/WRITE SPLIT (deliberate): createMcpHandler registers its tools ONCE, inside
// the construction callback — there is no per-request hook to add or drop a tool. So
// we build TWO handlers at module scope: `readOnlyHandler` (the analytics tools only)
// and `adminHandler` (those + the write tool save_search). The exported GET/POST/DELETE
// pick between them per request from the bearer token. Unlike the HTTP write endpoints
// (which stay OPEN when ADMIN_SECRET is unset), MCP is FAIL-CLOSED: an unset/empty
// ADMIN_SECRET always yields the read-only handler — never an open write path.
import { createMcpHandler } from 'mcp-handler'
import {
  CAMPAIGN_OVERVIEW_SQL,
  PIPELINE_OVERVIEW_SQL,
  SCHEMA_DOC,
  WEEKLY_FUNNEL_SQL,
  executeSql,
} from './_lib/core.js'
import { executeSaveSearch, toolDefs } from './_lib/tools.js'

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

/** Register the five READ-ONLY analytics tools shared by both handlers. */
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
}

const serverOptions = {
  serverInfo: { name: 'linkedin-campaign-db', version: '1.0.0' },
}
const handlerOptions = {
  basePath: '/api',
  maxDuration: 60,
  verboseLogs: false,
}

// Both handlers built ONCE at module scope (see the read/write-split note above).
const readOnlyHandler = createMcpHandler(
  (server) => registerReadOnlyTools(server),
  serverOptions,
  handlerOptions
)

const adminHandler = createMcpHandler(
  (server) => {
    registerReadOnlyTools(server)
    // The one write tool, exposed only over the admin handler.
    server.tool(
      toolDefs.save_search.name,
      toolDefs.save_search.description,
      toolDefs.save_search.inputShape,
      async (args) => asText(await executeSaveSearch(args))
    )
  },
  serverOptions,
  handlerOptions
)

// Fail-closed gating: serve the write-capable handler ONLY when a non-empty
// ADMIN_SECRET is configured AND the caller presents it as a bearer token. Any other
// case — no header, wrong token, or (critically) ADMIN_SECRET unset/empty — falls
// through to the read-only handler, so an unconfigured project can never expose the
// write tool over MCP.
function pickHandler(req: Request) {
  const secret = process.env.ADMIN_SECRET
  if (secret && req.headers.get('authorization') === `Bearer ${secret}`) {
    return adminHandler
  }
  return readOnlyHandler
}

const GET = (req: Request) => pickHandler(req)(req)
const POST = (req: Request) => pickHandler(req)(req)
const DELETE = (req: Request) => pickHandler(req)(req)

export { GET, POST, DELETE }
