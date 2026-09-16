#!/usr/bin/env node
/* Static contract checks for ledger step 020. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const sqlPath = resolve(root, 'postgres/tenant-baseline/v1/020_reply_review_machine_invalidation.sql');
const manifestPath = resolve(root, 'postgres/tenant-baseline/v1/ledger.manifest.json');
const sql = readFileSync(sqlPath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const step = manifest.steps.find((entry) => entry.step === 20);

assert.ok(step, 'manifest declares step 020');
assert.equal(step.artifact, '020_reply_review_machine_invalidation.sql');
assert.equal(
  step.sha256,
  createHash('sha256').update(readFileSync(sqlPath)).digest('hex'),
  'manifest pins the exact step 020 artifact',
);
assert.match(sql, /CREATE OR REPLACE FUNCTION public\.reply_review_provenance_guard\(\)/);
assert.match(sql, /NEW\.provenance IS DISTINCT FROM OLD\.provenance/);
assert.match(sql, /CREATE OR REPLACE FUNCTION public\.reply_review_message_semantic_change\(\)/);
assert.match(sql, /is_active_team_member\(\)/);
assert.match(sql, /FROM agent_credential c WHERE c\.id = aid/);
assert.match(sql, /event_provenance := 'machine'/);
assert.match(sql, /event_provenance := 'system'/);
assert.match(sql, /ELSE r\.reviewed_by END/);
assert.match(sql, /ELSE r\.provenance END/);
assert.match(sql, /REVOKE ALL ON FUNCTION public\.reply_review_provenance_guard\(\) FROM PUBLIC/);
assert.match(sql, /REVOKE ALL ON FUNCTION public\.reply_review_message_semantic_change\(\) FROM PUBLIC/);
assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN|FUNCTION)|CREATE EXTENSION/i);

console.log('Reply-review machine invalidation fix: all static contract assertions passed');
