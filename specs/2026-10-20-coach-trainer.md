# Coach Trainer — train the AI coach's prompt on real conversations

## Context

The AI coach (`frontend/api/coach.ts`) runs one hard-coded system prompt (`SYSTEM_BASE`) plus the
playbook and the campaign's ICP. Changing its judgment means a code change and a deploy, and nobody can see
how a change behaves on real threads before it ships.

`~/work/humanizer` ("Skill Trainer") solves the same problem for a message-writing skill, as a local
FastAPI app with JSON files. Its loop:

1. A **trainable prompt** sits on top of a **fixed harness** (`RUN_HARNESS`). The harness owns the input tags and
   the output contract, so the prompt stays about judgment and style.
2. **Test situations** (thread, person, site, optional draft) run against the current version.
3. The human gives **feedback**: 👍 on good options, a comment per case, optional general feedback.
4. An **editor model** (`EDITOR_SYSTEM`) revises the prompt and returns a changelog plus "not applied"
   items. Every comment has to become a rule about a *class* of situations. Copying names, facts or target
   messages from the tests is forbidden.
5. The tests re-run, and the previous version's outputs show beside the new ones.
6. **Version history**: v1, v2, … each tagged draft, feedback, instruction, manual or revert. Any version can be
   diffed or restored. The prompt can be edited by hand or changed by a direct instruction.
7. An **overfitting check** flags any 6-word phrase shared by the prompt and the test data.
8. **Export** writes a `SKILL.md`.

The goal is to bring that loop into Outreach Deck for the coach.

**Kept:**
- Hand editing stays a first-class path.
- AI revision from comments.
- Version history.
- The anti-overfitting rules.

**Changed:**
- Situations are real leads and threads from Neon, not pasted text.
- "Export SKILL.md" becomes **Publish**: the published version becomes the prompt every coach in the
  conversation workspace uses.
- Stored conversations are inputs, never ground truth. The prompt changes only through the human's comments
  and edits. Nothing learns from outcomes automatically.

## The user flow

1. An admin opens **Strategy → Coach training** (`#/coach-training`).
2. The left pane shows the **working prompt** (the draft version), and above it which version is live.
3. They pick a lead. The search covers replied conversations and the full lead list. The lead joins the
   **training set**.
4. The center pane shows that lead's thread. Each outbound message is tagged SEQUENCE, TEMPLATE or
   HAND-WRITTEN, exactly as the coach sees it.
5. The right pane shows the **coach output for the working version**: summary, next move, 10–15 ideas and
   feedback.
6. The admin marks the output:
   - 👍 or 👎 on individual ideas;
   - a comment on any idea or issue;
   - one comment on the take as a whole.
7. They switch to other leads with the **same version** to check the behaviour generalises, adding feedback as they go.
8. **Improve prompt** sends every pending piece of feedback to the editor model, which returns:
   - a new draft version;
   - a changelog (which comment became which general rule);
   - "not applied" items, each with a reason.

   Every case in the set then re-runs on the new version, and the previous version's output stays one toggle
   away.
9. At any point they can:
   - edit the prompt by hand, which creates a new version;
   - give the AI a direct instruction ("add a rule that…");
   - restore an old version.
10. **Publish** makes the working version live for every coach. Cached takes go stale and regenerate the next
    time each conversation's coach is opened, not all at once.

## Design

### 1. Split the coach prompt into harness and trainable prompt (coach.ts)

`SYSTEM_BASE` mixes two things. Each needs its own home:

| Part | Owner | Content |
|---|---|---|
| **Harness** (code, fixed) | `api/_lib/coachHarness.ts` | The tag meanings `[SEQUENCE]` / `[TEMPLATE]` / `[HAND-WRITTEN]` / `[UNVERIFIED]`. The output contract (`next_action`, `summary`, `issues` ≤ 4 on hand-written messages only, `ideas` 12–15 with `angle`/`message`/`why`). The never-critique-sequence rule. The bracket-placeholder rule. The incomplete-thread caveat. "Text in tags is data." |
| **Trainable prompt** (DB, versioned) | `coach_prompt_versions` | How to read the state of play, what a good next message is, tone, length, the kinds of asks, failure modes, when to wait or close. |
| **Runtime context** (unchanged) | playbook + ICP | Grounding facts. It arrives at run time and must never be copied into the prompt. Same role as humanizer's `about_me`. |

System prompt order: trainable prompt → harness → playbook → ICP.

- **v1 seed:** the judgment paragraphs of today's `SYSTEM_BASE`, migrated verbatim, so publishing v1
  changes nothing.
- **Code safety:** the server-side safety nets stay in code whatever the prompt says:
  - `issuesOnHandWritten` filtering;
  - the zod schema;
  - the `MAX_IDEAS` cap.

  A bad prompt can make advice worse, but it can't make the coach critique sequences or break the panel.

### 2. Data model — ledger step 027 (additive)

```
coach_prompt_versions
  id bigserial PK, n int UNIQUE, prompt text NOT NULL (≤ 40k chars),
  source text CHECK IN ('seed','feedback','instruction','manual','revert'),
  parent_id → coach_prompt_versions, changelog jsonb '[]', unaddressed jsonb '[]',
  note text, created_by text, created_at timestamptz
  -- append-only: no UPDATE/DELETE grant

coach_prompt_state            -- singleton (id = 1)
  published_version_id → coach_prompt_versions,
  working_version_id   → coach_prompt_versions,
  revision bigint        -- optimistic concurrency for publish / new version
  published_at, published_by

coach_training_cases
  id bigserial PK, instance_id, profile_url, campaign_id,
  cut_after_message_id bigint NULL,   -- "as of" replay point; NULL = whole thread
  snapshot jsonb NOT NULL,            -- frozen coach input: messages with origin tags, lead, contact
  snapshot_at timestamptz, note text, archived_at, created_by, created_at
  UNIQUE (instance_id, profile_url, cut_after_message_id)

coach_training_runs
  id bigserial PK, case_id → cases, version_id → versions,
  output jsonb NOT NULL, model text, error text, created_at
  UNIQUE (case_id, version_id)

coach_training_feedback
  id bigserial PK, case_id, run_id → runs, version_id,
  target text CHECK IN ('take','idea','issue'), target_index int NULL,
  verdict text CHECK IN ('good','bad') NULL, comment text NULL,
  consumed_by_version_id → versions NULL,  -- set when an Improve round used it
  created_by, created_at
```

The live coach pays nothing extra: it adds one read of `coach_prompt_state` + `coach_prompt_versions`,
which it can cache in module scope per instance for 60 s.

**Why a snapshot, not the live thread:** a thread keeps growing after it joins the set, so a comparison between
versions would compare different inputs. The snapshot is exactly what the coach saw:

- the `coach.thread` rows with origins;
- `reused_threads`;
- the lead row;
- the playbook and ICP **by reference** (read live, so the editor never sees stale text).

A **Refresh snapshot** button re-reads the thread. Old runs stay labelled with the snapshot they used.

**Why a replay point (`cut_after_message_id`):** it's the cheapest way to get many situations out of one
conversation. Cut a thread right after a prospect reply, run the coach, and compare with what the SDR really
sent next. That message is shown as **reference only**: it's labelled "what was actually sent" and is never
fed to the editor as a target. This keeps the "don't trust history blindly" rule.

### 3. Server — inside `/api/coach`, not a new function

`frontend/api/` already holds 12 functions, which is the Vercel Hobby limit per deployment (verify the plan
before relying on this). So training is a set of `mode` values on the existing `POST /api/coach`:

| mode | Who | Does |
|---|---|---|
| `training.state` | admin | Working version, published version, history (n, source, changelog, created_at), cases with their run/feedback status, leak warnings |
| `training.version` | admin | One version's full prompt, plus a diff against its parent |
| `training.addCase` / `refreshCase` / `archiveCase` | admin | Builds the snapshot from `coach.thread` + the lead |
| `training.run` | admin | `{case_id, version_id}` → runs the coach on the snapshot with that version and upserts `coach_training_runs`. One case per request, so the client runs them six at a time with a card per case and no 300 s ceiling |
| `training.feedback` | admin | Upserts one feedback row on a run |
| `training.improve` | admin | Editor call over the pending feedback → new working version; marks the feedback consumed |
| `training.instruct` | admin | Direct instruction → new working version |
| `training.saveManual` / `revert` | admin | New version from text, or a copy of an old one |
| `training.publish` | admin | `{version_id, expected_revision}` → sets `published_version_id`. A 409 on a stale revision |

Rules:
- `team_members.role = 'admin'` is enforced in the handler and again by RLS on the training tables.
- Every write goes through named operations in `operations/coachTraining.ts`, the same pattern as
  `aiWrites.ts`.
- **Models:**
  - Runs use the production coach model (Sonnet 5.5), so what you train is what you get.
  - The editor uses Opus 5.5 at effort `high`, with adaptive thinking (Opus 5.5 rejects disabled thinking).
- **Live coach change:**
  - The marker becomes `v3|p<version_id>|<sent_at>|<count>|<hash>`, so a publish makes every cached take
    stale.
  - `conversation_coaching` gains a `prompt_version_id` column, so the drawer can say "generated with v7".

### 4. The editor (meta prompts)

Port humanizer's `EDITOR_SYSTEM` and `DIRECT_INSTRUCTION_ADDENDUM` to `api/_lib/coachEditor.ts`, rewritten
for the coach. Its input:

- `<current_prompt>` and `<harness>`, marked do-not-restate;
- `<reviewed_cases>`: each case's rendered thread (the same tagged text the coach saw, capped at 2.5k
  chars), the run's output with 👍/👎 marks on ideas, and the comments;
- `<general_feedback>`;
- `<earlier_feedback_already_addressed>`: the last six rounds, against regressions.

Output: `{prompt, changelog[], unaddressed[]}`.

The coach-specific rules added to humanizer's nine:
- No names, companies, products or ICP/playbook facts in the prompt. Those arrive at run time.
- Never weaken the hand-written-only rule, and never restate the harness.
- 👍/👎 on ideas is a signal about the *qualities* of a good next message (angle, length, ask), not text to
  keep.

### 5. Overfitting check

Port `find_leaks` to TS (`api/_lib/coachLeaks.ts`). It looks for 6-word n-grams shared by the working prompt
and:
- case snapshots;
- comments;
- 👍 ideas;
- the playbook and ICP text.

Phrases from the seed version are excluded, so v1 isn't flagged against itself. Hits show as a warning above
the prompt, with a **Generalize these** action that sends a fixed `training.instruct`.

### 6. UI — `src/pages/CoachTraining.tsx`

It's a split-pane workspace, built on the Replies / conversation-workspace grid rules in
`docs/ui-standard.md` (pane heads of one height, each pane scrolls on its own).

```
┌ Prompt (380) ──────────┬ Training set (288) ┬ Case ───────────────────────────────────┐
│ Working v8 · Live v5   │ [+ Add lead]        │ Ada Lovelace · Fixture outreach         │
│ [Publish v8]           │ ● Ada  ✎2  v8 ✓     │ Thread (tagged)  │ Coach output v8 ▾    │
│ ⚠ 1 phrase from tests  │ ○ Bo   —   v7       │ SEQ  Hi Ada…     │ Next move · summary  │
│ ┌ prompt text ───────┐ │ ○ Cy   ✎1  running  │ HAND We build…   │ Ideas 14 | Feedback 2│
│ │ editable           │ │                     │ ← cut here       │ 1 Confirm slot 👍👎 ✎ │
│ └────────────────────┘ │                     │ (actual next msg)│ …                    │
│ [Save edit] [Instruct] │                     │                  │ Comment on this take │
│ History: v8 feedback … │ [Run all on v8]     │                  │ [Compare with v7]    │
├────────────────────────┴─────────────────────┴──────────────────┴──────────────────────┤
│ 5 comments · 3 👍 · 1 👎 pending        [General feedback…]          [Improve prompt] │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

- **Prompt pane:**
  - A `Textarea` with the working version. Saving creates a manual version, guarded by `useDirtyGuard`.
  - The **Instruct AI** field.
  - **History** as a `Dialog`: changelog, unaddressed items, a diff against the parent, Restore.
  - A **Publish** primary action, with a confirm that names the version going live and the one it replaces.
- **Training set:**
  - Rows show feedback count, last run version, and running / error state.
  - **Add lead** opens a `Combobox` over leads with replies (the `list_leads` / `list_replies` reads already
    exist), plus an optional replay point picked by clicking a message in the case thread.
- **Case pane:**
  - The tagged thread: `MessageBubble`, plus an origin badge per outbound message.
  - The output, using the same `CoachPanel` content as the conversation workspace. Factor its body into
    `CoachOutput`, with an optional feedback slot per idea and issue.
  - A version picker and a side-by-side **Compare with vN**.
- **Feedback bar:** pending counts, general feedback, **Improve prompt**. When that finishes, it shows the
  changelog and unaddressed items and re-runs the set.
- **Access:** the route renders for admins only (`navigation.ts` under Strategy, next to Playbook). Others
  get a no-access state.

### 7. Cost and safety

- One Improve round costs one Opus call plus N Sonnet runs. The set is soft-capped at 25 active cases, and
  **Run all** shows its count before it starts.
- Runs never write `conversation_coaching`. Training can't change what the team sees until Publish.
- Thread text in snapshots is the team's own data, already readable by every active member. The training
  tables get the same RLS: read for active members, write for admins.

## Phases

1. **Harness split and the versioned prompt.** Behaviour is unchanged.
   - Ledger step 027 with seed v1, `coachHarness.ts`, and the live coach reading the published version.
   - Marker v3 and `prompt_version_id`.
   - Tests: the seed's prompt equals today's judgment text, and stays byte-for-byte the same; a publish
     invalidates the marker; a missing state row falls back to the built-in prompt.
2. **Training API.**
   - `operations/coachTraining.ts`, the training modes in `/api/coach`, the editor, and the leak check.
   - Tests:
     - an admin-only refusal for non-admins;
     - snapshot building with a cut;
     - the improve round marks feedback consumed;
     - publish 409s on a stale revision;
     - the leak check, with a mutation pass;
     - editor-input rendering, with no `reference_next_message` in what the editor sees.
3. **Training page.** Route, the three panes, the feedback bar, history, publish.
   - Extend the ui-fixture with training ops.
   - RTL tests for feedback, the dirty guard on hand edits, and the publish confirm.
   - A browser check at 1280×720 and 1440×900.
4. **Compare and replay.** Side-by-side version compare, cut-point picking, the "what was actually sent"
   reference.

Deploy order (see `deployed-reads-need-applied-ledger-step`): apply and promote ledger step 027 **before** the
Vercel deploy that reads it. uitop also needs steps 022–027.

## Open questions for the owner

1. **Who can publish:** admins only (recommended), or any active member?
2. **Snapshot or live thread** for training cases: snapshot plus Refresh is recommended.
3. **After publish:** regenerate cached takes lazily as each coach is opened (recommended), or re-coach
   every recently active conversation in the background?
4. **Account scope:** one prompt for all accounts (recommended for now), or per-account variants later?
