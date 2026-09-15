import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Replies workspace's two-pane behaviour is CSS, and the defect that made
 * Review / Next step / Save unreachable at 1280 and 1440 was a pure cascade
 * accident: a base `.replies-pane-switch { display: none }` written *after* the
 * container query that reveals it. Both rules are one class selector, so source
 * order decided, and the only control that reaches the review pane never
 * rendered. A rendering test could not see it — jsdom does not resolve
 * container queries, and the component was in the tree the whole time.
 *
 * So this asserts the stylesheet itself: anything a conditional block reveals
 * must not be re-hidden by an unconditional rule further down the file.
 */

const CSS_PATH = fileURLToPath(new URL('../src/pages/replies-inbox.css', import.meta.url))

/** The file with comments removed, so a selector quoted in prose is not parsed. */
function stylesheet(): string {
  return readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Split into top-level rules and conditional (`@media` / `@container`) blocks. */
function partition(css: string): { top: string; conditional: string } {
  let depth = 0
  let atRuleDepth: number | null = null
  let top = ''
  let conditional = ''
  let buffer = ''
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]
    buffer += char
    if (char === '{') {
      if (atRuleDepth === null && /@(media|container|supports)[^{}]*$/.test(buffer.slice(0, -1))) {
        atRuleDepth = depth
      }
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (atRuleDepth !== null && depth === atRuleDepth) {
        conditional += buffer
        buffer = ''
        atRuleDepth = null
        continue
      }
      if (depth === 0 && atRuleDepth === null) {
        top += buffer
        buffer = ''
      }
    }
  }
  return { top, conditional }
}

/** Every `display:` declaration for `selector`, in source order, as [index, value]. */
function displayRules(css: string, selector: string): Array<[number, string]> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(^|[,{}])\\s*${escaped}\\s*(?:,[^{}]*)?\\{([^{}]*)\\}`, 'g')
  const found: Array<[number, string]> = []
  let match = pattern.exec(css)
  while (match) {
    const declaration = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(match[2])
    if (declaration) found.push([match.index, declaration[1].trim()])
    match = pattern.exec(css)
  }
  return found
}

describe('Replies workspace stylesheet', () => {
  const css = stylesheet()
  const { top, conditional } = partition(css)

  it('reveals the pane switch below the three-pane threshold', () => {
    expect(conditional).toContain('@container (max-width: 1239px)')
    const inQuery = displayRules(conditional, '.replies-pane-switch')
    expect(inQuery).toHaveLength(1)
    expect(inQuery[0][1]).not.toBe('none')
  })

  it('never re-hides the pane switch from an unconditional rule', () => {
    // The base rule may hide it — that is the wide-screen default — but it must
    // be the *only* unconditional `display`, so the container query wins.
    const unconditional = displayRules(top, '.replies-pane-switch')
    expect(unconditional).toHaveLength(1)
    expect(unconditional[0][1]).toBe('none')
    // And it has to come before the query that reveals it.
    const base = css.indexOf('.replies-pane-switch')
    expect(base).toBeGreaterThan(-1)
    expect(base).toBeLessThan(css.indexOf('@container (max-width: 1239px)'))
  })

  it('keeps the review pane reachable in the two-pane layout', () => {
    // Below the threshold exactly one of list / inspector is hidden, and which
    // one is decided by .pane-review — the class the switch toggles.
    expect(conditional).toContain('.replies-workspace.pane-review .replies-list-pane { display: none; }')
    expect(conditional).toContain('.replies-workspace:not(.pane-review) .replies-inspector-pane { display: none; }')
    // At ≥1240px all three panes show, so nothing unconditional may hide the
    // inspector — the base rule lays it out like the other two.
    const unconditional = displayRules(top, '.replies-inspector-pane')
    expect(unconditional.length).toBeGreaterThan(0)
    expect(unconditional.map(([, value]) => value)).not.toContain('none')
  })
})
