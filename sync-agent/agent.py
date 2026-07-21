#!/usr/bin/env python3
"""Sync agent: pushes Linked Helper 2 local data into Supabase.

Runs on each notebook. Three commands:

  python3 agent.py inspect                 # discover LH2 data dirs + SQLite schemas
  python3 agent.py sync                    # extract per config.yaml and upsert to Supabase
  python3 agent.py ingest-csv FILE --campaign "Name" [--kind successes|replies|queue]
  python3 agent.py annotate "Template B"   # drop a marker on the dashboard charts

Linked Helper 2 has no public API and its on-disk schema differs between
versions, so the agent is mapping-driven: run `inspect` once, look at the
table/column names it prints, and fill in the `mapping` section of
config.yaml. If you prefer not to touch the local DB, use LH2's built-in
"Export to CSV" and feed the file to `ingest-csv` instead — both paths write
the same normalized rows.

Dependencies: requests, pyyaml  (pip install -r requirements.txt)
"""

import argparse
import csv
import datetime as dt
import glob
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests
import yaml

AGENT_VERSION = "1.12.1"
HERE = os.path.dirname(os.path.abspath(__file__))

# Timezone applied to timezone-NAIVE timestamps parsed from LH2 (epoch values are
# already absolute/UTC). Defaults to UTC so behavior is unchanged unless a notebook
# sets `local_timezone` (an IANA name, e.g. "Europe/Kyiv") in its config; LH2 writes
# some columns in local wall-clock time, and treating those as UTC shifts them.
LOCAL_TZ = dt.timezone.utc


def set_local_tz(cfg):
    """Set LOCAL_TZ from cfg['local_timezone'] (IANA name). UTC on any problem."""
    global LOCAL_TZ
    name = cfg.get("local_timezone")
    if not name:
        LOCAL_TZ = dt.timezone.utc
        return
    try:
        LOCAL_TZ = ZoneInfo(str(name))
    except (ZoneInfoNotFoundError, ValueError):
        print(f"local_timezone {name!r} not found — using UTC for naive timestamps")
        LOCAL_TZ = dt.timezone.utc

LH2_DEFAULT_DIRS = [
    "~/Library/Application Support/Linked Helper 2",   # macOS (older builds)
    "~/Library/Application Support/linked-helper",      # macOS (current builds)
    os.path.join(os.environ.get("APPDATA", ""), "Linked Helper 2"),  # Windows (older)
    os.path.join(os.environ.get("APPDATA", ""), "linked-helper"),    # Windows (current)
    "~/.config/Linked Helper 2",                        # Linux (older)
    "~/.config/linked-helper",                          # Linux (current)
]


# ---------------------------------------------------------------- helpers

def load_config():
    path = os.path.join(HERE, "config.yaml")
    if not os.path.exists(path):
        sys.exit("config.yaml not found — copy config.example.yaml and edit it.")
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    for key in ("supabase_url", "supabase_service_key", "instance_id"):
        if not cfg.get(key):
            sys.exit(f"config.yaml is missing required key: {key}")
    return cfg


class Supabase:
    def __init__(self, cfg):
        self.base = cfg["supabase_url"].rstrip("/") + "/rest/v1"
        self.headers = {
            "apikey": cfg["supabase_service_key"],
            "Authorization": f"Bearer {cfg['supabase_service_key']}",
            "Content-Type": "application/json",
        }

    def _request(self, method, url, retriable=True, **kwargs):
        """Issue one PostgREST request with bounded retry, then raise_for_status.

        A scheduled sync shouldn't fail on a momentary network/Supabase blip, so
        transient failures are retried up to 3 attempts with backoff (~2s then
        ~8s): connection errors/timeouts and 429/5xx responses. Everything else —
        a 4xx other than 429 — raises immediately, since retrying a malformed or
        rejected request never helps and would just delay a real error. Callers
        need not raise_for_status themselves; this does it for them.

        retriable=False disables the retry loop (single attempt) for a NON-idempotent
        write, where a Timeout after the server committed would otherwise duplicate
        the row on retry — the caller must own that risk explicitly."""
        kwargs.setdefault("timeout", 30)
        backoffs = (2, 8) if retriable else ()  # () -> single attempt, no retry
        for attempt in range(len(backoffs) + 1):
            try:
                r = requests.request(method, url, **kwargs)
            except (requests.exceptions.ConnectionError,
                    requests.exceptions.Timeout) as e:
                if attempt == len(backoffs):
                    raise
                wait = backoffs[attempt]
                print(f"supabase {method} {url.rsplit('/', 1)[-1]}: "
                      f"{type(e).__name__} (attempt {attempt + 1}/"
                      f"{len(backoffs) + 1}) — retrying in {wait}s")
                time.sleep(wait)
                continue
            # Retry throttling (429) and server errors (5xx); a 4xx like 400/409
            # is a client problem the retry can't fix, so fall through and raise.
            if (r.status_code == 429 or r.status_code >= 500) \
                    and attempt < len(backoffs):
                wait = backoffs[attempt]
                print(f"supabase {method} {url.rsplit('/', 1)[-1]}: "
                      f"HTTP {r.status_code} (attempt {attempt + 1}/"
                      f"{len(backoffs) + 1}) — retrying in {wait}s")
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r

    def upsert(self, table, rows, on_conflict=None):
        """Idempotent batch upsert. Returns number of rows sent."""
        if not rows:
            return 0
        params = {"on_conflict": on_conflict} if on_conflict else {}
        headers = dict(self.headers,
                       Prefer="resolution=merge-duplicates,return=minimal")
        for i in range(0, len(rows), 500):
            self._request("POST", f"{self.base}/{table}", params=params,
                          headers=headers, data=json.dumps(rows[i:i + 500]),
                          timeout=60)
        return len(rows)

    def insert(self, table, row, retriable=True):
        headers = dict(self.headers, Prefer="return=representation")
        r = self._request("POST", f"{self.base}/{table}", retriable=retriable,
                          headers=headers, data=json.dumps(row), timeout=60)
        return r.json()[0]

    def update(self, table, match, patch):
        params = {k: f"eq.{v}" for k, v in match.items()}
        self._request("PATCH", f"{self.base}/{table}", params=params,
                      headers=self.headers, data=json.dumps(patch),
                      timeout=60)


def self_update(cfg):
    """Pull the latest agent.py from the private 'agent' storage bucket and
    swap ourselves out (deployed there by sync-agent/deploy.sh). Returns True
    when a new build was installed and the caller should re-exec. Any failure
    just means we keep running the current version — updates must never
    break the scheduled sync."""
    if not cfg.get("auto_update", True):
        return False
    if os.environ.get("LH2_AGENT_REEXEC"):  # already updated during this run
        return False
    url = cfg["supabase_url"].rstrip("/") + "/storage/v1/object/agent/agent.py"
    headers = {"apikey": cfg["supabase_service_key"],
               "Authorization": f"Bearer {cfg['supabase_service_key']}"}
    try:
        r = requests.get(url, headers=headers, timeout=30)
        if r.status_code in (400, 404):
            return False  # nothing deployed yet
        r.raise_for_status()
        new = r.content
    except requests.RequestException as e:
        print(f"self-update check failed ({e}) — continuing with v{AGENT_VERSION}")
        return False
    # Integrity gate: a truncated/corrupt download must NEVER overwrite a working
    # agent (that would brick the notebook's scheduled sync). Verify the transfer
    # completed and the bytes are a plausible, parseable agent before swapping.
    clen = r.headers.get("Content-Length")
    if clen is not None and clen.isdigit() and int(clen) != len(new):
        print(f"self-update: truncated download ({len(new)}/{clen} bytes) — skipping")
        return False
    me = os.path.abspath(__file__)
    with open(me, "rb") as f:
        current = f.read()
    if hashlib.sha256(current).digest() == hashlib.sha256(new).digest():
        return False
    if b'AGENT_VERSION = "' not in new:
        print("self-update: downloaded file doesn't look like agent.py — skipping")
        return False
    if len(new) < len(current) // 2:
        print(f"self-update: download suspiciously small ({len(new)} bytes) — skipping")
        return False
    try:
        compile(new, me, "exec")  # reject a syntactically broken build
    except (SyntaxError, ValueError) as e:
        print(f"self-update: downloaded agent does not parse ({e}) — skipping")
        return False
    tmp = me + ".new"
    with open(tmp, "wb") as f:
        f.write(new)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, me)  # atomic swap once we've validated the bytes
    print(f"self-update: installed new agent build (was v{AGENT_VERSION}), restarting")
    return True


def reexec():
    """Re-run the same command under the freshly installed agent.py."""
    env = dict(os.environ, LH2_AGENT_REEXEC="1")
    sys.exit(subprocess.call([sys.executable] + sys.argv, env=env))


# Keys that may be overridden online from the dashboard's Health page (stored in
# instances.config and merged over the local config.yaml on every sync). The
# bootstrap keys — supabase_url, supabase_service_key, instance_id — are
# deliberately absent: they're needed locally just to connect/identify, so a
# remote blob can never change where the agent points or who it claims to be.
REMOTE_CONFIG_KEYS = {
    "instance_label",
    "account_name", "account_url", "account_avatar",
    "auto_update", "sync_steps", "sync_messages", "sync_photos",
    "lh2_db_path", "mapping", "local_timezone",
    "notify_url", "exclude_campaigns",
}


def fetch_remote_config(cfg):
    """Pull this instance's overrides from the instances.config blob in Supabase
    (edited on the Health page). Returns a dict, or {} on any failure — like
    self_update, a config-fetch problem must never break a scheduled sync."""
    url = cfg["supabase_url"].rstrip("/") + "/rest/v1/instances"
    headers = {"apikey": cfg["supabase_service_key"],
               "Authorization": f"Bearer {cfg['supabase_service_key']}"}
    params = {"id": f"eq.{cfg['instance_id']}", "select": "config", "limit": 1}
    try:
        r = requests.get(url, headers=headers, params=params, timeout=30)
        r.raise_for_status()
        rows = r.json()
    except (requests.RequestException, ValueError) as e:
        print(f"remote-config fetch failed ({e}) — using local config.yaml only")
        return {}
    remote = rows[0].get("config") if rows else None
    return remote if isinstance(remote, dict) else {}


def apply_remote_config(cfg):
    """Merge the remote overrides (instances.config) over the local config.yaml so
    settings can be changed online. Remote wins; only allowlisted keys are honored
    (bootstrap keys are ignored); `mapping` is merged one level deep so a remote
    override of one section doesn't drop the others. A local
    `ignore_remote_config: true` opts out entirely — the escape hatch to recover a
    notebook if a bad remote value breaks its sync."""
    if cfg.get("ignore_remote_config"):
        return cfg
    remote = fetch_remote_config(cfg)
    applied = []
    for key in REMOTE_CONFIG_KEYS:
        if key not in remote:
            continue
        val = remote[key]
        if key == "mapping":
            if not isinstance(val, dict):
                continue  # ignore a malformed mapping override, keep the local one
            base = cfg["mapping"] if isinstance(cfg.get("mapping"), dict) else {}
            cfg["mapping"] = dict(base, **val)
        else:
            cfg[key] = val
        applied.append(key)
    if applied:
        print(f"remote-config: applied online overrides for {', '.join(sorted(applied))}")
    return cfg


def notify_new_replies(cfg):
    """Fire-and-forget ping to the dashboard's /api/notify-replies after a
    successful push, so a new inbound reply reaches Slack within one sync cycle
    instead of waiting for the daily cron sweep. The endpoint is open and
    self-limiting (claims unnotified rows atomically, capped batch) — see
    frontend/api/notify-replies.ts. Pings unconditionally when notify_url is
    set: the no-work case is a cheap no-op, and gating on "messages extracted"
    would strand backlog left by a previously failed ping. ANY failure is
    swallowed — a notification problem must never break a sync; the next ping
    (from any notebook) or the daily sweep retries the backlog."""
    url = (cfg.get("notify_url") or "").strip()
    if not url:
        return
    try:
        # instance_id is informational only (shows who pinged in the Vercel
        # logs) — the endpoint drains ALL instances' backlog regardless.
        r = requests.post(url, json={"instance_id": cfg["instance_id"]}, timeout=15)
        print(f"notify-replies: HTTP {r.status_code} {r.text[:200]}")
    except Exception as e:
        print(f"notify-replies ping failed ({e}) — will retry after next sync")


# Per-run cap on photo uploads so the initial backfill (potentially thousands of
# leads) spreads over several scheduled syncs instead of hammering one run.
PHOTO_CAP = 200


def sync_photos(cfg, sb, avatar_map):
    """Mirror each lead's LinkedIn avatar into the public `lead-photos` Storage
    bucket for UI display — display-only, NEVER used for any inference. Runs after
    the leads push, only when config `sync_photos` is truthy. Like
    notify_new_replies, EVERY exception is swallowed here: a photo problem must
    never break a scheduled sync.

    Signed licdn URLs expire within weeks, so we download the bytes at sync time
    from the fresh DB read (`avatar_map`) rather than storing a soon-dead URL.
    Per candidate (this instance's leads with photo_synced_at IS NULL, capped at
    PHOTO_CAP):
      - no local avatar URL, or HTTP 403/404 (expired/dead) -> stamp photo_synced_at
        and leave photo_path NULL, so the job converges (a future --refresh-photos
        flag can re-attempt);
      - timeout / connection error / 5xx / upload failure -> leave the lead
        UNTOUCHED so the next run retries it; counted as retryable;
      - success -> upload the bytes, then PATCH photo_path + photo_synced_at.
    """
    try:
        instance_id = cfg["instance_id"]
        base = cfg["supabase_url"].rstrip("/")
        service_key = cfg["supabase_service_key"]
        auth = {"apikey": service_key,
                "Authorization": f"Bearer {service_key}"}

        # Candidates: unsynced leads for THIS instance. The leads unique key is
        # (campaign_id, profile_url) — both selected for the later PATCH; profile_url
        # also yields the slug. Capped so the backfill spreads over several runs.
        # STABLE ORDER (newest added_at first, as classify.ts orders): together with
        # converging on any permanent error below, this stops a stuck set from
        # pinning the same PHOTO_CAP window every run and starving the backfill.
        try:
            r = requests.get(
                f"{base}/rest/v1/leads", headers=auth,
                params={"instance_id": f"eq.{instance_id}",
                        "photo_synced_at": "is.null",
                        "select": "campaign_id,profile_url",
                        "order": "added_at.desc",
                        "limit": PHOTO_CAP},
                timeout=30)
            r.raise_for_status()
            candidates = r.json()
        except (requests.RequestException, ValueError) as e:
            print(f"photo sync: candidate fetch failed ({e}) — skipping this run")
            return

        now = dt.datetime.now(dt.timezone.utc).isoformat()
        uploaded = no_avatar = retryable = 0
        for cand in candidates:
            cid = cand.get("campaign_id")
            purl = cand.get("profile_url")
            if not cid or not purl:
                continue
            match = {"campaign_id": cid, "profile_url": purl}
            raw_slug = slug_from_profile_url(purl)
            sanitized = sanitize_slug(raw_slug)
            avatar_url = avatar_map.get(raw_slug)

            # Converge quietly (mark synced, leave photo_path NULL) when there is no
            # avatar on file, OR the slug sanitizes to empty (a malformed profile_url
            # would otherwise collapse every such lead onto "{instance_id}/.jpg") —
            # never upload in either case.
            if not avatar_url or not sanitized:
                try:
                    sb.update("leads", match, {"photo_synced_at": now})
                    no_avatar += 1
                except Exception:
                    retryable += 1
                continue

            try:
                resp = requests.get(avatar_url, timeout=10)
            except requests.RequestException:
                retryable += 1  # transient — retry next run, lead untouched
                continue

            if 400 <= resp.status_code < 500:
                # ANY 4xx is permanent (expired/forbidden/gone signed URL, auth) ->
                # converge (mark synced, no photo) so it can never pin a backfill slot.
                try:
                    sb.update("leads", match, {"photo_synced_at": now})
                    no_avatar += 1
                except Exception:
                    retryable += 1
                continue
            if resp.status_code != 200 or not resp.content:
                retryable += 1  # 5xx / unexpected — retry next run, lead untouched
                continue

            ctype = resp.headers.get("content-type", "")
            if not ctype.startswith("image/"):
                ctype = "image/jpeg"
            path = f"{instance_id}/{sanitized}.jpg"
            try:
                up = requests.post(
                    f"{base}/storage/v1/object/lead-photos/{path}",
                    headers=dict(auth, **{"x-upsert": "true",
                                          "content-type": ctype}),
                    data=resp.content, timeout=30)
                up.raise_for_status()
            except requests.RequestException:
                retryable += 1  # upload failed — retry next run, lead untouched
                continue

            try:
                sb.update("leads", match,
                          {"photo_path": path, "photo_synced_at": now})
                uploaded += 1
            except Exception:
                retryable += 1  # storage has the object; PATCH retries next run

        print(f"photo sync: {uploaded} uploaded, {no_avatar} no-avatar, "
              f"{retryable} retryable (of {len(candidates)} candidates)")
    except Exception as e:
        print(f"photo sync failed ({e}) — will retry after next sync")


def content_hash(body):
    """Stable disambiguator for a message body. Two genuinely different messages
    that happen to share one action-run timestamp (CheckForReplies records a whole
    thread at one created_at) must not collide on the messages unique key — the hash
    of the body distinguishes them. NULL/empty bodies hash to a fixed value."""
    return hashlib.md5((body or "").encode("utf-8")).hexdigest()


def iso(value):
    """Best-effort timestamp normalization (epoch ms/s, ISO, common formats)."""
    if value in (None, "", 0, "0"):
        return None
    if isinstance(value, (int, float)):
        sec = value / 1000 if value > 1e11 else value
        return dt.datetime.fromtimestamp(sec, dt.timezone.utc).isoformat()
    s = str(value).strip()
    if s.isdigit():
        return iso(int(s))
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z",
                "%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%m/%d/%Y %H:%M",
                "%m/%d/%Y", "%d.%m.%Y %H:%M", "%d.%m.%Y"):
        try:
            d = dt.datetime.strptime(s, fmt)
            if d.tzinfo is None:
                # Naive wall-clock time from LH2 — interpret in the configured local
                # timezone (UTC by default) and normalize to UTC.
                d = d.replace(tzinfo=LOCAL_TZ).astimezone(dt.timezone.utc)
            return d.isoformat()
        except ValueError:
            continue
    return None


LINKEDIN_IN_PREFIX = "https://www.linkedin.com/in/"


def slug_from_profile_url(url):
    """Invert the leads mapping's profile_url = LINKEDIN_IN_PREFIX || external_id to
    recover the deduped slug (external_id). Tolerates other LinkedIn URL shapes and a
    trailing slash. The recovered slug matches the avatar map's keys, and — once
    sanitized — the stored photo_path, so a photo always joins back to its lead."""
    s = (url or "").strip()
    if s.startswith(LINKEDIN_IN_PREFIX):
        s = s[len(LINKEDIN_IN_PREFIX):]
    else:
        m = re.search(r"/in/([^/?#]+)", s)
        if m:
            s = m.group(1)
    return s.strip("/")


def sanitize_slug(slug):
    """Reduce a slug to a Storage-path-safe [A-Za-z0-9_-] token (percent-decode
    first so an encoded name collapses to its readable form, then replace anything
    else with '_'). Deterministic, so photo_path always matches the uploaded key."""
    decoded = urllib.parse.unquote(slug or "")
    return re.sub(r"[^A-Za-z0-9_-]", "_", decoded)


# ---------------------------------------------------------------- inspect

def cmd_inspect(args):
    roots = [args.path] if args.path else LH2_DEFAULT_DIRS
    found_any = False
    for root in roots:
        root = os.path.expanduser(root)
        if not root or not os.path.isdir(root):
            continue
        print(f"\n== {root}")
        patterns = ["**/*.db", "**/*.sqlite", "**/*.sqlite3"]
        files = sorted({p for pat in patterns
                        for p in glob.glob(os.path.join(root, pat), recursive=True)})
        if not files:
            print("   no SQLite files found (LH2 may store this instance's data "
                  "in LevelDB — use the CSV export path instead)")
            continue
        for path in files:
            found_any = True
            print(f"\n-- {path}")
            try:
                con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                cur = con.execute(
                    "select name from sqlite_master where type='table' order by name")
                for (table,) in cur.fetchall():
                    cols = [c[1] for c in con.execute(f'pragma table_info("{table}")')]
                    n = con.execute(f'select count(*) from "{table}"').fetchone()[0]
                    print(f"   {table} ({n} rows): {', '.join(cols)}")
                con.close()
            except sqlite3.Error as e:
                print(f"   unreadable: {e}")
    if not found_any:
        print("\nNo SQLite databases discovered. Point me at the instance folder "
              "with --path, or rely on `ingest-csv` with LH2's CSV exports.")


# ---------------------------------------------------------------- sync (sqlite)

def row_get(row, colmap, key):
    col = colmap.get(key)
    return row[col] if col and col in row.keys() else None


def rows_for(con, section):
    """Yield rows for a mapping section: raw `query:` (JOINs across LH2's
    normalized tables) or simple `table:`. Column keys in the mapping refer
    to the query's result aliases."""
    if section.get("query"):
        return con.execute(section["query"])
    return con.execute(f'select * from "{section["table"]}"')


def discover_db_path():
    """Locate the active LH2 account database when lh2_db_path isn't set.
    A machine can hold several accounts; the active one is the most
    recently written."""
    candidates = []
    for root in LH2_DEFAULT_DIRS:
        root = os.path.expanduser(root)
        if root and os.path.isdir(root):
            candidates += glob.glob(
                os.path.join(root, "**", "linked-helper-account-*-main", "lh.db"),
                recursive=True)
    if not candidates:
        raise RuntimeError(
            "no LH2 database found automatically — run `agent.py inspect` "
            "and set lh2_db_path in config.yaml, or use ingest-csv.")
    candidates.sort(key=os.path.getmtime, reverse=True)
    if len(candidates) > 1:
        print("WARNING: multiple LH2 account DBs found; guessing the most recently "
              "modified one. If this is the wrong account, set lh2_db_path in "
              "config.yaml (or on the Health page) to pin it explicitly:")
        for p in candidates:
            print(f"  {'->' if p == candidates[0] else '  '} {p}")
    return candidates[0]


def note_warning(warnings, section, exc):
    """Record a swallowed per-section extraction failure so a schema-drift error
    that fails safe to empty (message/step/owner extraction) is still VISIBLE.
    Each caller keeps its own fail-safe-to-empty behavior AND its own print; this
    only appends a compact "section: ExceptionType: message" line to the shared
    list so cmd_sync can flag the run 'partial' instead of a falsely-green 'ok'
    (the worst failure mode: the Replies feed silently empties while the dashboard
    stays green). No-op when warnings is None (paths without run-status tracking)."""
    if warnings is not None:
        warnings.append(f"{section}: {type(exc).__name__}: {exc}")


def extract_owner(cfg, con, warnings=None):
    """LinkedIn identity of the account this instance runs as. Manual config
    values (account_name / account_url / account_avatar) win; an optional
    mapping.owner query fills the rest from lh.db — preferable for the
    avatar, because LinkedIn media URLs are signed and expire, while the DB
    copy refreshes on every sync."""
    owner = {
        "account_name": cfg.get("account_name"),
        "account_url": cfg.get("account_url"),
        "account_avatar": cfg.get("account_avatar"),
    }
    omap = (cfg.get("mapping") or {}).get("owner") or {}
    if con is not None and (omap.get("query") or omap.get("table")):
        try:
            row = next(iter(rows_for(con, omap)), None)
        except sqlite3.Error as e:
            note_warning(warnings, "owner", e)
            print(f"owner mapping failed ({e}) — continuing without it")
            row = None
        if row is not None:
            for key, alias in (("account_name", "name"),
                               ("account_url", "profile_url"),
                               ("account_avatar", "avatar_url")):
                if not owner[key]:
                    owner[key] = row_get(row, omap, alias)
    return {k: v for k, v in owner.items() if v}


# Campaign message-sequence extraction. These queries are specific to the LH2
# schema verified on the notebooks (campaigns -> campaign_versions ->
# campaign_version_actions -> actions -> action_configs; executions in
# action_result_messages). They run with no per-notebook config; if a future
# LH2 version renames tables, extract_steps fails safe and the per-step view is
# simply empty. Set `sync_steps: false` in config.yaml to opt out.

# Action types that send something a person can reply to. Everything else in
# the sequence (profile visits, post likes, follows, endorsements, ...) is a
# warm-up/auxiliary step: synced so the full sequence is visible, but replies
# are only attributed to messaging steps.
MESSAGING_TYPES = ("InvitePerson", "MessageToPerson")
# Monitor actions that run continuously rather than being a sequence position.
EXCLUDED_TYPES = ("CheckForReplies",)

# Ordered steps of each campaign's LATEST version (ALL types incl. warm-up),
# with the template AST for messaging steps.
STEP_DEFS_SQL = """
WITH latest_v AS (
  SELECT campaign_id, MAX(id) AS version_id FROM campaign_versions GROUP BY campaign_id
)
SELECT a.campaign_id            AS campaign_id,
       cva.id                   AS order_key,
       a.id                     AS action_id,
       a.name                   AS step_name,
       ac.actionType            AS step_type,
       ac.actionSettings        AS settings
FROM campaign_version_actions cva
JOIN latest_v lv ON lv.version_id = cva.version_id
JOIN actions a   ON a.id = cva.action_id
JOIN action_configs ac ON ac.id = (
  SELECT config_id FROM action_versions WHERE action_id = a.id ORDER BY id DESC LIMIT 1)
WHERE ac.actionType NOT IN ('CheckForReplies')
"""

# person_external_ids holds ~2 'public' rows per person (human-readable slug
# plus LinkedIn's opaque 'AC...' id). Joining it raw double-counts every
# person, inflating per-step aggregates ~1.6x. Dedupe to ONE slug per person,
# preferring the human-readable one (newest if several).
PEI_ONE_SLUG_SQL = """(
  SELECT person_id, external_id FROM (
    SELECT person_id, external_id,
           ROW_NUMBER() OVER (PARTITION BY person_id
             ORDER BY (external_id LIKE 'AC%'), rowid DESC) AS rn
    FROM person_external_ids
    WHERE type_group = 'public'
  ) WHERE rn = 1
)"""

# One row per outbound send (invite note or follow-up message) per person.
STEP_SENDS_SQL = f"""
SELECT 'https://www.linkedin.com/in/' || pei.external_id AS profile_url,
       a.campaign_id   AS campaign_id,
       a.id            AS action_id,
       ar.created_at   AS sent_at
FROM action_result_messages arm
JOIN action_results ar  ON ar.id = arm.action_result_id
JOIN action_versions av ON av.id = ar.action_version_id
JOIN actions a          ON a.id = av.action_id
JOIN action_configs ac  ON ac.id = av.config_id
JOIN {PEI_ONE_SLUG_SQL} pei ON pei.person_id = ar.person_id
WHERE arm.type IN ('Sent', 'Message')
  AND ac.actionType IN ('InvitePerson', 'MessageToPerson')
"""

# One row per execution of a NON-messaging action per person (profile visit,
# like, follow, ...). Messaging steps keep the stricter arm.type-filtered
# query above so their sent counts only include actual sends.
STEP_EXECUTIONS_SQL = f"""
SELECT 'https://www.linkedin.com/in/' || pei.external_id AS profile_url,
       a.campaign_id   AS campaign_id,
       a.id            AS action_id,
       ar.created_at   AS executed_at
FROM action_results ar
JOIN action_versions av ON av.id = ar.action_version_id
JOIN actions a          ON a.id = av.action_id
JOIN action_configs ac  ON ac.id = av.config_id
JOIN {PEI_ONE_SLUG_SQL} pei ON pei.person_id = ar.person_id
WHERE ac.actionType NOT IN ('InvitePerson', 'MessageToPerson', 'CheckForReplies')
"""

# Earliest follow-up message (MessageToPerson) per person — the funnel's
# first_message_at milestone (the invite note itself is an InvitePerson 'Sent',
# excluded here). Same join chain as the step queries; fails safe to empty.
FIRST_MESSAGE_SQL = f"""
SELECT 'https://www.linkedin.com/in/' || pei.external_id AS profile_url,
       MIN(ar.created_at) AS first_message_at
FROM action_result_messages arm
JOIN action_results ar  ON ar.id = arm.action_result_id
JOIN action_versions av ON av.id = ar.action_version_id
JOIN actions a          ON a.id = av.action_id
JOIN action_configs ac  ON ac.id = av.config_id
JOIN {PEI_ONE_SLUG_SQL} pei ON pei.person_id = ar.person_id
WHERE arm.type IN ('Sent', 'Message')
  AND ac.actionType = 'MessageToPerson'
GROUP BY 1
"""


# One row per inbound reply per person (CheckForReplies writes type='Replied').
STEP_REPLIES_SQL = f"""
SELECT 'https://www.linkedin.com/in/' || pei.external_id AS profile_url,
       a.campaign_id   AS campaign_id,
       ar.created_at   AS replied_at
FROM action_result_messages arm
JOIN action_results ar  ON ar.id = arm.action_result_id
JOIN action_versions av ON av.id = ar.action_version_id
JOIN actions a          ON a.id = av.action_id
JOIN {PEI_ONE_SLUG_SQL} pei ON pei.person_id = ar.person_id
WHERE arm.type = 'Replied'
"""

# Full conversation thread, both directions: outbound sends (the invite note and
# follow-up messages we sent) and inbound replies. Same proven join chain as the
# step queries above, so it ships in agent.py and rolls out via deploy.sh — no
# per-notebook config. The body is NOT on action_result_messages itself: that
# table only holds a message_id FK, and the text lives in the separate `messages`
# table (m.message_text) — verified against a real lh.db (account 524650: 2,488
# outbound + 683 inbound, all with body text). campaign_id comes from the action
# (correct attribution), not person_in_campaigns_history. Override per-notebook
# with mapping.messages only for a non-standard schema; disable with
# sync_messages:false.
#
# DEDUP: `sent_at` is ar.created_at (when the action RAN, not the true message
# time). CheckForReplies re-records the whole thread on every run, so one real
# message yields one action_result_messages row per run — each with a different
# created_at. Without dedup the same message shows up N times in the conversation
# view (and the unique constraint can't catch it, since sent_at differs). The
# ROW_NUMBER() window keeps the EARLIEST observation per logical message: stable
# across syncs (runs are only appended), so the upsert stays idempotent. Dedup is
# by (person, direction, body) so it works regardless of whether LH reuses
# messages.id across snapshots; NULL bodies fall back to message_id so genuinely
# distinct empty-body sends aren't collapsed. If you confirm messages.id is reused
# per logical message (see the inspect query in the repo plan), PARTITION BY
# arm.message_id is more precise (never merges two distinct same-text messages).
MESSAGES_SQL = f"""
SELECT profile_url, campaign_id, body, sent_at, direction FROM (
  SELECT 'https://www.linkedin.com/in/' || pei.external_id AS profile_url,
         a.campaign_id   AS campaign_id,
         m.message_text  AS body,
         ar.created_at   AS sent_at,
         CASE WHEN arm.type = 'Replied' THEN 'in' ELSE 'out' END AS direction,
         ROW_NUMBER() OVER (
           PARTITION BY pei.external_id,
                        CASE WHEN arm.type = 'Replied' THEN 'in' ELSE 'out' END,
                        COALESCE(m.message_text, 'arm:' || arm.message_id)
           ORDER BY ar.created_at ASC
         ) AS rn
  FROM action_result_messages arm
  JOIN messages m         ON m.id = arm.message_id
  JOIN action_results ar  ON ar.id = arm.action_result_id
  JOIN action_versions av ON av.id = ar.action_version_id
  JOIN actions a          ON a.id = av.action_id
  JOIN {PEI_ONE_SLUG_SQL} pei ON pei.person_id = ar.person_id
  WHERE arm.type IN ('Sent', 'Message', 'Replied')
) WHERE rn = 1
"""


# ------------------------ demographics signals + avatar source ---------------
# All three below reuse the SAME one-slug-per-person dedup as leads, so their
# results key on the SAME slug-format profile_url (years) / slug (avatars) — and
# all fail safe to EMPTY on schema drift (a build missing these tables just syncs
# with no years/photos). Never wired to note_warning: these are new best-effort
# extractions, so a notebook that lacks the tables must NOT read as 'partial'.

# Per-person EARLIEST education start year and EARLIEST first-job start year, for
# deterministic birth-year inference downstream. Implausible placeholder years
# (LH2 stores 1900/1970, and future-dated typos) are rejected IN SQL — before the
# MIN, so a garbage row can't drag the minimum down. The upper bound (current
# year) is a bound query parameter. A per-notebook mapping.education_year /
# mapping.first_job_year `query:` overrides these for a non-standard LH2 layout
# (alias profile_url + start_year); the plausibility window is re-checked in
# Python either way. `?` is the max-year bound.
EDU_YEAR_SQL = f"""
SELECT 'https://www.linkedin.com/in/' || pei.external_id AS profile_url,
       MIN(pe.start_year) AS start_year
FROM person_education pe
JOIN {PEI_ONE_SLUG_SQL} pei ON pei.person_id = pe.person_id
WHERE pe.start_year >= 1950 AND pe.start_year <= ?
GROUP BY 1
"""

JOB_YEAR_SQL = f"""
SELECT 'https://www.linkedin.com/in/' || pei.external_id AS profile_url,
       MIN(pp.start_year) AS start_year
FROM person_positions pp
JOIN {PEI_ONE_SLUG_SQL} pei ON pei.person_id = pp.person_id
WHERE pp.start_year >= 1950 AND pp.start_year <= ?
GROUP BY 1
"""

# Best avatar URL per deduped slug: prefer the 800x800
# person_original_mini_profile.avatar, fall back to the 100x100
# person_mini_profile.avatar. LEFT JOINs tolerate a person with no mini-profile
# row (NULL avatar). Signed licdn URLs expire within weeks, so the photo step
# downloads the bytes at sync time from this fresh DB read.
AVATAR_SQL = f"""
SELECT pei.external_id AS slug,
       COALESCE(NULLIF(pomp.avatar, ''), NULLIF(pmp.avatar, '')) AS avatar_url
FROM {PEI_ONE_SLUG_SQL} pei
LEFT JOIN person_original_mini_profile pomp ON pomp.person_id = pei.person_id
LEFT JOIN person_mini_profile pmp ON pmp.person_id = pei.person_id
"""


def flatten_template(settings):
    """Flatten LH2's action_configs.actionSettings JSON into readable text.
    The message lives at messageTemplate.variants[0].child as a tree of nodes:
    text (literal), var (a {{placeholder}}), group (concatenated children)."""
    if not settings:
        return None
    try:
        data = json.loads(settings) if isinstance(settings, str) else settings
    except (ValueError, TypeError):
        return None
    variants = (((data or {}).get("messageTemplate") or {}).get("variants")) or []
    if not variants:
        return None

    def walk(node):
        if not isinstance(node, dict):
            return ""
        t = node.get("type")
        if t == "text":
            return node.get("value") or ""
        if t == "var":
            return "{{" + (node.get("name") or "var") + "}}"
        if node.get("child") is not None:
            return walk(node["child"])
        return "".join(walk(k) for k in (node.get("children") or []))

    text = walk(variants[0].get("child") or variants[0]).strip()
    return text[:4000] or None


def extract_steps(con, instance_id, warnings=None):
    """Per-(campaign, step) aggregates over the FULL sequence — warm-up steps
    (visits, likes, follows, ...) included, so 'where is everyone stuck' is
    answerable before the invite step. Reply attribution and current-step are
    computed here over each person's timeline — clearer than SQL window
    joins. Fails safe to []."""
    try:
        defs = list(con.execute(STEP_DEFS_SQL))
        sends = list(con.execute(STEP_SENDS_SQL))
        replies = list(con.execute(STEP_REPLIES_SQL))
    except sqlite3.Error as e:
        note_warning(warnings, "steps", e)
        print(f"step extraction skipped ({e}) — per-step view will be empty")
        return []
    try:
        executions = list(con.execute(STEP_EXECUTIONS_SQL))
    except sqlite3.Error as e:  # warm-up counts are additive; don't lose messaging steps
        note_warning(warnings, "steps.warmup", e)
        print(f"warm-up execution extraction skipped ({e})")
        executions = []

    # Order each campaign's steps by their position in the sequence and assign a
    # 0-based step_index; map (campaign, action) -> step_index for the sends.
    by_campaign = {}
    for r in defs:
        by_campaign.setdefault(str(r["campaign_id"]), []).append(r)
    step_meta = {}    # (lh_cid, step_index) -> {step_label, step_type, template_body}
    action_step = {}  # (lh_cid, action_id)  -> step_index
    for lh_cid, rows in by_campaign.items():
        rows.sort(key=lambda r: r["order_key"])
        for idx, r in enumerate(rows):
            action_step[(lh_cid, str(r["action_id"]))] = idx
            step_meta[(lh_cid, idx)] = {
                "step_label": r["step_name"],
                "step_type": r["step_type"],
                "template_body": flatten_template(r["settings"]),
            }

    # Steps a reply can be attributed to (messaging only — a profile visit or
    # like can't be "replied to").
    messaging_steps = {
        (lh_cid, idx) for (lh_cid, idx), meta in step_meta.items()
        if meta["step_type"] in MESSAGING_TYPES
    }

    # Per-person step timeline: message sends plus warm-up executions (drop
    # rows whose action was removed from the latest sequence — they have no
    # step to attribute to).
    timeline = {}  # (lh_cid, profile) -> [(ts_iso, step_index)]
    for rows, ts_col in ((sends, "sent_at"), (executions, "executed_at")):
        for r in rows:
            lh_cid = str(r["campaign_id"])
            sidx = action_step.get((lh_cid, str(r["action_id"])))
            ts = iso(r[ts_col])
            if sidx is None or not ts:
                continue
            timeline.setdefault((lh_cid, r["profile_url"]), []).append((ts, sidx))

    # Per-person earliest reply.
    first_reply = {}  # (lh_cid, profile) -> earliest replied_at iso
    for r in replies:
        ts = iso(r["replied_at"])
        if not ts:
            continue
        key = (str(r["campaign_id"]), r["profile_url"])
        if key not in first_reply or ts < first_reply[key]:
            first_reply[key] = ts

    sent_n, replied_n, current_n = {}, {}, {}
    for (lh_cid, profile), events in timeline.items():
        events.sort()
        for step in {s for _, s in events}:               # received this step
            sent_n[(lh_cid, step)] = sent_n.get((lh_cid, step), 0) + 1
        furthest = max(s for _, s in events)              # where they are now
        current_n[(lh_cid, furthest)] = current_n.get((lh_cid, furthest), 0) + 1
        rep = first_reply.get((lh_cid, profile))          # attribute first reply
        msg_events = [(ts, s) for ts, s in events if (lh_cid, s) in messaging_steps]
        if rep and msg_events:
            # Attribute to the latest messaging step sent at/before the reply. If the
            # reply predates every send (clock skew / data anomaly), attribute to
            # none — counting it against a step whose message went out later would
            # inflate that step's reply rate for a message that can't have caused it.
            attributed = None
            for ts, step in msg_events:
                if ts <= rep:
                    attributed = step
                else:
                    break
            if attributed is not None:
                replied_n[(lh_cid, attributed)] = replied_n.get((lh_cid, attributed), 0) + 1

    now = dt.datetime.now(dt.timezone.utc).isoformat()
    out = []
    for (lh_cid, idx), meta in sorted(step_meta.items()):
        out.append({
            "campaign_id": f"{instance_id}:{lh_cid}",
            "step_index": idx,
            "step_label": meta["step_label"],
            "step_type": meta["step_type"],
            "template_body": meta["template_body"],
            "sent_count": sent_n.get((lh_cid, idx), 0),
            "replied_count": replied_n.get((lh_cid, idx), 0),
            "current_count": current_n.get((lh_cid, idx), 0),
            "updated_at": now,
        })
    return out


def extract_messages(con, instance_id):
    """Full conversation threads (both directions) via the built-in MESSAGES_SQL.
    No config needed; mirrors the dict shape the mapping path produces."""
    out = []
    for row in con.execute(MESSAGES_SQL):
        profile = row["profile_url"]
        sent_at = iso(row["sent_at"])
        if not profile or not sent_at:
            continue
        body = row["body"]
        body = str(body)[:2000] if body else None
        lh_cid = row["campaign_id"]
        out.append({
            "instance_id": instance_id,
            "campaign_id": f"{instance_id}:{lh_cid}" if lh_cid is not None else None,
            "profile_url": str(profile),
            "direction": str(row["direction"] or "in"),
            "body": body,
            "sent_at": sent_at,
            "content_hash": content_hash(body),
        })
    return out


def extract_first_messages(con, warnings=None):
    """Map profile_url -> first_message_at (earliest MessageToPerson send). Built-in
    schema only; fails safe to {} so a schema change never breaks the sync."""
    out = {}
    try:
        for row in con.execute(FIRST_MESSAGE_SQL):
            ts = iso(row["first_message_at"])
            if row["profile_url"] and ts:
                out[row["profile_url"]] = ts
    except sqlite3.Error as e:
        note_warning(warnings, "first_message", e)
        print(f"first-message extraction skipped ({e}) — first_message_at will be empty")
    return out


def _year_map(con, section, builtin_sql, max_year, label):
    """Build {profile_url -> earliest plausible start_year} for one age signal.

    Uses a per-notebook mapping override (a `query:`/`table:` section aliasing
    profile_url + start_year, defaulting to those column names) when present, else
    the built-in SQL with the current-year bound. Plausibility (1950..max_year) is
    enforced in SQL for the built-in and re-checked here so an override can't smuggle
    a 1900/1970 placeholder through. Keeps the MIN plausible year per profile. Fails
    safe to {} on any schema drift (print-only, never note_warning) — the sync then
    proceeds with no year for this signal."""
    out = {}
    try:
        if section and (section.get("query") or section.get("table")):
            cursor = rows_for(con, section)
            p_col = section.get("profile_url", "profile_url")
            y_col = section.get("start_year", "start_year")
            override = True
        else:
            cursor = con.execute(builtin_sql, (max_year,))
            p_col = y_col = None
            override = False
        for row in cursor:
            if override:
                keys = row.keys()
                profile = row[p_col] if p_col in keys else None
                year = row[y_col] if y_col in keys else None
            else:
                profile = row["profile_url"]
                year = row["start_year"]
            if not profile or year is None:
                continue
            try:
                y = int(year)
            except (ValueError, TypeError):
                continue
            if y < 1950 or y > max_year:
                continue
            cur = out.get(profile)
            if cur is None or y < cur:
                out[profile] = y
    except sqlite3.Error as e:
        print(f"{label} extraction skipped ({e}) — {label} will be empty")
        return {}
    return out


def extract_demographic_years(cfg, con):
    """Per-lead earliest education / first-job start years for age inference, keyed
    by the same slug-format profile_url the leads extraction produces (so they merge
    by profile_url). Each signal fails safe to {} independently."""
    mapping = cfg.get("mapping") or {}
    max_year = dt.datetime.now(dt.timezone.utc).year
    edu = _year_map(con, mapping.get("education_year"), EDU_YEAR_SQL, max_year,
                    "education_year")
    job = _year_map(con, mapping.get("first_job_year"), JOB_YEAR_SQL, max_year,
                    "first_job_year")
    return edu, job


def build_avatar_map(con):
    """{deduped slug (external_id) -> best avatar URL}. Prefers the 800x800
    person_original_mini_profile.avatar, falls back to the 100x100
    person_mini_profile.avatar. Fails safe to {} on schema drift (print-only) — the
    photo step then finds no avatars and converges quietly."""
    out = {}
    try:
        for row in con.execute(AVATAR_SQL):
            slug = row["slug"]
            url = row["avatar_url"]
            if slug and url:
                out[str(slug)] = str(url)
    except sqlite3.Error as e:
        print(f"avatar map extraction skipped ({e}) — photo sync finds no avatars")
    return out


def build_year_updates(leads, edu_map, job_map):
    """Bucket leads by which start-year signals they carry so each PostgREST upsert
    request has a UNIFORM key set (a mixed-key batch is rejected). Only non-NULL
    years are ever emitted, so a re-sync can never clobber a stored year with NULL.
    Returns (both, edu_only, job_only) — each a list of merge-duplicate rows on the
    leads (campaign_id, profile_url) unique key; the row always already exists (leads
    were just upserted) so each hits the UPDATE path and touches only these columns.

    instance_id is included even though the row already exists: PostgREST's
    merge-duplicates emits INSERT ... ON CONFLICT DO UPDATE, and Postgres validates
    the candidate insert tuple's NOT NULL constraints BEFORE routing the conflict to
    the UPDATE branch. Omitting the NOT NULL instance_id makes every batch 400 with a
    not-null violation (which is exactly what happened in agent 1.12.0). It's set to
    the lead's own instance_id, so the UPDATE branch is a no-op for that column."""
    both, edu_only, job_only = [], [], []
    for lead in leads:
        e = edu_map.get(lead["profile_url"])
        j = job_map.get(lead["profile_url"])
        base = {"instance_id": lead["instance_id"],
                "campaign_id": lead["campaign_id"],
                "profile_url": lead["profile_url"]}
        if e is not None and j is not None:
            both.append(dict(base, education_start_year=e, first_job_start_year=j))
        elif e is not None:
            edu_only.append(dict(base, education_start_year=e))
        elif j is not None:
            job_only.append(dict(base, first_job_start_year=j))
    return both, edu_only, job_only


def apply_campaign_excludes(cfg, campaigns, leads, messages, steps):
    """Drop everything belonging to LH2 campaigns listed in `exclude_campaigns`
    (LH2 campaign ids, e.g. [4]). Archiving a campaign in LH2 does NOT remove
    it (or its person_in_campaigns_history rows) from the SQLite DB, so a
    campaign deleted from Supabase gets resurrected by the next sync unless it
    is excluded here. Events need no filtering — derive_events builds them from
    the already-filtered leads. Messages with campaign_id None are kept."""
    raw = cfg.get("exclude_campaigns") or []
    if not isinstance(raw, (list, tuple)):
        raw = [raw]
    excluded = {f"{cfg['instance_id']}:{x}" for x in map(str, raw)}
    if not excluded:
        return campaigns, leads, messages, steps
    kept = ([c for c in campaigns if c["id"] not in excluded],
            [l for l in leads if l["campaign_id"] not in excluded],
            [m for m in messages if m["campaign_id"] not in excluded],
            [s for s in steps if s["campaign_id"] not in excluded])
    dropped = (len(campaigns) - len(kept[0]), len(leads) - len(kept[1]),
               len(messages) - len(kept[2]), len(steps) - len(kept[3]))
    if any(dropped):
        print(f"exclude_campaigns: dropped {dropped[0]} campaigns, "
              f"{dropped[1]} leads, {dropped[2]} messages, {dropped[3]} steps")
    return kept


def extract_local(cfg, warnings=None):
    """Read campaigns + leads (+ owner identity) from the local LH2 DB.

    `warnings` (a list, when provided) collects any per-section extraction failure
    that fails safe to empty — messages/steps/first-message/owner — so cmd_sync can
    downgrade the run to 'partial' rather than reporting a falsely-green 'ok'."""
    instance_id = cfg["instance_id"]
    mapping = cfg.get("mapping") or {}
    db_path = os.path.expanduser(cfg.get("lh2_db_path") or "") or discover_db_path()
    if not os.path.exists(db_path):
        raise RuntimeError(
            f"lh2_db_path not found: {db_path!r}. Run `agent.py inspect` "
            "and fix config.yaml, or use ingest-csv.")
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    now = dt.datetime.now(dt.timezone.utc).isoformat()

    campaigns = []
    cmap = mapping.get("campaigns", {})
    if cmap.get("table") or cmap.get("query"):
        for row in rows_for(con, cmap):
            lh_id = str(row_get(row, cmap, "id"))
            campaigns.append({
                "id": f"{instance_id}:{lh_id}",
                "instance_id": instance_id,
                "lh_campaign_id": lh_id,
                "name": row_get(row, cmap, "name") or f"Campaign {lh_id}",
                "status": str(row_get(row, cmap, "status") or "active"),
                "updated_at": now,
            })

    leads = []
    lmap = mapping.get("leads", {})
    if lmap.get("table") or lmap.get("query"):
        for row in rows_for(con, lmap):
            profile = row_get(row, lmap, "profile_url")
            lh_cid = row_get(row, lmap, "campaign_id")
            if not profile or lh_cid is None:
                continue
            leads.append({
                "instance_id": instance_id,
                "campaign_id": f"{instance_id}:{lh_cid}",
                "profile_url": str(profile),
                "full_name": row_get(row, lmap, "full_name"),
                "headline": row_get(row, lmap, "headline"),
                "company": row_get(row, lmap, "company"),
                "status": str(row_get(row, lmap, "status") or ""),
                "invited_at": iso(row_get(row, lmap, "invited_at")),
                "connected_at": iso(row_get(row, lmap, "connected_at")),
                "first_message_at": iso(row_get(row, lmap, "first_message_at")),
                "replied_at": iso(row_get(row, lmap, "replied_at")),
                "last_action_at": iso(row_get(row, lmap, "last_action_at")),
                "added_at": iso(row_get(row, lmap, "added_at")),
                "updated_at": now,
            })
    messages = []
    mmap = mapping.get("messages", {})
    if mmap.get("table") or mmap.get("query"):
        # Per-notebook override for a non-standard schema.
        for row in rows_for(con, mmap):
            profile = row_get(row, mmap, "profile_url")
            sent_at = iso(row_get(row, mmap, "sent_at"))
            if not profile or not sent_at:
                continue
            body = row_get(row, mmap, "body")
            body = str(body)[:2000] if body else None
            lh_cid = row_get(row, mmap, "campaign_id")
            messages.append({
                "instance_id": instance_id,
                "campaign_id": f"{instance_id}:{lh_cid}" if lh_cid is not None else None,
                "profile_url": str(profile),
                "direction": str(row_get(row, mmap, "direction") or "in"),
                "body": body,
                "sent_at": sent_at,
                "content_hash": content_hash(body),
            })
    elif cfg.get("sync_messages", True):
        try:
            messages = extract_messages(con, instance_id)
        except Exception as e:  # schema mismatch must never break a sync
            note_warning(warnings, "messages", e)
            print(f"message extraction skipped ({e}) — Replies feed will be empty")

    steps = []
    if cfg.get("sync_steps", True):
        try:
            steps = extract_steps(con, instance_id, warnings)
        except Exception as e:  # never let the per-step view break a sync
            note_warning(warnings, "steps", e)
            print(f"step extraction skipped ({e}) — per-step view will be empty")

    # Back-fill first_message_at (built-in schema) for any lead the mapping didn't
    # supply it for, matching on the slug-format profile_url. Best-effort: a lead
    # whose profile_url doesn't match simply keeps its NULL.
    first_msgs = extract_first_messages(con, warnings)
    if first_msgs:
        for lead in leads:
            if not lead.get("first_message_at"):
                fm = first_msgs.get(lead["profile_url"])
                if fm:
                    lead["first_message_at"] = fm

    # added_at = LH2's add_to_target_date when the mapping supplies it; else the
    # earliest milestone (same fallback as the 025 migration backfill, so mapped
    # and unmapped notebooks converge on the same values). Runs after the
    # first_message_at back-fill so the fallback sees the complete milestones.
    for lead in leads:
        if not lead.get("added_at"):
            lead["added_at"] = min(
                (t for t in (lead["invited_at"], lead["connected_at"],
                             lead["first_message_at"], lead["replied_at"],
                             lead["last_action_at"]) if t),
                default=None)

    campaigns, leads, messages, steps = apply_campaign_excludes(
        cfg, campaigns, leads, messages, steps)

    # Age-inference signals + avatar source (both new + best-effort): built here
    # while the DB is open, fail safe to empty so a notebook whose LH2 build lacks
    # these tables still syncs cleanly (and is NOT flagged 'partial' — these are
    # print-only on drift, never note_warning). Returned in `demo` for the leads
    # year-merge, the photo step, and the dry-run coverage counts.
    edu_map, job_map = extract_demographic_years(cfg, con)
    avatar_map = build_avatar_map(con)

    owner = extract_owner(cfg, con, warnings)
    con.close()
    demo = {"edu_map": edu_map, "job_map": job_map, "avatar_map": avatar_map}
    return campaigns, leads, messages, steps, owner, demo


def print_dry_run(instance_id, campaigns, leads, messages, steps, owner, demo):
    print(f"\ndry run for instance '{instance_id}' — nothing pushed\n")
    if owner:
        print("account identity: " + ", ".join(
            f"{k.removeprefix('account_')}={v}" for k, v in owner.items()) + "\n")
    header = f"{'campaign':<42}{'leads':>7}{'invited':>9}{'accepted':>10}{'replied':>9}"
    print(header)
    print("-" * len(header))
    names = {c["id"]: c["name"] for c in campaigns}
    stats = {cid: [0, 0, 0, 0] for cid in names}
    for lead in leads:
        s = stats.setdefault(lead["campaign_id"], [0, 0, 0, 0])
        s[0] += 1
        for i, field in enumerate(("invited_at", "connected_at", "replied_at"), 1):
            s[i] += 1 if lead[field] else 0
    for cid, (n, inv, acc, rep) in sorted(stats.items()):
        name = names.get(cid, cid)[:40]
        print(f"{name:<42}{n:>7}{inv:>9}{acc:>10}{rep:>9}")

    if steps:
        print("\ncampaign steps incl. warm-up (processed -> replied):")
        sh = (f"{'campaign':<24}{'#':>2} {'step':<22}"
              f"{'sent':>7}{'replied':>9}{'reply%':>8}{'now':>6}")
        print(sh)
        print("-" * len(sh))
        for s in steps:
            cname = names.get(s["campaign_id"], s["campaign_id"])[:22]
            label = (s["step_label"] or s["step_type"] or "")[:20]
            rate = f"{100 * s['replied_count'] / s['sent_count']:.1f}" if s["sent_count"] else "—"
            print(f"{cname:<24}{s['step_index']:>2} {label:<22}"
                  f"{s['sent_count']:>7}{s['replied_count']:>9}{rate:>8}{s['current_count']:>6}")

    edu_map, job_map, avatar_map = (demo["edu_map"], demo["job_map"],
                                    demo["avatar_map"])
    edu_n = sum(1 for l in leads if edu_map.get(l["profile_url"]) is not None)
    job_n = sum(1 for l in leads if job_map.get(l["profile_url"]) is not None)
    avatar_n = sum(1 for l in leads
                   if avatar_map.get(slug_from_profile_url(l["profile_url"])))
    print(f"\ndemographics: {edu_n} leads with an education start year, "
          f"{job_n} with a first-job start year "
          "(merged into leads; a NULL year is never sent).")
    print(f"photos: {avatar_n}/{len(leads)} leads have a local avatar URL "
          "(nothing downloaded in a dry run; enable with sync_photos).")

    print(f"\n{len(campaigns)} campaigns, {len(leads)} leads, "
          f"{len(messages)} messages, {len(steps)} steps. "
          "Compare against LH2's own numbers, then run `agent.py sync`.")


def cmd_sync(args):
    cfg = load_config()
    instance_id = cfg["instance_id"]

    # Pull online overrides (Health page) and merge over local config.yaml before
    # anything else, so auto_update is itself remotely controllable and --dry-run
    # previews exactly what a real sync will use.
    cfg = apply_remote_config(cfg)
    set_local_tz(cfg)

    if not args.dry_run and self_update(cfg):
        reexec()

    if args.dry_run:
        warnings = []
        campaigns, leads, messages, steps, owner, demo = extract_local(cfg, warnings)
        print_dry_run(instance_id, campaigns, leads, messages, steps, owner, demo)
        if warnings:
            print("\nWARNING: a real sync would report status 'partial' — "
                  "these sections failed and returned empty:")
            for w in warnings:
                print(f"  - {w}")
        return

    sb = Supabase(cfg)
    sb.upsert("instances", [{
        "id": instance_id,
        "label": cfg.get("instance_label", instance_id),
        "agent_version": AGENT_VERSION,
    }], on_conflict="id")
    # sync_runs.status is one of: running (row inserted here) | ok | partial | error.
    # 'partial' means the run pushed successfully but at least one fail-safe-to-empty
    # section (messages/steps/first-message/owner) hit a schema-drift error — the run
    # is green-ish but a feed may be silently empty, so it must NOT read as a clean 'ok'.
    # NOT retriable: a plain insert with no on_conflict isn't idempotent, so a Timeout
    # after the server committed would, on retry, leave an orphaned status='running'
    # row (whose id we'd never keep) stuck forever on the Health page.
    run = sb.insert("sync_runs", {"instance_id": instance_id}, retriable=False)

    total = 0
    warnings = []
    try:
        campaigns, leads, messages, steps, owner, demo = extract_local(cfg, warnings)
        total += sb.upsert("campaigns", campaigns, on_conflict="id")
        total += sb.upsert("leads", leads, on_conflict="campaign_id,profile_url")
        # Merge age-inference start years WITHOUT ever sending NULL (a re-sync must
        # not clobber a stored year). Kept out of the main leads payload (which stays
        # uniform) and pushed as separate merge-duplicate upserts bucketed by which
        # years each row carries, so every request has a uniform key set. Each row's
        # (campaign_id, profile_url) already exists from the leads upsert above, so
        # merge-duplicates UPDATEs just these columns.
        # GUARDED separately so a year failure never aborts the rest of the sync —
        # events, messages, steps, the reply ping and photos all still run. Fail safe
        # to a 'partial' run (visible on the Health page) and press on, exactly like
        # the other fail-safe-to-empty sections. Two ways this can 400: (a) this agent
        # self-updates ahead of migration 041, so the year columns don't exist yet;
        # (b) the payload omits a NOT NULL leads column — merge-duplicates validates
        # the candidate insert tuple before routing the conflict to UPDATE, so a
        # missing instance_id 400s even though the row exists (the 1.12.0 bug, fixed
        # in build_year_updates). A year failure must never break a scheduled sync.
        try:
            for bucket in build_year_updates(leads, demo["edu_map"], demo["job_map"]):
                total += sb.upsert("leads", bucket, on_conflict="campaign_id,profile_url")
        except Exception as e:
            note_warning(warnings, "year columns push (migration 041 applied?)", e)
            print(f"year columns push failed (migration 041 applied?): {e} — "
                  "continuing; run reports 'partial'")
        # events on_conflict key matches migration 035 (occurred_at dropped from the
        # key so a corrected LH2 milestone UPDATES the event instead of inserting a
        # duplicate). DEPLOY ORDER: migration 035 must be applied BEFORE this agent
        # version rolls out — until then this key has no unique constraint and
        # PostgREST rejects the on_conflict loudly (visible, not silent).
        total += sb.upsert("events", dedupe_events(derive_events(instance_id, leads)),
                           on_conflict="instance_id,campaign_id,profile_url,event_type")
        total += sb.upsert("messages", dedupe_messages(messages),
                           on_conflict="instance_id,profile_url,direction,sent_at,content_hash")
        total += sb.upsert("campaign_steps", steps,
                           on_conflict="campaign_id,step_index")

        # A successful push with swallowed per-section failures is 'partial', not 'ok'.
        status = "partial" if warnings else "ok"
        run_patch = {
            "status": status, "rows_upserted": total,
            "finished_at": dt.datetime.now(dt.timezone.utc).isoformat()}
        if warnings:
            run_patch["error"] = "; ".join(warnings)[:500]
        sb.update("sync_runs", {"id": run["id"]}, run_patch)
        sb.update("instances", {"id": instance_id}, dict(
            owner, last_sync_at=dt.datetime.now(dt.timezone.utc).isoformat()))
        print(f"sync {status}: {total} rows upserted for instance {instance_id}"
              + (f" ({len(warnings)} section(s) failed empty)" if warnings else ""))
        # After the run is recorded: both swallow everything internally, so they can
        # never trip the outer except and flip a green run to status='error'.
        notify_new_replies(cfg)
        # Photo mirroring runs after the leads push, opt-in per notebook. Off by
        # default so the first backfill is a deliberate rollout, not an ambush.
        if cfg.get("sync_photos"):
            sync_photos(cfg, sb, demo["avatar_map"])
    except Exception as e:
        sb.update("sync_runs", {"id": run["id"]}, {
            "status": "error", "error": str(e)[:2000],
            "finished_at": dt.datetime.now(dt.timezone.utc).isoformat()})
        sys.exit(f"sync failed: {e}")


def dedupe_messages(messages):
    """Collapse rows sharing the messages unique key within one batch (keep the
    earliest). A single Postgres upsert that targets the same conflict key twice
    fails with 'ON CONFLICT ... cannot affect row a second time', which would abort
    the whole messages push — so we guarantee uniqueness before sending."""
    seen = {}
    for m in sorted(messages, key=lambda x: x["sent_at"]):
        k = (m["instance_id"], m["profile_url"], m["direction"],
             m["sent_at"], m["content_hash"])
        seen.setdefault(k, m)
    return list(seen.values())


def dedupe_events(events):
    """Collapse events sharing the NEW unique key within one batch, keeping the
    LATEST occurred_at. Since migration 035 the key is
    (instance_id, campaign_id, profile_url, event_type) — occurred_at is no longer
    part of it — so two rows for the same lead+milestone with different timestamps
    now collide. A single upsert that hits the same conflict key twice fails with
    'ON CONFLICT ... cannot affect row a second time' and aborts the whole events
    push, so we guarantee uniqueness first (same guard as dedupe_messages). The
    sync path can't produce such a pair (leads are unique per campaign+profile in a
    run, one event per type), but the CSV ingest path can if the export repeats a
    profile — keeping the latest occurred_at matches the point of the key change:
    the newest correction of a milestone time wins."""
    seen = {}
    for e in sorted(events, key=lambda x: x["occurred_at"]):
        k = (e["instance_id"], e["campaign_id"], e["profile_url"], e["event_type"])
        seen[k] = e  # ascending sort → last assignment kept = latest occurred_at
    return list(seen.values())


def derive_events(instance_id, leads):
    """Turn lead milestone timestamps into append-only events for the chart."""
    events = []
    milestones = [("invited_at", "invite_sent"),
                  ("connected_at", "invite_accepted"),
                  ("first_message_at", "message_sent"),
                  ("replied_at", "reply_received")]
    for lead in leads:
        for field, etype in milestones:
            if lead.get(field):
                events.append({
                    "instance_id": instance_id,
                    "campaign_id": lead["campaign_id"],
                    "profile_url": lead["profile_url"],
                    "event_type": etype,
                    "occurred_at": lead[field],
                })
    return events


# ---------------------------------------------------------------- annotate

def cmd_annotate(args):
    """Drop a marker on the dashboard's time-series charts, e.g.
    `agent.py annotate "Switched to template B"`. Global by default; scope
    with --campaign (dashboard campaign id) or --instance (this notebook)."""
    cfg = load_config()
    sb = Supabase(cfg)
    sb.upsert("annotations", [{
        "note": args.note,
        "noted_at": args.date or dt.date.today().isoformat(),
        "instance_id": cfg["instance_id"] if args.instance else None,
        "campaign_id": args.campaign,
    }], on_conflict="note,noted_at,instance_id,campaign_id")
    print(f"annotation saved: {args.note!r} @ {args.date or 'today'}")


# ---------------------------------------------------------------- ingest-csv

# Column aliases seen in LH2 "Export to CSV" files.
CSV_ALIASES = {
    "profile_url": ["profile url", "profileurl", "linkedin url", "url",
                    "member id", "public url"],
    "full_name": ["full name", "name", "first name"],
    "headline": ["headline", "title", "current title"],
    "company": ["company", "current company", "organization"],
    "invited_at": ["invited", "invite sent", "invitation date", "date of invitation"],
    "connected_at": ["connected", "connection date", "accepted", "date connected"],
    "replied_at": ["replied", "reply date", "answered", "date of reply"],
    "added_at": ["added", "date added", "added at", "add to target date",
                 "date of adding"],
}


def pick(header_map, key, row):
    for alias in CSV_ALIASES[key]:
        if alias in header_map:
            return row[header_map[alias]]
    return None


def csv_campaign_slug(name):
    """Stable, collision-resistant campaign id slug for CSV ingest. A short hash of
    the exact name is appended so two distinct names that normalize to the same
    readable slug (e.g. 'Q1 Sales' vs 'Q1  Sales!') never share an id and silently
    overwrite each other's leads. Stable per exact name, so re-imports stay idempotent."""
    base = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-") or "campaign"
    suffix = hashlib.sha1(name.strip().encode("utf-8")).hexdigest()[:6]
    return f"{base}-{suffix}"


def cmd_ingest_csv(args):
    cfg = load_config()
    set_local_tz(cfg)
    sb = Supabase(cfg)
    instance_id = cfg["instance_id"]
    slug = csv_campaign_slug(args.campaign)
    campaign_id = f"{instance_id}:{slug}"

    sb.upsert("instances", [dict(extract_owner(cfg, None),
                                 id=instance_id,
                                 label=cfg.get("instance_label", instance_id),
                                 agent_version=AGENT_VERSION)], on_conflict="id")
    sb.upsert("campaigns", [{
        "id": campaign_id, "instance_id": instance_id,
        "lh_campaign_id": slug,
        "name": args.campaign,
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }], on_conflict="id")

    leads = []
    with open(args.file, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        hmap = {h.strip().lower(): i for i, h in enumerate(header)}
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        for row in reader:
            profile = pick(hmap, "profile_url", row)
            if not profile:
                continue
            lead = {
                "instance_id": instance_id,
                "campaign_id": campaign_id,
                "profile_url": profile.strip(),
                "full_name": pick(hmap, "full_name", row),
                "headline": pick(hmap, "headline", row),
                "company": pick(hmap, "company", row),
                "invited_at": iso(pick(hmap, "invited_at", row)),
                "connected_at": iso(pick(hmap, "connected_at", row)),
                "replied_at": iso(pick(hmap, "replied_at", row)),
                "added_at": iso(pick(hmap, "added_at", row)),
                "updated_at": now,
            }
            # --kind lets exports without date columns still count milestones.
            # A reply implies the connection happened, so synthesize connected_at
            # too — otherwise the funnel shows replies with no acceptance and
            # reply_rate (replies/accepted) blows past 100%.
            if args.kind == "successes" and not lead["connected_at"]:
                lead["connected_at"] = now
            if args.kind == "replies" and not lead["replied_at"]:
                lead["replied_at"] = now
            if args.kind == "replies" and not lead["connected_at"]:
                lead["connected_at"] = lead["replied_at"] or now
            if args.kind in ("successes", "replies") and not lead["invited_at"]:
                lead["invited_at"] = lead["connected_at"] or now
            lead["last_action_at"] = (lead["replied_at"] or lead["connected_at"]
                                      or lead["invited_at"])
            # Same earliest-milestone fallback as the sqlite path / 025 backfill.
            lead["added_at"] = lead["added_at"] or min(
                (t for t in (lead["invited_at"], lead["connected_at"],
                             lead["replied_at"]) if t),
                default=None)
            leads.append(lead)

    n = sb.upsert("leads", leads, on_conflict="campaign_id,profile_url")
    # events on_conflict key matches migration 035 (occurred_at dropped from the key);
    # dedupe_events pre-collapses in case the CSV repeats a profile. DEPLOY ORDER:
    # migration 035 must be applied before this agent version runs, else PostgREST
    # rejects the on_conflict loudly (visible, not silent).
    sb.upsert("events", dedupe_events(derive_events(instance_id, leads)),
              on_conflict="instance_id,campaign_id,profile_url,event_type")
    sb.update("instances", {"id": instance_id},
              {"last_sync_at": dt.datetime.now(dt.timezone.utc).isoformat()})
    print(f"ingested {n} leads into campaign '{args.campaign}'")


# ---------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("inspect", help="discover LH2 SQLite databases and schemas")
    pi.add_argument("--path", help="explicit LH2 data directory to scan")
    pi.set_defaults(func=cmd_inspect)

    ps = sub.add_parser("sync", help="sync local LH2 DB to Supabase per config.yaml")
    ps.add_argument("--dry-run", action="store_true",
                    help="extract and print per-campaign counts without pushing")
    ps.set_defaults(func=cmd_sync)

    pa = sub.add_parser("annotate",
                        help="mark an event (template change, audience swap…) "
                             "on the dashboard charts")
    pa.add_argument("note", help="short text shown on the chart marker")
    pa.add_argument("--date", help="YYYY-MM-DD (default today)")
    pa.add_argument("--campaign", help="dashboard campaign id to scope to")
    pa.add_argument("--instance", action="store_true",
                    help="scope to this notebook's account only")
    pa.set_defaults(func=cmd_annotate)

    pc = sub.add_parser("ingest-csv", help="ingest an LH2 CSV export")
    pc.add_argument("file")
    pc.add_argument("--campaign", required=True, help="campaign name")
    pc.add_argument("--kind", choices=["queue", "successes", "replies"],
                    default="queue")
    pc.set_defaults(func=cmd_ingest_csv)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
