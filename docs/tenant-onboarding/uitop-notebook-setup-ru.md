# uitop — end-user notebook setup instruction (Russian)

The end-user procedure is now canonical in
`docs/tenant-onboarding/notebook onboarding.md` and is executed by the macOS or
Windows installer bundle. Do not copy a second set of commands into this file.

Everything below is operator context. Do not send it to Ivan.

## Before you send the installer — five owner prerequisites

Items 1–4 are blocking; item 5 is not. Every ❌ below was established by probing
the live deployment on 2026-08-12. Re-run the read-only probes below rather than
assuming this historical state is still current.

| # | What | Where | Recorded state on 2026-08-12 |
| --- | --- | --- | --- |
| 1 | Set the `app_machine` password on uitop's Neon project, then bind `NEON_MACHINE_DATABASE_URL` | uitop Vercel, production | ❌ — N-S29 item 3(a)–(c) |
| 2 | `APP_TENANT_ID=uitop` | uitop Vercel, production | ❌ — must be exactly `uitop` |
| 3 | Redeploy uitop from a build that exports `GET` on `/api/import` | uitop Vercel | ❌ — the serving release predated that fix |
| 4 | Mint one credential per notebook | `POST https://uitop.ciphercross.dev/api/identity?op=admin.agentCredentialIssue` | ❌ |
| 5 | `AGENT_RELEASE_*` read pair plus one `sync-agent/deploy.sh` publish | uitop Vercel and operator shell | ❌ — optional after item 3 |

Missing items 1 or 2 make the first live sync fail with HTTP 503 after bounded
retries. Missing item 3 makes the two machine GET operations (`agent.config`
and `agent.release`) return 405 before the handler runs; remote config will not
reach the notebook.

### Read-only preflight probes

Use an intentionally invalid token. These calls have no successful credential
and no mutation payload. All three responses should now be `401`:

```bash
TOK="lha.$(uuidgen | tr 'A-Z' 'a-z').0000000000000000000000000000000000000000000"
H="Authorization: Bearer $TOK"
U="https://uitop.ciphercross.dev/api/import"
curl -s -o /dev/null -w '%{http_code} config\n'  -H "$H" "$U?op=agent.config"
curl -s -o /dev/null -w '%{http_code} release\n' -H "$H" "$U?op=agent.release"
curl -s -o /dev/null -w '%{http_code} ingest\n'  -X POST -H "$H" \
  -H 'content-type: application/json' -d '{}' "$U?op=agent.ingest"
```

- `405` on either GET means item 3 is still missing.
- `503` on POST with `the machine path is not configured on this deployment`
  means items 1–2 are still missing.
- Do not send the installer until all three are `401`.

These probes establish only route/readiness behavior. They do not prove that a
real credential was minted correctly or that a live ingest will succeed.

## Credential issuance

There is no end-user UI. Issue one credential per notebook using an admin
session on uitop's own hostname. The request body is:

```json
{ "tenant_id": "uitop", "instance_id": "uitop-1", "label": "Notebook 1 — <name>" }
```

The plaintext `lha.<uuid>.<secret>` appears in that response once and is not
recoverable. Keep each token with its exact `instance_id`; a mismatch is
rejected with HTTP 403. Credential issuance does not create the `instances`
row—the first accepted ingest batch does.

Send the user three non-ambiguous items through the approved channel:

1. the platform-specific installer bundle;
2. `docs/tenant-onboarding/notebook onboarding.md`;
3. that notebook's exact `instance_id` and one-time token.

Do not place a token inside the bundle or documentation.

## Installer bundles

The minimum macOS bundle contains:

```text
install-macos.command
requirements.txt
installer/install.py
installer/release.json
installer/config.template.json
```

The minimum Windows bundle contains:

```text
install-windows.cmd
install-windows.ps1
requirements.txt
installer/install.py
installer/release.json
installer/config.template.json
```

Build both from one reviewed commit. Preserve the executable bit on
`install-macos.command`, archive the files rather than sending them separately,
and record each archive's SHA-256 before distribution:

```bash
python3 sync-agent/installer/build-bundles.py
```

The command creates deterministic archives under `sync-agent/dist/` and prints
their hashes. The scripts are not signed native packages: users may see normal
Gatekeeper or SmartScreen prompts, as described in the canonical guide.

## The deliberate two-phase gate

Installation does not send an ingest batch and does not register a scheduled
job. It produces:

- `onboarding-report.txt`, containing the redacted dry-run output;
- `inspect.txt`, containing LH2 database discovery/schema information;
- local state `software_installed` or `ready_to_activate`.

Review both files and compare every campaign's leads/invited/accepted/replied
counts against LH2. Approval is a human decision; `parity ok` only proves the
agent's extracted rows were represented consistently in its proposed batches.
It does not prove the LH2 mapping extracted the right source columns.

Only after approval should the user relaunch the same bundle, choose activation,
and type `ОДОБРЕНО <instance_id>`. The launcher repeats the dry run, performs one
live `only` sync, requires `sync ok`, registers the native per-user schedule,
and verifies one scheduler-originated run. Signed self-updates remain disabled
through both verified runs, then are enabled only after those checks pass. Any
live or scheduler failure leaves the state non-active and reports the error.

## Expected mapping round trip

The bundled leads mapping is the generic mapping previously published in the
manual guide. It reads milestone columns from `person_in_campaigns_history`.
Those columns are not present in every LH2 build; on known current Windows
builds the funnel may instead live in `action_results` and
`action_result_messages`.

When the report says the configuration needs help or shows a missing table or
column:

1. inspect `inspect.txt`;
2. prepare a complete corrected `config.yaml` without changing
   `instance_id`, gateway values, token, or `sync_photos: false`;
3. transfer it through the approved secret-bearing channel, because the file
   contains the machine token;
4. have the user replace the local config and choose the launcher's safe
   recheck action;
5. review the new counts before approving activation.

Do not ask a non-technical user to edit SQL. Do not turn on photos: the
machine-only path deliberately keeps `sync_photos` false for this rollout.

## Pinned release contract

The single source consumed by both platform launchers is
`sync-agent/installer/release.json`. It currently pins:

- agent `1.15.1`;
- commit `4b040863d7dd39b6503d676eb8d959b5f9b31f45`;
- SHA-256 `b39fc97c3d2b8c3136d2dcf3e68b368274720da2b7ab6e47f6b891ebb6f01269`;
- size `134074` bytes.

Whenever `agent.py` changes, update version, immutable URL, SHA-256, and byte
count together, run `sync-agent/tests/test_installers.py`, and rebuild both
archives. Never point an onboarding bundle at a moving branch.

## Scheduling and secrets

- macOS uses the current user's LaunchAgent
  `dev.ciphercross.lh2-sync` with a 30-minute interval and absolute paths.
- Windows uses the current user's limited-privilege Task Scheduler task
  `LH2 Sync Agent`, with `StartWhenAvailable` and `MultipleInstances=IgnoreNew`.
- Neither schedule runs before login or stores the machine token in its
  arguments.
- The raw token remains in `config.yaml`, protected by mode `0600` on macOS or a
  current-user-only ACL on Windows. Reports, logs, state, task definitions, and
  console output must not contain it.
- Remote config becomes available only after the first accepted batch creates
  the notebook's `instances` row. A pre-activation remote-config 401/failure line
  is therefore expected and is not evidence that the dry run sent data.

Publishing the signed agent release, deploying uitop, issuing credentials, and
rolling out bundles are separate operator actions. Creating or testing the
installer scripts does not authorize any of them.
