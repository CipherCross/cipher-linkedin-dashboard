/**
 * Cascade guard.
 *
 * jsdom applies no stylesheet and resolves no layer, so none of this is
 * observable from a rendering test — these defects render perfectly in every
 * unit test and wrong in a browser. The guard therefore reads the CSS entry and
 * the BUILT bundle as text.
 *
 * Each assertion here corresponds to a defect that was actually measured on the
 * gallery during the Phase 0 migration, not to a hypothetical.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ENTRY = join(__dirname, '../src/index.css')
const entry = readFileSync(ENTRY, 'utf8')
/** Comments in this file talk ABOUT the rules being guarded against, so every
 *  content assertion runs against the comment-stripped source. */
const code = entry.replace(/\/\*[\s\S]*?\*\//g, '')

describe('CSS entry', () => {
  it('declares the layer order before any import', () => {
    const layer = entry.indexOf('@layer theme, base, foundation, app, utilities;')
    const firstImport = entry.indexOf('@import')
    expect(layer).toBeGreaterThan(-1)
    expect(layer).toBeLessThan(firstImport)
  })

  it('imports Tailwind by the canonical string the shadcn CLI detects', () => {
    // Splitting this into theme.css + utilities.css to drop preflight makes
    // `shadcn init` and every `shadcn add` fail with "No Tailwind CSS
    // configuration found". Verified both ways.
    expect(entry).toMatch(/@import\s+"tailwindcss";/)
  })

  it('leaves no local stylesheet unlayered', () => {
    // Unlayered CSS outranks EVERY layer regardless of specificity, so one
    // unlayered sheet silently defeats all Tailwind utilities.
    const localImports = [...entry.matchAll(/@import\s+'\.\/([^']+)'([^;]*);/g)]
    expect(localImports.length).toBeGreaterThan(0)
    for (const [, file, rest] of localImports) {
      expect(rest, `${file} is imported without a layer()`).toMatch(/layer\(/)
    }
  })

  it('keeps ui.css and styles.css in ONE layer, ui.css first', () => {
    // Splitting them inverts the cascade: a layer beats specificity outright,
    // so every route rule in styles.css would defeat every primitive rule in
    // ui.css. Measured: it dropped the danger border off an invalid input, the
    // grey fill off a disabled one, and collapsed a textarea from 120px to 66px.
    const ui = entry.match(/@import\s+'\.\/ui\/ui\.css'\s+layer\((\w+)\)/)
    const legacy = entry.match(/@import\s+'\.\/styles\.css'\s+layer\((\w+)\)/)
    expect(ui?.[1]).toBeDefined()
    expect(legacy?.[1]).toBe(ui?.[1])
    expect(entry.indexOf("'./ui/ui.css'")).toBeLessThan(entry.indexOf("'./styles.css'"))
  })

  it('has no dark-mode block', () => {
    // One light theme is a product decision. Every `shadcn add` tries to
    // regenerate `.dark` and the `dark` custom variant.
    expect(code).not.toMatch(/^\s*\.dark\s*\{/m)
    expect(code).not.toMatch(/@custom-variant\s+dark/)
  })

  it('does not reintroduce a translucent focus halo', () => {
    // styles/reset.css rejects this explicitly: a halo fails WCAG 1.4.11 on a
    // light surface and vanishes over a tinted one. shadcn ships
    // `outline-ring/50` on `*` by default.
    expect(code).not.toMatch(/outline-ring/)
  })

  it('does not default every element to shadcn’s border colour', () => {
    // `* { @apply border-border }` changed the computed border-colour of 217 of
    // 271 elements on the gallery away from currentColor, for no visual gain.
    expect(code).not.toMatch(/\*\s*\{[^}]*border-border/)
  })

  it('never lets shadcn redefine a token tokens.css owns', () => {
    // shadcn's `:root` is UNLAYERED, so it outranks tokens.css in `foundation`.
    // Its --accent is a near-white hover surface; ours is the brand blue. When
    // they collided, the primary button rendered white-on-white.
    const tokens = readFileSync(join(__dirname, '../src/styles/tokens.css'), 'utf8')
    const ours = new Set([...tokens.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]))
    const blocks = [
      ...entry.matchAll(/@theme inline \{([\s\S]*?)\n\}/g),
      ...entry.matchAll(/\n:root \{([\s\S]*?)\n\}/g),
    ]
    const collisions: string[] = []
    for (const [, body] of blocks) {
      for (const [, name] of body.matchAll(/--([a-z0-9-]+)\s*:/g)) {
        if (ours.has(name)) collisions.push(name)
      }
    }
    // The radius scale is deliberately shared: shadcn's names are repointed at
    // our geometry (--radius-sm: var(--radius-control)), so the VALUES agree.
    const deliberate = new Set(['radius-sm', 'radius-md', 'radius-lg'])
    expect([...new Set(collisions)].filter((c) => !deliberate.has(c))).toEqual([])
  })
})

describe('built CSS', () => {
  const dist = join(__dirname, '../dist/assets')
  const built = existsSync(dist)
    ? readdirSync(dist).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(dist, f), 'utf8')).join('\n')
    : null

  it.runIf(built)('emits our tokens, not shadcn’s, for the brand accent', () => {
    expect(built).toMatch(/--accent:\s*#2563eb/)
  })

  it.runIf(built)('ships no .dark block', () => {
    expect(built).not.toMatch(/\.dark\s*\{\s*--background/)
  })
})
