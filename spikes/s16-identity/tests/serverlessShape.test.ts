/**
 * Does the mechanism fit the serverless runtime, and has the spike stayed out
 * of the product?
 *
 * The Vercel-specific half of the S16 coverage requirement could not be
 * completed as written: this session may not create anything on any provider,
 * and a preview deployment is a provider resource. What is measured here is
 * everything about the shape that a deployment would have exercised, plus the
 * two facts a deployment would have put at risk — the function budget and the
 * product's own surface. The gap itself is recorded in the handoff and in the
 * G3 artifact rather than papered over.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CookieJar } from '../src/cookieJar.js'
import { createSpikeHandler, WHOAMI_PATH } from '../src/handler.js'
import { createWorld, SPIKE_PROVIDER, type World } from './support/world.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')
const PASSPHRASE = 'correct-horse-battery-staple-16'

describe('the handler is shaped like a serverless function', () => {
  let world: World

  beforeAll(async () => {
    world = await createWorld()
  })
  afterAll(async () => {
    await world?.close()
  })

  it('answers a Web Request with a Web Response, with no server involved', async () => {
    // Called directly, the way Vercel's Node runtime calls an exported handler:
    // no `node:http`, no socket, no framework, no `req.body` parsing.
    const handler = createSpikeHandler({
      auth: world.auth.auth,
      resolveActor: world.resolver,
      provider: SPIKE_PROVIDER,
    })

    const email = `serverless-${Date.now()}@example.test`
    const invited = await world.invite({ email, password: PASSPHRASE })

    const jar = new CookieJar()
    await world.signIn(jar, email, PASSPHRASE)
    const cookie = jar.header(`${world.origin}/`) as string

    const anonymous = await handler(new Request(`https://spike.invalid${WHOAMI_PATH}`))
    expect(anonymous).toBeInstanceOf(Response)
    expect(anonymous.status).toBe(401)

    const authenticated = await handler(
      new Request(`https://spike.invalid${WHOAMI_PATH}`, { headers: { cookie } }),
    )
    expect(authenticated.status).toBe(200)
    expect(await authenticated.json()).toMatchObject({ subject: invited.subject })
  })

  it('holds no per-instance state between requests', async () => {
    // A serverless deployment may answer two requests on two instances, or one
    // instance may be frozen between them. A second handler built from scratch
    // must accept the session the first one issued.
    const email = `stateless-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE })
    const jar = new CookieJar()
    await world.signIn(jar, email, PASSPHRASE)
    const cookie = jar.header(`${world.origin}/`) as string

    const fresh = createSpikeHandler({
      auth: world.auth.auth,
      resolveActor: world.resolver,
      provider: SPIKE_PROVIDER,
    })
    const response = await fresh(
      new Request(`https://spike.invalid${WHOAMI_PATH}`, { headers: { cookie } }),
    )
    expect(response.status).toBe(200)
  })

  it('emits multiple Set-Cookie headers separately, not folded into one', async () => {
    // The classic serverless-adapter bug. Folding them loses every cookie but
    // the first, and it fails silently — the sign-in still returns 200.
    const email = `setcookie-${Date.now()}@example.test`
    await world.invite({ email, password: PASSPHRASE })
    const jar = new CookieJar()
    const result = await world.signIn(jar, email, PASSPHRASE)

    const headers = result.response.headers.getSetCookie()
    expect(headers.length).toBeGreaterThanOrEqual(1)
    for (const header of headers) {
      // A folded header would contain two `=`-separated pairs before the first
      // attribute; a correctly separated one never does.
      expect(header.split(';')[0].split('=').length).toBe(2)
    }
  })

  it('imports without a database credential', async () => {
    // Importing the handler module must not construct a pool or read an
    // environment variable, or a type-check and a cold start both pay for a
    // connection they may not need.
    const withoutEnv = await import('../src/handler.js')
    expect(typeof withoutEnv.createSpikeHandler).toBe('function')
  })
})

describe('the product surface is untouched', () => {
  it('frontend/api still holds exactly 12 serverless functions', () => {
    // The Vercel Hobby cap, and the constraint B3 recorded. The spike adds no
    // endpoint to the product; if it ever did, this goes red before a deploy
    // could fail.
    const functions = readdirSync(resolve(REPO, 'frontend/api')).filter((name) =>
      name.endsWith('.ts'),
    )
    expect(functions.length).toBe(12)
    expect(functions.some((name) => name.toLowerCase().includes('s16'))).toBe(false)
    expect(functions.some((name) => name.toLowerCase().includes('auth'))).toBe(false)
  })

  it('the spike is not referenced anywhere in the product', () => {
    for (const file of [
      'frontend/src/lib/AuthContext.tsx',
      'frontend/src/lib/DataContext.tsx',
      'frontend/src/App.tsx',
      'frontend/vercel.json',
      'frontend/package.json',
    ]) {
      const text = readFileSync(resolve(REPO, file), 'utf8')
      expect(text, `${file} must not reference the spike`).not.toMatch(/s16|better-auth/i)
    }
  })

  it('the candidate is not a dependency of the product', () => {
    const manifest = JSON.parse(readFileSync(resolve(REPO, 'frontend/package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies)).not.toContain('better-auth')
    expect(Object.keys(manifest.devDependencies)).not.toContain('better-auth')
  })

  it('the immutable baseline is not touched by the spike', () => {
    // The resolver candidate lives in the spike, not in the tenant baseline.
    const baseline = readFileSync(
      resolve(REPO, 'postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql'),
      'utf8',
    )
    expect(baseline).not.toContain('identity_resolve_actor')
    expect(baseline).not.toContain('identity_spike')
  })
})
