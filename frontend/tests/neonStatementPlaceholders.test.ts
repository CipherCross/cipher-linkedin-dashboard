import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Every value an operation sends must be referenced by its SQL.
 *
 * node-postgres sends parameters untyped, so PostgreSQL infers each one's type
 * from where it is used. A value the text never mentions has no use to infer
 * from, and the statement fails to parse with 42P18 ("could not determine data
 * type of parameter $N"). `replies.projectReview` shipped that way: a
 * `reviewedAt` value with no `$6` in the text failed every manual reply-review
 * save in production, and no offline test could see it because nothing
 * compared the two.
 */
const OPERATIONS_DIR = new URL('../api/_lib/data/operations/', import.meta.url)
const CONTEXT = {
  actor: { kind: 'user', actorId: 'actor', tenantId: 'tenant', role: 'admin' },
  params: {}, page: { limit: 10, cursor: null }, after: undefined, range: undefined,
}

describe('Neon operation placeholders', () => {
  it('references every sent value and sends a value for every placeholder', async () => {
    const defects: string[] = []
    let checked = 0
    for (const file of readdirSync(OPERATIONS_DIR).filter((name) => name.endsWith('.ts'))) {
      const module = await import(new URL(file, OPERATIONS_DIR).href) as Record<string, unknown>
      for (const [name, operation] of Object.entries(module)) {
        const build = (operation as { build?: unknown } | null)?.build
        if (typeof build !== 'function') continue
        let statement: { text: string; values?: readonly unknown[] }
        // A few builders refuse empty params by design (allowlisted routes,
        // retired AI writes); they cannot be probed with a generic context.
        try { statement = build(CONTEXT) } catch { continue }
        checked += 1
        const sent = statement.values?.length ?? 0
        const used = new Set([...statement.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))
        const unreferenced = Array.from({ length: sent }, (_, index) => index + 1).filter((n) => !used.has(n))
        const unsent = [...used].filter((n) => n > sent)
        if (unreferenced.length || unsent.length) defects.push(`${file}:${name} unreferenced=[${unreferenced}] unsent=[${unsent}]`)
      }
    }
    expect(checked).toBeGreaterThan(150)
    expect(defects).toEqual([])
  })
})
