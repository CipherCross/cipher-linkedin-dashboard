# Route-local dashboard reads

## Goal
Remove the tenant-wide browser snapshot from every Neon route. Each page must become useful from bootstrap metadata plus one bounded, route-owned read, so tenant growth cannot turn navigation into a multi-minute request waterfall.

## Non-goals
- Removing the still-supported Supabase fallback in this iteration.
- Changing funnel, cohort, reply-intent, follow-up, or UTC date semantics.
- Adding caches or materialized views before route telemetry proves they are needed.

## Research findings
- The current Neon full load starts twenty relation reads, then walks large relations sequentially in 1,000-row pages.
- Only `/` and `/leads` currently avoid that snapshot. Every other hash navigation invokes `load('full')`; overlapping navigations can start duplicate snapshots.
- UITOP telemetry shows repeated 14,891-lead walks, roughly 1 MB per page, plus conversation and message projections. Actor resolution is paid again on every request and rises under concurrency.
- The endpoint already has a named-operation registry, strict parameter validation, route-local reads, request telemetry, and exact Overview/Leads implementations to reuse.

## Decisions
- Scope: every authenticated route, including account/campaign detail, Pipeline, Follow-ups, Review, Health, Team, Search Library, ICP, Hypotheses, Playbook, Chat, import, and Neon activity.
- Rollout: enabled for all users; no feature-flag cohort.
- Correctness: preserve current exact metrics and mutations; no time-window shortcuts that change all-time numbers.
- Deployment: ship without rollback, verify the exact commit on UITOP after local tests.

## Approach
Keep `dashboard.bootstrap` as the only application-shell read. Replace the implicit full snapshot with a route-keyed loader that deduplicates in-flight requests and commits only the active route. Add a single allowlisted `dashboard.routeSnapshot` vocabulary entry whose server-side builder selects a fixed, parameterized projection for each route; one actor resolution and one response replace the per-relation/page waterfall. Data-heavy routes return only their own scoped or workflow-relevant rows, while small-library routes return only their small relations. Overview, Leads, conversation threads, lead notes, Playbook, and Neon activity retain their existing local reads.

## Implementation phases
1. **S — Safety hotfix:** remove automatic tenant-wide reloads and add route-key/in-flight deduplication tests.
2. **L — Route snapshot contract:** add validated route names/ids, fixed SQL projections, client types, telemetry, and contract tests.
3. **L — UI migration:** hydrate the existing `DashboardData` surface from route snapshots so page behavior and optimistic mutations stay intact; make `phase='full'` mean the active route is ready rather than the tenant snapshot is ready.
4. **M — Verification and release:** run API/frontend suites, typechecks/build, inspect request vocabulary, deploy the exact SHA to UITOP, and confirm no route emits `leads.directory` or other tenant-wide snapshot walks.

## Affected files/modules
- `frontend/src/lib/DataContext.tsx`
- `frontend/src/lib/dashboardReads.ts`
- `frontend/src/App.tsx`
- `frontend/api/activity-daily.ts`
- `frontend/api/_lib/data/operations/` and operation registry
- `frontend/tests/dashboardReads.test.ts`
- `frontend/tests/dataContext.test.tsx`
- dashboard slice/operation contract tests

## Risks & how to verify
- Metric drift: compare route payload-derived UI values with the previous helpers and existing fixtures; keep SQL/parser and production-shaped reads in verification.
- Stale route commits: test rapid navigation and require active route keys before state commit.
- Mutation regressions: keep optimistic patch APIs and verify Pipeline, follow-up, library, ICP, hypothesis, campaign-context, Team, and import flows still see their required slices.
- Oversized payloads: record rows/bytes/actor/query/total telemetry per route and keep workflow reads scoped.
- Legacy fallback: run existing Supabase-path tests unchanged.

## Definition of done
- No Neon route calls `fetchNeonDashboard` or starts the 20-read full snapshot.
- Concurrent refresh/navigation creates at most one in-flight request per route key; an explicit later refresh can replace a completed snapshot.
- Every route renders its existing content and writes against its route-owned data.
- Relevant tests, API typecheck, and production build pass.
- Authenticated UITOP verification shows useful pages without tenant-wide `leads.directory`, all-message, or conversation-wide pagination waterfalls.
