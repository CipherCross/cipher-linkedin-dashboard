# Notebook rollout prompt — 1.12.2 → 1.15.1, Supabase → Neon gateway

Paste everything between the two `═══` lines into the AI agent running on **one**
notebook. It is identical for every notebook — **it contains no secrets and no
per-notebook values** — so the same text is safe to reuse on all of them. The
agent asks for one thing, the credential, at the very start, and then runs
unattended to the end.

**notebook-1 is done** (2026-08-12), which is why this version has no
confirmation gates: the procedure has been proven end to end, so the remaining
notebooks run start to finish and stop only on a real failure. The abort
conditions at the bottom of the prompt are what replaced the human checkpoints.

Two things must be true before you paste it, and both already are for this fleet:

1. **Production reads the new Neon project** (S28 gate 6) — done, and the
   dashboard is deployed with the `/api/import` GET fix.
2. **That notebook's machine credential is minted**, against the *current*
   deployment, and you have the plaintext `lha.<uuid>.<secret>`. It is shown once
   at mint time and is not recoverable.

**`sync_photos` is a remote-config key**, so whatever the Health page holds for a
notebook outranks its local file. From `shadow` onward the mirror also uploads
each photo to the gateway, and a gateway photo failure withholds the Supabase
`photo_synced_at` stamp, which stalls that notebook's existing Supabase photo
backfill rather than failing on its own. On the `only` path the mirror refuses
cleanly (1.15.1). If you would rather keep photos out of the rollout entirely,
clear `sync_photos` on the Health page first — the prompt reports what it sees
and deliberately does not change it.

═══════════════════════════════════════════════════════════════════════════════

You are upgrading the Linked Helper sync agent on this notebook and moving its
data destination from Supabase to the dashboard gateway. The procedure below has
already been run end to end on another notebook, so **run it start to finish
without asking me to confirm anything.**

Ask me exactly one question, right now, before you begin — see "The one thing I
have to give you". After that, work unattended until you either finish or hit one
of the abort conditions at the end. Do not ask permission between steps, do not
summarise and wait, do not check in. Report once, at the end.

## What this notebook is

It runs Linked Helper 2 (LH2), which stores its data in a local SQLite file
(`lh.db`). A single-file Python program, `agent.py`, reads that file on a
schedule (cron every 30 minutes, or Task Scheduler on Windows) and pushes the
extracted campaigns, leads, messages and steps to a remote dashboard. It lives in
a `sync-agent` folder with its own virtualenv (`.venv`) and a `config.yaml`
holding credentials.

Today it pushes to Supabase. You are switching it to the dashboard's
authenticated gateway at `https://ciphercross.dev`, and putting it on a signed
self-update channel so future upgrades need no manual copying.

## Hard rules — these override everything below

- **Never print, echo, log or repeat back the contents of `config.yaml`**, and
  never display any value of `supabase_service_key`, `ingest_token`, or anything
  beginning `lha.`. Confirm a credential only as present/absent and shape ok/not.
  If I paste one to you, do not repeat it back.
- **Never change `instance_id`.** Every row this notebook has ever written is
  keyed by it; changing it silently duplicates the entire history.
- **Never touch `lh.db` or anything in the Linked Helper folders.** The agent
  opens it read-only and LH2 may keep running throughout.
- Do not run `agent.py annotate`, and do not change `sync_photos`.
- Autonomy ends at the abort conditions. When one fires, stop and report — do not
  improvise a fix, do not retry with different values, do not continue to the
  next step. A working notebook that was not upgraded beats a broken one.

## The one thing I have to give you

Ask me for this notebook's machine credential now, then proceed unattended.

It looks like `lha.` + a 36-character UUID + `.` + 43 characters of letters,
digits, `-` or `_`. Check that shape and report pass/fail only, never the value.
If it does not match, stop before touching anything.

The shape check matters more than it looks: this notebook still holds Supabase
credentials, so a malformed token does **not** stop a sync. The run succeeds,
Supabase gets its data, and the gateway half quietly skips with one line in the
output. A token that is wrong in a way nobody notices is what this whole
procedure exists to prevent.

## Step 1 — survey (record, do not stop)

Find the `sync-agent` folder, its `.venv`, `agent.py` and `config.yaml`. Record
the absolute path, the current `AGENT_VERSION` (expected `1.12.2`), the
`instance_id` (safe to show), whether the Supabase keys are present (yes/no), the
cron line or Task Scheduler entry, and the last 20 lines of any sync log.

## Step 2 — back up

Copy `agent.py` to `agent.py.1.12.2.bak` and `config.yaml` to `config.yaml.bak`.
Confirm both exist and are non-empty. This is the rollback; if it fails, abort.

## Step 3 — dependencies

The new version verifies an Ed25519 signature on every release it downloads:

- macOS/Linux: `.venv/bin/pip install --upgrade requests pyyaml 'cryptography>=42.0'`
- Windows: `.venv\Scripts\pip.exe install --upgrade requests pyyaml "cryptography>=42.0"`

Record the resulting versions. If `cryptography` will not install, record that and
carry on — the agent falls back to OpenSSL — but say so in the report.

## Step 4 — download and verify 1.15.1, then install

The repository is public, so this needs no credential, and the URL is pinned to
one immutable commit rather than a branch — it cannot hand you a different file
than it handed the previous notebook. **Verify before installing**: download to a
temporary name and move it into place only once all three checks pass, so a
truncated download never spends a moment as `agent.py`.

macOS / Linux:

```bash
curl -fsSL -o agent.py.new \
  https://raw.githubusercontent.com/CipherCross/cipher-linkedin-dashboard/4b040863d7dd39b6503d676eb8d959b5f9b31f45/sync-agent/agent.py

shasum -a 256 agent.py.new              # expect b39fc97c3d2b8c3136d2dcf3e68b368274720da2b7ab6e47f6b891ebb6f01269
wc -c < agent.py.new                    # expect 134074
grep -m1 '^AGENT_VERSION' agent.py.new  # expect AGENT_VERSION = "1.15.1"

mv agent.py.new agent.py                # only if all three matched
.venv/bin/python -m py_compile agent.py
```

Windows (PowerShell):

```powershell
curl.exe -fsSL -o agent.py.new `
  https://raw.githubusercontent.com/CipherCross/cipher-linkedin-dashboard/4b040863d7dd39b6503d676eb8d959b5f9b31f45/sync-agent/agent.py

certutil -hashfile agent.py.new SHA256   # expect b39fc97c3d2b8c3136d2dcf3e68b368274720da2b7ab6e47f6b891ebb6f01269
(Get-Item agent.py.new).Length           # expect 134074
Select-String -Path agent.py.new -Pattern '^AGENT_VERSION' | Select-Object -First 1

Move-Item -Force agent.py.new agent.py   # only if all three matched
.venv\Scripts\python.exe -m py_compile agent.py
```

If any check disagrees, delete `agent.py.new`, leave the current `agent.py`
untouched, and abort. If this machine cannot reach `raw.githubusercontent.com`,
abort and say so — I will hand you the file instead.

## Step 5 — config

Leave every existing key exactly as it is, including both Supabase keys. Append:

```yaml
ingest_url: "https://ciphercross.dev/api/import?op=agent.ingest"
ingest_mode: "shadow"
release_public_key: "v-Zb6qV8GZhMjatTKgNo4BUaTIjfHh1MWEq8jQ4A6Is"
ingest_token: "<the credential I gave you>"
```

The first three are identical on every notebook and are not secret. Then confirm
the file is still valid YAML and `instance_id` is unchanged.

## Step 6 — dry run

Run `.venv/bin/python agent.py sync --dry-run` (Windows:
`.venv\Scripts\python.exe agent.py sync --dry-run`). It extracts everything and
pushes nothing. Capture the full output and record:

- the per-campaign leads / invited / accepted / replied table
- the batch list and whether **parity** says `ok`
- the credential id it names (the UUID half — safe to record)
- which keys, if any, the line `remote-config: applied online overrides for …`
  names, and whether `ingest_mode` or `ingest_url` is among them
- any campaign dropped by `exclude_campaigns`, with its counts

Then run this check yourself, because it is the one extraction fault that has
actually occurred here: compare each campaign's **invited** count from the
campaign table against that campaign's **invite sends** in the step table. The
two come from independent queries. If any ratio exceeds **1.2**, the leads
mapping has lost its `person_external_ids` dedup and is counting each person
about twice — abort and report the table. Ratios near 1.00 are correct.

## Step 7 — shadow

Run the same command without `--dry-run`. `shadow` means Supabase still receives
the authoritative copy exactly as today, and the gateway receives the same data
alongside it; a gateway failure is recorded as noise.

Success looks like:

```
ingest 1/1: accepted   <N> rows  key sync.<date>.<hash>  written <N>
ingest: 1 batch(es) delivered as credential <uuid> — 1 accepted, 0 replayed
```

Read the output for the abort lines listed at the end — in `shadow` the run
reports overall success even when the gateway half failed, so the exit status
will not tell you.

## Step 8 — dual

Set `ingest_mode: "dual"` and run one real sync. Same as `shadow` except a
gateway failure now marks the run `partial` and becomes visible on the dashboard.

## Step 9 — only

Set `ingest_mode: "only"` and run one real sync. The gateway is now the sole
destination: no Supabase client is built, and a delivery failure fails the run.

Expect no mention of Supabase. If `sync_photos` is on for this notebook you will
also see one line saying photo sync was **skipped** — that is correct on this
path, which builds no Supabase client for the mirror to use. A photo mirror that
*ran* here would not be correct. Record the line either way; do not change the
setting.

If this run fails, set `ingest_mode` back to `"dual"`, run one sync to confirm
the notebook is delivering again, and report.

## Step 10 — report

Confirm the cron entry or Task Scheduler task is unchanged and still points at
the same command and folder, and that `auto_update` is still `true` — from now on
this notebook checks the signed release channel at the start of every scheduled
sync, so this is the last time anyone copies a file to it by hand.

Then give me this, with nothing secret in it:

```
notebook:            <instance_id>
agent version:       <before> -> <after>
config backup:       <path>
credential id:       <the uuid half named in the dry run>
remote overrides:    <keys named, and whether ingest_mode/ingest_url were among them>
excluded campaigns:  <what exclude_campaigns dropped, with counts>
dry-run counts:      <campaign: leads/invited/accepted/replied, per campaign>
invite ratio check:  <per campaign: leads-path invited vs step-path sends, ratio>
parity:              <ok / the problems reported>
shadow sync:         <ok / failed — one line>
dual sync:           <ok / failed — one line>
only sync:           <ok / failed — one line>
photo line:          <verbatim, or "none">
scheduled job:       <unchanged / describe>
warnings seen:       <any warning-looking line, verbatim>
```

I will compare the counts against LH2 myself. Print the table; do not wait for me.

## Abort conditions

Stop and report immediately on any of these. Everything else, keep going.

1. The token does not match the shape above.
2. The downloaded file's hash, size or version disagrees, or the download fails.
3. `config.yaml` is not valid YAML after editing, or `instance_id` changed.
4. The dry run refuses to start — read the message, it names what is missing.
5. Parity is not `ok`.
6. Any campaign's invite ratio exceeds 1.2.
7. Any of these appears in a run:

```
ingest: ingest_token is not a well-formed lha token — skipped
ingest: ingest_url or ingest_token is missing
ingest: refusing to deliver — <N> parity problem(s):
ingest: transport failed before delivery (<error>)
```

8. `remote-config: applied online overrides` names `ingest_mode` or `ingest_url` —
   the dashboard is deciding this notebook's mode and my local edits will keep
   being overridden. That is mine to fix, not yours.
9. A real sync exits non-zero at any mode.

## Rollback

```
cp agent.py.1.12.2.bak agent.py
cp config.yaml.bak config.yaml
```

Then run one sync to confirm the notebook is working again, and report what
happened. Rolling back is always the right first move — nothing here is urgent
enough to debug on a machine that is supposed to be syncing.

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
