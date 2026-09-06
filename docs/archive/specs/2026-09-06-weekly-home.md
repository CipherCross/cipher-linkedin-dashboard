# Weekly home screen

## Goal
Make Overview immediately show outreach activity across all accounts for the last seven days compared with the preceding seven days. Follow it with one campaign/account row showing acceptance rate, reply rate, and invited leads.

## Non-goals
Deployment, notebook changes, funnel migrations, sequence authoring changes, and changing metrics on other pages are outside this implementation.

## Research findings
Overview previously loaded a sequence hub plus an overview aggregate, defaulted to 90 days, and repeated operations, account, and analytics sections. The existing date helpers use inclusive UTC days and provide an equal-length previous period. Existing period campaign rates mix milestone flows; they cannot safely be relabeled as lifetime rates. Preserve the bounded summary read and legacy provider path.

## Decisions
The user approved defaults with “do the defaults”: three overall counts (invites, connections accepted, leads who replied), seven days versus the preceding seven days, all-time campaign rates, and separate campaign/account rows. Use the existing seven UTC calendar days including today; explicitly label the partial day and exact dates. Reply rate preserves the product denominator of connected leads; it is not replies divided by weekly invites. Include historical and empty campaigns, with archived campaigns labeled, sorted by weekly invites descending. Replace the crowded home sections with these two sections; retain navigation to sequences and sync health.

## Approach
Use overview.summary for current and previous global counts and campaign weekly invites. Add explicitly named lifetime acceptance/reply rates computed from all milestone rows within each campaign. Never average campaign percentages into overall counts. Keep existing range rate fields unchanged for other consumers. Legacy mode derives equivalent lifetime campaign rates from its complete snapshot. Show undefined rates as an em dash, numeric deltas even when the previous value is zero, read errors with retry, sync freshness, and empty/loading states. Refresh UTC date boundaries while the page remains open.

## Implementation phases
1. (S) Add lifetime fields to the summary payload and client contract.
2. (M) Replace Overview with three comparison cards and the campaign table, including responsive layout and legacy parity.
3. (M) Verify rendering, denominator behavior, period boundaries, build and API typecheck; make a logical commit.

## Affected files/modules
- frontend/api/_lib/data/operations/dashboard.ts
- frontend/src/lib/types.ts
- frontend/src/pages/Overview.tsx
- frontend/src/styles.css
- frontend/tests/overviewOperations.test.tsx

## Risks & how to verify
- Delayed replies: lifetime rate numerators must belong to their denominator, independent of the seven-day activity period.
- Empty denominators: render an em dash, never infinity or a fabricated zero rate.
- Midnight and incomplete current day: show UTC dates and refresh date boundaries; previous period must not overlap.
- Provider parity: test the legacy calculation with earlier invitations and recent acceptance/reply milestones.
- UI regressions: test exact counts, account identity, campaign links, ordering and errors; visually inspect desktop and mobile.
- Deployment scope: local verification does not establish authenticated production behavior.

## Definition of done
Overview defaults to the approved seven-day comparison and contains only the primary weekly summary and campaign table. Campaign rows display the approved scope labels, correct counts/rates, account names, and working detail links. Relevant tests, production build, and API typecheck pass; a commit records only this work. No live deployment is implied.

## Verification record
Implemented locally on 2026-09-06. Build and API typecheck passed; 230 targeted tests passed. The actual campaign SQL CTE and JSON projection ran in a temporary PGlite PostgreSQL engine with delayed outcomes and null denominators. Browser QA used the actual Overview component and stylesheet with synthetic data at 1280px and 390px; no page overflow, and the mobile table scrolls within its container. This is not authenticated production verification, and no deployment was performed.
