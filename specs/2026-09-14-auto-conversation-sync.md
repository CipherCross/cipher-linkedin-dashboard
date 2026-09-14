# Automatic full-conversation sync from LinkedIn

Status: **Phase 1 BUILT on branch `conversation-sync-phase1` (2026-09-14,
uncommitted at time of writing; see "Phase 1 rollout checklist"). Phase 2 is
designed, waits on probe #4 and on Phase 1 being live.** Nothing is implemented. Probe ran on notebook-1 on 2026-09-14; fleet is Windows 10/11, all on
the latest LH2 build (2.130.36), LinkedIn Premium + Sales Navigator, LH2 PRO.

## Problem

The agent's `MESSAGES_SQL` reads `action_result_messages → messages` in `lh.db`.
Those rows exist only for messages an LH2 campaign action itself sent or detected
(`InvitePerson`, `MessageToPerson`, `CheckForReplies`). Once a lead replies they
leave the campaign, LH2 stops looking at that thread, and the dashboard shows a
truncated conversation exactly when the SDR needs the whole of it. The manual
"Import history" paste flow (`parseLinkedInThread.ts` → `/api/import-conversation`)
fills the gap by hand and does not scale.

## What the probe found (notebook-1, account 524650)

**1. LH2 already keeps a real chat store that we never read.**
`chats` (2,544, all `one-to-one`, platform `linkedin`), `chat_participants` (2 per
chat; the SDR is `person_id=231` in every chat), `participant_messages` →
`messages` (5,028 rows with `message_text`, `type` DEFAULT/MEMBER_TO_MEMBER/EDITED/
RECALLED and a **real LinkedIn `send_at`**, distinct from LH2's `created_at`),
`message_external_ids` (3,713 opaque LinkedIn message ids), `chat_external_ids`
(673 conversation ids), `chat_meta` (`last_check_date`,
`last_attempt_to_actualize_date`), `chat_messages_cursor` (read cursors).

| | count |
|---|---:|
| messages in `lh.db` | 5,028 |
| …referenced by `action_result_messages` (what we sync today) | 3,569 |
| …**unreferenced, invisible to the dashboard** | **1,459** (512 inbound, 947 outbound) |
| persons who replied through a campaign | 186 |
| …no longer active in any campaign | 186 (100%) |
| …with no new message in `lh.db` for 30+ days | 168 (90%) |

**2. How rows get into that store (LH2 support docs, verified against the DB).**
LH2 scrapes the *whole visible chat* whenever it is about to send a message,
whenever `CheckForReplies` looks at a thread, and when a dedicated
"Scrape messaging history" action processes a person. It scrapes **once per
processing**; nothing is auto-updated afterwards. To refresh a thread, the person
must be re-queued (or "retried") in an action and the campaign started. The
regular LinkedIn inbox and the Sales Navigator inbox are separate; a scrape covers
only the platform the person is processed on. Group chats and attachments are not
scraped (attachments are noted as present). Sources:
[Scrape messaging history](https://support.linkedhelper.com/hc/en-us/articles/9025165336978-Scrape-messaging-history),
[template](https://support.linkedhelper.com/hc/en-us/articles/10800392864402-Scrape-messaging-history-template),
[Inbox menu](https://support.linkedhelper.com/hc/en-us/articles/5422237843218-Linked-Helper-Inbox-menu),
[Messaging history](https://support.linkedhelper.com/hc/en-us/articles/360022104220-Messaging-history-in-Linked-Helper),
[Check for replies](https://support.linkedhelper.com/hc/en-us/articles/360017905660-Check-for-replies).
The operator confirms the "Scrape messaging history" action is installed as a
campaign plugin; the Inbox plug-in is not.

**3. CDP.** LH2's DevTools port (ephemeral, 53789 today; `config.yaml` says 52153)
lists a `page` target at `https://www.linkedin.com` (title "(15) Messaging |
LinkedIn" — LH2 parks its browser on the messaging view) alongside the `file://`
app renderer. The renderer exposes `mainWindowService.mainWindow.source.people.
messages` (`getChats`, `getChatsMessagesByPersonId`, `getInboxMessagesInfo`,
read-cursor setters, …), `draftMessages`, `chatPendingMessages` (`scheduleChats`,
`markAsSend`) and `tasks.*SendChatPendingMessages*`. All of these read or write
the local DB; no method name suggests "fetch this chat from LinkedIn now".
Electron 39.5 / Chromium 142; `window.require` is available in the renderer.

**4. Gateway/DB constraints that shape any solution.**
- `messages_identity_key = (instance_id, profile_url, direction, sent_at, content_hash)`.
  Today `sent_at` is the LH2 *run* time. Any source that supplies the real send
  time re-keys every existing row, so the switch needs a one-time re-key that
  carries `sentiment`, `intent_*`, `notified_at`, `sentiment_manual` over.
- Manual rows dedup by direction + normalized body; a full sync makes most manual
  rows redundant and must not double them.
- `notify-replies` posts every inbound `source='sync'` row with `notified_at IS
  NULL` younger than 14 days. A backfill of 512 old inbound rows must be stamped
  before the ping, not announced.
- The tenant baseline is append-only; new columns are a new ledger step after 013
  (the runtime-status spec already claims 014 — coordinate numbering).

## Candidate paths

### A. Read LH2's chat store instead of `action_result_messages`
Replace `MESSAGES_SQL` with a query over `chats → chat_participants →
participant_messages → messages (+ message_external_ids)`, direction = participant
`person_id` ≠ the account's own person, slug via `PEI_ONE_SLUG_SQL`, `sent_at =
messages.send_at`, external message id as the stable identity.

- **+** Recovers the 29 % of messages we already have on disk (incl. 512 inbound),
  real timestamps, EDITED/RECALLED handling, and a stable per-message id that
  retires the `created_at`-window dedup hack.
- **+** Zero new LinkedIn traffic, zero LH2 mutation, zero detection risk. Agent
  release + one ledger step + one re-key migration.
- **+** Also captures the SDR's *pre-campaign* manual history for anyone LH2 ever
  processed (LH2 scrapes the whole chat).
- **−** Does **not** keep threads fresh after the lead leaves the campaign. It is
  the floor every other path builds on, not the answer alone.
- **−** Campaign attribution is lost for chat rows (chats are per person, not per
  campaign): `campaign_id` NULL or inferred from `person_in_campaigns_history`.
- **−** Regular-LinkedIn inbox only, unless SN chats are also scraped by LH2.

### B. LH2-native refresh: a "Conversation tracker" campaign re-queued by the agent
One paused-by-default campaign per notebook whose only action is "Scrape messaging
history" (published through the existing publisher). After each sync the agent
enqueues the leads whose threads should be refreshed (replied + left campaign,
or recently active) through LH2's renderer API, LH2 does the scraping during its
own working hours and throttling, and path A picks the rows up on the next sync.

- **+** LinkedIn only ever sees LH2 doing what LH2 does; rate limits, working
  hours and daily credits stay LH2's problem. No new API to reverse-engineer.
- **+** Data lands in the same tables as A; no second ingestion shape.
- **−** Each refresh opens the chat and scrolls to the very beginning: minutes per
  person, serialized in LH2's single queue, competing with outreach campaigns for
  the daily working window. 186 people/notebook cannot be refreshed daily; needs a
  priority policy (e.g. P3/P2 threads, replied < 60 d, SDR-flagged) and accepts
  hours-to-days latency.
- **−** Needs a *mutating* LH2 internal call (add-to-queue / retry). The publisher
  work showed these APIs have undocumented truthiness rules and a verifier gap;
  a follow-up read-only probe of `source.people.campaigns` / `actions` method names
  is required before committing.
- **−** Visible campaign in every LH2 UI; an operator can pause or delete it.
- **−** Does not see SN-inbox threads unless a second action with Override
  platform is added (doubles the cost).

### C1. Active: read LinkedIn's messaging API from inside LH2's logged-in page
`Runtime.evaluate` a `fetch()` against the Voyager messaging endpoints in the
existing `https://www.linkedin.com` target (same cookies, same fingerprint, same
process LH2 already uses), incremental by conversation `lastActivityAt`, and
deliver the delta through the existing ingest contract.

- **+** The only path that is *complete*: every thread, every device the SDR
  replied from, independent of campaign membership, fresh at every sync.
- **+** Cheap per sync: one conversation-list page plus one call per thread that
  changed. Runs inside the agent's existing 30-minute cadence; no resident process.
- **−** Direct, non-LH2 traffic on the SDR's real account. Even though it shares
  LH2's session, it is extra API volume without matching UI navigation, and
  LinkedIn's anti-automation (the `li.protechts.net` iframe is in the page) is a
  black box. Account restriction is a business risk the owner must accept.
- **−** Undocumented API: Voyager GraphQL query ids rotate; each rotation breaks
  sync until someone re-derives them (LH2 has a paid team for exactly this).
- **−** Reverses a deliberate agent policy (`discover_cdp_target` refuses http(s)
  targets). Needs its own security profile, opt-in per notebook, hard budgets
  (calls/sync, threads/sync, working hours only, jitter, back-off on 4xx/429).
- **−** Sales Navigator inbox is a different API (`/sales-api/…`); second adapter.
- **−** Concurrency with LH2: an evaluate during LH2's own navigation fails or
  observes a half-loaded page; must be retry-safe and never block LH2.

### C2. Passive: capture LinkedIn messaging responses LH2 already receives
Attach to the same target with `Network.enable` and record Voyager messaging
response bodies as they happen (when LH2 scrapes, when anyone uses the embedded
messaging view).

- **+** Adds zero requests to LinkedIn; strictly observational.
- **−** Covers only what is browsed anyway — for threads that left the campaign,
  that is exactly nothing unless combined with B. Needs a resident listener
  (service/Task Scheduler "always on"), not a cron run. Not worth building alone.

### D. LH2 renderer messaging service (`people.messages`) as the data source
- **−** Same rows as A, read through an undocumented API instead of `mode=ro`
  SQLite. No advantage; rejected. (Its `setChatReadCursor` / `chatPendingMessages`
  surface is interesting for a later "reply from the dashboard" feature, not for
  sync.)

### E. Separate logged-in browser or cookie reuse from Python
- **−** Second session/fingerprint per LinkedIn account: the highest detection
  risk of all. Rejected.

## Decisions taken (owner, 2026-09-14)

1. **No direct LinkedIn API calls from the agent, even read-only, even inside
   LH2's own session.** C1 is rejected on account-risk grounds; C2 is not built.
   Phase 2 is **B**.
2. **Regular LinkedIn messaging only.** SDRs do not converse in the Sales
   Navigator inbox; no second platform adapter, no Override-platform action.
3. **SDRs reply by hand inside LH2's embedded LinkedIn browser.** LH2 does not
   persist those replies (only actions scrape), so the tracker campaign is the
   mechanism that brings them into `lh.db`.

## Recommendation

**Phase 1 — Path A now (no-regret).** It fixes timestamps and dedup identity and
recovers 29 % of stored history with no risk. Phase 2 writes into the same shape.

**Phase 2 — Path B: an agent-driven LH2 "Conversation tracker" campaign.** LH2
does every LinkedIn interaction; the agent only decides *who* to refresh and
*when*, within a daily cap, and reads the result back through Phase 1.

**Phase 3 — demote manual import** to an explicit fallback (attachments, group
chats) and show sync coverage per thread in the UI.

## Implementation phases

### Phase 1 — chat-store extraction (agent + ledger + re-key)
1. **Agent (`agent.py`, new minor release).**
   - `CHAT_MESSAGES_SQL`: one row per `participant_messages` row joined to
     `messages`, `chat_participants`, `chats` (filter `type='one-to-one'`), the
     one-slug-per-person dedup for the *other* participant, `message_external_ids`
     LEFT JOIN for `external_id`, `chats.platform` as `platform`. Direction: own
     account's `person_id` resolved from `li_accounts`/`lh_users` → people, falling
     back to "the participant present in every chat"; abort extraction (not the
     sync) if neither resolves to exactly one id.
   - Keep `MESSAGES_SQL` as the fallback when the chat tables are absent (older
     builds / uitop), selected by schema fingerprint like `_extract_v1/_v2`.
   - `sent_at = messages.send_at`; body = `message_text`; `RECALLED` rows → body
     `null` + `message_type`; `EDITED` rows supersede by external id.
   - Campaign attribution: latest campaign the person was processed in
     (`person_in_campaigns_history`), else NULL. Document as a heuristic.
   - Dry-run prints per-notebook: chat rows, unreferenced recovered, inbound/
     outbound, own person id, sample redacted rows. Compare against the probe's
     numbers before the first real sync.
2. **Ingest contract (`ingest.ts` + transport tests).** Optional fields
   `external_id` (≤128), `platform` (`linkedin|sales_navigator|recruiter`),
   `message_type`. Existing agents that omit them keep working.
3. **Ledger step (next free number).** `messages.external_id text`,
   `messages.platform text`, `messages.message_type text`; partial unique index on
   `(instance_id, external_id) WHERE external_id IS NOT NULL`; `app_machine` grant
   unchanged (same table). Update `SCHEMA_DOC`.
4. **Re-key migration (one-shot, per tenant, in the gateway as an admin op or a
   scripted `test:neon`-style runner — not a ledger step).** For every existing
   `source='sync'` row find the new row by `(instance_id, profile_url, direction,
   normalized body)` within ±14 days; move `sentiment`, `intent_*`,
   `intent_taxonomy_version`, `sentiment_manual`, `notified_at`, `reviewed_*` to
   the new row; delete the old row. Unmatched old rows stay. Manual rows matching
   a new sync row by the same rule are deleted (their milestone contribution is
   already durable via `leads_keep_milestones`). Run against the fixture DB first.
5. **Notify guard.** The first chat-store sync per notebook stamps every inbound
   row older than the notebook's last successful sync with `notified_at = now()`
   before the ping; nothing historic reaches Slack.
6. **Verify** on notebook-1: dry-run counts = probe counts (5,028 / 1,459 / 512);
   dashboard conversation for three known truncated threads shows the recovered
   messages; `npm run build`, transport tests, `test:neon` twice.

### Phase 1 rollout checklist (what was built, what is left)

Built and green locally (offline vitest 1210/1210, transport tests 187/187,
`typecheck:api`, `npm run build`, ledger static assertions 262/262):

- `postgres/tenant-baseline/v1/019_messages_chat_store_identity.sql` + manifest
  step 19 + static assertions (promote 019 to `PROTECTED_PATHS`/immutable list in
  the session AFTER it is applied live, per the file's own rule).
- `ingest.ts`: `MessageRow` += `external_id`, `platform`, `message_type`
  (validated; absent → null).
- `agentIngest.ts` `upsertMessagesOperation`: one CTE statement — adopt legacy
  rows (exact hash, or normalized-body for manual rows, sent_at −1 d…+45 d),
  insert keyed rows on `(instance_id, external_id)`, legacy rows on the identity
  key. Labels and `notified_at` never written.
- `aiSystem.ts` notify candidates skip inbound rows with a later outbound in the
  same thread (backfill guard).
- `core.ts` `SCHEMA_DOC`: new columns, revised blind-spot wording.
- `agent.py` 1.25.0: `chat_store_profile`, `own_person_id`,
  `extract_chat_messages`, `extract_conversations` (fallback to legacy),
  dry-run "conversations" block, `_supabase_messages` strip, dedupe/parity on
  `external_id`.

Left, in order — **the gateway statement names the 019 columns unconditionally,
so every ingest 500s between deploying the gateway and applying 019**:

1. Commit + push the branch (owner's call).
2. Apply step 019 to every live tenant with the ledger runner (`apply` as
   `app_migration`; no `psql`/Docker on this machine today — `brew install
   libpq` or the Docker wrapper from the platform-ops recipe).
3. Deploy the gateway from the branch (or after merge).
4. Dry-run the new agent on notebook-1 (prompt below) and compare the
   "conversations" block with the probe: 5,028 rows, 512 inbound unreferenced,
   own person 231. Only then `deploy.sh` 1.25.0 (bump `installer/release.json`
   first; `tests/test_installers.py` is the gate).
5. After the first real sync: spot-check three previously truncated threads in
   the dashboard; confirm Slack got no backfill storm; run `test:neon` twice.
6. Next session: promote 019 to the immutable list.

#### Notebook-1 dry-run prompt (paste into its Claude Code once the branch is pushed)

═══════════════════════════════════════════════════════════════════════════════

Dry-run a NEW agent build without installing it. Do not touch the installed
`agent.py`, `config.yaml`, the scheduler, or LH2. Nothing is pushed anywhere
(`--dry-run` extracts and prints; it makes no network writes).

1. In the `sync-agent` folder create `dryrun/` and download the candidate into
   it: `<AGENT_PY_URL>` → `dryrun/agent.py`. Verify its SHA-256 equals
   `<AGENT_PY_SHA256>`; stop if it does not.
2. Copy the installed `config.yaml` next to it (read-only use; do not edit).
3. Run `..\.venv\Scripts\python.exe agent.py sync --dry-run` from `dryrun/`
   and capture the full output to `dryrun/dry-run.txt`.
4. Report: the "conversations" block verbatim (source, own person id, totals,
   inbound/outbound, li:/lh: counts, threads, unattributed, samples, fallback
   reason if any), the per-campaign counts block, and every WARNING or
   traceback. Then delete `dryrun/config.yaml`.

═══════════════════════════════════════════════════════════════════════════════

### Phase 2 — LH2 "Conversation tracker" campaign (Path B)

#### What probe #2 established (notebook-1, 2026-09-14)

- The scraper is `actionType = 'ScrapeMessagingHistory'`, `actionSettings = {}`,
  `coolDown = 60000`, `maxActionResultsPerIteration = 10`. One config exists (id
  350) from archived campaign 4; no active campaign uses it. It is a main-process
  plugin: absent from the renderer's `configs` registry, present only as the
  string in `action_configs`.
- Renderer service methods are proxies into `@linked-helper/source-manager`
  (loaded via `window.require`; probe #2 read them as Electron IPC thunks, probe
  #3 found the renderer calls the module directly through a `callWrite(path,
  ...args)` dispatcher). Either way: callable through CDP in the app renderer,
  **arity and body not observable** — signatures come from the renderer
  bundle's own call sites (probe #3 below). Action implementations are V8
  bytecode (`.jsc`) and cannot be read.
- Candidate mutators, by purpose:
  - first-time add by LinkedIn URL: `people.campaigns.importPeopleFromUrls`,
    `people.actions.importPeopleFromUrls`;
  - re-queue already-processed people: `people.actions.retryPeople`
    (person × action) or `campaigns.retryCampaign`; `retryPeopleCampaign` is
    listed on the proxy but **never called by LH2's own UI** — do not use it;
    `people.actions.ignoreRepliedAndAddToQueue` for people LH2 flagged as replied;
  - run control: `campaigns.setCampaignPaused` / `isCampaignPaused` (already
    used by the publisher), `isCampaignStandByModeActive`;
  - readback: `people.actions.getActionVersionTargetCount`,
    `getActionsQueuedPeopleMap`, `people.campaigns.getCampaignPeopleCount`.
- Queue state lives in `action_target_people.state`: `1` waiting, `2`
  processed, `-1` failed/skipped (mirrored by
  `person_in_campaigns_history.action_add_to_target_state`). A successful
  enqueue is therefore verifiable from `lh.db` in `mode=ro`, the same way
  publish verification works today.
- Working hours are per action rows in `working_intervals`
  (`working_week_day` 0=Mon, `day_and_night`, `started_at`/`ended_at` minutes
  from midnight). `daily_limits.max_limit = 150` actions/day for the account,
  shared by every campaign.
- Untested by the operator: behaviour of a Running campaign with an empty queue;
  whether re-adding a processed person needs Retry or Add-to-Queue. The design
  below does not depend on either answer.

#### Signatures (probe #3, from the v2.130.36 renderer bundle)

| Call (`callWrite`/`callRead` path) | Arguments | Returns |
|---|---|---|
| `people.actions.importPeopleFromUrls` | `(actionId, 0, urlsNewlineJoined /*≤100*/, true, liAccountId)` | `[imported[], {total:{addToTarget:{alreadyInQueue, alreadyProcessed, inExcludeList, successful}, excludeList:{added}}}]` |
| `people.campaigns.importPeopleFromUrls` | `(campaignId, 0, urls, true, liAccountId)` | same |
| `people.actions.retryPeople` | `(actionId, {request:{...filterRequest, action: undefined}, filter, ...selection})` — envelope built by the UI's list-filter helpers (`L.Ps`, `L.NA`) | `void` |
| `people.actions.ignoreRepliedAndAddToQueue` | `({request:{..., action, actionCollectionType:'replied'}, type:'people', filter, ...selection})` | `{campaignId}` |
| `people.actions.getActionVersionTargetCount` | `(actionVersionId)` | `number` (queue size) |
| `people.actions.getActionVersionTargetPeople` | `(actionVersionId, from, to)` | people slice |
| `campaigns.setCampaignPaused` / `isCampaignPaused` | `(campaignId, paused, liAccountId)` / `(campaignId, liAccountId)` | `void` / `bool` |
| `workingHours.saveWorkingHours` | `(schedule, {type:'action', campaignId, actionId}, liAccountId)`; `schedule` = `{0..6: true \| false \| [{start:[h,m], end:[h,m]}]}` | `void` |

Wizard-generated scraper action: `{ target: [], excludeList: [], config:
{ actionType: 'ScrapeMessagingHistory', actionSettings: {}, coolDown: 60000,
maxActionResultsPerIteration: 10, overridePlatform } }` (a second-platform
variant uses `coolDown: 30 min, maxActionResultsPerIteration: 30`). Delay
profile key `ScrapeMessagingHistoryLi`.

Two facts that change the design:
- **`importPeopleFromUrls` does not re-add processed people** (it reports them as
  `alreadyProcessed`). Re-queue therefore needs either `retryPeople` with a
  selection envelope, or emptying the tracker's Processed list
  (`campaigns.removeFromCampaignList` / `actions.removeFromList`) so a plain
  re-import works. The envelope helpers and the remove signature are the one
  remaining read-only grep (step 0 below).
- **Credits:** the scraper has no `limit_types` row of its own; it charges
  profile/page-load credits, **not** the Invite/Message budgets. Raising the daily
  cap does not eat outreach capacity; it costs LH2 wall-clock time and page loads.
- Weekday indexing disagrees between sources (DB sample says 0 = Sunday, probe #2
  read 0 = Monday). Verify against a known campaign's schedule in the pilot before
  writing the tracker's hours.

#### Design

0. **Last read-only grep (notebook-1, same extraction as probe #3).** Bodies of
   the helpers the sagas call as `(0,L.Ps)(payload)` and `(0,L.NA)(selection)`
   (they build the `retryPeople` envelope), and the call sites of
   `campaigns.removeFromCampaignList` and `actions.removeFromList` (argument
   shape). Also confirm which weekday index the `working_intervals` rows of a
   known Mon–Fri campaign carry.
1. **Campaign.** One paused campaign per notebook, `Conversation tracker
   (dashboard)`, single action `ScrapeMessagingHistory` with `{}` settings,
   created through `LinkedHelperPublisher` and verified by the existing readback
   rules (`is_valid`, exclude lists `[]` at both levels, zero targets). Its
   `working_intervals` are written at creation via
   `workingHours.saveWorkingHours(schedule, {type:'action', campaignId,
   actionId}, liAccountId)` to the SDR's daytime window (remote-config
   `tracker_hours`, default Mon–Fri 09:00–18:00 local): LH2 then enforces hours
   and the agent needs no clock logic. The agent stores the
   tracker's LH2 campaign id in `config.yaml` (`conversation_tracker.campaign_id`)
   and reports it to the dashboard; **it is appended to `exclude_campaigns`
   automatically** so the tracker never appears as a campaign, never creates lead
   rows, and never counts in the funnel. Phase 1's campaign-attribution heuristic
   skips excluded campaigns.
2. **Refresh policy (agent, after each successful sync).** Candidates = this
   instance's leads with any inbound message whose latest known message
   (`max(messages.send_at)` from the chat store) is older than
   `refresh_after_days` (default 3) and whose tracker `chat_meta.last_check_date`
   is older than the same. Priority: intent P3 > P2 > P1 > unlabelled, then most
   recent activity, then never-refreshed. Cap `max_refresh_per_day` (default
   **10**, i.e. ≤ 7 % of the 150-action budget; raise per notebook once the real
   per-person cost is measured). Skip anyone with `state = 1` in any *other*
   campaign's `action_target_people`. Knobs are remote-config keys.
3. **Enqueue.** One `people.actions.importPeopleFromUrls(actionId, 0,
   urls, true, liAccountId)` call per batch (≤ 100 URLs; in practice ≤ the daily
   cap) through a dedicated `CdpClient` session gated by its own
   `cdp_security_ack`. The returned stats are the first verification:
   `successful` must equal the batch size; `alreadyProcessed > 0` means the
   Processed list was not emptied (see below) and the run is marked `partial`.
   Second verification: `action_target_people` rows with `state = 1` for the
   tracker action, read from `lh.db` in `mode=ro`. Before each import, people
   the tracker has already processed are cleared from its list
   (`removeFromCampaignList`/`removeFromList`, signature from step 0) so LH2's
   own no-duplicates rule does not block the re-import; `retryPeople` is the
   alternative if clearing turns out to be the wrong primitive.
4. **Run control.** Default: the agent un-pauses the tracker after a non-empty
   enqueue and pauses it again on a later sync when the queue shows zero
   `state = 1` rows. This is deterministic and does not rely on LH2's idle
   behaviour. If the operator later confirms a Running empty-queue campaign idles
   quietly, switch to always-running and drop the toggling.
5. **Read-back.** Phase 1's chat-store extraction picks the refreshed rows up on
   the next sync; `chat_meta.last_check_date` per chat becomes "last refreshed"
   in the conversation drawer. The SDR's hand-typed replies (made in LH2's
   embedded browser) arrive this way and only this way.
6. **Guards.** Never create a second tracker (look up by stored id, then by name);
   never enqueue someone already `state = 1` in the tracker; stop the batch on
   the first LH2 error; never call anything but the four methods above plus the
   two pause/readback methods; every call and answer goes into bounded
   `sync_runs` notes visible on Health. If `daily_limits` shows the account near
   its cap (credits used today from `limit_type_credits_used` ≥ 80 %), skip the
   batch.
7. **Verify** on notebook-1: enqueue 3 known-dark threads, confirm `state = 1`
   rows, watch LH2 process them within the window, next sync shows their new
   messages with real `send_at`; funnel totals identical before and after.

(Probe #3 ran 2026-09-14; its results are the Signatures table above.)

#### Probe #4 — design step 0, read-only (paste into notebook-1's Claude Code)

═══════════════════════════════════════════════════════════════════════════════

READ-ONLY, fourth round, same rules: work only on the temp copy of `app.asar`
you extracted last time (re-extract it if the folder is gone), open `lh.db`
only `mode=ro`, call no LH2 method. Report as `conversation-probe-4.md` in
`sync-agent` and print it in full.

1. In the renderer bundle (`app.*.js`), find the two helper functions the sagas
   call as `(0,L.Ps)(payload)` and `(0,L.NA)(selection)` (the minified names may
   differ — locate them from the "Retry action people or organizations" saga
   and follow the import). Print each helper's full source and the shape of the
   object it returns, with an example built from a payload that selects a fixed
   list of person ids for one action (which keys carry the ids? `selectedIds`?
   `ids`? `filter.person.ids`? how is "all selected" expressed?).
2. Call sites and argument shapes of `campaigns.removeFromCampaignList` and
   `actions.removeFromList` (`callWrite` dispatcher cases plus the saga that
   builds their payload). Which list types does the campaign-level remove
   accept (queue / processed / replied / …)?
3. Which weekday index `working_intervals.working_week_day` uses: pick a
   campaign whose LH2 UI shows Mon–Fri hours (ask the operator which one) and
   print its rows; state whether 0 is Sunday or Monday.
4. `action_configs` for the archived campaign 4's `ScrapeMessagingHistory`
   action: `actionSettings`, `coolDown`, `maxActionResultsPerIteration`, and the
   `working_intervals` rows of that action, as the wizard wrote them.
5. Row counts today of `action_target_people` grouped by `state` for campaign 4,
   so the pilot has a before-picture.

═══════════════════════════════════════════════════════════════════════════════

### Phase 3 — UI/manual import
- Conversation drawer shows source per message (`sync`/`manual`) and platform;
  "Import history" stays for attachments, group chats and uncovered platforms.
- Replies feed and reply-review read chat rows (campaign NULL allowed).

## Rejected for the record
- **C1 (in-session LinkedIn API reads):** rejected by the owner 2026-09-14 — no
  non-LH2 traffic on the accounts, whatever the budget. Do not re-propose.
- **C2, D, E:** see the path table above.
