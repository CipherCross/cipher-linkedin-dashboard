# Archive

Historical records. **Nothing in here describes the system as it is now.**

Everything filed here was checked against the live repo on 2026-08-12 and found to
be either already implemented, already decided, or explicitly superseded. It is
kept for reasoning and forensics, not for orientation.

One later addition: `specs/2026-08-31-sequence-builder-linked-helper-publishing.md`
was filed on 2026-08-31, when its feature reached a verified pilot. Its transport
research is still the best record of why CDP was chosen over generated CSV and
UI automation, but its "approval inputs" section is spent and its LH2 behavioural
claims were partly wrong — see `docs/implementation-handoffs/campaign-creator-summary.md`
for what the pilot actually established.

## When to read it

Open a file here only for a specific reason:

- You need the **why** behind something already built ("why is the ledger in its
  own schema", "was a second provider considered", "why does the driver `SET LOCAL`").
- You are touching a subsystem and want the **defects a past session already hit**
  in it, so you do not rediscover them.
- You need the evidence behind a **closed gate decision** (G2, G3).

Do **not** read it to find out what the system does, what is deployed, or what is
left to do. For that: `CLAUDE.md`, `AGENTS.md`, the live code, and the four
handoffs still in `docs/implementation-handoffs/`.

## How to read it safely

- **Every status claim is true only on the doc's date.** Many of these files say
  "not deployed", "blocked", or "provider readiness is false" about things that
  shipped days later. A status line here is never evidence about production.
- **Never resume a plan from here** without re-deriving its premises from live
  state. At least one plan in this archive was written on a premise that was
  already false when written.
- A few archived docs cite each other by their **pre-archive paths**
  (`docs/implementation-handoffs/…`). Read those as `docs/archive/…`.

## What is here

| Path | What it is |
| --- | --- |
| `implementation-handoffs/P1-*, P2, P3-*, P4-*` | Pre-Neon platform-ops phases: contract authoring, registry, Keychain, MCP, provider adapters. All shipped into `ops/`. |
| `implementation-handoffs/N-S01…N-S26` | The Neon migration and multitenancy sessions, plus the topic sessions (`N-B2`, `N-ROSTER`, `N-COACHING`, `N-BROWSER-RUN`, `N-UI-TESTS`). All shipped. |
| `platform-ops/g2-*, g3-*` | Closed gate decisions (DataContext migration, auth candidate). The accepted conditions live in the JSON, which is why the JSON is kept and the session prose is not. |
| `platform-ops/neon-migration-source-measurements*` | Pre-migration sizing of the Supabase source. |
| `platform-ops/neon-provider-decisions.md` | G0 provider selection, all now live. Carries one still-valid review trigger: Neon Free is 0.5 GB/project and ~6 hours of restore history — revisit past 70% of storage or CU-hours. |
| `platform-ops/p4-c-deferred-provisioning-plan.md`, `tenant-baseline-cutover-v053.md` | Supabase-era provisioning and baseline paths. Self-labelled must-not-resume. |
| `platform-ops/s26-*.md` | S26 status and evidence logs, falsified by S26 completing 13/13 on live providers the next day. |
| `specs/*` | Feature specs whose features are built and live. |
| `auth-rollout.md` | One-time Supabase Auth console rollout for migrations 050/051/054. |
| `redesign.md` | The 2026-07 UI redesign, fully shipped. |
| `NOTEBOOK-ROLLOUT-PROMPT.md` | The 1.12.2 → 1.15.1 notebook migration, finished on all four notebooks. New notebooks use the installer bundle instead. |

## Historical, but deliberately NOT moved here

Six documents are load-bearing test inputs. Moving or renaming them breaks the
pre-push gate, so they stay where the tests expect them even though their content
is historical:

- `docs/implementation-handoffs/N-IDENTITY-LEDGER.md`, `N-S13-consolidation.md`,
  `N-S15.md`, `N-S17.md`, `N-S21.md` and `docs/platform-ops/g1-dump-restore-go-no-go.json`
  — `postgres/tests/portable_migration_ledger_static_assertions.mjs` asserts each
  exists at its exact path and sweeps its content for provider resource IDs and
  credentials.
- `docs/platform-ops/local-owner-mcp.md` — `ops/test/mcp.test.ts` parses its
  `enabled_tools` TOML block and asserts it matches `OWNER_TOOL_ALLOWLIST`.

Two more stay for a different reason: `supabase/tenant-migrations/README.md` and
`supabase/tenant-baseline/v053/README.md` document directories that will be
deleted wholesale by the Supabase exit, and `supabase/tenant-baseline/` is under
the ledger's immutability check. They die with their directories.
