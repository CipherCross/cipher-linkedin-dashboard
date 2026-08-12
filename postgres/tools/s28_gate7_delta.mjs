#!/usr/bin/env node
// S28 gate 7 — copy the measured delta from the source (Supabase) into the
// owner's production Neon database.
//
// Like s28_owner_migration.mjs and b2_tenant_slice.mjs this is deliberately NOT
// part of the portable baseline set: it bridges two providers, which the
// artifacts in postgres/tenant-baseline/v1 must never name. Every endpoint, key
// and connection string arrives from the environment; there is none in this file.
//
// WHY THIS IS NOT `s28_owner_migration.mjs delta`
//
// The migration tool copies whole tables into an empty database and its
// `rollback` empties them again. Gate 7 is the opposite situation: the target is
// LIVE, it is ahead of the source in eight tables, and a whole-row upsert would
// revert a teammate's morning. What is copied here is five hand-scoped items
// reached by column-scoped UPDATEs and conflict-guarded INSERTs, and there is no
// rollback because there is nothing safe to roll back to. Adding that mode to a
// tool whose contract is "the target is a dedicated database whose only purpose
// is to hold exactly this" would falsify its header. It is left byte-identical.
//
// WHAT IS COPIED, AND WHAT IS DELIBERATELY NOT
//
// Measured read-only on 2026-08-12; see N-S28-OWNER-DATA-MIGRATION.md gate 7 for
// the evidence behind every number.
//
//   1  briefings                1 row    the 2026-08-12 briefing
//   2  briefing_jobs            1 row    its job record
//   3  messages                 3 rows   sentiment + intent, columns only
//   4  leads                  100 rows   six demographic columns, columns only
//   7  sync_runs               23 rows   the syncs between extract and cutover
//
// Items 5 and 6 — five `pipeline_auto_advance()` stage changes and their five
// `pipeline_events` — are DROPPED by owner decision 2026-08-12. They are a
// machine decision taken against a database that is no longer the system of
// record; one of them would have overridden a stage a teammate set by hand on the
// target; and `pipeline_events.id` has already collided (ids 516/517 name
// different rows on the two sides), so copying them would mean re-keying into a
// table with no natural key to make the re-key idempotent.
//
// EVERY WRITE IS IDEMPOTENT AND FILL-ONLY
//
// The two INSERTs carry an ON CONFLICT DO NOTHING on the target's own natural
// key. The two UPDATEs touch a fixed column list and match only rows where the
// target value is still absent, so a second run is a no-op and a value written on
// the target since the measurement is never overwritten. The column lists matter
// beyond tidiness: `leads` carries BEFORE UPDATE OF triggers on `full_name`,
// `headline`, `education_start_year` and `first_job_start_year`
// (`reset_lead_gender_on_input_change`, `refresh_lead_age_estimate`), so naming a
// column that does not need writing has side effects.
//
// Values are read as JSON and encoded here as SQL literals. CSV is not used: the
// source's CSV writer backslash-escapes inside the field and `COPY … FORMAT csv`
// does not unescape it, which corrupts every jsonb holding a quote or a newline —
// the defect s28_owner_migration.mjs documents. `briefings` alone has five jsonb
// columns.
//
// Usage:
//   node postgres/tools/s28_gate7_delta.mjs plan  [--emit-sql PATH]
//   node postgres/tools/s28_gate7_delta.mjs apply [--emit-sql PATH] [--allow-drift]
//
// Environment: the same five s28_owner_migration.mjs takes.
//   S28_SOURCE_URL  S28_SOURCE_KEY  S28_PSQL  S28_DB  S28_APPLY_USER
//
// Exit codes: 0 success, 1 a check failed, 2 usage/environment error.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// --- the approved shape ------------------------------------------------------

// apply refuses if what it measures is not this. The delta was scoped and agreed
// row by row; a different shape means the world moved since, and the right
// response is to re-scope rather than to copy whatever happens to be there. The
// crons write to the source every morning at 06:00 and 07:00 UTC, so this WILL
// drift — deliberately loudly.
const EXPECTED = {
  briefings: 1,
  briefing_jobs: 1,
  messages: 3,
  leads: 100,
  sync_runs: 23,
};

// The gap between the extract watermark and the notebook cutover. Every source
// sync_run in it is one the target never saw; outside it, the target has its own.
const EXTRACT_WATERMARK = '2026-08-11T21:32:29.911Z';
const NOTEBOOK_CUTOVER = '2026-08-11T23:25:07.147663Z';

// Column-scoped, for the reason in the header.
const MESSAGE_CLASSIFICATION = [
  'sentiment', 'reason', 'classified_at', 'classified_model',
  'intent_level', 'intent_reason', 'intent_classified_at',
  'intent_classified_model', 'intent_taxonomy_version',
];
const LEAD_DEMOGRAPHICS = [
  'gender', 'gender_confidence', 'gender_model_version',
  'demo_model', 'demo_inferred_at', 'gender_inferred_at',
];
const MESSAGE_GRAIN = ['instance_id', 'profile_url', 'direction', 'sent_at', 'content_hash'];

const PAGE = 1000;

// --- plumbing ----------------------------------------------------------------

class DeltaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new DeltaError(code, message); };
const env = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback === undefined) fail('environment', `${name} is not set`);
    return fallback;
  }
  return value;
};

function psql(sql) {
  const argv = env('S28_PSQL', 'psql').split(/\s+/).filter(Boolean);
  const result = spawnSync(argv[0], [
    ...argv.slice(1),
    '--no-psqlrc', '--quiet', '--no-align', '--tuples-only',
    '--set', 'ON_ERROR_STOP=1',
    '--username', env('S28_APPLY_USER', 'app_migration'),
    '--dbname', env('S28_DB', 'neondb'),
  ], { input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });

  const stderr = (result.stderr || '').trim();
  // psql can exit on a server error while we are still writing to its stdin;
  // reporting EPIPE would hide the database's own message behind plumbing.
  if (result.error) {
    if (result.error.code === 'EPIPE' && stderr) fail('query_failed', stderr);
    fail('psql_unavailable', `could not run ${argv[0]}: ${result.error.message}`);
  }
  if (result.status !== 0) fail('query_failed', stderr || (result.stdout || '').trim());
  for (const line of (result.stderr || '').split('\n')) {
    if (line.startsWith('NOTICE:')) process.stdout.write(`  ${line.replace(/^NOTICE:\s*/, '')}\n`);
  }
  return result.stdout || '';
}

// app_migration is NOINHERIT and app_owner owns these tables, so RLS (enabled,
// not forced) is bypassed only under SET ROLE. A raw query with no actor set
// reads as [] rather than erroring, which is why this is not optional.
const asOwner = (sql) => `SET ROLE app_owner;\n${sql}`;

function targetJson(sql) {
  const text = psql(asOwner(
    `SELECT coalesce(json_agg(row_to_json(q)), '[]'::json)::text FROM (\n${sql}\n) q;\n`,
  )).trim();
  try { return JSON.parse(text); }
  catch { return fail('query_failed', `could not parse target result: ${text.slice(0, 200)}`); }
}

async function sourceRequest(path) {
  const response = await fetch(`${env('S28_SOURCE_URL')}/rest/v1/${path}`, {
    headers: {
      apikey: env('S28_SOURCE_KEY'),
      Authorization: `Bearer ${env('S28_SOURCE_KEY')}`,
      // count=exact or the source reports its total as `*`, the pager cannot tell
      // a full page from the last one, and anything over 1000 rows silently
      // truncates to its first page. That defect has been shipped once here.
      Prefer: 'count=exact',
    },
  });
  const text = await response.text();
  if (!response.ok) fail('source', `${response.status} on ${path}: ${text.slice(0, 300)}`);
  const range = response.headers.get('content-range') || '';
  const total = range.includes('/') ? range.split('/')[1] : null;
  if (total === '*') fail('source', `count=exact was not honoured for ${path}`);
  return { rows: text ? JSON.parse(text) : [], total: total === null ? null : Number(total) };
}

async function sourceRows(relation, order, filters = []) {
  const out = [];
  for (;;) {
    const query = [`select=*`, `order=${order}`, `limit=${PAGE}`, `offset=${out.length}`, ...filters];
    const { rows, total } = await sourceRequest(`${relation}?${query.join('&')}`);
    out.push(...rows);
    if (rows.length < PAGE) {
      if (total !== null && out.length !== total) {
        fail('source', `short read on ${relation}: ${out.length} of ${total}`);
      }
      return out;
    }
    if (total !== null && out.length >= total) return out;
  }
}

// --- SQL literal encoding ----------------------------------------------------

// standard_conforming_strings is on, so a backslash is an ordinary character and
// only the quote needs doubling. jsonb and arrays are encoded from the parsed
// JSON value rather than from any text rendering of it — see the header.
const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

function literal(value, udt) {
  if (value === null || value === undefined) return 'NULL';
  if (udt === 'jsonb' || udt === 'json') return `${quote(JSON.stringify(value))}::${udt}`;
  if (udt === 'bool') return value ? 'true' : 'false';
  if (['int2', 'int4', 'int8', 'float4', 'float8', 'numeric'].includes(udt)) {
    if (typeof value !== 'number' && !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(String(value))) {
      fail('encode', `${udt} column received a non-numeric value: ${JSON.stringify(value)}`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    fail('encode', `array value for ${udt} is not expected in this delta: ${JSON.stringify(value)}`);
  }
  if (typeof value === 'object') {
    fail('encode', `object value for a non-json column (${udt}): ${JSON.stringify(value)}`);
  }
  return `${quote(value)}::${udt}`;
}

function targetTypes(table) {
  const rows = targetJson(
    `SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='${table}'`,
  );
  if (rows.length === 0) fail('schema', `target has no table public.${table}`);
  return Object.fromEntries(rows.map((r) => [r.column_name, r.udt_name]));
}

// The column list comes from the TARGET and is demanded of the source, so a
// schema that has drifted apart fails here instead of quietly dropping a column.
function alignedColumns(table, sourceRow, types) {
  const target = Object.keys(types);
  const missing = target.filter((c) => !(c in sourceRow));
  if (missing.length) {
    fail('schema', `source ${table} is missing target columns: ${missing.join(', ')}`);
  }
  return target;
}

// --- measuring ---------------------------------------------------------------

const isoOf = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());
const grainOf = (row) => MESSAGE_GRAIN.map((c) => (c === 'sent_at' ? isoOf(row[c]) : String(row[c]))).join(' ');

async function measure() {
  const plan = {};

  // 1 + 2 — whole rows the target has never seen, keyed on the natural key.
  const targetBriefings = new Set(targetJson(
    `SELECT briefing_date::text AS d, briefing_kind AS k FROM public.briefings`,
  ).map((r) => `${r.d}|${r.k}`));
  plan.briefings = (await sourceRows('briefings', 'briefing_date'))
    .filter((r) => !targetBriefings.has(`${r.briefing_date}|${r.briefing_kind}`));

  const targetJobs = new Set(targetJson(
    `SELECT briefing_date::text AS d, briefing_kind AS k FROM public.briefing_jobs`,
  ).map((r) => `${r.d}|${r.k}`));
  plan.briefing_jobs = (await sourceRows('briefing_jobs', 'briefing_date'))
    .filter((r) => !targetJobs.has(`${r.briefing_date}|${r.briefing_kind}`));

  // 3 — classification the source holds for a message the target has left
  // unclassified. Matched on the message's own grain, never on `id`: both sides
  // allocate that independently and it has already diverged.
  const targetUnclassified = new Map(targetJson(
    `SELECT id, ${MESSAGE_GRAIN.join(', ')} FROM public.messages
      WHERE sentiment IS NULL AND classified_at IS NULL`,
  ).map((r) => [grainOf(r), r.id]));
  plan.messages = [];
  for (const row of await sourceRows('messages', 'id', ['classified_at=not.is.null'])) {
    const id = targetUnclassified.get(grainOf(row));
    if (id === undefined) continue;
    plan.messages.push({ id, values: Object.fromEntries(MESSAGE_CLASSIFICATION.map((c) => [c, row[c] ?? null])) });
  }

  // 4 — demographics the source inferred for a lead the target still has blank.
  const targetBlank = new Set(targetJson(
    `SELECT id::text AS id FROM public.leads WHERE gender IS NULL`,
  ).map((r) => r.id));
  plan.leads = [];
  for (const row of await sourceRows('leads', 'id', ['gender=not.is.null'])) {
    if (!targetBlank.has(String(row.id))) continue;
    plan.leads.push({ id: String(row.id), values: Object.fromEntries(LEAD_DEMOGRAPHICS.map((c) => [c, row[c] ?? null])) });
  }

  // 7 — run records from the gap between the extract and the cutover.
  const targetRuns = new Set(targetJson(`SELECT id::text AS id FROM public.sync_runs`).map((r) => r.id));
  plan.sync_runs = (await sourceRows('sync_runs', 'started_at', [
    `started_at=gt.${EXTRACT_WATERMARK}`,
    `started_at=lte.${NOTEBOOK_CUTOVER}`,
  ])).filter((r) => !targetRuns.has(String(r.id)));

  return plan;
}

// --- SQL ---------------------------------------------------------------------

function insertStatements(table, rows, conflict) {
  if (rows.length === 0) return [];
  const types = targetTypes(table);
  const columns = alignedColumns(table, rows[0], types);
  const values = rows.map((r) => `  (${columns.map((c) => literal(r[c], types[c])).join(', ')})`);
  return [
    `INSERT INTO public.${table} (${columns.map((c) => `"${c}"`).join(', ')})\nVALUES\n${values.join(',\n')}\nON CONFLICT ${conflict} DO NOTHING;`,
  ];
}

function updateStatements(table, updates, columns, guard) {
  if (updates.length === 0) return [];
  const types = targetTypes(table);
  const missing = columns.filter((c) => !(c in types));
  if (missing.length) fail('schema', `target ${table} has no column ${missing.join(', ')}`);
  return updates.map((u) => {
    const set = columns.map((c) => `"${c}" = ${literal(u.values[c], types[c])}`).join(', ');
    return `UPDATE public.${table} SET ${set} WHERE id = ${literal(u.id, types.id)} AND ${guard};`;
  });
}

function buildSql(plan) {
  const parts = [];
  parts.push(...insertStatements('briefings', plan.briefings, '(briefing_date, briefing_kind)'));
  parts.push(...insertStatements('briefing_jobs', plan.briefing_jobs, '(briefing_date, briefing_kind)'));
  // The guards repeat the measurement predicate inside the transaction, so a row
  // classified or inferred on the target between measuring and applying keeps its
  // own value instead of being overwritten by the source's.
  parts.push(...updateStatements('messages', plan.messages, MESSAGE_CLASSIFICATION,
    'sentiment IS NULL AND classified_at IS NULL'));
  parts.push(...updateStatements('leads', plan.leads, LEAD_DEMOGRAPHICS, 'gender IS NULL'));
  parts.push(...insertStatements('sync_runs', plan.sync_runs, '(id)'));
  return parts;
}

// --- commands ----------------------------------------------------------------

function report(plan, applied) {
  let total = 0;
  for (const [table, rows] of Object.entries(plan)) {
    const n = rows.length;
    total += n;
    const expected = EXPECTED[table];
    // In the applied state every count is legitimately zero, so comparing it to
    // the approved outstanding count would label the success case DRIFT.
    const mark = applied ? 'done' : n === expected ? 'ok  ' : 'DRIFT';
    const against = applied ? `${expected} copied` : `approved ${expected}`;
    process.stdout.write(`  ${mark} ${table.padEnd(16)} ${String(n).padStart(4)} outstanding (${against})\n`);
  }
  process.stdout.write(`  ${total} rows outstanding in total\n`);
  return total;
}

const driftedTables = (plan) =>
  Object.keys(EXPECTED).filter((t) => (plan[t] || []).length !== EXPECTED[t]);

// An empty delta is the SUCCESS state, not drift. Checking the approved shape
// first would make the second run of a successful copy — the natural way to ask
// "did this land?" — report every table as DRIFT and exit 1. The approved shape
// describes what was outstanding before the copy; once nothing is outstanding,
// there is nothing to compare it against.
const alreadyApplied = (plan) => Object.values(plan).every((rows) => rows.length === 0);

async function cmdPlan(emitSqlTo) {
  process.stdout.write('Measured delta, source against target\n');
  const plan = await measure();
  const applied = alreadyApplied(plan);
  report(plan, applied);
  if (applied) {
    process.stdout.write('\nNothing outstanding — the delta is fully applied.\n');
    return 0;
  }
  const sql = buildSql(plan);
  if (emitSqlTo) {
    writeFileSync(emitSqlTo, `BEGIN;\nSET ROLE app_owner;\n\n${sql.join('\n')}\n\nCOMMIT;\n`);
    process.stdout.write(`\n${sql.length} statements written to ${emitSqlTo}\n`);
  }
  const drift = driftedTables(plan);
  if (drift.length) {
    process.stdout.write(`\nDrifted from the approved shape: ${drift.join(', ')}. apply will refuse without --allow-drift.\n`);
    return 1;
  }
  process.stdout.write('\nMatches the approved shape.\n');
  return 0;
}

async function cmdApply(emitSqlTo, allowDrift) {
  process.stdout.write('Measured delta, source against target\n');
  const plan = await measure();
  const applied = alreadyApplied(plan);
  const total = report(plan, applied);
  if (applied) {
    process.stdout.write('\nNothing to copy — already applied.\n');
    return 0;
  }
  const drift = driftedTables(plan);
  if (drift.length && !allowDrift) {
    fail('drift', `measured shape differs from the approved one for: ${drift.join(', ')}. `
      + 'Re-scope, or pass --allow-drift if the difference is understood.');
  }

  const statements = buildSql(plan);
  if (emitSqlTo) {
    writeFileSync(emitSqlTo, `BEGIN;\nSET ROLE app_owner;\n\n${statements.join('\n')}\n\nCOMMIT;\n`);
    process.stdout.write(`\n${statements.length} statements written to ${emitSqlTo}\n`);
  }

  // One transaction. The counts are asserted inside it, before COMMIT, so a
  // partial application cannot survive: any shortfall raises and rolls the whole
  // thing back rather than leaving the delta half-copied.
  const assertions = [
    ['briefings', plan.briefings.length,
      `SELECT count(*) FROM public.briefings WHERE (briefing_date::text, briefing_kind) IN (${plan.briefings.map((r) => `(${quote(r.briefing_date)}, ${quote(r.briefing_kind)})`).join(', ') || `('', '')`})`],
    ['briefing_jobs', plan.briefing_jobs.length,
      `SELECT count(*) FROM public.briefing_jobs WHERE (briefing_date::text, briefing_kind) IN (${plan.briefing_jobs.map((r) => `(${quote(r.briefing_date)}, ${quote(r.briefing_kind)})`).join(', ') || `('', '')`})`],
    ['messages', plan.messages.length,
      `SELECT count(*) FROM public.messages WHERE id IN (${plan.messages.map((u) => u.id).join(', ') || 'NULL'}) AND classified_at IS NOT NULL`],
    ['leads', plan.leads.length,
      `SELECT count(*) FROM public.leads WHERE id IN (${plan.leads.map((u) => quote(u.id)).join(', ') || 'NULL'}) AND gender IS NOT NULL`],
    ['sync_runs', plan.sync_runs.length,
      `SELECT count(*) FROM public.sync_runs WHERE id IN (${plan.sync_runs.map((r) => quote(r.id)).join(', ') || 'NULL'})`],
  ].filter(([, n]) => n > 0).map(([table, n, query]) => `
DO $assert$
DECLARE got bigint;
BEGIN
  ${query.replace('SELECT count(*)', 'SELECT count(*) INTO got')};
  IF got <> ${n} THEN
    RAISE EXCEPTION '${table}: expected ${n} rows present after the copy, found %', got;
  END IF;
  RAISE NOTICE '${table}: ${n} rows present';
END
$assert$;`);

  psql(`BEGIN;\nSET ROLE app_owner;\n\n${statements.join('\n')}\n${assertions.join('\n')}\n\nCOMMIT;\n`);
  process.stdout.write(`\nApplied ${statements.length} statements, ${total} rows, in one transaction.\n`);
  return 0;
}

// --- entry -------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const at = rest.indexOf(name);
  return at === -1 ? null : rest[at + 1];
};
const has = (name) => rest.includes(name);

try {
  let code = 2;
  if (command === 'plan') code = await cmdPlan(flag('--emit-sql'));
  else if (command === 'apply') code = await cmdApply(flag('--emit-sql'), has('--allow-drift'));
  else {
    process.stderr.write('usage: s28_gate7_delta.mjs plan|apply [--emit-sql PATH] [--allow-drift]\n');
  }
  process.exit(code);
} catch (error) {
  if (error instanceof DeltaError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exit(error.code === 'usage' || error.code === 'environment' ? 2 : 1);
  }
  throw error;
}
