#!/usr/bin/env node
/**
 * Full-coverage conversion check.
 *
 * `css-declares.mjs` verifies declarations you remember to list. This lists
 * them for you: given the ORIGINAL stylesheet, it extracts every declaration
 * it contained and checks each one still exists somewhere in the built CSS.
 *
 * Written because spot-checking missed the failure that matters. Deleting a
 * base rule while keeping its variants leaves the class present in the
 * stylesheet, so the unknown-class guard stays green while the element renders
 * unstyled — that happened to `.msg-bubble` and `.msg-meta`, and a
 * hand-written sample of declarations happened not to include their padding.
 *
 *   git show HEAD:frontend/src/pages/x.css > /tmp/before.css
 *   node scripts/css-parity.mjs /tmp/before.css
 *
 * Values Tailwind legitimately rewrites (shorthand reordering, `calc()`
 * elision, longhand splits) are reported as near-misses with what was seen for
 * the same property, so a real gap is distinguishable from a rewrite.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [sheet] = process.argv.slice(2)
if (!sheet) { console.error('usage: css-parity.mjs <original-stylesheet>'); process.exit(2) }

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
/** Minified CSS drops the space after a colon and around commas. */
const norm = (d) => d.trim().replace(/\s+/g, ' ').replace(/\s*:\s*/, ':').replace(/,\s+/g, ',')

/** Declarations the original sheet contained, keyed by property. */
const wanted = new Map()
for (const [, body] of strip(readFileSync(sheet, 'utf8')).matchAll(/\{([^{}]*)\}/g)) {
  for (const decl of body.split(';')) {
    const d = norm(decl)
    if (!d.includes(':') || d.startsWith('--')) continue
    wanted.set(d, d.split(':')[0].trim())
  }
}

const dir = join(process.cwd(), 'dist/assets')
const css = readdirSync(dir).filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
const have = new Set()
const byProp = new Map()
for (const [, body] of css.matchAll(/\{([^{}]*)\}/g)) {
  for (const decl of body.split(';')) {
    const d = norm(decl)
    if (!d.includes(':')) continue
    have.add(d)
    const p = d.split(':')[0].trim()
    if (!byProp.has(p)) byProp.set(p, new Set())
    byProp.get(p).add(d)
  }
}

let missing = 0
for (const [decl, prop] of wanted) {
  if (have.has(decl)) continue
  missing += 1
  console.log(`  MISS  ${decl}`)
  const near = [...(byProp.get(prop) ?? [])].slice(0, 3)
  for (const n of near) console.log(`          saw: ${n}`)
}
console.log(`\n  ${wanted.size - missing}/${wanted.size} declarations still present`)
process.exit(missing ? 1 : 0)
