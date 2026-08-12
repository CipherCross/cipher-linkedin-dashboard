# Deterministic anomaly signals for the Morning Briefing

## Goal
The Morning Briefing (`frontend/api/briefing.ts`) currently asks an LLM to notice "what's
at risk or declining" purely by reading raw seed query results and whatever it chooses to
query further. That means trend/anomaly claims are only as good as the model's own read of
noisy day-to-day numbers. This adds a deterministic, code-computed anomaly-signal step that
runs *before* the ensemble, flags sustained multi-day trends and stalls with real math, and
feeds those signals into the prompts so risk/change claims are grounded in pre-verified
numbers instead of invented from a glance at raw data. This directly targets the two chosen
focus areas: **accuracy & trust** (fewer hallucinated/noise-driven trend claims) and
**richer content** (deeper anomaly detection than the current single-pass investigative read).

## Non-goals
- No change to the 3-stage Opus ensemble itself (models, stage count, step budgets) — cost/
  latency stays as-is per the "prioritize quality" decision.
- No new delivery surfaces: no history/archive page, no manual trigger on the Health page, no
  new delivery channel beyond Slack. `BriefingCard.tsx` and `slack.ts` are not touched.
- No `briefingSchema` (zod) changes — `risks`/`changes`/`actions` keep their current shape.
  Signals ground the *reasoning*, not the stored output format.
- No playbook-grounded actions (`coach.ts`-style) and no dedicated per-campaign breakdown
  section — the content question explicitly narrowed scope to anomaly detection only.
- No fix to the `MAX_PRIOR_AGE_DAYS = 7` continuity gap (day-over-day narrative continuity is
  a separate concern from the new signals, which are computed fresh from raw history every run
  regardless of prior-briefing age).

## Research findings
- `buildBriefing()` (`frontend/api/briefing.ts:316-425`) runs `renderSeed()` (fixed SQL
  snapshots) and `fetchPriorBriefing()` in parallel, then two `generateText` INVESTIGATE passes
  (risk-first / growth-first, `ANGLES` at lines 41-56), then one VERIFY+MERGE `generateText`
  pass, then one STRUCTURE `generateObject` pass. All three stages currently use
  `claude-opus-4-8` (lines 34-36).
- `SEED_QUERIES` (lines 64-97) are single-snapshot queries (e.g. "invites per account in the
  last 7 days") — no trend/baseline comparison exists anywhere in the pipeline today. Anomaly
  detection is entirely up to the model's own reading of these snapshots plus whatever it
  chooses to query via the shared `tools` (`_lib/tools.ts`, same object used by `/api/chat`).
- `daily_activity` view (`core.ts` `SCHEMA_DOC`, `001_init.sql`) already buckets
  `event_type` counts per `day`/`instance_id` — exactly the raw material needed for a rolling-
  window trend computation, no migration required.
- `WEEKLY_FUNNEL_SQL` (`core.ts:145-160`) computes invite-week cohort acceptance/reply rates
  but aggregates across **all** accounts — there's no per-account cohort query today, needed
  for an account-level "this cohort's reply rate is down vs its recent history" signal.
- CLAUDE.md's funnel-reasoning rule (replies lag invites; cohort by invite week, never compare
  raw invites-this-week vs replies-this-week) must be respected by any new reply-rate signal —
  mirrored already in `BRIEFING_SYSTEM`/`VERIFY_SYSTEM`'s "COHORTS" rules.
- `VERIFY_SYSTEM` (lines 184-218) already re-runs the SQL behind every claim via the same
  `tools` — the natural hook point to also cross-check claims against deterministic signals.
- `frontend/api/**` is not covered by `npm run build`'s `tsc -b` (scoped to `frontend/src`) —
  per existing project memory, typecheck API changes separately.

## Decisions
Answers from the clarifying round:

1. **Focus areas** → *Accuracy & trust* + *Richer content*. Cost/latency and distribution/UX
   were explicitly excluded.
2. **Content addition** → *Deeper anomaly detection* (sustained multi-day trends), not
   per-campaign breakdown or playbook-grounded actions.
3. **Cost/latency** → Keep the ensemble as-is; prioritize quality over trimming Opus calls.
4. **Delivery/UX** → None; keep Overview-page + Slack delivery unchanged.

Additional defaults set here (not asked, since they're implementation-level judgment calls —
flag if you want different numbers before implementation starts):
- Trend window: trailing 21 days of `daily_activity`, per instance, per `event_type` in
  `{invite_sent, invite_accepted, reply_received}`.
- "Sustained" rule: recent 3-day average deviates ≥30% (relative) from the preceding 7-day
  baseline (days t-11..t-4, skipping the most recent 3 days as the comparison window), **and**
  at least 2 of the last 3 individual days deviate the same direction — filters single-day
  noise from real multi-day moves.
- "Stalled" rule: a metric with a non-trivial baseline (baseline avg ≥ 1/day) drops to zero for
  3+ consecutive days.
- Cohort reply-rate signal: per-account invite-week cohorts (new query, mirroring
  `WEEKLY_FUNNEL_SQL`); flag when the most recent **mature** cohort (≥14 days since that week,
  so it's had time to reply) sits ≥25% below the trailing 4-cohort mature average.
- Severity mapping: ≥50% deviation or an active→zero stall → `high`; 30-50% → `med`. Low-
  severity/soft observations stay at the model's discretion — deterministic signals only
  surface clear, sustained anomalies to avoid drowning the briefing in noise.
- Low-volume accounts (baseline avg < 1/day) are skipped for percentage-based signals, since
  percentage deviation is meaningless near zero.

## Approach
Add a deterministic pre-computation stage that runs alongside the existing seed-data fetch,
producing a compact "ANOMALY SIGNALS" block that both INVESTIGATE prompts and the VERIFY
prompt receive — the same way `seed` and the prior-briefing block are spliced in today. The
signals are plain TypeScript + SQL, not model output, so they can't hallucinate; the LLM's job
becomes "explain/prioritize signals we already found" for anomaly content, while still being
free to investigate anything else via the existing `tools` loop. The VERIFY stage additionally
gets an instruction to cut any trend/decline risk claim that isn't backed by a provided signal
or a fresh confirming query — closing the loop on "richer content" and "accuracy" together
without adding model calls, schema fields, or new UI.

New module `frontend/api/_lib/anomalies.ts`:
- `computeAnomalySignals(db)` — runs the daily-activity trend query + new per-account cohort
  query, applies the sustained/stalled/cohort-decline rules in plain TS, returns
  `AnomalySignal[]` (`{ account, instanceId, metric, direction, magnitude, daysSustained,
  severity, detail }`).
- `renderSignals(signals)` — formats the flagged signals (only — not raw daily numbers) as a
  compact markdown block, or a "(no sustained anomalies detected)" note when empty so the
  model doesn't invent one to fill space.

`core.ts` gains one new SQL constant (`WEEKLY_FUNNEL_BY_ACCOUNT_SQL` or equivalent, per-instance
version of `WEEKLY_FUNNEL_SQL`) for the cohort signal.

`briefing.ts` changes:
- `buildBriefing()`: add `computeAnomalySignals()` to the existing initial `Promise.all` (with
  `renderSeed()`/`fetchPriorBriefing()`), fail-soft like the seed queries.
- Splice `renderSignals()`'s output into both INVESTIGATE prompts and the VERIFY prompt, next
  to where `seed` is inserted today.
- `BRIEFING_SYSTEM`: add a short rule in "HOW TO WORK" — trend/decline claims should line up
  with a provided ANOMALY SIGNAL or a fresh confirming query, not be invented from one data
  point.
- `VERIFY_SYSTEM`: add a "SIGNALS" bullet alongside the existing "COHORTS"/"RECONCILE" bullets
  — cross-check every trend-claiming risk against the signals block; cut what isn't backed.

## Implementation phases
1. **(M) Deterministic signal computation** — `frontend/api/_lib/anomalies.ts` +
   `WEEKLY_FUNNEL_BY_ACCOUNT_SQL` in `core.ts`. No DB migration needed (`daily_activity` view
   already exists). Independently testable by calling `computeAnomalySignals()` against real
   data and eyeballing output before it ever touches a prompt.
2. **(S) Wire signals into the ensemble prompts** — splice `renderSignals()` output into
   `buildBriefing()`'s prompts; add the grounding rules to `BRIEFING_SYSTEM` and `VERIFY_SYSTEM`.
   No schema/UI changes.
3. **(S, optional) Belt-and-suspenders logging guard** — after `generateObject`, scan
   `risks`/`changes`/`actions` text for the banned-phrase patterns the prompts already forbid
   (e.g. "чекає на нас", "очікує відповіді") and `console.warn` (non-blocking) if found, giving
   log-based visibility into prompt-rule adherence over time. Also fix the `model` row field
   (`briefing.ts:400`, currently only ever records `INVESTIGATE_MODEL`) to reflect ensemble
   provenance more precisely — trivial, bundle in if time allows.

## Affected files/modules
- `frontend/api/_lib/anomalies.ts` — new.
- `frontend/api/_lib/core.ts` — add one new SQL constant for per-account cohorts.
- `frontend/api/briefing.ts` — wire signals into `buildBriefing()`, `BRIEFING_SYSTEM`,
  `VERIFY_SYSTEM`; optional phase-3 guard + `model` field fix.
- Not touched: `briefingSchema`, `frontend/src/lib/types.ts`, `BriefingCard.tsx`, `slack.ts`,
  `DataContext.tsx`, `vercel.json`.

## Risks & how to verify
- **Noise from thin data**: mitigated by the ≥1/day baseline floor and the 2-of-3-days rule;
  verify by running against a low-volume test account and confirming no signal fires.
- **Added latency**: new queries run inside the same initial `Promise.all` as `renderSeed()`,
  so they add at most one query's latency to an already-parallel fetch, not to the model calls.
  Verify by timing `buildBriefing()` before/after via a manual `POST /api/briefing`.
- **Prompt bloat**: `renderSignals()` emits only flagged signals, not raw daily series — keep
  it to a handful of lines even on a bad week; verify by inspecting the rendered block's length
  in a manual run.
- **False positives in the phase-3 log guard**: verify by checking Vercel logs across a few
  days of real runs for unexpected warnings (would indicate the regex is too broad, not that
  the briefing is actually wrong).
- **General verification**: manually trigger via `POST /api/briefing` (or `vercel dev` + curl)
  against real data, inspect the stored `briefings` row for signal-grounded `risks`/`changes`,
  and confirm `BriefingCard.tsx` still renders correctly (output shape is unchanged, so this
  should be a non-issue, but worth a visual check).
- Typecheck `frontend/api/**` explicitly (not covered by `npm run build`) — e.g.
  `npx tsc --noEmit -p frontend/api` or the project's existing convention for this.

## Definition of done
- [ ] `computeAnomalySignals()` implemented, covering sustained trend, stall, and cohort
      reply-rate decline detection with the sample-size-aware thresholds above.
- [ ] Both INVESTIGATE prompts and the VERIFY prompt receive the signals block and the new
      grounding rules are present in `BRIEFING_SYSTEM`/`VERIFY_SYSTEM`.
- [ ] A manually-triggered briefing against real/current data shows at least one signal-backed
      risk or change where a real sustained trend exists in the data, spot-checked against the
      DB by hand.
- [ ] No hallucinated trend claim in a manual run lacks a backing signal or a fresh query
      (spot-check the VERIFY stage's tool-call trace / final output).
- [ ] `briefingSchema`, `BriefingCard.tsx`, `slack.ts` unchanged — output shape and delivery
      surfaces identical to before.
- [ ] `frontend/api/briefing.ts` and the new `_lib/anomalies.ts` typecheck cleanly.
- [ ] Existing Ukrainian-language, brevity, and anti-hallucination framing rules are intact
      (spot-check a generated briefing reads the same in tone/length as before).
