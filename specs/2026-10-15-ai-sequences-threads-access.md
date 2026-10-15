# AI: full view of sequences, threads and reply labels

## Context

The copilot (`frontend/api/chat.ts`), the MCP server (`mcp.ts`) and the Slack briefing (`briefing.ts`) all reason
over the database through `ai_execute_sql`, the SELECT-only guard owned by `app_ai_runner`. Exploration found
three gaps between what the team sees and what the AI can see:

1. **Reply labels are invisible (bug).** Ledger step 017 granted the reply-review tables only to
   `app_runtime`/`app_readonly`. `SCHEMA_DOC` (`core.ts:538-583`) calls `reply_reviews` the source of truth, and the
   briefing seed queries at `briefing.ts:152` and `:164` join it. Those queries always fail on permission, so every
   briefing runs without them.
2. **Sequences are only half-visible.** The AI reads `campaign_steps.template_body`, but that is LH2 variant 0
   only. Sequence Builder documents (all variations and A/B/C branches), publish lineage and
   `campaign_sequence_links` sit outside the allowlist (`core.ts:418-437`).
3. **Threads are awkward to read.** Message bodies are readable, but the model has to rebuild a thread with SQL,
   and results are cut off at 24k characters (`core.ts:33-50`). No tool returns "this conversation" or "every reply
   in this campaign" in readable form. Contact names (`conversation_contacts`) are unreadable.

On top of that, no sent message is linked to the step or variation that produced it. So "variant B of step 2
gets twice the replies" cannot be answered. The owner chose **server-side matching** to close that gap.

Outcome: the AI can read the whole picture. That means what we send (every step and variation), what we actually
sent to each person, the full thread, the team's labels, and per-variation reply performance.

Out of scope, by the owner's choice: page-aware "Ask AI" buttons, and AI copy review inside the Builder. AI reply
classification stays retired; labels remain manual-only.

## Phase 0 — Save the plan
Copy this plan to `specs/2026-10-15-ai-sequences-threads-access.md`, as AGENTS.md requires for planning output.

## Phase 1 — Ledger step 023: AI read grants (fixes the label bug)

New file `postgres/tenant-baseline/v1/023_ai_read_sequences_reviews.sql`, plus its `ledger.manifest.json` entry. It
mirrors the grant and policy pattern at `003_functions_triggers_ai_guard.sql:1192-1265`:
`GRANT SELECT … TO app_ai_runner` plus `CREATE POLICY <t>_ai_read … FOR SELECT TO app_ai_runner USING (true)`
for:
- `reply_reviews`, `reply_review_reasons`, `conversation_reply_review_state`
- `conversation_contacts`
- `sequence_documents`, `sequence_versions`, `sequence_publish_jobs`, `sequence_publish_branches`,
  `campaign_sequence_links`

Comments, publish targets/contracts, mutations/events and identity stay excluded. Before writing the grants, check
each table for a credential or email column and use a column-list grant where one exists, as `instances` and
`team_members` already do.

- Add 023 to the static-assertion lists the same way 022 was added
  (`postgres/tests/portable_migration_ledger_static_assertions.mjs:142`). Follow its rule on when a step joins
  `PROTECTED_PATHS`.
- Before applying, grep the tests for anything asserting that the AI *cannot* read these relations. Memory
  "applied-step-invalidates-its-own-tests" applies.
- Apply with the ledger runner (Docker psql recipe in memory). This changes production, so ask the owner before
  applying. The step must be applied **before** the Vercel deploy that relies on it.

## Phase 2 — Thread and sequence tools

### Parameterised named queries
In `frontend/api/_lib/data/operations/ai.ts`, add builders next to `AI_OPERATIONS`. The guard takes only SQL text,
so add a `sqlLiteral()` helper that doubles `'` and rejects NUL, with unit tests. Arguments go in as literals.
The blast radius is unchanged: the result is still one guarded SELECT, exactly like `run_sql`.

Extend `executeNamedSql` (`core.ts:33-61`) with an optional `maxChars` so transcript tools can return about 60k
characters. The default stays 24k.

### New tools in `frontend/api/_lib/tools.ts`
Add each to `toolDefs` and wire it into `buildTools` and `mcp.ts`, so all three surfaces stay in sync.

**`get_sequence({ campaign_id? , sequence_id? })`**
Returns a readable outline:
- source (Builder document or LH2-native)
- steps in order, with **every variation's text**
- branches, and which notebook/campaign each was deployed to (from publish branches and links)
- the per-step `sent_count`/`replied_count` from `campaign_steps`
- once Phase 3 lands, per-variation performance

Notes:
- Builder text uses `{firstName}` (`frontend/src/lib/sequenceBuilder.ts:379`); LH2 templates use `{{firstName}}`.
  Show both as-is.
- Reuse the hub/link resolution logic in `operations/sequenceHub.ts` for the campaign→document mapping. Do not
  re-derive it.

**`get_thread({ instance_id, profile_url })`**
Returns one compact transcript. The header holds:
- name and headline (from `leads`, falling back to `conversation_contacts`)
- campaign and hypothesis
- milestones
- follow-up state and `do_not_contact`
- review labels on inbound messages

Then the messages, in chronological order, one per line:

    [2026-09-01 10:22 OUT · step 2/B] body

- Message cap: 120 messages.
- Body cap: 2000 characters per message.
- Flag `source='manual'` messages.
- Flag legacy rows whose `sent_at` is an action-run time (rows with no `external_id`).
- Scope by `instance_id` (the `leadKey` rule).

**`campaign_conversations({ campaign_id, only_replied = true, since?, limit ≤ 40 })`**
The "read every reply in this campaign" view. For each thread:
- our last outbound before the reply
- the inbound reply or replies
- the label
- the thread key, so the model can call `get_thread` for detail

**`search_messages({ text, direction?, campaign_id?, since?, limit ≤ 50 })`**
- An `ILIKE` search over `body`.
- Returns a snippet, the direction, the date and the thread key.

### Schema doc and prompts
`SCHEMA_DOC` in `core.ts`:
- Replace the "outside the allowlist / do not query" text at `:418-437` with the real columns and the
  document/variation jsonb shape.
- Mark `reply_reviews` and the others as readable.
- Document `conversation_contacts`, `messages.first_seen_at` and the `campaigns.runtime_status` columns.
- Keep the warning that a draft is not proof anything was sent: only publish lineage proves deployment.

In the system prompt in `chat.ts` and the analyst prompt in `briefing.ts`, add short guidance:
- For questions about copy, use `get_sequence` first.
- For reply content, use `campaign_conversations` / `get_thread`.
- Keep the existing cohort-maturity rule when comparing variations.

## Phase 3 — Server-side step/variation attribution

### 3a. Measure first (read-only, production)
Prototype the matcher as one SELECT through the prod read-only analytics path (memory
"prod-readonly-analytics-path"):
- Normalise both sides: lower-case, collapse whitespace, trim.
- Turn each template into an anchored regex: escape literal text, then replace each `{{var}}`/`{var}` with
  `.{0,120}?`.
- Fallback when the regex misses: the first 60 normalised literal characters match.

Candidate templates for a message:
- first, the steps of the message's own `campaign_id`
- then the templates of every campaign that lead sat in on the same instance. This also covers chat-store rows
  whose `campaign_id` is a guess or NULL.

Builder campaigns take their variation texts from `sequence_publish_branches.compiled_action_chain`, which gives
step, branch and variation.

Record three numbers on the full corpus: match rate, ambiguous-match rate, and runtime.
- **Gate:** if outbound coverage is low (roughly under 70%), stop and report to the owner before building.
- Known cause of misses: LH2-native steps keep only variant 0, so other variants won't match. Fixing that means
  an agent change (syncing all variants), which would be a follow-up.

### 3b. Ledger step 024
Choose the form from the runtime measured in 3a:
- **Plain view** `message_step_attribution`, if the full-corpus query runs in about 1.5 seconds or less. There is
  no write path and no refresh, and template edits are picked up automatically.
- **Otherwise, a table** filled by a `SECURITY DEFINER` function `refresh_message_step_attribution(p_instance)`.
  `app_system` calls it after each `agent.ingest` batch, and the daily `/api/classify` cron runs it as a sweep.

Columns: `message_id`, `instance_id`, `profile_url`, `attributed_campaign_id`, `step_index`, `branch_letter`,
`variation_id`/`label` (Builder only), `method` (`regex` | `prefix`), `ambiguous` (bool).

Add the view `step_variant_performance`, one row per campaign × step × branch × variation, with:
- `sent`
- `replied`: an inbound message arrived after this outbound and before the next outbound in the same thread
- `mature_sent` / `mature_replied`: outbound older than 14 days
- `positive`, from `reply_reviews`
- `p3`

Grant both to `app_ai_runner`, document both in `SCHEMA_DOC`, and surface them in `get_sequence` and
`get_thread` (the "step 2/B" tag).

Keep the agent's `derive_events` and the funnel views unchanged. Attribution is an additional layer, not a
change to funnel semantics.

## Critical files
- `postgres/tenant-baseline/v1/023_*.sql`, `024_*.sql`, `ledger.manifest.json`, `postgres/tests/portable_migration_ledger_static_assertions.mjs`
- `frontend/api/_lib/data/operations/ai.ts`: new named-query builders and `sqlLiteral`
- `frontend/api/_lib/core.ts`: `executeNamedSql` `maxChars`, `SCHEMA_DOC`
- `frontend/api/_lib/tools.ts`, `frontend/api/mcp.ts`, `frontend/api/chat.ts`, `frontend/api/briefing.ts`
- Reuse `operations/sequenceHub.ts` (campaign↔document resolution) and `leadKey`
- For Phase 3b, if it becomes a table: `operations/agentIngest.ts`, `frontend/api/classify.ts`

## Verification
- Run `npm test`, `npm run typecheck:api` and `npm run build` in `frontend/`.
- Add unit tests for:
  - `sqlLiteral`, including quote and NUL inputs
  - the transcript formatter
  - the tool parity between chat and MCP
  - the template→regex conversion
- Run `node postgres/tests/portable_migration_ledger_static_assertions.mjs`.
- Grammar-check the new SQL offline with libpg-query (memory "offline-sql-grammar-check").
- After 023 is applied, run every new tool's SQL through `ai_execute_sql` on prod via the read-only path:
  - pick a known replied thread, and check `get_thread` against what the Replies page shows
  - check `get_sequence` on one Builder campaign and one LH2-native campaign
- Confirm the briefing seed rows that join `reply_reviews` no longer read `(query failed`. Trigger the admin
  briefing POST, or inspect the next `briefing_jobs` row.
- Phase 3: check 20 hand-picked outbound messages, attribution against what was actually sent. Report coverage
  and the ambiguous rate.
- Deploy order: apply ledger step → Vercel deploy. Then ask in the live copilot: "Which step-2 variant in
  <campaign> gets the most replies? Show me two of those threads." This needs a signed-in member, so the owner
  runs it.
- Commit in logical pieces: grants step, tools plus schema doc, attribution.

## Status (2026-10-15)

Built on `main`. Not applied to any database, not deployed.

- **Phase 1:** ledger step 023 is written.
- **Phase 2:** the four context tools are wired into chat, MCP and the briefing. They live in
  `frontend/api/_lib/aiContext.ts` and `frontend/api/_lib/data/operations/aiContext.ts`.
- **Phase 3a** was measured read-only on production through the guard:
  - 13,271 outbound messages in total; 9,320 of them went to campaign leads.
  - **8,735 matched a template (94% of lead outbound).**
  - 100 matched more than one step (about 1%).
  - Unmatched messages are mostly hand-typed, plus LH2 variants that were never synced.
  - The full-corpus match took 9.3 s. That is too slow for a view under the guard's 10 s limit, so this
    became the table form.
  - A notebook-1 dry run took 4.3 s. All 20 sampled matches were correct by hand check.
- **Phase 3b:** ledger step 024 is written.
  - Contents: the `message_step_attribution` table, `refresh_message_step_attribution`, and the
    `step_attribution_performance` view.
  - Incremental refresh runs after each sync ping (`/api/notify-replies` POST). A full refresh runs in the
    daily `/api/classify` cron.
  - `get_thread` tags each outbound line with its step. `get_sequence` shows matched per-step performance.

### Rollout order (owner approval needed for each)
1. Apply ledger steps 023 and 024 to production as `app_migration`.
   - The memory recipe is "neon-ledger-apply-needs-docker-psql".
   - Steps 023 and 024 must be applied **before** the deploy: the tools join tables and views they create.
2. Deploy to Vercel. The first sync ping after the deploy fills the attribution cache. A full pass on
   prod is about 10 s across all instances.
3. Run the plan's verification checks on prod:
   - `get_thread` against the Replies page
   - `get_sequence` on one Builder campaign and one LH2-native campaign
   - the briefing seed no longer reads `(query failed`
4. In the next session, promote 023 and 024 to `PROTECTED_PATHS`.

### Follow-ups
- Sync every LH2 variant of a step, not only variant 0. This needs an agent change and would raise
  coverage for LH2-native A/B steps.
