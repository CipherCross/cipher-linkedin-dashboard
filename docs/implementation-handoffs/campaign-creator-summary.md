# Campaign Creator: Linked Helper 2 publishing summary

**Updated:** 2026-08-31  
**Scope:** Sequence Builder → Linked Helper 2 paused, zero-target campaign creation

## Current outcome

The `1.18.0` exclude-list fix **did not work**, and it made the result worse.
The pilot run of `1.18.0` created LH2 campaign **9** with:

- all 13 action versions still at `exclude_list_id IS NULL` — the same state as
  campaigns 7 and 8, which were created *with* `excludeList: []`;
- `campaigns.is_valid = 0` — a new regression. Campaigns 7 and 8 were at
  `is_valid = 1`.

Removing the top-level `excludeList` key therefore changed the validity flag
without changing the action-level references at all. That is evidence the
campaign-level key is the wrong lever: `exclude_list_id` is a **per action
version** reference, and a healthy campaign holds one distinct collection per
action version. Whatever suppresses LH2's native placeholder setup is in the
per-action part of the payload, not in the campaign-level key.

The publisher payload is unchanged in `1.19.0`. The failing hypothesis has not
been replaced with another guess.

### What `1.19.0` does change: the verifier

The decisive problem found by the pilot was not the payload — it was that the
agent reported `publish-once: completed` for a campaign LH2 itself cannot open.
Canonical readback checked id, name, `liAccountId` and the action chain, but
checked neither `exclude_list_id` nor `is_valid`, so a successful publish and a
structurally broken one were indistinguishable. Further runs would have
accumulated broken campaigns silently.

`1.19.0` closes that first:

- readback now also reads `campaigns.is_valid` and, for every action version of
  the campaign, `action_versions.exclude_list_id`;
- verification fails closed on `LH_CAMPAIGN_NOT_VALID`,
  `LH_ACTION_EXCLUDE_LIST_MISSING`, `LH_ACTION_EXCLUDE_LIST_UNRESOLVED` and
  `LH_ACTION_VERSION_COUNT_MISMATCH`;
- a build whose schema lacks either column fails closed with its own code
  (`LH_CAMPAIGN_VALIDITY_UNKNOWN`, `LH_ACTION_EXCLUDE_LIST_UNKNOWN`) rather than
  skipping the check it was supposed to perform;
- the verification summary sent to the dashboard now carries `is_valid`,
  `action_version_count`, `exclude_lists_present` and `exclude_lists_unresolved`;
- `publish-once` no longer prints `completed` when a branch failed. It prints
  `publish-once: FAILED — n of m branch(es) did not verify` and exits non-zero.

Replayed against the campaign 7/8/9 states, the new verifier rejects all three.

### New read-only command

`agent.py publish-verify --campaign 6 --campaign 9` prints the structural state
of local campaigns without contacting LH2 and without creating anything to look
at. Per campaign it reports paused, `is_valid`, action count, action-version
count, action versions missing an exclude list, unresolved exclude-list
references, target people, action types, and — the part that should identify the
suppressed placeholder setup — which `action_versions` reference columns LH2
populated and which it left NULL, by column name.

Comparing the natively created reference campaign 6 against published campaign 9
with this command is the next diagnostic step. It reads the database `mode=ro`
and reports no stored values, only column names and NULL/set.

### Leading hypothesis, not yet tested

Each action entry in the create payload is built as
`{"name", "description", "target": [], "config": {...}}`. If LH2 guards its
native `_createPeopleCollection()` + `createPeopleCollectionVersion(id,
"addToTarget")` path on the action's list argument being `undefined` — the same
`!== undefined` shape already observed at the campaign level — then `"target":
[]` has been suppressing that setup on every run, which would explain why the
campaign-level change moved `is_valid` and nothing else. The healthy reference
campaign's `exclude_list_id` values point at `addToTarget` collection versions,
which is consistent with one native path creating both.

This is a hypothesis. It should be checked against the `publish-verify`
comparison of campaigns 6 and 9 before another campaign is created.

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
14. `1.19.0` leaves the payload alone and closes the verifier gap instead:
    `is_valid` and the per-action-version exclude-list references are now part
    of canonical verification, and `publish-verify` reports the structural
    difference between a native campaign and a published one read-only.

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

The publisher now builds this payload shape for a new campaign:

```python
{
    "name": name,
    "liAccount": li_account_id,
    "actions": actions,
}
```

It intentionally does **not** include `"excludeList": []`. LH2 must own the
creation of its empty placeholder collections and versions. The adapter still
creates only empty-target campaigns, explicitly pauses them, and performs
canonical readback. It has no start/unpause, target population, archive, rename,
delete, or direct-SQL repair path.

## Verification performed locally

From `sync-agent/` using the project virtualenv:

```text
123 tests passed
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

The signed release is available, but the real notebook must still self-update.
Run from `C:\Claude\sync-agent` with the notebook's existing virtualenv:

```powershell
.venv\Scripts\python.exe -c "import agent; cfg=agent.load_config(); print('updated=', agent.self_update(cfg)); print('version=', agent.AGENT_VERSION)"
.venv\Scripts\python.exe agent.py publish-probe
```

The probe should report agent `1.19.0`, the current LH2 endpoint, and
`compatible: true`. Recheck the ephemeral CDP port if LH2 restarted.

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
edit SQLite. Campaigns 7, 8 and 9 remain known malformed test artifacts until a
supported LH2 UI/vendor operation is available to remove or repair them. All
three are paused with zero targets and nothing was sent to LinkedIn.

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

