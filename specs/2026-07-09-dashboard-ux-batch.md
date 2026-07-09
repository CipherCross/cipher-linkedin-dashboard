# Dashboard UX batch — briefing, funnel, cleanup, Leads filters, weekly limit

## Goal

One batch of six UX/product changes: make the daily briefing readable for the whole team
(simpler words, more supporting numbers), merge the Home funnel with the CRM pipeline into
one continuous full-statistics funnel, remove two low-value CampaignDetail widgets
(audience segments, top companies), fold the Replies page into Leads-tab filters, and show
per-account "leads added this week vs 200/week limit" on the Account page and Overview cards.

## Non-goals

- No AI (Haiku) replacement for headline segmentation — the segment table is simply removed
  (decided in Q&A; can be revisited later).
- No per-account configurable invite limit — 200/week is a code constant for now
  (`weekly_invite_target` was deliberately dropped in migration 006; not resurrecting it).
- No changes to funnel *semantics* (milestone timestamps, views, agent `derive_events`) —
  the funnel work is presentation + pipeline overlay only (CLAUDE.md rule).
- No auth work on API endpoints (tracked separately).
- No deploys / `supabase db push` / `deploy.sh` — user runs those.

## Research findings

1. **Briefing** — `frontend/api/briefing.ts`: 3-stage ensemble (2× investigate → verify+merge
   → structure via `generateObject`), all Opus. Style rules live in THREE prompts that must
   stay consistent: `BRIEFING_SYSTEM` (lines ~119–227, incl. BREVITY rule "ONE number per
   claim" at ~222 — directly conflicts with the new requirement), `VERIFY_SYSTEM` (~233–284),
   STRUCTURE prompt (~627–639, "single most telling number per point"). Output = zod
   `briefingSchema` (~286–310): `headline, summary, changes[], sections[], actions[], risks[]`;
   stored one row/day in `briefings`; rendered by `frontend/src/components/BriefingCard.tsx`
   (Ukrainian labels); posted to Slack via `postBriefingToSlack` in `frontend/api/_lib/slack.ts`
   (briefing.ts:663). Ukrainian-output guardrail regexes: `FRAMING_VIOLATION_PATTERNS` (~322–330).
   Rich numeric grounding already exists (`SEED_QUERIES` ~73–117 + `_lib/anomalies.ts`).

2. **Funnel** — Home = `frontend/src/pages/Overview.tsx` renders `<Funnel leads showPipeline />`
   (line ~129). `frontend/src/components/Funnel.tsx` computes client-side from lead milestones
   (Leads→Invited→Accepted→Replied) and, with `showPipeline`, appends a *separate* "Manual
   pipeline" section from `frontend/src/lib/pipeline.ts` (`PIPELINE_CHECKPOINTS`, `reachByLead`,
   `checkpointCount` — client/lost terminal handling must be preserved). Pipeline checkpoints:
   Interested → Negotiations → Call Booked → Call Done → Proposal Presented → Client.
   Pipeline layer (migrations 027/028, `/api/pipeline`, kanban) is built but **uncommitted /
   unpushed** — the pipeline section is a no-op in prod until `db push`.

3. **Segment table** — private `SegmentTable` in `frontend/src/pages/CampaignDetail.tsx`
   (~258–303, rendered ~218 in a `two-col` beside CompanyTable). Uses `segmentOf()` +
   `SEGMENT_RULES` in `frontend/src/lib/leads.ts` (~217–232); no other callers.

4. **Top companies** — private `CompanyTable` in `CampaignDetail.tsx` (~305–345, rendered ~219).
   No other dependents. `l.company` itself is used elsewhere and stays.

5. **Replies page** — `frontend/src/pages/Replies.tsx`, route `/replies` (App.tsx:33), nav link
   Layout.tsx:31 + skeleton variant Layout.tsx:42. Features: URL sentiment filter with counts
   (`SENTIMENT_META/SENTIMENT_ORDER`, incl. `unclassified`), 7/30/90/All date range, "Classify
   new replies" button (POST `/api/classify`), per-instance coaching digest panel
   (`coaching_digest` + POST `/api/coach`), "new since last visit" localStorage dot, rows via
   `ReplyRow.tsx` + `latestRepliesByLead`, click → shared ConversationDrawer.
   `LeadsExplorer.tsx` already has URL filters (search/account/campaign/stage/risk/pipeline
   stage/owner), sortable columns, CSV export, and opens the same drawer — missing only the
   sentiment/reply-date dimension. `HotLeads.tsx` and `RepliesPanel.tsx` link to `/replies`
   but are dead code (not imported by any page).

6. **Weekly limit** — `AccountDetail.tsx` (route `/account/:id`) already has `WarmupChart`
   (invites/week vs 100–200 band). Overview cards = `frontend/src/components/AccountCard.tsx`
   (+ `accountStats` in leads.ts:397). `added_at` exists since migration 025 but is
   **approximate**: backfill = earliest milestone, and notebooks run agent v1.7.2 (v1.8.0,
   which captures real added_at, not yet deployed) — so fresh rows may have NULL `added_at`.
   `addedByDay` (leads.ts:203) already consumes it and tolerates NULL. LinkedIn's real limit
   is a rolling 7-day window on *invites* (~100–200/wk).

Conventions: HashRouter, pages in `src/pages/`, single `useData()` from `DataContext.tsx`,
metric logic in `src/lib/leads.ts`, plain CSS in `styles.css`, Recharts + `chartTheme.tsx`.
`npm run build` typechecks only `src/` — typecheck `api/` separately. Vercel Hobby 12-function
cap (~11 used) — no new API routes needed by this plan. Parallel Claude sessions may hold
uncommitted pipeline changes — don't revert unowned working-tree changes.

## Decisions

| Question | Answer |
|---|---|
| Briefing: how to add numbers? | **Both**: simplify wording AND allow 2–3 supporting numbers per claim inline AND add a structured key-metrics block to the schema/card/Slack. |
| Funnel × pipeline | **One continuous funnel**: Leads→Invited→Accepted→Replied→Interested→…→Client in a single visualization; automated vs manual halves visually distinguished. |
| Segment table | **Remove** (no AI replacement now). |
| Weekly limit metric | **`added_at`** (leads added), fixed limit **200**, window: rolling **last 7 days** (default; matches LinkedIn's rolling window). Fallback for NULL `added_at`: earliest milestone. Accuracy improves after agent v1.8.0 rollout. |

Defaults set by the plan (override during review if wrong):
- **Coaching digest + "Classify new replies" button** move to the Leads page (collapsible panel
  / toolbar button, visible when the sentiment filter is active or always in the toolbar).
- **"New since last visit" dot** is dropped (low value once replies are just a filter).
- Dead components `HotLeads.tsx`, `RepliesPanel.tsx`, and `ReplyRow.tsx` (after Replies.tsx
  deletion its only consumers) are deleted.
- Briefing schema change is **additive & optional** (`metrics?: [...]`) so old stored rows and
  `prevBriefing` rendering keep working.

## Approach

### R1 — Briefing: simpler language + more numbers (M)
- `BRIEFING_SYSTEM`: rewrite VOICE/BREVITY blocks — plain everyday Ukrainian, short sentences,
  no analyst jargon ("когорта" → explain or avoid; concrete verbs); replace "ONE number per
  claim" with "every conclusion must show the numbers that justify it — count + base + %
  (e.g. «12 відповідей із 240 інвайтів = 5%»), max ~3 numbers per claim".
- Apply the same rule change to `VERIFY_SYSTEM` and the STRUCTURE prompt (three prompts encode
  the same style — change all, keep them consistent).
- Schema: add optional `metrics: [{ label, value, note? }]` (5–8 headline numbers of the day).
  Update `BriefingCard.tsx` to render them as a compact stat strip; update
  `_lib/slack.ts` to include them. Guard for absence (old rows).
- Keep Ukrainian, keep `FRAMING_VIOLATION_PATTERNS` valid (adjust if wording rules shift),
  keep cohort-reasoning framing (invites-lag rule) intact.

### R2 — One continuous funnel on Home (M)
- Rework `Funnel.tsx`: single bar sequence — automated milestones (Leads, Invited, Accepted,
  Replied) flowing into pipeline checkpoints (Interested, Negotiations, Call Booked, Call Done,
  Proposal Presented, Client), conversion % on every connector, distinct visual treatment for
  the manual half (color family / divider label). Scale all bars against total leads (or
  log-ish min-width so tail stages stay visible).
- Keep data sources as-is: milestones from `leads`, checkpoints via `checkpointCount`
  (client≠lost terminal logic preserved). Pipeline half self-hides (or renders greyed) when no
  lead was ever staged — prod-safe before migrations 027/028 are pushed.
- Keep the "pending invites" line; add totals + overall Lead→Client conversion.

### R3 + R4 — Remove Segment table and Top companies (S)
- Delete `SegmentTable` and `CompanyTable` from `CampaignDetail.tsx` and their `two-col`
  section; remove `segmentOf` + `SEGMENT_RULES` from `leads.ts` (no other callers).

### R5 — Replies page → Leads filters (M)
- `LeadsExplorer.tsx`: add URL-persisted **sentiment** filter (buckets + counts from
  `latestRepliesByLead`, incl. `unclassified` and "has reply / no reply"), and a **replied
  within 7/30/90/All** range filter. When a sentiment filter is active, show the latest inbound
  snippet + sentiment badge in rows (reuse ReplyRow's presentation inline or a slim variant).
- Move "Classify new replies" button + coaching digest panel into Leads (per Decisions).
- Delete `Replies.tsx`, `/replies` route, nav link + skeleton variant; add a redirect
  `/replies → /leads?sentiment=…` (HashRouter `Navigate`) so old links keep working.
- Delete dead `HotLeads.tsx`, `RepliesPanel.tsx`; fold/keep `ReplyRow` only if reused by the
  Leads row rendering, otherwise delete.

### R6 — Weekly added-leads vs 200 limit (S/M)
- `leads.ts`: new helper `weeklyAdded(leads, instanceId)` — count of leads whose
  `added_at ?? earliest-milestone` falls in the last 7 days (rolling, UTC); export constant
  `WEEKLY_ADD_LIMIT = 200` and `remaining = max(0, 200 − added)`.
- `AccountDetail.tsx`: stat card "Додано за 7 днів: X / 200 · можна ще Y" with a small
  progress bar (green <70%, amber <100%, red at limit).
- `AccountCard.tsx` (Overview): same number as a compact stat/progress chip in the stats row.
- Tooltip/footnote: values approximate until agent v1.8.0 rollout (added_at backfill).

## Implementation phases

1. **P1 — Removals** (S): SegmentTable + CompanyTable + `segmentOf`/`SEGMENT_RULES`; layout fix
   on CampaignDetail. Independently shippable.
2. **P2 — Leads filters + Replies removal** (M): sentiment/reply-range filters on Leads, move
   classify button + coaching digest, delete Replies page/route/nav + dead components, redirect.
3. **P3 — Continuous funnel** (M): Funnel.tsx rework; verify Overview and any other Funnel usage.
4. **P4 — Weekly limit** (S): leads.ts helper + AccountDetail stat + AccountCard chip.
5. **P5 — Briefing** (M): three prompts + schema + BriefingCard + slack.ts; typecheck `api/`
   separately; test via POST run before relying on the cron.

Phases are independent; any subset can ship.

## Affected files/modules

- `frontend/api/briefing.ts`, `frontend/api/_lib/slack.ts`, `frontend/src/components/BriefingCard.tsx`
- `frontend/src/components/Funnel.tsx`, `frontend/src/lib/pipeline.ts` (read-only usage), `frontend/src/pages/Overview.tsx`
- `frontend/src/pages/CampaignDetail.tsx`, `frontend/src/lib/leads.ts`
- `frontend/src/pages/LeadsExplorer.tsx`, `frontend/src/pages/Replies.tsx` (delete),
  `frontend/src/App.tsx`, `frontend/src/components/Layout.tsx`,
  `frontend/src/components/ReplyRow.tsx` / `HotLeads.tsx` / `RepliesPanel.tsx` (delete/fold)
- `frontend/src/pages/AccountDetail.tsx`, `frontend/src/components/AccountCard.tsx`
- `frontend/src/styles.css` (funnel + stat-chip styles)
- No migrations, no new API routes, no sync-agent changes.

## Risks & how to verify

- **Briefing regressions** (wrong language, schema mismatch, Slack break): run a manual POST
  briefing generation against real data; check stored row renders in BriefingCard (incl. an
  *old* row without `metrics`), check Slack message locally/preview; confirm
  `FRAMING_VIOLATION_PATTERNS` still meaningful. `npm run build` doesn't cover `api/` —
  run `npx tsc --noEmit` (or equivalent) in the api scope.
- **Funnel numbers change silently**: milestone counts before/after refactor must be identical
  (semantics untouched); pipeline half must render 0-state correctly with no staged leads
  (prod pre-migration) and correct counts with staged leads (local).
- **Leads filter parity**: every sentiment bucket count on new Leads filters matches the old
  Replies page against the same data; drawer opens from filtered rows; classify + coach buttons
  still hit their endpoints; `/replies` deep link redirects.
- **Weekly limit correctness**: cross-check one instance's 7-day count against
  LeadsAddedTable/velocity charts; NULL `added_at` rows fall back to earliest milestone, never
  crash; number visibly capped at 0 remaining.
- **Working tree**: pipeline layer is uncommitted and other sessions may be active — build on
  top of current tree, never revert changes this task didn't author.
- Verification for every phase: `npm run build` green + manual pass in `npm run dev`
  (P5 needs `vercel dev` for the API function).

## Definition of done

- [ ] Briefing (new run) is in simple Ukrainian, each conclusion backed by explicit numbers
      (count + base + %), and shows a key-metrics block in BriefingCard and Slack; old rows
      still render.
- [ ] Home shows ONE continuous funnel Leads→…→Client with per-step conversions; totals match
      pre-change milestone counts; graceful when pipeline data is absent.
- [ ] "Performance by audience segment" and "Top companies" are gone from CampaignDetail;
      no dead code (`segmentOf`, `SEGMENT_RULES`) remains.
- [ ] `/replies` no longer exists (redirects to Leads); Leads has sentiment + reply-date
      filters with counts, reply snippets, classify button, and the coaching digest.
- [ ] AccountDetail and Overview account cards show "added last 7 days: X/200, Y remaining"
      per account, with the approximation footnote.
- [ ] `npm run build` passes; `api/` typechecks separately; no migrations or deploys were run.
