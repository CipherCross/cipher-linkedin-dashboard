# The signed agent release channel

How a change to `sync-agent/agent.py` reaches every notebook without anyone
touching a notebook. Live since 2026-08-12; first release published is **1.15.1**.

## The trust model, in one paragraph

The transport is not trusted; the **signature** is. An operator signs a release
manifest with an Ed25519 private key that never leaves their machine, and every
notebook carries only the public half in its `config.yaml`. The dashboard holds a
**read-only** bucket credential, so a compromised dashboard can serve a release
but cannot create one. The bucket is private and every read is a 120-second
presigned URL. This is why no secret has to reach a notebook and no notebook
needs access to anything but the dashboard it already talks to.

## What happens on a notebook, every scheduled sync

Before extracting anything, `self_update` (`agent.py:315`) calls
`GET /api/import?op=agent.release` with its own `ingest_token`. The dashboard
reads `agent/current.json` and answers with the signed manifest plus a presigned
download URL. The agent then, in order:

1. compares versions and **stops unless the published one is strictly greater**;
2. verifies the Ed25519 signature against its local `release_public_key`;
3. checks size and SHA-256 against the manifest;
4. replaces itself atomically and re-execs.

Every failure — unreachable bucket, bad signature, wrong hash, 4xx, 5xx — leaves
the current file in place and lets the scheduled sync proceed. A broken release
channel can never break a sync.

## Cutting a release

```bash
# 1. bump AGENT_VERSION in sync-agent/agent.py, commit
# 2. load the operator credentials (never committed; see "Where things live")
set -a; . ~/.config/agent-release.env; set +a
# 3. publish
sync-agent/deploy.sh
```

`deploy.sh` runs `py_compile`, the transport tests and a `bash -n` of itself
before anything is uploaded — it is the last gate before the whole fleet
self-updates. `publish_release.py` then writes, in this order:

```
agent/<version>/agent.py
agent/<version>/manifest.json
agent/current.json          <- LAST, always
```

The pointer moves last so a notebook reading mid-publish sees either the complete
old release or the complete new one, never a pointer to half a release.

Notebooks pick it up within 30 minutes. Watch `agent_version` per instance on the
dashboard's Health page.

## Verifying a release

Signing proves nothing on its own — verify with the key the **notebooks** hold,
not the one that signed it:

```bash
set -a; . ~/.config/agent-release.env; set +a
export AWS_ACCESS_KEY_ID="$AGENT_RELEASE_WRITE_ACCESS_KEY_ID" \
       AWS_SECRET_ACCESS_KEY="$AGENT_RELEASE_WRITE_SECRET_ACCESS_KEY" \
       AWS_DEFAULT_REGION=auto

aws s3 ls "s3://$AGENT_RELEASE_BUCKET/" --recursive --endpoint-url "$AGENT_RELEASE_ENDPOINT"
aws s3 cp "s3://$AGENT_RELEASE_BUCKET/agent/current.json" - --endpoint-url "$AGENT_RELEASE_ENDPOINT"
```

Then verify the manifest through the agent's own verifier, with the public key
copied out of a notebook's `config.yaml`. `agent.verify_release_signature` and
`agent.release_version` are importable directly; check that a tampered manifest
(change `version` or `sha256`) fails, or the positive result proves nothing.

That the read credential can serve a download is a separate question from whether
the bucket has the bytes, and worth its own check:

```bash
url=$(AWS_ACCESS_KEY_ID=<read id> AWS_SECRET_ACCESS_KEY=<read secret> AWS_DEFAULT_REGION=auto \
  aws s3 presign "s3://$AGENT_RELEASE_BUCKET/agent/<version>/agent.py" \
  --expires-in 120 --endpoint-url "$AGENT_RELEASE_ENDPOINT")
curl -fsSL "$url" | shasum -a 256      # must equal the manifest's sha256
```

## Things that will bite

**You roll back by rolling forward.** Self-update accepts only a strictly higher
version, so republishing 1.15.1 cannot undo 1.16.0 — publish 1.16.1 containing the
reverted code. The asymmetry is deliberate: it stops a stale pointer from
downgrading a fleet. It also means a bad release needs a new number, and the fix
must be *published*, not reverted in git.

**Publishing the version the fleet already runs is a no-op.** Useful as a safe
first publish, and useless as proof that self-update works. The first genuine
end-to-end proof is the first *higher* version — make it small, and let one
notebook take it before the rest.

**Pin a canary.** `auto_update: false` in a notebook's `config.yaml` holds it
back. Worth setting on all but one for any release whose blast radius you are
unsure of.

**The private key is the fleet.** Anyone holding
`~/.config/agent-release-signing.pem` can publish a build that every notebook
will trust and execute. It must never reach the dashboard, Vercel, R2 or a
notebook. Rotating it means publishing a release *and* hand-editing
`release_public_key` on every notebook — the one operation this design cannot do
remotely, and the accepted cost of not needing a secret on the notebooks.

**The release bucket is not the photo bucket.** `releaseArtifacts.ts:181-190`
refuses a release bucket equal to `OBJECT_STORAGE_BUCKET` and will fail closed if
they are ever set the same.

**`deploy.sh` runs under bash 3.2 on macOS.** It died on its first-ever
invocation because an apostrophe inside a `${VAR:?message}` expansion is an
opening quote to that parser — after passing its own tests, which is the worst
place to fail. `bash -n` on the script now runs inside the transport suite; keep
it there, and keep apostrophes out of those messages.

## Where things live

| Thing | Location | Secret |
| --- | --- | --- |
| Signing private key | `~/.config/agent-release-signing.pem`, mode 0600 | **yes — the fleet** |
| Operator credentials | `~/.config/agent-release.env`, mode 0600 | **yes** (write pair) |
| Release public key | each notebook's `config.yaml`, `release_public_key` | no — a trust anchor |
| Read-only pair | Vercel production, `AGENT_RELEASE_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | yes |
| Endpoint + bucket | Vercel production, `AGENT_RELEASE_ENDPOINT` / `AGENT_RELEASE_BUCKET` | no |
| Artifacts | R2 bucket `lh2-agent-releases`, private, `r2.dev` disabled | no |

Both R2 token pairs are scoped to that bucket alone. Minting them is a Cloudflare
**dashboard** action — `wrangler r2` exposes only `object`, `bucket` and `sql`,
so there is no CLI path to an S3 API token. Do not spend time looking for one.

## Note on this repository being public

`CipherCross/cipher-linkedin-dashboard` is a public repo, so this file, the
rollout prompt and the S29 handoff carry the bucket name, the R2 endpoint (which
embeds the Cloudflare account id), the dashboard origin and the release public
key. None of them is a credential — the account id is inert without an API token,
and the public key is published by design. Said plainly here so it is a decision
on the record rather than an oversight.
