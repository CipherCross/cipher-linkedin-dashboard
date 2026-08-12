# Dashboard performance at scale

## Goal

Make the authenticated dashboard fast and predictable for every tenant as data grows past
10,000 leads. The first useful Overview content must appear within 5 seconds and the page
must be fully interactive within 10 seconds on a representative 10,000–15,000-lead tenant,
without changing funnel, reply-intent, cohort, or UTC date semantics.

The solution must stop treating the browser as the owner of a complete tenant snapshot.
Small summaries needed for the current route load first; large directories and conversation
history use server-side filtering and pagination and load only when their routes need them.

## Non-goals

- No UITOP-only code path, tenant allowlist, or one-tenant pilot. The resulting read contract
  and UI behavior apply to all tenants.
- No arbitrary retention window for inbound messages. All-time inbound history remains the
  source of truth for sentiment, intent, durable P3, and related metrics.
- No change to funnel definitions, invite-cohort maturity rules, person deduplication, lost
  stage ordering, or UTC date boundaries.
- No migration away from the current React/Vite, Vercel function, or Neon architecture.
- No materialized view, cache, or index added merely on suspicion; database changes require
  query-plan and timing evidence.
- No virtualized 10,000-row client table as a substitute for server-side pagination.

## Research findings

- The initial Neon load starts approximately 20 dataset reads together in
  `frontend/src/lib/dashboardReads.ts`. These include the complete lead directory, all-time
  inbound messages, recent outbound messages, pipeline events, follow-up state, and several
  conversation-wide projections.
- Unbounded reads are capped at 1,000 rows per response and each dataset fetches its pages
  sequentially. Ten thousand leads therefore require at least 10–11 requests for the lead
  directory alone; message and conversation datasets add many more.
- Each paginated request repeats actor resolution and API/function overhead. A measurement
  recorded in `frontend/api/activity-daily.ts` showed roughly 196 ms of actor resolution in a
  525 ms request. Repeating this fixed cost across tens of pages can dominate the waterfall.
- `frontend/src/components/Layout.tsx` keeps the entire authenticated route behind a skeleton
  until the complete snapshot resolves. A slow non-critical dataset therefore delays every
  page and makes progressive completion invisible.
- `campaign_metrics` returns a small grouped result and is not the leading architectural
  suspect. `conversation_reply_intent` and `conversation_latest_message` are stronger SQL
  candidates because pagination over complex views may repeat windowing, grouping, and join
  work. This must be confirmed with `EXPLAIN (ANALYZE, BUFFERS)` on production-shaped data.
- The lead payload contains roughly 30 fields, while all-time inbound messages include bodies
  and classification fields. Several projections duplicate conversation-level information
  before first paint, increasing database work, JSON serialization, transfer, parsing, and
  browser memory.
- The browser recomputes reply-intent metrics once per instance and again for global current
  and previous ranges. These are repeated linear scans over leads, messages, intents, and
  events. This is meaningful CPU work after download, but it is unlikely to explain the full
  two-minute wait by itself.
- Leads Explorer already renders only 50 rows, but filters and sorts the full in-memory lead
  array. Server-side search, filters, sort, total count, and keyset pagination will remove the
  need to download the directory and improve both startup and interactions.
- Twenty concurrent initial operations can also create connection pressure against the
  small server-side pool and Neon Free limits. More parallel browser requests are therefore
  not the fix; the critical read set must become smaller and deliberately scheduled.
- The application already has useful patterns to retain: named operations through the
  consolidated read endpoint, keyset pagination, delta refresh after initial load, route code
  splitting, and reference-stable context slices.
- Runtime attribution is not yet measured. The Chrome DevTools performance service was not
  available during planning, so the code-backed hypotheses require an authenticated production
  waterfall, operation telemetry, current row counts/bytes, and database plans before SQL
  tuning is selected.
- PostgreSQL's `EXPLAIN ANALYZE` and `pg_stat_statements`, Vercel runtime logs/tracing, and a
  custom `dashboard_useful` browser mark provide the required database, server, and user-level
  evidence respectively.

## Decisions

- **Performance target:** first useful Overview content within 5 seconds and fully interactive
  Overview within 10 seconds for a representative 10,000–15,000-lead tenant.
- **Loading UX:** progressive loading is allowed. Summary cards and primary charts appear
  first; slower secondary sections show local skeleton/error/retry states instead of blocking
  the whole route.
- **Large collections:** Leads and Conversations use server-side pagination, search, filtering,
  and sorting. The browser no longer receives every row up front.
- **Rollout scope:** the new architecture is released for all tenants. UITOP is a useful
  high-volume measurement case, not a separate pilot or code path.
- **Metric correctness:** existing metric semantics and exact all-time requirements are
  preserved. Performance work must pass parity checks against the current implementation.
- **Freshness default:** first-load summaries are computed from current committed data. Any
  later proposal for materialization or stale-while-revalidate caching must state a freshness
  bound and receive separate approval after measurement proves it necessary.

## Approach

Replace the single global `DashboardData` completion gate with three data tiers:

1. **Bootstrap:** authenticated actor, tenant/instance metadata, and the minimum navigation
   configuration. This is the only data required before the app shell renders.
2. **Route summary:** compact, server-computed datasets for the active page. Overview receives
   exact aggregate metrics and chart series without raw leads/messages; each section resolves
   independently.
3. **Paged detail:** lead rows, conversations, and message history are fetched on demand with
   typed filters, stable sort keys, keyset cursors, totals, and abortable requests.

Keep named reads in the consolidated Vercel endpoint, but add route-oriented operations rather
than composing the UI from 20 tenant-wide tables. A single authenticated request may return a
small Overview summary envelope when that reduces repeated actor resolution and connection
churn. Do not create one giant SQL query: each component still needs observable timing and an
independent failure boundary.

Move client-only aggregate work to SQL or a server summary module only after writing parity
fixtures around `rangeTotals`, `rangedCampaigns`, `stageOf`, `riskOf`, `replyIntentMetrics`,
cohort maturity, and UTC boundaries. Retain shared domain functions where they are still needed
for local subsets, but avoid rescanning the same raw arrays once per instance.

For Leads and Conversations, define an explicit query contract: permitted filter fields,
permitted sort keys, page size cap, keyset cursor, total or bounded count, and a compact row
projection. Fetch full message bodies and conversation detail only when a drawer/page opens.
URL query state should preserve filters and pagination where practical.

Instrument first, then select SQL changes. Record operation name, page/cursor, rows, serialized
bytes, actor-resolution time, database time, total server time, status, and a correlation ID,
without logging tokens, message bodies, or personal data. In the browser record shell ready,
Overview useful, Overview interactive, and route-detail ready. Run `EXPLAIN (ANALYZE, BUFFERS)`
for the dominant operations and use the plans to choose between query rewrites, indexes, a
purpose-built summary query/table, or—only if freshness is explicitly accepted—a materialized
projection.

## Implementation phases

1. **Performance contract and observability — M**
   - Add `performance.mark`/`measure` points for shell ready, Overview useful, Overview fully
     interactive, and paged route ready.
   - Add redacted per-operation server timing/row/byte telemetry and correlation IDs.
   - Capture cold and warm authenticated loads for small, medium, and 10,000–15,000-lead
     tenants; include UITOP among the high-volume evidence but do not special-case it.
   - Collect current row counts and response bytes for every initial operation.
   - Rank database statements with runtime logs/tracing and `pg_stat_statements`; run
     `EXPLAIN (ANALYZE, BUFFERS)` for the slowest first/deep pages.
   - Produce a checked-in before-measurement artifact with p50/p95 timings and the dominant
     critical path. This phase is read/measure-first and must precede speculative SQL work.

2. **Progressive app shell and route-local loading — M**
   - Split bootstrap state from route datasets in `DataContext` or focused providers/hooks.
   - Render navigation and the active route after bootstrap instead of waiting for all datasets.
   - Give each Overview section its own loading, empty, error, retry, and stale-refresh state.
   - Cancel obsolete requests during navigation and prevent duplicate React requests.
   - Keep the existing five-minute refresh behavior, but refresh only mounted/active datasets
     and merge results without blanking already rendered content.
   - Release globally once correctness and failure-state tests pass.

3. **Exact Overview summary contract — L**
   - Inventory which raw fields each visible Overview component actually consumes.
   - Add one or a small number of named, actor-scoped summary operations for totals, campaign
     metrics, daily activity, reply intent/P3, cohorts, and risk counts.
   - Execute compatible aggregations server-side and return compact typed results; eliminate
     raw lead/message/event downloads from the Overview critical path.
   - Deduplicate repeated browser scans by computing shared maps/aggregates once per requested
     range, not once per instance plus global comparisons.
   - Add golden parity tests comparing old and new outputs across empty tenants, multiple
     instances, duplicate people, immature invite cohorts, manual messages, P3 milestones,
     NULL milestones, and UTC week boundaries.
   - Keep slow secondary cards progressive; the primary useful subset must meet the 5-second
     target independently.

4. **Server-paged Leads and Conversations — L**
   - Add validated named operations for lead and conversation list queries with page-size caps,
     allowlisted filters/sorts, stable keyset cursors, and counts.
   - Return compact list projections. Load full lead/conversation/message detail only on open.
   - Refactor Leads Explorer and conversation consumers to use server query state, debounced
     search, request cancellation, and retained previous-page data.
   - Preserve instance-scoped lead/thread keys and deterministic ordering under concurrent
     syncs; test missing/deleted cursor rows and tenant isolation.
   - Remove the corresponding full-directory and conversation-wide datasets from bootstrap.
   - Release the new behavior for all tenants after automated and production-shaped checks.

5. **Evidence-led database and transport tuning — M/L**
   - Rewrite the confirmed dominant queries so cursor predicates are applied before expensive
     grouping/window work where possible.
   - Add or adjust indexes only when the measured plan demonstrates the access path and write
     cost is acceptable.
   - If exact live summaries still miss the SLA, evaluate a transactionally maintained summary
     table before a periodically refreshed materialized view. Any freshness trade-off requires
     explicit product approval.
   - Reduce projections and duplicate payloads; enable/verify compression and region alignment.
   - Batch compatible small reads when it reduces repeated actor resolution, but cap server
     concurrency to avoid pool pressure and preserve per-operation observability.
   - Re-run the same cold/warm measurement matrix after every database change.

6. **Global cutover, regression budget, and cleanup — M**
   - Run production-shaped load/concurrency tests for small, medium, and high-volume tenants.
   - Compare every migrated metric and list result against the legacy path before removing it.
   - Enable the new architecture globally with operational rollback at the release level, not a
     long-lived tenant-specific implementation branch.
   - Remove obsolete snapshot fetches and client aggregate passes after parity is demonstrated.
   - Add a CI/performance budget or repeatable benchmark that fails on material regression in
     query count, payload bytes, time to useful Overview, or interaction latency.
   - Document the new read contracts, troubleshooting queries, and expected telemetry.

## Affected files/modules

- `frontend/src/lib/DataContext.tsx` — split global snapshot state, refresh, and merge behavior.
- `frontend/src/lib/dashboardReads.ts` — route summary and paged-detail read contracts.
- `frontend/src/components/Layout.tsx` — remove the all-data render gate; section-level states.
- `frontend/src/pages/Overview.tsx` — consume summary datasets and progressive sections.
- `frontend/src/lib/leads.ts` — metric parity fixtures and removal/deduplication of repeated scans.
- `frontend/src/pages/LeadsExplorer.tsx` — server query state and paged list UI.
- Conversation list/drawer consumers under `frontend/src/` — paged summaries and on-demand
  detail/history.
- `frontend/api/activity-daily.ts` — new named operations, request timing, batching, and limits.
- `frontend/api/_lib/data/operations/leads.ts` — filtered/paged lead projection.
- `frontend/api/_lib/data/operations/messages.ts` — conversation list and detail projections.
- `frontend/api/_lib/data/neon.ts` — safe timing/connection instrumentation where required.
- `postgres/tenant-baseline/v1/001_portable_business_baseline.sql` and its append-only ledger —
  only for evidence-backed portable schema changes; never edit the immutable baseline in place.
- `frontend/api/_lib/core.ts` schema documentation if any tables, columns, or views change.
- New frontend/API parity tests, benchmark fixtures, and a checked-in performance report or
  runbook under the repository's live documentation paths.

## Risks & how to verify

- **Metric drift:** server summaries could subtly change cohort, UTC, deduplication, manual
  import, or P3 semantics. Verify with golden parity fixtures and sampled tenant comparisons;
  require exact equality unless a separately reviewed bug fix explains the difference.
- **RLS/tenant leakage:** new filtered reads broaden query inputs. Keep actor resolution and
  transaction-local identity, validate every filter/sort, and add positive/negative cross-tenant
  tests for every operation.
- **Inconsistent pages during sync:** rows can move while paginating. Use deterministic compound
  cursors, define snapshot/refresh behavior, and test inserts/updates between pages.
- **Counts become a new bottleneck:** exact counts over complex filters can be expensive. Measure
  them separately; use exact counts where product behavior needs them and bounded/omitted counts
  only after explicit UX agreement.
- **Request waterfall moves rather than disappears:** progressive UI can mask but not reduce
  work. Success requires lower critical-path requests, rows, bytes, database time, and browser
  CPU in addition to earlier paint.
- **Connection exhaustion:** route sections could still fan out. Enforce a concurrency budget,
  observe pool wait/errors, and test multiple simultaneous tenant sessions.
- **Database tuning harms ingest:** new indexes/maintained summaries add write cost. Compare sync
  duration, lock time, and write throughput before and after.
- **Stale or partial UI confusion:** section-level status must distinguish loading, stale data,
  empty results, and errors. Test slow/failing operations and navigation during refresh.
- **Small tenants regress:** global rollout must improve or preserve timings across the full
  size matrix, not only UITOP-sized datasets.

## Definition of done

- On the agreed production-shaped 10,000–15,000-lead benchmark, p95 cold load reaches useful
  Overview content in at most 5 seconds and a fully interactive Overview in at most 10 seconds.
- Small and medium tenants do not materially regress; thresholds and the comparison method are
  recorded in the performance artifact.
- The authenticated shell is not blocked by lead/message/conversation directory completion.
- Overview does not download complete lead, inbound-message, conversation-projection, or event
  datasets solely to render aggregate metrics.
- Leads and Conversations use server-side validated filtering, sorting, searching, and keyset
  pagination with compact list payloads and on-demand details.
- All migrated metrics pass exact parity tests for the documented funnel, cohort, intent/P3,
  deduplication, manual import, and UTC behaviors.
- Before/after evidence reports request count, response bytes, database time, actor-resolution
  time, server duration, browser parsing/CPU, and custom ready timings for all tenant-size tiers.
- Dominant SQL operations have recorded plans; every schema/index/materialization change is tied
  to measured evidence and includes ingest/write regression checks.
- Cross-tenant authorization tests, pagination concurrency tests, partial-failure UX tests,
  frontend build, and relevant backend/schema tests pass.
- The new behavior is deployed for all tenants with release-level rollback instructions, and
  obsolete full-snapshot reads are removed after parity is confirmed.
