# Overview conversion rates and campaign comparison

## Goal

Make Overview readable without manual arithmetic. System totals will expose a coherent invite-cohort funnel, Performance will show percentage movement against the immediately preceding equal-length period, and the page will provide one cross-account campaign comparison table with reversible client-side list editing.

The implementation must keep the existing milestone semantics, UTC analytical ranges, person deduplication, and the established definition `Reply rate = replied / connected`.

## Non-goals

- Do not add employer/company analytics; “companies” in the request means LinkedIn campaigns running from the available accounts.
- Do not redefine Reply rate as replies divided by first messages.
- Do not sum campaign rows to reproduce System totals: campaign rows are campaign-scoped lead rows, while System and Performance deduplicate people by `(instance_id, profile_url)`.
- Do not persist the hand-edited comparison list to Neon, Supabase, user settings, or another server-side store in this iteration.
- Do not delete, archive, pause, start, or otherwise mutate a campaign when it is removed from the comparison list.
- Do not change the Performance activity chart, campaign runtime semantics, CRM stages, or Linked Helper data.
- No database migration is expected; the three narrow read operations can derive the additional fields from current milestone columns. Do not add schema objects without measured query evidence.

## Research findings

- Overview currently loads System totals, Performance, and Account analytics independently. A failure or refresh in one section must not block the others.
- System totals currently show only counts. Finite-range counts are event-flow counts: each milestone is included by its own timestamp. Directly dividing those visible counts can compare different cohorts, include organic connections, and produce misleading or greater-than-100% results.
- The existing analytics contract already carries `acceptedOfInvited` and `repliedOfConnected`, but it does not carry a connected-cohort first-message numerator or an explicit invite-cohort object.
- Performance already requests a current range and the immediately preceding equal-length range. The UI currently displays the absolute count difference (for example, `+4 vs previous`), not the percentage change or the previous value.
- The existing All-time conversion panel uses the accepted definitions:
  - `Acceptance rate = accepted invited leads / invited leads`.
  - `Reply rate = replied connected leads / connected leads`.
- `overview.summary` already returns every campaign across every account. The current UI shows the account table when All accounts is selected and reveals campaign rows only after selecting one account, which prevents cross-account comparison.
- Campaign rows already contain range-scoped invited, connected, and reply counts plus lifetime acceptance and reply rates. A range-scoped first-message count is the one additional campaign field needed for the accepted table.
- The raw-lead fallback in `frontend/src/lib/overviewAnalytics.ts` and `frontend/src/lib/leads.ts` must remain semantically equivalent to the Neon summary path.
- The current Neon path starts three Overview reads after bootstrap: compact `overview.systemTotals`, `overview.summary` for Performance, and a second `overview.summary` for Account analytics. The two summary calls use different default ranges, so they cannot be deduplicated.
- `overview.summary` is a broad aggregate. In addition to the analytics and campaigns used by this screen, it materializes lead rows and derives intent from messages, pipeline/funnel data, velocity, and legacy payloads. Those unrelated calculations must not remain on the critical path for this feature.
- The server-side runtime pool is capped at two database connections while Overview can start three reads. Every request also repeats actor resolution and transaction preamble. Initial orchestration must therefore prioritize System totals and Performance before the lower-page campaign table.
- Client work over roughly 25 campaigns is negligible compared with network and database time. Sorting, hiding, and restoring rows should stay client-side; virtualization and server pagination would add complexity without addressing the current bottleneck.
- Existing telemetry already records response bytes, actor time, database acquisition/preamble/execution/commit stages, total time, and operation name. Performance acceptance should extend those signals rather than infer SQL cost from a spinner or one browser observation.
- Earlier live checks found a 20-lead discrepancy between compact System totals and the older summary path. Metric parity must be explicitly resolved with a fixed dataset before either contract is treated as canonical.
- The page must remain English-only, light-theme, and PC-only. Acceptance viewports are 1280×720, 1440×900, and 1920×1080. Wide tables scroll inside their own frame and do not overflow the page.
- Sortable columns must remain semantic table headers with only the active column exposing `aria-sort`.
- PostgreSQL can materialize reused CTEs but materialization can also prevent predicate pushdown; retain or change `MATERIALIZED` only after inspecting the measured plan ([PostgreSQL `WITH` queries](https://www.postgresql.org/docs/17/queries-with.html)).
- Keep browser-visible server attribution in `Server-Timing` and use paired User Timing marks/measures for section readiness ([Server-Timing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Server-Timing), [User Timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/User_timing)).

## Decisions

1. **System totals becomes an invite-cohort funnel.** For a selected UTC range `R`, define `C` as the distinct people whose earliest `invited_at` falls inside `R`, deduplicated by `(instance_id, profile_url)`. For All time, `C` is every distinct person with an invite.
   - Leads: keep the existing leads-added count for `R`; it has no conversion percentage.
   - Invited: `|C|`; show `100.0%` when `|C| > 0`, otherwise `—`.
   - Connected: people in `C` with `connected_at`; show `Connected / Invited`.
   - Messaged: people in `C` with both `connected_at` and `first_message_at`; show `Messaged / Connected`.
   - Replied: people in `C` with both `connected_at` and `replied_at`; show `Replied / Connected`.
   - Outcomes are followed through the query time and are not clipped to the end of `R`. This prevents a connection or reply that arrived after the invite window from disappearing from its invite cohort.
   - Render rates to one decimal place. If the invited cohort is empty, every rate renders `—`. If Invited is non-zero and Connected is zero, Connected renders `0.0%`; Messaged and Replied render `—` because their Connected denominator is zero. Never render `Infinity` or `NaN`.

2. **Performance keeps event activity and adds explicit comparisons.** The selected period continues to count invites, connections, and first replies by each event’s own timestamp. The comparison period is the immediately preceding, non-overlapping range of the same duration: 7 days versus the previous 7 days, 30 days versus the previous 30 days, and the same rule for a custom closed range.
   - Every KPI keeps its current absolute count.
   - Every KPI shows the previous-period count and percentage change: `(current - previous) / previous × 100`.
   - If `previous > 0`, render the signed change to one decimal, for example `+25.0% vs previous 7 days · 12`.
   - If `previous = 0` and `current > 0`, render `New vs previous 7 days · 0` instead of an infinite percentage.
   - If both values are zero, render `0.0% vs previous 7 days · 0`.
   - If the selected range has no finite previous interval, render `No comparison`.
   - The Connected card also shows the selected invite cohort’s Acceptance rate. The First replies card also shows that cohort’s Reply rate. Invited has no artificial conversion rate beyond being the cohort baseline.
   - Keep the existing All-time conversion panel as a maturity-safe reference and label the card-level rates clearly as selected invite-cohort rates.

3. **Reply rate is always connected-based in this work.** In System totals, Performance, and campaign comparison, `Reply rate = people with connected_at and replied_at / people with connected_at`. First-message counts remain useful funnel context but never become the Reply rate denominator.

4. **Add a global campaign comparison table without removing account drill-down.** When All accounts is selected, Account analytics continues to show the account table and also shows a Campaign comparison table containing every eligible campaign across accounts. Selecting an account filters the same campaign table to that account rather than switching to a different table contract.
   - Columns: Account, Campaign, Invited, Connected, First messages, First replies, Acceptance rate · lifetime, Reply rate · lifetime, Remove, Open.
   - Absolute milestone counts follow the Account analytics date range.
   - Acceptance and Reply rate remain lifetime values so recent, immature invite cohorts do not masquerade as final campaign conversion.
   - The global default sort is Invited descending, then Account and Campaign for deterministic ties.
   - Archived campaigns are hidden by default and included by the existing Show archived control.
   - Undefined rate denominators render `—`.

5. **Comparison-list editing is frontend-only and reversible.** Each campaign row has an accessible remove icon. Clicking it hides that campaign from the comparison table only; it does not alter campaign data or call a write API.
   - Hidden campaigns are tracked by `campaign_id` in component state and stay hidden while Overview remains mounted, including across sorting, pagination, date-range changes, account filtering, and Show archived changes.
   - A full page reload restores the server-provided list. This iteration intentionally does not use local storage or server persistence.
   - The toolbar shows `Hidden: N` and a `Restore all` action whenever the hidden set is non-empty.
   - Removing the last visible row produces a distinct client-filtered empty state with a Restore all action; a genuinely empty API result retains the normal no-data state.
   - Pagination resets or clamps after removals so the user cannot remain on a now-empty out-of-range page.
   - The icon’s accessible label identifies the target, for example `Remove HealthTech motion from comparison`; the visual `×` alone is not the label.

## Approach

### Page placement and hierarchy

Keep the existing page order and do not create another top-level navigation concept:

1. Existing `PageHeader`.
2. **System totals** — the first analytics section directly under the header.
3. **Performance** — the existing chart section immediately below System totals.
4. **Account analytics** — the existing account table.
5. **Campaign comparison** — inside the Account analytics section, after the account table and its pagination/freshness footer, separated by 24px and introduced by an `h3` titled `Campaign comparison`.

Campaign comparison must not be wrapped in another bordered card. The allowed surface depth remains page → section. It reuses the Account analytics date range and account selection: All accounts displays the global comparison, and selecting an account filters the same table to that account.

### System totals visual contract

- Keep the existing five-column `.ov-summary` grid at 1280, 1440, and 1920 widths. Do not replace it with a chart, progress bar, funnel illustration, or stacked cards.
- Each `.ov-total` uses exactly three lines: muted label, 32/40 tabular count, and one 13/18 explanatory line.
- Exact secondary copy for the example `100 invited / 40 connected / 30 messaged / 10 replied`:
  - Leads: `Added in selected range` for finite ranges or `All leads` for All time, and no rate.
  - Invited: `100.0% of invited`.
  - Connected: `40.0% of invited`.
  - Messaged: `75.0% of connected`.
  - Replied: `25.0% of connected`.
- Do not use arrows, badges, gradients, progress bars, success/danger colouring, or decorative icons for these conversion lines. The numbers and their denominators carry the meaning.
- The section subtitle must make the scope explicit: `<selected range> · Invite cohort · All accounts · UTC` for a finite range, and `All time · Invite cohort · All accounts` for lifetime.
- The loading skeleton retains five cells and reserves the secondary-copy line, preventing layout shift when the rates arrive.

### Performance visual contract

- Keep the three `.ov-metric` KPIs above the existing activity chart and keep the right-side `All-time conversion` rail. The chart remains event-time activity, not a cohort chart.
- Each KPI keeps the label and 32/40 count. The next line is the period comparison:
  - Normal: `+25.0% vs previous 7 days · 12`.
  - Previous zero/current positive: `New vs previous 7 days · 0`.
  - Both zero: `0.0% vs previous 7 days · 0`.
  - No finite prior period: `No comparison`.
- Connected gets one additional metadata line: `Acceptance 40.0% · 40 / 100 invited`.
- First replies gets one additional metadata line: `Reply rate 25.0% · 10 / 40 connected`.
- Invited has no second conversion line. It is the cohort baseline, and `Invited = 100%` must not be presented as a meaningful Performance result.
- Comparison lines use muted text; conversion lines use primary text with the label in weight 500. Do not use red/green to encode improvement because higher outreach volume is not inherently good and a percentage may be undefined.
- The 1280 layout remains chart plus a 220px rate rail. The 1440 layout keeps the same composition. At 1920 the analytics page remains capped by the existing 1600px maximum width.

### Campaign comparison visual contract

- Use shared `TableFrame`, `TableToolbar`, semantic `Table`, `Checkbox`, `IconButton`, `Button`, and `AccountIdentity` primitives rather than adding route-local control patterns.
- Toolbar layout:
  - Left: `<visible count> campaigns`.
  - Right, in order: `Show archived` checkbox; `Hidden: N` text when non-zero; ghost `Restore all` button when non-zero.
  - `Hidden: N` counts hidden campaign IDs still present in the current API response, independent of the selected account filter.
- Column order is fixed: Account, Campaign, Invited, Connected, First messages, First replies, Acceptance rate · lifetime, Reply rate · lifetime, Remove, Open.
- Account uses `AccountIdentity`; campaign names remain user content and are never truncated without the full value available through the cell/title. Numeric cells are right-aligned with tabular numerals.
- The table defaults to Invited descending, then Account label ascending, then Campaign name ascending, then `campaign_id` for a deterministic final tie-break.
- Only the active sortable header carries `aria-sort`; inactive headers omit the attribute rather than setting `aria-sort="none"`.
- Remove uses a neutral 44×44 `IconButton` with a 20px `X`, not danger styling. Its accessible label is `Remove <campaign name> from comparison`. It never says Delete.
- Open remains a semantic link labeled `View leads` and preserves the encoded campaign-detail URL.
- API-empty copy: `No campaigns are available for this scope.`
- Client-hidden copy: `All campaigns are hidden from comparison.` followed by a `Restore all` button.
- The table has `min-width: 1180px`, a sticky header, local horizontal scrolling, and the written hint `Scroll horizontally for all campaign metrics.` At 1280 and 1440 it may scroll inside its frame; at 1920 the full table should fit. The page itself must never acquire horizontal overflow.
- Pagination remains 20 rows per page. Removal, archive filtering, account filtering, and restoration must clamp or reset the current page before rendering.

### Formula contract

All date presets are inclusive UTC calendar days in the UI and half-open UTC instants in the query: `[from 00:00, day-after-to 00:00)`.

| Metric | Population / numerator | Denominator | Display formula |
| --- | --- | --- | --- |
| System Invited | Distinct people whose earliest `invited_at` is in the selected invite cohort | Same population | `100.0%` when non-empty |
| System Connected / Acceptance | Cohort people with `connected_at IS NOT NULL` | Cohort Invited | `100 × connected / invited` |
| System Messaged | Cohort people with `connected_at IS NOT NULL` and `first_message_at IS NOT NULL` | Cohort Connected | `100 × messaged / connected` |
| System Replied / Reply rate | Cohort people with `connected_at IS NOT NULL` and `replied_at IS NOT NULL` | Cohort Connected | `100 × replied / connected` |
| Performance change | Current event-time count minus previous event-time count | Previous event-time count | `100 × (current - previous) / previous` |
| Campaign Acceptance · lifetime | Campaign lead rows with both invite and connection milestones | Campaign lead rows with an invite milestone | `100 × lifetime_accepted / lifetime_invites` |
| Campaign Reply rate · lifetime | Campaign lead rows with both connection and reply milestones | Campaign lead rows with a connection milestone | `100 × lifetime_replied / lifetime_connected` |

Do not add a new timestamp-order requirement. Preserve the existing earliest-milestone and constrained-numerator semantics. Outcomes for the System invite cohort are observed through query time and are not clipped at the cohort range end. Campaign absolute counts remain event-time counts inside the selected Account analytics range.

### Data shape and read operations

Do not extend the broad `overview.summary` call for the new UI. Replace the current critical-path reads with three bounded named operations:

1. `overview.systemTotals`
   - Extend the existing compact distinct-person scan with the selected invite-cohort counts and rates.
   - Return only the leads-added count, cohort counts/rate numerators, and scope metadata required by System totals.
   - Target payload: at most 1KB.
2. `overview.performance`
   - Return current and previous event-time totals, current/previous/lifetime invite-cohort totals globally and per account, and current-range activity buckets.
   - Exclude campaign rows, message bodies, intent, pipeline events, funnel, velocity, and unrelated legacy summary fields.
   - Target payload: at most 20KB for the current tenant shape.
3. `overview.accountCampaigns`
   - Return account totals plus compact campaign rows for the Account analytics range, including range `first_messages` and explicit lifetime Acceptance and Reply rates.
   - Exclude messages, intent, pipeline events, funnel, velocity, activity charts, and unrelated legacy fields.
   - Target payload: at most 50KB for approximately 25 campaigns.

The raw-lead fallback derives the same three logical projections in memory, but production must not fetch raw leads solely to calculate Overview.

### Request orchestration and caching

- On initial Overview load, start `overview.systemTotals` and `overview.performance` immediately. Start `overview.accountCampaigns` after the first of those two critical requests settles, limiting intentional Overview pressure to two concurrent reads, matching the current runtime pool ceiling.
- Keep three independent loading, error, retry, and ready states. Failure of Campaign comparison must not hide System totals or Performance; failure of Performance must not hide the already-ready System totals.
- A System range change refetches only `overview.systemTotals`. A Performance range change refetches only `overview.performance`. An Account analytics range change refetches only `overview.accountCampaigns`.
- Account selection, campaign sorting, Show archived, Remove, Restore all, and pagination are client-only and must not issue a read.
- Deduplicate identical in-flight reads by `operation + fromInclusive + toExclusive`. Do not use object identity from `DataContext` as a dependency.
- Plumb `AbortSignal` to obsolete browser requests when the range changes. Stale responses must be ignored by their request key. Cancellation must not be described as proof that a database statement stopped after it began.
- During a same-key background refresh, retain rendered data and show the existing `Refreshing…` indicator. When the key/range changes, never show old-range values beneath the new range label; show the section skeleton until the matching response arrives.
- Do not add persistent browser caching, materialized views, new indexes, a larger database pool, or a combined batch endpoint in this iteration without measurement. A later batch is allowed only if telemetry shows repeated actor/pool overhead dominates after the narrow operations ship.

### Performance measurement and budgets

- Performance targets apply to a production-shaped tenant with roughly 10k–15k lead rows:
  - Useful Overview p95: System totals and Performance ready within 5 seconds of Overview navigation.
  - Fully interactive Overview p95: Account analytics and Campaign comparison ready within 10 seconds.
  - Campaign sort, remove, restore, archive toggle, account filter, and pagination paint within 100ms and create no browser main-thread task longer than 50ms.
- Initial analytics network budget is exactly three reads. There must be no request per rate, campaign, table row, sort, filter, or removal.
- Preserve existing `dashboard_read` and `Server-Timing` data for operation, response bytes, actor resolution, database acquire/preamble/execute/commit, total time, request ID, and errors.
- Keep existing browser marks `dashboard_overview_system_available`, `dashboard_overview_performance_available`, and `dashboard_overview_useful`; add `dashboard_overview_campaigns_available`. Redefine `dashboard_overview_interactive` to fire only when all three Overview sections for their current keys are ready.
- Use paired `performance.mark()` / `performance.measure()` entries so ready times can be inspected as durations rather than isolated timestamps.
- Before optimization and after implementation, capture at least ten cold-tab and ten warm-route runs. Report p50 and p95 separately for System, Performance, Campaigns, useful Overview, and interactive Overview; do not add overlapping request durations.
- If a narrow operation misses budget, capture read-only `EXPLAIN (ANALYZE, BUFFERS)` under the runtime actor/RLS context and inspect database stage telemetry before changing SQL shape, indexes, regions, pool size, or compute tier.
- The API has a 10-second function limit and an 8-second SQL timeout. A query that regularly approaches either limit fails acceptance even if the skeleton looks smooth.

### Calculation helpers

Add small pure helpers for percentage change, cohort rates, previous-period labels, and zero-denominator behavior. Keep formulas centralized and unit-tested rather than embedding variants in JSX. Derive campaign rows in this order: API payload → account filter → archived filter → hidden-ID filter → sort → pagination. Keep hidden IDs separate from source data so refreshes and range changes cannot mutate or delete campaign rows.

## Implementation phases

1. **Metric parity and narrow read contracts — L**
   - Reproduce and explain the known compact-System-versus-summary count difference on one fixed fixture before choosing the new canonical result.
   - Add typed current/previous/lifetime invite-cohort totals globally and per account.
   - Extend compact `overview.systemTotals`; add bounded `overview.performance` and `overview.accountCampaigns` operations; remove the two broad `overview.summary` reads from the Overview page.
   - Add range-scoped `first_messages` to campaign rows and preserve explicit lifetime rate fields.
   - Mirror the three projections in the raw-lead fallback without adding raw-lead fetching to the production path.
   - Add data-layer tests for deduplication, half-open UTC boundaries, later outcomes, organic connections, zero denominators, Reply rate’s connected denominator, exact response shapes, and Neon/fallback parity.

2. **System totals and Performance percentages — M**
   - Render the agreed cohort counts and rates in System totals with explicit funnel labels.
   - Replace the raw Performance delta annotation with previous value, equal-period label, percentage change, and defined zero behavior.
   - Add selected-cohort Acceptance and Reply rate annotations to Connected and First replies while retaining the All-time conversion reference.
   - Match the exact typography, copy, three-line KPI hierarchy, and skeleton geometry defined above.

3. **Cross-account campaign comparison — M**
   - Keep Account analytics visible for All accounts and add the global campaign table 24px below its existing footer without another card surface.
   - Use the shared table and control primitives; add Account and First messages columns, lifetime rate labels, deterministic sorting, archived filtering, local horizontal scrolling, and existing campaign-detail links.
   - Add client-only Remove and Restore all behavior, hidden-count feedback, empty states, and pagination clamping.
   - Preserve account selection as a filter/drill-down rather than a prerequisite for seeing campaigns.

4. **Loading orchestration and observability — M**
   - Prioritize System and Performance, then start Account/Campaigns after the first critical read settles.
   - Add request-key stale-response protection, in-flight deduplication, and browser request cancellation.
   - Preserve same-key content during refresh and keep new-range content hidden until the matching response arrives.
   - Add the Campaigns ready mark, correct the Interactive ready definition, and preserve per-operation server timing.

5. **Regression, query, performance, and visual acceptance — L**
   - Expand interaction tests for formulas, period labels, account filtering, sorting, pagination, removal/restoration, archived rows, accessible names, request counts, cancellation, stale responses, and error/loading isolation.
   - Capture read-only query plans for any narrow operation that misses its budget; do not pre-emptively add schema objects.
   - Run the frontend build, API typecheck, focused Overview tests, analytics/data tests, telemetry tests, and diff checks.
   - Visually verify populated, empty, loading, refreshing, error, long-name, 25+ campaign, and locally scrolled table states at all three supported PC viewports.
   - Measure ten cold and ten warm runs and report p50/p95 per section and for Useful/Interactive Overview.

## Affected files/modules

- `frontend/src/lib/types.ts`
  - Add explicit cohort totals, narrow operation responses, and `CampaignMetrics.first_messages`.
- `frontend/src/lib/format.ts`
  - Centralize percentage-change, rate, and previous-period display formatting.
- `frontend/src/lib/overviewAnalytics.ts`
  - Derive the three narrow logical projections and current/previous/lifetime invite cohorts in the raw-lead fallback.
- `frontend/src/lib/leads.ts`
  - Add range-scoped first-message campaign aggregation while preserving connected-based Reply rate.
- `frontend/src/lib/dashboardReads.ts`
  - Add typed callers, request-key deduplication, and `AbortSignal` support for the three Overview reads.
- `frontend/api/_lib/data/operations/dashboard.ts`
  - Extend compact System totals and add narrow Performance and Account/Campaign operations without unrelated joins or projections.
- `frontend/api/activity-daily.ts`
  - Register and authorize the two new named reads through the existing consolidated endpoint and telemetry path.
- `frontend/src/pages/Overview.tsx`
  - Orchestrate two critical reads plus deferred Campaigns, keyed refreshes, cancellation, ready marks, and independent section state.
- `frontend/src/components/overview/OverviewAnalytics.tsx`
  - Render the exact KPI hierarchy, formulas, campaign comparison, and client-only list editing contract.
- `frontend/src/components/overview/overview.css`
  - Implement the specified five-column/three-KPI geometry, 220px rate rail, 24px subsection gap, 1180px table minimum, and local scrolling using existing tokens.
- `frontend/tests/overviewAnalytics.test.ts`
  - Pin fallback cohort and percentage semantics.
- `frontend/tests/overviewOperations.test.tsx`
  - Pin rendered formulas and campaign comparison behavior.
- `frontend/tests/dashboardSlice.test.ts`
- `frontend/tests/dashboardSlice.neon.test.ts`
- `frontend/tests/dashboardReads.test.ts`
- `frontend/tests/dashboardReadsRest.neon.test.ts`
- `frontend/tests/dataContext.test.tsx`
- `frontend/tests/readTelemetry.test.ts`
  - Update narrow-operation contracts, request orchestration, provider parity, and telemetry expectations.

## Risks & how to verify

- **Event-flow and cohort numbers could be accidentally mixed.** Verify with a fixture where an invite occurs in the selected range but connection and reply occur afterward. System totals must follow the invite; Performance activity must keep each event in its actual event period.
- **The new compact contract could preserve an existing count mismatch.** Reconcile the previously observed 4,700-versus-4,680 result on a fixed dataset before deleting or bypassing either calculation. Record which rows differ and why; do not accept visual similarity as parity.
- **Organic or pre-existing connections could inflate acceptance.** Verify a person with `connected_at` but no `invited_at` is excluded from the invite cohort and acceptance numerator while remaining in event activity where appropriate.
- **Reply rate could regress to a message denominator.** Pin exact examples: 100 invited, 40 connected, 30 messaged, 10 replied must show Acceptance `40.0%`, Message conversion `75.0%`, and Reply rate `25.0%`.
- **Previous-period math could emit Infinity or ambiguous percentages.** Pin the three zero cases and verify the UI includes the previous count and period duration.
- **Recent cohorts are immature.** Keep campaign comparison rates explicitly lifetime and keep the Performance All-time conversion reference. Labels must distinguish selected-cohort rates from lifetime rates.
- **Provider paths could disagree.** Run the same synthetic dataset through the raw-lead helper and Neon-compatible summary tests and compare cohort totals and campaign first-message counts.
- **Narrow endpoints could still repeat expensive authentication or wait for the pool.** Measure actor, acquire, preamble, execute, commit, and total stages per operation. Batch only if post-split measurements show shared overhead, because batching would couple section failures and ranges.
- **A smaller payload does not prove a faster query.** Compare response bytes and database-stage time separately. Any index, CTE/materialization change, region move, pool increase, or compute-tier change requires a runtime-context plan and production-shaped evidence.
- **Starting all reads at once could starve the useful content.** Assert that only System and Performance start immediately and that Campaigns starts when the first critical read settles; verify there are never more than two intentional Overview reads in flight.
- **Client caching could show stale ranges.** Key every response and in-flight entry by operation/from/to, ignore stale completions, preserve only same-key refresh content, and test rapid 7-day → 30-day → 7-day changes.
- **Removing rows could look destructive.** Use “Remove from comparison,” never “Delete,” provide Restore all immediately, and confirm no network mutation occurs.
- **Filtering/removal could break pagination.** Test removing the only row on the last page, switching account filters, toggling archived rows, and restoring after a range refresh.
- **The wider table could become unreadable.** Verify a local horizontal scrollbar, sticky readable headers, keyboard-reachable controls, and no page-level overflow at 1280, 1440, and 1920 widths.
- **Smooth skeletons could hide a failed performance goal.** Acceptance uses measured Useful and Interactive durations plus server stages; loaders do not compensate for requests approaching the 8-second SQL or 10-second function limits.
- **Rate labels could outlive stale fields.** Do not fall back from missing lifetime rates to range rates; render `—` and surface the issue in contract tests.

## Definition of done

- System totals shows Leads plus the invited-cohort Invited, Connected, Messaged, and Replied counts with the agreed percentages and one-decimal formatting.
- For the fixture 100 invited, 40 connected, 30 messaged, 10 replied, the page shows Invited `100.0%`, Connected `40.0%`, Messaged `75.0%`, and Replied/Reply rate `25.0%`.
- System totals remains the first analytics section and uses five equal three-line KPI cells with no progress bars, nested cards, decorative effects, or layout shift when rates load.
- A 7-day Performance selection compares against the immediately preceding 7 days; a 30-day selection compares against the immediately preceding 30 days; a closed custom range compares against the immediately preceding range of identical duration.
- All three Performance KPIs show current counts, previous counts, and safe percentage-change labels. Connected also exposes cohort Acceptance rate, and First replies exposes cohort Reply rate.
- Performance retains the existing event-time chart and 220px All-time conversion rail; Connected and First replies use the exact numerator/denominator metadata copy defined above.
- Reply rate is `replied / connected` everywhere touched by this feature.
- All accounts view contains both Account analytics and a cross-account Campaign comparison table.
- Campaign comparison includes Account, Campaign, four milestone counts, lifetime Acceptance and Reply rates, Remove, and Open controls; campaign-detail links remain correctly encoded.
- Campaign comparison sits 24px below the account-table footer inside the same section, uses the exact toolbar/control order, has a sticky header and 1180px minimum width, and scrolls locally without page overflow.
- Archived campaigns are excluded by default and appear when Show archived is enabled.
- Removing a campaign changes only the visible comparison list, survives in-page filters/range changes, is reversible with Restore all, and resets after a full reload.
- Empty, zero-denominator, no-comparison, loading, refresh, and error states are explicit and contain no `NaN`, `Infinity`, or misleading `0%` rates.
- Neon and raw-lead fallback tests agree on cohort totals, range boundaries, campaign first-message counts, and connected-based Reply rate.
- The Overview page no longer calls broad `overview.summary`; it issues exactly one System, one Performance, and one Account/Campaign read for the initial ranges, with no per-row or per-interaction reads.
- System and Performance start first; Account/Campaign starts after the first critical read settles. Identical requests are deduplicated, obsolete requests are cancelled/ignored, same-key refreshes preserve visible data, and new keys never display old-range values.
- Response payloads meet the plan ceilings: System ≤1KB, Performance ≤20KB, Account/Campaigns ≤50KB for the acceptance tenant, or the handoff includes measured evidence and an approved adjustment.
- On a production-shaped 10k–15k-lead tenant, at least ten cold and ten warm measurements establish Useful Overview p95 ≤5s and Interactive Overview p95 ≤10s. Each campaign-table interaction paints within 100ms with no >50ms main-thread task.
- Server logs and Browser Timing expose per-operation bytes plus actor/acquire/preamble/execute/commit/total timing; browser measures include System, Performance, Campaigns, Useful, and Interactive readiness.
- `npm run build`, `npm run typecheck:api`, focused Overview/analytics tests, and `git diff --check` pass from `frontend/` or the appropriate repository root.
- Visual QA passes at 1280×720, 1440×900, and 1920×1080 with no page overflow and with keyboard-accessible sort, remove, restore, filter, pagination, and campaign links.
