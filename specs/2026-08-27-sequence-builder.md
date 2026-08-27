# Sequence Builder

## Goal

Replace the team's Google Docs workflow for drafting LinkedIn outreach sequences with a shared, structured workspace inside the dashboard. A sequence contains one optional connection request, an ordered set of follow-up message steps, multiple text variations per step, review comments, named A/B/C branches assembled from those variations, and an approximate LinkedIn web/mobile preview.

## Non-goals

- Publishing, syncing, or exporting sequences directly to Linked Helper 2 or LinkedIn.
- Assigning leads to experiment branches, running traffic allocation, or reporting A/B test results.
- Images, files, PDFs, rich-text formatting, or arbitrary document embeds.
- Google Docs-style live cursors or character-by-character collaborative editing.
- Pixel-perfect guarantees that the preview matches LinkedIn's current production UI.

## Research findings

- Routes are lazy-loaded in `frontend/src/App.tsx`, while `frontend/src/lib/navigation.ts` is the canonical registry for sidebar placement, titles, permissions, skeletons, and quick navigation.
- `frontend/src/pages/SearchLibrary.tsx` provides the closest existing card-list and modal editing patterns. `frontend/src/components/ImportHistoryPanel.tsx` provides local block-editor patterns, and `frontend/src/components/ConversationDrawer.tsx` provides the existing message-bubble visual language.
- Existing `campaign_steps` rows are synchronized LH2 telemetry and must not be reused for editable drafts. Sequence Builder needs a separate persistence domain.
- Human writes already cross an authenticated server API boundary. The project is at the Vercel Hobby function limit, so Sequence Builder operations should be consolidated into an existing or single new multiplexed endpoint rather than split into many functions.
- The portable Neon baseline is append-only. Persisted entities require a new ledger step, hashes, RLS/grants/indexes, and clean-room/inventory test coverage.
- Existing annotations and lead notes cannot represent sequence-, step-, variation-, or selection-level threaded comments.
- No drag-and-drop or structured text-editor library is currently installed. `dnd-kit` fits accessible cross-container sorting. A plain-text Lexical editor can model anchored selection comments without enabling rich formatting.
- Selection comments cannot safely rely only on raw character offsets: edits, deletions, copy/paste, and overlapping comments require stable editor marks plus explicit orphaned-context behavior.
- Connection-request limits can change and emoji are not reliably counted with JavaScript `string.length`; warnings should use grapheme-aware counting and configurable limits.

## Decisions

- V1 is a shared drafting and review workspace that replaces Google Docs. It does not publish to LH2 or LinkedIn.
- Users can reorder whole steps, move individual variations between steps, and convert content between follow-up messages and the connection request. There is exactly one connection-request step, it remains first, and it may be empty.
- A master sequence can contain multiple variations per step. Users assemble named branches such as A, B, and C by selecting one variation per step. V1 prepares these branches only; it does not execute or measure an experiment.
- All active members can create and edit sequences and can add, reply to, resolve, and reopen comments. If selected text is deleted, its comment remains visible with an outdated-context state.
- Sequence Builder appears under Strategy.
- Changes autosave. The API uses document revisions to prevent silent overwrites, but V1 does not provide real-time co-editing or live cursors.
- Sequences have version history and use archive rather than destructive deletion in the primary UI.
- Text supports emoji and a fixed catalog of personalization variables. Preview uses sample values. Connection-request length violations are warnings, not blockers.
- Sequence cards show the name, a short content preview, counts for steps/variations/branches, author, and last update.
- Preview lets the user choose a variation for each step and switch between approximate LinkedIn web and mobile renderings.

## Approach

Create an independent Sequence Builder domain with normalized sequence metadata plus a revisioned JSON document. The document holds ordered steps, stable variation IDs, plain-text editor state, branch selections, and sample preview values. Separate comment/thread rows reference a sequence, optional step/variation IDs, and optional editor mark IDs; comment messages remain queryable and resolvable without rewriting the full document.

Expose authenticated list/detail/save/archive/comment operations through one multiplexed server endpoint backed by the existing provider abstraction. Each save supplies the last known revision; stale saves receive a conflict response and the current document instead of overwriting it. Successful saves append a compact version snapshot and increment the revision.

Build the UI as two route states: a searchable responsive card library and a full editor. The editor presents steps vertically, variations side by side on wide screens and stacked on narrow screens, with accessible drag handles, add/remove/convert actions, autosave status, comment affordances, and branch management. A preview panel reads an explicit branch or temporary per-step selection and renders reusable web/mobile LinkedIn-style shells.

Use a plain-text structured editor for each variation so emoji, personalization tokens, selection marks, undo, and anchored comments share one model. Drag operations preserve stable IDs and repair branch selections when a selected variation moves or disappears. Connection-request warnings use grapheme-aware character counts.

## Implementation phases

1. **Persistence and contracts (L)** — Add the append-only tenant ledger step, sequence/comment/version tables, constraints, indexes, RLS/grants, provider operations, schema documentation, and focused clean-room/API tests.
2. **Library and navigation (M)** — Add the Strategy navigation item, lazy route, route-local reads, responsive sequence cards, search, create, open, and archive flows.
3. **Core editor and autosave (L)** — Implement ordered steps, side-by-side variations, plain-text/emoji/token editing, revision-aware autosave, warnings, add/remove, reorder, cross-step moves, and type conversion.
4. **Comments and review (L)** — Implement block- and selection-level threaded comments, replies, resolve/reopen, mark rendering, and outdated-context behavior.
5. **Branches and preview (L)** — Implement named A/B/C branch assembly, automatic repair of invalid selections, per-step preview selectors, sample token substitution, and approximate LinkedIn web/mobile shells.
6. **Verification and release (M)** — Run schema, API, frontend, accessibility, build, and visual checks; commit logical units and deploy only if the repository's current release path and environment are available and safe.

## Affected files/modules

- `frontend/src/App.tsx`
- `frontend/src/lib/navigation.ts`
- `frontend/src/lib/types.ts`
- `frontend/src/lib/dashboardReads.ts`
- `frontend/src/lib/DataContext.tsx`
- New `frontend/src/pages/SequenceBuilder*.tsx` page modules
- New `frontend/src/components/sequence-builder/**` editor, comments, branches, cards, and preview components
- New `frontend/src/lib/sequenceBuilder.ts` document operations and validation
- `frontend/src/styles.css`
- A consolidated `frontend/api/sequence-builder.ts` endpoint or an equivalent operation family folded into an existing endpoint
- `frontend/api/_lib/core.ts`
- `frontend/api/_lib/data/**` provider operation registries and Neon implementations
- New append-only files under `postgres/tenant-baseline/v1/ledger/` plus `ledger.manifest.json`
- Navigation, routing, API, document-operation, clean-room, and visual behavior tests

## Risks & how to verify

- **Lost edits during autosave:** simulate two clients saving the same revision and verify the stale client receives a conflict without data loss.
- **Broken selection comments after edits:** test insertion before/inside a mark, partial and full deletion, overlapping marks, undo/redo, and reload persistence.
- **Branch drift:** move/delete selected variations and verify every branch either keeps its selection or shows an explicit missing-selection state that can be repaired.
- **Invalid connection-request state:** move and convert content across steps and verify there is still exactly one first connection-request step, including when it is empty.
- **Drag accessibility:** verify pointer, touch, and keyboard reordering with focus preservation and announcements.
- **Editor scale:** exercise realistic sequences with many steps and variations and confirm acceptable input latency and autosave behavior.
- **Preview overpromises fidelity:** label preview as approximate, test both responsive shells, and keep rendering independent from persisted content.
- **Provider/schema drift:** run portable baseline clean-room creation, inventory/hash checks, API provider-contract tests, and PostgreSQL parser-backed validation.
- **Navigation/access mismatch:** test sidebar, quick navigation, direct routes, active-member authorization, and signed-out behavior.

## Definition of done

- An active member can create, rename, open, edit, archive, and restore a sequence from a card-based Strategy page.
- A sequence always has one optional/empty connection-request step followed by any number of reorderable message steps.
- Users can add multiple variations, edit plain text with emoji and supported variables, and move/convert variations and steps through pointer and keyboard controls.
- Autosave visibly reports saving/saved/conflict states, preserves changes after reload, and never silently overwrites a newer revision.
- Users can add threaded comments to a sequence block or selected text, reply, resolve, reopen, and still find comments whose selected text was deleted.
- Users can build named A/B/C branches by choosing one variation per step.
- Users can preview a branch or temporary selection in approximate LinkedIn web and mobile layouts with sample personalization values and connection-note warnings.
- The feature has focused unit/integration tests, passes the repository's relevant typecheck/build/schema checks, and receives visual QA at desktop and mobile sizes.
- The implementation is delivered in logical Git commits with unrelated work preserved.
