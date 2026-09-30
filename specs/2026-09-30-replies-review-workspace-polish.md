# Replies: review workspace polish

Declutter `#/replies`, make the thread read as a chat, keep the review form visible
at every desktop width. Review stays the workflow: select → read → label → Save and
next. No composer, no sending.

## Status (2026-09-30)

Phases 1–4 are built and committed on `main`, **not pushed or deployed**:
`992e76c` (one list page at a time), `1acdfcf` (layout + messenger thread),
`962b0df` (lead photos), and `06948d3` (drawer). Verified in the
`ui-fixture` browser at 1280×720, 1440×900 and 1920×1080 (review form and Save on
screen without a click at all three; first row at y≈190; 11 rows visible at
1440×900), and with the `photos-admin` fixture scenario (photos by lead id,
broken image → initials).

Deviations from the plan below, decided while building:
- Bands are **≥1120** (list 288 · review 340) and **900–1119** (rail 64 · review
  320), not ≥1180 / list 300: at 1440 with the sidebar open the container is
  1160px, and the full list had to fit there.
- Queue rows show the time today and the date before that; the exact time is the
  tooltip.
- The drawer now shows Madrid times (it used the browser's clock).

Still open: phase 5 (contact names, own spec), a signed-in production smoke, and
push + deploy.

## Context

A peer product's inbox reads as far more finished than ours at the same type scale
(13/14px). The gap is structural, confirmed in code on 2026-09-30 (`main` = `origin/main`
at `9302f22`, Supabase retirement merged, review save fix present):

1. **The review form is hidden at laptop width.** Below a 1240px workspace container
   (any 1280–1440 screen with the sidebar open) the grid drops to two panes and the
   inspector sits behind "Review reply and next step →" (`replies-inbox.css:85-93`,
   `Replies.tsx:521-525`).
2. **No faces.** Rows use `InitialsAvatar`; the inbox read returns no `lead_id` or
   `photo_path` (`api/_lib/data/operations/replyReviews.ts:361-376`). Many threads have
   no `leads` row at all (chat-sync contacts, existing connections), so no name exists.
3. **Bubbles aren't chat.** Inbound `--surface-2` vs outbound `--accent-subtle`, both
   bordered cards with a name + time header per message (`replies-inbox.css:154-168`,
   `ConversationThread.tsx:73-87`). The Drawer draws a different bubble
   (`ConversationDrawer.tsx:819-909`).
4. **Chrome stacking.** Title row, toolbar row, "Review queue · 50 loaded · more
   available", search, "Load more"; rows are 4–5 lines tall.

## Rules carried forward (binding)

The 2026-09-13 repair spec was deleted when it shipped. Its rules still bind this work:

- Desktop inbox has no document scroll; list, thread and inspector scroll
  independently; pane headers and the inspector footer never scroll away.
- Selecting a message or thread never triggers the global DataContext load, a
  capabilities re-fetch or a full skeleton; loading shows only in the pane that loads.
- The workflow block (Next step) is available whenever a thread is selected, even
  with an outbound message focused.
- One time formatter for list, bubbles, day separators and quotes: Europe/Madrid
  (`src/lib/replyTime.ts`). Analytics windows stay UTC.
- Save / Save and next save every changed field through the existing atomic
  review + workflow payload; a field error blocks both parts. Save and next crosses
  the page boundary (`nextPendingPage`); end of the loaded rows ≠ end of the queue.
- Leaving a dirty form goes through the styled dialog (Keep editing / Discard /
  Save); a background refresh, filter change or workflow save never clears a draft.
- 409 / error keeps the current thread, message and every typed value.
- Unknown person = `UNKNOWN_PERSON_LABEL` ("LinkedIn contact") plus the identifier we
  have. **Never derive a human name from a slug** (`src/ui/Identity.tsx:8`).
- No DB ids, revision numbers or contract wording in the UI.
- Real saves are tested on fixtures only; production stays read-only without an
  explicit go.

## Decisions (2026-09-29/30)

- Laptop width → **collapsible list**; the inspector is always visible from a 900px
  container up.
- Names for lead-less threads → **separate phase 5**; phases 1–4 do not paper over it.
- Bubbles → **messenger style**, one shared visual component, selection wrapper owned
  by Replies.
- No tab counts in this version: `replies.facets` counts are already scoped to the
  selected view (`replyReviews.ts:440-445`) and cannot be summed into the other tabs.
  Per-view counts would need their own server contract — out of scope.
- A thread belongs to one instance, so outbound bubbles never need a sender label.

## Phase 1 — Layout and chrome

Files: `src/pages/Replies.tsx`, `src/pages/replies-inbox.css`, `src/lib/useRepliesInbox.ts`.

Container bands (container query on `.replies-page`, as today):

| Workspace container | Layout |
|---|---|
| ≥ 1180px | list 300 · thread flex (min 420) · inspector 340 |
| 900–1179px | list **rail 64** · thread flex · inspector 320. Expanding the rail opens the list at 300 **over the thread** (the one allowed overlay shadow) |
| < 900px | today's two-pane fallback with `.replies-pane-switch`, unchanged except the band edge |

- **Overlay list**: closes on Esc, outside click, and after a row pick **only once the
  navigation is allowed**. With a dirty form, a row pick opens the unsaved-changes
  dialog; Keep editing keeps the draft, the current selection and the overlay open.
- **Pin**: at ≥ 1180 the user may collapse the list to the rail too; remembered in
  `localStorage` (try/catch, render correctly without it).
- **Rail item**: 40px avatar, accent pending dot with the count in `aria-label`, the
  selected marker `inset 3px 0 var(--accent)` as rows today, name in a tooltip. It is
  the same queue-row `button`: keep it inside `Replies` so the `replies-queue-item`
  allowlist entry still matches, or move entry `path`/`symbol` and its
  `ui-exception(...)` comment in the same commit.
- **Header**: keep `PageHeader` (one h1 is mandatory). Refresh becomes an `IconButton`
  ("Refresh"). Tabs, account select and Filters stay one toolbar row, no counts.
- **List head**: remove the "Review queue / N loaded · more available" block. The head
  is the search field + clear; the `aside` keeps an `aria-label`.
- **Infinite scroll**: an IntersectionObserver sentinel calls `loadMore`. `loadMore`
  and `nextPendingPage` must share **one in-flight guard** — today `nextPendingPage`
  ignores `loadingMore` and both overwrite `moreAbort` (`useRepliesInbox.ts:311-354`).
  Make both go through one list-page runner so a scroll-triggered page and a
  Save-and-next walk never race, duplicate rows or abort each other. A "Load more"
  button remains only as the fallback when loading failed or the observer is absent.
- **Rows** = `--row-height-identity` (56px), two lines:
  1. avatar 32 · name (1-line clamp) · time;
  2. snippet 1-line clamp, "You: " prefix for outbound only, pending badge at the end.

  The account shows as a 16px account `Avatar` (`inst.account_avatar`) with its label
  in title/aria. Owner and next step leave the row; they're in the inspector.
- **Surfaces**: one workspace surface, panes split by 1px `--border` only, no nested
  card borders.

## Phase 2 — Messenger thread

Files: new `src/components/conversation/MessageBubble.tsx`, new
`src/lib/messageGroups.ts`, `ConversationThread.tsx`, `src/styles/tokens.css`,
`api/_lib/data/operations/replyReviews.ts` (thread SELECT), `api/_lib/replyReview.ts`.

- **`MessageBubble` is visual only**: a non-interactive element taking direction,
  body, time, a `footer` slot and `children`. It never renders a `button`. Replies
  wraps it in its own selection button in `ConversationThread` (keeps the
  `replies-message-bubble` allowlist match). The Drawer (phase 4) places its editor and
  edit/delete controls in the slots, so no interactive element nests inside another.
- **Tokens**: add `--bubble-in` (= `--surface-2`), `--bubble-in-fg` (= `--text`) and
  `--radius-bubble` (12px); reuse `--bubble-out` / `--bubble-out-fg`. The tail corner is
  4px on the sender side. No bubble border.
- **Direction**: outbound is filled `--bubble-out` with white text on the right;
  inbound is `--bubble-in` on the left.
- **Grouping** (`messageGroups.ts`, pure):
  - A group is consecutive messages with the same direction, less than 10 minutes
    apart **and on the same Madrid day** (`replyDateKey`). A day boundary always
    starts a new group and a separator.
  - Spacing is 4px inside a group and 12px between groups.
  - The visible time sits under the last bubble of a group. **Every** bubble keeps its
    exact time, in its accessible name and in a tooltip on hover or focus.
- **Selection** stays per message: the `focus` message id, `aria-pressed` on its
  wrapper, and a 2px `--accent` outline with a 2px offset (visible on the filled
  outbound bubble too). Grouping never selects a group.
- **Review state** on inbound goes in the footer slot as a `Badge`: "Unreviewed" in
  warning tone, or the sentiment tone plus the reason count. Colour is always paired
  with a word.
- **Imported marker**: the thread read doesn't return `source` today. The client type
  has `source?` (`src/lib/replyReview.ts:86`); the server DTO has none
  (`api/_lib/replyReview.ts:264-276`). Add `source` to the thread SELECT, the server
  DTO and its mapper, and render "Imported" in the footer for `source='manual'`.

## Phase 3 — Faces from data we already have

Files: `api/_lib/data/operations/replyReviews.ts`, `api/_lib/replyReview.ts`,
`src/lib/replyReview.ts`, `src/components/Avatar.tsx`, `Replies.tsx`.

- **Read**: add `ld.id AS lead_id, ld.photo_path` to the inbox lateral join and final
  SELECT; map them in `mapInbox`; add them to both `ReplyInboxItem` types. No schema
  change.
- **Avatar contract**: `LeadAvatar` requires a full `Lead` today (`Avatar.tsx:35-48`)
  and reads `full_name`/`profile_url` for its fallback.
  - Narrow its prop to a named subject type:
    `{ id: number; photo_path: string | null; full_name: string | null; profile_url: string }`.
  - The loader already needs only `LeadPhotoRef { id, photo_path }`.
  - Existing callers pass a `Lead`, which satisfies the new type structurally, so they
    are unchanged: Drawer, `LeadReplyIdentity`, FollowUps, Pipeline and
    `leadPhotoRendering.test.tsx`.
  - No fake fields, no casts.
- **Render**:
  - A row with a lead gets `LeadAvatar` built from `lead_id`, `photo_path`, `name` and
    `profile_url`.
  - A row without a lead keeps `InitialsAvatar`.
  - The thread header does the same.
- **Identity text is unchanged**: the name, or "LinkedIn contact" plus the slug as the
  secondary identifier. Phase 3 improves faces, not names.
- **Thread header**:
  - avatar · name · one meta line with `headline · account label` (1-line clamp);
  - LinkedIn becomes an `IconButton` link;
  - "Import history" and "New reply · show it" keep their current conditions.
- **Photo delivery in production** is still limited: new photos are not mirrored by
  the agent (`specs/open-follow-ups.md:9`), so only photos copied during the owner
  migration will show. Everything else falls back to initials. That item is not part
  of this spec.

## Phase 4 — Drawer on the shared bubble

Replace the inline bubble markup in `ConversationDrawer.tsx:819-909` with
`MessageBubble` + `messageGroups`. The edit/delete controls and the inline editor for
imported messages move into the bubble's slots. One bubble language across the app.

## Phase 5 — Contact names for lead-less threads (own spec before build)

1. Probe LH2 on a notebook (`agent.py inspect`) for the chat participant's name and
   headline in the chat store.
2. The agent sends them with chat-sync messages through a gateway ingest field
   (`api/_lib/agent/ingest.ts`; the transport tests pin field names).
3. A new baseline ledger step adds, for example,
   `conversation_contacts(instance_id, profile_url, full_name, headline)`.
4. The inbox and thread reads use `COALESCE(ld.full_name, cc.full_name)`.
5. Update `SCHEMA_DOC`.

This spans an agent release, a ledger apply and the gateway, so it gets its own spec.
Until it ships, "LinkedIn contact" + identifier stays honest.

## Verification

1. **Fixtures** (`tests/support/ui-fixture-api.mjs`):
   - About 15 inbox rows: with and without a lead, with and without `photo_path`, two
     accounts, pending and reviewed, enough to scroll and page (`next_cursor`).
   - A thread with grouped runs, a Madrid midnight crossing inside a run, and one
     `source='manual'` message.
   - A photo scenario where `config.readPath` answers `photoPath: 'neon'`. Add a
     `leads.photoUrls` handler returning local image URLs, including one broken URL to
     prove the initials fallback on `onError`. Today the fixture hard-codes `disabled`
     and has no photo handler (`:579`).
2. **Workflow tests** (RTL, `tests/repliesWorkspacePage.test.tsx` and related):
   - Dirty review → pick a row in the overlay → the dialog opens. Keep editing keeps
     the draft, the thread and the open overlay. Discard navigates and closes it.
   - Save and next succeeds → the next pending reply is selected, including across a
     page boundary.
   - Save fails and 409 → current thread, focused message and all typed values stay.
   - A scroll-sentinel page and a Save-and-next walk at the same time → one request at
     a time, no duplicate rows, no aborted walk (`tests/repliesInboxPagination.test.tsx`).
   - Selecting another message in the same thread → no capabilities or list re-fetch.
3. **Unit tests**:
   - `messageGroups`: the 10-minute boundary, the Madrid day boundary including DST,
     and direction changes.
   - `MessageBubble`: renders no interactive element itself.
   - `LeadAvatar` with the narrowed subject.
   - Inbox mapper returns `lead_id` / `photo_path`; thread mapper returns `source`
     (`replyReviewOperations.test.ts`).
   - `tests/repliesWorkspaceCss.test.ts` covers the three container bands. Run it
     against the unchanged CSS first so it is proven non-vacuous.
4. **SQL**: grammar-check both edited SQL literals with libpg-query; there is no live
   Neon test database.
5. **Gates**:
   - `npm run build`, `npm run typecheck:api`, `npm test`;
   - `npm run ui:inventory` after the build (it checks chunk budgets);
   - `sizingScale`, `cssCascade`, `unknownClasses`.
6. **Browser**: use the `ui-fixture` launch config with the global puppeteer
   `headless: 'shell'`, at 1280×720, 1440×900 and 1920×1080, sidebar open and
   collapsed. Pass criteria:
   - The review form and Save are visible without a click at every size.
   - The first row sits at y ≤ 340.
   - At least 10 rows are visible in the expanded list at 1440×900.
   - Inbound and outbound can be told apart in greyscale.
   - The overlay closes on Esc and after an allowed row pick.
   - Photos render and the broken one falls back to initials.
7. Before/after screenshots go in the handoff. A signed-in prod smoke and any push or
   deploy happen only with an explicit go.
