# Campaign Creator: Linked Helper 2 publishing summary

**Updated:** 2026-08-31  
**Scope:** Sequence Builder → Linked Helper 2 paused, zero-target campaign creation

## Current outcome

The publishing path is now fixed in the agent and released as signed version
`1.18.0`. The fix is deliberately small: the publisher no longer sends
`excludeList: []` in the `createCampaign` payload. In LH2 2.130.29, an absent
`excludeList` key selects the native initialization branch that creates the
required empty exclude-list placeholder for every action.

The source commit is `d12acde` (`Fix LH2 empty exclude-list initialization`). The
release pointer and manifest were verified from the private release bucket:

- pointer version = `1.18.0`;
- manifest version = `1.18.0`;
- downloaded size matches the signed manifest;
- downloaded SHA-256 matches the signed manifest;
- Ed25519 signature validates against the notebook-pinned public key;
- downloaded source contains `AGENT_VERSION = "1.18.0"`.

The two untracked planning specs are intentionally preserved:

- `specs/2026-08-12-tenant-owner-feature-config.md`;
- `specs/2026-08-31-sequence-builder-linked-helper-publishing.md`.

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
113 tests passed
python -m py_compile agent.py: passed
```

The regression assertion verifies that the generated create expression does not
contain an `excludeList` key.

## Windows rollout checklist

The signed release is available, but the real notebook must still self-update.
Run from `C:\Claude\sync-agent` with the notebook's existing virtualenv:

```powershell
.venv\Scripts\python.exe -c "import agent; cfg=agent.load_config(); print('updated=', agent.self_update(cfg)); print('version=', agent.AGENT_VERSION)"
.venv\Scripts\python.exe agent.py publish-probe
```

The probe should report agent `1.18.0`, the current LH2 endpoint, and
`compatible: true`. Recheck the ephemeral CDP port if LH2 restarted.

After an approved job is present in the dashboard, run:

```powershell
.venv\Scripts\python.exe agent.py publish-once
```

Then perform read-only verification:

- campaign count increased by one;
- the new campaign is paused;
- people/targets count is zero;
- action-version count equals action count;
- `action_versions_missing_exclude_list = 0`;
- the campaign opens in the LH2 UI.

Do not run `sync` as part of this publishing verification, and do not manually
edit SQLite. Campaign 7 remains the known malformed test artifact until a
supported LH2 UI/vendor operation is available to remove or repair it.

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

