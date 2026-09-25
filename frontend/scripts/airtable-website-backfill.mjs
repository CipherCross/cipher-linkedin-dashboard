#!/usr/bin/env node
// Optional, owner-approved: rewrite the existing DB `Company Website` and
// Companies `Website URL` values to the bare domain the CSV importer writes.
//
// Matching already normalizes both sides, so nothing depends on this; it only
// makes the stored values uniform. The default is a dry run that reports what
// every value would become. Values that do not normalize (not a URL, a
// LinkedIn/Linktree page, an IP) are listed and never touched.
//
//   node scripts/airtable-website-backfill.mjs                 # dry run, both tables
//   node scripts/airtable-website-backfill.mjs --out report.csv
//   node scripts/airtable-website-backfill.mjs --apply --table db --confirm db
//
// `--apply` rewrites one table per run, ten records per request, with
// typecast off, and only after `--confirm` repeats the table name. Run it only
// on an explicit go-ahead from the Airtable owner: the DB → Companies
// automation and the SDR Interface must be confirmed to work with bare domains.
//
// Needs AIRTABLE_TOKEN and AIRTABLE_BASE_ID in the environment.
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDomain } from '../src/lib/domain.ts'

const TABLES = {
  db: { id: 'tblEYOgRDRg0aYfzI', field: 'fldOtfQ8mk0W0quRi', label: 'DB.Company Website' },
  companies: { id: 'tblDk8o4Nb4mFAEa8', field: 'fldQxdTVpDHxJRETw', label: 'Companies.Website URL' },
}

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const option = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const token = process.env.AIRTABLE_TOKEN
const baseId = process.env.AIRTABLE_BASE_ID
if (!token || !/^app[a-zA-Z0-9]{14}$/.test(baseId ?? '')) {
  console.error('AIRTABLE_TOKEN and a valid AIRTABLE_BASE_ID are required.')
  process.exit(2)
}

const apply = flag('apply')
const only = option('table')
if (apply && (!only || !TABLES[only] || option('confirm') !== only)) {
  console.error('--apply rewrites one table: pass --table db|companies and repeat it with --confirm.')
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function airtable(path, init = {}, attempt = 0) {
  await sleep(250)
  const response = await fetch(`https://api.airtable.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  if ((response.status === 429 || response.status >= 500) && attempt < 3) {
    await sleep(response.status === 429 ? 30_000 : 2_000)
    return airtable(path, init, attempt + 1)
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Airtable ${response.status}: ${JSON.stringify(body.error ?? body)}`)
  return body
}

async function readAll(table) {
  const records = []
  let offset
  do {
    const params = new URLSearchParams({ pageSize: '100', returnFieldsByFieldId: 'true' })
    params.append('fields[]', table.field)
    if (offset) params.set('offset', offset)
    const page = await airtable(`/v0/${baseId}/${table.id}?${params}`)
    records.push(...(page.records ?? []))
    offset = page.offset
    process.stderr.write(`\r${table.label}: ${records.length} read`)
  } while (offset)
  process.stderr.write('\n')
  return records
}

function plan(records, table) {
  return records.map((record) => {
    const current = typeof record.fields[table.field] === 'string' ? record.fields[table.field] : ''
    const { domain, issue } = parseDomain(current)
    const status = !current.trim() ? 'blank' : issue ? `unusable:${issue}` : domain === current ? 'unchanged' : 'change'
    return { table: table.label, id: record.id, current, next: domain, status }
  })
}

const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`

const rows = []
for (const [key, table] of Object.entries(TABLES)) {
  if (only && key !== only) continue
  rows.push(...plan(await readAll(table), table))
}

const summary = {}
for (const row of rows) {
  summary[row.table] ??= {}
  summary[row.table][row.status] = (summary[row.table][row.status] ?? 0) + 1
}
const out = option('out') ?? join(tmpdir(), `airtable-website-backfill-${Date.now()}.csv`)
writeFileSync(
  out,
  [['Table', 'Record ID', 'Current', 'Bare domain', 'Status'].map(cell).join(','),
    ...rows.map((row) => [row.table, row.id, row.current, row.next, row.status].map(cell).join(','))].join('\r\n'),
)
console.log(JSON.stringify(summary, null, 2))
console.log(`Row-level report: ${out}`)

if (apply) {
  const table = TABLES[only]
  const changes = rows.filter((row) => row.status === 'change')
  console.log(`Rewriting ${changes.length} ${table.label} values in batches of 10…`)
  let done = 0
  for (let index = 0; index < changes.length; index += 10) {
    const chunk = changes.slice(index, index + 10)
    await airtable(`/v0/${baseId}/${table.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        typecast: false,
        records: chunk.map((row) => ({ id: row.id, fields: { [table.field]: row.next } })),
      }),
    })
    done += chunk.length
    process.stderr.write(`\r${done}/${changes.length} rewritten`)
  }
  process.stderr.write('\n')
} else {
  console.log('Dry run: nothing was written.')
}
