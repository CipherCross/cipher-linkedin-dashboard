#!/usr/bin/env node
// Static assertions for the S08 ledger, dump/restore and reconciliation
// artifacts. Runs without a database.
//
//   node postgres/tests/portable_migration_ledger_static_assertions.mjs
//
// Checks:
//   * the manifest is well formed, declares 001 .. 006 contiguously, pins a
//     SHA-256 for every artifact -- including the additive control-plane
//     role-bootstrap extension, which is not a step -- and declares no down
//     migration path;
//   * no step uses CREATE INDEX CONCURRENTLY, which the one-step-one-transaction
//     runner cannot apply;
//   * every pinned SHA-256 matches the file on disk;
//   * the four published baseline artifacts still carry the digests S05, S06,
//     S07 and the identity ledger session published, so a later session
//     provably did not edit them;
//   * no provider marker appears in executable SQL, script or manifest content
//     (a provider name inside a comment is documentation, not a dependency, and
//     comments are stripped before the sweep);
//   * no secret, credential, password or connection string appears anywhere;
//   * no already-applied migration and no published baseline artifact changed
//     relative to the current branch's merge base with main.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_DIR = join(REPO_DIR, 'postgres', 'tenant-baseline', 'v1');
const MANIFEST_PATH = join(BASELINE_DIR, 'ledger.manifest.json');

// The digests S05, S06, S07, the identity ledger session and S17 published for
// the baseline set. 005 joins the list here, at the digest S17 publishes, so any
// later edit to it fails two independent checks rather than one.
//
// A new artifact is deliberately NOT added to PROTECTED_PATHS in the session that
// introduces it: that list is checked against the diff since the merge base, so a
// session's own new file would flag itself. The session after adds it. S17 is
// that session for 004, which is why 004 appears below *and* in PROTECTED_PATHS,
// while 006 appears only here.
//
// 005 graduated on that schedule and is now in both. 006 is the S13 consolidation
// session's own, so it is pinned here and nowhere else; whichever session follows
// should promote it once the owner has applied it — and only then, because
// PROTECTED_PATHS means "already applied, never touch again" and an unapplied
// step may still need a correction.
const IMMUTABLE_BASELINE = {
  '001_portable_business_baseline.sql':
    '4ad64a8c20e05b8c8858e311458d0bc6e421456531ad8e80a414d93e27a05415',
  '002_identity_roles_actor_rls.sql':
    '18a779f3abd99592a1af71430f87b4f93c7beff3fba75924fa0122ae0b3c3d80',
  '003_functions_triggers_ai_guard.sql':
    'a46a8e61f9b890e628b2d22d9fd2659f2ac39a7d01154f1b67a0c046d4448e92',
  '004_identity_write_path_and_store.sql':
    '2ec822cad4067273aac7ead38e1dfdb29dc8dbf3ce5e1ee1765ea0e24ecf7163',
  '005_identity_atomic_invite.sql':
    '229442570c0440d5a6f0d1ae336e9e80924155d9437bab5347855eaed3ee27e8',
  '006_messages_direction_seek_index.sql':
    '87991430eca2ffc22a69a0570d6d4f45e9b852dc4274a4828f84306dfa37bf47',
};

// Everything the ledger sessions add. Every one of these is swept for markers
// and secrets. A new baseline artifact that is not on this list is never swept,
// so the list grows with the baseline: the identity ledger session's seven files
// are at the end.
const S08_ARTIFACTS = [
  'postgres/tenant-baseline/v1/000_control_plane_role_bootstrap.sql',
  'postgres/tenant-baseline/v1/000_migration_ledger.sql',
  'postgres/tenant-baseline/v1/restore_window_open.sql',
  'postgres/tenant-baseline/v1/restore_window_close.sql',
  'postgres/tenant-baseline/v1/ledger.manifest.json',
  'postgres/tools/portable_migration_ledger.mjs',
  'postgres/tests/portable_schema_inventory_snapshot.sql',
  'postgres/tests/portable_sequence_state.sql',
  'postgres/tests/portable_restore_reconciliation.sql',
  'postgres/tests/portable_restore_behavior_assertions.sql',
  'postgres/tests/portable_restore_ai_guard_assertions.sql',
  'postgres/tests/portable_dump_restore_test_roles.sql',
  'postgres/tests/portable_migration_ledger_tests.sh',
  'postgres/tests/portable_dump_restore_cleanroom.sh',
  'postgres/tests/portable_migration_ledger_static_assertions.mjs',
  'docs/platform-ops/g1-dump-restore-go-no-go.json',
  // Identity ledger session (step 004 and its control-plane prerequisite).
  'postgres/tenant-baseline/v1/000_identity_store_role_bootstrap.sql',
  'postgres/tenant-baseline/v1/004_identity_write_path_and_store.sql',
  'postgres/tests/portable_identity_write_path_catalog_assertions.sql',
  'postgres/tests/portable_identity_write_path_behavior_assertions.sql',
  'postgres/tests/portable_identity_store_isolation_assertions.sql',
  'postgres/tests/portable_identity_write_path_ai_boundary_assertions.sql',
  'postgres/tests/portable_identity_write_path_cleanroom.sh',
  'docs/implementation-handoffs/N-IDENTITY-LEDGER.md',
  // S17 (step 005, the atomic cross-store invite).
  'postgres/tenant-baseline/v1/005_identity_atomic_invite.sql',
  'postgres/tests/portable_identity_atomic_invite_assertions.sql',
  'postgres/tests/portable_identity_atomic_invite_cleanroom.sh',
  'docs/implementation-handoffs/N-S17.md',
  // S13 consolidation (step 006, the message keyset's index).
  'postgres/tenant-baseline/v1/006_messages_direction_seek_index.sql',
  'docs/implementation-handoffs/N-S13-consolidation.md',
];

const EXECUTABLE_SCRIPTS = [
  'postgres/tests/portable_migration_ledger_tests.sh',
  'postgres/tests/portable_dump_restore_cleanroom.sh',
  'postgres/tests/portable_identity_write_path_cleanroom.sh',
  'postgres/tests/portable_identity_atomic_invite_cleanroom.sh',
];

// Paths no session may touch, on any branch, for the life of the migration.
//
// This list was originally S08's own blast-radius contract and also carried
// 'frontend/', 'sync-agent/' and 'ops/'. Those three were session scope, not
// invariants: once S08 merged they only ever fired on later branches doing
// exactly the work they were commissioned to do (S11 phase 1 was the first).
// They were removed rather than weakened. What remains is genuinely immutable:
// already-applied migrations, and the published baseline set — the latter also
// enforced, more strongly, by the IMMUTABLE_BASELINE digest checks above.
const PROTECTED_PATHS = [
  'supabase/migrations/',
  'supabase/tenant-baseline/',
  'postgres/tenant-baseline/v1/001_portable_business_baseline.sql',
  'postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql',
  'postgres/tenant-baseline/v1/003_functions_triggers_ai_guard.sql',
  // Added by S17, the session after the one that introduced it, exactly as the
  // identity ledger handoff asked. It is applied to the live project, so from
  // here on it is as immutable as 001..003.
  'postgres/tenant-baseline/v1/004_identity_write_path_and_store.sql',
  // Added by B2, the session after S17, for the same reason and on the same
  // schedule: 005 is applied to the live project, so it is now as immutable as
  // 001..004. S17 could not add it, because this list is checked against the
  // diff since the merge base and a session's own new file would flag itself.
  'postgres/tenant-baseline/v1/005_identity_atomic_invite.sql',
];

// Provider surfaces the portable baseline must not depend on.
const PROVIDER_MARKERS = [
  /\bsupabase\b/i,
  /\bpostgrest\b/i,
  /\bservice_role\b/i,
  /\bauth\.(uid|users|jwt)\b/i,
  /\bstorage\.(objects|buckets)\b/i,
  /\banon\b/i,
  /\bauthenticated\b/i,
  /\bauthenticator\b/i,
  /\bai_sql_runner\b/i,
  /\bneon\b/i,
  /\bvercel\b/i,
  /\bcloudflare\b/i,
];

// Two files necessarily name provider surfaces in executable content, because
// their whole job is to prove those surfaces are absent. Exempting them from the
// marker sweep is explicit and reasoned rather than a silent regex hole; the
// credential sweep still applies to both.
const MARKER_SWEEP_EXEMPT = {
  'postgres/tests/portable_restore_reconciliation.sql':
    'asserts that no provider schema or provider role exists after restore, so it must name them',
  'postgres/tests/portable_migration_ledger_static_assertions.mjs':
    'defines the marker patterns themselves',
  'docs/platform-ops/g1-dump-restore-go-no-go.json':
    'is the owner decision document; naming the provider being adopted and the one being left is its purpose. It is swept for resource IDs and credentials instead.',
  'docs/implementation-handoffs/N-IDENTITY-LEDGER.md':
    'is a handoff document, not executable content; naming the provider it asks the owner to apply to is its purpose. It is swept for resource IDs and credentials instead, which is the sweep that matters for a document.',
  'docs/implementation-handoffs/N-S17.md':
    'is a handoff document, not executable content; it names the provider whose apply it requests, the hosting provider whose function cap shaped the design, and the identity provider G3 accepted. It is swept for resource IDs and credentials instead, which is the sweep that matters for a document.',
  'docs/implementation-handoffs/N-S13-consolidation.md':
    'is a handoff document, not executable content; the two defects it fixes are in the provider-specific read path and the step it writes is for the provider being migrated to, so naming both is its subject. It is swept for resource IDs and credentials instead, which is the sweep that matters for a document.',
};

// Provider RESOURCE identifiers, as opposed to provider names. These must not
// appear anywhere, including in the owner decision document: an evidence file
// that carries a project, endpoint or account identifier stops being safe to
// share and starts being an inventory of live infrastructure.
const RESOURCE_ID_MARKERS = [
  /\bprj_[A-Za-z0-9]{8,}/,
  /\bteam_[A-Za-z0-9]{8,}/,
  /\bacct_[A-Za-z0-9]{8,}/,
  /\barn:aws:/i,
  /\bep-[a-z0-9]+-[a-z0-9]+-\d{5,}/i,
  /[A-Za-z0-9-]+\.neon\.tech/i,
  /[A-Za-z0-9-]+\.vercel\.app/i,
  /[A-Za-z0-9-]+\.supabase\.(co|in)/i,
  /[A-Za-z0-9-]+\.r2\.cloudflarestorage\.com/i,
];

// Secrets and credentials, in any file.
const SECRET_MARKERS = [
  /\bpostgres(ql)?:\/\//i,
  /\bPGPASSWORD\b/,
  /\bpassword\s*[:=]\s*['"][^'"]+['"]/i,
  /\bPASSWORD\s+'[^']+'/i,
  /\bENCRYPTED\s+PASSWORD\b/i,
  /\b(api[_-]?key|secret[_-]?key|access[_-]?token|bearer)\s*[:=]\s*['"][^'"]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{20,}\./,
];

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failures += 1;
    process.stderr.write(`  FAIL ${label}${detail ? `: ${detail}` : ''}\n`);
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Comments are documentation. A provider name inside one is a note about what
// the artifact deliberately does NOT use; a provider name in executable code is
// a dependency. Only the latter is a finding, so comments come out first.
function stripComments(path, text) {
  if (path.endsWith('.sql')) {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
  }
  if (path.endsWith('.sh')) {
    return text
      .split('\n')
      .map((line) => (/^\s*#/.test(line) ? '' : line))
      .join('\n');
  }
  if (path.endsWith('.mjs')) {
    return text
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((line) => (/^\s*\/\//.test(line) ? '' : line))
      .join('\n');
  }
  return text;
}

// --- manifest ----------------------------------------------------------------

process.stdout.write('Ledger manifest\n');

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

check('manifest declares the portable ledger contract',
  manifest.ledger_contract === 'portable-tenant-baseline-ledger');
check('manifest declares no down migration path',
  manifest.down_migrations?.supported === false);
check('manifest declares idempotent-skip re-apply semantics',
  manifest.reapply_semantics?.mode === 'idempotent-skip');
check('manifest declares the non-superuser apply principal',
  manifest.apply_principal?.session_user === 'app_migration'
  && manifest.apply_principal?.current_user === 'app_owner'
  && manifest.apply_principal?.superuser_forbidden === true);
check('manifest stores the ledger outside the business schema',
  manifest.ledger_store?.schema === 'app_ledger' && manifest.ledger_store?.append_only === true);
// Still seven, and that is the point rather than an oversight. The identity
// ledger session needed an eighth role and did NOT add it here: the digest of
// this artifact is recorded in app_ledger.role_bootstrap, a single-row
// append-only table, so changing its bytes would permanently break the ledger of
// every database already prepared with it. The eighth role arrives as an
// additive extension artifact, asserted separately below.
check('manifest still declares the seven-role bootstrap dependency',
  Array.isArray(manifest.role_bootstrap?.required_roles)
  && manifest.role_bootstrap.required_roles.length === 7
  && manifest.role_bootstrap.is_ledger_step === false);
check('manifest declares six steps in order 1 -> 2 -> 3 -> 4 -> 5 -> 6',
  manifest.steps.length === 6 && manifest.steps.every((s, i) => s.step === i + 1));

// Step 006 needs no control-plane prerequisite, and saying so is not noise: 004
// and 005 both do, so "declares none" is the distinguishing fact, and an index
// that silently acquired a role dependency would be a different step entirely.
check('step 006 declares no role-bootstrap prerequisite, because an index needs none',
  manifest.steps.find((s) => s.step === 6)
    ?.requires_role_bootstrap_extension === undefined);

// The runner applies every step inside BEGIN/COMMIT, and CREATE INDEX
// CONCURRENTLY cannot run in a transaction block — it would fail at apply time,
// and special-casing the runner to allow it would trade the ledger's
// commit-together guarantee for a lock. Asserted over every step, not just 006,
// so the next person reaching for it has to change this line first.
for (const step of manifest.steps) {
  const body = readFileSync(join(BASELINE_DIR, step.artifact), 'utf8');
  check(`step ${step.step} contains no CONCURRENTLY, which the one-transaction runner cannot apply`,
    !/\bCONCURRENTLY\b/i.test(stripComments(step.artifact, body)));
}

// Step 005 needs the same control-plane prerequisite as 004 and must say so.
// It writes the identity tables, so a database without the identity_store role
// has no such tables to write and the step could only fail at apply time.
check('step 005 declares the identity_store prerequisite it inherits from 004',
  manifest.steps.find((s) => s.step === 5)
    ?.requires_role_bootstrap_extension === '000_identity_store_role_bootstrap.sql');

// Role-bootstrap extensions: additive control-plane prerequisites, each pinned,
// each declaring the roles it creates and the step that needs them, and none of
// them a ledger step.
const extensions = manifest.role_bootstrap_extensions ?? [];
check('every role-bootstrap extension declares its roles and the step that needs them',
  extensions.length === 1
  && extensions.every((e) =>
    Array.isArray(e.required_roles) && e.required_roles.length > 0
    && e.is_ledger_step === false
    && Number.isInteger(e.required_by_step)
    && manifest.steps.some((s) => s.step === e.required_by_step)));
check('no extension role is also claimed by the seven-role bootstrap',
  extensions.every((e) =>
    e.required_roles.every((r) => !manifest.role_bootstrap.required_roles.includes(r))));
check('every step needing an extension names the artifact that provides it',
  manifest.steps
    .filter((s) => s.requires_role_bootstrap_extension)
    .every((s) => extensions.some((e) => e.artifact === s.requires_role_bootstrap_extension)));

const pinned = [
  manifest.role_bootstrap,
  manifest.ledger_bootstrap,
  manifest.restore_procedure.window_open,
  manifest.restore_procedure.window_close,
  ...extensions,
  ...manifest.steps,
];

for (const entry of pinned) {
  const path = join(BASELINE_DIR, entry.artifact);
  const actual = existsSync(path) ? sha256(path) : '<missing>';
  check(`pinned digest matches ${entry.artifact}`, actual === entry.sha256,
    `manifest ${entry.sha256}, disk ${actual}`);
}

process.stdout.write('\nImmutable baseline set\n');
for (const [artifact, expected] of Object.entries(IMMUTABLE_BASELINE)) {
  const actual = sha256(join(BASELINE_DIR, artifact));
  check(`${artifact} is unchanged since its own session`, actual === expected,
    `expected ${expected}, found ${actual}`);
  const declared = manifest.steps.find((s) => s.artifact === artifact);
  check(`${artifact} is pinned in the ledger at its published digest`,
    declared?.sha256 === expected);
}

// --- marker and secret sweep -------------------------------------------------

process.stdout.write('\nProvider and credential sweep\n');
for (const relative of S08_ARTIFACTS) {
  const path = join(REPO_DIR, relative);
  if (!existsSync(path)) {
    check(`${relative} exists`, false);
    continue;
  }
  const raw = readFileSync(path, 'utf8');
  const code = stripComments(relative, raw);

  if (MARKER_SWEEP_EXEMPT[relative]) {
    process.stdout.write(`  ok   ${relative} is exempt from the marker sweep (${MARKER_SWEEP_EXEMPT[relative]})\n`);
    checks += 1;
  } else {
    const providerHits = PROVIDER_MARKERS
      .filter((pattern) => pattern.test(code))
      .map((pattern) => pattern.source);
    check(`${relative} has no provider marker in executable content`,
      providerHits.length === 0, providerHits.join(', '));
  }

  const secretHits = SECRET_MARKERS
    .filter((pattern) => pattern.test(raw))
    .map((pattern) => pattern.source);
  check(`${relative} has no secret, credential or connection string`,
    secretHits.length === 0, secretHits.join(', '));

  const resourceHits = RESOURCE_ID_MARKERS
    .filter((pattern) => pattern.test(raw))
    .map((pattern) => pattern.source);
  check(`${relative} has no provider resource identifier`,
    resourceHits.length === 0, resourceHits.join(', '));
}

process.stdout.write('\nHarness hygiene\n');
for (const relative of EXECUTABLE_SCRIPTS) {
  const path = join(REPO_DIR, relative);
  const mode = statSync(path).mode;
  check(`${relative} is executable`, (mode & 0o111) !== 0);
  check(`${relative} refuses an implicit image pull`,
    readFileSync(path, 'utf8').includes('refusing an implicit network pull'));
  check(`${relative} removes its containers`,
    readFileSync(path, 'utf8').includes('trap cleanup EXIT'));
}

// --- immutability ------------------------------------------------------------

process.stdout.write('\nImmutability\n');
let changed = null;
try {
  const base = execFileSync('git', ['merge-base', 'HEAD', 'main'], { cwd: REPO_DIR, encoding: 'utf8' }).trim();
  changed = execFileSync('git', ['diff', '--name-only', base], { cwd: REPO_DIR, encoding: 'utf8' })
    .split('\n').filter(Boolean);
} catch {
  process.stdout.write('  skip Git is unavailable; scope check not run\n');
}

if (changed) {
  const violations = changed.filter((file) =>
    PROTECTED_PATHS.some((protectedPath) =>
      protectedPath.endsWith('/') ? file.startsWith(protectedPath) : file === protectedPath));
  check('no historical migration or immutable baseline file changed',
    violations.length === 0, violations.join(', '));
}

process.stdout.write(`\nStatic assertions: ${checks - failures} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
