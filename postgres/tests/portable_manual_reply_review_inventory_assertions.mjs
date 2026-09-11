#!/usr/bin/env node
/* Static, clean-room-friendly contract checks for ledger step 017.
 * This file does not connect to a tenant and never mutates a database. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const sqlPath = resolve(root, 'postgres/tenant-baseline/v1/017_manual_reply_review.sql');
const manifestPath = resolve(root, 'postgres/tenant-baseline/v1/ledger.manifest.json');
const sql = readFileSync(sqlPath, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const check = (needle, message = needle) => assert.match(sql, new RegExp(needle), message);
const names = (pattern) => [...sql.matchAll(pattern)].map((match) => match[1]);

assert.equal(manifest.steps.at(-1).step, 17);
assert.equal(manifest.steps.at(-1).artifact, '017_manual_reply_review.sql');
assert.equal(
  manifest.steps.at(-1).sha256,
  createHash('sha256').update(readFileSync(sqlPath)).digest('hex'),
  'manifest pins the exact step 017 artifact',
);

for (const table of [
  'reply_reviews', 'reply_review_reasons', 'reply_review_events',
  'reply_review_mutations', 'conversation_reply_review_state',
  'legacy_reply_classifications', 'reply_review_settings',
]) check(`CREATE TABLE public\\.${table}\\b`);

for (const sentiment of ['positive', 'neutral', 'negative', 'objection', 'referral', 'auto']) {
  check(`'${sentiment}[^']*'::text`);
}
for (const intent of ['unreviewed', 'none', 'level', 'not_applicable', 'p1', 'p2', 'p3']) {
  check(`'${intent}'::text`);
}
for (const reason of [
  'no_need', 'timing', 'budget', 'existing_solution', 'offer_fit',
  'wrong_person', 'trust_information', 'do_not_contact', 'other',
]) check(`'${reason}'::text`);
for (const action of [
  'needs_reply', 'follow_up', 'awaiting_reply', 'resolved', 'closed_soft', 'closed_hard',
]) check(`'${action}'::text`);

check('first_seen_at timestamp with time zone');
check('first_seen_at SET DEFAULT clock_timestamp');
check('reply_review_first_seen_guard');
check('first_seen_at is immutable');
check('reply_messages_inbound_lock');
check('reply_messages_inbound_revision');
check('inbound_revision = conversation_reply_review_state\\.inbound_revision \\+ 1');
check('ON CONFLICT \\(instance_id, profile_url\\) DO UPDATE');
check('reply_messages_semantic_review_invalidation');
check('reply_review_message_semantic_change');
check('reply_review_events_immutable');
check('reply_review_mutations_immutable');
check('before jsonb');
check('after jsonb');
check('occurred_at timestamp with time zone');
check('payload_hash text NOT NULL');
check('id boolean DEFAULT true NOT NULL');
check('DEFERRABLE INITIALLY DEFERRED');
check('negative and objection reviews require at least one reason');
check('other reason requires a non-empty comment');
check('AI reply classification writes are disabled in manual mode');
check("USING \\(public\\.is_active_team_member\\(\\)\\)");
check('ALTER FUNCTION public\\.apply_follow_up_action');
check('RENAME TO apply_follow_up_action_legacy');
check('CREATE FUNCTION public\\.activate_manual_reply_review');
check('REVOKE ALL ON FUNCTION public\\.activate_manual_reply_review\\(uuid, integer\\) FROM PUBLIC');
check("mode='manual'");
for (const field of [
  'activation_in_progress', 'activation_cursor', 'activation_processed',
  'activation_total', 'activation_cutoff', 'activation_mutation_id',
  'activation_actor_id', 'activation_batch_size',
]) check(field, `resumable activation field: ${field}`);
check('p_batch_size integer DEFAULT 500');
check('p_batch_size > 1000');
check('activation is already in progress with another mutation_id');
check('activation already completed with another mutation_id');
check('activation mutation inputs changed during resume');
assert.doesNotMatch(sql, /activation mutation inputs changed after completion/,
  'manual completion uses the immutable replay ledger without an unreachable duplicate branch');
check("mode = 'manual' OR activation_in_progress");
check('activation_in_progress=true');
check('activation_mutation_id=p_mutation_id');
check('activation_cutoff=s.activation_cutoff');
check('activation_total=s.activation_total');
check('id <= s.activation_cutoff');
check('FOR KEY SHARE');
check('happens-before boundary');
check('ORDER BY id LIMIT p_batch_size');
check('activation_processed\\s*=\\s*activation_processed \\+ v_batch_count');
check("activation_in_progress=false");
check("mode remains prepared while activation_in_progress is true");
check("'complete',v_complete");
check("'processed',s.activation_processed");
check("'remaining',v_remaining");
check("'cursor',s.activation_cursor");
check('v_hash');
check('v_existing_actor');
check('v_existing_hash');
check("'batch_size',p_batch_size");
check('mutation_id was already used with different inputs');
check('batches use the settings progress columns');
check('IF v_complete THEN');
check('ON CONFLICT \\(mutation_id\\) DO NOTHING');
assert.doesNotMatch(sql, /INSERT INTO reply_review_mutations[\s\S]*?DO UPDATE/i,
  'immutable mutation ledger is never updated during resumable activation');
check('sentiment=CASE WHEN \\(SELECT r\\.sentiment_provenance');
check('classified_model=CASE WHEN \\(SELECT r\\.sentiment_provenance');
check('THEN m\\.sentiment ELSE NULL END');
check('intent_level=CASE WHEN \\(SELECT r\\.intent_provenance');
check('intent_classified_model=CASE WHEN \\(SELECT r\\.intent_provenance');
check('THEN m\\.intent_level ELSE NULL END');
check("CASE WHEN classified_model = 'manual' THEN 'legacy_manual'");
assert.doesNotMatch(sql, /source\\s*=\\s*'manual'\\s+THEN\\s*'legacy_manual'/i,
  'message import source is never treated as classification provenance');
assert.doesNotMatch(sql, /classified_model\\s*=\\s*'manual'\\s+OR\\s+source\\s*=\\s*'manual'/i,
  'message import source is independent from classification provenance');
assert.doesNotMatch(sql, /\\bsource\\b/i,
  'message import source is not a provenance input anywhere in the step');
check('app.reply_review_write', 'manual compatibility writes require the transaction-local marker');
check('manual compatibility projection requires a matching reply review row');
assert.doesNotMatch(sql, /AND NOT is_active_team_member\\(\\)/,
  'active runtime members cannot bypass the manual classification guard');
check('do_not_contact reason requires the conversation DNC flag');
check('reply_review_validate_dnc_reason_state');
check('reply_reviews_readonly_member');
check('reply_review_reasons_readonly_member');

// Guard the migration's executable shape: a copied PL/pgSQL delimiter or DDL
// statement can make the whole append-only step fail before any table exists.
assert.doesNotMatch(sql, /\n\s*\$\$;\s*\n\s*\$\$;/,
  'no standalone duplicate PL/pgSQL delimiter');
assert.equal((sql.match(/\$\$/g) ?? []).length, 32,
  'each of the sixteen functions has exactly one body delimiter pair');
for (const [kind, pattern] of [
  ['function', /^CREATE FUNCTION public\.([a-z0-9_]+)\(/gm],
  ['trigger', /^CREATE TRIGGER ([a-z0-9_]+)/gm],
]) {
  const declared = names(pattern);
  assert.equal(new Set(declared).size, declared.length,
    `no duplicate adjacent CREATE ${kind} declarations`);
}
assert.equal((sql.match(/^CREATE TRIGGER reply_messages_semantic_review_invalidation\b/gm) ?? []).length, 1,
  'semantic review invalidation trigger is declared exactly once');
assert.equal((sql.match(/^CREATE TRIGGER reply_messages_delete_review_audit\b/gm) ?? []).length, 1,
  'message deletion audit trigger is declared exactly once');
check('reply_review_message_delete_audit');
check("'message_deleted'");
check('original_message_id');
check('NEW\\.sentiment := NULL');
check('NEW\\.intent_classified_model := NULL');
check("IF TG_OP = 'DELETE' THEN RETURN OLD;");

assert.doesNotMatch(sql, /CREATE EXTENSION|service_role|DROP TABLE|DROP COLUMN/i);
console.log('Manual reply-review inventory: all static contract assertions passed');
