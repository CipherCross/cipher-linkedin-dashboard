/*
 * Local-only browser fixture API. This module is intentionally outside
 * frontend/api: ui-fixture-dev.mjs exposes it only from an ephemeral Vercel
 * project root and never changes the product functions.
 */

import { readFile, writeFile } from 'node:fs/promises'

const ACTOR_IDS = {
  admin: 'fixture-admin-00000000-0000-0000-0000-000000000001',
  member: 'fixture-member-00000000-0000-0000-0000-000000000002',
}

const DEFAULT_SCENARIO = process.env.UI_FIXTURE_SCENARIO || 'populated-admin'

async function currentScenario() {
  try {
    return (await readFile(process.env.UI_FIXTURE_STATE_FILE, 'utf8')).trim() || DEFAULT_SCENARIO
  } catch {
    return DEFAULT_SCENARIO
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })

const page = (items) => ({ items, nextCursor: null, hasMore: false })

const instance = {
  id: 'fixture-instance',
  label: 'Fixture account',
  last_sync_at: '2026-09-22T08:00:00.000Z',
  agent_version: 'fixture',
  account_name: 'Fixture account',
  account_url: 'https://example.test/fixture-account',
  account_avatar: null,
  config: null,
  config_updated_at: null,
}

const campaign = {
  campaign_id: 'fixture-instance:1',
  instance_id: 'fixture-instance',
  campaign_name: 'Fixture outreach',
  status: 'active',
  runtime_status: 'running',
  is_archived: false,
  status_observed_at: '2026-09-22T08:00:00.000Z',
  status_source: 'fixture',
  status_raw: 'running',
  total_leads: 1,
  invites_sent: 1,
  connected: 1,
  first_messages: 1,
  accepted: 1,
  replies: 1,
  acceptance_rate: 100,
  reply_rate: 100,
  lifetime_acceptance_rate: 100,
  lifetime_reply_rate: 100,
  leads_added: 1,
  last_activity_at: '2026-09-21T12:00:00.000Z',
}

const member = (role) => ({
  id: role === 'admin' ? 1 : 2,
  userId: ACTOR_IDS[role],
  name: role === 'admin' ? 'Fixture Admin' : 'Fixture Member',
  email: `${role}@fixture.test`,
  role,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
})

const teamMember = (role) => ({
  id: role === 'admin' ? 1 : 2,
  name: role === 'admin' ? 'Fixture Admin' : 'Fixture Member',
  active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  auth_user_id: null,
  email: `${role}@fixture.test`,
  role,
})

function activeRole(scenario) {
  if (scenario === 'populated-member' || scenario === 'empty-member') return 'member'
  return 'admin'
}

function isEmpty(scenario) {
  return scenario === 'empty-admin' || scenario === 'empty-member'
}

function leadRows(scenario) {
  if (isEmpty(scenario)) return []
  return [{
    id: 'fixture-lead-00000000-0000-0000-0000-000000000001',
    instance_id: instance.id,
    campaign_id: campaign.campaign_id,
    profile_url: 'https://example.test/fixture-lead',
    full_name: 'Alex Fixture',
    headline: 'Product leader',
    company: 'Fixture Labs',
    added_at: '2026-09-20T09:00:00.000Z',
    invited_at: '2026-09-20T09:00:00.000Z',
    connected_at: '2026-09-20T10:00:00.000Z',
    first_message_at: '2026-09-20T11:00:00.000Z',
    replied_at: '2026-09-21T12:00:00.000Z',
    last_action_at: '2026-09-21T12:00:00.000Z',
    pipeline_stage: 'interested',
    pipeline_substatus: null,
    lost_reason: null,
    pipeline_stage_changed_at: '2026-09-21T12:00:00.000Z',
    assigned_to: null,
    gender: null,
    gender_confidence: null,
    gender_inferred_at: null,
    gender_model_version: null,
    demo_inferred_at: null,
    demo_model: null,
    photo_path: null,
    photo_synced_at: null,
  }]
}

function messageRows(scenario) {
  if (isEmpty(scenario)) return []
  return [{
    id: 1,
    instance_id: instance.id,
    campaign_id: campaign.campaign_id,
    profile_url: 'https://example.test/fixture-lead',
    direction: 'in',
    body: 'Thanks for reaching out — happy to chat.',
    sent_at: '2026-09-21T12:00:00.000Z',
    sentiment: 'positive',
    reason: null,
    classified_at: null,
    classified_model: null,
    intent_level: 'p2',
    intent_reason: null,
    intent_classified_at: null,
    intent_classified_model: null,
    intent_taxonomy_version: null,
    source: 'fixture',
  }]
}

/* One overdue follow-up on the fixture lead, owned by the admin, so the
 * Follow-ups queue and the Leads "Next follow-up" column render populated. */
function followUpStateRows(scenario) {
  if (isEmpty(scenario)) return []
  return [{
    instance_id: instance.id,
    profile_url: 'https://example.test/fixture-lead',
    next_follow_up_date: '2026-09-20',
    owner_id: 1,
    revision: 1,
    last_event_id: null,
    last_mutation_id: null,
    created_at: '2026-09-19T09:00:00.000Z',
    updated_at: '2026-09-19T09:00:00.000Z',
    updated_by: 'Fixture Admin',
    archived_at: null,
  }]
}

function latestMessageRows(scenario) {
  if (isEmpty(scenario)) return []
  return [{
    instance_id: instance.id,
    profile_url: 'https://example.test/fixture-lead',
    message_id: 1,
    direction: 'in',
    body: 'Thanks for reaching out — happy to chat.',
    sent_at: '2026-09-21T12:00:00.000Z',
    source: 'fixture',
  }]
}

function savedSearchRows(scenario) {
  if (isEmpty(scenario)) return []
  const row = (id, name, platform, extra = {}) => ({
    id, name, platform, description: null, include_keywords: [], exclude_keywords: [], boolean_query: null,
    filters: {}, notes: null, author: 'Fixture Admin', archived: false, hypothesis_id: null,
    created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z', ...extra,
  })
  return [
    row(1, 'Fintech VPs, US, 200–1000', 'Apollo', {
      description: 'Revenue leaders at growth-stage fintechs.',
      include_keywords: ['fintech', 'payments'], exclude_keywords: ['intern'],
      boolean_query: '("VP Sales" OR "Head of Sales") NOT intern', filters: { seniority: ['vp', 'head'], employees: 200 },
    }),
    row(2, 'Operations leaders in logistics and freight forwarding — wave 4 of the long-running outbound programme', 'Sales Navigator', {
      notes: 'Long name on purpose: card titles must wrap.',
    }),
    row(3, 'Retired list', 'Apollo', { archived: true }),
  ]
}

const STAMP = { created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z' }

function strategyRows(scenario) {
  if (isEmpty(scenario)) return { icps: [], icpPersonas: [], icpIndustries: [], hypotheses: [], hypothesisCampaigns: [] }
  return {
    icps: [{
      id: 1, name: 'Growth-stage fintech', airtable_url: null, main_product: 'Payments API', core_sphere: 'Fintech',
      secondary_sphere: 'B2B SaaS', product_stage: 'Scale-up', monetization: 'Usage-based', features_note: null,
      purchase_triggers: ['New funding round'], features: ['Instant payouts'], company_countries: ['US', 'DE'],
      company_headcount: '200–1000', company_age: '3–8 years', apollo_industries: ['Financial Services'], funding: 'Series B+',
      dev_team_availability: null, dev_team_location: null, exclude_keywords: ['crypto'], archived: false, ...STAMP,
    }],
    icpPersonas: [{
      id: 1, icp_id: 1, kind: 'Head of Revenue', job_titles: ['VP Sales', 'CRO'], age_range: null, location: 'US',
      background: null, profile_status: null, connections_note: null, followers_note: null, sort: 0, ...STAMP,
    }],
    icpIndustries: [{ id: 1, icp_id: 1, name: 'Payments', include_keywords: ['payments', 'acquiring'], ...STAMP }],
    hypotheses: [
      { id: 1, name: 'Founders respond to payout-speed pain', icp_id: 1, description: 'Lead with instant payouts.', archived: false, ...STAMP },
      { id: 2, name: 'Unassigned idea', icp_id: null, description: null, archived: false, ...STAMP },
    ],
    hypothesisCampaigns: [{ hypothesis_id: 1, campaign_id: campaign.campaign_id, created_at: STAMP.created_at }],
  }
}

function snapshot(scenario) {
  return {
    instances: isEmpty(scenario) ? [] : [instance],
    campaigns: isEmpty(scenario) ? [] : [campaign],
    leads: leadRows(scenario),
    messages: messageRows(scenario),
    pipelineEvents: [],
    conversationReplyIntents: [],
    annotations: [],
    steps: [],
    syncRuns: [],
    followUpStates: followUpStateRows(scenario),
    latestConversationMessages: latestMessageRows(scenario),
    followUpsAvailable: true,
    savedSearches: savedSearchRows(scenario),
    ...strategyRows(scenario),
    campaignSequenceContext: null,
  }
}

function inRange(timestamp, search) {
  if (!timestamp) return false
  const from = search.get('from')
  const to = search.get('to')
  const day = timestamp.slice(0, 10)
  return (!from || day >= from) && (!to || day <= to)
}

function overviewCohort(scenario, search) {
  const leads = leadRows(scenario)
  const invited = leads.filter((lead) => inRange(lead.invited_at, search))
  return {
    leads: invited.length,
    invited: invited.length,
    connected: invited.filter((lead) => lead.connected_at).length,
    messaged: invited.filter((lead) => lead.connected_at && lead.first_message_at).length,
    replied: invited.filter((lead) => lead.connected_at && lead.replied_at).length,
  }
}

function overviewSystemTotals(scenario, search) {
  const cohort = overviewCohort(scenario, search)
  return {
    leads: leadRows(scenario).filter((lead) => inRange(lead.added_at, search)).length,
    invited: cohort.invited,
    connected: cohort.connected,
    messaged: cohort.messaged,
    replied: cohort.replied,
  }
}

function eventTotals(scenario, search) {
  const leads = leadRows(scenario)
  const count = (field) => leads.filter((lead) => inRange(lead[field], search)).length
  return { invited: count('invited_at'), connected: count('connected_at'), replied: count('replied_at') }
}

function analyticsTotals(scenario, search) {
  const leads = leadRows(scenario)
  const count = (field) => leads.filter((lead) => inRange(lead[field], search)).length
  return {
    leads: count('added_at'), invited: count('invited_at'), connected: count('connected_at'),
    messaged: count('first_message_at'), replied: count('replied_at'),
    acceptedOfInvited: leads.filter((lead) => lead.invited_at && inRange(lead.connected_at, search)).length,
    repliedOfConnected: leads.filter((lead) => lead.connected_at && inRange(lead.replied_at, search)).length,
  }
}

export async function setFixtureScenario(next) {
  const allowed = new Set(['populated-admin', 'populated-member', 'empty-admin', 'empty-member', 'error', 'read-error'])
  if (!allowed.has(next)) return false
  await writeFile(process.env.UI_FIXTURE_STATE_FILE, `${next}\n`)
  return true
}

export async function getFixtureScenario() {
  return currentScenario()
}

export async function identityFixture(request) {
  const scenario = await currentScenario()
  const op = new URL(request.url).searchParams.get('op')
  if (request.method !== 'GET') return mutationRefusal()
  if (scenario === 'error') return json({ error: 'Fixture auth failure' }, 503)
  if (op === 'session.current') {
    const role = activeRole(scenario)
    return json({ subject: ACTOR_IDS[role], provider: 'fixture', actor: { actorId: ACTOR_IDS[role], role } })
  }
  if (op === 'team.roster') {
    const role = activeRole(scenario)
    return json({ members: [member(role)], hasMore: false })
  }
  if (op === 'session.signOut' || op === 'session.signIn') return mutationRefusal()
  return json({ error: 'Local fixture operation is unsupported', operation: op }, 501)
}

export async function activityFixture(request) {
  const scenario = await currentScenario()
  const url = new URL(request.url)
  const op = url.searchParams.get('op')
  if (request.method !== 'GET') return mutationRefusal()
  if (op === 'config.readPath') return json({ readPath: 'neon', photoPath: 'disabled' })
  if (scenario === 'error' || scenario === 'read-error') return json({ error: 'Fixture read failure', operation: op }, 503)
  if (!op) return json({ error: 'Missing fixture operation' }, 400)
  const role = activeRole(scenario)
  if (op === 'dashboard.bootstrap') {
    return json(page([{ rosterPath: 'neon', instances: isEmpty(scenario) ? [] : [instance], campaigns: isEmpty(scenario) ? [] : [campaign], teamMembers: [teamMember(role)] }]))
  }
  if (op === 'dashboard.routeSnapshot') return json(page([snapshot(scenario)]))
  if (op === 'overview.systemTotals') return json(page([{ totals: overviewSystemTotals(scenario, url.searchParams) }]))
  if (op === 'overview.performance') {
    const current = eventTotals(scenario, url.searchParams)
    const cohort = overviewCohort(scenario, url.searchParams)
    const lifetime = overviewCohort(scenario, new URLSearchParams())
    return json(page([{
      current, previous: null, cohort, previousCohort: null, lifetime,
      accounts: isEmpty(scenario) ? [] : [{ instance_id: instance.id, current, previous: null, cohort, previousCohort: null, lifetime }],
      activity: [],
    }]))
  }
  if (op === 'overview.accountCampaigns') {
    const totals = analyticsTotals(scenario, url.searchParams)
    const lifetime = analyticsTotals(scenario, new URLSearchParams())
    const cohort = overviewCohort(scenario, url.searchParams)
    return json(page([{
      accounts: isEmpty(scenario) ? [] : [{ instance_id: instance.id, totals, previous: null, lifetime, cohort, previousCohort: null }],
      campaigns: isEmpty(scenario) ? [] : [{
        ...campaign, leads_added: totals.leads, invites_sent: totals.invited,
        connected: totals.connected, first_messages: totals.messaged,
        accepted: totals.connected, replies: totals.replied,
        acceptance_rate: totals.invited ? 100 * totals.acceptedOfInvited / totals.invited : null,
        reply_rate: totals.connected ? 100 * totals.repliedOfConnected / totals.connected : null,
        lifetime_acceptance_rate: 100, lifetime_reply_rate: 100,
      }],
    }]))
  }
  if (op === 'leads.searchPage') {
    // Keep this first list smoke exact and small. Other filter semantics remain
    // unsupported until a matching synthetic projection is implemented.
    const supported = new Set(['op', 'limit', 'instance_id', 'camp', 'q', 'sort', 'dir', 'today', 'page', 'page_size'])
    if ([...url.searchParams.keys()].some((key) => !supported.has(key))) {
      return json({ error: 'Fixture lead filter is unsupported', operation: op }, 501)
    }
    const query = (url.searchParams.get('q') ?? '').toLowerCase()
    const rows = leadRows(scenario).filter((lead) =>
      (!url.searchParams.get('instance_id') || lead.instance_id === url.searchParams.get('instance_id')) &&
      (!url.searchParams.get('camp') || lead.campaign_id === url.searchParams.get('camp')) &&
      (!query || `${lead.full_name} ${lead.headline} ${lead.company}`.toLowerCase().includes(query)),
    )
    const offset = Math.max(0, Number(url.searchParams.get('page') ?? 0)) * Math.max(1, Number(url.searchParams.get('page_size') ?? 50))
    const size = Math.max(1, Number(url.searchParams.get('page_size') ?? 50))
    const items = rows.slice(offset, offset + size).map((lead) => ({
      lead,
      reply: {
        body: messageRows(scenario)[0].body, sentiment: 'positive', reason: null,
        intent_level: 'p2', intent_reason: null, highest_intent: 'p2',
        sent_at: messageRows(scenario)[0].sent_at,
      },
      highestIntent: 'p2', followUp: null,
    }))
    return json(page([{
      items, total: rows.length, allTotal: leadRows(scenario).length,
      replyCounts: { total: rows.length, c: rows.length ? { positive: rows.length } : {} },
    }]))
  }
  if (op === 'activity.dailySeries') return json(page([]))
  if (op === 'coaching.digests') return json(page([]))
  if (op === 'coach.playbook') {
    return json(page(isEmpty(scenario) ? [] : [{
      content: '# Outreach playbook\n\n## Tone\n\n- Short, specific, no pitch in the first message.\n- Ask one question.\n',
      updated_at: '2026-09-20T09:00:00.000Z',
    }]))
  }
  if (op === 'identity.teamRoster') return json(page([member(role)]))
  return json({ error: 'Local fixture operation is unsupported', operation: op }, 501)
}

export async function fixtureControl(request) {
  const scenario = await currentScenario()
  const url = new URL(request.url)
  const next = url.searchParams.get('scenario')
  if (request.method !== 'GET' || !next) return json({ scenario, allowed: ['populated-admin', 'populated-member', 'empty-admin', 'empty-member', 'error', 'read-error'] })
  if (!(await setFixtureScenario(next))) return json({ error: 'Unknown fixture scenario', scenario }, 400)
  return json({ ok: true, scenario: next })
}

const FIXTURE_COMPANY = { id: 'recFixture0000001', name: 'Fixture Labs', website: 'https://fixture.test', linkedin: '' }

/**
 * CSV import endpoint: metadata, previews and company search are reads and get
 * synthetic answers; both commit actions are writes and are refused, so the
 * browser can walk stages 1–4 without any path to Airtable.
 */
export async function importFixture(request) {
  const scenario = await currentScenario()
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (scenario === 'error' || scenario === 'read-error') return json({ error: 'Fixture import read failure' }, 503)
  const body = await request.json().catch(() => ({}))
  const metadata = { source: 'apollo', mappingVersion: 1, addedBy: ['Fixture Admin'], limits: { maxRows: 500, maxFileBytes: 5000000 } }
  if (body.action === 'contact_metadata' || body.action === 'company_metadata') return json(metadata)
  if (body.action === 'company_search') return json({ companies: [FIXTURE_COMPANY] })
  if (body.action === 'company_preview') {
    const rows = Array.isArray(body.rows) ? body.rows : []
    const results = rows.map((row, index) => index === 0
      ? { rowNumber: row.rowNumber, status: 'company_action', reason: 'name_match', suggestions: [FIXTURE_COMPANY], canCreate: true }
      : { rowNumber: row.rowNumber, status: 'ready', canCreate: true })
    return json({ results, counts: {} })
  }
  if (body.action === 'contact_preview') {
    const rows = Array.isArray(body.rows) ? body.rows : []
    return json({ results: rows.map((row) => ({ rowNumber: row.rowNumber, status: 'ready', company: FIXTURE_COMPANY, matchMethod: 'resolved' })), counts: {} })
  }
  return mutationRefusal()
}

export function mutationRefusal() {
  return json({ error: 'Local fixture is read-only; mutation was refused' }, 403)
}
