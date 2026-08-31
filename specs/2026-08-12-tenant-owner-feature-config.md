# Tenant and owner feature configuration

## Goal

Add a versioned product feature configuration for the owner workspace and every isolated tenant workspace. The configuration must control both what users can see and what the trusted server is allowed to execute, while keeping infrastructure provisioning configuration and machine ingestion outside the product-feature surface.

The owner workspace has its own effective configuration and also supplies defaults for new tenants. Every tenant receives an independent configuration that can later diverge through explicit owner-managed overrides.

## Non-goals

- Replacing or extending `s26-owner-runtime.v1`; product features remain separate from provider credentials, catalogs, onboarding, and recovery configuration.
- Introducing an external feature-flag SaaS or per-request remote flag evaluation.
- Per-user, per-role, percentage-rollout, experiment, scheduled activation, or gradual-release targeting in v1.
- Tenant-admin self-service editing in v1. Tenant admins may see the effective configuration but cannot change it.
- Deleting historical data when a feature is disabled. Existing briefings, classifications, messages, imports, and coaching results remain durable.
- Making Auth, Team, Health, notebook ingest, remote notebook config, photo upload, or signed agent release transport configurable.
- Removing tenant cron schedules dynamically. A disabled scheduled capability exits safely inside its handler without performing model, database-write, or Slack-delivery work.

## Research findings

- Routes are registered in `frontend/src/App.tsx`, while navigation, titles, and loading skeletons are maintained separately in `frontend/src/components/Layout.tsx`. A page flag therefore needs one shared registry consumed by both surfaces, plus a direct-route guard.
- The existing `AdminOnly` wrapper is a useful UI-gate pattern, but client-side hiding is not authorization. Current server authorization is centralized in `frontend/api/_lib/auth.ts`; feature enforcement should compose with `requireMember` and `requireAdmin` after the trusted workspace context is resolved.
- Tenant deployments are physically isolated and use separate Neon projects and credentials. A workspace-local singleton configuration avoids cross-tenant reads and lets each server enforce its own configuration.
- `instances.config` configures individual LH2 notebook instances, not workspace product features. `s26-owner-runtime.v1` is an owner-local infrastructure/control-plane configuration and must remain separate.
- `/api/import` multiplexes human imports and critical machine operations. CSV and conversation-history flags must be checked at the individual operation boundary; disabling a product import must never disable `agent.ingest`, `agent.config`, `agent.photoUpload`, or `agent.release`.
- Daily and weekly briefings share one endpoint but are separate jobs and schedules. They need independent capability keys and independent early exits before any model call or Slack delivery.
- AI is already split across chat, coaching, reply classification, demographic inference, and briefings. A single `ai=false` flag would hide important dependency and cost boundaries, so v1 uses leaf capabilities without an ambiguous parent/master switch.
- The application currently uses a fixed serverless-function budget. Feature-config reads and writes should reuse the existing named-operation dispatchers rather than create a new top-level Vercel function.
- The portable PostgreSQL baseline is append-only and its migration inventory is pinned by tests and the Worker. Adding configuration and audit tables requires a new ledger step and corresponding manifest, RLS/grant, clean-room, and pinned-artifact updates.
- [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) recommends deny-by-default and server-side authorization checks on every request. [OpenFeature evaluation semantics](https://openfeature.dev/specification/sections/flag-evaluation/) require explicit defaults for unavailable or invalid configuration. For this entitlement-like use case, unknown or invalid capabilities fail closed, while an explicit all-enabled seed preserves existing workspaces during migration.
- [LaunchDarkly's feature flag guidance](https://launchdarkly.com/docs/guides/flags/creating-flags) distinguishes long-lived entitlement/operational flags from temporary release flags and recommends a defined purpose, smallest useful unit, dependencies, defaults, and lifecycle for every key.

## Decisions

- The owner workspace has its own configuration and provides defaults for new tenants. Each tenant stores an independent configuration and can receive owner-managed overrides.
- A disabled feature is enforced across navigation, direct routes, API handlers, cron execution, model calls, and Slack delivery where applicable. It is not a cosmetic menu toggle.
- Disabled direct API calls return a stable `403 feature_disabled` error carrying the canonical feature key. Disabled page routes render a clear unavailable state with a link to the nearest enabled safe page.
- Page visibility, AI capabilities, CSV imports, and conversation-history import are separate layers. A page being visible does not implicitly grant its embedded actions.
- AI uses granular leaf keys rather than one master switch:
  - `ai.chat`
  - `ai.coach`
  - `ai.reply.sentiment`
  - `ai.reply.intent`
  - `ai.demographics.gender`
  - `briefing.daily`
  - `briefing.weekly`
- The initial configurable page keys are:
  - `page.overview`
  - `page.follow_ups`
  - `page.pipeline`
  - `page.leads`
  - `page.review`
  - `page.playbook`
  - `page.searches`
  - `page.icps`
  - `page.hypotheses`
  - `page.ai_chat`
  - `page.csv_import`
- Import capabilities are independent:
  - `import.csv.contacts`
  - `import.csv.companies`
  - `import.conversation_history`
- Additional independent delivery capabilities are:
  - `notification.reply_slack`
  - `notification.review_digest_slack`
- Auth, Team, and Health remain accessible to the appropriate member/admin roles and are not flaggable. Machine ingest, notebook remote config, photo upload, and signed release transport are not feature-config operations.
- V1 configuration changes are available only to the platform owner through the existing owner operations boundary. Changes carry an optimistic revision, actor, timestamp, reason, and immutable before/after audit record. Tenant admins receive a read-only effective-config view.
- Existing owner and tenant workspaces are explicitly seeded with all configurable features enabled. New tenants are seeded from the owner defaults during onboarding and thereafter own an independent snapshot.
- The browser loads feature configuration during authenticated bootstrap and refreshes it with the existing five-minute data refresh. The server reads authoritative current configuration for every protected operation and does not trust browser-supplied feature state.

## Approach

Create a single canonical, typed feature registry shared by browser and server code. Each registry entry defines its stable key, kind (`page`, `capability`, or `delivery`), default used only during explicit provisioning/migration, protected UI surfaces, protected server operations, and any dependency. Unknown keys are rejected; deprecated keys remain readable only through an explicit schema-version migration.

Store one versioned feature document in every workspace database, including the owner workspace. The singleton contains `schema_version`, monotonic `revision`, the complete boolean feature map, and update metadata. An append-only audit table stores the actor, reason, previous revision/configuration, and next revision/configuration. The database migration explicitly seeds all current workspaces as enabled; request-time absence or invalidity is not treated as an implicit all-on fallback.

Keep two owner concepts distinct:

1. The owner workspace's own effective feature document, enforced by the owner dashboard deployment.
2. The owner tenant-default document, used only when creating a tenant snapshot during onboarding.

Tenant override updates replace an expected revision atomically with a complete validated document. They do not retain a runtime inheritance link to owner defaults, so changing defaults cannot silently change existing tenants. The owner operations flow remains `preflight -> plan -> owner approval -> apply/resume -> verify`, using named typed operations and never arbitrary SQL or environment mutation.

Expose the effective document through an existing authenticated named read operation. The client stores it in the authenticated data layer, builds navigation from the canonical page registry, and uses one reusable route guard for direct hash routes. Components with embedded functionality use capability checks to hide or disable only the relevant action, not the surrounding lead/conversation data.

On the server, add a shared `requireFeature` helper that resolves the trusted workspace-local configuration after the existing member/admin/machine boundary. Every human API operation, cron branch, model invocation, and Slack delivery maps to one canonical capability key. Checks occur before billable calls or durable writes. Machine import operations bypass product flags by explicit operation identity, not by a broad `/api/import` exception.

For coupled implementations, refactor before gating. In particular, reply sentiment and intent must have independently enforceable execution paths even if they continue sharing one endpoint, and daily/weekly briefing modes must resolve separate keys. Derived non-AI age calculation remains outside the AI feature vocabulary.

## Implementation phases

1. **Canonical vocabulary and contract tests (S)**
   - Add the shared typed registry, schema version, page-to-route mapping, server-operation mapping, and invariants.
   - Assert unique keys, complete boolean documents, valid dependencies, and exact client/server vocabulary parity.
   - Document why core/admin recovery and machine operations are not configurable.

2. **Workspace storage, bootstrap, and audit (L)**
   - Add an append-only portable-schema ledger step for effective workspace configuration and immutable audit history.
   - Seed the owner and existing tenants explicitly with the all-enabled v1 document.
   - Add least-privilege read grants for authenticated runtime and system cron identities, and owner-only mutation operations with expected-revision checks.
   - Update schema inventories, RLS/grant assertions, clean-room tests, pinned Worker migrations, and schema documentation.

3. **Authenticated read path and frontend page gates (M)**
   - Add feature configuration to authenticated bootstrap through an existing named read dispatcher.
   - Store and refresh it in the client data context.
   - Generate sidebar visibility and route gating from the canonical page registry; cover direct deep links, active-route fallback, page titles, and loading skeletons.
   - Add read-only effective-config visibility for tenant admins without exposing mutation controls.

4. **Granular server and embedded-feature enforcement (L)**
   - Add `requireFeature` and the stable `feature_disabled` response contract.
   - Gate AI chat, coaching, sentiment, intent, gender inference, daily briefing, and weekly briefing before billable/model work.
   - Gate CSV Contacts, CSV Companies, and conversation-history import at their individual operation boundaries while proving machine ingest/config/photo/release remain unaffected.
   - Gate reply Slack notifications and review-digest Slack delivery independently.
   - Add component-level checks for embedded coach, classifier, demographic, conversation-history, briefing, and notification controls.

5. **Owner defaults and audited operations workflow (L)**
   - Add typed owner operations to read current owner config/defaults, plan a revisioned change, apply after approval, and verify the effective document and audit row.
   - Seed new tenant configuration from an immutable snapshot of owner defaults during onboarding.
   - Add idempotent apply/resume behavior and verify/adopt postconditions so retries cannot duplicate audit transitions or silently overwrite a newer revision.
   - Keep secrets and infrastructure runtime configuration out of feature-config payloads and logs.

6. **Rollout and end-to-end verification (M)**
   - Migrate owner first, then a disposable tenant, then existing tenants with explicit all-enabled seeds.
   - Exercise one feature from each class both enabled and disabled, including a direct route, direct API call, cron invocation, model call prevention, Slack prevention, CSV import, and conversation-history import.
   - Verify the five-minute browser refresh and immediate server enforcement after a revision change.
   - Update current operational documentation and preserve rollback as a new audited revision rather than deleting configuration or audit data.

## Affected files/modules

- Shared feature contract (new module under `frontend/shared/`), plus relevant frontend/server TypeScript configuration.
- `frontend/src/App.tsx`
- `frontend/src/components/Layout.tsx`
- `frontend/src/lib/AuthContext.tsx`
- `frontend/src/lib/DataContext.tsx`
- `frontend/src/lib/dashboardReads.ts`
- Embedded controls in `frontend/src/pages/Chat.tsx`, `frontend/src/pages/LeadsExplorer.tsx`, `frontend/src/pages/Health.tsx`, `frontend/src/pages/Review.tsx`, `frontend/src/pages/CsvImport.tsx`, `frontend/src/components/ConversationDrawer.tsx`, and `frontend/src/components/ImportHistoryPanel.tsx`.
- `frontend/api/_lib/auth.ts` and a new shared server feature guard.
- `frontend/api/activity-daily.ts` named read/write dispatch.
- `frontend/api/chat.ts`
- `frontend/api/coach.ts`
- `frontend/api/classify.ts`
- `frontend/api/briefing.ts`
- `frontend/api/import.ts`
- `frontend/api/review-digest.ts`
- `frontend/api/notify-replies.ts`
- `frontend/api/_lib/data/contracts.ts` and named operation registry/implementations.
- A new append-only file under `postgres/tenant-baseline/v1/`, its migration ledger/manifest imports, RLS and role grants, clean-room harnesses, and `ops/src/worker/pinned-postgres.ts`.
- Owner operations schemas, plan/apply/verify core, registry/audit persistence, onboarding tenant-default snapshot, CLI/MCP allowlist, and their tests under `ops/` and `docs/platform-ops/`.
- Frontend route/read/serverless-shape tests and PostgreSQL/ops contract tests.
- `CLAUDE.md`, `AGENTS.md`, and the relevant current implementation handoff when implementation changes the documented current state.

## Risks & how to verify

- **UI-only bypass:** hidden links could leave direct routes or APIs usable. Verify every registry entry has both a UI mapping where applicable and a server-operation mapping; test direct URLs and raw requests.
- **Notebook outage through import gating:** a broad `/api/import` check could stop ingestion. Test all machine operations with every human import feature disabled.
- **Unexpected lockout:** missing config combined with deny-by-default could hide the product. Prevent this with transactional explicit seeds, always-on Auth/Team/Health recovery surfaces, startup validation, and a clear invalid-config health diagnostic.
- **Over-entitlement during failures:** cached or browser-provided config could allow work after disablement. Verify the server reads authoritative workspace-local state and fails closed before effects.
- **Coupled AI work:** a combined classifier could run a disabled sub-feature. Add mode-level tests proving each AI leaf can be disabled without invoking its model/persistence path and without disabling unrelated leaves.
- **Cron cost or delivery after disablement:** schedules continue firing. Verify disabled daily/weekly/notification handlers exit before model calls, database mutations, and webhooks while still returning an observable successful no-op result.
- **Stale navigation:** the browser may show a feature for up to five minutes. Verify the next protected call is denied immediately and the next scheduled refresh removes the UI entry.
- **Owner-default drift:** changing defaults could unexpectedly affect tenants. Verify tenants store independent snapshots and existing revisions do not change when owner defaults change.
- **Lost concurrent update:** two owner changes could overwrite one another. Verify expected-revision compare-and-swap, deterministic conflict responses, immutable audit ordering, and idempotent resume.
- **Vocabulary drift:** client, server, database seed, and ops schemas could disagree. Pin one canonical registry and add parity tests across generated/validated artifacts.
- **Migration/auth transition:** owner and tenant deployments currently have different auth paths. Run the same feature read/enforcement tests against both supported authenticated paths until the auth flip is complete.

## Definition of done

- A canonical v1 registry exists with all agreed page, AI, briefing, import, and notification keys and no ambiguous master AI flag.
- Owner effective config, owner tenant defaults, and each tenant effective config are distinct, versioned, revisioned, and auditable.
- Existing workspaces are explicitly seeded all-enabled; new tenants receive an independent snapshot of owner defaults.
- Navigation, page titles, loading states, and direct routes honor page flags.
- Every protected API, cron branch, model call, import operation, and Slack delivery enforces its leaf capability server-side and returns the documented disabled behavior.
- CSV Contacts, CSV Companies, and conversation-history import can be toggled independently.
- AI Chat, Coach, Sentiment, Intent, Gender inference, Daily Briefing, and Weekly Briefing can be toggled independently.
- Auth, Team, Health, notebook ingest, remote config, photo upload, and signed releases remain available according to their existing authorization rules regardless of product flags.
- Only platform-owner operations can change configuration; tenant admins can inspect effective state but cannot mutate it.
- Audit history records actor, reason, timestamp, before/after documents, and monotonic revisions; concurrent and repeated applies are safe.
- Frontend build, route/read tests, server handler tests, PostgreSQL clean-room/RLS tests, Worker pinned-migration tests, and `cd ops && npm test` all pass.
- Owner plus one disposable tenant pass the enabled/disabled end-to-end matrix before rollout to existing tenants.
