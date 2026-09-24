/** Phase 0 ratchet proof.  The temporary file is always removed before the
 * test completes; it exercises the same AST path a product edit uses. */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bundleDelta } from '../scripts/ui-inventory.mjs'

const frontend = join(__dirname, '..')
const script = join(frontend, 'scripts/ui-inventory.mjs')
let mutation: string | null = null
let fixtureRoot: string | null = null

function inventory(fixture?: string): { status: number, output: string } {
  try {
    const output = execFileSync(process.execPath, [script, ...(fixture ? [`--fixture=${fixture}`] : [])], { cwd: frontend, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, output }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failed.status ?? 1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
  }
}

afterEach(() => {
  if (mutation && existsSync(mutation)) rmSync(join(mutation, '..'), { recursive: true, force: true })
  if (fixtureRoot && existsSync(fixtureRoot)) rmSync(fixtureRoot, { recursive: true, force: true })
  mutation = null
  fixtureRoot = null
})

describe('UI inventory ratchet', () => {
  it('passes the unmodified reviewed Phase 0 baseline', () => {
    const result = inventory()
    expect(result.status).toBe(0)
    expect(result.output).not.toContain('FAIL ')
  })

  it('rejects deliberate raw-control, legacy-token, and direct-import mutations', () => {
    mutation = join(mkdtempSync(join(tmpdir(), 'ui-inventory-')), 'mutation.tsx')
    writeFileSync(mutation, `
      import { Calendar } from './components/ui/calendar'
      export function UiInventoryMutation() {
        return <><button className="btn">Unexpected</button><Calendar /></>
      }
    `)
    const result = inventory(mutation)
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('FAIL raw controls:')
    expect(result.output).toContain('FAIL compatibility tokens:')
    expect(result.output).toContain('FAIL forbidden direct imports:')
  })

  it('matches route chunks across Vite content hashes and enforces their gzip budget', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'ui-bundle-inventory-'))
    const fixture = join(fixtureRoot, 'bundle.json')
    writeFileSync(fixture, JSON.stringify({
      baseline: { available: true, chunks: [{ name: 'Overview-a1b2c3d4.js', type: 'js', scope: 'production', gzipBytes: 10000 }] },
      current: { available: true, chunks: [{ name: 'Overview-e5f6g7h8.js', type: 'js', scope: 'production', entry: false, gzipBytes: 25000 }] },
    }))
    const { baseline, current } = JSON.parse(readFileSync(fixture, 'utf8'))
    const failures: string[] = []

    bundleDelta(current, baseline, failures)

    expect(failures).toEqual(['bundle: Overview-e5f6g7h8.js gzip grew above its larger-of-10%-or-10KB route budget (10000 -> 25000)'])
  })

  it('keeps same-named entry and route chunks distinct by budget', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'ui-bundle-inventory-'))
    const fixture = join(fixtureRoot, 'bundle.json')
    writeFileSync(fixture, JSON.stringify({
      baseline: { available: true, chunks: [
        { name: 'index.js', type: 'js', scope: 'production', gzipBytes: 10000 },
        { name: 'index.js', type: 'js', scope: 'production', entry: true, gzipBytes: 20000 },
      ] },
      current: { available: true, chunks: [
        { name: 'index-11111111.js', type: 'js', scope: 'production', entry: true, gzipBytes: 21100 },
        { name: 'index-22222222.js', type: 'js', scope: 'production', entry: false, gzipBytes: 20300 },
      ] },
    }))
    const { baseline, current } = JSON.parse(readFileSync(fixture, 'utf8'))
    const failures: string[] = []

    bundleDelta(current, baseline, failures)

    expect(failures).toEqual([
      'bundle: index-11111111.js gzip grew above its 5% entry budget (20000 -> 21100)',
      'bundle: index-22222222.js gzip grew above its larger-of-10%-or-10KB route budget (10000 -> 20300)',
    ])
  })
})

describe('UI exceptions are named where they live (Phase 12)', () => {
  it('marks every allowlisted raw control with its ui-exception comment', () => {
    const allowlist = JSON.parse(readFileSync(join(frontend, 'ui-inventory-allowlist.json'), 'utf8')) as {
      entries: Array<{ id: string; kind: string; path: string }>
    }
    const unmarked = allowlist.entries
      .filter((entry) => entry.kind === 'raw-control')
      .filter((entry) => !readFileSync(join(frontend, entry.path), 'utf8').includes(`ui-exception(${entry.id})`))
      .map((entry) => `${entry.id} (${entry.path})`)
    expect(unmarked).toEqual([])
  })

  it('has no compatibility block left in ui.css', () => {
    expect(readFileSync(join(frontend, 'src/ui/ui.css'), 'utf8')).not.toContain('LEGACY route + component styles.')
  })
})
