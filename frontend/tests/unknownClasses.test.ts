/**
 * Unknown-utility guard.
 *
 * `npm run build` (tsc -b) is the ONLY automated check over src/, and there is
 * no linter. A mistyped Tailwind utility therefore produces no error anywhere:
 * it simply generates no CSS and the element renders unstyled. This is a defect
 * class the pre-Tailwind stylesheet approach did not have, and this guard is
 * the only thing standing in for it.
 *
 * It cannot catch everything. Deleting a BASE rule while keeping its variants
 * leaves the class present in the stylesheet, so this guard stays green while
 * the element loses its padding — that happened twice in the Tailwind
 * migration, to `.msg-bubble` and `.msg-meta`. Both were found by diffing the
 * generated CSS against the rules removed (scripts/css-declares.mjs), not
 * here. A guard for it was written and then removed: page-namespaced
 * conventions like `.overview .ov-avatar` are structurally identical to the
 * defect, so it needed an allowlist longer than its own findings.
 *
 * It walks the TypeScript AST rather than using a regex. A regex over
 * `className={...}` scrapes JS expression fragments (`===`, `col.id`,
 * `SEVERITY_CLS[iss.severity]`) and was measured at ~80% false positives.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const SRC = join(__dirname, '../src')
const DIST = join(__dirname, '../dist/assets')

/** Class names assembled at runtime from a literal prefix, e.g.
 *  `ui-status--${tone}` in Badge.tsx. The prefix alone never matches a
 *  rule, so it is declared here rather than silently ignored. */
/**
 * Class names that legitimately have no CSS rule of their own:
 *  - Tailwind markers. `group` and `peer` exist only so that `group-hover:*`
 *    and `peer-checked:*` on descendants have something to match; Tailwind
 *    emits no `.group` rule.
 *  - Class names owned by a third-party package's own stylesheet, which is
 *    bundled separately from ours.
 */
const NO_RULE_BY_DESIGN = new Set(['group', 'peer', 'toaster', 'cn-toast'])


const DYNAMIC_PREFIXES = ['deployed-step-', 'ui-status--']

/**
 * Class names applied in JSX that match no CSS rule at all. Every one of these
 * predates the Tailwind migration — they are dead markup, harmless but real.
 *
 * This list is a RATCHET: it may only ever shrink. Each Phase 3 route
 * migration should delete its entries, and reaching [] is one of the
 * conditions for retiring src/styles.css. Adding to it requires a reason in
 * the commit message, because the normal cause of a new entry is a typo.
 */
const PRE_EXISTING_DEAD = new Set([
  // `deployed-sequence` is the last one: campaignWorkspace.test.tsx uses it to
  // assert the chain is ABSENT, so it has no element to hang a data attribute
  // on. It goes when that assertion is rewritten.
  'deployed-sequence',
])

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkFiles(p, out)
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** Literal class tokens only: string literals, and the literal text of a
 *  template literal (its `${}` holes are skipped, not guessed at). */
function classTokens(file: string): Map<string, string> {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found = new Map<string, string>()
  const add = (text: string) => {
    for (const tok of text.split(/\s+/)) if (tok) found.set(tok, file)
  }
  const fromExpr = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node.text)
    else if (ts.isTemplateExpression(node)) {
      add(node.head.text)
      for (const span of node.templateSpans) add(span.literal.text)
    } else if (ts.isConditionalExpression(node)) {
      fromExpr(node.whenTrue); fromExpr(node.whenFalse)
    } else if (ts.isBinaryExpression(node)) {
      fromExpr(node.left); fromExpr(node.right)
    } else if (ts.isParenthesizedExpression(node)) fromExpr(node.expression)
    else if (ts.isJsxExpression(node) && node.expression) fromExpr(node.expression)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText() === 'className' && node.initializer) {
      fromExpr(node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return found
}

describe('unknown class names', () => {
  const hasDist = existsSync(DIST)

  it.runIf(hasDist)('every literal className token resolves to a real CSS rule', () => {
    const css = readdirSync(DIST)
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(DIST, f), 'utf8'))
      .join('\n')

    // Selectors as authored, plus the same with CSS escapes removed so that
    // utilities like `px-2\.5` and `w-[137px]` match their JSX spelling.
    const present = new Set<string>()
    for (const [, sel] of css.matchAll(/\.((?:[A-Za-z0-9_-]|\\.)+)/g)) {
      present.add(sel)
      present.add(sel.replace(/\\/g, ''))
    }

    const unknown = new Map<string, string>()
    for (const file of walkFiles(SRC)) {
      for (const [tok, where] of classTokens(file)) {
        if (present.has(tok)) continue
        if (DYNAMIC_PREFIXES.some((p) => tok === p || tok.startsWith(p))) continue
        if (NO_RULE_BY_DESIGN.has(tok)) continue
        if (tok.startsWith('group/') || tok.startsWith('peer/')) continue
        if (PRE_EXISTING_DEAD.has(tok)) continue
        unknown.set(tok, where.replace(/.*\/src\//, 'src/'))
      }
    }

    expect(
      [...unknown].map(([t, f]) => `${t}  (${f})`).sort(),
      'class names with no matching CSS rule — a typo, or dead markup',
    ).toEqual([])
  })

  it.runIf(hasDist)('the dead-class allowlist only shrinks', () => {
    // A name that has since been cleaned up must be removed from the list, so
    // the list cannot quietly become a place where typos go to hide.
    const css = readdirSync(DIST)
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(DIST, f), 'utf8'))
      .join('\n')
    const present = new Set<string>()
    for (const [, sel] of css.matchAll(/\.((?:[A-Za-z0-9_-]|\\.)+)/g)) {
      present.add(sel); present.add(sel.replace(/\\/g, ''))
    }
    const used = new Set<string>()
    for (const file of walkFiles(SRC)) for (const tok of classTokens(file).keys()) used.add(tok)

    const stale = [...PRE_EXISTING_DEAD].filter((c) => present.has(c) || !used.has(c))
    expect(stale, 'allowlisted names that are no longer dead — delete them from PRE_EXISTING_DEAD').toEqual([])
  })
})
