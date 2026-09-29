# Remove Supabase from the codebase

Owner decision, 2026-09-29: production is fully on Neon, `VITE_AUTH_PATH=identity`
is set in production, Supabase is used nowhere, and all four notebooks sync through
the gateway (`ingest_mode: only`). This finishes step 6 ("Delete") of the Supabase
exit. Delete this spec when every phase has landed.

## Ground rules

- Every phase leaves these green: `cd frontend && npm test && npm run typecheck:api && npm run build`,
  `node postgres/tests/portable_migration_ledger_static_assertions.mjs`, `cd ops && npm test`,
  and the sync-agent tests (`tests/test_ingest_transport.py`, `tests/test_installers.py`).
- `typecheck:api` also compiles every test file (including `*.neon.test.ts`) with
  `noUnusedLocals`, so test edits land with the API change they follow.
- The tenant contract (`ops/src/worker/backend.ts`, `ops/src/providers/hosting-tenant.ts`)
  still binds `NEON_READS/WRITES/AI_PATH_DEFAULT=neon`, `NEON_PHOTOS_DEFAULT` and
  `VITE_AUTH_PATH=identity`. The app must keep tolerating them (inert), except
  `NEON_PHOTOS_DEFAULT`, where `disabled` stays a real choice. Changing that list is an
  ops contract bump — out of scope.
- A missing Neon/identity credential must fail with a named 500
  (`NeonConfigurationError`/`IdentityConfigurationError` classified in
  `api/_lib/data/availability.ts`), never the generic "Could not verify team access",
  and never a silent fallback.
- Keep: `AI_NAMED_SQL` (Neon registry uses it); the agent's `verify_ingest_parity`
  (checks chunks against the extraction, not against Supabase); tests that assert
  Supabase is *absent* (`chatRosterPrompt`, `errorBanner`, `test_installers.py`,
  postgres restore/catalog assertions, ops hosting tests); all of `ops/`;
  `docs/platform-ops/*v053*.json` and `portable-*.json` (loaded by tests).

## Phases

1. **Sync agent (1.26.0 → 1.27.0).** Remove the `Supabase` class, the PostgREST
   remote-config bridge, `INGEST_MODES`/`resolve_ingest_mode`, the Supabase half of
   `cmd_sync` (always `sync_machine_only`), the Supabase branch of `ingest-csv`,
   `annotate` (no machine grant on `annotations`) and `sync_photos` (no machine-path
   candidate query — print a one-line notice when `sync_photos` is set). `load_config`
   requires `instance_id` + machine credential and **ignores** leftover
   `supabase_url`/`supabase_service_key`/`ingest_mode`. Any notebook able to receive
   1.27.0 through the signed release channel already satisfies this. Release with
   `sync-agent/deploy.sh` only after merge (owner action).
2. **Server data/AI paths.** Delete `api/_lib/data/{providerPath,writePath,aiPath}.ts`;
   every endpoint (briefing, classify, coach, notify-replies, pipeline, playbook, chat,
   import, review-digest, `tools.ts`, `conversationImport.ts`, `activity-daily.ts`) keeps
   only its Neon branch; `core.ts` loses `db()`; `auth.ts` keeps only machine-secret
   guards and error helpers. `config.readPath` keeps answering (constant `neon`) so open
   SPA tabs survive the deploy.
3. **Server auth.** Drop the legacy Supabase bearer (`acceptLegacyBearer`,
   `requireUser`, the JWT verifier, `deploymentApplicationAuthPath`); identity is the
   only path. Tests switch from the `requireUser` stub to the fake identity provider.
4. **Browser.** Delete `src/lib/supabase.ts`, `src/lib/authPath.ts`,
   `SupabaseAuthProvider`, the Supabase fetchers/delta mode in `DataContext`, read-path
   fallback in `dashboardReads`, `RosterPath`, Supabase photo signing, and the
   page-local fallbacks (Team, Playbook, LeadsExplorer, Overview, drawer, panels).
   Uninstall `@supabase/supabase-js`.
5. **Legacy schema.** Delete `supabase/` (migrations, seeds, tenant-baseline v053,
   tenant-migrations, tests). Remove `supabase/migrations/` and
   `supabase/tenant-baseline/` from `PROTECTED_PATHS` in the ledger assertions (the
   protected files no longer exist). Drop the one-time SQL-source derivation from
   `portable_business_inventory_assertions.mjs`; its JSON-inventory checks stay.
6. **Docs.** AGENTS.md, README.md, `frontend/.env.example`; move N-S28's open items to
   `specs/open-follow-ups.md`; delete N-S27/N-S28.

## Owner actions after deploy

- Remove `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_ANON_KEY`, `SUPABASE_URL` from Vercel.
- Preview deployments need `NEON_AI_DATABASE_URL`, `IDENTITY_*` and
  `VITE_AUTH_PATH=identity` too, or AI endpoints and sign-in fail there.
- Publish agent 1.27.0 (`sync-agent/deploy.sh`); confirm all four notebooks report it.
- Take a final backup, then decommission the Supabase project.

## Separate follow-up

`ops/` still carries the dead P4-C provisioning path, its Supabase SDK dependencies and
`supabase.*` keychain secret names. Remove them in their own change.
