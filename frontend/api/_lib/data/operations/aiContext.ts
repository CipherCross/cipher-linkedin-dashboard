/**
 * The AI's context reads: one thread, one campaign's conversations, a message
 * search and one sequence — the whole picture of what we send and what comes
 * back, in a shape a model can read without assembling it from raw SQL.
 *
 * ## Why these take arguments when the fixed queries in `ai.ts` do not
 *
 * `aiSystem.ts` deliberately keeps caller-shaped text out of its guard reads:
 * those feed server-owned jobs, and nothing about them needs a filter. These
 * operations are the opposite case. Each one backs a model-facing tool whose
 * argument the model already chooses — the same model that can send arbitrary
 * text through `ai.executeSql`. So the argument is placed into the statement as
 * a quoted literal, and the blast radius is exactly the guard's: one
 * SELECT/WITH statement, SELECT-only role, 1000 rows, 10 seconds. A value that
 * escaped its literal could do nothing `run_sql` cannot already do.
 *
 * The literals are still built defensively (`sqlLiteral`): standard strings
 * only, quotes doubled, NUL refused, length bounded, and always preceded by a
 * space or a parenthesis so the guard's E''/U&'' refusal never trips on them.
 * The guard masks literal contents before its keyword scan, so search text
 * such as "set up a call" is not mistaken for a statement.
 *
 * Each statement returns ONE row of named jsonb columns (or N plain rows for
 * the search), keeping a tool to a single guard round trip. Formatting for the
 * model lives in `../../aiContext.ts`.
 *
 * SQL here must avoid the guard's denied keywords outside literals — notably
 * `comment`, `set`, `into`, `start`, `lock`, `do` — which is why the review
 * note is read as `to_jsonb(rr) ->> 'comment'`.
 */

import { guardStatement, mapGuardRow } from './ai.js'
import type { NeonOperationRegistry } from '../neon.js'
import type { DataStoreParams } from '../contracts.js'

export const AI_CONTEXT_OPERATIONS = {
  thread: 'ai.context.thread',
  campaignConversations: 'ai.context.campaignConversations',
  searchMessages: 'ai.context.searchMessages',
  sequence: 'ai.context.sequence',
} as const

export type AiContextOperation = keyof typeof AI_CONTEXT_OPERATIONS

const MAX_LITERAL = 2000

/** A standard-conforming SQL string literal. Throws on NUL or over-long input. */
export function sqlLiteral(value: string): string {
  if (typeof value !== 'string') throw new Error('sqlLiteral expects a string')
  if (value.includes('\u0000')) throw new Error('sqlLiteral refuses a NUL character')
  if (value.length > MAX_LITERAL) throw new Error(`sqlLiteral refuses input over ${MAX_LITERAL} characters`)
  return `'${value.replace(/'/g, "''")}'`
}

/** A LIKE/ILIKE pattern matching `value` anywhere, with its wildcards escaped
 *  (backslash is LIKE's default escape and is literal in a standard string). */
export function containsPattern(value: string): string {
  return sqlLiteral(`%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
}

/** An ISO date or timestamp literal cast to timestamptz, validated first. */
export function timestampLiteral(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)
    || Number.isNaN(Date.parse(value))) {
    throw new Error(`not an ISO date: ${value}`)
  }
  return `(${sqlLiteral(value)}::timestamptz)`
}

function boundedInt(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('expected a positive integer')
  }
  return Math.min(value, max)
}

function requiredText(params: DataStoreParams | undefined, key: string): string {
  const value = params?.[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`)
  return value.trim()
}

function optionalText(params: DataStoreParams | undefined, key: string): string | undefined {
  const value = params?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value.trim() === '' ? undefined : value.trim()
}

export const THREAD_MESSAGE_CAP = 120
export const CONVERSATION_MESSAGE_CAP = 8

/** One conversation (instance + profile): who, which campaigns, follow-up
 *  state, and the latest messages with the team's review labels. */
export function threadSql(instanceId: string, profileUrl: string): string {
  const inst = sqlLiteral(instanceId)
  const prof = sqlLiteral(profileUrl)
  return `
with lead_rows as (
  select l.campaign_id, c.name as campaign_name, l.full_name, l.headline, l.company,
         l.added_at, l.invited_at, l.connected_at, l.first_message_at, l.replied_at,
         l.pipeline_stage, l.pipeline_substatus,
         (select string_agg(h.name, ', ' order by h.name)
            from hypothesis_campaigns hc join hypotheses h on h.id = hc.hypothesis_id
           where hc.campaign_id = l.campaign_id) as hypotheses
    from leads l
    left join campaigns c on c.id = l.campaign_id
   where l.instance_id = ${inst} and l.profile_url = ${prof}
), recent as (
  select m.id, m.direction, m.sent_at, m.body, m.source, m.campaign_id, m.message_type,
         (m.external_id is not null) as has_external_id,
         rr.sentiment as review_sentiment, rr.intent_state as review_intent_state,
         rr.intent_level as review_intent, to_jsonb(rr) ->> 'comment' as review_note,
         (select array_agg(r.reason_id order by r.reason_id)
            from reply_review_reasons r where r.message_id = m.id) as review_reasons
    from messages m
    left join reply_reviews rr on rr.message_id = m.id
   where m.instance_id = ${inst} and m.profile_url = ${prof}
   order by m.sent_at desc, m.id desc
   limit ${THREAD_MESSAGE_CAP}
)
select
  (select i.account_name from instances i where i.id = ${inst}) as account_name,
  (select coalesce(jsonb_agg(to_jsonb(lr) order by lr.added_at nulls last), '[]'::jsonb) from lead_rows lr) as leads,
  (select jsonb_build_object('full_name', cc.full_name, 'headline', cc.headline)
     from conversation_contacts cc where cc.instance_id = ${inst} and cc.profile_url = ${prof}) as contact,
  (select jsonb_build_object('next_follow_up_date', f.next_follow_up_date, 'action', f.action,
                             'do_not_contact', f.do_not_contact, 'archived_at', f.archived_at)
     from conversation_follow_up_state f where f.instance_id = ${inst} and f.profile_url = ${prof}) as follow_up,
  (select count(*) from messages m where m.instance_id = ${inst} and m.profile_url = ${prof}) as message_total,
  (select coalesce(jsonb_agg(to_jsonb(x) order by x.sent_at, x.id), '[]'::jsonb) from recent x) as messages
`.trim()
}

export interface CampaignConversationsArgs {
  campaignId: string
  onlyReplied: boolean
  since?: string
  limit: number
}

/** Every person in one campaign (by lead row, because a chat-store message's
 *  campaign_id is only a guess), newest inbound first, each with the last few
 *  messages of the thread and their labels. */
export function campaignConversationsSql(args: CampaignConversationsArgs): string {
  const camp = sqlLiteral(args.campaignId)
  const filters = [
    args.onlyReplied ? 'th.last_in_at is not null' : 'true',
    args.since ? `th.last_in_at >= ${timestampLiteral(args.since)}` : 'true',
  ].join(' and ')
  return `
with people as (
  select l.instance_id, l.profile_url, max(l.full_name) as full_name, max(l.headline) as headline,
         max(l.company) as company, min(l.invited_at) as invited_at, max(l.replied_at) as replied_at,
         max(l.pipeline_stage) as pipeline_stage
    from leads l
   where l.campaign_id = ${camp}
   group by l.instance_id, l.profile_url
), threads as (
  select p.*,
         (select max(m.sent_at) from messages m
           where m.instance_id = p.instance_id and m.profile_url = p.profile_url and m.direction = 'in') as last_in_at,
         (select count(*) from messages m
           where m.instance_id = p.instance_id and m.profile_url = p.profile_url) as message_total
    from people p
), picked as (
  select th.* from threads th
   where ${filters}
   order by th.last_in_at desc nulls last, th.profile_url
   limit ${args.limit}
)
select
  (select count(*) from people) as people_total,
  (select count(*) from threads th where th.last_in_at is not null) as replied_total,
  (select c.name from campaigns c where c.id = ${camp}) as campaign_name,
  (select coalesce(jsonb_agg(to_jsonb(pk) || jsonb_build_object('recent_messages', (
      select coalesce(jsonb_agg(to_jsonb(x) order by x.sent_at, x.id), '[]'::jsonb) from (
        select m.id, m.direction, m.sent_at, m.body, m.source,
               rr.sentiment as review_sentiment, rr.intent_level as review_intent
          from messages m
          left join reply_reviews rr on rr.message_id = m.id
         where m.instance_id = pk.instance_id and m.profile_url = pk.profile_url
         order by m.sent_at desc, m.id desc
         limit ${CONVERSATION_MESSAGE_CAP}) x))
     order by pk.last_in_at desc nulls last, pk.profile_url), '[]'::jsonb)
     from picked pk) as threads
`.trim()
}

export interface SearchMessagesArgs {
  text: string
  direction?: 'in' | 'out'
  campaignId?: string
  since?: string
  limit: number
}

/** Messages whose body contains the text, newest first, with a snippet around
 *  the first match and the thread key to open with get_thread. */
export function searchMessagesSql(args: SearchMessagesArgs): string {
  const needle = sqlLiteral(args.text.toLowerCase())
  const where = [`m.body ilike ${containsPattern(args.text)}`]
  if (args.direction) where.push(`m.direction = ${sqlLiteral(args.direction)}`)
  if (args.since) where.push(`m.sent_at >= ${timestampLiteral(args.since)}`)
  if (args.campaignId) {
    where.push(`exists (select 1 from leads l where l.campaign_id = ${sqlLiteral(args.campaignId)}
                   and l.instance_id = m.instance_id and l.profile_url = m.profile_url)`)
  }
  return `
select m.id as message_id, m.instance_id, m.profile_url, m.direction, m.sent_at, m.source,
       coalesce((select max(l.full_name) from leads l
                  where l.instance_id = m.instance_id and l.profile_url = m.profile_url),
                (select cc.full_name from conversation_contacts cc
                  where cc.instance_id = m.instance_id and cc.profile_url = m.profile_url)) as person,
       substr(m.body, greatest(1, strpos(lower(m.body), ${needle}) - 160), 420) as snippet,
       count(*) over () as total_matches
  from messages m
 where ${where.join('\n   and ')}
 order by m.sent_at desc, m.id desc
 limit ${args.limit}
`.trim()
}

export interface SequenceArgs {
  campaignId?: string
  sequence?: string
}

/** One or more Sequence Builder documents with every step variation, where
 *  each branch was deployed, and the synced LH2 steps (the copy actually
 *  running, with LH2's per-step counts) of every campaign involved. With a
 *  campaign that has no document, only its synced steps come back. With no
 *  argument, a catalog of documents and their deployments. */
export function sequenceSql(args: SequenceArgs): string {
  let docs: string
  if (args.campaignId) {
    const camp = sqlLiteral(args.campaignId)
    docs = `
  select j.sequence_document_id as id
    from sequence_publish_jobs j join sequence_publish_branches b on b.job_id = j.id
   where b.lh_campaign_id is not null and j.target_instance_id || ':' || b.lh_campaign_id = ${camp}
  union
  select k.sequence_document_id from campaign_sequence_links k where k.campaign_id = ${camp}`
  } else if (args.sequence) {
    docs = `
  select d.id from (
    select d0.id from sequence_documents d0
     where d0.id::text = ${sqlLiteral(args.sequence)} or d0.name ilike ${containsPattern(args.sequence)}
     order by (d0.id::text = ${sqlLiteral(args.sequence)}) desc, d0.archived, d0.updated_at desc
     limit 5) d`
  } else {
    docs = `
  select d.id from sequence_documents d where d.archived = false`
  }
  const detailed = Boolean(args.campaignId || args.sequence)
  const extraCampaign = args.campaignId ? `union select ${sqlLiteral(args.campaignId)}` : ''
  return `
with docs as (${docs}
), deployments_all as (
  select j.sequence_document_id, j.target_instance_id || ':' || b.lh_campaign_id as campaign_id,
         b.branch_id, b.branch_letter, b.campaign_name as published_name, j.sequence_revision,
         j.status as publish_status, j.queued_at as deployed_at, 'published'::text as via,
         row_number() over (partition by j.target_instance_id || ':' || b.lh_campaign_id
                            order by j.queued_at desc, j.id desc) as rank_in_campaign
    from sequence_publish_jobs j join sequence_publish_branches b on b.job_id = j.id
   where b.lh_campaign_id is not null and j.sequence_document_id in (select id from docs)
  union all
  select k.sequence_document_id, k.campaign_id, null, null, null, null, null, k.linked_at, k.link_kind, 1
    from campaign_sequence_links k
   where k.sequence_document_id in (select id from docs)
), deployments as (
  select dep.*, c.name as campaign_name, c.instance_id, i.account_name, c.runtime_status, c.is_archived
    from deployments_all dep
    left join campaigns c on c.id = dep.campaign_id
    left join instances i on i.id = c.instance_id
   where dep.rank_in_campaign = 1
), involved as (
  select campaign_id from deployments ${extraCampaign}
)
select
  (select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'name', d.name, 'revision', d.revision, 'archived', d.archived,
      'updated_at', d.updated_at${detailed ? ", 'document', d.document" : ''}) order by d.updated_at desc), '[]'::jsonb)
     from sequence_documents d where d.id in (select id from docs)) as documents,
  (select coalesce(jsonb_agg(to_jsonb(dp) - 'rank_in_campaign' order by dp.sequence_document_id, dp.branch_letter nulls last, dp.campaign_id), '[]'::jsonb)
     from deployments dp) as deployments,
  ${detailed ? `(select coalesce(jsonb_agg(jsonb_build_object(
      'campaign_id', c.id, 'name', c.name, 'instance_id', c.instance_id, 'account_name', i.account_name,
      'runtime_status', c.runtime_status, 'is_archived', c.is_archived) order by c.id), '[]'::jsonb)
     from campaigns c left join instances i on i.id = c.instance_id
    where c.id in (select campaign_id from involved)) as campaigns,
  (select coalesce(jsonb_agg(jsonb_build_object(
      'campaign_id', s.campaign_id, 'step_index', s.step_index, 'step_type', s.step_type,
      'template_body', s.template_body, 'sent_count', s.sent_count, 'replied_count', s.replied_count,
      'current_count', s.current_count) order by s.campaign_id, s.step_index), '[]'::jsonb)
     from campaign_steps s
    where s.campaign_id in (select campaign_id from involved)
      and (s.step_type in ('InvitePerson', 'MessageToPerson') or coalesce(btrim(s.template_body), '') <> '')) as steps`
    : `'[]'::jsonb as campaigns, '[]'::jsonb as steps`}
`.trim()
}

/** Build the statement for one context operation from its params. Exported so
 *  a test can assert the SQL each tool would run without a database. */
export function buildContextSql(name: AiContextOperation, params: DataStoreParams | undefined): string {
  switch (name) {
    case 'thread':
      return threadSql(requiredText(params, 'instance_id'), requiredText(params, 'profile_url'))
    case 'campaignConversations':
      return campaignConversationsSql({
        campaignId: requiredText(params, 'campaign_id'),
        onlyReplied: params?.only_replied !== false,
        since: optionalText(params, 'since'),
        limit: boundedInt(params?.limit, 25, 40),
      })
    case 'searchMessages': {
      const direction = optionalText(params, 'direction')
      if (direction !== undefined && direction !== 'in' && direction !== 'out') {
        throw new Error("direction must be 'in' or 'out'")
      }
      return searchMessagesSql({
        text: requiredText(params, 'text'),
        direction,
        campaignId: optionalText(params, 'campaign_id'),
        since: optionalText(params, 'since'),
        limit: boundedInt(params?.limit, 25, 50),
      })
    }
    case 'sequence':
      return sequenceSql({
        campaignId: optionalText(params, 'campaign_id'),
        sequence: optionalText(params, 'sequence'),
      })
  }
}

/** Register the context reads on the AI registry: each a guard call. */
export function registerContextOperations(registry: NeonOperationRegistry): NeonOperationRegistry {
  for (const [name, operation] of Object.entries(AI_CONTEXT_OPERATIONS) as [AiContextOperation, string][]) {
    registry.registerQuery<unknown[]>(operation, {
      build: ({ params }) => guardStatement(buildContextSql(name, params)),
      mapRow: mapGuardRow,
    })
  }
  return registry
}
