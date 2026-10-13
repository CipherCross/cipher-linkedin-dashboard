# Outreach data insights: audit and question catalog

Status: phases 1 and 2 done 2026-10-13. The fact book is the dashboard artifact
"Outreach fact book" (https://claude.ai/artifact/QyK4SrJwMkFZXFX3qnVJwB), built by
`analysis/outreach-insights/`. Open work is at the end of this file.

Goal: find facts in the outreach data (correlations with sizes, confidence ranges
and stated limits), not recommendations. This file records what the data can and
cannot answer, so phase 2 only asks questions the data can carry.

## How the audit read production

Read-only, through the same guard the AI copilot uses: `NEON_AI_DATABASE_URL`
(production, `~/.config/neon-s28-production.env`), `BEGIN READ ONLY`,
`set_config('role','app_system',true)`, actor = nil uuid, every query through
`public.ai_execute_sql` (single SELECT, 1000-row cap, 10 s timeout). Aggregates
only; no lead-level data left the database. Trap: `ai_execute_sql` wraps the query
as `jsonb_agg(t) ... ) t`, so a result column named `t` replaces the whole row.

## What is in the data (production, 2026-10-13)

| Thing | Count | Note |
|---|---|---|
| LinkedIn accounts | 4 | karina-1, notebook-1, notebook-2 (both Mykyta), notebook-3 (Anastasia) |
| Campaigns | 42 | ~30 with leads; 12 empty, test or canary |
| Lead rows (person × campaign) | 6,489 | ~6,400 people |
| Invited | 5,728 | 4,369 invited more than 30 days ago |
| Accepted | 1,511 | 26% of invites |
| First message sent | 907 | |
| Replied | 441 | 7.7% of invites |
| People invited by two accounts | 762 | 631 account pairs with a clear first and second sender |
| Messages | ~15,400 | 2,291 inbound, ~13,100 outbound |
| Conversation threads | 6,422 | 4,152 with leads; 2,270 are the wider inbox (back to 2020) |
| Campaign steps | 483 | 138 distinct message texts |
| Pipeline events | 695 | 213 auto, 70 Airtable import, ~240 human |

Monthly invite volume runs from 223 (Oct 2025) to 1,403 (Sep 2026). Activity before
March 2026 is one campaign (notebook-1:1, Oct 2025).

### Field fill rates (6,489 lead rows)

| Field | Filled | Usable as |
|---|---|---|
| headline | 6,190 (95%) | role, seniority, industry keywords, style |
| company | 5,858 (90%) | 3,316 distinct; 1,341 companies have 2+ leads |
| inferred gender (male/female) | 5,643 (87%) | model inference, labelled as such |
| inferred age range | 3,384 (52%) | from education and first-job years |
| photo | 708 of 3,743 checked | see the photo trap below |
| added / invited / connected / first message / replied | 5,980 / 5,728 / 1,511 / 907 / 441 | the funnel |
| pipeline_stage | 300 (5%) | thin |
| lost_reason | 58 | thin |
| `raw` jsonb | 0 | empty everywhere |

Headline composition: "founder" appears in 2,261 headlines, CEO in 1,333, CTO in 427,
COO in 295; health or medical terms in 2,207. No headline contains Cyrillic, so the audience
writes in English.

### Outcome labels: the binding limit

| Outcome | n | Verdict |
|---|---|---|
| Accepted | 1,511 | solid |
| Replied | 441 (335 with reply text) | solid for big splits |
| Time to accept / time to reply | 1,511 / 441 | solid |
| Touches before first reply | 441 | solid |
| Sentiment label | 32 of 2,291 inbound | effectively absent |
| Intent P1/P2/P3 | 6 | absent |
| Interested or further on the board | 30 | descriptive only |
| Negotiations / call booked / client | 11 / 1 / 1 | anecdotes |

"Did the reply mean anything" cannot be studied until replies are labelled (see
the open decisions below).

### Detection power, as a rule of thumb (mature invites only)

- A feature splitting the audience in half: an acceptance gap of about 4 points
  and a reply gap of about 2.3 points are detectable.
- A feature covering 10% of the audience: about 6 points (acceptance) and about
  3.8 points (reply, half the base rate).
- Smaller subgroups give direction, not facts.

## Traps found in this data

1. **Overlapping people.** 762 people were invited by two accounts and 79 by two
   campaigns in one account. Questions about people must count each person once.
2. **Recent invites haven't finished.** 1,359 invites (24%) are under 30 days old.
   About 70% of acceptances arrive within 5 days, but 137 (11%) arrived after 30 or more
   days. Use invites older than 30 days, or time-to-event methods.
3. **Milestones out of order.**
   - 195 leads connected before being invited (existing connections or
     re-invites) and should be excluded from acceptance questions.
   - 196 replied with no first message (they answered the connection itself).
   - 71 replied before the first message.
4. **Reply text gap.** 106 of the 441 replied leads have no inbound text, because
   of the profile-link mismatch and pre-chat-store history. Text analysis covers 76%.
5. **The wider inbox is not outreach.** 2,270 threads have no lead row: personal
   and network conversations, including most of the 703 Cyrillic inbound messages.
   Exclude them.
6. **Photo may be an effect, not a cause.** Raw acceptance is 29.7% with a photo vs
   25.3% without. Before using photo as a feature, confirm when the agent captures
   it; if it only resolves after a profile visit or connection, it's reverse-causal.
7. **Account, audience and time move together.** Mature-invite acceptance by
   account: karina-1 18.2%, notebook-1 31.0%, notebook-2 28.1%, notebook-3 22.5%.
   Each account ran different lists in different months, so any feature fact must
   hold within account and campaign.
8. **One person, two accounts.** notebook-1 and notebook-2 are both Mykyta's.
   "Sender" is an account, not a human.

## Natural experiments already in the data

- **Second-sender re-invites.**
  - 293 people invited by notebook-1 were invited about 47 days later by notebook-3:
    19 accepted the first invite, 48 accepted the second.
  - 226 people went notebook-1 → karina-1 about 95 days apart: 9 accepted the
    first, 25 the second.
  - Within-person and paired, so audience is held constant. Limit: the second
    sender is always the later touch and always a woman, so sender, "second touch"
    and elapsed time cannot be separated.
- **September persona × offer grid.** From 2026-09-10 every account launched
  campaigns named `<persona> → <offer>`: personas are Founder, CTO, Product/COO;
  offers are UX/UI, Full-stack, Mobile, QA. This is close to a factorial design,
  but under five weeks old, so acceptance is usable now and replies need until
  about mid-November.
- **Warm-up regimes** at campaign level:
  - endorse + like + visit (the older 18-step Web2Mob sequences);
  - follow + visit (the September grid);
  - none (notebook-2's September campaigns).
  - Confounded with period and account, so descriptive only.

## Question catalog

### A. Answerable now (acceptance, reply, timing)

1. **Who accepts?** Acceptance by:
   - headline role (founder, CEO, CTO, COO, product, head/director, engineer);
   - industry words (health, mental, clinical, SaaS, AI…);
   - headline style (length, `|`-separated, "helping…" phrasing);
   - inferred age band and gender;
   - whether a company is listed.

   Each fact must hold within account and campaign. Raw example to test: inferred
   age 20s accepts 47% (men) vs 12% for 60s.
2. **Who replies once connected?** The same features, against reply given
   acceptance.
3. **Sender effect.** Account differences with audience held constant, plus the
   paired re-invite experiment above.
4. **Timing.**
   - Invite weekday and hour vs acceptance (raw: Sunday 18% vs about 26% on weekdays).
   - The time-to-accept curve: when a pending invite is effectively dead.
   - Time to reply.
5. **Sequence yield.**
   - The marginal reply rate of each follow-up: step 7 is 6.8%; steps 13–17 are
     about 1.5%.
   - Touches before the first reply: 121 at zero, 105 at one, 85 at two, 67 at three.
   - The share of replies that come before any follow-up.
6. **Saturation.**
   - Does reaching a second or later person at the same company change outcomes?
   - Does a person in two campaigns behave differently?
7. **Volume and fatigue.**
   - An account's invites that day vs acceptance.
   - A campaign's first week vs later weeks: are lists front-loaded with their
     best leads?
8. **Outbound copy.** Message length, a question, personalization variables vs
   reply. This is campaign-level (about 30 campaigns, 138 texts), so it's weak.

### B. Answerable after labelling

9. **What replies say.** Cluster the 963 inbound lead-thread messages: not
   interested, already has a vendor, tell me more, auto-reply, referral, wrong
   person.
10. **Which audiences produce positive vs negative replies**, rather than just
    replies.

### C. Descriptive only (too few cases)

11. Paths into interested, negotiation and call: 30 leads.
12. Lost reasons: 58, mostly not a fit, unsubscribe, no budget, wrong person.

### D. Not answerable without new data

- Location and timezone, industry, company size or funding, connection or follower
  count, profile language.
- Which warm-up actions a specific lead actually received (only campaign
  aggregates are synced).

Two possible sources:
- LH2's local database holds profile fields from `VisitAndExtract`, which the
  agent could sync.
- Apollo CSV imports in Airtable carry company industry, headcount and country for
  imported leads.

## Decisions (owner, 2026-10-13)

1. Replies are classified by Claude for the analysis only, outside the product
   (codebook: `analysis/outreach-insights/labels/CODEBOOK.md`). 359 threads were
   labelled. A blind re-read agreed on 20 of 20 for substantive-or-not, and the
   labels match the pipeline board.
2. Enrichment was done now through the Airtable join: 87% of invited rows matched
   a contact, which brings company size, founding year, HQ country and industry.

## Phase 2 as built

- The snapshot is JSON through the read-only guard, not DuckDB.
- First touch per person, fixed windows (accepted within 14 days, replied within
  21 days).
- Mantel–Haenszel within campaign, a joint logistic model with campaign fixed
  effects, Benjamini–Hochberg correction.
- Replication split at 2026-07-01, not 2026-08-01: the September grid left too
  few mature invites after August.
- Re-invites are compared with fresh invites in the same campaigns, not with
  McNemar's test, because nearly no first invite was accepted before the second.

## Open work

1. **Re-run in mid-November 2026**, when the September persona campaigns'
   replies have matured. Steps are in `analysis/outreach-insights/README.md`;
   classify only the new threads.
2. **Location, connection count and profile language** are still missing. LH2
   holds them locally, so they need an agent sync change: baseline step, gateway
   contract, agent release. That is a product change and needs its own session.
3. **Deep funnel.** 23 agreed calls is too few to profile who books calls. It
   becomes answerable at roughly three times that count.
