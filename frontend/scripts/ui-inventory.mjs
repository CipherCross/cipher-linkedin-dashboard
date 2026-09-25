#!/usr/bin/env node
/**
 * The component-system migration needs a guard that can see JSX structure, not
 * just text.  This is deliberately a small TypeScript-AST program rather than
 * an ESLint rule: it is useful in a checkout without an editor integration and
 * its JSON report is the reviewable migration ledger.
 *
 * `npm run ui:inventory` checks the reviewed starting inventory.  It permits
 * findings to disappear, but never permits a new raw element, legacy token,
 * modal root, or generated-widget bypass.  `--update` is an explicit review
 * operation; it is the only mode that rewrites the baseline or selector ledger.
 */
import { gzip as gzipBuffer } from 'node:zlib'
import { promisify } from 'node:util'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import postcss from 'postcss'

const gzip = promisify(gzipBuffer)
const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const BASELINE = join(ROOT, 'ui-inventory-baseline.json')
const ALLOWLIST = join(ROOT, 'ui-inventory-allowlist.json')
const SELECTOR_OWNERS = join(ROOT, 'ui-selector-owners.json')
const UPDATE = process.argv.includes('--update')
const JSON_ONLY = process.argv.includes('--json')
const FINAL = process.argv.includes('--final')
const FIXTURE = process.argv.find((arg) => arg.startsWith('--fixture='))?.slice('--fixture='.length)

const RAW_TAGS = new Set(['button', 'input', 'select', 'textarea', 'table'])
const COMPATIBILITY_MARKER = 'LEGACY route + component styles.'
const GENERATED_UI_SEGMENT = `${sep}src${sep}components${sep}ui${sep}`
const APPLICATION_UI_SEGMENT = `${sep}src${sep}ui${sep}`

const posix = (path) => relative(ROOT, path).split(sep).join('/')
const stable = (value) => JSON.stringify(value, null, 2) + '\n'
const byKey = (a, b) => a.key.localeCompare(b.key)
const entryKey = (entry) => `${entry.kind}:${entry.path ?? ''}:${entry.symbol ?? ''}:${entry.tag ?? entry.token ?? entry.specifier ?? entry.selector}:${entry.nativeType ?? ''}:${entry.ordinal ?? 1}`
const COMPATIBILITY_TOKENS = new Set(['btn', 'btn-accent', 'link-btn', 'icon-btn', 'icon-only-btn', 'card', 'badge'])

async function walk(dir, predicate = () => true, out = []) {
  for (const name of await readdir(dir)) {
    const file = join(dir, name)
    const info = await stat(file)
    if (info.isDirectory()) await walk(file, predicate, out)
    else if (predicate(file)) out.push(file)
  }
  return out.sort()
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((part) => part.literal.text)]
  if (ts.isConditionalExpression(node)) return [...literalText(node.whenTrue), ...literalText(node.whenFalse)]
  if (ts.isBinaryExpression(node)) return [...literalText(node.left), ...literalText(node.right)]
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression)
  return []
}

function classTokens(attribute) {
  if (!attribute.initializer) return []
  const value = ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : attribute.initializer
  if (!value) return []
  return literalText(value).flatMap((text) => text.split(/\s+/).filter(Boolean))
}

function enclosingSymbol(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) && current.name) return current.name.text
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
  }
  return '<module>'
}

function jsxAttribute(node, name) {
  return node.properties.find((property) => ts.isJsxAttribute(property) && property.name.text === name)
}

function jsxAttributeText(node, name) {
  const attribute = jsxAttribute(node, name)
  return attribute ? classTokens(attribute).join(' ') : ''
}

function addOrdinals(entries) {
  const seen = new Map()
  for (const entry of entries.sort((a, b) => a.line - b.line || String(a.tag ?? a.token ?? a.specifier).localeCompare(String(b.tag ?? b.token ?? b.specifier)))) {
    const base = `${entry.kind}:${entry.path ?? ''}:${entry.symbol ?? ''}:${entry.tag ?? entry.token ?? entry.specifier ?? entry.selector}:${entry.nativeType ?? ''}`
    entry.ordinal = (seen.get(base) ?? 0) + 1
    seen.set(base, entry.ordinal)
    entry.key = entryKey(entry)
  }
  entries.sort(byKey)
}

function importIsGeneratedUi(specifier) {
  return /(?:^|\/)components\/ui\//.test(specifier) || /(?:^|\/)ui\/(?:button|calendar|command|dialog|dropdown-menu|input(?:-group)?|popover|sonner|textarea|tooltip)$/.test(specifier)
}

function isInfrastructureFile(file) {
  return file.includes(GENERATED_UI_SEGMENT) || file.includes(APPLICATION_UI_SEGMENT)
}

async function sourceFiles() {
  const files = await walk(SRC, (file) => /\.(tsx|ts)$/.test(file))
  if (FIXTURE) files.push(FIXTURE)
  return files.sort()
}

async function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : fallback
}

async function scanSource(allowlist, knownCompatibilityTokens) {
  const rawControls = []
  const allowlistedRawControls = []
  const directImports = []
  const forbiddenDirectImports = []
  const modalRoots = []
  const compatibilityTokens = []
  const classConsumers = new Map()
  const allowed = allowlist.entries ?? []
  const files = await sourceFiles()

  const allowedEntry = (kind, path, symbol, tag, nativeType, specifier) => allowed.find((entry) =>
    entry.kind === kind && entry.path === path && entry.symbol === symbol && (!entry.tag || entry.tag === tag) && (!entry.nativeType || entry.nativeType === nativeType) && (!entry.specifier || entry.specifier === specifier),
  )

  for (const file of files) {
    const path = posix(file)
    const text = await readFile(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !isInfrastructureFile(file)) {
        const specifier = node.moduleSpecifier.text
        if (importIsGeneratedUi(specifier)) {
          const clause = node.importClause
          const symbol = clause?.name?.text
            ?? (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
              ? `{ ${clause.namedBindings.elements.map((element) => element.name.text).sort().join(', ')} }`
              : clause?.namedBindings?.getText(source))
            ?? '<side-effect>'
          const entry = { kind: 'direct-import', path, line: lineOf(node), symbol, specifier }
          directImports.push(entry)
          if (!allowedEntry(entry.kind, path, symbol, undefined, undefined, specifier)) forbiddenDirectImports.push(entry)
        }
      }

      if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node
        const tag = opening.tagName.getText(source)
        const symbol = enclosingSymbol(opening)
        const line = lineOf(opening)
        if (!isInfrastructureFile(file) && RAW_TAGS.has(tag)) {
          const nativeType = tag === 'input' ? jsxAttributeText(opening.attributes, 'type') : undefined
          const entry = { kind: 'raw-control', path, line, symbol, tag, nativeType }
          const exception = allowedEntry(entry.kind, path, symbol, tag, nativeType)
          ;(exception ? allowlistedRawControls : rawControls).push({ ...entry, allowlistId: exception?.id })
        }
        const role = jsxAttribute(opening.attributes, 'role')
        const ariaModal = jsxAttribute(opening.attributes, 'aria-modal')
        if (!isInfrastructureFile(file) && ((role && classTokens(role).includes('dialog')) || ariaModal)) {
          const entry = { kind: 'modal-root', path, line, symbol, tag, token: ariaModal ? 'aria-modal' : 'role=dialog' }
          modalRoots.push(entry)
        }
        const classes = jsxAttribute(opening.attributes, 'className')
        if (classes) for (const token of classTokens(classes)) {
          if (!classConsumers.has(token)) classConsumers.set(token, new Set())
          classConsumers.get(token).add(path)
          if (COMPATIBILITY_TOKENS.has(token) || knownCompatibilityTokens.has(token)) compatibilityTokens.push({ kind: 'compatibility-token', path, line, symbol, token })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  for (const collection of [rawControls, allowlistedRawControls, directImports, forbiddenDirectImports, modalRoots, compatibilityTokens]) addOrdinals(collection)
  return { rawControls, allowlistedRawControls, directImports, forbiddenDirectImports, modalRoots, compatibilityTokens, classConsumers }
}

async function compatibilitySelectors(classConsumers) {
  const cssPath = join(SRC, 'ui/ui.css')
  const css = await readFile(cssPath, 'utf8')
  const start = css.indexOf(COMPATIBILITY_MARKER)
  if (start < 0) return []
  const legacyStart = css.lastIndexOf('/*', start)
  const legacy = css.slice(legacyStart < 0 ? start : legacyStart)
  const found = new Map()
  const tree = postcss.parse(legacy)
  const duplicateOrdinals = new Map()
  tree.walkRules((rule) => {
    const selector = rule.selector.trim().replace(/\s+/g, ' ')
    if (!selector) return
    const classes = [...selector.matchAll(/\.([A-Za-z_-][A-Za-z0-9_-]*)/g)].map((item) => item[1])
    const consumerCandidates = [...new Set(classes.flatMap((name) => [...(classConsumers.get(name) ?? [])]))].sort()
    const ancestry = []
    for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) if (parent.type === 'atrule') ancestry.unshift(`@${parent.name} ${parent.params}`.trim())
    const identity = `${ancestry.join(' > ')}|${selector}`
    const ordinal = (duplicateOrdinals.get(identity) ?? 0) + 1
    duplicateOrdinals.set(identity, ordinal)
    const entry = { kind: 'compatibility-selector', path: 'src/ui/ui.css', selector, ancestry, line: (css.slice(0, legacyStart < 0 ? start : legacyStart).match(/\n/g)?.length ?? 0) + rule.source.start.line, ordinal, consumerCandidates }
    entry.key = `${entry.kind}:${identity}:${ordinal}`
    found.set(entry.key, entry)
  })
  const entries = [...found.values()]
  return entries.sort(byKey)
}

async function sourceCounts() {
  const files = await walk(SRC, (file) => /\.(tsx|css)$/.test(file))
  const counts = { tsx: { files: 0, lines: 0 }, css: { files: 0, lines: 0 } }
  for (const file of files) {
    const kind = extname(file) === '.tsx' ? 'tsx' : 'css'
    counts[kind].files += 1
    counts[kind].lines += (await readFile(file, 'utf8')).split('\n').length - 1
  }
  return counts
}

async function gzipBytes(file) {
  const output = await gzip(await readFile(file))
  return output.byteLength
}

async function bundleReport() {
  const assets = join(ROOT, 'dist/assets')
  if (!existsSync(assets)) return { available: false, reason: 'Run npm run build before ui:inventory.' }
  const files = await readdir(assets)
  const html = await readFile(join(ROOT, 'dist/index.html'), 'utf8')
  const entryFiles = new Set([...html.matchAll(/assets\/([^"']+\.js)/g)].map((match) => match[1]))
  const chunks = []
  for (const file of files.filter((name) => /\.(js|css)$/.test(name)).sort()) {
    const type = extname(file).slice(1)
    const bytes = await gzipBytes(join(assets, file))
    const gallery = /^Gallery-/.test(file)
    chunks.push({ key: `${type}:${file}`, name: file, type, gzipBytes: bytes, scope: gallery ? 'gallery' : 'production', entry: entryFiles.has(file) })
  }
  chunks.sort(byKey)
  const sum = (where) => chunks.filter(where).reduce((total, chunk) => total + chunk.gzipBytes, 0)
  return {
    available: true,
    chunks,
    production: { jsGzipBytes: sum((chunk) => chunk.scope === 'production' && chunk.type === 'js'), cssGzipBytes: sum((chunk) => chunk.scope === 'production' && chunk.type === 'css') },
    gallery: { jsGzipBytes: sum((chunk) => chunk.scope === 'gallery' && chunk.type === 'js'), cssGzipBytes: sum((chunk) => chunk.scope === 'gallery' && chunk.type === 'css') },
  }
}

function ownerForConsumers(selector, consumerCandidates, ruleKey) {
  const phaseFor = (source) => {
    if (/SequenceBuilder|sequence/.test(source)) return 11
    if (/Chat/.test(source)) return 10
    if (/Overview|AccountDetail|CampaignDetail|SentimentAnalysis|chart|Funnel|Kpi|Cohort|RateVolume|LeadsVelocity|ActivityChart/.test(source)) return 9
    if (/Pipeline|LeadsAndRepliesWorkspace|CampaignTable|leads-and-replies/.test(source)) return 8
    if (/Replies|Conversation|reply-analysis|ReplyReview|LostReason/.test(source)) return 7
    if (/LeadsExplorer|FollowUps|FollowUp|Review|LeadNotes/.test(source)) return 6
    if (/CsvImport|CompanyResolution|ImportHistory/.test(source)) return 5
    if (/SearchLibrary|Icp|Hypotheses|Playbook/.test(source)) return 4
    if (/Team|Health|NeonActivity/.test(source)) return 3
    if (/Layout|Auth|ResetPassword|QuickNavigation/.test(source)) return 2
    return 12
  }
  const accountCard = selector.includes('account-card')
  const source = accountCard ? 'src/pages/AccountDetail.tsx' : [...consumerCandidates].sort((a, b) => phaseFor(b) - phaseFor(a) || a.localeCompare(b))[0] ?? 'src/ui/ui.css'
  const phase = accountCard ? 9 : consumerCandidates.length ? Math.max(...consumerCandidates.map(phaseFor)) : 12
  return {
    id: `compatibility-rule-${createHash('sha256').update(ruleKey).digest('hex').slice(0, 12)}`,
    kind: 'compatibility-selector',
    selector,
    ruleKey,
    consumerCandidates,
    owner: source,
    destination: source,
    reason: consumerCandidates.length ? 'Retained until its application consumer family moves to the canonical contract. Candidate paths are class-token references; contextual selector matching still requires review.' : 'No statically discoverable JSX class-token reference; inspect before deleting because CSS may be reached through dynamic or generated markup.',
    verification: consumerCandidates.length ? 'Inventory candidate report and route visual acceptance.' : 'Zero-candidate inspection plus CSS parity before deletion.',
    removeByPhase: `Phase ${phase}`,
  }
}

function selectorLedger(selectors, previous = { entries: [] }) {
  const manual = new Map((previous.entries ?? []).map((entry) => [entry.ruleKey, entry]))
  return {
    version: 1,
    generatedFrom: 'ui-inventory.mjs',
    entries: selectors.map((entry) => {
      const next = ownerForConsumers(entry.selector, entry.consumerCandidates, entry.key)
      const old = manual.get(entry.key)
      return old ? { ...next, owner: old.owner, destination: old.destination, reason: old.reason, verification: old.verification, removeByPhase: old.removeByPhase } : next
    }),
  }
}

function findingDelta(label, current, baseline, failures) {
  const previous = new Set((baseline ?? []).map((entry) => entry.key))
  const introduced = current.filter((entry) => !previous.has(entry.key))
  if (introduced.length) failures.push(`${label}: ${introduced.length} new finding(s): ${introduced.slice(0, 6).map((entry) => entry.key).join(', ')}`)
  if (current.length > (baseline ?? []).length) failures.push(`${label}: count grew from ${(baseline ?? []).length} to ${current.length}`)
}

function checkSelectorLedger(selectors, ledger, failures) {
  const entries = new Map((ledger.entries ?? []).map((entry) => [entry.ruleKey, entry]))
  const missing = selectors.filter((selector) => !entries.has(selector.key))
  if (missing.length) failures.push(`selector ledger: ${missing.length} compatibility selector rule(s) have no explicit owner: ${missing.slice(0, 6).map((entry) => entry.selector).join(', ')}`)
  const stale = [...entries.keys()].filter((key) => !selectors.some((item) => item.key === key))
  if (stale.length) failures.push(`selector ledger: ${stale.length} stale selector owner(s): ${stale.slice(0, 6).join(', ')}`)
  for (const entry of entries.values()) for (const key of ['owner', 'destination', 'reason', 'verification', 'removeByPhase']) {
    if (!(key in entry)) failures.push(`selector ledger: ${entry.selector} is missing ${key}`)
  }
}

function checkAllowlist(allowlist, scan, failures) {
  const required = ['id', 'kind', 'path', 'symbol', 'owner', 'reason', 'verification', 'removeByPhase']
  const ids = new Set()
  const current = [
    ...scan.directImports,
    ...scan.allowlistedRawControls,
  ]
  for (const entry of allowlist.entries ?? []) {
    for (const key of required) if (!(key in entry)) failures.push(`allowlist: ${entry.id ?? '<unnamed>'} is missing ${key}`)
    if (ids.has(entry.id)) failures.push(`allowlist: duplicate id ${entry.id}`)
    ids.add(entry.id)
    const matched = current.some((finding) => finding.allowlistId === entry.id || (
      finding.kind === entry.kind && finding.path === entry.path && finding.symbol === entry.symbol &&
      (!entry.tag || entry.tag === finding.tag) && (!entry.nativeType || entry.nativeType === finding.nativeType) && (!entry.specifier || entry.specifier === finding.specifier)
    ))
    if (!matched) failures.push(`allowlist: stale entry ${entry.id}`)
  }
}

function bundleNameIdentity(name) {
  return name.replace(/-[A-Za-z0-9_-]{8}(?=\.(?:js|css)$)/, '')
}

// Vite content hashes change on every rebuild, so chunks are matched by
// scope, type, hash-free name and entry flag. A baseline row without an
// entry flag is a route chunk; the Phase 0 baseline marks its one entry.
function bundleChunkIdentity(chunk) {
  return `${chunk.scope}:${chunk.type}:${bundleNameIdentity(chunk.name)}:${chunk.entry === true ? 'entry' : 'route'}`
}

export function bundleDelta(current, baseline, failures) {
  if (!current.available || !baseline?.available) return
  const oldChunks = new Map()
  for (const chunk of baseline.chunks ?? []) {
    const identity = bundleChunkIdentity(chunk)
    if (oldChunks.has(identity)) failures.push(`bundle: baseline has duplicate chunk identity ${identity}`)
    oldChunks.set(identity, chunk)
  }
  for (const chunk of current.chunks.filter((item) => item.scope === 'production' && item.type === 'js')) {
    const old = oldChunks.get(bundleChunkIdentity(chunk))
    const isEntry = chunk.entry
    const maximum = isEntry ? Math.ceil(old?.gzipBytes * 1.05) : (old?.gzipBytes ?? 0) + Math.max(Math.ceil((old?.gzipBytes ?? 0) * 0.10), 10 * 1024)
    if (old && chunk.gzipBytes > maximum) failures.push(`bundle: ${chunk.name} gzip grew above its ${isEntry ? '5% entry' : 'larger-of-10%-or-10KB route'} budget (${old.gzipBytes} -> ${chunk.gzipBytes})`)
  }
  const cssBaseline = baseline.production?.cssGzipBytes
  const cssCurrent = current.production?.cssGzipBytes
  if (FINAL && typeof cssBaseline === 'number' && typeof cssCurrent === 'number' && cssCurrent > cssBaseline) {
    failures.push(`bundle: final production CSS gzip grew above the Phase 0 baseline (${cssBaseline} -> ${cssCurrent})`)
  }
}

async function main() {
  const allowlist = await readJson(ALLOWLIST, { version: 1, entries: [] })
  const existingBaseline = await readJson(BASELINE, null)
  const knownCompatibilityTokens = new Set([
    ...COMPATIBILITY_TOKENS,
    ...(existingBaseline?.compatibilitySelectors ?? []).flatMap((entry) => [...entry.selector.matchAll(/\.([A-Za-z_-][A-Za-z0-9_-]*)/g)].map((item) => item[1])),
  ])
  const scan = await scanSource(allowlist, knownCompatibilityTokens)
  const selectors = await compatibilitySelectors(scan.classConsumers)
  const report = {
    version: 1,
    source: { revision: '38d139b', root: 'frontend/src' },
    rawControls: scan.rawControls,
    allowlistedRawControls: scan.allowlistedRawControls,
    directImports: scan.directImports,
    forbiddenDirectImports: scan.forbiddenDirectImports,
    compatibilityTokens: scan.compatibilityTokens,
    compatibilitySelectors: selectors,
    modalRoots: scan.modalRoots,
    sourceCounts: await sourceCounts(),
    bundle: await bundleReport(),
  }

  if (UPDATE) {
    const nextBaseline = existingBaseline
      ? { ...report, source: existingBaseline.source, sourceCounts: existingBaseline.sourceCounts, bundle: existingBaseline.bundle }
      : report
    await writeFile(BASELINE, stable(nextBaseline))
    const previousLedger = await readJson(SELECTOR_OWNERS, { entries: [] })
    await writeFile(SELECTOR_OWNERS, stable(selectorLedger(selectors, previousLedger)))
    if (!JSON_ONLY) console.log(`Updated ${posix(BASELINE)} and reconciled ${posix(SELECTOR_OWNERS)} while preserving matched owner decisions.`)
    return
  }

  const baseline = existingBaseline
  const ledger = await readJson(SELECTOR_OWNERS, { entries: [] })
  const failures = []
  if (!baseline) failures.push('Missing ui-inventory-baseline.json. Run npm run ui:inventory:update after review.')
  else {
    findingDelta('raw controls', report.rawControls, baseline.rawControls, failures)
    findingDelta('compatibility tokens', report.compatibilityTokens, baseline.compatibilityTokens, failures)
    findingDelta('modal roots', report.modalRoots, baseline.modalRoots, failures)
    bundleDelta(report.bundle, baseline.bundle, failures)
  }
  if (report.forbiddenDirectImports.length) failures.push(`forbidden direct imports: ${report.forbiddenDirectImports.map((entry) => entry.key).join(', ')}`)
  checkAllowlist(allowlist, scan, failures)
  checkSelectorLedger(selectors, ledger, failures)
  if (JSON_ONLY) console.log(stable({ report, failures }))
  else {
    console.log(`UI inventory: ${report.rawControls.length} raw controls, ${report.allowlistedRawControls.length} allowlisted raw controls, ${report.compatibilityTokens.length} compatibility-token uses, ${selectors.length} compatibility selectors, ${report.modalRoots.length} modal roots.`)
    console.log(`Source: ${report.sourceCounts.tsx.files} TSX / ${report.sourceCounts.tsx.lines} lines; ${report.sourceCounts.css.files} CSS / ${report.sourceCounts.css.lines} lines.`)
    if (report.bundle.available) {
      const cssDelta = baseline?.bundle?.production?.cssGzipBytes == null ? 'n/a' : report.bundle.production.cssGzipBytes - baseline.bundle.production.cssGzipBytes
      console.log(`Bundles: production JS ${report.bundle.production.jsGzipBytes} gzip bytes, CSS ${report.bundle.production.cssGzipBytes} (delta ${cssDelta}); Gallery JS ${report.bundle.gallery.jsGzipBytes} (excluded from production totals).`)
    }
    for (const failure of failures) console.error(`FAIL ${failure}`)
  }
  process.exitCode = failures.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
}
