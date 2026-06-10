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
import sqlite3
import subprocess
import sys

import requests
import yaml

AGENT_VERSION = "1.4.0"
HERE = os.path.dirname(os.path.abspath(__file__))

LH2_DEFAULT_DIRS = [
    "~/Library/Application Support/Linked Helper 2",   # macOS
    os.path.join(os.environ.get("APPDATA", ""), "Linked Helper 2"),  # Windows
    "~/.config/Linked Helper 2",                        # Linux
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

    def upsert(self, table, rows, on_conflict=None):
        """Idempotent batch upsert. Returns number of rows sent."""
        if not rows:
            return 0
        params = {"on_conflict": on_conflict} if on_conflict else {}
        headers = dict(self.headers,
                       Prefer="resolution=merge-duplicates,return=minimal")
        for i in range(0, len(rows), 500):
            r = requests.post(f"{self.base}/{table}", params=params,
                              headers=headers, data=json.dumps(rows[i:i + 500]),
                              timeout=60)
            r.raise_for_status()
        return len(rows)

    def insert(self, table, row):
        headers = dict(self.headers, Prefer="return=representation")
        r = requests.post(f"{self.base}/{table}", headers=headers,
                          data=json.dumps(row), timeout=60)
        r.raise_for_status()
        return r.json()[0]

    def update(self, table, match, patch):
        params = {k: f"eq.{v}" for k, v in match.items()}
        r = requests.patch(f"{self.base}/{table}", params=params,
                           headers=self.headers, data=json.dumps(patch),
                           timeout=60)
        r.raise_for_status()


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
    me = os.path.abspath(__file__)
    with open(me, "rb") as f:
        if hashlib.sha256(f.read()).digest() == hashlib.sha256(new).digest():
            return False
    if b'AGENT_VERSION = "' not in new:
        print("self-update: downloaded file doesn't look like agent.py — skipping")
        return False
    tmp = me + ".new"
    with open(tmp, "wb") as f:
        f.write(new)
    os.replace(tmp, me)
    print(f"self-update: installed new agent build (was v{AGENT_VERSION}), restarting")
    return True


def reexec():
    """Re-run the same command under the freshly installed agent.py."""
    env = dict(os.environ, LH2_AGENT_REEXEC="1")
    sys.exit(subprocess.call([sys.executable] + sys.argv, env=env))


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
                d = d.replace(tzinfo=dt.timezone.utc)
            return d.isoformat()
        except ValueError:
            continue
    return None


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
        print("multiple LH2 account DBs found, using most recently active:")
        for p in candidates:
            print(f"  {'->' if p == candidates[0] else '  '} {p}")
    return candidates[0]


def extract_owner(cfg, con):
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

# Ordered message steps of each campaign's LATEST version, with the template AST.
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
WHERE ac.actionType IN ('InvitePerson', 'MessageToPerson')
"""

# One row per outbound send (invite note or follow-up message) per person.
STEP_SENDS_SQL = """
SELECT 'https://www.linkedin.com/in/' || pei.external_id AS profile_url,
       a.campaign_id   AS campaign_id,
       a.id            AS action_id,
       ar.created_at   AS sent_at
FROM action_result_messages arm
JOIN action_results ar  ON ar.id = arm.action_result_id
JOIN action_versions av ON av.id = ar.action_version_id
JOIN actions a          ON a.id = av.action_id
JOIN action_configs ac  ON ac.id = av.config_id
JOIN person_external_ids pei ON pei.person_id = ar.person_id AND pei.type_group = 'public'
WHERE arm.type IN ('Sent', 'Message')
  AND ac.actionType IN ('InvitePerson', 'MessageToPerson')
"""

# One row per inbound reply per person (CheckForReplies writes type='Replied').
STEP_REPLIES_SQL = """
SELECT 'https://www.linkedin.com/in/' || pei.external_id AS profile_url,
       a.campaign_id   AS campaign_id,
       ar.created_at   AS replied_at
FROM action_result_messages arm
JOIN action_results ar  ON ar.id = arm.action_result_id
JOIN action_versions av ON av.id = ar.action_version_id
JOIN actions a          ON a.id = av.action_id
JOIN person_external_ids pei ON pei.person_id = ar.person_id AND pei.type_group = 'public'
WHERE arm.type = 'Replied'
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


def extract_steps(con, instance_id):
    """Per-(campaign, step) send/reply aggregates for the message-sequence view.
    Reply attribution and current-step are computed here over each person's
    send/reply timeline — clearer than SQL window joins. Fails safe to []."""
    try:
        defs = list(con.execute(STEP_DEFS_SQL))
        sends = list(con.execute(STEP_SENDS_SQL))
        replies = list(con.execute(STEP_REPLIES_SQL))
    except sqlite3.Error as e:
        print(f"step extraction skipped ({e}) — per-step view will be empty")
        return []

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

    # Per-person send timeline (drop sends whose action was removed from the
    # latest sequence — they have no step to attribute to).
    timeline = {}  # (lh_cid, profile) -> [(sent_at_iso, step_index)]
    for r in sends:
        lh_cid = str(r["campaign_id"])
        sidx = action_step.get((lh_cid, str(r["action_id"])))
        ts = iso(r["sent_at"])
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
        if rep:
            attributed = events[0][1]
            for ts, step in events:
                if ts <= rep:
                    attributed = step
                else:
                    break
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


def extract_local(cfg):
    """Read campaigns + leads (+ owner identity) from the local LH2 DB."""
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
                "replied_at": iso(row_get(row, lmap, "replied_at")),
                "last_action_at": iso(row_get(row, lmap, "last_action_at")),
                "updated_at": now,
            })
    messages = []
    mmap = mapping.get("messages", {})
    if mmap.get("table") or mmap.get("query"):
        for row in rows_for(con, mmap):
            profile = row_get(row, mmap, "profile_url")
            sent_at = iso(row_get(row, mmap, "sent_at"))
            if not profile or not sent_at:
                continue
            body = row_get(row, mmap, "body")
            lh_cid = row_get(row, mmap, "campaign_id")
            messages.append({
                "instance_id": instance_id,
                "campaign_id": f"{instance_id}:{lh_cid}" if lh_cid is not None else None,
                "profile_url": str(profile),
                "direction": str(row_get(row, mmap, "direction") or "in"),
                "body": str(body)[:2000] if body else None,
                "sent_at": sent_at,
            })

    steps = []
    if cfg.get("sync_steps", True):
        try:
            steps = extract_steps(con, instance_id)
        except Exception as e:  # never let the per-step view break a sync
            print(f"step extraction skipped ({e}) — per-step view will be empty")

    owner = extract_owner(cfg, con)
    con.close()
    return campaigns, leads, messages, steps, owner


def print_dry_run(instance_id, campaigns, leads, messages, steps, owner):
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
        print("\nmessage steps (sent -> replied):")
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

    print(f"\n{len(campaigns)} campaigns, {len(leads)} leads, "
          f"{len(messages)} messages, {len(steps)} steps. "
          "Compare against LH2's own numbers, then run `agent.py sync`.")


def cmd_sync(args):
    cfg = load_config()
    instance_id = cfg["instance_id"]

    if not args.dry_run and self_update(cfg):
        reexec()

    if args.dry_run:
        campaigns, leads, messages, steps, owner = extract_local(cfg)
        print_dry_run(instance_id, campaigns, leads, messages, steps, owner)
        return

    sb = Supabase(cfg)
    sb.upsert("instances", [{
        "id": instance_id,
        "label": cfg.get("instance_label", instance_id),
        "agent_version": AGENT_VERSION,
    }], on_conflict="id")
    run = sb.insert("sync_runs", {"instance_id": instance_id})

    total = 0
    try:
        campaigns, leads, messages, steps, owner = extract_local(cfg)
        total += sb.upsert("campaigns", campaigns, on_conflict="id")
        total += sb.upsert("leads", leads, on_conflict="campaign_id,profile_url")
        total += sb.upsert("events", derive_events(instance_id, leads),
                           on_conflict="instance_id,campaign_id,profile_url,event_type,occurred_at")
        total += sb.upsert("messages", messages,
                           on_conflict="instance_id,profile_url,direction,sent_at")
        total += sb.upsert("campaign_steps", steps,
                           on_conflict="campaign_id,step_index")

        sb.update("sync_runs", {"id": run["id"]}, {
            "status": "ok", "rows_upserted": total,
            "finished_at": dt.datetime.now(dt.timezone.utc).isoformat()})
        sb.update("instances", {"id": instance_id}, dict(
            owner, last_sync_at=dt.datetime.now(dt.timezone.utc).isoformat()))
        print(f"sync ok: {total} rows upserted for instance {instance_id}")
    except Exception as e:
        sb.update("sync_runs", {"id": run["id"]}, {
            "status": "error", "error": str(e)[:2000],
            "finished_at": dt.datetime.now(dt.timezone.utc).isoformat()})
        sys.exit(f"sync failed: {e}")


def derive_events(instance_id, leads):
    """Turn lead milestone timestamps into append-only events for the chart."""
    events = []
    milestones = [("invited_at", "invite_sent"),
                  ("connected_at", "invite_accepted"),
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
    }], on_conflict="note,noted_at")
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
}


def pick(header_map, key, row):
    for alias in CSV_ALIASES[key]:
        if alias in header_map:
            return row[header_map[alias]]
    return None


def cmd_ingest_csv(args):
    cfg = load_config()
    sb = Supabase(cfg)
    instance_id = cfg["instance_id"]
    campaign_id = f"{instance_id}:{args.campaign.lower().replace(' ', '-')}"

    sb.upsert("instances", [dict(extract_owner(cfg, None),
                                 id=instance_id,
                                 label=cfg.get("instance_label", instance_id),
                                 agent_version=AGENT_VERSION)], on_conflict="id")
    sb.upsert("campaigns", [{
        "id": campaign_id, "instance_id": instance_id,
        "lh_campaign_id": args.campaign.lower().replace(" ", "-"),
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
                "updated_at": now,
            }
            # --kind lets exports without date columns still count milestones
            if args.kind == "successes" and not lead["connected_at"]:
                lead["connected_at"] = now
            if args.kind == "replies" and not lead["replied_at"]:
                lead["replied_at"] = now
            if args.kind in ("successes", "replies") and not lead["invited_at"]:
                lead["invited_at"] = lead["connected_at"] or now
            lead["last_action_at"] = (lead["replied_at"] or lead["connected_at"]
                                      or lead["invited_at"])
            leads.append(lead)

    n = sb.upsert("leads", leads, on_conflict="campaign_id,profile_url")
    sb.upsert("events", derive_events(instance_id, leads),
              on_conflict="instance_id,campaign_id,profile_url,event_type,occurred_at")
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
