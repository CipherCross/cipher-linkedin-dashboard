# Campaign Creator: Linked Helper 2 publishing summary

**Updated:** 2026-08-31  
**Scope:** Sequence Builder → Linked Helper 2 paused, zero-target campaign creation

## Status

**The pilot succeeded on 2026-08-31 with signed agent `1.21.0`.** The first
structurally complete campaign was created on `notebook-1`: paused, zero
targets, `is_valid = 1`, a campaign-level exclude list, one empty placeholder
collection per action version, and it opens normally in the LH2 UI. Nothing was
sent to LinkedIn.

Released versions, in order: `1.18.0` (wrong fix), `1.19.0` (verifier only,
committed but never published), `1.20.0` (correct payload, but would have
failed closed on every good publish), `1.21.0` (**current**).

The remaining work is in "Open items" at the end of this document. None of it
blocks a publish on the pilot notebook; the largest item is that `publish-once`
is still run by hand.

## How the fix was found

The root cause is established from the installed LH2 `2.130.25` bundle, and the
fix is in signed version `1.20.0`. It is the opposite of what `1.18.0` assumed.

**LH2 creates an empty exclude-list placeholder only for a TRUTHY
`excludeList`, and the two levels have separate guards.**

- Action level, `_createAction`: a bare truthiness test on `entry.excludeList`.
  No `undefined` check, no inherit branch. Falsy or omitted →
  `action_versions.exclude_list_id` is written NULL.
- Campaign level, `_createCampaignVersion`: `void 0 !== arg.excludeList`, whose
  `undefined` branch **inherits the previous version's list** rather than
  creating one. On a brand-new campaign there is no previous version, so
  `undefined` yields NULL.

`[]` is truthy in JavaScript, so it selects creation at both levels — and the
chain does not bail on emptiness: `_createPeopleCollection` passes
`forceCreateVersion = true` to `_addPeopleCollectionItems`, so the
`addToTarget` version row is written even with zero items. That produces
exactly the reference shape: a nameless collection, zero `collection_people`
rows, one `collection_people_versions` row.

So `1.18.0` removed the one key that was working and never added the key that
was missing. `1.20.0` sends `"excludeList": []` on the campaign argument **and
on every action entry**.

### What this explains

| campaign | campaign-level `excludeList` sent | per-action sent | `campaign_versions.exclude_list_id` | action versions NULL | `is_valid` |
|---|---|---|---|---|---|
| 6 (native reference) | — | — | set (all 15) | 0 of 12 | 1 |
| 7, 8 (≤ 1.17.1) | `[]` | no | set (139 / 140) | 11 of 11 | 1 |
| 9 (1.18.0) | omitted | no | **NULL** | 13 of 13 | **NULL** |

Two corrections to what the pilot report assumed:

- Campaign 9's `is_valid` is **NULL, not 0**. `is_valid` is a nullable
  tri-state and `_resetCampaignValid()` writes NULL for "not yet validated".
- Campaigns 7 and 8 were **not** identically broken to 9: they each did get a
  campaign-level list. Campaign 9 is missing 14 placeholder collections; 7 and
  8 are missing 11 each.

### Confirmed reference model

Every `exclude_list_id` is a `collection_people_versions.id` — not a
`collections.id`:

```text
action_versions.exclude_list_id  →  collection_people_versions.id
campaign_versions.exclude_list_id                ↓
                                     collections.id → li_accounts.id
```

For reference campaign 6: collection 106 + version 126 at campaign-insert time,
then one new collection and one `addToTarget` version per action insert
(107–118 / 127–138). The campaign-level list is created once and reused
unchanged across all later `campaign_versions` rows. All 13 collections have
`name = NULL` and zero `collection_people` rows. The only two
`version_operation_status` values in the whole database are `addToTarget` and
`removeFromTarget`.

The action entry as `_createAction` consumes it: `name`, `description`,
`target`, `excludeList`, `config`, `workingHours`, plus optional mutually
exclusive `at` / `after` / `before`, plus `campaignId` / `liAccount` which
`_createCampaignVersion` injects. The campaign argument to `createCampaign` is
`name`, `description`, `actions`, `excludeList`, `liAccount`.

One remaining cosmetic difference from native: campaign 6 leaves
`actions.name` empty on all rows, while the publisher writes the action type
there. It did not affect validity (7 and 8 also carried names and were
`is_valid = 1`) and is left as the more informative value.

### Three defects found after 1.20.0 was published (fixed in 1.21.0)

**`is_valid` is never computed during creation.** LH2 writes that column from
exactly two places: `_resetCampaignValid()` — which runs at the end of every
`_createAction`, writing NULL — and `_validateCampaign`. Nothing computes it
while a campaign is being built, so a *correct* campaign always reads back NULL.
1.20.0's `is_valid == 1` assertion would therefore have failed closed with
`LH_CAMPAIGN_VALIDITY_PENDING` on **every good publish**. The publisher now
calls `source.campaigns.validate(campaignId)` after the pause and verifies
again; run by hand on campaign 9 this flipped the flag to 1 with no errors.

Validation is attempted only after every other canonical check has already
passed — name, account, action chain, fingerprint, zero targets, paused — so a
campaign that is not this branch's fails before validation could write to it.
That keeps the recovery/adoption path non-mutating, and it also makes crash
recovery work: a campaign created but not yet validated is adopted and
validated rather than reported as a conflict. `validate_campaign` is now part
of the capability gate, so a build without it fails preflight.

**The CDP port cannot be pinned.** It rotated `61121 → 51358` when LH2
auto-updated, and `DevToolsActivePort` is unreliable here — it still named
61121 with nothing listening. The port belongs to the instance process
(`Instances\<version>\linked-helper.exe`). Discovery now scans loopback TCP
listeners owned by an LH2 process and probes `/json/version` on each. The
configured port stays a hint and is tried first, so the scan is a fallback
rather than a per-connection cost; `preflight` pins the verified port for the
rest of the run.

**`lh_version` was echoed from config, never measured.** The probe reported
`2.130.29` while the process was running `2.130.17` — the drift that caused the
mid-session breakage. It is now measured from the running instance's executable
path, and preflight fails closed with `LH_VERSION_MISMATCH` when a measured
build contradicts the pinned one, naming both values. A build that cannot be
measured is reported, not blocked; the endpoint is then labelled
`configured-unverified` because process ownership was not established.

Note the operational consequence: correcting `lh_version` in `config.yaml`
changes the account snapshot, and a queued job whose stored snapshot still
carries the old value will fail `PUBLISH_ACCOUNT_SNAPSHOT_MISMATCH`. Update the
dashboard-side profile and recreate the job.

The `app-<version>` directory is a weaker signal than the running instance:
this machine had `app-2.130.25` on disk while the running instance was
`2.130.17`. Discovery prefers `Instances\<version>`.

### The verifier was hardened first

The decisive failure was not the payload — it was that the agent reported
`publish-once: completed` for a campaign LH2 cannot open. Readback checked id,
name, `liAccountId`, the action chain, zero targets and `is_paused`, but neither
exclude-list level nor `is_valid`. A broken publish and a good one were
indistinguishable, so further runs would have accumulated broken campaigns
silently. Version `1.19.0` closed that (committed, never published); `1.20.0`
is the first release carrying both it and the fix.

Verification now also requires, fail-closed with its own code each:

| code | condition |
|---|---|
| `LH_CAMPAIGN_NOT_VALID` | `is_valid = 0` |
| `LH_CAMPAIGN_VALIDITY_PENDING` | `is_valid IS NULL` — reset, not yet validated |
| `LH_CAMPAIGN_EXCLUDE_LIST_MISSING` | latest `campaign_versions.exclude_list_id` NULL |
| `LH_ACTION_EXCLUDE_LIST_MISSING` | any action version's exclude list NULL |
| `LH_ACTION_EXCLUDE_LIST_UNRESOLVED` | reference with no `collection_people_versions` row |
| `LH_ACTION_VERSION_COUNT_MISMATCH` | action count ≠ action-version count |
| `LH_CAMPAIGN_VALIDITY_UNKNOWN`, `LH_CAMPAIGN_EXCLUDE_LIST_UNKNOWN`, `LH_ACTION_EXCLUDE_LIST_UNKNOWN` | the build's schema lacks the column |

People in the referenced exclude collections are reported but **not** enforced:
an operator may legitimately populate an adopted campaign's lists, and an
excluded person is never contacted. The verification summary sent to the
dashboard carries `is_valid`, `action_version_count`, `exclude_lists_present`,
`exclude_lists_unresolved`, `campaign_exclude_list` and `exclude_list_people`.

`publish-once` no longer prints `completed` when a branch failed: it prints
`publish-once: FAILED — n of m branch(es) did not verify` and exits non-zero.

`LH_CAMPAIGN_VALIDITY_PENDING` survives as a real failure: it now means LH2
refused to validate the campaign, not merely that validation had not run.

### New read-only command

```powershell
agent.py publish-verify --campaign 6 --campaign 7 --campaign 8 --campaign 9
```

Prints each campaign's structural state without contacting LH2 and without
creating anything to look at: paused, `is_valid`, action and action-version
counts, action versions missing an exclude list, unresolved references, the
campaign-level list, people in exclude collections, target people, action types,
and which `action_versions` reference columns LH2 populated versus left NULL.
It opens the database `mode=ro` and reports no stored values.

## Pilot notebook and LH2 state

The tested notebook is `notebook-1`, account `524650`, workspace `601896`, with
internal LH2 account id `1`. LH2 was observed at build `2.130.29` (Chromium
142.0.7444.265, CDP protocol 1.3). Its CDP endpoint is loopback-only but
unauthenticated and uses an ephemeral port; the last confirmed port was `61121`
for the LH2 instance process. The port must be rechecked after every LH2 restart.

The publish profile has the required account, workspace, sender, compatibility,
machine, adapter and security-ack values. `machine_key` is `notebook-1`. The
agent must still fail closed if any of these values or the current endpoint do
not match.

## What happened during the rollout

The progression below records the observed gates and failures. No outbound
LinkedIn activity was started by the adapter; all successful test creations were
paused with zero targets.

1. The original Windows checkout lacked a Git repository and the agent was
   `1.15.1`; the LH2 publishing profile and `machine_key` were absent.
2. Signed self-update installed `1.16.0`; the first probe reported
   `COMPATIBILITY_PROFILE_MISSING`.
3. CDP inventory found LH2's live loopback endpoint and an app renderer. The
   initial selector incorrectly targeted an anti-bot iframe, so the probe failed
   closed without opening a WebSocket.
4. The selector was corrected to the local `index.html` LH2 renderer. Read-only
   runtime checks confirmed the four capability methods, but the adapter gate was
   still disabled.
5. Read-only method and SQLite inventory confirmed the relevant campaign methods
   and the two-account schema difference. No functions were invoked during that
   inventory.
6. Signed updates advanced the agent through `1.16.4`, `1.16.6`, `1.16.7`,
   `1.16.8` and `1.16.9`. The intermediate failures were:
   `MACHINE_KEY_MISSING`, `ACCOUNT_ID_INVALID`,
   `LH_CAMPAIGN_LIST_SHAPE_INVALID`, `CDP_EVALUATION_FAILED` and
   `LH_CREATE_REJECTED`. Each was fixed or made observable in a later signed
   release.
7. `1.17.0` separated the external dashboard account id from LH2's internal
   `li_account_id`. This allowed the first actual campaign creation.
8. The first created campaign was LH2 campaign **7**. It is paused and has zero
   people, but it is structurally incomplete and cannot be opened in LH2
   (`Failed to fetch campaigns`).
9. Signed `1.17.1` changed canonical readback to SQLite `mode=ro` only. It never
   repairs or writes the database.
10. A healthy existing campaign was compared read-only with campaign 7. The
    decisive difference was found: campaign 7 has `exclude_list_id IS NULL` for
    all 11 action versions; healthy campaigns have one non-null reference per
    action version.
11. The LH2 bundle was read in place, without modifying installation or
    returning proprietary source. Type declarations and six call sites showed
    that `createCampaign` treats `excludeList !== undefined` as an already
    existing list. Passing an empty array therefore suppresses native setup.
12. The same bundle showed that omitting the key invokes LH2's native path:
    `_createPeopleCollection()` followed by
    `createPeopleCollectionVersion(collectionId, "addToTarget")`.
13. `1.18.0` shipped that change. Its pilot run created LH2 campaign **9**:
    paused, zero targets, 13 actions and 13 action versions — but still all 13
    exclude-list references NULL, and now `is_valid = 0`. The agent reported
    `completed`. The campaign-level key was the wrong lever, and the verifier
    could not tell the outcome apart from a success.
14. `1.19.0` left the payload alone and closed the verifier gap instead:
    both exclude-list levels and `is_valid` became part of canonical
    verification. It was committed but never published.
15. A read-only diagnosis on the notebook — SQLite `mode=ro` plus the
    `app.asar` bundle read in place — established the two guards and inverted
    the `1.18.0` hypothesis. `1.20.0` sends `"excludeList": []` at both levels.
16. `1.20.0` was published and verified from the release bucket, then three
    further defects were found on the notebook: `is_valid` is never computed at
    creation (so 1.20.0 would fail every good publish), the CDP port had
    rotated `61121 → 51358`, and `lh_version` was echoed from config rather
    than measured. `1.21.0` fixes all three.

## Confirmed data model

For a healthy native-created campaign:

```text
action_versions.exclude_list_id
  → collection_people_versions.id
  → collections.id
  → li_accounts.id
```

Each action version receives its own empty, unnamed collection and its own
`addToTarget` version. Healthy reference measurements were:

- 12 actions and 12 action versions;
- 12 distinct `exclude_list_id` values;
- 12 distinct collection ids behind those versions;
- 12 `addToTarget`, 0 `removeFromTarget` versions;
- zero people in all referenced collections;
- zero version-log rows;
- empty collection names.

Campaign 7 has 11 actions and 11 action versions, but all 11 exclude-list
references are NULL. Its `campaigns.is_valid = 1` and `is_paused = 1` do not make
the missing action-level links valid to the LH2 UI.

## Code change

The publisher builds this payload shape for a new campaign:

```python
{
    "name": name,
    "liAccount": li_account_id,
    "excludeList": [],
    "actions": [
        {"name": action_type, "description": "", "target": [],
         "excludeList": [], "config": {...}},
        ...
    ],
}
```

Both `excludeList` keys are required and both must be `[]`. LH2 still owns the
creation of the placeholder collections and versions — `[]` selects its native
path rather than supplying a list. The adapter still creates only empty-target
campaigns, explicitly pauses them, and performs canonical readback. It has no
start/unpause, target population, archive, rename, delete, or direct-SQL repair
path.

## Verification performed locally

From `sync-agent/` using the project virtualenv:

```text
140 tests passed
python -m py_compile agent.py: passed
```

The new tests build a minimal LH2 database in each of the observed structural
states and assert that the verifier rejects each one with its own error code: a
NULL exclude list (campaigns 7 and 8), `is_valid = 0` (campaign 9), a NULL
validity flag, a dangling exclude-list reference, and each missing column. One
test builds the exact campaign 9 shape and asserts `publish_branch` raises
instead of returning `created` — the regression the pilot found. A healthy
fixture still verifies, which is what stops the new checks being vacuous.

## Windows rollout checklist

Kept as the procedure for the next release. Run from `C:\Claude\sync-agent`
with the notebook's existing virtualenv:

```powershell
.venv\Scripts\python.exe -c "import agent; cfg=agent.load_config(); print('updated=', agent.self_update(cfg)); print('version=', agent.AGENT_VERSION)"
.venv\Scripts\python.exe agent.py publish-probe
```

The probe should report agent `1.21.0`, the current LH2 endpoint, and
`compatible: true`. The probe now discovers the rotated port itself and reports
`cdp_port` beside `cdp_port_configured` and `lh_version_measured` beside
`lh_version_configured` — check those two pairs first if it fails.

After an approved job is present in the dashboard, run:

```powershell
.venv\Scripts\python.exe agent.py publish-once
```

Before creating anything, compare the healthy reference campaign with the
published ones:

```powershell
.venv\Scripts\python.exe agent.py publish-verify --campaign 6 --campaign 7 --campaign 8 --campaign 9
```

Then perform read-only verification:

- campaign count increased by one;
- the new campaign is paused;
- people/targets count is zero;
- action-version count equals action count;
- `action_versions_missing_exclude_list = 0`;
- the campaign opens in the LH2 UI.

The agent now performs all of those checks itself: `publish-once` reports
`FAILED` and exits non-zero unless every one of them holds.

Do not run `sync` as part of this publishing verification, and do not manually
edit SQLite. See "Open items" for the state of campaigns 7, 8 and 9.

## Safety and licensing decisions

- All pre-create diagnostics were read-only. SQLite readback uses `mode=ro`.
- No LinkedIn session/page target was used for runtime evaluation; checks were
  limited to the LH2 local renderer.
- The CDP endpoint is an unauthenticated loopback service. Treat the notebook
  and terminal history as sensitive, even though no credentials or lead data are
  stored in these reports.
- The attempted direct SQLite repair was removed before release. The project
  specification permits AGPL `lhremote` as behavioral evidence only; its
  implementation and schema-write logic must not be copied. Any future direct
  schema write requires separate technical and legal/support approval. The
  released fix uses the independently observed native LH2 behavior instead.

## Rollback

The agent's self-update accepts only a strictly higher version. Rollback is
therefore performed by publishing a new higher version containing reverted code,
not by republishing an older version. LH2 campaign 7 is a separate data-state
problem and cannot be rolled back by changing the agent release.

## Open items

Closed on 2026-08-31, after the pilot:

- **`publish-once` is now scheduled.** `register_schedule` registers the
  namespaced two-minute publish task when — and only when — the machine's own
  `config.yaml` carries an `lh2_publish` profile with `enable_cdp_adapter: true`.
  That is the same gate the agent's preflight requires, so adding a notebook
  cannot give it a publish worker by accident, and the schedule follows the
  machine's configuration rather than a separate list that could drift from it.
  Deactivation removes the publish task unconditionally.
- **The fixture is now a real oracle.** `frontend/tests/sequencePublishFixture.test.ts`
  loads LH2's own export of reference campaign 6 from
  `docs/platform-ops/linked-helper-campaign-settings-fixture.csv`, pins its
  SHA-256, reconstructs the source text from the fixture's own template ASTs,
  and asserts deep equality of the entire compiled chain — every action,
  setting, cooldown and per-iteration limit. Seven perturbations prove the
  comparison is not vacuous. The compiler matched on the first run.
- **The browser client no longer dies at import.** `createClient` throws on a
  malformed `VITE_SUPABASE_URL`, and this module is imported at startup, so a
  placeholder or a `vercel env pull` redaction produced a blank page instead of
  the configuration banner. An unusable value is now treated exactly like a
  missing one, which every consumer already handles.
- **`installer/release.json` was four versions stale** (1.17.1 while the fleet
  ran 1.18.0) and nothing checked it. It now pins 1.21.0, and `deploy.sh` runs
  `tests/test_installers.py`, which is the gate that asserts the pin matches the
  exact `agent.py` being published.

Still open:

### 1. `lh_version` still disagrees with the running build

The measured build is `2.130.17`; `config.yaml` and the dashboard publish
profile say `2.130.29`. Since `1.21.0` fails closed on `LH_VERSION_MISMATCH`,
both must be corrected. Note the ordering: the account snapshot is part of the
job, so a job queued against the old value fails
`PUBLISH_ACCOUNT_SNAPSHOT_MISMATCH`. Update the dashboard profile first, then
`config.yaml`, then recreate the job.

The CDP port needs no maintenance — discovery finds the rotated port itself.

Registering the publish task on the pilot notebook is a re-run of the installer's
activation, or the one command directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install-windows.ps1 `
  -RegisterPublishSchedule -InstallRoot C:\Claude\sync-agent `
  -TaskName "LH2 Publish Agent -- notebook-1"
```

### 2. LH2 campaigns 7, 8 and 9

Three malformed test artifacts remain. All are paused with zero targets and
nothing was sent from them. Removing them needs a supported LH2 UI or vendor
operation; the adapter has no delete path and direct SQL repair was rejected.

### 3. `test:cleanroom` cannot run on this checkout

`frontend/.env.local` came from `vercel env pull`, which redacts secret values as
`[SENSITIVE]`, so `IDENTITY_STORE_DATABASE_URL` is unusable and the cleanroom
suite fails. `npm test` is now green regardless (54 files / 1040 tests), because
it no longer depends on a usable Supabase URL. The cleanroom gate is left failing
loudly rather than auto-skipped: "skipped" and "passed" must not look the same.

### 4. Cosmetic difference from a natively created campaign

The publisher writes the action type into `actions.name`; the LH2 UI leaves that
column empty. It has no effect on validity and is deliberately kept as the more
informative value.
