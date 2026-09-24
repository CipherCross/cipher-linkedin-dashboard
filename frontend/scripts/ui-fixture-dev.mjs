#!/usr/bin/env node

/*
 * Start the unchanged SPA with local-only API fixtures in an ephemeral Vercel
 * project root. The temporary root is the only place that contains an `api/`
 * directory, so the product functions and repository `.vercel` state cannot be
 * selected accidentally.
 */

import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const frontend = resolve(here, '..')
const checkOnly = process.argv.includes('--check')
const scenario = checkOnly ? 'populated-admin' : process.env.UI_FIXTURE_SCENARIO ?? process.argv[2] ?? 'populated-admin'
const port = process.env.UI_FIXTURE_PORT ?? '4300'

const bridge = `
export function bridge(handler) {
  return async function fixtureVercelHandler(req, res) {
    const chunks = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) headers.set(key, value.join(', '))
      else if (value != null) headers.set(key, value)
    }
    // Vercel's Node runtime may already have consumed the stream into req.body.
    let body = chunks.length ? Buffer.concat(chunks) : undefined
    if (!body && req.body !== undefined && req.body !== null) {
      body = Buffer.from(typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body))
    }
    const request = new Request('http://127.0.0.1:' + ${JSON.stringify(port)} + (req.url || '/'), {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    })
    const response = await handler(request)
    res.statusCode = response.status
    response.headers.forEach((value, key) => res.setHeader(key, value))
    res.end(Buffer.from(await response.arrayBuffer()))
  }
}
`

const identityEntry = `import { identityFixture } from './ui-fixture-api.mjs'; import { bridge } from './bridge.mjs'; export default bridge(identityFixture)\n`
const activityEntry = `import { activityFixture } from './ui-fixture-api.mjs'; import { bridge } from './bridge.mjs'; export default bridge(activityFixture)\n`
const controlEntry = `import { fixtureControl } from './ui-fixture-api.mjs'; import { bridge } from './bridge.mjs'; export default bridge(fixtureControl)\n`
const importEntry = `import { importFixture } from './ui-fixture-api.mjs'; import { bridge } from './bridge.mjs'; export default bridge(importFixture)\n`
const readOnlyEntry = `import { mutationRefusal } from './ui-fixture-api.mjs'; import { bridge } from './bridge.mjs'; export default bridge(mutationRefusal)\n`
const playbookEntry = `import { playbookFixture } from './ui-fixture-api.mjs'; import { bridge } from './bridge.mjs'; export default bridge(playbookFixture)\n`
const viteConfig = `
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: resolve(process.cwd(), 'empty-env'),
  resolve: { alias: { '@': resolve(${JSON.stringify(frontend)}, 'src') } },
})
`

const root = await mkdtemp(join('/tmp', 'linkedin-ui-fixture-'))
const api = join(root, 'api')
await mkdir(api)
await mkdir(join(root, 'empty-env'))
await mkdir(join(root, 'vercel-global-config'))
await writeFile(join(root, 'fixture-scenario'), `${scenario}\n`)

// Symlink only source assets. No repository .env/.vercel directory is present
// in this root, and API routes are all generated fixture wrappers.
for (const name of ['src', 'public']) {
  try { await cp(join(frontend, name), join(root, name), { recursive: true }) } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
await writeFile(join(root, 'index.html'), await readFile(join(frontend, 'index.html')))
await symlink(join(frontend, 'tests', 'support', 'ui-fixture-api.mjs'), join(api, 'ui-fixture-api.mjs'))
await writeFile(join(api, 'bridge.mjs'), bridge)
await writeFile(join(api, 'identity.mjs'), identityEntry)
await writeFile(join(api, 'activity-daily.mjs'), activityEntry)
await writeFile(join(api, 'ui-fixture.mjs'), controlEntry)
await writeFile(join(api, 'import.mjs'), importEntry)
await writeFile(join(api, 'playbook.mjs'), playbookEntry)
for (const name of ['pipeline', 'coach', 'review-digest', 'classify', 'briefing', 'notify-replies']) {
  await writeFile(join(api, `${name}.mjs`), readOnlyEntry)
}
await writeFile(join(root, 'vite.config.mjs'), viteConfig)
await writeFile(join(root, 'package.json'), JSON.stringify({
  private: true,
  type: 'module',
  scripts: { dev: 'vite --host 127.0.0.1 --config vite.config.mjs' },
}, null, 2) + '\n')
await writeFile(join(root, 'vercel.json'), JSON.stringify({
  framework: 'vite',
}, null, 2) + '\n')
await symlink(join(frontend, 'node_modules'), join(root, 'node_modules'))

if (checkOnly) {
  try {
    for (const name of ['bridge', 'identity', 'activity-daily', 'ui-fixture', 'pipeline', 'import', 'playbook', 'coach', 'review-digest', 'classify', 'briefing', 'notify-replies']) {
      execFileSync(process.execPath, ['--check', join(api, `${name}.mjs`)])
    }
    assert.equal(await readFile(join(root, 'fixture-scenario'), 'utf8'), 'populated-admin\n')
    process.env.UI_FIXTURE_SCENARIO = 'populated-admin'
    process.env.UI_FIXTURE_STATE_FILE = join(root, 'fixture-scenario')
    const { identityFixture, activityFixture, fixtureControl, mutationRefusal, importFixture, playbookFixture } = await import(join(api, 'ui-fixture-api.mjs'))
    const request = (path, method = 'GET') => new Request(`http://127.0.0.1:${port}${path}`, { method })
    const body = async (response) => ({ status: response.status, json: await response.json() })
    const admin = await body(await identityFixture(request('/api/identity?op=session.current')))
    assert.equal(admin.status, 200)
    assert.equal(admin.json.actor.role, 'admin')
    assert.match(admin.json.subject, /^fixture-/)
    const populated = await body(await activityFixture(request('/api/activity-daily?op=overview.systemTotals')))
    assert.deepEqual(populated.json.items[0].totals, { leads: 1, invited: 1, connected: 1, messaged: 1, replied: 1 })
    const changed = await body(await fixtureControl(request('/api/ui-fixture?scenario=empty-member')))
    assert.deepEqual(changed.json, { ok: true, scenario: 'empty-member' })
    assert.equal(await readFile(join(root, 'fixture-scenario'), 'utf8'), 'empty-member\n')
    const member = await body(await identityFixture(request('/api/identity?op=session.current')))
    assert.equal(member.json.actor.role, 'member')
    const empty = await body(await activityFixture(request('/api/activity-daily?op=overview.systemTotals')))
    assert.deepEqual(empty.json.items[0].totals, { leads: 0, invited: 0, connected: 0, messaged: 0, replied: 0 })
    const performance = await body(await activityFixture(request('/api/activity-daily?op=overview.performance')))
    assert.equal(performance.json.items[0].cohort.invited, 0)
    const campaigns = await body(await activityFixture(request('/api/activity-daily?op=overview.accountCampaigns')))
    assert.deepEqual(campaigns.json.items[0].accounts, [])
    assert.deepEqual(campaigns.json.items[0].campaigns, [])
    const emptyLeads = await body(await activityFixture(request('/api/activity-daily?op=leads.searchPage&page=0&page_size=50')))
    assert.deepEqual(emptyLeads.json.items[0].items, [])
    await fixtureControl(request('/api/ui-fixture?scenario=populated-admin'))
    const leads = await body(await activityFixture(request('/api/activity-daily?op=leads.searchPage&page=0&page_size=50')))
    assert.equal(leads.json.items[0].total, 1)
    assert.equal(leads.json.items[0].items[0].lead.full_name, 'Alex Fixture')
    const noMatch = await body(await activityFixture(request('/api/activity-daily?op=leads.searchPage&q=no-match&page=0&page_size=50')))
    assert.equal(noMatch.json.items[0].total, 0)
    assert.equal((await activityFixture(request('/api/activity-daily?op=unknown'))).status, 501)
    await fixtureControl(request('/api/ui-fixture?scenario=read-error'))
    assert.equal((await identityFixture(request('/api/identity?op=session.current'))).status, 200)
    assert.equal((await activityFixture(request('/api/activity-daily?op=config.readPath'))).status, 200)
    assert.equal((await activityFixture(request('/api/activity-daily?op=dashboard.bootstrap'))).status, 503)
    assert.equal((await activityFixture(request('/api/activity-daily?op=dashboard.bootstrap', 'POST'))).status, 403)
    assert.equal((await identityFixture(request('/api/identity?op=session.signOut', 'POST'))).status, 403)
    assert.equal((await mutationRefusal()).status, 403)
    await fixtureControl(request('/api/ui-fixture?scenario=populated-admin'))
    const post = (path, payload) => new Request(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } })
    assert.equal((await body(await playbookFixture(post('/api/playbook', { action: 'list_sequences' })))).json.sequences.length, 2)
    assert.equal((await playbookFixture(post('/api/playbook', { action: 'set_archived', id: 'fixture-sequence', archived: true }))).status, 403)
    assert.equal((await body(await activityFixture(request('/api/activity-daily?op=sequences.hub')))).json.items[0].items.length, 2)
    await fixtureControl(request('/api/ui-fixture?scenario=populated-admin'))
    const importPost = (payload) => importFixture(new Request(`http://127.0.0.1:${port}/api/import`, { method: 'POST', body: JSON.stringify(payload) }))
    assert.equal((await importPost({ action: 'contact_metadata' })).status, 200)
    assert.equal((await importPost({ action: 'company_commit', rows: [] })).status, 403)
    assert.equal((await importPost({ action: 'contact_commit', rows: [] })).status, 403)
    console.log('UI fixture check passed: generated modules, scenario state, identity, reads, and mutation refusal')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  process.exit(0)
}

const env = {
  PATH: process.env.PATH,
  NODE_ENV: 'development',
  VITE_AUTH_PATH: 'identity',
  UI_FIXTURE_SCENARIO: scenario,
  UI_FIXTURE_STATE_FILE: join(root, 'fixture-scenario'),
}
const child = spawn('vercel', [
  '--cwd', root,
  '--global-config', join(root, 'vercel-global-config'),
  'dev', '--local', '--yes',
  '--local-config', join(root, 'vercel.json'),
  '--listen', `127.0.0.1:${port}`,
], { env, stdio: 'inherit' })

console.error(`UI fixture: http://127.0.0.1:${port}/#/`)
console.error(`UI fixture control: http://127.0.0.1:${port}/api/ui-fixture?scenario=<scenario>`)
console.error('Scenarios: populated-admin, populated-member, empty-admin, empty-member, error, read-error')
console.error(`UI fixture temp root: ${root}`)

const cleanup = async () => {
  if (!child.killed) child.kill('SIGTERM')
  await rm(root, { recursive: true, force: true })
}
process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)))
process.once('SIGTERM', () => void cleanup().finally(() => process.exit(143)))
child.once('exit', (code, signal) => {
  void cleanup().finally(() => process.exit(code ?? (signal ? 1 : 0)))
})
