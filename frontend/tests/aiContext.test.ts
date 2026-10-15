/**
 * The AI context reads, offline: literal construction, that every statement
 * would pass the guard's own lexical rules, the transcript/outline formatters,
 * and that chat and MCP expose the same tools. The live counterpart (the guard
 * actually serving these against Neon) needs ledger step 023 applied.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  AI_CONTEXT_OPERATIONS,
  buildContextSql,
  containsPattern,
  sqlLiteral,
  timestampLiteral,
  type AiContextOperation,
} from '../api/_lib/data/operations/aiContext.js'
import { buildAiRegistry } from '../api/_lib/data/operations/ai.js'
import { DataStoreAuthorizationError } from '../api/_lib/data/contracts.js'
import {
  capText,
  formatCampaignConversations,
  formatSearch,
  formatSequence,
  formatThread,
  messageLine,
} from '../api/_lib/aiContext.js'
import { buildTools, toolDefs } from '../api/_lib/tools.js'

/** The guard's scan (tenant baseline 003, ai_execute_sql) re-stated: mask
 *  standard string literals, refuse E''/U&'' prefixes, then apply the single
 *  statement, SELECT/WITH and keyword rules to what is left. */
const DENIED = /\b(insert|update|delete|merge|truncate|create|alter|drop|grant|revoke|comment|copy|call|do|execute|prepare|deallocate|reindex|refresh|vacuum|cluster|lock|listen|unlisten|notify|discard|reset|set|begin|start|commit|rollback|savepoint|import|declare|checkpoint|reassign|into|analyze|explain|security)\b/i
function guardVerdict(sql: string): string | null {
  let scan = ''
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "'") {
      if (i > 0 && /[eEuU&]/.test(sql[i - 1])) return 'escape literal'
      let j = i + 1
      for (;;) {
        if (j >= sql.length) return 'unterminated literal'
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") break
        j++
      }
      scan += 'x'.repeat(j - i + 1)
      i = j
    } else if (sql.startsWith('--', i) || sql.startsWith('/*', i) || sql[i] === '$' || sql[i] === '"') {
      return 'unexpected comment, dollar or quoted identifier'
    } else {
      scan += sql[i]
    }
  }
  const body = scan.replace(/[;\s]+$/, '')
  if (body.includes(';')) return 'multiple statements'
  if (!/^\s*(select|with)\b/i.test(body)) return 'not SELECT/WITH'
  const denied = body.match(DENIED)
  return denied ? `denied keyword ${denied[1]}` : null
}

const SAMPLE_PARAMS: Record<AiContextOperation, Record<string, unknown>[]> = {
  thread: [{ instance_id: 'notebook-1', profile_url: 'https://www.linkedin.com/in/o-brien' }],
  campaignConversations: [
    { campaign_id: 'notebook-1:42' },
    { campaign_id: 'notebook-1:42', only_replied: false, since: '2026-09-01', limit: 40 },
  ],
  searchMessages: [
    { text: 'set up a call into next week; drop me a line' },
    { text: "budget 100%_ \\ isn't", direction: 'in', campaign_id: 'notebook-1:42', since: '2026-09-01T00:00:00Z', limit: 50 },
  ],
  sequence: [{}, { campaign_id: 'notebook-1:42' }, { sequence: "Founders' outreach" }],
}

describe('sqlLiteral and friends', () => {
  it('doubles quotes and wraps in a standard string', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'")
    expect(sqlLiteral('')).toBe("''")
    expect(sqlLiteral('a\\b')).toBe("'a\\b'")
  })

  it('refuses NUL and over-long input', () => {
    expect(() => sqlLiteral('a\u0000b')).toThrow()
    expect(() => sqlLiteral('x'.repeat(2001))).toThrow()
  })

  it('escapes LIKE wildcards and the escape character', () => {
    expect(containsPattern('100%_x\\')).toBe("'%100\\%\\_x\\\\%'")
  })

  it('accepts ISO dates and refuses anything else', () => {
    expect(timestampLiteral('2026-09-01')).toBe("('2026-09-01'::timestamptz)")
    expect(timestampLiteral('2026-09-01T10:00:00Z')).toContain('::timestamptz')
    for (const bad of ["2026-09-01'; select 1", 'yesterday', '2026-13-45', '']) {
      expect(() => timestampLiteral(bad)).toThrow()
    }
  })
})

describe('the context statements', () => {
  it('pass the guard rules for representative and hostile arguments', () => {
    for (const [name, samples] of Object.entries(SAMPLE_PARAMS) as [AiContextOperation, Record<string, unknown>[]][]) {
      for (const params of samples) {
        const sql = buildContextSql(name, params as never)
        expect(guardVerdict(sql), `${name} ${JSON.stringify(params)}`).toBeNull()
      }
    }
  })

  it('keeps an injection attempt inside one literal', () => {
    const hostile = "x'); drop table messages; --"
    const sql = buildContextSql('thread', { instance_id: hostile, profile_url: hostile })
    expect(guardVerdict(sql)).toBeNull()
    expect(sql).toContain("'x''); drop table messages; --'")
  })

  it('the guard mirror is not vacuous', () => {
    expect(guardVerdict("select 1; select 2")).toBe('multiple statements')
    expect(guardVerdict('select rr.comment from reply_reviews rr')).toBe('denied keyword comment')
    expect(guardVerdict("select E'x'")).toBe('escape literal')
    expect(guardVerdict("select 'set'")).toBeNull()
  })

  it('validates arguments before any SQL is built', () => {
    expect(() => buildContextSql('thread', { instance_id: 'n', profile_url: ' ' })).toThrow()
    expect(() => buildContextSql('campaignConversations', {})).toThrow()
    expect(() => buildContextSql('campaignConversations', { campaign_id: 'c', limit: 0 })).toThrow()
    expect(() => buildContextSql('searchMessages', { text: 'x', direction: 'both' })).toThrow()
    expect(() => buildContextSql('searchMessages', { text: 'x', since: 'last week' })).toThrow()
  })

  it('caps limits at the documented maxima', () => {
    expect(buildContextSql('campaignConversations', { campaign_id: 'c', limit: 999 })).toMatch(/limit 40\n/)
    expect(buildContextSql('searchMessages', { text: 'hello', limit: 999 })).toMatch(/limit 50$/)
  })

  it('scopes campaign reads through leads, not the guessed messages.campaign_id', () => {
    expect(buildContextSql('campaignConversations', { campaign_id: 'c' })).toContain("where l.campaign_id = 'c'")
    expect(buildContextSql('searchMessages', { text: 'hi', campaign_id: 'c' })).toContain("l.campaign_id = 'c'")
  })

  it('registers each as a guard query and never as a command', () => {
    const registry = buildAiRegistry()
    for (const [name, operation] of Object.entries(AI_CONTEXT_OPERATIONS) as [AiContextOperation, string][]) {
      const query = registry.lookupQuery(operation)
      const statement = query.build({
        actor: undefined as never,
        params: SAMPLE_PARAMS[name][0] as never,
        page: { limit: 1, cursor: null },
        range: undefined,
        after: undefined,
      } as never)
      expect(statement.text).toBe('SELECT public.ai_execute_sql($1) AS result')
      expect(() => registry.lookupCommand(operation)).toThrow(DataStoreAuthorizationError)
    }
  })
})

describe('the formatters', () => {
  const inbound = {
    id: 2, direction: 'in', sent_at: '2026-09-03T08:00:00Z', body: 'Sounds good, what does it cost?',
    source: 'sync', has_external_id: true, review_sentiment: 'positive', review_intent: 'p3',
    review_reasons: ['timing'], review_note: 'asked for pricing',
  }

  it('renders a thread oldest first with flags and labels', () => {
    const text = formatThread({
      account_name: 'Ivan',
      leads: [{ campaign_id: 'notebook-1:42', campaign_name: 'Founders A', full_name: 'Ann Lee',
        headline: 'CEO', company: 'Acme', invited_at: '2026-08-01T00:00:00Z', replied_at: '2026-09-03T08:00:00Z',
        hypotheses: 'H1', pipeline_stage: 'call_booked' }],
      contact: null,
      follow_up: { action: 'needs_reply', do_not_contact: false },
      message_total: 130,
      messages: [
        { id: 1, direction: 'out', sent_at: '2026-09-01T10:22:00Z', body: 'Hi {{firstName}}', source: 'sync', has_external_id: false,
          step_campaign_id: 'notebook-1:42', step_type: 'InvitePerson', message_ordinal: 0, step_ambiguous: false },
        { id: 4, direction: 'out', sent_at: '2026-09-02T10:00:00Z', body: 'Follow-up', source: 'sync', has_external_id: true,
          step_campaign_id: 'notebook-1:42', step_type: 'MessageToPerson', message_ordinal: 2, step_ambiguous: true },
        { id: 5, direction: 'out', sent_at: '2026-09-02T11:00:00Z', body: 'typed by hand', source: 'sync', has_external_id: true },
        inbound,
        { id: 3, direction: 'out', sent_at: '2026-09-04T09:00:00Z', body: 'Pasted reply', source: 'manual', has_external_id: false },
      ],
    }, 'notebook-1', 'https://www.linkedin.com/in/ann')
    expect(text).toContain('Person: Ann Lee — CEO @ Acme')
    expect(text).toContain('hypothesis: H1')
    expect(text).toContain('pipeline: call_booked')
    expect(text).toContain('latest 5 of 130')
    expect(text).toContain('[2026-09-01 10:22 OUT · connection note of notebook-1:42 · time ≈ LH2 action run] Hi {{firstName}}')
    expect(text).toContain('[2026-09-02 10:00 OUT · message 2 of notebook-1:42 (ambiguous)] Follow-up')
    expect(text).toContain('[2026-09-02 11:00 OUT · no template match] typed by hand')
    expect(text).toContain('label: positive, P3, reasons: timing, note: "asked for pricing"')
    expect(text).toContain('imported by hand')
    expect(text.indexOf('10:22 OUT')).toBeLessThan(text.indexOf('08:00 IN'))
    expect(text).toContain('Follow-up: action needs_reply')
  })

  it('falls back to the contact name for a general-inbox thread', () => {
    const text = formatThread({ leads: [], contact: { full_name: 'Bo', headline: 'CTO' }, messages: [] }, 'n', 'p')
    expect(text).toContain('Person: Bo — CTO')
    expect(text).toContain('general-inbox')
  })

  it('marks unlabelled replies and clips long bodies', () => {
    const line = messageLine({ direction: 'in', sent_at: '2026-09-03T08:00:00Z', body: 'x'.repeat(50) }, 10)
    expect(line).toContain('unlabelled')
    expect(line).toContain('[+40 chars]')
  })

  it('renders campaign conversations with the thread key', () => {
    const text = formatCampaignConversations({
      campaign_name: 'Founders A', people_total: 120, replied_total: 9,
      threads: [{ instance_id: 'notebook-1', profile_url: 'p1', full_name: 'Ann', message_total: 12,
        recent_messages: [inbound] }],
    }, 'notebook-1:42')
    expect(text).toContain('120 people, 9 with an inbound message')
    expect(text).toContain('thread: notebook-1 | p1')
    expect(text).toContain('showing last 1')
  })

  it('renders search results and the empty case', () => {
    expect(formatSearch([], 'budget')).toBe('No message contains "budget".')
    const text = formatSearch([{ sent_at: '2026-09-03T08:00:00Z', direction: 'in', person: 'Ann',
      instance_id: 'n', profile_url: 'p', snippet: 'no budget', total_matches: 30 }], 'budget')
    expect(text).toContain('30 message(s)')
    expect(text).toContain('thread n | p')
  })

  it('renders a sequence with variations, branch picks, deployments and synced steps', () => {
    const text = formatSequence({
      documents: [{ id: 'd1', name: 'Founders', revision: 4, updated_at: '2026-09-01T00:00:00Z', document: {
        steps: [
          { id: 's1', kind: 'connection', variations: [{ id: 'v1', label: 'Short', text: 'Hi {firstName}' }] },
          { id: 's2', kind: 'message', variations: [
            { id: 'v2', label: 'Pain', text: 'Struggling with X?' },
            { id: 'v3', label: 'Proof', text: 'We helped Y' }] },
        ],
        branches: [{ id: 'b1', name: 'Pain', selections: {} }, { id: 'b2', name: 'Proof', selections: { s2: 'v3' } }],
      } }],
      deployments: [{ sequence_document_id: 'd1', campaign_id: 'notebook-1:42', campaign_name: 'Founders A',
        account_name: 'Ivan', branch_letter: 'A', sequence_revision: 3, via: 'published' }],
      campaigns: [{ campaign_id: 'notebook-1:42', name: 'Founders A', account_name: 'Ivan' }],
      steps: [{ campaign_id: 'notebook-1:42', step_index: 2, step_type: 'MessageToPerson',
        template_body: 'Struggling with X, {{firstName}}?', sent_count: 80, replied_count: 6, current_count: 3 }],
      performance: [{ campaign_id: 'notebook-1:42', step_index: 2, sent: 78, people: 77, replied: 7,
        mature_sent: 60, mature_replied: 6, positive_replies: 2, p3_replies: 1, ambiguous_sent: 0,
        first_sent_at: '2026-08-01T00:00:00Z', last_sent_at: '2026-10-01T00:00:00Z' }],
    }, { campaign_id: 'notebook-1:42' })
    expect(text).toContain('Step 2 — message 1:')
    expect(text).toContain('• Proof: We helped Y')
    expect(text).toContain('A "Pain": step 1=Short, step 2=Pain')
    expect(text).toContain('B "Proof": step 1=Short, step 2=Proof')
    expect(text).toContain('branch A, from revision 3, via published')
    expect(text).toContain('[2] MessageToPerson — LH2: sent 80, replied 6')
    expect(text).toContain('Matched: 78 sent to 77 people, 7 replied (9.0%); mature 6/60 (10.0%); positive 2, P3 1; sent 2026-08-01..2026-10-01')
  })

  it('says when a campaign has no Builder document', () => {
    const text = formatSequence({ documents: [], deployments: [], campaigns: [
      { campaign_id: 'n:1', name: 'Native' }], steps: [] }, { campaign_id: 'n:1' })
    expect(text).toContain('has no Sequence Builder document')
    expect(text).toContain('(no synced message steps)')
  })

  it('caps output and says so', () => {
    expect(capText('x'.repeat(20), 10)).toBe(`${'x'.repeat(10)}\n… [output truncated at 10 characters]`)
  })
})

describe('tool parity', () => {
  const contextTools = ['get_sequence', 'get_thread', 'campaign_conversations', 'search_messages'] as const

  it('chat exposes every shared tool definition', () => {
    expect(Object.keys(buildTools()).sort()).toEqual(Object.keys(toolDefs).sort())
  })

  it('MCP registers every context tool', () => {
    const mcp = readFileSync(join(__dirname, '..', 'api', 'mcp.ts'), 'utf8')
    for (const name of contextTools) {
      expect(toolDefs[name].name).toBe(name)
      expect(mcp).toContain(`toolDefs.${name}.name`)
    }
  })
})
