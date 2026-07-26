# Weekday and weekly LinkedIn briefings

## Goal

Replace the noisy daily briefing with two distinct Slack updates: a short operational briefing every weekday and a longer contextual briefing every Monday. Both formats should be selective, natural Ukrainian, use team-provided campaign context before interpreting performance, and avoid repeating standing observations that do not lead to action.

The Overview briefing card will be removed. Briefings will still be stored for continuity, auditability, and safe retries, but Slack becomes their only team-facing surface.

## Non-goals

- Do not change funnel, cohort-maturity, reply-lag, intent, or anomaly semantics.
- Do not merge or replace the existing deterministic, manually posted Weekly Review.
- Do not change the models used by chat, per-conversation coaching, or coaching digests.
- Do not infer campaign strategy from metrics or cross-account overlap when the team has not supplied that context.
- Do not add authentication beyond the repository's current `ADMIN_SECRET`, `CRON_SECRET`, service-role, and read-only-open conventions.
- Do not rewrite historical migrations or old briefing rows.

## Research findings

- `frontend/api/briefing.ts` currently runs one daily four-call Opus ensemble: two investigations, a verify/merge pass, and structured extraction. Its prompts, persistence keys, prior-briefing lookup, and comments assume one briefing per day.
- `frontend/vercel.json` runs `/api/briefing` every day at 07:00 UTC. Vercel cron uses UTC and does not retry failed invocations.
- `briefings` and `briefing_jobs` are keyed only by `briefing_date`, so they cannot represent both a daily and weekly briefing on Monday.
- The current prompt already asks for concise Ukrainian, but rigid requirements such as exactly three actions, a fixed KPI strip, repeated count/base/percentage evidence, two mirrored drafts, and fixed sections encourage formulaic output.
- Campaign context exists in three places but is not reliably loaded into the briefing: scoped `annotations`, hypothesis descriptions and campaign assignments, and saved-search notes. Annotations are CLI-only; there is no durable campaign-context editor in the dashboard.
- The current model can observe campaign performance but cannot reliably infer a cause such as “this campaign re-engages leads who did not accept on another account.” Causal context must be explicitly supplied and clearly distinguished from measured facts.
- Anthropic documents `claude-opus-5` as the Opus 5 API model ID. The installed `@ai-sdk/anthropic` accepts arbitrary model strings but predates Opus 5 capability metadata, so the provider dependency must be upgraded and structured output revalidated, not just renamed. See the [Anthropic migration guide](https://platform.claude.com/docs/en/about-claude/models/migration-guide) and [Opus 5 prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5).
- The Overview card is the only consumer of briefing data in the SPA. Removing the card also permits removing the briefing query, state, types, component, and dedicated styles from the client without affecting Slack generation.
- The existing deterministic Weekly Review is manually posted and cohort-based. It can remain separate from the scheduled AI weekly briefing without creating another automatic cron.

## Decisions

- **Cadence:** Generate a short daily briefing Monday through Friday and a longer weekly briefing every Monday.
- **Timing:** Keep Monday's weekly briefing at 07:00 UTC. Run weekday daily briefings at 07:30 UTC so Monday's two jobs do not race and the weekly post arrives first.
- **Monday behavior:** Monday intentionally receives two Slack posts. The daily post covers only immediate operational changes since the previous business-day briefing and must not repeat the weekly analysis.
- **Weekly period:** The Monday weekly briefing covers the previous Monday through Sunday and compares only with the prior weekly briefing.
- **Daily continuity:** Daily briefings compare only with the preceding daily briefing; Friday-to-Monday is treated as one business-day interval rather than a missing-weekend gap.
- **Context source:** Add a dashboard-editable `briefing_context` field per campaign. Preload non-empty campaign context, linked hypothesis descriptions, relevant saved-search notes, and recent scoped annotations before investigation.
- **Context attribution:** Treat context as team-provided background, not measured telemetry. Attribute causal explanations to the team context. Without explicit context, report the observed result and say the cause is unknown rather than inventing one.
- **Output shape:** Daily output is a compact operational note with only material changes and zero to two justified actions. Weekly output may include more context and up to three actions. Neither format must fill every section, produce exactly three actions, repeat a KPI strip, or list a risk when there is no actionable risk.
- **Voice:** Apply the humanize principles directly in prompt and verification rules: concrete actors and actions, ordinary Ukrainian, varied rhythm driven by meaning, no stock “leader/weakest link/growth engine” labels, no duplicated conclusion, no padding, and no invented personal detail or certainty.
- **Persistence:** Store daily and weekly briefings separately. Enforce one daily row per UTC date and one weekly row per Monday week key.
- **Manual regeneration:** Keep an internal, admin-guarded regeneration path for recovery. It updates the existing daily or weekly row and never sends another Slack message.
- **UI:** Remove the briefing card and all briefing fetching/rendering from Overview. Campaign context editing lives on Campaign Detail.
- **Model:** Upgrade only the briefing pipeline to `claude-opus-5` and upgrade the Anthropic AI SDK provider to a release that recognizes Opus 5.
- **Weekly Review:** Keep the existing deterministic Weekly Review separate and manually posted.

## Approach

Introduce `daily` and `weekly` as explicit briefing kinds rather than trying to infer format from the day of week. A new migration will add campaign context fields, add briefing kind and reporting-period fields, and replace date-only uniqueness in `briefings` and `briefing_jobs` with composite kind/date keys. Existing rows will be retained as `daily`.

Refactor the briefing generator around a shared pipeline with kind-specific configuration:

- **Daily:** one focused investigation plus validation/structuring, using the previous daily briefing, recent operational data, current queues, sync health, new replies, pending manual imports, and preloaded campaign context. The final Slack payload should normally fit in a headline, a short paragraph or small set of material changes, and at most two actions.
- **Weekly:** retain the deeper risk/growth investigation and fact-checking path, but make it period-aware and less repetitive. It should analyze the completed Monday–Sunday period, respect cohort maturity, compare with the previous weekly briefing, use campaign context before assigning causes, and produce no more than three specific next steps.

Both paths will share deterministic guardrails for cohort framing, source attribution, invite warm-up, manual-message incompleteness, and unsupported causal claims. Context will be rendered as clearly delimited data; text inside it must never be treated as instructions to the model.

Add an admin-guarded `save_campaign_context` action to the existing Playbook endpoint and an editor on Campaign Detail. Reusing that endpoint keeps the deployment within Vercel Hobby's 12-function limit. Saving updates the campaign row and refreshes or optimistically patches the campaign data shown in the page. The context editor will explain that the text is supplied to AI briefings and should capture durable facts such as lead source, re-engagement strategy, account overlap, exclusions, or a temporary experiment.

Make Slack rendering kind-aware. Daily and weekly posts receive distinct fallback titles, section labels, reporting periods, and metadata. Empty sections are omitted. The Monday daily prompt will be given the just-generated weekly content as an anti-duplication reference, but it will compare its metrics only with the preceding daily briefing.

Remove the SPA briefing surface completely: delete the Overview card, stop querying `briefings` in `DataContext`, remove briefing state and types from the client, and remove unused briefing styles. Persistence remains server-side for continuity and operations.

## Implementation phases

1. **Persistence and campaign context — M**
   - Add a new sequential migration with `campaigns.briefing_context`, `briefing_context_updated_at`, briefing kind/reporting-period columns, and composite uniqueness for briefing rows and jobs.
   - Recreate or extend `campaign_metrics` so the campaign context is available to Campaign Detail without changing metric semantics.
   - Update `SCHEMA_DOC` so the AI knows the new fields and their trust level.

2. **Campaign context editor — M**
   - Add an `ADMIN_SECRET`-guarded Playbook action that validates the campaign ID and a bounded plain-text context value without adding another Serverless Function.
   - Add a simple context editor to Campaign Detail with save/error/success behavior and a short explanation of what belongs there.
   - Update campaign types and client data refresh/optimistic state so saved context appears immediately.

3. **Kind-aware briefing pipeline and Opus 5 — L**
   - Extract shared briefing job/key/date helpers and introduce daily/weekly configuration.
   - Build daily and weekly seed windows, prior-kind lookups, context preload, prompt contracts, schemas, and retry behavior.
   - Relax fixed content counts while preserving numeric verification, funnel maturity rules, and factual safeguards.
   - Encode the humanize restraint pass in the generation and verification instructions.
   - Upgrade `@ai-sdk/anthropic`, switch the briefing stages to `claude-opus-5`, and explicitly configure thinking/output behavior for investigation, verification, and structure calls.
   - Keep manual regeneration admin-only and suppress Slack delivery for manual runs.

4. **Slack cadence and presentation — M**
   - Add separate weekday-daily and Monday-weekly cron entries, staggered at 07:30 and 07:00 UTC.
   - Route cron requests explicitly by briefing kind.
   - Render kind-specific Slack headings, periods, labels, and metadata; omit empty sections and the repetitive metrics grid.
   - On Mondays, make the daily job use the weekly output only as an anti-repetition reference.

5. **Remove Overview briefing UI — S**
   - Remove `BriefingCard` from Overview and delete the unused component.
   - Remove briefing queries/state/types and the dedicated briefing CSS from the SPA.
   - Keep server-side storage and Slack delivery intact.

6. **Verification and documentation — M**
   - Add focused tests for week keys, weekday scheduling decisions, kind-scoped prior lookup, Monday anti-duplication input, context attribution, empty optional sections, idempotent manual regeneration, and Slack kind labels.
   - Run the frontend test suite and production build.
   - Update `README.md`, `AGENTS.md`, and in-code comments to describe the two schedules, Opus 5, campaign context, Slack-only delivery, and the distinction from Weekly Review.

## Affected files/modules

- `frontend/api/briefing.ts`
- `frontend/api/_lib/slack.ts`
- `frontend/api/_lib/core.ts`
- `frontend/api/playbook.ts`
- New briefing helper/test modules under `frontend/api/_lib/` as needed
- `frontend/vercel.json`
- `frontend/package.json`
- `frontend/package-lock.json`
- `frontend/src/pages/Overview.tsx`
- `frontend/src/pages/CampaignDetail.tsx`
- `frontend/src/components/BriefingCard.tsx` (remove)
- `frontend/src/lib/DataContext.tsx`
- `frontend/src/lib/types.ts`
- `frontend/src/lib/admin.ts` or the existing admin-write helper call sites
- `frontend/src/styles.css`
- New migration after `supabase/migrations/048_demographics_lifecycle.sql`
- `README.md`
- `AGENTS.md`

## Risks & how to verify

- **Two Monday jobs collide or overwrite each other.** Verify composite kind/date keys with concurrent daily and weekly requests and confirm both rows/jobs persist independently.
- **Monday creates duplicated Slack advice.** Feed the weekly output to the Monday daily prompt as exclusion context and add a fixture proving the daily result does not restate weekly takeaways.
- **A missed weekly cron leaves no briefing for seven days.** Preserve resumable jobs, expose the admin-only no-Slack regeneration path, and test restarting incomplete stages for the same weekly key.
- **Opus 5 provider metadata or structured output differs from Opus 4.8.** Upgrade the provider, pin explicit output/thinking settings, run schema fixtures, and confirm model labels and stored JSON.
- **Human context is mistaken for verified telemetry.** Delimit and label the context, require attribution for causal explanations, and test a campaign with context, without context, and with instruction-like text inside context.
- **Context becomes stale.** Show its last-updated time in Campaign Detail and include that date in the model's context block.
- **Context leaks internal strategy.** Document that campaign context follows the existing anon-readable posture; do not put credentials or sensitive personal data in it.
- **Daily output remains formulaic.** Test output constraints rather than exact wording: no fixed item count, empty sections accepted, no duplicate headline/summary claim, no stock campaign ranking without actionable evidence, and strict length caps.
- **Removing the card breaks the global data load.** Remove the briefing query and error dependency together, then verify Overview, five-minute refreshes, and all existing dashboard routes through the production build.
- **Cron syntax or ordering is wrong.** Validate Vercel's numeric weekday expressions and inspect the deployed cron list: weekly Monday 07:00 UTC; daily Monday–Friday 07:30 UTC; no Saturday/Sunday runs.

## Definition of done

- Slack receives one short daily briefing Monday–Friday and one longer weekly briefing every Monday; nothing is generated on Saturday or Sunday.
- Monday's daily and weekly runs persist separately and do not overwrite or race each other.
- The weekly briefing covers the completed Monday–Sunday period; daily and weekly comparisons use only their own prior kind.
- A campaign's team-entered context is editable from Campaign Detail and is always preloaded into briefing generation.
- The model attributes supplied causal context and does not invent a cause when context is absent.
- Briefing generation and stored model metadata use `claude-opus-5` with a compatible Anthropic provider.
- Daily and weekly Slack output is natural, concise Ukrainian, omits empty/filler sections, and contains only justified actions.
- The Monday daily message does not repeat the longer weekly analysis.
- The Overview page contains no briefing card and the SPA no longer fetches briefing rows.
- Manual regeneration is admin-guarded, idempotent per kind/period, and does not post to Slack.
- The existing manual Weekly Review is unchanged.
- New focused tests, the full frontend test suite, and `npm run build` pass.
- Repository documentation matches the new cadence, context source, model, and Slack-only behavior.
