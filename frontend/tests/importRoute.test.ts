/**
 * Method dispatch at the ROUTE, for the four machine operations.
 *
 * `agentS23.test.ts` covers these operations by calling their handler
 * factories, and every one of those tests was green while two of the four
 * operations were unreachable in every deployment: `/api/import` exported only
 * `POST`, and `agent.config` and `agent.release` are GETs, so the platform
 * answered 405 before `handle` was ever entered. A handler test cannot see
 * that, because it is the export list that is wrong rather than the handler.
 *
 * So these tests import the module the way the platform loads it and call the
 * exported verb symbols. The assertions are about which verb reaches which
 * operation — not about what an authenticated notebook gets back, which is
 * `agentS23.test.ts`'s subject and needs a seeded store.
 *
 * With no machine credential configured the machine operations answer 503,
 * which is exactly the signal wanted here: 503 means the request reached the
 * operation and found the deployment unequipped, where 405 would mean it never
 * arrived. The environment is stubbed empty rather than read, because a
 * developer's own `.env` would otherwise decide whether these pass.
 */

import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'

import { GET, POST } from '../api/import.js'
import {
  AGENT_CONFIG_OP,
  AGENT_PHOTO_UPLOAD_OP,
  AGENT_RELEASE_OP,
} from '../api/_lib/agent/machineOps.js'
import { AGENT_INGEST_OP } from '../api/_lib/agent/ingest.js'

const url = (op?: string) =>
  `https://dashboard.test/api/import${op === undefined ? '' : `?op=${op}`}`

/**
 * A well-formed token for a credential that does not exist. It has to be
 * present and well-shaped: `authenticateMachine` answers 401 for a missing
 * bearer *before* it looks at whether the deployment is equipped, so a request
 * with no header could not tell "reached the operation" from "was refused".
 */
const TOKEN = `Bearer lha.9f1b0000-0000-4000-8000-00000000c001.${'A'.repeat(43)}`

const get = (op?: string) =>
  GET(new Request(url(op), { headers: { authorization: TOKEN } }))
const post = (op?: string, body?: string) =>
  POST(
    new Request(url(op), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: TOKEN },
      body: body ?? '{}',
    }),
  )

beforeAll(() => {
  vi.stubEnv('NEON_MACHINE_DATABASE_URL', '')
  vi.stubEnv('APP_TENANT_ID', '')
  vi.stubEnv('OBJECT_STORAGE_TENANT_ID', '')
})

afterAll(() => {
  vi.unstubAllEnvs()
})

describe('/api/import route method dispatch', () => {
  it('exports both verbs, because two of its four machine operations are GETs', () => {
    expect(typeof GET).toBe('function')
    expect(typeof POST).toBe('function')
  })

  /**
   * The table is written out per operation rather than derived, so that adding
   * a fifth operation with the wrong verb is a test somebody has to write
   * rather than a row a loop generates from the code under test.
   */
  const cases: ReadonlyArray<{
    readonly op: string
    readonly verb: 'GET' | 'POST'
    readonly reaches: boolean
  }> = [
    { op: AGENT_CONFIG_OP, verb: 'GET', reaches: true },
    { op: AGENT_CONFIG_OP, verb: 'POST', reaches: false },
    { op: AGENT_RELEASE_OP, verb: 'GET', reaches: true },
    { op: AGENT_RELEASE_OP, verb: 'POST', reaches: false },
    { op: AGENT_INGEST_OP, verb: 'POST', reaches: true },
    { op: AGENT_INGEST_OP, verb: 'GET', reaches: false },
    { op: AGENT_PHOTO_UPLOAD_OP, verb: 'POST', reaches: true },
    { op: AGENT_PHOTO_UPLOAD_OP, verb: 'GET', reaches: false },
  ]

  for (const { op, verb, reaches } of cases) {
    it(`${verb} ${op} ${reaches ? 'reaches the operation' : 'is refused as a wrong verb'}`, async () => {
      const response = await (verb === 'GET' ? get(op) : post(op))
      expect(response.status).toBe(reaches ? 503 : 405)
    })
  }

  it('never lets a GET reach a human import action', async () => {
    // The human actions read a JSON body and are guarded as admin. A GET that
    // fell through to them would be answered `invalid JSON body` by an action
    // that was never meant to see it, and the guard would be the only thing
    // between an authenticated GET and a handler expecting a payload.
    const response = await get()
    expect(response.status).toBe(405)
    expect(await response.json()).toEqual({ error: 'GET is not allowed' })
  })

  it('still answers an unknown operation before any authorization', async () => {
    for (const response of [await get('agent.nope'), await post('agent.nope')]) {
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: 'operation is not allowlisted: agent.nope',
      })
    }
  })
})
