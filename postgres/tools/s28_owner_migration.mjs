#!/usr/bin/env node
// S28 — migrate the owner's live dashboard data from Supabase to a dedicated
// Neon database: extract, load, verify parity, roll back.
//
// Like postgres/tools/b2_tenant_slice.mjs, this tool is deliberately NOT part of
// the portable baseline set: the artifacts in postgres/tenant-baseline/v1 must
// not name any provider surface, and this tool exists precisely to bridge two
// providers. It is still swept by hand for credentials and resource identifiers
// and contains neither — every endpoint, key and connection string arrives from
// the environment.
//
// WHY THIS IS NOT AN EXTENSION OF b2_tenant_slice.mjs
//
// b2's header states that its SCOPE is "a constant rather than a flag so that the
// approved slice and the code that copies it cannot drift apart, and so `delete`
// removes exactly what `load` wrote". Extending it here would mean making that
// constant variable — on a tool whose `delete --confirm` is scoped by it. Beyond
// that, b2 copies 6 tables under a row ceiling for one instance, re-keys a
// colliding identity value, and drops an assignee by decision. S28 copies 24
// tables with no ceiling across four instances, must never re-key, and must
// resolve every roster reference or fail. b2's collision branch is actively wrong
// here: on a dedicated target a collision means the load is running twice, which
// must abort rather than silently produce a second copy under new ids.
// b2_tenant_slice.mjs is left byte-identical.
//
// WHAT IS REUSED FROM IT, DELIBERATELY
//
//  - `count=exact` on every page. Without it the source reports its total as `*`,
//    the pager cannot tell a full page from the last one, and every table over
//    1000 rows silently truncates to its first page. That is a defect b2 shipped
//    once; it is not being re-learned here.
//  - Counting CSV data rows with the quoting rules, because a message body
//    legitimately contains newlines and a naive split over-counts most of them.
//  - Taking the column list from the TARGET and demanding it of the source, so a
//    schema that has drifted apart fails at extract instead of quietly dropping
//    a column.
//  - Staging tables, so the load asserts what it received before it commits.
//  - `setval` past every copied maximum, or the next real write collides.
//  - Comparing parity through the two sides' own aggregate views, normalising
//    only the two shapes a JSON reader and a SQL reader legitimately disagree
//    about (numeric type, timestamp precision).
//
// Usage:
//   node postgres/tools/s28_owner_migration.mjs counts
//   node postgres/tools/s28_owner_migration.mjs roster-map --out DIR
//   node postgres/tools/s28_owner_migration.mjs extract    --out DIR
//   node postgres/tools/s28_owner_migration.mjs load       --in  DIR [--dry-run]
//   node postgres/tools/s28_owner_migration.mjs verify     --in  DIR
//   node postgres/tools/s28_owner_migration.mjs rollback   --confirm
//
// Environment:
//   S28_SOURCE_URL  base URL of the source REST endpoint
//   S28_SOURCE_KEY  bearer credential for the source
//   S28_PSQL        psql invocation for the target (default "psql")
//   S28_DB          target database name (default "neondb")
//   S28_APPLY_USER  target login (default "app_migration"; reads SET ROLE app_owner)
//
// Exit codes: 0 success, 1 a check failed, 2 usage/environment error.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// --- scope -------------------------------------------------------------------

// The whole of the owner's business data. Unlike B2 there is no instance filter
// and no row ceiling: the target is a dedicated database whose only purpose is to
// hold exactly this, so "everything" is the scope and `rollback` removes
// everything rather than a slice.
//
// team_members is deliberately absent. Its rows are not copyable: the source
// column is `auth_user_id` (a Supabase auth.users uuid) and the target column is
// `user_id NOT NULL` (a public.users uuid), so a roster row on the target cannot
// exist until the identity layer has created the canonical user behind it. The
// roster is therefore rebuilt through the live invite path (gate 2) and this tool
// consumes the result as roster.map.json. Every reference to it is remapped.
const SKIP_TABLES = new Set([
  'team_members',      // rebuilt by the identity layer, see above
  'users',             // identity, gate 2
  'user_identities',   // identity, gate 2
  'agent_credential',  // machine ingest, issued per notebook, never copied
  'agent_ingest_batch',// machine ingest idempotency ledger, must not be seeded
]);

// The views parity is computed from, rather than rows to copy. `campaign_metrics`
// and `daily_activity` are the funnel topline; `pipeline_metrics` and the two
// reply-intent views are the surfaces S13 added and no earlier copy ever checked.
// `keys` is each view's real grain, read off the live relations rather than
// guessed. Rows are matched BY KEY rather than compared position by position,
// because the two sides do not agree on text ordering: `daniël-huizinga` and
// `daniel-jasewicz` sort in a different order under the source's collation than
// under the target's, which misaligned a positional walk and reported 12 differing
// cells for data that was in fact identical. `order` remains only to make the
// source's own paging deterministic.
const PARITY_VIEWS = [
  { name: 'campaign_metrics', order: 'campaign_id', keys: ['campaign_id'] },
  { name: 'daily_activity', order: 'instance_id,day,event_type', keys: ['instance_id', 'day', 'event_type'] },
  { name: 'pipeline_metrics', order: 'campaign_id,pipeline_stage', keys: ['campaign_id', 'pipeline_stage', 'pipeline_substatus'] },
  { name: 'campaign_reply_intent', order: 'campaign_id,intent_level', keys: ['campaign_id', 'intent_level'] },
  { name: 'conversation_reply_intent', order: 'instance_id,profile_url', keys: ['instance_id', 'profile_url'] },
];

// NULL means "this never happened" for every one of these, so a copy that turned
// a real timestamp back into NULL would silently un-do a funnel milestone —
// exactly what trigger `leads_keep_milestones` exists to prevent on re-sync.
const MILESTONES = ['invited_at', 'connected_at', 'first_message_at', 'replied_at'];

const PAGE = 1000; // the source REST endpoint caps a response at 1000 rows

// --- plumbing ----------------------------------------------------------------

class S28Error extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new S28Error(code, message);
};

const env = (name, fallback) => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    fail('environment', `${name} is not set`);
  }
  return value;
};

let checks = 0;
let failures = 0;
function check(label, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}\n`);
}

// --- target (SQL) ------------------------------------------------------------

function psql(sql, { csv = false } = {}) {
  const argv = env('S28_PSQL', 'psql').split(/\s+/).filter(Boolean);
  const result = spawnSync(argv[0], [
    ...argv.slice(1),
    '--no-psqlrc',
    '--quiet',
    '--no-align',
    '--tuples-only',
    '--set', 'ON_ERROR_STOP=1',
    '--username', env('S28_APPLY_USER', 'app_migration'),
    '--dbname', env('S28_DB', 'neondb'),
    ...(csv ? ['--csv'] : []),
  ], { input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });

  // A large load writes megabytes to psql's stdin. If the server raises early —
  // the double-load refusal is exactly this case — psql exits while we are still
  // writing and the write fails with EPIPE. Reporting that as "could not run psql"
  // would hide the database's own message behind a plumbing error, which is the
  // failure mode S27 step 2 was about: every cause arriving at the log as the same
  // label. So psql's stderr wins whenever it said anything.
  const stderr = (result.stderr || '').trim();
  if (result.error) {
    if (result.error.code === 'EPIPE' && stderr) fail('query_failed', stderr);
    fail('psql_unavailable', `could not run ${argv[0]}: ${result.error.message}`);
  }
  if (result.status !== 0) fail('query_failed', stderr || (result.stdout || '').trim());
  // Decisions the load makes for itself arrive as notices. Surfacing them is the
  // difference between a copy that reports what it did and one that only reports
  // that it finished.
  for (const line of (result.stderr || '').split('\n')) {
    if (line.startsWith('NOTICE:')) process.stdout.write(`  ${line.replace(/^NOTICE:\s*/, '')}\n`);
  }
  return result.stdout || '';
}

// Every read and write runs as app_owner: app_migration is NOINHERIT, and
// app_owner owns these tables, so RLS (enabled, not forced) is bypassed. A raw
// query with no actor set returns [] rather than erroring, so running as the
// wrong principal reads as "the table is empty" — which is why this is not
// optional and why the counts below are trusted only through it.
const asOwner = (sql) => `SET ROLE app_owner;\n${sql}`;

function targetJson(sql) {
  const text = psql(asOwner(
    `SELECT coalesce(json_agg(row_to_json(q)), '[]'::json)::text FROM (\n${sql}\n) q;\n`,
  )).trim();
  try {
    return JSON.parse(text);
  } catch {
    return fail('query_failed', `could not parse target result: ${text.slice(0, 200)}`);
  }
}

// --- catalog discovery -------------------------------------------------------

// Everything structural is read from the target catalog rather than hardcoded:
// the table set, the column lists, the primary keys, the identity columns and the
// foreign-key graph that decides load order. A table that gains an identity
// column, or a new reference to the roster, must not be able to slip through by
// virtue of not being in a list someone forgot to update.
function readCatalog() {
  const tables = targetJson(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  ).map((r) => r.name).filter((t) => !SKIP_TABLES.has(t));

  const columns = {};
  for (const row of targetJson(
    `SELECT table_name, column_name, ordinal_position, is_identity, udt_name
       FROM information_schema.columns WHERE table_schema='public'
      ORDER BY table_name, ordinal_position`,
  )) {
    (columns[row.table_name] ||= []).push(row);
  }

  const pks = {};
  for (const row of targetJson(
    `SELECT c.relname AS t, a.attname AS col, k.ord
       FROM pg_constraint con
       JOIN pg_class c ON c.oid=con.conrelid
       JOIN unnest(con.conkey) WITH ORDINALITY k(att,ord) ON true
       JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.att
      WHERE con.contype='p' AND c.relnamespace='public'::regnamespace
      ORDER BY c.relname, k.ord`,
  )) {
    (pks[row.t] ||= []).push(row.col);
  }

  const fks = targetJson(
    `SELECT src.relname AS child, tgt.relname AS parent, a.attname AS column_name
       FROM pg_constraint con
       JOIN pg_class src ON src.oid=con.conrelid
       JOIN pg_class tgt ON tgt.oid=con.confrelid
       JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=con.conkey[1]
      WHERE con.contype='f'
        AND src.relnamespace='public'::regnamespace
        AND tgt.relnamespace='public'::regnamespace`,
  );

  return { tables, columns, pks, fks };
}

// Kahn's algorithm over the FK graph. The graph among public tables is a DAG, and
// this asserts that rather than assuming it: a cycle would mean no load order
// exists and the copy needs a deferred-constraint strategy, which is a design
// decision, not something to paper over with an arbitrary order.
function loadOrder(catalog) {
  const inScope = new Set(catalog.tables);
  const deps = new Map([...inScope].map((t) => [t, new Set()]));
  for (const { child, parent } of catalog.fks) {
    if (!inScope.has(child) || !inScope.has(parent) || child === parent) continue;
    deps.get(child).add(parent);
  }
  const ordered = [];
  const placed = new Set();
  while (ordered.length < inScope.size) {
    const ready = [...inScope]
      .filter((t) => !placed.has(t) && [...deps.get(t)].every((p) => placed.has(p)))
      .sort();
    if (ready.length === 0) {
      const stuck = [...inScope].filter((t) => !placed.has(t));
      fail('schema', `the foreign-key graph has a cycle among: ${stuck.join(', ')}`);
    }
    for (const t of ready) {
      ordered.push(t);
      placed.add(t);
    }
  }
  return ordered;
}

const columnNames = (catalog, table) => {
  const cols = catalog.columns[table];
  if (!cols) fail('schema', `target has no table public.${table}`);
  return cols.map((c) => c.column_name);
};

const identityColumns = (catalog, table) =>
  (catalog.columns[table] || []).filter((c) => c.is_identity === 'YES').map((c) => c.column_name);

// column -> the target's own declared type, which is what decides how a value is
// encoded on its way in.
const columnTypes = (catalog, table) =>
  Object.fromEntries((catalog.columns[table] || []).map((c) => [c.column_name, c.udt_name]));

// Columns that name a roster row through a real foreign key. The text columns
// that hold a display name (pipeline_events.actor/from_assignee/to_assignee,
// lead_notes.author, saved_searches.author,
// conversation_follow_up_state.updated_by) are provider-independent and copy
// verbatim — they were checked by type, because a text column called `actor` is
// exactly where an id would hide.
const rosterColumns = (catalog, table) =>
  catalog.fks.filter((f) => f.child === table && f.parent === 'team_members')
    .map((f) => f.column_name);

// pg_get_serial_sequence returns text, and setval takes regclass. The cast is
// explicit because the text -> regclass coercion is not implicit in an argument
// position, so leaving it out fails at run time rather than at review.
const sequenceFor = (table, column) =>
  `pg_get_serial_sequence('public.${table}', '${column}')::regclass`;

// --- source (REST) -----------------------------------------------------------

async function sourceRequest(path, headers = {}) {
  const base = env('S28_SOURCE_URL').replace(/\/+$/, '');
  const key = env('S28_SOURCE_KEY');
  const response = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...headers },
  });
  if (!response.ok) {
    fail('source', `source returned ${response.status} for ${path.split('?')[0]}: ${(await response.text()).slice(0, 200)}`);
  }
  return response;
}

async function sourceCount(relation, filters = []) {
  const response = await sourceRequest(`${relation}?${['select=*', ...filters].join('&')}`, {
    Prefer: 'count=exact',
    Range: '0-0',
  });
  const total = Number((response.headers.get('content-range') || '').split('/')[1]);
  if (!Number.isFinite(total)) fail('source', `could not read a count for ${relation}`);
  return total;
}

// Pages every row of a relation as JSON. Used for the parity views, the roster
// and the milestone invariant, where the values are compared rather than loaded.
// `select` and `filters` are separate arguments rather than baked into
// `relation`, because assembling a query string by hand at each call site is how
// a filter silently ends up in the wrong half of the URL.
async function sourceRows(relation, order, select = '*', filters = []) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const query = [`select=${select}`, `order=${order}`, ...filters].join('&');
    const response = await sourceRequest(`${relation}?${query}`, {
      Prefer: 'count=exact',
      Range: `${offset}-${offset + PAGE - 1}`,
    });
    const page = await response.json();
    rows.push(...page);
    const total = Number((response.headers.get('content-range') || '').split('/')[1]);
    if (!Number.isFinite(total) || offset + PAGE >= total) break;
  }
  return rows;
}

// --- encoding -----------------------------------------------------------------
//
// THE SOURCE'S OWN CSV CANNOT BE TRUSTED FOR jsonb, AND THIS IS THE ONE PLACE
// THIS TOOL DELIBERATELY DEPARTS FROM ITS PRECEDENT.
//
// b2_tenant_slice.mjs requests `Accept: text/csv` and states that the source
// "renders every value in the text form COPY reads back, including jsonb.
// Nothing re-encodes a value here." That is false. PostgREST's CSV writer
// backslash-escapes inside the field, and `COPY ... FORMAT csv` does not
// unescape backslashes — so a jsonb string containing a quote arrives as
//
//     source value      [{"body": "Anastasia \"Standart Offering\""}]
//     PostgREST CSV     "[{""body"": ""Anastasia \\""Standart Offering\\""""}]"
//     after COPY csv    [{"body": "Anastasia \\"Standart Offering\\""}]
//                                                ^^ a literal backslash, then a
//                                                   quote that ends the string
//
// which is invalid JSON and aborts the load. Newlines corrupt the same way
// (`\n` becomes `\\n`, a literal backslash and an `n`). It was found by loading
// the real data into a throwaway cluster; it is not theoretical.
//
// The same latent defect is present in b2_tenant_slice.mjs. It never fired there
// because the only jsonb column in its six-table slice is `instances.config`,
// whose values are flat keys with no quote, backslash or newline in them.
//
// So values are fetched as JSON — where the source's own types survive — and this
// tool encodes the CSV it feeds to COPY. Re-encoding explicitly, with the target's
// declared type for each column, is safer than depending on an escaping contract
// that does not hold. 12 jsonb columns and 11 text[] columns depend on it,
// including `leads.raw` and `events.raw`.

// COPY ... FORMAT csv with default options: NULL is an *unquoted* empty field, so
// a quoted empty string is an empty string and not NULL. Every non-null value is
// quoted, and the only in-field escape is a doubled quote.
const csvField = (text) => (text === null ? '' : `"${text.replace(/"/g, '""')}"`);

// A Postgres array literal, not JSON: elements are comma-separated inside braces,
// a quoted element escapes backslash and quote with a backslash, and an unquoted
// bare NULL is the null element. Encoding a text[] as JSON would store the string
// "[\"a\"]" in some rows and fail on others.
function arrayLiteral(values) {
  return `{${values.map((v) => (v === null || v === undefined
    ? 'NULL'
    : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',')}}`;
}

// One JSON value from the source -> the text COPY should read for that column.
// `udt` is the target's own declared type, so the encoding is decided by where the
// value is going rather than by what the JSON happens to look like.
function encodeValue(value, udt, table, column) {
  if (value === null || value === undefined) return null;
  if (udt === '_text') {
    if (!Array.isArray(value)) {
      fail('encoding', `${table}.${column}: expected an array for text[], got ${typeof value}`);
    }
    return arrayLiteral(value);
  }
  if (udt === 'jsonb' || udt === 'json') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    fail('encoding', `${table}.${column}: got an object for ${udt}, which would be silently stringified`);
  }
  return String(value);
}

// Pages a table as JSON and encodes it as CSV for COPY. Returns the row count it
// actually encoded so the caller can assert completeness against the source's own
// total rather than trusting the pager.
async function sourceTableCsv(table, columns, order, udts) {
  const query = [`select=${columns.join(',')}`, `order=${order}`].join('&');
  const lines = [columns.join(',')];
  let rows = 0;

  for (let offset = 0; ; offset += PAGE) {
    // `count=exact` is required, not merely informative: without it the source
    // reports its total as `*`, the loop cannot tell a full page from the last
    // one, and every table over one page silently truncates to its first 1000
    // rows.
    const response = await sourceRequest(`${table}?${query}`, {
      Prefer: 'count=exact',
      Range: `${offset}-${offset + PAGE - 1}`,
    });
    const page = await response.json();
    for (const row of page) {
      const keys = Object.keys(row);
      if (keys.length !== columns.length || keys.some((k) => !columns.includes(k))) {
        fail('schema', `${table}: source returned columns ${keys.join(',')}, target declares ${columns.join(',')}`);
      }
      lines.push(columns.map((c) => csvField(encodeValue(row[c], udts[c], table, c))).join(','));
      rows += 1;
    }
    const total = Number((response.headers.get('content-range') || '').split('/')[1]);
    if (!Number.isFinite(total) || offset + PAGE >= total) break;
  }

  return { csv: `${lines.join('\n')}\n`, rows };
}

// Counts data rows in a CSV, honouring quoting: a row break inside a quoted field
// is data, not a record separator. A naive split on '\n' over-counts every
// message whose body contains a newline, which is most of them.
function countCsvDataRows(text) {
  let rows = 0;
  let inQuotes = false;
  let sawContent = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i += 1;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === '\n') {
      if (sawContent) rows += 1;
      sawContent = false;
    } else if (ch !== '\r') sawContent = true;
  }
  if (sawContent) rows += 1;
  return Math.max(0, rows - 1); // the header is not a data row
}

// --- roster map --------------------------------------------------------------

const rosterPath = (dir) => join(dir, 'roster.map.json');
const manifestPath = (dir) => join(dir, 'migration.manifest.json');

// Builds the source-id -> target-id map by MEASURING both rosters and joining on
// email, never by assuming the invite order held. Ordering the invites so the ids
// land 1:1 is an optimisation; this is the correctness check, and a source
// assignee with no counterpart is refused rather than guessed at or nulled.
//
// The B2 precedent nulled one assignee by decision, because its target already
// held fixture rows in the same identity space. On a dedicated target that
// compromise is unnecessary: every referenced id resolves, or the load fails.
async function cmdRosterMap(dir) {
  if (!dir) fail('usage', 'roster-map needs --out DIR');
  mkdirSync(dir, { recursive: true });

  const source = await sourceRows('team_members', 'id');
  const target = targetJson('SELECT id, name, email, role, active FROM public.team_members ORDER BY id');

  process.stdout.write(`Source roster: ${source.length} rows; target roster: ${target.length} rows\n\n`);

  const byEmail = new Map(
    target.filter((r) => r.email).map((r) => [String(r.email).trim().toLowerCase(), r]),
  );

  const map = {};
  const unresolved = [];
  for (const row of source) {
    const email = row.email ? String(row.email).trim().toLowerCase() : null;
    const match = email ? byEmail.get(email) : undefined;
    if (!match) {
      unresolved.push(`${row.id} (${row.name}, ${row.email || 'no email'})`);
      continue;
    }
    map[String(row.id)] = Number(match.id);
    process.stdout.write(
      `  ${String(row.id).padStart(3)} ${String(row.name).padEnd(14)} -> ${String(match.id).padStart(3)} ${match.name}`
      + `${Number(match.id) === Number(row.id) ? '  (id preserved)' : '  (REMAPPED)'}\n`,
    );
  }

  process.stdout.write('\n');
  // Only ids that are actually referenced have to resolve. A roster row nobody
  // points at can be absent from the target without costing any attribution, and
  // failing over it would block the migration on a person who left.
  const referenced = await referencedRosterIds();
  process.stdout.write(`Roster ids referenced by business rows: ${[...referenced].sort((a, b) => a - b).join(', ')}\n`);

  const missing = [...referenced].filter((id) => map[String(id)] === undefined);
  check(`every referenced roster id resolves (${referenced.size} referenced)`, missing.length === 0,
    `unresolved: ${missing.join(', ')}`);
  if (unresolved.length > 0) {
    process.stdout.write(`  note: ${unresolved.length} source roster row(s) have no target counterpart and are not referenced: ${unresolved.join('; ')}\n`);
  }

  if (failures > 0) {
    process.stdout.write('\nThe map was NOT written. Invite the missing teammates, then re-run.\n');
    return 1;
  }

  writeFileSync(rosterPath(dir), `${JSON.stringify({
    builtAt: new Date().toISOString(),
    sourceIdToTargetId: map,
    referenced: [...referenced].sort((a, b) => a - b),
  }, null, 2)}\n`);
  process.stdout.write(`\nWrote ${rosterPath(dir)}\n`);
  return 0;
}

// Every distinct roster id any business row actually points at, read from the
// source through the FK columns the target catalog declares.
async function referencedRosterIds() {
  const catalog = readCatalog();
  const referenced = new Set();
  for (const table of catalog.tables) {
    for (const column of rosterColumns(catalog, table)) {
      const rows = await sourceRows(table, column, column, [`${column}=not.is.null`]);
      for (const row of rows) {
        if (row[column] !== null && row[column] !== undefined) referenced.add(Number(row[column]));
      }
    }
  }
  return referenced;
}

// --- extract -----------------------------------------------------------------

async function cmdExtract(dir) {
  if (!dir) fail('usage', 'extract needs --out DIR');
  mkdirSync(dir, { recursive: true });

  const catalog = readCatalog();
  const order = loadOrder(catalog);
  process.stdout.write(`Extracting ${order.length} tables in dependency order\n`);
  process.stdout.write(`  (skipped, rebuilt by the identity layer or per notebook: ${[...SKIP_TABLES].join(', ')})\n\n`);

  // The watermark is recorded BEFORE the first read, so anything a sync writes
  // during the extract falls after it and the delta pass will find it. Recording
  // it afterwards would leave a window that looks copied and is not.
  const watermark = new Date().toISOString();
  const manifest = { watermark, extractedTables: [], loadOrder: order };
  let total = 0;

  for (const table of order) {
    const columns = columnNames(catalog, table);
    const pk = catalog.pks[table];
    if (!pk) fail('schema', `public.${table} has no primary key; paging cannot be made deterministic`);
    const declared = await sourceCount(table);
    const { csv, rows: encoded } = await sourceTableCsv(table, columns, pk.join(','), columnTypes(catalog, table));
    // Three numbers that must agree, and each catches a different failure: the
    // source's own `count=exact` total, the rows this tool actually encoded (a
    // truncating pager), and the rows a CSV reader finds in the emitted text (an
    // encoder that produced an unbalanced quote, which would otherwise surface as
    // a baffling COPY error thousands of lines in).
    const written = countCsvDataRows(csv);
    if (encoded !== declared || written !== declared) {
      fail('source', `${table}: the source counted ${declared} rows, ${encoded} were encoded, and the CSV holds ${written}`);
    }
    writeFileSync(join(dir, `${table}.csv`), csv);
    manifest.extractedTables.push({ table, columns, pk, rows: declared });
    total += declared;
    process.stdout.write(`  ${table.padEnd(30)} ${String(declared).padStart(7)} rows\n`);
  }

  // The milestone invariant needs the source's own answer, captured at extract
  // time, so `verify` can prove nothing regressed even if the source has moved on.
  const leadMilestones = await sourceRows('leads', 'id', ['id', ...MILESTONES].join(','));
  writeFileSync(join(dir, 'lead_milestones.json'), `${JSON.stringify(leadMilestones)}\n`);

  manifest.totalRows = total;
  manifest.leadMilestones = leadMilestones.length;
  writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(`\n  total ${total} rows\n  watermark ${watermark}\n`);
  process.stdout.write(`  captured milestones for ${leadMilestones.length} leads\n`);
  return 0;
}

// --- load --------------------------------------------------------------------

// Rows arrive through a temp staging table rather than straight into the target,
// for two reasons: the roster remap must happen before the row exists (an UPDATE
// afterwards would fire the touch_*_updated_at triggers and rewrite a copied
// value), and staging lets the load assert what it received before it commits.
function loadSql(dir, manifest, roster, catalog) {
  const chunks = ['BEGIN;', 'SET ROLE app_owner;', "SET LOCAL app.actor_id = '';"];
  const mapEntries = Object.entries(roster.sourceIdToTargetId);

  // Refuse before copying anything rather than after. A row already present means
  // this load is running a second time; on a dedicated target that is never a
  // reason to re-key — b2 re-keyed because its target legitimately held other rows
  // in the same identity space — so abort and let `rollback` be the way back.
  // Checked up front so a 27k-row copy is not paid for before the refusal.
  for (const table of manifest.loadOrder) {
    chunks.push(
      `DO $$ DECLARE existing bigint; BEGIN
         SELECT count(*) INTO existing FROM public.${table};
         IF existing > 0 THEN
           RAISE EXCEPTION 's28: public.${table} already holds % rows; run rollback --confirm first', existing;
         END IF;
       END $$;`,
    );
  }

  for (const table of manifest.loadOrder) {
    const entry = manifest.extractedTables.find((t) => t.table === table);
    if (!entry) fail('usage', `${table} is in the load order but not in the manifest`);
    if (entry.rows === 0) continue;

    const csv = readFileSync(join(dir, `${table}.csv`), 'utf8');
    const cols = entry.columns.map((c) => `"${c}"`).join(', ');
    const stage = `s28_stage_${table}`;
    const identity = identityColumns(catalog, table);
    const roles = rosterColumns(catalog, table);
    // LIKE without INCLUDING IDENTITY gives a plain column, so staging accepts
    // the real values; the override is needed only on the insert into the table.
    const overriding = identity.length > 0 ? ' OVERRIDING SYSTEM VALUE' : '';

    chunks.push(`CREATE TEMP TABLE ${stage} (LIKE public.${table}) ON COMMIT DROP;`);
    chunks.push(`COPY ${stage} (${cols}) FROM STDIN WITH (FORMAT csv, HEADER true);`);
    chunks.push(csv.endsWith('\n') ? csv.slice(0, -1) : csv);
    chunks.push('\\.');

    let select = entry.columns.map((c) => `"${c}"`).join(', ');
    if (roles.length > 0) {
      const known = mapEntries.map(([from]) => from).join(', ');
      for (const column of roles) {
        // An assignee the map does not know means the roster moved and the map is
        // stale. Refuse the whole load rather than invent or drop an attribution.
        chunks.push(
          `DO $$ DECLARE unknown_count int; BEGIN
             SELECT count(*) INTO unknown_count FROM ${stage}
               WHERE ${column} IS NOT NULL AND ${column} NOT IN (${known});
             IF unknown_count > 0 THEN
               RAISE EXCEPTION 's28: % staged ${table} rows carry ${column} outside the roster map', unknown_count;
             END IF;
           END $$;`,
        );
      }
      const cases = mapEntries.map(([from, to]) => `WHEN ${Number(from)} THEN ${Number(to)}::bigint`).join(' ');
      select = entry.columns.map((c) => (roles.includes(c)
        ? `CASE "${c}" ${cases} ELSE NULL::bigint END AS "${c}"`
        : `"${c}"`)).join(', ');
      chunks.push(`DO $$ BEGIN RAISE NOTICE 's28: ${table} — remapped ${roles.join(', ')} through the roster map'; END $$;`);
    }

    chunks.push(`INSERT INTO public.${table} (${cols})${overriding} SELECT ${select} FROM ${stage};`);

    // Leave the generator past every value just inserted, or the next real write
    // to this table collides with a copied row.
    for (const column of identity) {
      chunks.push(
        `SELECT setval(${sequenceFor(table, column)},
           GREATEST((SELECT coalesce(max("${column}"), 0) FROM public.${table}), 1));`,
      );
    }
  }

  return chunks;
}

function cmdLoad(dir, dryRun, emitSqlTo) {
  if (!dir) fail('usage', 'load needs --in DIR');
  if (!existsSync(manifestPath(dir))) fail('usage', `no migration.manifest.json in ${dir}; run extract first`);
  if (!existsSync(rosterPath(dir))) fail('usage', `no roster.map.json in ${dir}; run roster-map first`);
  const manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8'));
  const roster = JSON.parse(readFileSync(rosterPath(dir), 'utf8'));
  const catalog = readCatalog();

  // Refused here, before a single byte of the 8MB statement stream is generated,
  // so the overwhelmingly common mistake — running `load` twice — costs one
  // round trip and says exactly what is wrong. The in-transaction guard below is
  // kept as well: it is the one that holds if something writes between this check
  // and the COPY.
  const occupied = Object.entries(targetCounts(catalog, manifest.loadOrder))
    .filter(([, n]) => n > 0);
  if (occupied.length > 0) {
    fail('target', `the target already holds rows in ${occupied.map(([t, n]) => `${t} (${n})`).join(', ')}`
      + '; run `rollback --confirm` first');
  }

  process.stdout.write(
    `${dryRun ? 'DRY RUN: loading and rolling back' : 'Loading'} ${manifest.totalRows} rows into the target, in one transaction\n`,
  );
  if (dryRun) {
    process.stdout.write('  nothing will be committed; this proves the copy applies cleanly\n');
  }

  const chunks = loadSql(dir, manifest, roster, catalog);
  chunks.push(dryRun ? 'ROLLBACK;' : 'COMMIT;');
  const sql = `${chunks.join('\n')}\n`;

  // Emitting the statement stream is not a debugging afterthought: this is the
  // one command that writes 27k rows to a live database, and being able to read
  // exactly what it will run — before it runs — is the difference between
  // reviewing a copy and trusting one.
  if (emitSqlTo) {
    writeFileSync(emitSqlTo, sql);
    process.stdout.write(`  wrote ${sql.length} bytes of SQL to ${emitSqlTo}\n`);
  }

  psql(sql);

  if (dryRun) {
    process.stdout.write('\nDry run applied and rolled back cleanly.\n');
    return 0;
  }

  const after = targetCounts(catalog, manifest.loadOrder);
  process.stdout.write('\nRows now in the target\n');
  for (const entry of manifest.extractedTables) {
    check(`${entry.table}: ${entry.rows} extracted, ${after[entry.table]} loaded`,
      after[entry.table] === entry.rows);
  }
  return failures === 0 ? 0 : 1;
}

// --- counts and verify -------------------------------------------------------

function targetCounts(catalog, tables) {
  const union = tables
    .map((t) => `SELECT '${t}' AS t, count(*) AS n FROM public.${t}`)
    .join(' UNION ALL ');
  return Object.fromEntries(targetJson(union).map((r) => [r.t, Number(r.n)]));
}

async function cmdCounts() {
  const catalog = readCatalog();
  const order = loadOrder(catalog);
  const target = targetCounts(catalog, order);

  process.stdout.write('table                            source   target   delta\n');
  let sourceTotal = 0;
  let targetTotal = 0;
  for (const table of order) {
    const n = await sourceCount(table);
    sourceTotal += n;
    targetTotal += target[table];
    const delta = target[table] - n;
    process.stdout.write(
      `${table.padEnd(30)} ${String(n).padStart(7)}  ${String(target[table]).padStart(7)}  ${delta === 0 ? '     .' : String(delta).padStart(6)}\n`,
    );
  }
  process.stdout.write(`${'TOTAL'.padEnd(30)} ${String(sourceTotal).padStart(7)}  ${String(targetTotal).padStart(7)}  ${String(targetTotal - sourceTotal).padStart(6)}\n`);
  return 0;
}

// Values are compared as strings after normalising the two shapes a JSON reader
// and a SQL reader legitimately disagree about: numeric types, and the trailing
// precision of a timestamp. A real difference in a count or a rate survives both.
function normalise(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (/^-?\d+(\.\d+)?$/.test(value)) return String(Number(value));
    const asDate = /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(value) ? new Date(value) : null;
    if (asDate && !Number.isNaN(asDate.getTime())) return asDate.toISOString();
  }
  return String(value);
}

// Matches rows by the view's grain, never by position. Two databases can hold
// identical data and still enumerate it in different orders — text collation is
// the usual reason — and a positional comparison reports that as data corruption.
// Keying also makes a genuinely missing or extra row say so, instead of shifting
// every subsequent row and reporting hundreds of false differences.
function compareRows(label, sourceRowsIn, targetRowsIn, keyColumns) {
  const keyOf = (row) => keyColumns.map((c) => String(normalise(row[c]))).join(' ');
  const sourceByKey = new Map(sourceRowsIn.map((r) => [keyOf(r), r]));
  const targetByKey = new Map(targetRowsIn.map((r) => [keyOf(r), r]));

  check(`${label}: ${sourceRowsIn.length} rows on the source, ${targetRowsIn.length} on the target`,
    sourceRowsIn.length === targetRowsIn.length);
  check(`${label}: the grain ${keyColumns.join('+')} is unique on both sides`,
    sourceByKey.size === sourceRowsIn.length && targetByKey.size === targetRowsIn.length,
    `${sourceRowsIn.length - sourceByKey.size} duplicate source keys, ${targetRowsIn.length - targetByKey.size} on the target`);

  const missing = [...sourceByKey.keys()].filter((k) => !targetByKey.has(k));
  const extra = [...targetByKey.keys()].filter((k) => !sourceByKey.has(k));
  check(`${label}: every source row has a counterpart`, missing.length === 0 && extra.length === 0,
    `${missing.length} missing, ${extra.length} unexpected; e.g. ${[...missing, ...extra].slice(0, 3).map((k) => k.replace(/ /g, '|')).join(', ')}`);

  let mismatches = 0;
  const examples = [];
  for (const [key, sourceRow] of sourceByKey) {
    const targetRow = targetByKey.get(key);
    if (!targetRow) continue;
    for (const column of Object.keys(sourceRow)) {
      const a = normalise(sourceRow[column]);
      const b = normalise(targetRow[column]);
      if (a !== b) {
        mismatches += 1;
        if (examples.length < 5) {
          examples.push(`${key.replace(/ /g, '|')} ${column}: source ${a} vs target ${b}`);
        }
      }
    }
  }
  check(`${label}: every cell agrees`, mismatches === 0,
    `${mismatches} differing cells; ${examples.join('; ')}`);
}

async function cmdVerify(dir) {
  const catalog = readCatalog();
  const order = loadOrder(catalog);

  process.stdout.write('Row counts, source against target\n');
  const target = targetCounts(catalog, order);
  for (const table of order) {
    const n = await sourceCount(table);
    check(`${table}: source ${n}, target ${target[table]}`, n === target[table]);
  }

  // Parity is computed from the two sides' own aggregate views rather than from
  // the extract. Comparing the extract to the load would only prove the copier is
  // self-consistent; this compares the number the dashboard would show.
  for (const view of PARITY_VIEWS) {
    process.stdout.write(`\n${view.name}\n`);
    const sourceView = await sourceRows(view.name, view.order);
    const targetView = targetJson(
      `SELECT * FROM public.${view.name} ORDER BY ${view.order}`,
    );
    compareRows(view.name, sourceView, targetView, view.keys);
  }

  // Per-column NULL counts, both sides, every column of every table. This is the
  // generic net under the encoder: a jsonb `null` coerced to SQL NULL, an empty
  // string read as NULL, an array that arrived as a string — none of those change
  // a row count and most do not change a funnel view, but all of them move a NULL
  // count. It is the check that would have caught the CSV escaping defect as data
  // loss rather than as a load failure, had the load not aborted first.
  process.stdout.write('\nper-column NULL counts\n');
  let nullDrift = 0;
  const nullExamples = [];
  for (const table of order) {
    const columns = columnNames(catalog, table);
    // One query per table, not one per column. Every target query is a process
    // spawn, so 305 of them serialised is minutes of wall clock for work the
    // database does in a single scan.
    const targetNulls = targetJson(
      `SELECT ${columns.map((c) => `count(*) FILTER (WHERE "${c}" IS NULL) AS "${c}"`).join(', ')}
         FROM public.${table}`,
    )[0];
    // The source has no such batching — PostgREST answers one count per request —
    // so these run with bounded concurrency instead of one at a time.
    const sourceNulls = {};
    for (let i = 0; i < columns.length; i += 8) {
      const batch = columns.slice(i, i + 8);
      const counts = await Promise.all(batch.map((c) => sourceCount(table, [`${c}=is.null`])));
      batch.forEach((c, at) => { sourceNulls[c] = counts[at]; });
    }
    for (const column of columns) {
      if (sourceNulls[column] !== Number(targetNulls[column])) {
        nullDrift += 1;
        if (nullExamples.length < 8) {
          nullExamples.push(`${table}.${column}: source ${sourceNulls[column]} vs target ${Number(targetNulls[column])}`);
        }
      }
    }
  }
  check('every column has the same NULL count on both sides', nullDrift === 0,
    `${nullDrift} columns differ; ${nullExamples.join('; ')}`);

  // The invariant CLAUDE.md and trigger leads_keep_milestones both exist for: a
  // milestone that was set must never read as NULL afterwards. Checked per lead
  // against the source's own answer captured at extract time, so a source that
  // has moved on cannot mask a regression.
  process.stdout.write('\nmilestone timestamps — none regressed to NULL\n');
  const captured = dir && existsSync(join(dir, 'lead_milestones.json'))
    ? JSON.parse(readFileSync(join(dir, 'lead_milestones.json'), 'utf8'))
    : await sourceRows('leads', 'id', ['id', ...MILESTONES].join(','));
  const targetLeads = new Map(targetJson(
    `SELECT id::text AS id, ${MILESTONES.join(', ')} FROM public.leads`,
  ).map((r) => [r.id, r]));

  let regressed = 0;
  let absent = 0;
  const examples = [];
  for (const lead of captured) {
    const row = targetLeads.get(String(lead.id));
    if (!row) {
      absent += 1;
      continue;
    }
    for (const column of MILESTONES) {
      if (lead[column] !== null && lead[column] !== undefined && (row[column] === null || row[column] === undefined)) {
        regressed += 1;
        if (examples.length < 5) examples.push(`lead ${lead.id} ${column}`);
      }
    }
  }
  check(`every source lead is present on the target (${captured.length} checked)`, absent === 0,
    `${absent} missing`);
  check('no milestone regressed to NULL', regressed === 0,
    `${regressed} regressions; ${examples.join(', ')}`);

  process.stdout.write(`\nParity: ${checks - failures} passed, ${failures} failed\n`);
  return failures === 0 ? 0 : 1;
}

// --- rollback ----------------------------------------------------------------

// The way back from a load. On a dedicated target this can be total, which is
// simpler and safer than B2's scoped delete: there is no other data to preserve
// by construction, so nothing has to be matched by a scope predicate that could
// be wrong.
//
// The identity layer is deliberately NOT rolled back. Gate 2's invites are real
// accounts with real passwords the teammates have set; discarding them to undo a
// data load would turn a reversible step into an irreversible one.
function cmdRollback(confirmed) {
  if (!confirmed) fail('usage', 'rollback needs --confirm');
  const catalog = readCatalog();
  const order = loadOrder(catalog);
  const before = targetCounts(catalog, order);

  const statements = [...order].reverse().map((t) => `DELETE FROM public.${t};`);
  for (const table of order) {
    for (const column of identityColumns(catalog, table)) {
      statements.push(`SELECT setval(${sequenceFor(table, column)}, 1, false);`);
    }
  }

  psql(asOwner(`BEGIN;\nSET LOCAL app.actor_id = '';\n${statements.join('\n')}\nCOMMIT;\n`));
  const after = targetCounts(catalog, order);

  process.stdout.write('Rollback — business tables emptied, identity left intact\n');
  for (const table of order) {
    check(`${table}: ${before[table]} removed, ${after[table]} left`, after[table] === 0);
  }
  process.stdout.write(`\nRoster and identity rows were not touched.\n`);
  return failures === 0 ? 0 : 1;
}

// --- entry point -------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const at = rest.indexOf(name);
  return at === -1 ? undefined : rest[at + 1];
};

try {
  let code = 2;
  if (command === 'counts') code = await cmdCounts();
  else if (command === 'roster-map') code = await cmdRosterMap(flag('--out'));
  else if (command === 'extract') code = await cmdExtract(flag('--out'));
  else if (command === 'load') code = cmdLoad(flag('--in'), rest.includes('--dry-run'), flag('--emit-sql'));
  else if (command === 'verify') code = await cmdVerify(flag('--in'));
  else if (command === 'rollback') code = cmdRollback(rest.includes('--confirm'));
  else {
    process.stderr.write('usage: s28_owner_migration.mjs counts|roster-map|extract|load|verify|rollback\n');
  }
  process.exit(code);
} catch (error) {
  if (error instanceof S28Error) {
    process.stderr.write(`s28 error [${error.code}]: ${error.message}\n`);
    process.exit(error.code === 'usage' || error.code === 'environment' ? 2 : 1);
  }
  throw error;
}
