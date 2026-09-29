# Open follow-ups from closed specs and handoffs

The specs and handoffs below were deleted on 2026-09-29 because their work shipped
(the code implements them; git history keeps the documents). Each left small items
that the code alone cannot prove done. Delete a line when it is done or dropped.

## Product / code

- **New lead photos are not mirrored.** Agent 1.27.0 has no photo upload (`sync_photos`
  only prints a notice), so photos stop at what the owner migration copied to R2. Needs a
  machine-path photo candidate query plus upload, and tenants bind no `OBJECT_STORAGE_*`.
  (from N-S29, N-S28)
- **There is no `annotate` command any more** (removed in 1.27.0) — bringing it back needs
  an `annotations` ingest collection and an `app_machine` grant in a new ledger step.
  (from N-S29)
- **The ops tenant environment contract binds no `AGENT_RELEASE_*`, `ANTHROPIC_API_KEY`,
  `SLACK_WEBHOOK_URL` or `DASHBOARD_URL`** (`CANONICAL_TENANT_ENVIRONMENT` in `ops/`), so a
  new tenant gets no signed release channel and no working AI endpoints or Slack posts.
  Changing it is a contract version bump. (from N-S29, N-S27)
- **No repair operation for an active tenant.** `active` only moves to `suspended` or
  `offboarding_planned`, so every fix to a live tenant is out of band and the registry
  drifts; `docs/implementation-handoffs/N-UITOP.md` lists uitop's unrecorded divergences
  and the out-of-band procedure. (from the Neon migration spec, N-S27)
- **`leads.status` / `last_action_at` look non-deterministic for some leads.** After the
  owner migration (2026-08-12) 6 leads disagreed between Supabase and Neon (5 with Supabase
  ahead, 1 with Neon ahead), and the live agent kept rewriting the older values. The 5 all
  have an inbound reply; on Neon `status` is 1 instead of 2 and `last_action_at` is earlier
  by 58 s to 4 days. Funnel columns, messages and `daily_activity` are unaffected. Suspect:
  the `person_external_ids` one-slug-per-person `row_number()` in the leads mapping has no
  deterministic tiebreaker, so runs can pick different rows for one person. Diagnose on a
  notebook, not in the database (the next sync rewrites any copied value): `agent.py sync
  --dry-run` on notebook-1 and notebook-3, then compare one affected lead's row (named in
  the N-S28 handoff, in git history) with LH2's UI. (from N-S28)
- **`postgres/tools/b2_tenant_slice.mjs` has two latent defects**, left unfixed because it
  was an owner-approved frozen artifact (and its Supabase source is now gone): (1) it loads
  PostgREST CSV into `COPY … csv`, which corrupts `jsonb` values containing quotes,
  backslashes or newlines — its one jsonb column, `instances.config`, never hit this;
  (2) its parity check compares rows by position, which breaks when source and target
  collations sort non-ASCII keys differently. `s28_owner_migration.mjs` fixed both (fetch
  JSON and encode per target column type; match rows by grain). Fix or delete the tool
  before reusing it. (from N-S28)

## Verification never recorded

- Signed-in, read-only production smoke of the redesigned UI at 1280/1440/1920:
  shell and role gating, one route per page family, Replies, Sequence editor.
  (from the 2026-09-22 component-system redesign and UI-CLEANUP-STANDARDIZATION)
- Isolated write checks for the redesigned write surfaces. (UI-CLEANUP-STANDARDIZATION)
- Clean-VM / clean-user rehearsal of the notebook installers (macOS and Windows).
  (from the 2026-08-12 notebook onboarding scripts spec)
- Live dry-run and activation for each Windows multi-account profile (uitop-1/uitop-2).
  (from the 2026-08-12 Windows multi-account spec)
- Notebook-1 canary evidence before enabling LH2 auto-compatibility promotion fleet-wide.
  (from the 2026-09-09 auto-compatibility spec)
- A tenant backup restored into a rehearsal environment (Definition of done of the Neon
  migration spec; the dump/restore cleanroom scripts exist, a live-tenant restore was never
  recorded).

## Housekeeping

- Remove the malformed LH2 test campaigns 7, 8 and 9 on notebook-1 through the LH2 UI.
  (from campaign-creator-summary)
- `npm run test:cleanroom` needs an unredacted `IDENTITY_STORE_DATABASE_URL` to run.
  (from campaign-creator-summary)

## After the Supabase removal

Supabase was removed from the code on 2026-09-29 (agent 1.27.0, Neon-only API, identity
sign-in, `supabase/` deleted). Owner actions still to do:

- Repoint `sync-agent/installer/release.json` at the pushed commit that carries agent
  1.27.0 (version, commit, raw URL, sha256, bytes), then run `sync-agent/deploy.sh`;
  confirm all four notebooks report 1.27.0 on the Health page.
- Remove `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_ANON_KEY` and `SUPABASE_URL` from Vercel.
- Preview deployments need `NEON_AI_DATABASE_URL` and `IDENTITY_*` (pointing at the fixture
  project, never production), or AI endpoints and sign-in fail there.
- Take a final backup of the Supabase project, then decommission it.
- Run `npm run test:neon` once with credentials: the Neon suites were only typechecked
  during the removal.
- Old Supabase invite links (`?token_hash=…`) no longer work; re-invite anyone whose invite
  was still pending.
- `ops/`: remove the dead P4-C provisioning path, its Supabase SDK dependencies and the
  `supabase.*` keychain secret names, in their own change.
