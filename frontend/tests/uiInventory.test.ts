/** Phase 0 ratchet proof.  The temporary file is always removed before the
 * test completes; it exercises the same AST path a product edit uses. */
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const frontend = join(__dirname, '..')
const script = join(frontend, 'scripts/ui-inventory.mjs')
let mutation: string | null = null

function inventory(fixture?: string): { status: number, output: string } {
  try {
    const output = execFileSync(process.execPath, [script, ...(fixture ? [`--fixture=${fixture}`] : [])], { cwd: frontend, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, output }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failed.status ?? 1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` }
  }
}

afterEach(() => { if (mutation && existsSync(mutation)) rmSync(join(mutation, '..'), { recursive: true, force: true }); mutation = null })

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
})
