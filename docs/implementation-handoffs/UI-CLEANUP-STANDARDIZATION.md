# UI cleanup and standardization — phases 1–7 implemented, phase 8 open

Implementation of `specs/2026-09-14-ui-cleanup-standardization.md`. Frontend
only: no product logic, no database, no external system and no deployment was
touched.

| | |
|---|---|
| Base SHA | `5c298ed` (`main`, "docs(spec): Phase 2 shipped, notebook-1 pilot checklist") |
| Branch | `main` (local) |
| Commits | `b27cece` → `da8d46e` → `81a1659` → `156356d` → `bfb6ecb` → `743a76c` |
| Pushed | **no** |
| Deployed | **no** — phase 8 needs an explicit deployment authorisation |
| Data / schema / agent changes | none |

## What each commit did

| SHA | Phase | Scope |
|---|---|---|
| `b27cece` | 1–2 | Token foundation, shared primitives, light-only shell, dev gallery |
| `da8d46e` | 3 + part of 4/5 | English reply surface: Replies, Sentiment Analysis, the reply-domain labels |
| `81a1659` | 4 | Leads, Follow-ups, Pipeline, the conversation drawer |
| `156356d` | 5 | Overview (glass layer deleted), Account, Campaign, Review |
| `bfb6ecb` | 6 | Sequences and builder, Playbook, Searches, Team, CSV, Health, Chat, ICP/Hypotheses/Neon, auth |
| `743a76c` | 7 | Legacy removal, `docs/ui-standard.md`, `tests/uiPrimitives.test.tsx`, browser measurement |

The standard itself is `docs/ui-standard.md`, linked from CLAUDE.md and
AGENTS.md. This handoff records what was verified and what was not.

## Checks actually run

Repeatable, on every commit:

- `npm run build` (`tsc -b && vite build`) — green.
- `npm run test` — **1244 tests across 74 files**, green. Baseline before the
  work was 1228/73; the new file is `tests/uiPrimitives.test.tsx` (16 tests).
- `npm run typecheck:api` — green.
- `git diff --check` — clean.

Suites updated because they asserted copy or placement this work deliberately
changed, not because they broke:

| Suite | Change |
|---|---|
| `repliesInboxComponents` | Russian strings → the English ones |
| `sentimentAnalysis` | Russian strings → the English ones |
| `navigation` | `Sequence Builder` → `Sequences` (one user-facing name) |
| `sequenceBuilderPage` | Deployment filters now open in a sheet; heading renamed |
| `playbookPage` | `Saved` → `Changes saved`, `last saved` → `Last saved` |

Everything else passed untouched, including `leadsExplorerDigest` — which pins a
deliberate divergence in the digest panel's error handling and still holds after
the panel moved below the results.

Measured in a real browser (Chromium, the dev server, the `#/ui-gallery` route)
at 1280×720, 1440×900 and 1920×1080:

| Check | Result |
|---|---|
| Theme | `data-theme="light"` before the first frame; body `rgb(247,248,250)`, `background-image: none` |
| Decoration | `backdrop-filter` on **0** elements; **0** gradient backgrounds |
| Type | h1 28/36, body 16px, KPI 32/40, input 16px |
| Controls | Button 44px tall, 8px radius; icon button exactly 44×44 |
| Borders | Input border `rgb(122,134,153)` = `#7A8699`; table frame 12px |
| Three-pane grid | resolves to `320px 560px 360px` |
| Overflow | none at 1280, 1440, 1920, or at 640×360 (a 1280×720 window at 200% zoom) |
| Gutters / max width | 24px at 1280, 32px at 1440+, `max-width: 1600px` |
| Text size floor | **0** elements below 13px (LinkedIn preview excluded by design) |
| Contrast | **0** AA failures across every primitive in every state |
| Overlay | Escape closes, background `inert`, scroll locked and released, focus returned to the trigger |
| First result on a list route | **332px** at 1280×720, against a budget of 340 |

Two defects were found by that measurement and fixed in `743a76c`: `initialsOf`
turned a profile URL into `I` (the `in/` path segment) rather than the slug's
initial, and `Dialog` deferred its initial focus to `requestAnimationFrame`,
which never fires in a background tab — so the dialog could open with focus
still behind it. Both are covered by tests now.

## What was NOT verified, and why

- **No live route was opened in a browser.** Signing in needs a password this
  session does not have, and the plan forbids product or data changes during
  implementation. Route-level rendering rests on the existing jsdom suites
  (`overviewOperations`, `campaignWorkspace`, `repliesInbox*`,
  `sentimentAnalysis`, `leadsExplorerDigest`, `sequenceBuilderPage`,
  `playbookPage`, `quickNavigation`, `dateRangePickerAccessibility`, …) plus the
  build. The 20-route visual matrix is phase 8 work.
- **No write path was exercised.** Save, conflict, import, publish and export
  were not run — not even on disposable fixtures — because nothing in this work
  changed a request, a payload or a mutation. Their existing suites pass. The
  plan's isolated mutation scenarios remain owed before release.
- **No deployment.** Phase 8 is explicitly a separate operation requiring
  authorisation.
- **`sync-agent/`, `postgres/` and `frontend/api/` are untouched.**

## Open items (phase 8)

1. Deploy the verified commit.
2. Authorised read-only production smoke of the same 20 route types at the three
   target sizes, compared against the gallery.
3. Run the write checks — save, conflict, dirty navigation, CSV phases, publish
   — in an isolated environment before release.
4. Record deployment Ready, the browser evidence and the write results
   separately. Ready is not UI acceptance.
5. If visual or behavioural acceptance fails, roll back the frontend release
   only. Nothing here requires a database rollback.

## Deliberate deviations from the plan

- **Plain `ui-`-prefixed classes rather than CSS Modules.** Vitest does not
  process CSS, so a CSS-Module import resolves to `{}` and every `styles.x`
  becomes `undefined` in a class string — the jsdom suites query by class. The
  isolation the plan wanted comes from the prefix instead.
- **`src/styles.css` still exists.** It is the compatibility entrypoint the plan
  allows, and it now only shrinks. Its remaining button, field, segmented and
  table rules are literally the primitives' declarations, so a call site cannot
  look different from a converted one; converting one is a pure refactor.
- **The mobile drawer in `Layout.tsx` was left alone.** The plan says not to
  design new mobile navigation; deleting the existing one would have made the
  app unusable below 900px, which is a product change, not a cosmetic one.
