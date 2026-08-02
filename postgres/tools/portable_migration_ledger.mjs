#!/usr/bin/env node
// Provider-neutral migration ledger runner for the portable tenant baseline.
//
// Contract (see postgres/tenant-baseline/v1/ledger.manifest.json):
//   * the manifest declares the canonical order 001 -> 002 -> 003, the SHA-256
//     of every artifact, the apply principal and the role-bootstrap dependency;
//   * app_ledger.applied_migration inside the tenant database is the source of
//     truth for what that database actually received;
//   * a step already recorded with a matching SHA-256 is skipped (idempotent
//     re-apply); every other disagreement is a hard failure;
//   * there are no down migrations.
//
// The runner speaks to PostgreSQL only through psql, invoked as $LEDGER_PSQL
// (default "psql"). Host, port and authentication come from the caller's
// environment or from the wrapper it points at, so no connection string,
// password or provider resource ID is ever stored in this repository.
//
// Usage:
//   node postgres/tools/portable_migration_ledger.mjs apply  [--allow-partial] [--json PATH]
//   node postgres/tools/portable_migration_ledger.mjs verify [--allow-partial] [--json PATH]
//   node postgres/tools/portable_migration_ledger.mjs status [--json PATH]
//
// Exit codes: 0 consistent, 1 drift or apply failure, 2 usage/environment error.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_DIR = join(REPO_DIR, 'postgres', 'tenant-baseline', 'v1');
const MANIFEST_PATH = join(BASELINE_DIR, 'ledger.manifest.json');

const PSQL = process.env.LEDGER_PSQL || 'psql';
const DB = process.env.LEDGER_DB || 'postgres';
const APPLY_USER = process.env.LEDGER_APPLY_USER || 'app_migration';

class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new LedgerError(code, message);
}

// --- psql plumbing -----------------------------------------------------------

function psql(sql, { user = APPLY_USER } = {}) {
  const argv = PSQL.split(/\s+/).filter(Boolean);
  const result = spawnSync(argv[0], [
    ...argv.slice(1),
    '--no-psqlrc',
    '--quiet',
    '--no-align',
    '--tuples-only',
    '--set', 'ON_ERROR_STOP=1',
    '--username', user,
    '--dbname', DB,
  ], { input: sql, encoding: 'utf8' });

  if (result.error) {
    fail('psql_unavailable', `could not run ${argv[0]}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    return { ok: false, stdout: result.stdout || '', stderr: detail };
  }
  return { ok: true, stdout: result.stdout || '', stderr: (result.stderr || '').trim() };
}

// Every read runs under SET ROLE app_owner: app_migration is NOINHERIT and the
// ledger is granted to nobody but its owner.
function queryJson(sql, { user = APPLY_USER, asOwner = true } = {}) {
  const prologue = asOwner ? 'SET ROLE app_owner;\n' : '';
  const wrapped = `${prologue}SELECT coalesce(json_agg(row_to_json(q)), '[]'::json)::text FROM (\n${sql}\n) q;\n`;
  const result = psql(wrapped, { user });
  if (!result.ok) {
    fail('query_failed', `query failed: ${result.stderr}`);
  }
  const text = result.stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    fail('query_failed', `could not parse query result: ${text.slice(0, 200)}`);
  }
  return [];
}

function scalar(sql, { user = APPLY_USER, asOwner = false } = {}) {
  const rows = queryJson(`SELECT (${sql}) AS v`, { user, asOwner });
  return rows.length ? rows[0].v : null;
}

// --- manifest and artifact integrity ----------------------------------------

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function loadManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (error) {
    fail('manifest_unreadable', `could not read ${MANIFEST_PATH}: ${error.message}`);
  }

  if (manifest.ledger_contract !== 'portable-tenant-baseline-ledger') {
    fail('manifest_unreadable', `unexpected ledger_contract ${manifest.ledger_contract}`);
  }
  if (manifest.down_migrations?.supported !== false) {
    fail('manifest_unreadable', 'manifest must declare down_migrations.supported = false');
  }
  if (manifest.reapply_semantics?.mode !== 'idempotent-skip') {
    fail('manifest_unreadable', 'manifest must declare reapply_semantics.mode = idempotent-skip');
  }

  const steps = manifest.steps || [];
  if (steps.length === 0) {
    fail('manifest_unreadable', 'manifest declares no steps');
  }
  steps.forEach((step, index) => {
    if (step.step !== index + 1) {
      fail(
        'manifest_order_invalid',
        `manifest steps must be a contiguous ascending sequence starting at 1; position ${index + 1} declares step ${step.step}`,
      );
    }
  });

  return manifest;
}

// Repo-side drift: an artifact whose bytes no longer match the manifest.
function verifyArtifactDigests(manifest) {
  const pinned = [
    { role: 'role_bootstrap', ...manifest.role_bootstrap },
    { role: 'ledger_bootstrap', ...manifest.ledger_bootstrap },
    { role: 'restore_window_open', ...manifest.restore_procedure.window_open },
    { role: 'restore_window_close', ...manifest.restore_procedure.window_close },
    ...manifest.steps.map((step) => ({ role: `step ${step.step}`, ...step })),
  ];

  for (const entry of pinned) {
    const path = join(BASELINE_DIR, entry.artifact);
    let actual;
    try {
      actual = sha256(path);
    } catch (error) {
      fail('artifact_missing', `${entry.role}: cannot read ${entry.artifact} (${error.message})`);
    }
    if (actual !== entry.sha256) {
      fail(
        'artifact_sha_mismatch',
        `${entry.role}: ${entry.artifact} has SHA-256 ${actual}, manifest pins ${entry.sha256}`,
      );
    }
  }
}

// --- database-side preconditions --------------------------------------------

function assertApplyPrincipal() {
  const rows = queryJson(
    `SELECT session_user::text AS session_user,
            (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS is_superuser,
            pg_catalog.has_database_privilege(session_user, current_database(), 'CONNECT') AS can_connect`,
    { asOwner: false },
  );
  const row = rows[0] || {};
  if (row.session_user !== APPLY_USER) {
    fail('apply_principal_invalid', `connected as ${row.session_user}, expected ${APPLY_USER}`);
  }
  if (row.is_superuser) {
    fail('apply_principal_invalid', `${APPLY_USER} is a superuser; the baseline must be applied by a non-superuser principal`);
  }
  return row;
}

function assertRoleContract(manifest) {
  const required = manifest.role_bootstrap.required_roles;
  const rows = queryJson(
    `SELECT rolname::text AS rolname, rolsuper, rolbypassrls, rolcanlogin
       FROM pg_roles
      WHERE rolname = ANY (ARRAY[${required.map((r) => `'${r}'`).join(', ')}]::text[])
      ORDER BY rolname`,
    { asOwner: false },
  );
  const present = new Set(rows.map((r) => r.rolname));
  const missing = required.filter((r) => !present.has(r));
  if (missing.length) {
    fail(
      'role_contract_missing',
      `control-plane role bootstrap has not run against this database: missing ${missing.join(', ')}`,
    );
  }
  const privileged = rows.filter((r) => r.rolsuper || r.rolbypassrls).map((r) => r.rolname);
  if (privileged.length) {
    fail('role_contract_missing', `application roles must not be superuser or BYPASSRLS: ${privileged.join(', ')}`);
  }
  return rows;
}

// to_regclass raises rather than returning NULL when the caller lacks USAGE on
// the schema, and app_migration is NOINHERIT, so this probe runs as the owner.
function ledgerPresent() {
  return scalar(`to_regclass('app_ledger.applied_migration') IS NOT NULL`, { asOwner: true }) === true;
}

function readLedger() {
  const applied = queryJson(
    `SELECT step, artifact, sha256, ledger_version, apply_principal::text AS apply_principal,
            apply_role::text AS apply_role, applied_seq
       FROM app_ledger.applied_migration
      ORDER BY applied_seq`,
  );
  const bootstrap = queryJson(
    `SELECT artifact, sha256, ledger_version, required_roles, recorded_by::text AS recorded_by
       FROM app_ledger.role_bootstrap`,
  );
  return { applied, bootstrap: bootstrap[0] || null };
}

// --- drift detection ---------------------------------------------------------

function detectDrift(manifest, ledger) {
  const byStep = new Map(manifest.steps.map((s) => [s.step, s]));
  const applied = ledger.applied;

  // Role-bootstrap dependency.
  if (!ledger.bootstrap) {
    fail('role_bootstrap_missing', 'ledger records no role-bootstrap dependency');
  }
  if (ledger.bootstrap.artifact !== manifest.role_bootstrap.artifact) {
    fail(
      'role_bootstrap_mismatch',
      `ledger records role bootstrap ${ledger.bootstrap.artifact}, manifest declares ${manifest.role_bootstrap.artifact}`,
    );
  }
  if (ledger.bootstrap.sha256 !== manifest.role_bootstrap.sha256) {
    fail(
      'role_bootstrap_sha_mismatch',
      `role bootstrap applied with SHA-256 ${ledger.bootstrap.sha256}, manifest pins ${manifest.role_bootstrap.sha256}`,
    );
  }

  // Unknown, renamed or re-hashed steps.
  for (const row of applied) {
    const expected = byStep.get(row.step);
    if (!expected) {
      fail('ledger_unknown_step', `ledger records step ${row.step} (${row.artifact}), which the manifest does not declare`);
    }
    if (row.artifact !== expected.artifact) {
      fail(
        'ledger_artifact_mismatch',
        `step ${row.step} was applied from ${row.artifact}, manifest declares ${expected.artifact}`,
      );
    }
    if (row.sha256 !== expected.sha256) {
      fail(
        'ledger_sha_mismatch',
        `step ${row.step} was applied with SHA-256 ${row.sha256}, manifest pins ${expected.sha256}`,
      );
    }
    if (row.apply_principal !== manifest.apply_principal.session_user
        || row.apply_role !== manifest.apply_principal.current_user) {
      fail(
        'ledger_principal_invalid',
        `step ${row.step} was applied by ${row.apply_principal}/${row.apply_role}, contract requires `
        + `${manifest.apply_principal.session_user}/${manifest.apply_principal.current_user}`,
      );
    }
  }

  // A skipped step: the applied set must be the contiguous prefix 1..k.
  const steps = applied.map((r) => r.step).sort((a, b) => a - b);
  steps.forEach((step, index) => {
    if (step !== index + 1) {
      fail(
        'ledger_gap',
        `applied steps must form a contiguous prefix starting at 1; found ${JSON.stringify(steps)}`,
      );
    }
  });

  // Applied out of order: arrival order must equal declared order.
  for (let i = 0; i < applied.length; i += 1) {
    if (applied[i].step !== i + 1) {
      fail(
        'ledger_out_of_order',
        `step ${applied[i].step} was applied at position ${i + 1}; the manifest requires `
        + `${manifest.steps.map((s) => s.step).join(' -> ')}`,
      );
    }
  }

  return { appliedSteps: steps, pending: manifest.steps.filter((s) => !steps.includes(s.step)) };
}

// --- apply -------------------------------------------------------------------

function applyLedgerBootstrap(manifest) {
  const path = join(BASELINE_DIR, manifest.ledger_bootstrap.artifact);
  const result = psql(readFileSync(path, 'utf8'));
  if (!result.ok) {
    fail('ledger_bootstrap_failed', `${manifest.ledger_bootstrap.artifact}: ${result.stderr}`);
  }
}

function recordRoleBootstrap(manifest) {
  const roles = manifest.role_bootstrap.required_roles.map((r) => `'${r}'`).join(', ');
  const sql = `SET ROLE app_owner;
INSERT INTO app_ledger.role_bootstrap (artifact, sha256, ledger_version, required_roles)
VALUES ('${manifest.role_bootstrap.artifact}', '${manifest.role_bootstrap.sha256}',
        '${manifest.ledger_version}', ARRAY[${roles}]::text[]);
`;
  const result = psql(sql);
  if (!result.ok) {
    fail('role_bootstrap_record_failed', result.stderr);
  }
}

// One step, one transaction: the artifact and its ledger row commit together or
// not at all, so a half-applied step can never look applied.
function applyStep(manifest, step) {
  const path = join(BASELINE_DIR, step.artifact);
  const body = readFileSync(path, 'utf8');
  const sql = [
    'BEGIN;',
    // 001 predates the role contract and contains no SET ROLE of its own; 002
    // and 003 open with one. Entering the owner role here covers both and keeps
    // app_migration from ever owning an object.
    'SET ROLE app_owner;',
    body,
    // The artifact may have changed role internally; re-assert before recording.
    'SET ROLE app_owner;',
    `INSERT INTO app_ledger.applied_migration (step, artifact, sha256, ledger_version)`,
    `VALUES (${step.step}, '${step.artifact}', '${step.sha256}', '${manifest.ledger_version}');`,
    'COMMIT;',
    '',
  ].join('\n');

  const result = psql(sql);
  if (!result.ok) {
    fail('step_apply_failed', `step ${step.step} (${step.artifact}) failed: ${result.stderr}`);
  }
}

// --- commands ----------------------------------------------------------------

function buildState(manifest, ledger, drift) {
  return {
    ledger_contract: manifest.ledger_contract,
    ledger_version: manifest.ledger_version,
    reapply_semantics: manifest.reapply_semantics.mode,
    down_migrations_supported: manifest.down_migrations.supported,
    declared_steps: manifest.steps.map((s) => ({ step: s.step, artifact: s.artifact, sha256: s.sha256 })),
    role_bootstrap: ledger.bootstrap
      ? { artifact: ledger.bootstrap.artifact, sha256: ledger.bootstrap.sha256 }
      : null,
    applied: ledger.applied.map((r) => ({
      step: r.step,
      artifact: r.artifact,
      sha256: r.sha256,
      apply_principal: r.apply_principal,
      apply_role: r.apply_role,
      applied_seq: Number(r.applied_seq),
    })),
    pending: drift.pending.map((s) => s.step),
    complete: drift.pending.length === 0,
  };
}

function emit(jsonPath, payload) {
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

function main() {
  const [, , command, ...rest] = process.argv;
  const allowPartial = rest.includes('--allow-partial');
  const jsonIndex = rest.indexOf('--json');
  const jsonPath = jsonIndex >= 0 ? rest[jsonIndex + 1] : null;

  if (!['apply', 'verify', 'status'].includes(command)) {
    process.stderr.write('usage: portable_migration_ledger.mjs <apply|verify|status> [--allow-partial] [--json PATH]\n');
    process.exit(2);
  }

  const manifest = loadManifest();
  verifyArtifactDigests(manifest);
  assertApplyPrincipal();
  assertRoleContract(manifest);

  if (command === 'apply') {
    if (!ledgerPresent()) {
      applyLedgerBootstrap(manifest);
      recordRoleBootstrap(manifest);
    }
  } else if (!ledgerPresent()) {
    fail('ledger_missing', 'app_ledger.applied_migration does not exist; this database has no migration ledger');
  }

  let ledger = readLedger();
  let drift = detectDrift(manifest, ledger);

  if (command === 'apply') {
    if (drift.pending.length === 0) {
      process.stdout.write(
        `ledger already at step ${drift.appliedSteps.length}/${manifest.steps.length}; nothing to apply\n`,
      );
    } else {
      for (const step of drift.pending) {
        applyStep(manifest, step);
        process.stdout.write(`applied step ${step.step}: ${step.artifact}\n`);
      }
      ledger = readLedger();
      drift = detectDrift(manifest, ledger);
    }
  }

  const state = buildState(manifest, ledger, drift);

  if (command !== 'status' && !allowPartial && !state.complete) {
    emit(jsonPath, { ...state, ok: false, reason: 'incomplete' });
    process.stderr.write(
      `ledger is incomplete: applied ${state.applied.length}/${manifest.steps.length}, pending ${JSON.stringify(state.pending)}\n`,
    );
    process.exit(1);
  }

  emit(jsonPath, { ...state, ok: true });
  if (command !== 'status') {
    process.stdout.write(
      `ledger consistent: ${state.applied.length}/${manifest.steps.length} steps, order ${state.applied.map((r) => r.step).join(' -> ') || 'none'}\n`,
    );
  } else {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  }
}

try {
  main();
} catch (error) {
  if (error instanceof LedgerError) {
    process.stderr.write(`ledger error [${error.code}]: ${error.message}\n`);
    process.exit(error.code === 'psql_unavailable' ? 2 : 1);
  }
  throw error;
}
