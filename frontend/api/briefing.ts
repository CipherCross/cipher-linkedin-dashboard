// Morning Briefing. The chat copilot (/api/chat) runs a deep autonomous SQL
// investigation over the whole pipeline — but only when someone asks. This wraps
// that SAME agentic loop (same `tools`, SCHEMA_DOC, executeSql) in a scheduled job
// that investigates on its own each morning, then stores one row/day and pushes
// it to Slack. The Overview card reads the latest row.
//
// Accuracy matters (the sales team ACTS on this), so it's a 3-stage ensemble:
//   1. INVESTIGATE — two Opus passes in parallel, risk-first and growth-first,
//      each diffing today's data against the previous briefing.
//   2. VERIFY+MERGE — a third Opus re-runs the queries behind every claim, fuses
//      the two angles into one, reconciles rates, and enforces novelty vs yesterday.
//   3. STRUCTURE — coerce the verified narrative into the stored/Slack schema.
//
// Triggers:
//   GET  — the daily Vercel cron at 07:00 UTC (guarded by CRON_SECRET), after the
//          06:00 classify cron so the day's replies are already sentiment-labelled.
//   POST — the "Refresh briefing" button on Overview. No secret: self-limiting
//          (idempotent upsert on briefing_date, one cheap call/day).
import { generateObject, generateText, stepCountIs } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import {
  ACCEPT_LAG_SQL,
  CAMPAIGN_OVERVIEW_SQL,
  INVITE_QUEUE_SQL,
  SCHEMA_DOC,
  WEEKLY_FUNNEL_SQL,
  db,
  executeSql,
} from './_lib/core.js'
import { tools } from './_lib/tools.js'
import { postBriefingToSlack } from './_lib/slack.js'
import { computeAnomalySignals, renderSignals } from './_lib/anomalies.js'

export const maxDuration = 300

const INVESTIGATE_MODEL = 'claude-opus-4-8' // deep autonomous investigation
const VERIFY_MODEL = 'claude-opus-4-8' // adversarial fact-check + merge pass
const STRUCTURE_MODEL = 'claude-opus-4-8' // coerce the narrative into a schema (Opus: don't lose nuance)
// Stored on the row so the model column reflects the whole ensemble, not just stage 1
// — collapses to one name today since all three stages match, but stays accurate if
// they ever diverge.
const ENSEMBLE_MODEL_LABEL = Array.from(
  new Set([INVESTIGATE_MODEL, VERIFY_MODEL, STRUCTURE_MODEL])
).join(' + ')

// Two independent investigation angles run in parallel, then the verifier merges
// the strongest data-backed points from each. Diverse lenses surface risks AND
// opportunities one pass would under-explore.
const ANGLES: { label: string; lens: string }[] = [
  {
    label: 'risk-first',
    lens:
      `INVESTIGATE WITH A RISK-FIRST LENS: hunt for what is AT RISK or DECLINING — accounts near LinkedIn's ` +
      `invite safe-zone, falling acceptance/reply rates, stale or failed syncs, stalled cohorts, ` +
      `negative-sentiment clusters. Lead with the most serious problems.`,
  },
  {
    label: 'growth-first',
    lens:
      `INVESTIGATE WITH A GROWTH-FIRST LENS: hunt for what is WORKING and where to LEAN IN — accounts and ` +
      `campaigns with rising acceptance/reply rates, strong P2/P3 intent, headroom under the invite ` +
      `limit, message steps that outperform. Lead with the biggest opportunities.`,
  },
]

// How stale the previous briefing may be and still be worth diffing against.
// Beyond this (or with none at all) we skip continuity and just write today's.
const MAX_PRIOR_AGE_DAYS = 7

// Lightweight grounding queries run before the model investigates, so the briefing
// is anchored in current numbers even if it under-explores. Failures are skipped.
const SEED_QUERIES: { label: string; sql: string }[] = [
  { label: 'Per-campaign funnel (campaign_overview)', sql: CAMPAIGN_OVERVIEW_SQL },
  {
    label:
      'Invite queue per campaign — leads awaiting an invite. 0 recent invites with a NON-EMPTY queue ' +
      '= the batch is still in multi-day warm-up (invites expected), NOT a stopped campaign; an EMPTY ' +
      'queue = the campaign needs NEW leads, not "reactivation". Ignore rows with has_invite_step=false',
    sql: INVITE_QUEUE_SQL,
  },
  { label: 'Weekly invite cohorts (weekly_funnel)', sql: WEEKLY_FUNNEL_SQL },
  {
    label: 'Invite → accept lag (days, last 90d) — cohort maturity floor, NOT a metric to report',
    sql: ACCEPT_LAG_SQL,
  },
  {
    label: 'Recent sync runs (freshness / failures)',
    sql: `select coalesce(i.account_name, i.label, s.instance_id) as account, s.instance_id,
                 s.status, s.started_at, s.finished_at, s.rows_upserted, s.error
          from sync_runs s join instances i on i.id = s.instance_id
          order by s.started_at desc limit 20`,
  },
  {
    label: 'Inbound replies in the last 24h by sentiment',
    sql: `select coalesce(sentiment, 'unclassified') as sentiment, count(*) as cnt
          from messages
          where direction = 'in' and sent_at > now() - interval '24 hours'
          group by 1 order by 2 desc`,
  },
  {
    label: 'Invites sent per account in the last 7 days (limit risk)',
    sql: `select coalesce(i.account_name, i.label, l.instance_id) as account, l.instance_id,
                 count(*) as invites_7d
          from leads l join instances i on i.id = l.instance_id
          where l.invited_at > now() - interval '7 days'
          group by 1, 2 order by 3 desc`,
  },
  {
    label: 'Reply quality in the last 14 days by account (volume + sentiment)',
    sql: `select coalesce(i.account_name, i.label, m.instance_id) as account,
                 m.sentiment, count(*) as replies
          from messages m join instances i on i.id = m.instance_id
          where m.direction = 'in' and m.sent_at > now() - interval '14 days'
          group by 1, 2 order by 3 desc`,
  },
  {
    label: 'Commercial reply intent in the last 14 days by account (P1/P2/P3)',
    sql: `select coalesce(i.account_name, i.label, m.instance_id) as account,
                 coalesce(m.intent_level, 'none') as intent_level, count(*) as replies
          from messages m join instances i on i.id = m.instance_id
          where m.direction = 'in' and m.sent_at > now() - interval '14 days'
            and m.intent_taxonomy_version = 'p123-v1'
          group by 1, 2 order by 3 desc`,
  },
]

const BRIEFING_SYSTEM = `You are the morning analyst for a LinkedIn outreach team. You have read-only SQL
access to the team's Supabase Postgres database through tools, and you produce ONE concise daily
briefing the team reads with their coffee. The accounts ("instances") are real LinkedIn accounts; each
runs campaigns through Linked Helper 2.

${SCHEMA_DOC}

HOW TO WORK
- You are given seed query results below as a starting point. Treat the briefing as a GOAL: keep
  calling tools to investigate anything notable until you can write it confidently. A good briefing
  takes 5-15 targeted queries. Do not stop after the seed data.
- You are also given ANOMALY SIGNALS: deterministically computed (not model-judged) sustained
  multi-day trends, stalls, and cohort reply-rate declines. Treat these as pre-verified leads —
  investigate and prioritize them. A risk or change claiming a decline, rise, or stall should
  correspond to one of these signals or be confirmed by a fresh query; don't invent a trend from a
  single data point the signals don't support. An empty signals list doesn't mean nothing moved —
  it means nothing SUSTAINED moved; smaller or single-day observations can still come from your own
  investigation.
- Investigate what CHANGED and what's AT RISK: acceptance/reply-rate moves vs prior weeks (segment by
  account, campaign, and message step), accounts approaching LinkedIn's ~100-200 invites/week safe
  zone, stale or failed syncs (check instances.last_sync_at and sync_runs), and stalled cohorts.
- Replies LAG invites, and so does ACCEPTANCE — someone invited today typically connects 2-7 days later,
  slower still during holidays / low-activity stretches (e.g. summer). Never compare raw
  invites-this-week vs replies-this-week; reason in cohorts. The seed data includes the actual observed
  invite→accept lag (median/p90, last 90d) — a cohort younger than that p90 has not had the CHANCE to
  convert yet. NEVER cite the acceptance or reply rate of such a cohort as a decline, a weak
  campaign/channel, or "volume flowing somewhere bad" — that reads as a real problem to the team when
  it's actually just an immature cohort. Either omit its rate or say plainly it's too early to judge; a
  fresh cohort's VOLUME is fine to report, its RATE is not, until it clears the lag window.
- You CANNOT see whether a campaign (or Linked Helper itself) is RUNNING or PAUSED — that runtime state
  is not synced, and campaigns.status is a raw unreliable LH2 code. NEVER write that a campaign is
  paused/stopped/dead ("на паузі", "зупинена", "стоїть") and NEVER tell the team to resume/reactivate
  one. When invites sit at 0 for days, read the invite-queue seed instead of guessing a cause:
  leads_awaiting_invite / in_pre_invite_warmup > 0 means the batch is progressing through the multi-day
  warm-up delays that precede InvitePerson — several zero-invite days are NORMAL there, so say invites
  should resume as warm-up completes and report the queued volume. An EMPTY queue means the campaign has
  run out of people to invite — the finding is "черга порожня" and the action is "додайте нових лідів у
  <campaign>", never "відновіть кампанію".
- DO NOT judge follow-up status from message threads. The LH2 agent CANNOT see outbound messages the
  SDR types by hand after a lead replies — those enter the DB only via "Import history"
  (messages.source='manual'). So a thread that looks "unanswered" (an inbound reply with no later
  outbound) usually isn't; it just hasn't been re-imported. This is STRUCTURAL, not a sync-freshness
  issue — last_sync_at being minutes old does not close the gap. NEVER claim conversations are awaiting
  our reply or going cold, NEVER count "N hot replies waiting", NEVER say warm/positive replies aren't
  being followed up, and NEVER turn response latency into an action or risk. If you must probe a
  post-reply drop-off, split those threads by source, e.g. select profile_url, count(*) filter (where
  source='manual') as manual_n, count(*) filter (where source='sync') as sync_n from messages group by
  profile_url: a "no follow-up" set that is sync-only (manual_n=0) vs a "followed-up" set that is
  manually imported confirms a data-completeness artifact — then the only correct action is "manually
  import these threads", never "the SDR is dropping leads". Otherwise use messages for reply VOLUME,
  SENTIMENT, and P1/P2/P3 INTENT, never for who-replied-last.
  EXCEPTIONS — there are exactly two sanctioned chronology-backed silence signals:
  (1) P3 ghosting: first P3 exists, a RECORDED outbound follows it, no later call_booked exists,
  and no subsequent inbound arrives for 30+ days. This may be called "P3 ghosted".
  (2) the pipeline stage 'following_up':
  auto-advance only moves a lead there when a RECORDED follow-up went unanswered 14+ days, so its counts
  are deterministic pipeline data, not thread judgment. You MAY report following_up counts/aging from
  pipeline_metrics / pipeline_events (e.g. "N лідів у Following Up понад X днів — варто повторно
  звернутись"). You still may NOT derive your own going-cold / awaiting-our-reply claims from message
  threads outside those exact rules.
- Ground every number in real query results; never guess. Be honest about small samples and stale data.
- RECONCILE rates before you cite them: a daily pace and a weekly/period total must be arithmetically
  consistent (a "~65/day" claim cannot sit next to "261 in the week", which is ~37/day). State the time
  window each figure is based on, and if recent days differ from the period average, say so explicitly
  rather than quoting two numbers that contradict each other.

CONTINUITY (day-over-day) — this is what makes the briefing worth reading every morning
- You may be given the PREVIOUS briefing after the seed data. When it's there, your job is to report what
  CHANGED since then, not to rewrite it. Investigate each prior risk and action with SQL and decide whether
  the underlying situation RESOLVED, PROGRESSED, or still PERSISTS — judging ONLY from the data.
- Produce a short CHANGES list (≤4 lines): the day-over-day deltas that actually matter — a rate that moved,
  a prior risk that cleared, a new development, an action whose situation now looks better or worse. One
  line each, tagged with a trend: up (improved), down (worsened), flat (unchanged / still open), new (new
  since the previous briefing), resolved (a prior risk or issue no longer present).
- INFER progress ONLY from observable metric changes. You CANNOT see what the team actually did, and Linked
  Helper syncs on a lag — so NEVER write that the team "did", "completed" or "fixed" an action. Say what the
  NUMBERS now show ("acceptance піднялась до 31%"), never who did what.
- NOVELTY: do not restate standing facts that are unchanged from the previous briefing — in CHANGES or
  anywhere else. If nothing material moved, keep CHANGES short or empty rather than padding it. If there is
  no previous briefing, leave CHANGES empty.

THE BRIEFING (write it as your final message, in markdown)
- A one-line HEADLINE (one tight clause, ~max 120 chars) capturing the single most important thing.
- A SUMMARY of 2-3 short sentences. Lead with the single most important fact; don't recap everything.
- CHANGES (only when a previous briefing is provided): up to 4 one-line day-over-day deltas, each tagged
  up/down/flat/new/resolved. Omit entirely on the first briefing or when nothing material moved.
- At most 2 short SECTIONS (titled), 1-2 sentences each — and only if they add something the summary
  doesn't. Omit sections entirely on a quiet day.
- RISKS: specific at-risk callouts (account near the invite limit, stale/failed sync, rate cliff,
  stalled cohort) — each ONE short line with a severity (low/med/high). Omit if nothing is wrong.
- EXACTLY 3 ACTIONS: the three highest-leverage moves for TODAY, most important first — each ONE
  imperative sentence naming the account/campaign and the numbers that justify it (count + base + %
  where one applies, e.g. «12 відповідей із 240 інвайтів = 5%»).

LANGUAGE
- Write the ENTIRE briefing in UKRAINIAN (українською) — headline, summary, every change, every section,
  every risk and every action. Use natural, concise business Ukrainian, not a word-for-word translation.
- NAME ACCOUNTS BY THEIR LINKEDIN ACCOUNT NAME — that's what the team recognises. Every account-level
  seed row has an "account" column with the name to use; fall back to the label, then the instance id,
  ONLY when no name exists. Never surface a raw instance id like "notebook-3" when a name is available.
- Keep these VERBATIM (do not translate or transliterate): account names, campaign names, agent
  versions, dates, all numbers, and any LinkedIn / Linked Helper product terms. The severity/priority
  codes stay as the literal values high / med / low.

VOICE — write for the WHOLE team, not for analysts
- Plain, everyday Ukrainian that a salesperson (not an analyst) understands at a glance. Short, simple
  sentences. Prefer common words; avoid analytical jargon. If a technical term is truly unavoidable,
  explain it inline in a few plain words the first time (e.g. «когорта» — група лідів, запрошених
  одного тижня).
- Concrete and calm. Favour neutral, precise verbs ("зростає", "сповільнюється", "простоює") over
  slangy or dramatic ones. Inform, don't alarm.
- NO sarcasm, NO jokes, NO snark. Stay respectful and matter-of-fact: describe what an ACCOUNT is
  doing, never blame or mock a person/SDR by name. Frame risks as observations to act on, not as
  failures.

NUMBERS & LENGTH — the team must scan this in ~20 seconds AND trust every claim
- Keep it tight and airy: short sentences, cut every word that isn't carrying weight. Simpler words
  do NOT mean longer text.
- Back EVERY conclusion with the numbers that justify it — show the COUNT, the BASE it is out of, and
  the PERCENTAGE where one applies, e.g. «12 відповідей із 240 інвайтів = 5%». Up to ~3 numbers per
  claim; use only as many as the point needs — don't stack five figures into one sentence.
- State the time window behind each figure, and keep a daily pace and a weekly/period total
  arithmetically consistent (a "~65/день" claim can't sit next to "261 за тиждень", ~37/день).
- No repetition: if a point is in an action, don't re-explain it in the summary or risks. A risk an
  action already handles gets one bare line, not the fix again.

Today's date: ${new Date().toISOString().slice(0, 10)}.`

// Stage 2's adversarial editor. The sales team ACTS on this briefing, so a second
// model re-checks every claim against the database with the same SQL tools before
// it ships — catching wrong/stale numbers, rate contradictions, immature-cohort
// misreads, repeated standing facts, and framing violations the first pass missed.
const VERIFY_SYSTEM = `You are the editor who fact-checks the morning briefing before it ships to a sales
team that will ACT on it. You have the SAME read-only SQL tools as the analyst. You are given TWO draft
briefings of the same morning — one written RISK-FIRST, one GROWTH-FIRST — plus the seed data and, when one
exists, the previous day's briefing. Fact-check, MERGE them into ONE, and output the final briefing,
correct and grounded and genuinely NEW.

${SCHEMA_DOC}

VERIFY (use the tools — re-run queries, do NOT trust the drafts' numbers)
- MERGE the two drafts into a single coherent briefing: take the best-supported risk from the risk-first
  draft and the best-supported opportunity from the growth-first draft, reconcile points they both make,
  and drop the weaker or duplicated ones. The result is ONE briefing, never two concatenated.
- Check EVERY figure in the draft against the database. Re-run the query behind it; if a number is wrong,
  stale, or unsupported, fix it or cut it. A confidently wrong number is worse than an omitted one.
- RECONCILE rates: a daily pace and a weekly/period total must be arithmetically consistent (a "~65/day"
  claim cannot sit next to "261 in the week", ~37/day). Fix any two numbers that contradict each other and
  state the time window behind each.
- COHORTS: replies AND acceptance LAG invites (acceptance typically 2-7 days, longer around holidays / slow
  periods) — check the seed data's invite→accept lag (median/p90, last 90d) for the currently observed
  window. Confirm every acceptance/reply-rate claim is built from invite-week cohorts old enough to have
  cleared that p90, and that a "down vs last week" is a real decline, not a recent cohort still maturing.
  CUT or soften ANY claim — including the headline — that cites the raw acceptance/reply rate of a cohort
  still inside the lag window as if it were a problem; a low rate there is expected, not a signal. Its
  volume can still be reported, just not its rate.
- SIGNALS: cross-check every risk or change claiming a trend, decline, rise, or stall against the provided
  ANOMALY SIGNALS block (deterministic, not model-judged). If a claim isn't backed by a signal and can't be
  confirmed with a fresh query, cut it or soften it to what the data actually shows.
- NOVELTY: diff against the previous briefing. Cut anything that merely restates an unchanged standing fact.
  Every CHANGES line must be a real, data-backed day-over-day delta with the right trend; drop or fix any
  that isn't, and make sure a material change the analyst missed gets added.
- RUNTIME STATE: LH2's running/paused state is not synced and cannot be observed. CUT or reframe any
  claim that a campaign is paused/stopped/dead and any "resume/reactivate" action. For a campaign with
  invites at 0, re-check its invite queue (the "Invite queue per campaign" seed, or re-run that query):
  queued/warming leads > 0 → invites are expected as the multi-day warm-up completes (normal, not a
  stall); queue EMPTY → the correct finding is "no leads left to invite" with the action to add new
  leads.
- FRAMING: never claim the team "did", "completed" or "fixed" anything — infer only from metric movement.
  Never judge who-replied-last from message threads: the LH2 agent can't see hand-typed SDR follow-ups
  until they're manually imported (messages.source='manual'), so an "unanswered" reply usually just
  isn't re-imported — structural, not a sync-freshness lag. Strip any "awaiting our reply / going cold /
  hot replies waiting / warm replies not followed up" claim, and any "SDR is dropping leads" action; if
  a post-reply drop-off is raised, the only correct move is "manually import these threads". Keep
  (don't strip) claims sourced from the 'following_up' pipeline stage counts — that stage is
  deterministic data (a recorded follow-up unanswered 14+ days), not a thread-derived judgment.
- LANGUAGE & NUMBERS: keep the whole briefing in plain, everyday Ukrainian a salesperson understands at
  a glance — short simple sentences, no analytical jargon (explain any unavoidable term inline). Every
  conclusion the merged briefing keeps MUST show the numbers that justify it — count + base + % where one
  applies, e.g. «12 відповідей із 240 інвайтів = 5%», up to ~3 numbers per claim. If a draft states a
  conclusion without its supporting numbers, add them from a fresh query or cut the claim; don't ship a
  bare percentage with no base, or a base with no rate where a rate is the point.
- BREVITY: if the day is genuinely quiet, make the briefing SHORTER — never pad it to look busy. Simpler
  words and fuller numbers do NOT mean longer text.

OUTPUT
- The corrected FINAL briefing as markdown, in plain everyday UKRAINIAN, in the SAME shape the analyst
  used: a one-line headline, a 2-3 sentence summary, CHANGES (day-over-day deltas, each tagged
  up/down/flat/new/resolved; empty if there's no previous briefing or nothing moved), at most 2 sections,
  risks with severities, and EXACTLY 3 actions. Every claim carries its supporting numbers (count + base
  + %). Refer to accounts by their LinkedIn account name, never a raw instance id.
- Output ONLY the briefing — no preamble, no notes about what you changed.

Today's date: ${new Date().toISOString().slice(0, 10)}.`

const briefingSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  changes: z
    .array(
      z.object({
        text: z.string(),
        trend: z.enum(['up', 'down', 'flat', 'new', 'resolved']).optional(),
      })
    )
    .max(6),
  sections: z.array(z.object({ title: z.string(), body: z.string() })).max(6),
  actions: z
    .array(z.object({ text: z.string(), priority: z.enum(['high', 'med', 'low']) }))
    .max(5),
  risks: z
    .array(
      z.object({
        kind: z.string(),
        severity: z.enum(['low', 'med', 'high']),
        text: z.string(),
      })
    )
    .max(6),
  // Structured key-metrics strip — 5-8 headline numbers of the day, extracted by the
  // STRUCTURE stage from the verified write-up. OPTIONAL so old stored rows (and any
  // row saved before the `metrics` column is migrated) still parse and render.
  metrics: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        note: z.string().optional(),
      })
    )
    .max(8)
    .optional(),
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// Belt-and-suspenders check for the framing rules already stated in BRIEFING_SYSTEM /
// VERIFY_SYSTEM (never claim the team "did/fixed" something; never claim a reply is
// "waiting on us"). Non-blocking — just gives log-based visibility into whether the
// prompt rules are actually holding up over time.
const FRAMING_VIOLATION_PATTERNS: RegExp[] = [
  /чека(є|ють)\s+(на\s+)?(нас|наш)/i, // "waiting on us"
  /очіку(є|ють)\s+(нашої\s+)?відповід/i, // "awaiting our reply"
  /гаряч(а|і)\s+відповід/i, // "N hot replies waiting"
  /команда\s+(виправила|завершила|зробила|виконала)/i, // "team did/fixed/completed X"
  /на\s+паузі/i, // "campaign is paused" — LH2 runtime state is not synced
  /реактив/i, // "reactivate the campaign"
  /відновіть\s+(подачу|кампані)/i, // "resume feeding / the campaign"
]

function logFramingViolations(object: z.infer<typeof briefingSchema>, date: string): void {
  const text = [
    object.headline,
    object.summary,
    ...object.changes.map((c) => c.text),
    ...object.sections.map((s) => s.body),
    ...object.actions.map((a) => a.text),
    ...object.risks.map((r) => r.text),
    ...(object.metrics ?? []).flatMap((m) => [m.label, m.value, m.note ?? '']),
  ].join('\n')
  for (const pattern of FRAMING_VIOLATION_PATTERNS) {
    if (pattern.test(text)) {
      console.warn(`briefing ${date}: possible framing-rule violation (matched ${pattern}) — review output`)
    }
  }
}

type PriorBriefing = {
  briefing_date: string
  headline: string | null
  summary: string | null
  actions: { text: string; priority?: string }[]
  risks: { kind?: string; severity?: string; text: string }[]
}

/** The most recent briefing strictly before `today`, if it's recent enough to be
 *  worth diffing against (within MAX_PRIOR_AGE_DAYS). Returns the row plus how many
 *  days back it is, or null on the first run / a long gap / a read error. */
async function fetchPriorBriefing(
  today: string
): Promise<{ prior: PriorBriefing; gapDays: number } | null> {
  const { data, error } = await db()
    .from('briefings')
    .select('briefing_date, headline, summary, actions, risks')
    .lt('briefing_date', today)
    .order('briefing_date', { ascending: false })
    .limit(1)
  if (error || !data || data.length === 0) return null
  const prior = data[0] as PriorBriefing
  const gapDays = Math.round(
    (Date.parse(today) - Date.parse(prior.briefing_date)) / 86_400_000
  )
  if (gapDays < 1 || gapDays > MAX_PRIOR_AGE_DAYS) return null
  return { prior, gapDays }
}

/** Render the previous briefing as a markdown block the analyst diffs today against. */
function renderPrior(prior: PriorBriefing, gapDays: number): string {
  const when =
    gapDays === 1 ? 'учора' : `у попередньому брифінгу (${prior.briefing_date})`
  const actions = (prior.actions ?? []).map((a, i) => `${i + 1}. ${a.text}`).join('\n')
  const risks = (prior.risks ?? [])
    .map((r) => `- [${r.severity ?? '—'}] ${r.text}`)
    .join('\n')
  return [
    `## Попередній брифінг (${when})`,
    prior.headline ? `HEADLINE: ${prior.headline}` : '',
    prior.summary ? `SUMMARY: ${prior.summary}` : '',
    actions ? `ACTIONS:\n${actions}` : '',
    risks ? `RISKS:\n${risks}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Run the seed queries, returning a markdown block to anchor the investigation. */
async function renderSeed(): Promise<string> {
  const parts = await Promise.all(
    SEED_QUERIES.map(async ({ label, sql }) => {
      try {
        const { rows, rowCount, truncated } = await executeSql(sql)
        const note = truncated ? ` (showing ${rows.length} of ${rowCount})` : ''
        return `### ${label}${note}\n${JSON.stringify(rows)}`
      } catch (e) {
        return `### ${label}\n(query failed: ${e instanceof Error ? e.message : String(e)})`
      }
    })
  )
  return parts.join('\n\n')
}

// --- Resumable job state machine ---------------------------------------------------
//
// The 4-stage ensemble above used to run inside one invocation and hit Vercel's 300s
// timeout on slow days. Each stage now runs in its OWN invocation (a "tick"), reading
// and writing a `briefing_jobs` row so the pipeline can resume across calls instead of
// needing to finish inside a single request/response. `version` is bumped on every
// write and used as an optimistic-concurrency token: a stage claims its transient
// status via `UPDATE ... WHERE status=$observed AND version=$observed`, so a losing
// racer's update always affects 0 rows — including when RECLAIMING a stale claim,
// where `status` doesn't change but `version` still does.

type JobStatus =
  | 'pending'
  | 'investigating'
  | 'investigated'
  | 'verifying'
  | 'verified'
  | 'structuring'
  | 'done'
  | 'error'

interface BriefingJobRow {
  briefing_date: string
  status: JobStatus
  version: number
  attempt: number
  seed: string | null
  signals_block: string | null
  prior_md: string | null
  drafts: { label: string; text: string }[] | null
  verified_text: string | null
  error: string | null
  updated_at: string
}

type Sb = ReturnType<typeof db>
type TickResult = { status: JobStatus; error?: string; progressed: boolean }

const MAX_ATTEMPTS = 3 // consecutive retries of one stage before giving up into 'error'
const STALE_MS = 8 * 60_000 // comfortably longer than one 300s invocation

/** Conditionally advance `job` to `next`, guarded on (status, version) so a losing
 *  racer's update affects 0 rows — including a stale-claim RECLAIM, where `next` may
 *  equal `job.status` (only version/attempt change). Returns the claimed row, or null
 *  if another invocation claimed this stage first. */
async function claim(sb: Sb, today: string, job: BriefingJobRow, next: JobStatus): Promise<BriefingJobRow | null> {
  const { data } = await sb
    .from('briefing_jobs')
    .update({
      status: next,
      version: job.version + 1,
      attempt: job.attempt + 1,
      error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('briefing_date', today)
    .eq('status', job.status)
    .eq('version', job.version)
    .select()
  return data && data.length === 1 ? (data[0] as BriefingJobRow) : null
}

/** Persist a stage's successful output and advance to `next`; `attempt` resets to 0 so
 *  the next stage gets its own fresh retry budget. */
async function finishStage(
  sb: Sb,
  today: string,
  claimed: BriefingJobRow,
  next: JobStatus,
  patch: Record<string, unknown>
): Promise<void> {
  await sb
    .from('briefing_jobs')
    .update({ ...patch, status: next, attempt: 0, version: claimed.version + 1, updated_at: new Date().toISOString() })
    .eq('briefing_date', today)
    .eq('version', claimed.version)
}

/** A stage threw. Revert to its start-state for an immediate retry on the next tick,
 *  unless the attempt cap is hit — then give up visibly into 'error' rather than
 *  retrying forever. */
async function failStage(
  sb: Sb,
  today: string,
  claimed: BriefingJobRow,
  startStatus: JobStatus,
  message: string
): Promise<void> {
  const giveUp = claimed.attempt >= MAX_ATTEMPTS
  await sb
    .from('briefing_jobs')
    .update({
      status: giveUp ? 'error' : startStatus,
      error: message,
      version: claimed.version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('briefing_date', today)
    .eq('version', claimed.version)
}

/** Another invocation claimed this stage first — report its current state rather than
 *  the stale `fallback` we observed before losing the race. */
async function afterLostRace(sb: Sb, today: string, fallback: BriefingJobRow): Promise<TickResult> {
  const { data } = await sb.from('briefing_jobs').select('*').eq('briefing_date', today)
  const row = (data?.[0] as BriefingJobRow | undefined) ?? fallback
  return { status: row.status, error: row.error ?? undefined, progressed: false }
}

/** Stage 1 — investigate from two independent angles IN PARALLEL (risk-first and
 *  growth-first), each with the same tools the chat copilot uses. Computes and stores
 *  seed/signals/prior so later stages fact-check against the SAME data snapshot this
 *  stage drafted against, not one that's drifted since. */
async function runInvestigateStage(sb: Sb, today: string, job: BriefingJobRow): Promise<TickResult> {
  const claimed = await claim(sb, today, job, 'investigating')
  if (!claimed) return afterLostRace(sb, today, job)

  try {
    const [seed, priorInfo, signals] = await Promise.all([
      renderSeed(),
      fetchPriorBriefing(today),
      computeAnomalySignals(),
    ])
    const signalsBlock = renderSignals(signals)
    const priorMd = priorInfo ? renderPrior(priorInfo.prior, priorInfo.gapDays) : ''
    const priorBlock = priorInfo
      ? `\n\n---\n${priorMd}\n\nCompare today's data against this previous briefing. Verify with SQL ` +
        `whether each prior risk and action RESOLVED, PROGRESSED, or still PERSISTS, and capture the ` +
        `day-over-day deltas in CHANGES. Do not restate facts from it that have not changed.`
      : `\n\n(No recent previous briefing to compare against — leave CHANGES empty and just write today's briefing.)`

    const drafts = await Promise.all(
      ANGLES.map(async ({ label, lens }) => {
        const { text } = await generateText({
          model: anthropic(INVESTIGATE_MODEL),
          system: BRIEFING_SYSTEM,
          prompt:
            `Here are today's seed query results. ${lens}\n\nInvestigate further with the tools, then ` +
            `write the briefing.\n\n${seed}\n\n---\n${signalsBlock}${priorBlock}`,
          tools,
          stopWhen: stepCountIs(40),
          maxOutputTokens: 8000,
          providerOptions: {
            anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
          },
        })
        return { label, text }
      })
    )

    await finishStage(sb, today, claimed, 'investigated', {
      seed,
      signals_block: signalsBlock,
      prior_md: priorMd,
      drafts,
    })
    return { status: 'investigated', progressed: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await failStage(sb, today, claimed, 'pending', message)
    return { status: 'pending', error: message, progressed: true }
  }
}

/** Stage 2 — adversarial fact-check + merge, re-using stage 1's stored seed/signals/
 *  prior/drafts (NOT recomputed — the verifier must fact-check against the same
 *  snapshot the drafts were written against). */
async function runVerifyStage(sb: Sb, today: string, job: BriefingJobRow): Promise<TickResult> {
  const claimed = await claim(sb, today, job, 'verifying')
  if (!claimed) return afterLostRace(sb, today, job)

  try {
    const seed = claimed.seed ?? ''
    const signalsBlock = claimed.signals_block ?? ''
    const priorMd = claimed.prior_md ?? ''
    const draftsBlock = (claimed.drafts ?? []).map((d) => `### DRAFT — ${d.label}\n${d.text}`).join('\n\n')

    const { text } = await generateText({
      model: anthropic(VERIFY_MODEL),
      system: VERIFY_SYSTEM,
      prompt:
        `Two draft briefings of the same morning, written from different angles — merge and correct them:\n\n` +
        `${draftsBlock}\n\n---\nSEED DATA:\n${seed}\n\n---\n${signalsBlock}` +
        (priorMd ? `\n\n---\nPREVIOUS BRIEFING:\n${priorMd}` : '') +
        `\n\nFact-check against the database with the tools, then output ONLY the merged, corrected final briefing.`,
      tools,
      stopWhen: stepCountIs(30),
      maxOutputTokens: 8000,
      providerOptions: {
        anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
      },
    })

    await finishStage(sb, today, claimed, 'verified', { verified_text: text })
    return { status: 'verified', progressed: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await failStage(sb, today, claimed, 'investigated', message)
    return { status: 'investigated', error: message, progressed: true }
  }
}

/** Stage 3 — coerce the verified narrative into the stored/Slack shape, upsert into
 *  `briefings`, and post to Slack. */
async function runStructureStage(sb: Sb, today: string, job: BriefingJobRow): Promise<TickResult> {
  const claimed = await claim(sb, today, job, 'structuring')
  if (!claimed) return afterLostRace(sb, today, job)

  try {
    const text = claimed.verified_text ?? ''
    const priorMd = claimed.prior_md ?? ''

    const { object } = await generateObject({
      model: anthropic(STRUCTURE_MODEL),
      schema: briefingSchema,
      system:
        `Extract the structured briefing from the analyst's write-up below. Keep ALL text in plain, ` +
        `everyday UKRAINIAN (do not translate it back to English) that a salesperson understands at a ` +
        `glance — short simple sentences, no analytical jargon — and KEEP a calm, professional voice, ` +
        `but TIGHTEN it: trim bloat, drop repetition, make every action ONE short imperative sentence and ` +
        `every risk ONE short line. Preserve specifics verbatim (numbers, dates, account / campaign ` +
        `names, agent versions). KEEP the numbers that justify each point — the count, the base it is out ` +
        `of, and the % where one applies (e.g. «12 відповідей із 240 інвайтів = 5%»), up to ~3 numbers ` +
        `per point; do NOT strip the base or the percentage down to a single bare figure. Refer to ` +
        `accounts by their LinkedIn account name, never by a raw instance id like "notebook-3". Keep the ` +
        `3 highest-leverage actions, most important first. The severity/priority fields stay as the codes ` +
        `high/med/low. Populate CHANGES with the day-over-day deltas from the write-up — each ONE short ` +
        `Ukrainian line tagged with a trend (up/down/flat/new/resolved); if the write-up has none, or ` +
        `there was no previous briefing, return an empty changes array, and never add a change that just ` +
        `repeats an unchanged fact from the previous briefing (shown below for reference). ` +
        `Populate METRICS with 5-8 headline numbers of the day pulled ONLY from the write-up — each ` +
        `{label, value, note?} in Ukrainian, where label is a short caption («Інвайти за 7 днів», ` +
        `«Відповіді», «Конверсія в клієнта»), value is the number as a short string that may embed its ` +
        `base/% («62 із 240 = 5%»), and note is optional one-phrase context. Pick the metrics that best ` +
        `summarise today; if the write-up lacks clear headline numbers, return fewer or omit metrics. ` +
        `Do not invent anything not in the write-up.`,
      prompt: priorMd
        ? `${text}\n\n---\nFor reference, the PREVIOUS briefing — do NOT repeat unchanged points from it:\n${priorMd}`
        : text,
    })

    logFramingViolations(object, today)

    const baseRow = {
      briefing_date: today,
      headline: object.headline.slice(0, 300),
      summary: object.summary.slice(0, 2000),
      changes: object.changes,
      sections: object.sections,
      actions: object.actions,
      risks: object.risks,
      model: ENSEMBLE_MODEL_LABEL,
    }
    const metrics = object.metrics ?? []
    const row = { ...baseRow, metrics }

    // `metrics` is a new column. On a DB where the migration adding it hasn't run yet
    // the upsert errors on the unknown column — fall back to persisting the rest so the
    // briefing still stores and renders (metrics still ship to Slack from this run).
    // Remove the fallback once `briefings.metrics` exists everywhere.
    let { error: upsertError } = await sb.from('briefings').upsert(row, { onConflict: 'briefing_date' })
    const isMissingMetricsColumn =
      upsertError != null &&
      (upsertError.code === 'PGRST204' ||
        (/metrics/i.test(upsertError.message) && /column/i.test(upsertError.message)))
    if (isMissingMetricsColumn) {
      ;({ error: upsertError } = await sb.from('briefings').upsert(baseRow, { onConflict: 'briefing_date' }))
    }
    if (upsertError) throw new Error(`briefing upsert failed: ${upsertError.message}`)

    await finishStage(sb, today, claimed, 'done', {})

    await postBriefingToSlack(process.env.SLACK_WEBHOOK_URL, {
      briefing_date: today,
      headline: baseRow.headline,
      summary: baseRow.summary,
      changes: baseRow.changes,
      actions: baseRow.actions,
      risks: baseRow.risks,
      metrics,
      model: baseRow.model,
    })

    return { status: 'done', progressed: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await failStage(sb, today, claimed, 'verified', message)
    return { status: 'verified', error: message, progressed: true }
  }
}

/** Advance today's briefing job by exactly one stage. `allowRestart` (only the manual
 *  "Refresh briefing" button) resets an already-terminal job back to fresh so it
 *  regenerates on demand; the cron path never restarts a finished/failed job on its own. */
async function advanceBriefingJob(allowRestart: boolean): Promise<TickResult> {
  const sb = db()
  const today = new Date().toISOString().slice(0, 10)

  // Create today's row if it doesn't exist yet. ignoreDuplicates is essential here — a
  // plain upsert would reset an in-flight job back to 'pending' on every single tick.
  await sb.from('briefing_jobs').upsert({ briefing_date: today }, { onConflict: 'briefing_date', ignoreDuplicates: true })

  const { data: rows } = await sb.from('briefing_jobs').select('*').eq('briefing_date', today)
  let job = rows?.[0] as BriefingJobRow | undefined
  if (!job) return { status: 'error', error: 'failed to load job row', progressed: false }

  if (allowRestart && (job.status === 'done' || job.status === 'error')) {
    const { data: reset } = await sb
      .from('briefing_jobs')
      .update({
        status: 'pending',
        attempt: 0,
        version: job.version + 1,
        drafts: null,
        verified_text: null,
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('briefing_date', today)
      .eq('version', job.version)
      .select()
    if (reset && reset.length === 1) job = reset[0] as BriefingJobRow
    // else: lost the race to something else touching this row — fall through with it as-is.
  }

  const isTransient = job.status === 'investigating' || job.status === 'verifying' || job.status === 'structuring'
  const stale = isTransient && Date.now() - Date.parse(job.updated_at) > STALE_MS

  if (isTransient && stale && job.attempt >= MAX_ATTEMPTS) {
    // Kept getting silently killed at this stage (platform timeout) — give up visibly
    // rather than retrying forever every time staleness is re-checked.
    const message = `stage ${job.status} kept timing out`
    await sb
      .from('briefing_jobs')
      .update({ status: 'error', error: message, version: job.version + 1, updated_at: new Date().toISOString() })
      .eq('briefing_date', today)
      .eq('version', job.version)
    return { status: 'error', error: message, progressed: false }
  }

  if (job.status === 'pending' || (job.status === 'investigating' && stale)) return runInvestigateStage(sb, today, job)
  if (job.status === 'investigated' || (job.status === 'verifying' && stale)) return runVerifyStage(sb, today, job)
  if (job.status === 'verified' || (job.status === 'structuring' && stale)) return runStructureStage(sb, today, job)

  // done / error / an actively-claimed non-stale transient status — nothing to do.
  return { status: job.status, error: job.error ?? undefined, progressed: false }
}

async function handle(req: Request): Promise<Response> {
  // Cron path is guarded; the manual POST path is intentionally open (see top).
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET
    if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) {
      return json({ error: 'unauthorized' }, 401)
    }
  }
  try {
    if (req.method === 'GET') {
      // Unattended cron: best-effort walk as many stages as fit in this invocation's own
      // budget, so a normal day finishes end-to-end from the single daily cron fire. A
      // slow day that doesn't finish just waits for a manual "Refresh briefing" click to
      // advance the rest.
      const deadline = Date.now() + 280_000
      let result = await advanceBriefingJob(false)
      while (result.status !== 'done' && result.status !== 'error' && result.progressed && Date.now() < deadline) {
        result = await advanceBriefingJob(false)
      }
      return json(result)
    }
    // POST (manual button): advance exactly one stage per request — the frontend drives
    // the loop so it can show incremental progress instead of blocking for the whole
    // pipeline in a single call.
    return json(await advanceBriefingJob(true))
  } catch (e) {
    console.error('briefing failed:', e instanceof Error ? e.message : String(e))
    return json({ error: 'Failed to generate the briefing — check server logs.' }, 500)
  }
}

export const GET = (req: Request) => handle(req)
export const POST = (req: Request) => handle(req)
