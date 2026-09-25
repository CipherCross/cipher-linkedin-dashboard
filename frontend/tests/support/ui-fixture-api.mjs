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
  label: 'Fixture notebook',
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

/* The drawer's thread for the fixture lead: our first message, their reply,
 * and one imported message so the edit/delete controls render. */
/* The preview shows the real fixture lead first, then four synthetic replies so
 * the five-row limit, a long unbroken reply and multi-line copy are all visible. */
function campaignPreview(scenario) {
  const [lead] = leadRows(scenario)
  const extra = [
    ['Jordan Sample', 'Sample Systems', 'Not right now, maybe next quarter.', 'neutral', null],
    ['Casey Example', 'Example Group', 'Could you send more detail on pricing and how onboarding works for a 40-person sales team?\nWe are evaluating two other vendors this month.', 'positive', 'p3'],
    ['Riley Demo', 'Demo & Co', 'Please remove me from your list.', 'negative', null],
    ['Morgan Placeholder', 'Placeholder Inc', 'Sure — here is our deck: https://example.test/a-very-long-unbroken-link-that-should-wrap-inside-the-dialog-instead-of-widening-it', 'positive', 'p2'],
  ].map(([name, company, body, sentiment, intent], i) => ({
    lead: { ...lead, id: `fixture-preview-lead-${i}`, full_name: name, company, profile_url: `https://example.test/preview-${i}` },
    reply: { body, sent_at: `2026-09-2${Math.max(0, 1 - i) || 0}T0${8 - i}:15:00.000Z`, sentiment, reason: null },
    highestIntent: intent,
  }))
  return {
    campaign: { campaign_id: campaign.campaign_id, campaign_name: campaign.campaign_name, instance_id: instance.id },
    leads: [
      { lead, reply: { body: 'Thanks for reaching out — happy to chat.', sent_at: '2026-09-21T12:00:00.000Z', sentiment: 'positive', reason: null }, highestIntent: 'p2' },
      ...extra,
    ],
    steps: [
      { step_index: 0, step_label: 'Invite', step_type: 'InvitePerson', template_body: 'Hi {firstName} — saw your work at {companyName}. Would love to connect.' },
      { step_index: 2, step_label: 'Message', step_type: 'MessageToPerson', template_body: 'Thanks for connecting, {firstName}.\n\nQuick question: how does your team run follow-ups today?' },
      { step_index: 4, step_label: 'Message', step_type: 'MessageToPerson', template_body: 'Following up — worth a 15-minute call next week?' },
    ],
  }
}

function threadRows(scenario) {
  if (isEmpty(scenario)) return []
  const base = { sentiment: null, reason: null, classified_model: null, intent_level: null, intent_reason: null, intent_classified_model: null }
  return [
    { ...base, id: 11, direction: 'out', body: 'Hi Alex — saw Fixture Labs is hiring for payouts. Worth a quick chat?', sent_at: '2026-09-20T11:00:00.000Z', source: 'fixture' },
    { ...base, id: 1, direction: 'in', body: 'Thanks for reaching out — happy to chat.', sent_at: '2026-09-21T12:00:00.000Z', source: 'fixture', sentiment: 'positive', intent_level: 'p2' },
    { ...base, id: 12, direction: 'out', body: 'Great — does Tuesday 10:00 work?', sent_at: '2026-09-21T12:30:00.000Z', source: 'manual' },
  ]
}

/* Manual review is switched on for the fixture tenant, with one conversation
 * in the queue: the fixture lead's positive reply, not yet reviewed. Saving a
 * review is a write and is refused by the pipeline endpoint like every other. */
function replyCapabilities(role) {
  return {
    available: true, active: true, manual_ready: true, mode: 'manual',
    members: [{ id: role === 'admin' ? 1 : 2, name: role === 'admin' ? 'Fixture Admin' : 'Fixture Member', active: true }],
    instances: [{ id: instance.id, label: instance.account_name || instance.label }],
    campaigns: [{ id: campaign.campaign_id, name: campaign.campaign_name, instance_id: instance.id }],
  }
}

function replyInboxRows(scenario, search) {
  if (isEmpty(scenario)) return []
  const query = (search.get('query') ?? '').toLowerCase()
  if (query && !'alex fixture'.includes(query)) return []
  return [{
    instance_id: instance.id, profile_url: 'https://example.test/fixture-lead',
    name: 'Alex Fixture', company: 'Fixture Labs', headline: 'Product leader', campaign_id: campaign.campaign_id,
    latest_snippet: 'Thanks for reaching out — happy to chat.', latest_direction: 'in',
    latest_sent_at: '2026-09-21T12:00:00.000Z', selected_message_id: 1, pending_count: 1,
    owner_id: null, action: null, next_follow_up_date: null, do_not_contact: false,
    review_revision: 0, workflow_revision: 0, revision: 0, inbound_revision: 1, acknowledged_inbound_revision: 0,
  }]
}

function replyThreadRows(scenario) {
  return threadRows(scenario).map((message) => ({
    id: message.id, instance_id: instance.id, profile_url: 'https://example.test/fixture-lead',
    campaign_id: campaign.campaign_id, direction: message.direction, body: message.body,
    sent_at: message.sent_at, source: message.source, review: null,
  }))
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

/* Sentiment analysis (op=replies.analytics): every message in the fixture is
 * the one positive, reviewed reply, so the page renders its populated path —
 * metrics, the weekly trend and the account/campaign comparison all non-zero —
 * on `populated-*` scenarios, and its `!hasDialogues` empty state on
 * `empty-*` ones. Real accuracy against `filters.from`/`to` is not the point;
 * this only has to satisfy `parseAnalytics`'s shape. */
function repliesAnalytics(scenario) {
  const messages = messageRows(scenario)
  const total = messages.length
  const positive = messages.filter((m) => m.sentiment === 'positive').length
  const met = (numerator, denominator = total) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null })
  const zero = met(0, total)
  return {
    coverage: {
      dialogues: met(total), messages: met(total), full_dialogues: met(total),
      unreviewed_dialogues: zero, latest_unreviewed: zero, only_auto: zero,
      weekly_volume: met(total), unreviewed_intent: zero, legacy_ai: zero,
    },
    sentiment: {
      positive: met(positive), neutral: zero, negative: zero, objection: zero, referral: zero, auto: zero,
      business_rate: zero,
    },
    reasons: {},
    weekly_trend: total === 0 ? [] : [{
      week: messages[0].sent_at.slice(0, 10),
      messages: total,
      reviewed: total,
      coverage: met(total),
      volume: met(total),
      sentiment: { positive, neutral: 0, negative: 0, objection: 0, referral: 0, auto: 0 },
    }],
    workflow: { needs_confirmation: zero, resolved: met(positive) },
    comparison: isEmpty(scenario) ? [] : [
      { kind: 'account', id: instance.id, name: instance.label, volume: total, coverage: met(total), neg_objection: zero },
      { kind: 'campaign', id: campaign.campaign_id, name: campaign.campaign_name, volume: total, coverage: met(total), neg_objection: zero },
    ],
    dataset_at: '2026-09-22T08:00:00.000Z',
  }
}

const deployment = (over = {}) => ({
  key: 'fixture-deployment-1', lineage: 'publish', campaign_id: campaign.campaign_id,
  campaign_name: campaign.campaign_name, campaign_status: 'active', runtime_status: 'running',
  is_archived: false, status_observed_at: campaign.status_observed_at, status_source: 'fixture',
  status_raw: 'running', instance_id: instance.id, account_name: instance.account_name,
  account_avatar: null, last_sync_at: instance.last_sync_at, sequence_revision: 3, branch_id: null,
  branch_letter: null, publish_status: 'success', awaiting_sync: false, leads: 1, replies: 1, p3: 0,
  latest_reply: null, ...over,
})

function sequenceHub(scenario) {
  if (isEmpty(scenario)) return { items: [], newestReplies: [] }
  const item = (over) => ({
    revision: null, archived: false, branch_count: 0, updated_at: STAMP.updated_at,
    deployment_count: 1, account_count: 1, leads: 1, replies: 1, p3: 0, latest_reply: null, ...over,
  })
  return {
    items: [
      item({
        id: 'managed:fixture-sequence', kind: 'managed', source: 'builder',
        sequence_document_id: 'fixture-sequence', name: 'Fixture founder sequence', revision: 3,
        deployments: [deployment(), deployment({
          key: 'fixture-deployment-2', campaign_id: null, campaign_name: 'Fixture follow-up wave',
          runtime_status: 'paused', status_raw: 'paused', publish_status: 'publishing', awaiting_sync: true, leads: 0, replies: 0,
        })],
        deployment_count: 2,
      }),
      item({
        id: 'external:fixture-lh', kind: 'external', source: 'linked_helper', sequence_document_id: null,
        name: 'Hand-built Linked Helper flow',
        deployments: [deployment({
          key: 'fixture-deployment-3', lineage: 'external', campaign_id: null, campaign_name: 'Old manual campaign',
          runtime_status: 'completed', status_raw: 'completed', is_archived: null, publish_status: null, leads: 4, replies: 0,
        })],
      }),
    ],
    newestReplies: [],
  }
}

function sequenceRecords(scenario) {
  if (isEmpty(scenario)) return []
  const document = {
    version: 1,
    steps: [
      { id: 'step-connection', kind: 'connection', variations: [{ id: 'v1', label: 'Variation 1', text: 'Hi {firstName} — saw your work at {companyName}.' }] },
      { id: 'step-1', kind: 'message', variations: [{ id: 'v2', label: 'Variation 1', text: 'Thanks for connecting. One question about your outreach.' }, { id: 'v3', label: 'Variation 2', text: 'Quick one: how do you run follow-ups today?' }] },
      { id: 'step-2', kind: 'message', variations: [{ id: 'v4', label: 'Variation 1', text: 'Following up, {firstName} — worth a 15-minute call?' }] },
    ],
    branches: [
      { id: 'branch-a', name: 'A', selections: { 'step-connection': 'v1', 'step-1': 'v2', 'step-2': 'v4' } },
      { id: 'branch-b', name: 'B', selections: { 'step-connection': 'v1', 'step-1': 'v3', 'step-2': 'v4' } },
    ],
    sampleData: { firstName: 'Alex', companyName: 'Northstar Labs', jobTitle: 'VP of Product', senderName: 'You' },
  }
  const base = {
    document, created_by: 'fixture-member', created_by_name: 'Fixture Admin', updated_by: 'fixture-member',
    updated_by_name: 'Fixture Admin', ...STAMP,
  }
  return [
    { ...base, id: 'fixture-sequence', name: 'Fixture founder sequence', revision: 3, archived: false },
    { ...base, id: 'fixture-sequence-old', name: 'Retired intro test', revision: 1, archived: true },
  ]
}

/** `/api/playbook` is the Sequence Builder's POST endpoint. Listing is a read,
 *  so the fixture answers it; every other action is still refused. */
export async function playbookFixture(request) {
  const scenario = await currentScenario()
  let action = null
  try { action = (await request.clone().json())?.action ?? null } catch { /* not JSON */ }
  if (request.method === 'POST' && action === 'list_sequences') {
    if (scenario === 'error' || scenario === 'read-error') return json({ error: 'Fixture read failure' }, 503)
    return json({ sequences: sequenceRecords(scenario) })
  }
  if (request.method === 'POST' && READ_ACTIONS.has(action)) {
    if (scenario === 'error' || scenario === 'read-error') return json({ error: 'Fixture read failure' }, 503)
    if (action === 'get_sequence') {
      let id = null
      try { id = (await request.clone().json())?.id ?? null } catch { /* not JSON */ }
      const detail = sequenceDetail(scenario, id)
      return detail ? json(detail) : json({ error: 'Sequence not found' }, 404)
    }
    if (action === 'list_sequence_publish_targets') return json({ targets: isEmpty(scenario) ? [] : publishTargets() })
    return json({ jobs: [] })
  }
  return mutationRefusal()
}

/* Reads the editor makes on open and in the publish wizard. Save, comment and
 * publish stay refused, so the editor's error branches are what render. */
const READ_ACTIONS = new Set(['get_sequence', 'list_sequence_publish_targets', 'list_sequence_publish_jobs'])

function sequenceDetail(scenario, id) {
  const sequence = sequenceRecords(scenario).find((record) => record.id === id)
  if (!sequence) return null
  const version = (revision, name) => ({
    id: revision, sequence_id: sequence.id, revision, name, document: sequence.document,
    saved_by: 'fixture-member', saved_by_name: 'Fixture Admin', saved_at: STAMP.updated_at,
  })
  const thread = (id, extra) => ({
    id, sequence_id: sequence.id, created_by: 'fixture-member', created_by_name: 'Fixture Admin',
    resolved_at: null, resolved_by: null, resolved_by_name: null, ...STAMP, ...extra,
  })
  const message = (id, body) => ({ id, author_id: 'fixture-member', author_name: 'Fixture Admin', body, created_at: STAMP.updated_at })
  return {
    sequence,
    versions: [version(sequence.revision, sequence.name), version(sequence.revision - 1, `${sequence.name} (draft)`)],
    comments: [
      thread('fixture-thread-1', {
        step_id: 'step-1', variation_id: 'v2', anchor: { start: 0, end: 20, quote: 'Thanks for connecting' },
        messages: [message(1, 'Open with something specific to them instead.')],
      }),
      thread('fixture-thread-2', {
        step_id: null, variation_id: null, anchor: null,
        resolved_at: STAMP.updated_at, resolved_by: 'fixture-member', resolved_by_name: 'Fixture Admin',
        messages: [message(2, 'Three steps is the right length.')],
      }),
    ],
  }
}

function publishTargets() {
  const target = (instance, machine, compatible, extra = {}) => ({
    instance_id: instance, machine_key: machine,
    account_snapshot: compatible ? {
      account_id: `${instance}-account`, account_name: 'Fixture Sender', sender_name: 'Fixture Sender',
      workspace_id: 'fixture-workspace', lh_version: '5.14', compatibility_profile: 'linked-helper-v1',
    } : {},
    capability_snapshot: {}, compatible, compatibility_error_code: compatible ? null : 'version_not_supported',
    probed_at: STAMP.updated_at, measured_lh_version: '5.14', compatibility_state: compatible ? 'approved' : 'rejected',
    ...extra,
  })
  return [target('notebook-1', 'fixture-notebook-1', true), target('notebook-2', 'fixture-notebook-2', false)]
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
  // Neon Activity's daily series is the one read with no `op`: it is keyed by instance.
  if (!op && url.searchParams.get('instance_id')) {
    const instanceId = url.searchParams.get('instance_id')
    const activity = isEmpty(scenario) ? [] : [
      { day: '2026-09-20', instance_id: instanceId, event_type: 'invite', cnt: 12 },
      { day: '2026-09-20', instance_id: instanceId, event_type: 'reply', cnt: 2 },
      { day: '2026-09-21', instance_id: instanceId, event_type: 'invite', cnt: 9 },
    ]
    return json({ activity, nextCursor: null, hasMore: false })
  }
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
  if (op === 'campaign.preview') {
    if (url.searchParams.get('campaign_id') !== campaign.campaign_id || isEmpty(scenario)) return json(page([{ campaign: null, leads: [], steps: [] }]))
    return json(page([campaignPreview(scenario)]))
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
  if (op === 'sequences.hub') return json(page([sequenceHub(scenario)]))
  if (op === 'replies.analytics') return json(page([repliesAnalytics(scenario)]))
  if (op === 'coaching.digests') return json(page([]))
  if (op === 'coach.playbook') {
    return json(page(isEmpty(scenario) ? [] : [{
      content: '# Outreach playbook\n\n## Tone\n\n- Short, specific, no pitch in the first message.\n- Ask one question.\n',
      updated_at: '2026-09-20T09:00:00.000Z',
    }]))
  }
  if (op === 'identity.teamRoster') return json(page([member(role)]))
  if (op === 'messages.thread') return json(page(threadRows(scenario)))
  if (op === 'conversations.followUpHistory') return json(page([]))
  if (op === 'conversations.followUpState') {
    // The drawer's one-conversation read (Leads carries no follow-up data).
    const instanceId = url.searchParams.get('instance_id')
    const profileUrl = url.searchParams.get('profile_url')
    return json(page(followUpStateRows(scenario).filter((row) =>
      !instanceId || (row.instance_id === instanceId && row.profile_url === profileUrl))))
  }
  if (op === 'replies.capabilities') return json(replyCapabilities(role))
  if (op === 'replies.inbox') return json({ items: replyInboxRows(scenario, url.searchParams), next_cursor: null })
  if (op === 'replies.facets') return json({ facets: {} })
  if (op === 'replies.thread') {
    // Production answers 404 for a conversation with no messages at all.
    if (url.searchParams.get('profile_url') && url.searchParams.get('profile_url') !== 'https://example.test/fixture-lead') {
      return json({ error: 'The requested thread was not found', code: 'REPLY_REVIEW_NOT_FOUND' }, 404)
    }
    return json({ messages: replyThreadRows(scenario), older_cursor: null, newer_cursor: null, inbound_revision: 1, workflow: null, next_focus_message_id: null })
  }
  if (op === 'replies.reviewHistory') return json({ items: [], next_cursor: null })
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
