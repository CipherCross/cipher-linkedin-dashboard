# Analytics home redesign

## Goal
Show the scale and accumulated results of the whole outreach system, then let users explore performance by date, account, campaign and lead. Use the user-supplied Upwork dashboard references for the hierarchy: system totals, a large performance panel, an account comparison table, and progressively deeper records.

Status: implementation approved on 2026-09-08, with an independent System totals timeframe selector and a strong liquid-glass treatment. The accompanying concept uses fictional sample data; it is not a production screenshot.

## Non-goals
- Inbox, follow-up queue, or sequence operations as the main home-page content.
- Changes to funnel definitions, classification, CRM automation, ingestion, or production state.
- Unverified performance scores, AI explanations of causes, or weekly replies divided by weekly invites.
- A global application restyle without separately confirming its scope.

## Research findings
- Two independent Luna researchers reviewed the current Overview, navigation, summary contract, existing components, and relevant design guidance.
- At research time, `Overview.tsx` rendered three weekly totals and an all-campaign table. It includes archived campaigns and mixes explicitly labeled lifetime rates with weekly invite counts. There are no rendered trends or account comparison controls.
- `OverviewSummary` already includes current/previous totals, accounts, campaigns, daily activity, intent and other summary fields. Reuse the bounded server summary rather than fetching all raw leads to build the new page.
- Existing date picker and analytics components provide useful logic, but the new design need not reuse their old visual arrangement.
- Daily activity represents events; headline counts represent milestone-based lead counts. Validate reconciliation before using activity as a daily breakdown of headline totals. If those definitions differ, add a consistent milestone aggregation or label the chart separately.
- True invite-cohort conversion is not supplied by the existing summary and requires a separate bounded aggregate.
- Primary design references: [Material cards](https://m2.material.io/components/cards/web) for clear visual hierarchy, and [Material data tables](https://m2.material.io/design/components/data-tables.html) for comparison and nearby controls.

## Decisions
- Primary purpose: user explicitly answered **show analytics**.
- Visual scope: user explicitly answered **Completely new visual direction**.
- Audience: user explicitly requested whole-system general numbers AND in-depth per-account analytics. Default to all accounts with account drilldown.
- Proposed default: inclusive last seven UTC days versus preceding seven, with today labeled incomplete. Implementation should expose the existing date picker and equal-length comparison.
- Reference direction: spacious rounded panels, blue primary accent, restrained chart series colors, large totals, a large trend chart with adjacent rates, and a dense account comparison table. User explicitly requested heavy liquid glass: translucent layered surfaces, blur/saturation, refractive highlight edges, dimensional shadows and ambient background color; preserve crisp text, accessible contrast, fallback surfaces and reduced-transparency support. Support light and dark themes. User screenshots are design references, not instructions to perform billing, export or other actions.
- System totals has its own independent timeframe selector (user requested). Default All time; dated ranges show Leads added and milestone activity within that range. Performance keeps its own timeframe and account selection. Neither selector changes the other section.
- Five proposed system totals: account-scoped leads, invited leads, accepted connections, leads with a first recorded message, and leads with a first reply. Show account count and data freshness separately.
- Keep `/` and existing navigation destinations. The concept illustrates a restyled sidebar; production sidebar styling scope remains to be agreed.

## Approach
### First screen
1. **System totals:** five numbers across all accounts: Leads (Leads added for dated ranges), Invited, Connected, Messaged and Replied. A dedicated System totals date picker defaults to All time and supports its own presets/custom dates. This section remains global when exploring an account; selected dates are explicit.
2. **Performance:** selected-period invited, accepted and first-reply counts with previous equal-period deltas; one large daily trend chart; adjacent all-time acceptance/reply rates for the selected account scope, including numerators and denominators. Keep activity and conversion scope labels visible. No cost, profile-view or credit metrics are inferred from the Upwork reference.
3. **Account analytics:** default table shows each account, selected-period invites, accepted connections and first replies, lifetime acceptance/reply rates, and last sync. Users can compare accounts directly and select one to drill down.
4. **Account detail:** selecting an account updates the Performance section and replaces the account table with that account's campaigns. Show account lifetime totals below its campaigns and provide a clear All accounts return action. Production should preserve this state in existing routes/query conventions and support direct account links.
5. **Lead detail:** selecting a campaign exposes a compact paginated lead detail view or navigates to the existing filtered campaign/Leads route. The concept demonstrates recent first replies with account, campaign, timestamp and intent context. Opening full conversation detail uses existing authorized routes and drawers.

The Performance date selector controls period metrics, trend and tables; it does not change the independent System totals range or lifetime conversion. The account selector controls Performance, account totals, campaigns, leads and freshness; system totals remain global. Empty, stale and partial-data states must keep this distinction clear.

The concept demonstrates Last 7 days and Last 30 days. Implementation should reuse the existing date picker for custom ranges and offer Today/Yesterday only with honest partial-day comparison labels.

Default campaign comparison excludes explicitly archived campaigns, with an accessible Include archived control; unknown archive status remains included. Lifetime system/account totals retain historical results regardless of this table filter. Sort and paginate tables, show rate sample sizes, and preserve access to all matching records.

### Subsequent analytics expansion
Add a dedicated **Conversion by invite cohort** section only after defining a server contract: cohort date, unique invited denominator, accepted/replied numerator definitions, observation cutoff, and maturity labeling. Do not substitute daily events or lifetime ratios. P3 and booking analytics are optional follow-on work; completeness and maturity denominators must be visible.

### Data and interaction
Keep presentation state local or URL-backed using existing conventions. Account and date changes update only the sections governed by that scope, as defined above. The System totals strip changes only through its own timeframe picker; scope labels make this deliberate behavior explicit. Fetch cancellation must prevent responses from an earlier account/range overriding the current selection. Preserve authorization and legacy-path behavior; never show an error as a zero.

The revised visual concept demonstrates system totals, account selection, seven/thirty-day changes, account-to-campaign drilldown, sample lead detail and returning to all accounts. It uses illustrative data only and focuses on page content; the existing application shell remains outside the concept. Custom dates, archive controls, sorting, full pagination and actual conversation navigation belong to implementation.

System and account lead totals must deduplicate campaign memberships by `(instance_id, profile_url)`. The same profile reached from two different accounts remains two account-scoped leads. Campaign rows count their own memberships and therefore are not guaranteed to sum to deduplicated system or account totals. Displayed lifetime rate numerators must be true subsets of their lifetime denominators, preserving existing reply-rate semantics (connected leads who replied / connected leads). Add explicit all-time aggregates where the existing selected-period wire fields cannot supply them. Do not assume the current account detail already uses this deduplication; Luna found row-based recomputation that needs verification.

## Implementation phases
1. **S — Finalize design and metric contract.** Confirm lifetime summary labels and final visual direction; reconcile daily events versus milestone counts, account/campaign membership deduplication, and per-campaign first replies. Shared shell redesign remains separate.
2. **M — Consistent analytics data.** Provide explicit global independently range-scoped totals and independently scoped period analytics. Extend the bounded summary where appropriate for account filtering, previous-period daily points, per-row period counts and lifetime denominators; measure whether a separate bounded detail read is preferable. Aggregate account rates from underlying counts. Add focused parity/UTC/null-denominator tests.
3. **M — New home layout.** Implement independently date-filtered system strip, performance/chart/rates panel, account table, account-to-campaign-to-lead drilldown and scoped controls. Reuse server-paginated lead reads rather than loading all raw leads. Retain `/` and existing product routes. Add per-section loading, retry, no-data and stale states.
4. **S — Verify and hand off.** Build, run relevant tests and visually inspect responsive light/dark layouts. Commit scoped implementation only after checks. Deployment is a separate step.
5. **M — Optional cohort analytics.** Design and validate a bounded cohort query before adding conversion-over-time UI; this is outside the first release.

## Affected files/modules
- `frontend/src/pages/Overview.tsx`
- `frontend/src/styles.css` (scoped new styles; avoid changing unrelated pages)
- New dedicated home presentation components under `frontend/src/components/`
- `frontend/src/components/DateRangePicker.tsx` (reuse)
- `frontend/src/pages/AccountDetail.tsx`, campaign detail and Leads Explorer routes (reuse and verify aggregation semantics before sharing totals)
- `frontend/src/lib/dashboardReads.ts` and `frontend/src/lib/types.ts`
- `frontend/api/_lib/data/operations/dashboard.ts` where aggregates need extending
- `frontend/src/lib/navigation.ts` and `frontend/src/components/Layout.tsx` only if shared shell changes are approved
- `frontend/tests/overviewOperations.test.tsx`, `frontend/tests/dashboardReads.test.ts`, and relevant dashboard aggregate tests
- Shared AI schema documentation only if an exposed contract or schema changes

## Risks & how to verify
- **Misleading conversion:** keep period counts and lifetime/cohort rates distinctly labeled. Test unique lead and instance-scoped counting; preserve unknown archive state.
- **Daily/total mismatch:** compare sums of daily bars with headlines on fixtures containing repeat replies, imports, timezone boundaries and incomplete days. Specify divergence explicitly if chart semantics intentionally differ.
- **Slow first view:** use bounded summary reads; verify useful content does not wait for the full lead dataset. Compare request count and render timing against the current page.
- **Scope mismatch:** global System totals remains account-independent and uses its own dates; account filtering affects Performance/detail sections; performance dates affect their period values only. Test that each scope changes exactly its documented sections.
- **Duplicate campaign memberships:** add fixtures where one profile belongs to multiple campaigns in one account and another account. Count it once per account for global/account totals, preserve campaign membership rows, and prevent averaging percentages. Document why campaign-row sums can exceed account totals.
- **Incomplete records:** surface stale/missing sync and unknown values; never imply that lack of captured messages proves lack of human work.
- **Visual/accessibility regressions:** verify 360, 736, 1024 and larger desktop widths; keyboard controls, readable labels, light/dark contrast and empty/error states. Allow local table scrolling only where needed.
- **Validation boundary:** synthetic QA proves layout and interactions, not authenticated tenant results. Record authenticated verification separately if performed.

## Definition of done
- Approved system-to-account analytics design; all-time and period scopes are explicit and shared-shell changes are separately scoped.
- System-wide results with an independent timeframe remain visible while exploring an account. Users can compare accounts, inspect campaigns and reach corresponding lead records.
- Users can compare current/previous activity and campaign/account contributions without interpreting a weekly funnel.
- Charts, headline values and table scopes reconcile under documented definitions.
- Scope controls, drill-downs, null/error/loading states and archived inclusion work.
- Relevant tests and frontend build pass; responsive visual QA is complete.
- Changes are committed with unrelated edits preserved; production status is reported separately.

## Delegation and validation record
- Before dispatch, reviewed the official GPT-5.6 family prompting guidance and Luna model documentation. Use outcome-focused prompts, one statement per invariant, explicit file ownership and completion evidence; no unrelated prompt scaffolding. Sources: https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6#prompting-best-practices and https://developers.openai.com/api/docs/models/gpt-5.6-luna .
- Luna assignments: additive analytics aggregation/legacy parity; Overview request/date state and tests; chart/account/campaign components; scoped liquid-glass styling and accessible date popovers. Parent owns integration review, responsive QA, final checks and commits. User explicitly requested Sol for review; separate Sol passes cover data correctness and UI/accessibility.
- Production deployment and tenant/provider operations are outside this implementation session.

## Local implementation verification — 2026-09-08

The approved implementation is complete locally. The page uses a scoped liquid-glass stylesheet, independent URL-backed System totals and Performance date ranges, account drilldowns, sortable paginated tables, archive inclusion, lifetime totals and explicitly lifetime conversion rates. Campaign links reuse the existing campaign detail route. System/account analytics deduplicate campaign memberships by account and profile, using earliest recorded milestones; campaign rows retain their own memberships. No schema migration or live data write was needed.

Validation evidence:
- Frontend production build and API typecheck passed. Vite retains its bundle-size advisory.
- The five focused suites passed 245 tests: Overview orchestration and real component behavior, analytics aggregation, dashboard operations, read contracts and date-picker accessibility.
- The exact summary SQL was exercised in temporary PGlite against synthetic duplicate memberships, cross-account profiles, NULL timestamps, UTC offsets, dated/all-time/single-day/open-ended ranges and an empty database. Its analytics payload matched the legacy helper in each case. No tenant database was used.
- The actual Overview components were rendered with synthetic account fixtures in a temporary local Vite harness. Browser checks passed at 360, 736, 1024 and 1440 pixels in light and dark themes, with no page overflow. Both calendar dialogs remained within the viewport. Account drilldown, lifetime totals, archive inclusion, campaign links, independently changing date ranges and section-specific failures passed without browser runtime errors.
- Luna agents implemented the data, page, component and styling changes; Sol reviewed aggregation and UI correctness. Review findings covered invalid/empty accounts, pagination, long-range chart labels and date-picker placement/accessibility, and were corrected.

Verification boundary: this proves local implementation and synthetic interactions. Authenticated tenant rendering, production query performance and deployment were not exercised. Production deployment remains a separate action.
