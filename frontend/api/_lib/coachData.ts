// The reads the live coach and the trainer share, over the shared Neon store
// under the caller's resolved actor.
import {
  DataStoreSchemaError,
  MAX_PAGE_SIZE,
  type ActorContext,
  type DataStore,
  type DataStoreParams,
  type DataStoreTransaction,
  type Page,
} from './data/contracts.js'
import {
  AI_WRITE_OPERATIONS,
  COACH_TRAINING_OPERATIONS,
  MESSAGES_OPERATIONS,
  PIPELINE_WRITE_OPERATIONS,
  type CoachIcpPersonaRow,
  type CoachThreadRow,
  type IcpDetailRow,
  type PromptStateRow,
  type ThreadMessageRow,
} from './data/operations/index.js'
import { AuthorizationError } from './auth.js'
import { msgFromCoachRow, msgFromPlainRow, renderIcpText, type Msg } from './coachCore.js'

export const COACH_SCOPE = 'global'

export async function allPages<TRow>(
  store: DataStore,
  actor: ActorContext,
  operation: string,
  params?: DataStoreParams,
): Promise<TRow[]> {
  const rows: TRow[] = []
  let cursor: string | null = null
  for (;;) {
    const page: Page<TRow> = await store.query<TRow>(actor, {
      operation,
      params,
      page: { limit: MAX_PAGE_SIZE, cursor },
    })
    rows.push(...page.items)
    if (!page.hasMore || page.nextCursor === null) break
    cursor = page.nextCursor
  }
  return rows
}

export async function firstRow<TRow>(
  store: DataStore,
  actor: ActorContext,
  operation: string,
  params?: DataStoreParams,
): Promise<TRow | null> {
  const page = await store.query<TRow>(actor, { operation, params, page: { limit: 1 } })
  return page.items[0] ?? null
}

/** The thread as the coach reads it, oldest first. A tenant without ledger
 *  step 024 has no attribution: every outbound message is unverified. */
export async function loadCoachThread(
  store: DataStore,
  actor: ActorContext,
  instance_id: string,
  profile_url: string,
): Promise<Msg[]> {
  const params = { instanceId: instance_id, profileUrl: profile_url }
  try {
    const rows = await allPages<CoachThreadRow>(store, actor, AI_WRITE_OPERATIONS.coachThread, params)
    return rows.map(msgFromCoachRow)
  } catch (error) {
    if (!(error instanceof DataStoreSchemaError)) throw error
  }
  const rows = await allPages<ThreadMessageRow>(store, actor, MESSAGES_OPERATIONS.thread, params)
  return rows.map(msgFromPlainRow)
}

export async function loadPlaybook(store: DataStore, actor: ActorContext): Promise<string> {
  const row = await firstRow<{ content: string }>(store, actor, AI_WRITE_OPERATIONS.coachPlaybook)
  return (row?.content ?? '').trim()
}

/** This conversation's ICP (when its campaign is assigned to a hypothesis). */
export async function loadIcpForCampaign(
  store: DataStore,
  actor: ActorContext,
  campaign_id: string | null | undefined,
): Promise<string> {
  if (!campaign_id) return ''
  const assignment = await firstRow<{ hypothesis_id: number }>(
    store, actor, AI_WRITE_OPERATIONS.coachHypothesisAssignment, { campaignId: campaign_id },
  )
  if (assignment?.hypothesis_id === undefined) return ''
  const hyp = await firstRow<{ name: string; icp_id: number | null }>(
    store, actor, AI_WRITE_OPERATIONS.coachHypothesisIcp, { hypothesisId: assignment.hypothesis_id },
  )
  if (!hyp?.icp_id) return ''
  const [icp, personas] = await Promise.all([
    firstRow<IcpDetailRow>(store, actor, AI_WRITE_OPERATIONS.coachIcpDetail, { icpId: hyp.icp_id }),
    store.query<CoachIcpPersonaRow>(actor, {
      operation: AI_WRITE_OPERATIONS.coachIcpPersonas,
      params: { icpId: hyp.icp_id },
      page: { limit: MAX_PAGE_SIZE },
    }),
  ])
  if (!icp) return ''
  return renderIcpText(hyp.name, icp, personas.items)
}

/** The prompt state, or null before the trainer is first opened. A tenant
 *  without ledger step 027 has none either. */
export async function loadPromptState(
  store: DataStore,
  actor: ActorContext,
): Promise<PromptStateRow | null> {
  try {
    return await firstRow<PromptStateRow>(store, actor, COACH_TRAINING_OPERATIONS.promptState, { scope: COACH_SCOPE })
  } catch (error) {
    if (error instanceof DataStoreSchemaError) return null
    throw error
  }
}

/** The acting member's display name, for the audit columns. Read inside the
 *  caller's transaction so it cannot disagree with the actor that wrote. */
export async function actorName(transaction: DataStoreTransaction): Promise<string> {
  const page = await transaction.query<{ name: string }>({
    operation: PIPELINE_WRITE_OPERATIONS.actorDisplayName,
    params: { actorId: transaction.actor.actorId },
    page: { limit: 1 },
  })
  const name = page.items[0]?.name
  if (!name) throw new AuthorizationError(403, 'Your account is not an active team member')
  return name.slice(0, 120)
}
