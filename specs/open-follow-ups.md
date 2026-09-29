# Open follow-ups from closed specs and handoffs

The specs and handoffs below were deleted on 2026-09-29 because their work shipped
(the code implements them; git history keeps the documents). Each left small items
that the code alone cannot prove done. Delete a line when it is done or dropped.

## Product / code

- **New lead photos are not mirrored on the gateway path.** `sync_photos` refuses when
  the agent runs `ingest_mode: only`, so photos stop at what the owner migration copied
  to R2. Needs a machine-path photo candidate query plus upload. (from N-S29)
- **`annotate` refuses on the gateway path** — needs an `annotations` ingest collection
  and an `app_machine` grant in a new ledger step. (from N-S29)
- **`AGENT_RELEASE_*` bindings are missing from the ops tenant environment contract**
  (`ops/`), so a new tenant does not get the signed release channel. (from N-S29)

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

## Housekeeping

- Remove the malformed LH2 test campaigns 7, 8 and 9 on notebook-1 through the LH2 UI.
  (from campaign-creator-summary)
- `npm run test:cleanroom` needs an unredacted `IDENTITY_STORE_DATABASE_URL` to run.
  (from campaign-creator-summary)
