/**
 * The committed copy of the candidate's DDL is the candidate's own output.
 *
 * S17 has to hand this to the migration ledger, so it must not be a hand
 * transcription that drifts from the library. This test regenerates it and
 * compares.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, inject, it } from 'vitest'

import { compileCandidateSchema } from '../src/spikeAuth.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MARKER = '-- BEGIN GENERATED\n'

it('sql/better_auth_generated_schema.sql matches what the candidate emits', async () => {
  const committed = readFileSync(
    resolve(HERE, '../sql/better_auth_generated_schema.sql'),
    'utf8',
  )
  const body = committed.slice(committed.indexOf(MARKER) + MARKER.length).trim()
  const generated = (await compileCandidateSchema(inject('ownerUrl'))).trim()
  expect(body).toBe(generated)
})

it('the candidate never claims a canonical user id column of its own', () => {
  const committed = readFileSync(
    resolve(HERE, '../sql/better_auth_generated_schema.sql'),
    'utf8',
  )
  // `user.id` is text because it is a provider subject. If it were ever uuid,
  // someone would eventually join it to public.users.id, and the canonical id
  // would quietly acquire a second source of truth.
  expect(committed).toMatch(/create table "user" \("id" text not null primary key/)
  expect(committed).not.toMatch(/"id" uuid/)
})
