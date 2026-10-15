// Readable context for the AI: threads, a campaign's conversations, message
// search and sequences. The SQL lives in data/operations/aiContext.ts (guard
// calls); this module runs it and turns the jsonb into compact text a model
// reads faster and more reliably than raw rows. Shared by /api/chat, /api/mcp
// and the briefing through _lib/tools.ts.
import { getAiDataStore, SYSTEM_ACTOR } from './data/aiStore.js'
import {
  AI_CONTEXT_OPERATIONS,
  THREAD_MESSAGE_CAP,
  type AiContextOperation,
} from './data/operations/aiContext.js'
import type { DataStoreParams } from './data/contracts.js'

/** Output ceiling per tool call. Larger than run_sql's 24k because a thread or a
 *  campaign's replies is the point of the call, not a side effect. */
export const CONTEXT_MAX_CHARS = 60_000
const THREAD_BODY_CAP = 2000
const CONVERSATION_BODY_CAP = 700

type Row = Record<string, unknown>

async function runContext(name: AiContextOperation, params: DataStoreParams): Promise<Row[]> {
  const page = await getAiDataStore().query<unknown[]>(SYSTEM_ACTOR, {
    operation: AI_CONTEXT_OPERATIONS[name],
    params,
  })
  return ((page.items[0] as unknown[] | undefined) ?? []) as Row[]
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : [])

/** "2026-09-01 10:22" in UTC, or '' for a missing value. */
export function utcMinute(v: unknown): string {
  if (!v) return ''
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? str(v) : d.toISOString().slice(0, 16).replace('T', ' ')
}
const utcDay = (v: unknown) => utcMinute(v).slice(0, 10)

function clip(text: unknown, cap: number): string {
  const s = str(text).replace(/\r\n?/g, '\n').trim()
  return s.length > cap ? `${s.slice(0, cap)}… [+${s.length - cap} chars]` : s
}

/** Cut a rendered text to the ceiling, saying so, rather than overflowing the
 *  model's context with one call. */
export function capText(text: string, max = CONTEXT_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… [output truncated at ${max} characters]` : text
}

function labelOf(m: Row): string {
  const parts: string[] = []
  if (m.review_sentiment) parts.push(str(m.review_sentiment))
  if (m.review_intent) parts.push(str(m.review_intent).toUpperCase())
  else if (m.review_intent_state === 'none') parts.push('no intent')
  const reasons = Array.isArray(m.review_reasons) ? (m.review_reasons as string[]) : []
  if (reasons.length) parts.push(`reasons: ${reasons.join(', ')}`)
  if (m.review_note) parts.push(`note: "${clip(m.review_note, 300)}"`)
  return parts.join(', ')
}

/** One message as a transcript line: [time DIR · flags · labels] body. */
export function messageLine(m: Row, bodyCap: number): string {
  const tags = [`${utcMinute(m.sent_at)} ${m.direction === 'out' ? 'OUT' : 'IN'}`]
  if (m.source === 'manual') tags.push('imported by hand')
  else if (m.has_external_id === false) tags.push('time ≈ LH2 action run')
  if (m.message_type && !['DEFAULT', 'MEMBER_TO_MEMBER'].includes(str(m.message_type))) tags.push(str(m.message_type).toLowerCase())
  if (m.direction === 'in') {
    const label = labelOf(m)
    tags.push(label ? `label: ${label}` : 'unlabelled')
  }
  const body = m.body === null || m.body === undefined ? '(no text — recalled or attachment)' : clip(m.body, bodyCap)
  return `[${tags.join(' · ')}] ${body}`
}

export function formatThread(row: Row | undefined, instanceId: string, profileUrl: string): string {
  if (!row) return `No data for thread ${instanceId} | ${profileUrl}.`
  const leads = arr(row.leads)
  const contact = (row.contact ?? null) as Row | null
  const first = leads[0]
  const name = str(first?.full_name) || str(contact?.full_name) || 'unknown name'
  const headline = str(first?.headline) || str(contact?.headline)
  const out: string[] = []
  out.push(`Thread ${instanceId} | ${profileUrl} — account: ${str(row.account_name) || instanceId}`)
  out.push(`Person: ${name}${headline ? ` — ${headline}` : ''}${first?.company ? ` @ ${str(first.company)}` : ''}`)
  if (!leads.length) out.push('Campaigns: none (a general-inbox conversation, not a campaign lead).')
  for (const l of leads) {
    const milestones = [
      ['added', l.added_at], ['invited', l.invited_at], ['connected', l.connected_at],
      ['first message', l.first_message_at], ['replied', l.replied_at],
    ].filter(([, v]) => v).map(([k, v]) => `${k} ${utcDay(v)}`).join(', ')
    const crm = l.pipeline_stage ? `; pipeline: ${str(l.pipeline_stage)}${l.pipeline_substatus ? `/${str(l.pipeline_substatus)}` : ''}` : ''
    out.push(`Campaign "${str(l.campaign_name) || str(l.campaign_id)}" (${str(l.campaign_id)}${l.hypotheses ? `; hypothesis: ${str(l.hypotheses)}` : ''}): ${milestones || 'no milestones'}${crm}`)
  }
  const f = (row.follow_up ?? null) as Row | null
  if (f) {
    const bits = [
      f.action ? `action ${str(f.action)}` : '',
      f.next_follow_up_date ? `next follow-up ${str(f.next_follow_up_date)}` : '',
      f.do_not_contact ? 'DO NOT CONTACT' : '',
      f.archived_at ? `archived ${utcDay(f.archived_at)}` : '',
    ].filter(Boolean)
    if (bits.length) out.push(`Follow-up: ${bits.join(', ')}`)
  }
  const messages = arr(row.messages)
  const total = Number(row.message_total ?? messages.length)
  out.push('')
  out.push(total > messages.length
    ? `Messages (latest ${messages.length} of ${total}, oldest first; times UTC):`
    : `Messages (${messages.length}, oldest first; times UTC):`)
  if (!messages.length) out.push('(none synced)')
  for (const m of messages) out.push(messageLine(m, THREAD_BODY_CAP))
  return capText(out.join('\n'))
}

export function formatCampaignConversations(row: Row | undefined, campaignId: string): string {
  if (!row) return `No data for campaign ${campaignId}.`
  const threads = arr(row.threads)
  const out: string[] = []
  out.push(`Campaign "${str(row.campaign_name) || campaignId}" (${campaignId}): ${str(row.people_total)} people, ${str(row.replied_total)} with an inbound message. Showing ${threads.length} thread(s), newest reply first; each shows its latest messages (times UTC). Use get_thread for a full thread.`)
  for (const t of threads) {
    out.push('')
    const total = Number(t.message_total ?? 0)
    const recent = arr(t.recent_messages)
    out.push(`## ${str(t.full_name) || 'unknown'}${t.headline ? ` — ${clip(t.headline, 160)}` : ''}${t.company ? ` @ ${str(t.company)}` : ''}`)
    out.push(`thread: ${str(t.instance_id)} | ${str(t.profile_url)}; invited ${utcDay(t.invited_at) || '—'}; ${total} message(s)${total > recent.length ? `, showing last ${recent.length}` : ''}${t.pipeline_stage ? `; pipeline: ${str(t.pipeline_stage)}` : ''}`)
    for (const m of recent) out.push(messageLine(m, CONVERSATION_BODY_CAP))
  }
  return capText(out.join('\n'))
}

export function formatSearch(rows: Row[], text: string): string {
  if (!rows.length) return `No message contains "${text}".`
  const total = Number(rows[0].total_matches ?? rows.length)
  const out = [`${total} message(s) contain "${text}"${total > rows.length ? `; newest ${rows.length} shown` : ''} (times UTC):`]
  for (const r of rows) {
    out.push(`- ${utcMinute(r.sent_at)} ${r.direction === 'out' ? 'OUT' : 'IN'} · ${str(r.person) || 'unknown'} · thread ${str(r.instance_id)} | ${str(r.profile_url)}${r.source === 'manual' ? ' · imported by hand' : ''}\n  …${clip(r.snippet, 420)}…`)
  }
  return capText(out.join('\n'))
}

interface DocVariation { id?: string; label?: string; text?: string }
interface DocStep { id?: string; kind?: string; variations?: DocVariation[] }
interface DocBranch { id?: string; name?: string; selections?: Record<string, string> }

function stepName(step: DocStep, index: number): string {
  return index === 0 && step.kind === 'connection' ? 'Step 1 — connection request' : `Step ${index + 1} — message ${index}`
}

export function formatSequence(row: Row | undefined, request: { campaign_id?: string; sequence?: string }): string {
  if (!row) return 'No sequence data.'
  const documents = arr(row.documents)
  const deployments = arr(row.deployments)
  const campaigns = arr(row.campaigns)
  const steps = arr(row.steps)
  const detailed = Boolean(request.campaign_id || request.sequence)
  const out: string[] = []

  if (!detailed) {
    out.push(`${documents.length} live Sequence Builder document(s). Call get_sequence with a sequence id/name or a campaign_id for the full copy.`)
    for (const d of documents) {
      const deps = deployments.filter((x) => x.sequence_document_id === d.id)
      out.push(`- "${str(d.name)}" (id ${str(d.id)}, revision ${str(d.revision)}, updated ${utcDay(d.updated_at)}): ${deps.length ? deps.map((x) => `${str(x.campaign_name) || str(x.campaign_id)}${x.branch_letter ? ` [${str(x.branch_letter)}]` : ''} on ${str(x.account_name) || str(x.instance_id)}`).join('; ') : 'not deployed'}`)
    }
    out.push('Campaigns built directly in Linked Helper have no document; get_sequence({campaign_id}) shows their synced steps.')
    return capText(out.join('\n'))
  }

  if (!documents.length && request.sequence) out.push(`No Sequence Builder document matches "${request.sequence}".`)
  for (const d of documents) {
    const doc = (d.document ?? {}) as { steps?: DocStep[]; branches?: DocBranch[] }
    const docSteps = doc.steps ?? []
    out.push(`# Sequence "${str(d.name)}" (id ${str(d.id)}, current revision ${str(d.revision)}${d.archived ? ', ARCHIVED' : ''}, updated ${utcDay(d.updated_at)})`)
    out.push('This is the authored copy (Builder variables look like {firstName}). A draft is not proof anything was sent — the deployments and synced steps below are.')
    docSteps.forEach((step, i) => {
      out.push(`${stepName(step, i)}:`)
      for (const v of step.variations ?? []) out.push(`  • ${str(v.label) || str(v.id)}: ${clip(v.text, 2000)}`)
    })
    const branches = doc.branches ?? []
    if (branches.length) {
      out.push('Branches (each published branch becomes its own LH2 campaign, so a branch IS a variant combination):')
      branches.forEach((b, ordinal) => {
        const picks = docSteps.map((step, i) => {
          const chosen = b.selections?.[step.id ?? ''] ?? step.variations?.[0]?.id
          const v = step.variations?.find((x) => x.id === chosen)
          return `step ${i + 1}=${str(v?.label) || str(chosen)}`
        })
        out.push(`  ${String.fromCharCode(65 + ordinal)} "${str(b.name)}": ${picks.join(', ')}`)
      })
    }
    const deps = deployments.filter((x) => x.sequence_document_id === d.id)
    out.push(deps.length ? 'Deployments:' : 'Deployments: none.')
    for (const x of deps) {
      out.push(`  - ${str(x.campaign_name) || str(x.published_name) || str(x.campaign_id)} (${str(x.campaign_id)}) on ${str(x.account_name) || str(x.instance_id)}${x.branch_letter ? `, branch ${str(x.branch_letter)}` : ''}${x.sequence_revision ? `, from revision ${str(x.sequence_revision)}` : ''}, via ${str(x.via)}${x.runtime_status ? `, runtime ${str(x.runtime_status)}` : ''}${x.is_archived ? ', archived' : ''}`)
    }
    out.push('')
  }

  if (request.campaign_id && !documents.length) {
    out.push(`Campaign ${request.campaign_id} has no Sequence Builder document (built directly in Linked Helper, or not linked). Its synced steps are below.`)
  }
  if (campaigns.length) {
    out.push('# Synced LH2 steps — the copy actually running (LH2 variables look like {{firstName}}; only the first LH2 variant of a step is synced). sent/replied are LH2-derived per-step counts; replied credits the last messaging step sent before the first reply.')
    for (const c of campaigns) {
      out.push(`## ${str(c.name)} (${str(c.campaign_id)}) on ${str(c.account_name) || str(c.instance_id)}${c.runtime_status ? `, runtime ${str(c.runtime_status)}` : ''}${c.is_archived ? ', archived' : ''}`)
      const own = steps.filter((s) => s.campaign_id === c.campaign_id)
      if (!own.length) out.push('  (no synced message steps)')
      for (const s of own) {
        out.push(`  [${str(s.step_index)}] ${str(s.step_type)} — sent ${str(s.sent_count)}, replied ${str(s.replied_count)}, in queue ${str(s.current_count)}${s.template_body ? `\n      ${clip(s.template_body, 2000).replace(/\n/g, '\n      ')}` : ''}`)
      }
    }
  } else if (request.campaign_id) {
    out.push(`No campaign ${request.campaign_id} was found.`)
  }
  return capText(out.join('\n'))
}

// ---------------------------------------------------------------------------
// Entry points used by the tools
// ---------------------------------------------------------------------------

export async function getThread(args: { instance_id: string; profile_url: string }): Promise<string> {
  const rows = await runContext('thread', args)
  return formatThread(rows[0], args.instance_id, args.profile_url)
}

export async function getCampaignConversations(args: {
  campaign_id: string
  only_replied?: boolean
  since?: string
  limit?: number
}): Promise<string> {
  const rows = await runContext('campaignConversations', args)
  return formatCampaignConversations(rows[0], args.campaign_id)
}

export async function searchMessages(args: {
  text: string
  direction?: 'in' | 'out'
  campaign_id?: string
  since?: string
  limit?: number
}): Promise<string> {
  const rows = await runContext('searchMessages', args)
  return formatSearch(rows, args.text)
}

export async function getSequence(args: { campaign_id?: string; sequence?: string }): Promise<string> {
  const rows = await runContext('sequence', args)
  return formatSequence(rows[0], args)
}

export { THREAD_MESSAGE_CAP }
