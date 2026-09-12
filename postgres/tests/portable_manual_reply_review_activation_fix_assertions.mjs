#!/usr/bin/env node
/* Static contract checks for ledger step 018. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const sqlPath = resolve(root, 'postgres/tenant-baseline/v1/018_manual_reply_review_activation_fix.sql');
const manifestPath = resolve(root, 'postgres/tenant-baseline/v1/ledger.manifest.json');
const sql = readFileSync(sqlPath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const step = manifest.steps.find((entry) => entry.step === 18);

assert.ok(step, 'manifest declares step 018');
assert.equal(step.artifact, '018_manual_reply_review_activation_fix.sql');
assert.equal(
  step.sha256,
  createHash('sha256').update(readFileSync(sqlPath)).digest('hex'),
  'manifest pins the exact step 018 artifact',
);
assert.match(sql, /CREATE OR REPLACE FUNCTION public\.activate_manual_reply_review\(/);
assert.match(sql, /COALESCE\(m\.intent_taxonomy_version, 'reply-review-v1'\)/);
assert.match(sql, /ON CONFLICT \(message_id\) DO NOTHING/);
assert.match(sql, /activation_processed\s*=\s*activation_processed \+ v_batch_count/);
assert.match(sql, /mode='manual'/);
assert.match(sql, /REVOKE ALL ON FUNCTION public\.activate_manual_reply_review\(uuid, integer\) FROM PUBLIC/);
assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN|FUNCTION)|CREATE EXTENSION/i);

console.log('Manual reply-review activation fix: all static contract assertions passed');
