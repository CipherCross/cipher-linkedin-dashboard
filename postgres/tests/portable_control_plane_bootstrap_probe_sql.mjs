#!/usr/bin/env node
// Prints one of the control plane's own probe SQL texts, taken from the Worker
// source that ships it.
//
// The Worker module imports its pinned .sql artifacts as text, which only
// wrangler can resolve, so this cannot import the compiled module. It therefore
// reads the exported template literal out of the TypeScript source instead. The
// point is that the live-shaped harness executes THE SAME STRING the control
// plane sends: a harness holding its own copy would keep passing while the
// shipped SQL drifted, which is exactly how a mocked row of booleans hid a
// permission error that made every S26 step-3 retry fail.
//
// Usage: portable_control_plane_bootstrap_probe_sql.mjs <constant-name>
// Exit codes: 0 printed, 2 usage or extraction failure.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_PATH = join(REPO_DIR, 'ops', 'src', 'worker', 'pinned-postgres.ts');

const ALLOWED = new Set(['BOOTSTRAP_STATE_PROBE_SQL', 'LEDGER_PRESENCE_SQL']);

const name = process.argv[2];
if (!ALLOWED.has(name)) {
  process.stderr.write(`usage: ${process.argv[1]} <${[...ALLOWED].join('|')}>\n`);
  process.exit(2);
}

const source = readFileSync(SOURCE_PATH, 'utf8');
// The constants are plain backtick literals with no interpolation, so the first
// unescaped backtick after the assignment closes them.
const opening = `export const ${name} = \``;
const start = source.indexOf(opening);
if (start === -1) {
  process.stderr.write(
    `${name} is no longer an exported template literal in ops/src/worker/pinned-postgres.ts; `
    + 'the live-shaped harness would silently stop testing the shipped SQL\n',
  );
  process.exit(2);
}
const bodyStart = start + opening.length;
const end = source.indexOf('`', bodyStart);
if (end === -1) {
  process.stderr.write(`${name} has no closing backtick\n`);
  process.exit(2);
}
const sql = source.slice(bodyStart, end);
if (sql.includes('${')) {
  process.stderr.write(`${name} interpolates a value; the harness cannot run it verbatim\n`);
  process.exit(2);
}
if (!/\bSELECT\b/i.test(sql)) {
  process.stderr.write(`${name} does not look like a SELECT\n`);
  process.exit(2);
}
process.stdout.write(`${sql}\n`);
