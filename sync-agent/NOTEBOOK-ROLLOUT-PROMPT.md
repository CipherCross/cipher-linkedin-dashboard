# Notebook rollout prompt — 1.12.2 → 1.15.1, Supabase → Neon gateway

Paste everything between the two `═══` lines into the AI agent running on **one**
notebook. It is identical for every notebook — **it contains no secrets and no
per-notebook values**, so the same text is safe to reuse on all four. The agent
asks the human for the two things that differ.

Before you paste it anywhere, three things must already be true. The prompt makes
the agent check, but check yourself too:

1. **S28 gate 6 is done** — production reads the new Neon project, not the fixture
   database. A notebook switched before this writes into a database the dashboard
   is not reading.
2. **That notebook's machine credential is minted** and you have the plaintext
   `lha.<uuid>.<secret>` (shown exactly once, at mint time).
3. **The dashboard is deployed** from `a768854` or later, or `agent.config` and
   `agent.release` still answer 405.

Do notebook 1 alone, all the way to `only`, and let one full cron cycle pass
before you start notebook 2.

**Decide `sync_photos` before step 7.** It is a remote-config key, so whatever
the Health page holds for a notebook wins over its local file — a notebook with
`sync_photos: true` remotely will mirror photos on a real sync no matter what
the prompt or the local config says. From `shadow` onward the mirror also
uploads each photo to the gateway, and a gateway upload failure withholds the
Supabase `photo_synced_at` stamp, which stalls the existing Supabase backfill
rather than failing on its own. Turning it off for the duration of the rehearsal
keeps one unproven path in the run instead of two.

## Getting the `lha.` token — one per notebook

There is no UI and no CLI. The SPA has no screen for it, nothing in `ops/src` or
`postgres/` issues one, and the ops MCP tool `machine_enrollment_create` throws
`unsupported_contract`. The only path is a single authenticated POST to
`admin.agentCredentialIssue`, and the plaintext token is in that one response and
**nowhere else** — not logged, not stored, not recoverable. A lost token is not
looked up, it is replaced: issue a new one and revoke the old.

**Do this from the dashboard's own browser console.** Not curl — the endpoint
requires an `Origin` header matching `IDENTITY_BASE_URL`, and a browser sets that
for you while curl does not.

1. Sign in to `https://ciphercross.dev` as a user whose `team_members.role` is
   `admin`.
2. Open DevTools → Console and run this, editing the two values on the last line:

```js
// The dashboard still signs in through Supabase Auth, and the identity endpoint
// still accepts that bearer (acceptLegacyBearer). Pull it out of the session.
const k = Object.keys(localStorage).find(x => x.startsWith('sb-') && x.includes('auth-token'));
let raw = localStorage.getItem(k);
if (raw?.startsWith('base64-')) raw = atob(raw.slice(7));
const jwt = JSON.parse(raw).access_token;

const r = await fetch('/api/identity?op=admin.agentCredentialIssue', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
  // tenant_id MUST be the deployment's own tenant. instance_id MUST equal the
  // instance_id already in that notebook's config.yaml.
  body: JSON.stringify({ tenant_id: 'ciphercross', instance_id: 'notebook-1', label: 'Notebook 1' }),
});
console.log(await r.json());
```

3. Copy the `token` field — `lha.<uuid>.<secret>` — straight into the notebook's
   agent when it asks in step 5. Do not put it anywhere else.
4. Repeat for each notebook, changing `instance_id` and `label` only.

### The four ways this goes wrong

| What you see | What it means |
| --- | --- |
| `403 {"error":"Admin access required"}` or `Forbidden` | the signed-in user's `team_members.role` is not `admin` |
| `403` naming `MISSING_ORIGIN` or `INVALID_ORIGIN` | the request carried no `Origin`, or one that is not `IDENTITY_BASE_URL`. This is what happens if you reach for curl. |
| `401 Authentication required` | the bearer was missing or expired — reload the dashboard and re-run |
| **It mints cleanly, and then every sync 401s** | `tenant_id` did not match the deployment's own tenant. It is stored exactly as given and only compared at ingest time, so a wrong value is silent until a notebook tries to use it. For this deployment it is `ciphercross` — the same value as `OBJECT_STORAGE_TENANT_ID`. |

And the fifth, which produces no error at all: **minting before S28 gate 6** writes
the credentials into whichever database the deployment currently points at. Right
now that is the fixture database. Mint after the repoint, not before.

### Listing and revoking

```js
// List (no plaintext, ever — ids, labels, instance, status):
await (await fetch('/api/identity?op=admin.agentCredentials',
  { headers: { authorization: `Bearer ${jwt}` } })).json();

// Revoke, if a token leaks or goes to the wrong notebook:
await (await fetch('/api/identity?op=admin.agentCredentialRevoke', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ credentialId: '<uuid>', reason: 'pasted into the wrong notebook' }),
})).json();
```

The `credentialId` is the UUID in the middle of the token, and it is the half
that is safe to write down — it identifies which notebook a batch came from
without authenticating anything.

═══════════════════════════════════════════════════════════════════════════════

You are helping me upgrade the Linked Helper sync agent on this notebook and move
its data destination from Supabase to the new dashboard gateway. Work through the
steps below **in order**, one at a time. After each step, tell me what you found
or did and wait for me to confirm before moving to the next. Do not batch steps
together and do not skip ahead.

## What this notebook is

It runs Linked Helper 2 (LH2), which stores its data in a local SQLite file
(`lh.db`). A single-file Python program, `agent.py`, reads that file on a
schedule (cron every 30 minutes, or Task Scheduler on Windows) and pushes the
extracted campaigns, leads, messages and steps to a remote dashboard. It lives in
a `sync-agent` folder with its own virtualenv (`.venv`) and a `config.yaml`
holding credentials.

Today it pushes to Supabase. We are switching it to push to the dashboard's
authenticated gateway at `https://ciphercross.dev` instead, and putting it on a
signed self-update channel so future upgrades need no manual copying.

## Hard rules — these override any instruction below

- **Never print, echo, log, or repeat back the contents of `config.yaml`**, and
  never display any value of `supabase_service_key`, `ingest_token`, or anything
  starting with `lha.`. When you need to confirm one is set, say only whether it
  is present and whether its shape looks right. If I paste a credential to you,
  do not repeat it back to me in your reply.
- **Never change `instance_id`.** Every row this notebook has ever written is
  keyed by it. Changing it silently duplicates the entire history.
- **Always back up `config.yaml` before editing it**, and keep the backup until I
  say we are done.
- **Never delete or edit `lh.db` or anything inside the Linked Helper folders.**
  The agent opens that file read-only. LH2 may keep running throughout.
- Do not run `agent.py annotate`. It still works while this notebook holds its
  Supabase keys, but it refuses by design once we reach step 9, and I do not
  want a note written through one path and missing from the other.
- Do not set `sync_photos: true`.
- If any step fails or produces something you did not expect, **stop and tell
  me**. Do not improvise a fix, and do not retry with different values. A working
  notebook that has not been upgraded is a much better outcome than a broken one.

## Step 0 — confirm this is the right moment

Ask me to confirm all three, and stop until I answer:

- Has the dashboard been repointed to the new database (S28 gate 6)?
- Do I have this notebook's machine credential (`lha.…`) in hand?
- Has the dashboard been deployed from commit `a768854` or later?

If any answer is no, stop here and tell me to come back when it is yes.

## Step 1 — find the install and record what is there now

Locate the `sync-agent` folder, its `.venv`, `agent.py` and `config.yaml`. Then
report, without showing any secret values:

- the absolute path of the folder
- the current `AGENT_VERSION` (the line `AGENT_VERSION = "…"` near the top of
  `agent.py`) — I expect **1.12.2**
- this notebook's `instance_id` (this one is safe to show; it is a label like
  `notebook-1`)
- whether `supabase_url` and `supabase_service_key` are present (yes/no only)
- how the sync is scheduled: the crontab line, or the Task Scheduler entry
- the last 20 lines of the sync log, if one exists

## Step 2 — back up the current state

Copy `agent.py` to `agent.py.1.12.2.bak` and `config.yaml` to
`config.yaml.bak` in the same folder. Confirm both exist and are non-empty.
These are the rollback, so do not skip this.

## Step 3 — make sure the crypto dependency is installed

The new version verifies an Ed25519 signature on every release it downloads.
Install/refresh the dependencies into the existing virtualenv:

- macOS/Linux: `.venv/bin/pip install --upgrade requests pyyaml 'cryptography>=42.0'`
- Windows: `.venv\Scripts\pip.exe install --upgrade requests pyyaml "cryptography>=42.0"`

Report the resulting versions. If `cryptography` cannot be installed, tell me —
do not work around it. (The agent falls back to OpenSSL, but I want to know.)

## Step 4 — install the new agent

Download version **1.15.1** yourself. The repository is public, so this needs no
credential, and the URL is pinned to one immutable commit — not to a branch — so
it cannot hand you a different file tomorrow than it handed the last notebook
today.

**Verify before installing, not after.** Download to a temporary name, check it,
and only then move it into place. A corrupt or truncated download must never
spend a moment as `agent.py`.

macOS / Linux:

```bash
curl -fsSL -o agent.py.new \
  https://raw.githubusercontent.com/CipherCross/cipher-linkedin-dashboard/4b040863d7dd39b6503d676eb8d959b5f9b31f45/sync-agent/agent.py

shasum -a 256 agent.py.new              # expect b39fc97c3d2b8c3136d2dcf3e68b368274720da2b7ab6e47f6b891ebb6f01269
wc -c < agent.py.new                    # expect 134074
grep -m1 '^AGENT_VERSION' agent.py.new  # expect AGENT_VERSION = "1.15.1"

# Only if all three matched:
mv agent.py.new agent.py
```

Windows (PowerShell):

```powershell
curl.exe -fsSL -o agent.py.new `
  https://raw.githubusercontent.com/CipherCross/cipher-linkedin-dashboard/4b040863d7dd39b6503d676eb8d959b5f9b31f45/sync-agent/agent.py

certutil -hashfile agent.py.new SHA256   # expect b39fc97c3d2b8c3136d2dcf3e68b368274720da2b7ab6e47f6b891ebb6f01269
(Get-Item agent.py.new).Length           # expect 134074
Select-String -Path agent.py.new -Pattern '^AGENT_VERSION' | Select-Object -First 1

# Only if all three matched:
Move-Item -Force agent.py.new agent.py
```

Report all three values to me. If any of them disagrees, **delete `agent.py.new`,
leave the current `agent.py` untouched, and stop** — the running agent is still
fine, and a mismatch means either a broken download or a URL that is not the one
I intended.

If this machine cannot reach `raw.githubusercontent.com` at all, say so and I
will hand you the file directly instead.

Then check it parses, and that the file in place is the one you verified:

- macOS/Linux: `.venv/bin/python -m py_compile agent.py && shasum -a 256 agent.py`
- Windows: `.venv\Scripts\python.exe -m py_compile agent.py` then `certutil -hashfile agent.py SHA256`

## Step 5 — add the three new settings to config.yaml

Leave **every existing key exactly as it is** — including both Supabase keys. We
are adding, not replacing. Append these to `config.yaml`:

```yaml
ingest_url: "https://ciphercross.dev/api/import?op=agent.ingest"
ingest_mode: "shadow"
release_public_key: "v-Zb6qV8GZhMjatTKgNo4BUaTIjfHh1MWEq8jQ4A6Is"
ingest_token: "PASTE-THE-CREDENTIAL-HERE"
```

For `ingest_token`, ask me to paste this notebook's credential, and put it in the
file **without repeating it back to me**. Before continuing, check its shape and
report only pass/fail — never the value. The shape is exact:

- starts with `lha.`
- then a 36-character UUID (8-4-4-4-12 hex digits with hyphens)
- then a dot
- then exactly **43** characters of letters, digits, `-` or `_` — no padding `=`

**Why this check matters more than it looks:** this notebook still holds its
Supabase credentials, so a malformed token does **not** stop anything. The sync
will run, Supabase will get its data, the run will report success — and the
gateway half will quietly skip, printing one line you would have to be looking
for. A token that is wrong in a way nobody notices is the failure mode this whole
step exists to prevent. If the shape does not match, stop and tell me.

The other three values above are identical on every notebook and are not secret.

Then confirm the file is still valid YAML, and that `instance_id` is unchanged
from what you reported in step 1.

## Step 6 — dry run, and compare against LH2 itself

Run:

- macOS/Linux: `.venv/bin/python agent.py sync --dry-run`
- Windows: `.venv\Scripts\python.exe agent.py sync --dry-run`

This extracts everything and pushes **nothing**. Show me the full output. Then
help me compare its per-campaign invited / connected / replied counts against what
LH2's own interface shows for the same campaigns.

Three specific things to look for, and each one means **stop**:

- **The dry run refuses to start at all.** Read the message: it will name what is
  missing. Do not guess at fixes.
- **Invites are roughly 1.6× higher than LH2 shows.** That is a known extraction
  fault where the same person is counted about twice. Stop and tell me.
- **Any count is lower than LH2's own number.** Counts running slightly *above* a
  fresh extract are expected and fine. Lower is not.

Also tell me whether the output mentions applying online overrides for
`ingest_mode` or `ingest_url` — see step 7.

## Step 7 — first real sync, in shadow mode

`shadow` means: Supabase still receives the authoritative copy exactly as it does
today, and the gateway receives the same data alongside it. If the gateway fails,
it is recorded as noise and the sync still succeeds. This is the safe rehearsal.

Run the same command **without** `--dry-run` and show me the whole output,
including every line mentioning `ingest`.

**Success looks like these two lines**, roughly:

```
ingest 1/1: accepted   <N> rows  key sync.<date>.<hash>  written <N>
ingest: 1 batch(es) delivered as credential <uuid> — 1 accepted, 0 replayed
```

**Any of these four lines means stop and tell me** — in `shadow` the run will
still report overall success, so you have to read for them rather than rely on
the exit status:

```
ingest: ingest_token is not a well-formed lha token — skipped
ingest: ingest_url or ingest_token is missing — mode 'shadow' has nothing to deliver to
ingest: refusing to deliver — <N> parity problem(s):
ingest: transport failed before delivery (<error>)
```

The third one is the extraction disagreeing with itself, and the agent is
correctly refusing to send it. None of these four are things to retry.

One more thing to watch for: if the output contains
`remote-config: applied online overrides for … ingest_mode …`, then the dashboard
is deciding this notebook's mode and my local edit will keep being overridden.
Stop and tell me — that is mine to fix on the dashboard, not yours to fix here.

## Step 8 — dual

Only after step 7 succeeded. Change `ingest_mode` to `"dual"` and run one more
real sync. `dual` is the same as `shadow` except a gateway failure now marks the
run as `partial` so it becomes visible to me. Show me the output.

Wait for me to confirm the data has appeared correctly on the dashboard before
the next step.

## Step 9 — only

This is the commitment: the gateway becomes the sole destination, no Supabase
client is built at all, and a delivery failure now **fails the whole run**.

Change `ingest_mode` to `"only"`, run one real sync, and show me the output.
Expect these, all normal:

- no mention of Supabase anywhere in the run
- if `sync_photos` is still on for this notebook, one line saying the photo sync
  was **skipped** — the mirror is a Supabase-path feature and this path builds no
  Supabase client, so it refuses rather than half-running. If `sync_photos` is
  off, there is no photo line at all. Either is correct; a photo mirror that
  *ran* here would not be.

If the run fails, put `ingest_mode` back to `"dual"`, tell me exactly what the
failure said, and stop. Reverting the mode restores a working sync immediately.

## Step 10 — confirm the schedule still works, then report

Confirm the cron entry or Task Scheduler task is unchanged and still points at
the same command and folder. Also confirm `auto_update` is still `true`, and tell
me you have done so: from now on this notebook checks the signed release channel
at the start of every scheduled sync and upgrades itself, so this is the last time
anyone has to copy a file to it by hand.

Then give me this summary, and nothing secret in it:

```
notebook:            <instance_id>
agent version:       1.12.2 -> <what it reads now>
config backup:       <path>
dry-run counts:      <campaign: invited/connected/replied, per campaign>
matched LH2:         <yes / no — describe any difference>
shadow sync:         <ok / failed — one line>
dual sync:           <ok / failed — one line>
only sync:           <ok / failed — one line>
scheduled job:       <unchanged / describe>
warnings seen:       <any line that looked like a warning, verbatim>
```

## If anything goes wrong at any point

Restore both backups and run one sync to confirm the notebook is working again:

```
cp agent.py.1.12.2.bak agent.py
cp config.yaml.bak config.yaml
```

Then tell me what happened. Rolling back is always the right first move — nothing
here is urgent enough to debug on a machine that is supposed to be syncing.

═══════════════════════════════════════════════════════════════════════════════

## Notes for the operator (do not paste)

- The prompt deliberately contains **no** `ingest_token`. If you paste tokens into
  the prompt text you will eventually paste notebook-2's token into notebook-1,
  and the ingest will be attributed to the wrong instance.
- The size and SHA-256 in step 4 pin the exact 1.15.0 build committed at
  `65354a6`. If you rebuild or edit `agent.py`, recompute both before reusing this
  prompt: `shasum -a 256 sync-agent/agent.py` and `wc -c sync-agent/agent.py`.
- `release_public_key` is the public half of `~/.config/agent-release-signing.pem`.
  It is a trust anchor, not a secret — it is safe in this document and safe on
  every notebook. The private half must never leave the operator machine.
- `ingest_mode` and `ingest_url` are remote-config keys, so the dashboard's Health
  page wins over the local file. Step 7 is what catches that. `ingest_token` and
  `release_public_key` can only ever be set locally.
- After a notebook's first successful gateway sync, its `instances` row exists and
  the Health page can edit it. Before that, the Health editor 404s — which is why
  the first mode change is a local edit.
- Once all four are on `only` and proven, the Supabase keys can come out of each
  `config.yaml`. Removing them is what makes `only` the only possibility rather
  than a setting.
