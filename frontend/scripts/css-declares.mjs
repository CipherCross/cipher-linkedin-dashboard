#!/usr/bin/env node
/**
 * Does the built CSS actually declare these things?
 *
 * Written after six consecutive false alarms from hand-rolled greps against
 * dist/assets/*.css. Every one was the pattern, never the output: Tailwind
 * reorders `animation` shorthand, rewrites `flex: 2 1 420px` to `flex: 2 420px`
 * and `flex: 0 0 auto` to `flex: none`, drops a redundant `calc()` inside
 * `min()`, emits `:after` rather than `::after`, expresses a dashed border as
 * `--tw-border-style: dashed`, and escapes every bracket in a selector.
 *
 * So this matches against DECLARATIONS parsed out of the rule blocks, with
 * whitespace normalised, rather than against the raw text.
 *
 *   node scripts/css-declares.mjs 'width:18px' 'grid-template-columns:1fr 300px'
 *
 * Exits non-zero if any argument is absent, and prints a near-miss for each so
 * a genuine difference is distinguishable from a spelling one.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), 'dist/assets')
const css = readdirSync(dir).filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')

/** Every declaration in the sheet, normalised. */
const declarations = new Set()
for (const [, body] of css.matchAll(/\{([^{}]*)\}/g)) {
  for (const decl of body.split(';')) {
    const d = decl.trim().replace(/\s+/g, ' ')
    if (d.includes(':')) declarations.add(d)
  }
}

const wanted = process.argv.slice(2)
if (!wanted.length) {
  console.error('usage: css-declares.mjs <declaration>...')
  process.exit(2)
}

let missing = 0
for (const want of wanted) {
  const norm = want.trim().replace(/\s+/g, ' ')
  if (declarations.has(norm)) { console.log(`  OK    ${want}`); continue }
  missing += 1
  const [prop] = norm.split(':')
  const near = [...declarations].filter((d) => d.startsWith(prop + ':')).slice(0, 3)
  console.log(`  MISS  ${want}`)
  for (const n of near) console.log(`          saw: ${n}`)
}
process.exit(missing ? 1 : 0)
