#!/usr/bin/env node
// B2 — the bounded tenant-data slice: extract, load, verify parity, delete.
//
// This tool is deliberately NOT part of the portable baseline set. The portable
// artifacts in postgres/tenant-baseline/v1 must not name or depend on any
// provider surface; this tool exists precisely to bridge two providers, so it
// names a source REST endpoint and a target SQL database. That is why it is not
// listed in S08_ARTIFACTS in the static assertions and is not swept for provider
// markers there: it would fail that sweep by doing its job. It is still swept
// for credentials and resource identifiers, by hand, and it contains neither —
// every endpoint, key and connection string arrives from the environment.
//
// The scope below is the written scope G2 requires ("which tables, which
// instance, how many rows, and how the copy is deleted afterwards"). It is a
// constant rather than a flag so that the approved slice and the code that
// copies it cannot drift apart, and so `delete` removes exactly what `load`
// wrote.
//
// Usage:
//   node postgres/tools/b2_tenant_slice.mjs extract --out DIR
//   node postgres/tools/b2_tenant_slice.mjs load    --in  DIR
//   node postgres/tools/b2_tenant_slice.mjs verify  [--in DIR]
//   node postgres/tools/b2_tenant_slice.mjs delete  --confirm
//   node postgres/tools/b2_tenant_slice.mjs counts
//
// Environment:
//   B2_SOURCE_URL  base URL of the source REST endpoint
//   B2_SOURCE_KEY  bearer credential for the source
//   B2_PSQL        psql invocation for the target (default "psql")
//   B2_DB          target database name (default "postgres")
//   B2_APPLY_USER  target login (default "app_migration"; reads SET ROLE app_owner)
//
// Exit codes: 0 success, 1 a check failed, 2 usage/environment error.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// --- the approved scope ------------------------------------------------------

// Approved by the owner on 2026-08-05, confirming the starting scope G2 proposed
// but did not approve (owner_decision.items[1]).
const SCOPE = {
  approvedOn: '2026-08-05',
  instance: 'notebook-1',
  // Retired test campaign. Migration 038 already removed it from the source, so
  // this exclusion is satisfied by construction; it is still applied, because a
  // scope that only holds while a separate migration holds is not a scope.
  excludedCampaigns: ['notebook-1:4'],
  // The ceiling the owner approved. Measured: 1 + 4 + 66 + 1713 + 3702 + 2553.
  rowCeiling: 8039,
  // Copy verbatim. The owner was offered deterministic surrogates for
  // messages.body, leads.full_name and leads.headline and declined them, so no
  // column is transformed except the assignee remap below.
  pseudonymise: false,
};

// public.team_members.id is a bigint that means DIFFERENT PEOPLE on the two
// sides, and this is the single most dangerous fact in this file.
//
//   id | source                  | target
//   ---+-------------------------+---------------------------------
//    1 | the real admin          | S06 fixture "Active One"
//    2 | a real member           | S06 fixture "Active Two"
//    3 | a real member           | S06 fixture "Inactive Three"
//    4 | a real member           | (free)
//    5 | a real member           | the real admin
//
// Copying leads.assigned_to unchanged would therefore succeed — the foreign key
// is satisfied and every type matches — while silently reassigning real work to
// fixtures. That is the failure mode this map exists to prevent, and it is the
// same one the eventual cutover has to solve for every reference to
// team_members, not just this one column. See N-B2.md.
//
// team_members is not in the approved B2 scope and is not copied, so the only
// sound targets are rows that already exist on the target and denote the same
// person. `null` is a deliberate, recorded loss of attribution for this
// throwaway copy: assigned_to feeds no funnel metric, so parity is unaffected.
// The source keeps the real attribution; it is never written to.
//
// Owner decision, 2026-08-05: remap 1 -> 5 (the same real person), and null the
// assignee that has no counterpart on the target rather than widen the scope by
// a seventh table.
//
// Any source assignee absent from this map fails the load rather than being
// guessed at: an unrecognised assignee means the roster moved and the map is
// stale. Extending it is a scope decision, not a code change.
const ASSIGNEE_REMAP = new Map([
  [1, 5],    // the same real person on both sides
  [3, null], // no counterpart on the target; attribution dropped, by decision
]);

// Load order. Parents first; `delete` walks it backwards.
const TABLES = [
  { name: 'instances', order: 'id', scope: { column: 'id', kind: 'instance' } },
  { name: 'campaigns', order: 'id', scope: { column: 'instance_id', kind: 'instance' }, exclude: 'id' },
  { name: 'campaign_steps', order: 'campaign_id,step_index', scope: { column: 'campaign_id', kind: 'prefix' }, exclude: 'campaign_id' },
  { name: 'leads', order: 'id', scope: { column: 'instance_id', kind: 'instance' }, exclude: 'campaign_id' },
  { name: 'messages', order: 'id', scope: { column: 'instance_id', kind: 'instance' }, exclude: 'campaign_id' },
  { name: 'events', order: 'id', scope: { column: 'instance_id', kind: 'instance' }, exclude: 'campaign_id' },
];

const PAGE = 1000; // the source REST endpoint caps a response at 1000 rows

// --- plumbing ----------------------------------------------------------------

class B2Error extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new B2Error(code, message);
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
  const argv = env('B2_PSQL', 'psql').split(/\s+/).filter(Boolean);
  const result = spawnSync(argv[0], [
    ...argv.slice(1),
    '--no-psqlrc',
    '--quiet',
    '--no-align',
    '--tuples-only',
    '--set', 'ON_ERROR_STOP=1',
    '--username', env('B2_APPLY_USER', 'app_migration'),
    '--dbname', env('B2_DB', 'postgres'),
    ...(csv ? ['--csv'] : []),
  ], { input: sql, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

  if (result.error) fail('psql_unavailable', `could not run ${argv[0]}: ${result.error.message}`);
  if (result.status !== 0) {
    fail('query_failed', (result.stderr || result.stdout || '').trim());
  }
  // Decisions the load makes for itself arrive as notices. Surfacing them is the
  // difference between a copy that reports what it did and one that only reports
  // that it finished.
  for (const line of (result.stderr || '').split('\n')) {
    if (line.startsWith('NOTICE:')) process.stdout.write(`  ${line.replace(/^NOTICE:\s*/, '')}\n`);
  }
  return result.stdout || '';
}

// Every read and write runs as app_owner: app_migration is NOINHERIT, and
// app_owner owns these tables, so RLS (enabled, not forced) is bypassed.
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

// The column list is taken from the target and then demanded of the source, so a
// schema that has drifted apart fails loudly at extract rather than quietly
// dropping a column.
function targetColumns(table) {
  const rows = targetJson(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='${table}'
      ORDER BY ordinal_position`,
  );
  if (rows.length === 0) fail('schema', `target has no table public.${table}`);
  return rows.map((r) => r.column_name);
}

// messages.id and events.id are GENERATED ALWAYS identity columns. Their real
// values have to survive the copy — they are the rows' identity on the source,
// and a re-keyed copy could not be compared to it — so the insert overrides the
// generator and the sequence is moved past the copied maximum afterwards. This
// is discovered from the catalog rather than hardcoded: a table that gains an
// identity column later must not silently start re-keying.
function targetIdentityColumns(table) {
  return targetJson(
    `SELECT column_name, pg_get_serial_sequence('public.${table}', column_name) AS sequence
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='${table}' AND is_identity='YES'`,
  );
}

// --- source (REST) -----------------------------------------------------------

function sourceFilters(table) {
  const parts = [];
  const { scope, exclude } = table;
  if (scope.kind === 'instance') parts.push(`${scope.column}=eq.${SCOPE.instance}`);
  else parts.push(`${scope.column}=like.${SCOPE.instance}:*`);
  for (const excluded of SCOPE.excludedCampaigns) {
    if (exclude) parts.push(`or=(${exclude}.is.null,${exclude}.neq.${excluded})`);
  }
  return parts;
}

async function sourceRequest(path, headers = {}) {
  const base = env('B2_SOURCE_URL').replace(/\/+$/, '');
  const key = env('B2_SOURCE_KEY');
  const response = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...headers },
  });
  if (!response.ok) {
    fail('source', `source returned ${response.status} for ${path.split('?')[0]}: ${(await response.text()).slice(0, 200)}`);
  }
  return response;
}

async function sourceCount(table) {
  const query = [...sourceFilters(table), 'select=' + (table.order.split(',')[0])].join('&');
  const response = await sourceRequest(`${table.name}?${query}`, {
    Prefer: 'count=exact',
    Range: '0-0',
  });
  const range = response.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  if (!Number.isFinite(total)) fail('source', `could not read a count for ${table.name}`);
  return total;
}

// CSV is requested rather than JSON so the source renders every value in the
// text form COPY reads back, including jsonb. Nothing re-encodes a value here.
async function sourceCsv(table, columns) {
  const query = [
    ...sourceFilters(table),
    `select=${columns.join(',')}`,
    `order=${table.order}`,
  ].join('&');

  let out = '';
  let header = null;
  for (let offset = 0; ; offset += PAGE) {
    // `count=exact` is required, not merely informative: without it the source
    // reports its total as `*`, the loop cannot tell a full page from the last
    // one, and every table over one page silently truncates to its first 1000
    // rows. That is exactly what happened the first time this ran.
    const response = await sourceRequest(`${table.name}?${query}`, {
      Accept: 'text/csv',
      Prefer: 'count=exact',
      Range: `${offset}-${offset + PAGE - 1}`,
    });
    const body = await response.text();
    if (!body.trim()) break;
    const newline = body.indexOf('\n');
    const thisHeader = newline === -1 ? body : body.slice(0, newline);
    const rows = newline === -1 ? '' : body.slice(newline + 1);
    if (header === null) {
      header = thisHeader;
      out = `${header}\n`;
    } else if (thisHeader.trim() !== header.trim()) {
      fail('source', `${table.name}: the column header changed between pages`);
    }
    out += rows.endsWith('\n') || rows === '' ? rows : `${rows}\n`;
    const range = response.headers.get('content-range') || '';
    const total = Number(range.split('/')[1]);
    if (!Number.isFinite(total) || offset + PAGE >= total) break;
  }
  if (header === null) fail('source', `${table.name}: the source returned nothing at all`);

  const expected = header.trim().split(',').map((c) => c.replace(/^"|"$/g, ''));
  if (expected.join(',') !== columns.join(',')) {
    fail('schema', `${table.name}: source columns ${expected.join(',')} do not match target ${columns.join(',')}`);
  }
  return out;
}

// Counts data rows in a CSV, honouring quoting: a row break inside a quoted
// field is data, not a record separator. A naive split on '\n' over-counts every
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

// --- commands ----------------------------------------------------------------

const manifestPath = (dir) => join(dir, 'slice.manifest.json');

async function cmdExtract(dir) {
  if (!dir) fail('usage', 'extract needs --out DIR');
  mkdirSync(dir, { recursive: true });
  process.stdout.write(`Extracting the approved slice (instance ${SCOPE.instance}, ceiling ${SCOPE.rowCeiling} rows)\n`);

  const manifest = { scope: SCOPE, extractedTables: [] };
  let total = 0;

  for (const table of TABLES) {
    const columns = targetColumns(table.name);
    const declared = await sourceCount(table);
    const csv = await sourceCsv(table, columns);
    // The extract asserts its own completeness rather than trusting the pager.
    // A message body legitimately contains newlines, so the rows are counted
    // with the quoting rules rather than by splitting on '\n'.
    const written = countCsvDataRows(csv);
    if (written !== declared) {
      fail('source', `${table.name}: the source counted ${declared} rows but the extract holds ${written}`);
    }
    writeFileSync(join(dir, `${table.name}.csv`), csv);
    manifest.extractedTables.push({ table: table.name, columns, rows: declared });
    total += declared;
    process.stdout.write(`  ${table.name.padEnd(15)} ${String(declared).padStart(6)} rows\n`);
  }

  manifest.totalRows = total;
  writeFileSync(manifestPath(dir), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(`\n  total ${total} rows (ceiling ${SCOPE.rowCeiling})\n`);
  if (total > SCOPE.rowCeiling) {
    fail('scope', `the extract is ${total} rows, above the approved ceiling of ${SCOPE.rowCeiling}`);
  }
  return 0;
}

// Rows arrive through a temp staging table rather than straight into the target,
// for two reasons: the assignee remap must happen before the row exists (an
// UPDATE afterwards would fire touch_leads_updated_at and rewrite a copied
// value), and staging lets the load assert what it received before it commits.
function loadSql(dir, manifest) {
  const chunks = ['BEGIN;', 'SET ROLE app_owner;', "SET LOCAL app.actor_id = '';"];

  for (const table of TABLES) {
    const entry = manifest.extractedTables.find((t) => t.table === table.name);
    const csv = readFileSync(join(dir, `${table.name}.csv`), 'utf8');
    const cols = entry.columns.map((c) => `"${c}"`).join(', ');
    const stage = `b2_stage_${table.name}`;
    const identity = targetIdentityColumns(table.name);
    // LIKE without INCLUDING IDENTITY gives a plain column, so staging accepts
    // the real values; the override is needed only on the insert into the table.
    const overriding = identity.length > 0 ? ' OVERRIDING SYSTEM VALUE' : '';

    chunks.push(`CREATE TEMP TABLE ${stage} (LIKE public.${table.name}) ON COMMIT DROP;`);
    chunks.push(`COPY ${stage} (${cols}) FROM STDIN WITH (FORMAT csv, HEADER true);`);
    chunks.push(csv.endsWith('\n') ? csv.slice(0, -1) : csv);
    chunks.push('\\.');

    if (table.name === 'leads') {
      const cases = [...ASSIGNEE_REMAP.entries()]
        .map(([from, to]) => `WHEN ${from} THEN ${to === null ? 'NULL' : to}::bigint`)
        .join(' ');
      const known = [...ASSIGNEE_REMAP.keys()].join(', ');
      // An assignee the mapping does not know is a stale mapping, not a row to
      // guess at. Refuse the whole load rather than invent an attribution.
      chunks.push(
        `DO $$ DECLARE unknown_count int; BEGIN
           SELECT count(*) INTO unknown_count FROM ${stage}
             WHERE assigned_to IS NOT NULL AND assigned_to NOT IN (${known});
           IF unknown_count > 0 THEN
             RAISE EXCEPTION 'b2: % staged leads carry an assignee outside the approved remap', unknown_count;
           END IF;
         END $$;`,
      );
      const select = entry.columns
        .map((c) => (c === 'assigned_to'
          ? `CASE assigned_to ${cases} ELSE NULL::bigint END AS assigned_to`
          : `"${c}"`))
        .join(', ');
      chunks.push(`INSERT INTO public.${table.name} (${cols})${overriding} SELECT ${select} FROM ${stage};`);
    } else if (identity.length === 1) {
      // The target already holds synthetic fixture rows in the same identity
      // space, and B2's scope does not permit touching them. So the source ids
      // are preserved when they are free and the row is re-keyed when they are
      // not — decided here from the rows actually present, not assumed, and
      // announced eitherway. Nothing has a foreign key to these columns, so a
      // re-keyed row is still the same row for every purpose this copy serves.
      const key = identity[0].column_name;
      const withoutKey = entry.columns.filter((c) => c !== key).map((c) => `"${c}"`).join(', ');
      chunks.push(
        `DO $$ DECLARE collisions bigint; BEGIN
           SELECT count(*) INTO collisions
             FROM ${stage} s JOIN public.${table.name} t ON t."${key}" = s."${key}";
           IF collisions = 0 THEN
             INSERT INTO public.${table.name} (${cols}) OVERRIDING SYSTEM VALUE SELECT ${cols} FROM ${stage};
             RAISE NOTICE 'b2: ${table.name} kept its source ${key} values';
           ELSE
             INSERT INTO public.${table.name} (${withoutKey}) SELECT ${withoutKey} FROM ${stage};
             RAISE NOTICE 'b2: ${table.name} re-keyed; % source ${key} values were already taken by pre-existing rows', collisions;
           END IF;
         END $$;`,
      );
    } else {
      chunks.push(`INSERT INTO public.${table.name} (${cols}) SELECT ${cols} FROM ${stage};`);
    }

    // Leave the generator past every value just inserted, or the next real write
    // to this table collides with a copied row.
    for (const { column_name: column, sequence } of identity) {
      chunks.push(
        `SELECT setval('${sequence}', GREATEST((SELECT coalesce(max("${column}"), 0) FROM public.${table.name}), 1));`,
      );
    }
  }

  chunks.push('COMMIT;');
  return `${chunks.join('\n')}\n`;
}

function cmdLoad(dir) {
  if (!dir) fail('usage', 'load needs --in DIR');
  if (!existsSync(manifestPath(dir))) fail('usage', `no slice.manifest.json in ${dir}; run extract first`);
  const manifest = JSON.parse(readFileSync(manifestPath(dir), 'utf8'));

  const before = targetCounts();
  const occupied = TABLES.filter((t) => before[t.name] > 0);
  if (occupied.length > 0) {
    fail('target', `the slice is already present in ${occupied.map((t) => t.name).join(', ')}; run delete first`);
  }

  process.stdout.write(`Loading ${manifest.totalRows} rows into the target, in one transaction\n`);
  psql(loadSql(dir, manifest));

  const after = targetCounts();
  process.stdout.write('\nRows now in the target, inside the approved scope\n');
  let ok = true;
  for (const entry of manifest.extractedTables) {
    const got = after[entry.table];
    check(`${entry.table}: ${entry.rows} extracted, ${got} loaded`, got === entry.rows);
    ok = ok && got === entry.rows;
  }
  return ok ? 0 : 1;
}

// Counts are always scoped to the approved slice, never to the whole table: the
// target also holds synthetic fixtures under other instances, and a bare
// count(*) would silently mix them into every number this tool prints.
function scopeSql(table) {
  const excluded = SCOPE.excludedCampaigns.map((c) => `'${c}'`).join(', ');
  const base = table.scope.kind === 'instance'
    ? `${table.scope.column} = '${SCOPE.instance}'`
    : `${table.scope.column} LIKE '${SCOPE.instance}:%'`;
  const exclusion = table.exclude
    ? ` AND (${table.exclude} IS NULL OR ${table.exclude} NOT IN (${excluded}))`
    : '';
  return `${base}${exclusion}`;
}

function targetCounts() {
  const union = TABLES
    .map((t) => `SELECT '${t.name}' AS t, count(*) AS n FROM public.${t.name} WHERE ${scopeSql(t)}`)
    .join(' UNION ALL ');
  const rows = targetJson(union);
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]));
}

async function cmdCounts() {
  const target = targetCounts();
  process.stdout.write('table            source  target\n');
  let sourceTotal = 0;
  let targetTotal = 0;
  for (const table of TABLES) {
    const n = await sourceCount(table);
    sourceTotal += n;
    targetTotal += target[table.name];
    process.stdout.write(`${table.name.padEnd(15)} ${String(n).padStart(6)}  ${String(target[table.name]).padStart(6)}\n`);
  }
  process.stdout.write(`${'total'.padEnd(15)} ${String(sourceTotal).padStart(6)}  ${String(targetTotal).padStart(6)}\n`);
  return 0;
}

// Parity is deliberately computed from the two sides' own aggregate views —
// campaign_metrics and daily_activity — rather than from the extract. Comparing
// the extract to the load would only prove the copier is self-consistent; this
// compares the number the dashboard would show.
async function cmdVerify() {
  process.stdout.write('Row counts, source against target\n');
  const target = targetCounts();
  for (const table of TABLES) {
    const n = await sourceCount(table);
    check(`${table.name}: source ${n}, target ${target[table.name]}`, n === target[table.name]);
  }

  process.stdout.write('\ncampaign_metrics, per campaign\n');
  const metricRows = await (await sourceRequest(
    `campaign_metrics?instance_id=eq.${SCOPE.instance}&order=campaign_id`,
  )).json();
  const targetMetrics = targetJson(
    `SELECT * FROM public.campaign_metrics WHERE instance_id = '${SCOPE.instance}' ORDER BY campaign_id`,
  );
  compareRows('campaign_metrics', metricRows, targetMetrics, 'campaign_id');

  // daily_activity buckets by day and event type, not by campaign — this is the
  // day-bucket half of the parity claim, and it reads `events`, the one table
  // whose surrogate keys the load had to re-issue. If a re-keyed copy had
  // disturbed anything a metric reads, it would show up here.
  process.stdout.write('\ndaily_activity, per day and event type\n');
  const sourceDays = await (await sourceRequest(
    `daily_activity?instance_id=eq.${SCOPE.instance}&order=day,event_type&limit=20000`,
  )).json();
  const targetDays = targetJson(
    `SELECT * FROM public.daily_activity WHERE instance_id = '${SCOPE.instance}' ORDER BY day, event_type`,
  );
  compareRows('daily_activity', sourceDays, targetDays, 'day');

  process.stdout.write(`\nParity: ${checks - failures} passed, ${failures} failed\n`);
  return failures === 0 ? 0 : 1;
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

function compareRows(label, sourceRows, targetRows, keyColumn) {
  check(`${label}: ${sourceRows.length} rows on the source, ${targetRows.length} on the target`,
    sourceRows.length === targetRows.length);
  const limit = Math.min(sourceRows.length, targetRows.length);
  let mismatches = 0;
  const examples = [];
  for (let i = 0; i < limit; i += 1) {
    for (const column of Object.keys(sourceRows[i])) {
      const a = normalise(sourceRows[i][column]);
      const b = normalise(targetRows[i][column]);
      if (a !== b) {
        mismatches += 1;
        if (examples.length < 5) {
          examples.push(`${keyColumn}=${sourceRows[i][keyColumn]} ${column}: source ${a} vs target ${b}`);
        }
      }
    }
  }
  check(`${label}: every cell agrees`, mismatches === 0, `${mismatches} differing cells; ${examples.join('; ')}`);
}

// The deletion the scope promised. It removes exactly the rows `load` wrote,
// scoped identically, and is idempotent: running it twice deletes nothing the
// second time. It never touches a row outside the approved instance, so the
// synthetic fixtures the target already held are untouched by construction.
function cmdDelete(confirmed) {
  if (!confirmed) fail('usage', 'delete needs --confirm');
  const before = targetCounts();
  const statements = [...TABLES].reverse()
    .map((t) => `DELETE FROM public.${t.name} WHERE ${scopeSql(t)};`);

  // Reversibility includes the generators the load moved forward: wind each one
  // back to the rows that remain, so a deleted copy leaves no trace in the
  // sequence either. With the slice gone, that is the value it held before.
  for (const table of TABLES) {
    for (const { column_name: column, sequence } of targetIdentityColumns(table.name)) {
      statements.push(
        `SELECT setval('${sequence}', GREATEST((SELECT coalesce(max("${column}"), 0) FROM public.${table.name}), 1));`,
      );
    }
  }

  psql(asOwner(`BEGIN;\n${statements.join('\n')}\nCOMMIT;\n`));
  const after = targetCounts();

  process.stdout.write('Deletion, scoped to the approved slice\n');
  for (const table of TABLES) {
    check(`${table.name}: ${before[table.name]} removed, ${after[table.name]} left`, after[table.name] === 0);
  }
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
  if (command === 'extract') code = await cmdExtract(flag('--out'));
  else if (command === 'load') code = cmdLoad(flag('--in'));
  else if (command === 'verify') code = await cmdVerify();
  else if (command === 'delete') code = cmdDelete(rest.includes('--confirm'));
  else if (command === 'counts') code = await cmdCounts();
  else {
    process.stderr.write('usage: b2_tenant_slice.mjs extract|load|verify|delete|counts\n');
  }
  process.exit(code);
} catch (error) {
  if (error instanceof B2Error) {
    process.stderr.write(`b2 error [${error.code}]: ${error.message}\n`);
    process.exit(error.code === 'usage' || error.code === 'environment' ? 2 : 1);
  }
  throw error;
}
