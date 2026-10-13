# Outreach insights

The offline analysis behind the "Outreach fact book" dashboard artifact: what
correlates with accepting, replying and replying with real interest. It
produces facts, not recommendations. The questions and data audit are in
`specs/2026-10-13-outreach-data-insights.md`.

Nothing here touches the product. Production is read only through the AI
copilot's guard (`public.ai_execute_sql` as `app_system`, `BEGIN READ ONLY`),
and Airtable is read with GET requests only. Everything lands in `data/`,
which is gitignored because it holds lead-level data.

## Run

Python 3.12+ with `pip install -r requirements.txt` in a virtualenv; Node for
the snapshot (it borrows `pg` from `frontend/node_modules`). Run every step
from this directory.

1. `node snapshot.mjs`: reads production. It uses `NEON_AI_DATABASE_URL` from
   `$NEON_ENV_FILE` (default `~/.config/neon-s28-production.env`).
2. `python airtable_pull.py`: needs `AIRTABLE_TOKEN` in `frontend/.env.local`.
3. `python enrich.py`: joins leads to Airtable contacts by LinkedIn profile.
4. `python features.py`: one row per invite with features and outcomes.
5. `python build_threads.py`: writes reply threads in batches to
   `data/labels/batch_*.jsonl`.
6. Classify the replies. Claude reads each batch against
   `labels/CODEBOOK.md` and writes `data/labels/out_NN.jsonl`. This is
   analysis-only and never written back to the product, where sentiment stays
   manual. Then run `python labels/merge_labels.py`.
7. Run `python scan.py`, then `python deep.py`, then `python replies.py`.
8. `python build_dash.py`: writes the four files in `data/dash/` that the
   dashboard loads. Upload them to the artifact and point its datasets at the
   new files.

## Method in one paragraph

- Each person counts once, at their first invite, and existing connections
  are dropped.
- Outcomes use fixed windows, so recent invites aren't penalized: accepted
  within 14 days, replied within 21 days.
- Every factor is compared inside each campaign (Mantel–Haenszel).
  Overlapping factors are separated by one logistic model with a term per
  campaign.
- p-values are Benjamini–Hochberg corrected, and every result is re-checked on
  invites before and after 2026-07-01.
- Acceptance timing is Kaplan–Meier.

## When to re-run

The September 2026 persona campaigns' replies mature in mid-November 2026.
