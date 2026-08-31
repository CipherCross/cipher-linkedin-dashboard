/**
 * Fixture-equivalence: the compiler against Linked Helper's own export.
 *
 * The specification's definition of done asks for tests covering "every
 * supported actionSettings, cooldown and per-iteration limit" against the
 * fixture. Hand-written expectations cannot do that: they assert what we
 * believe LH2 wants, which is exactly the belief that produced three malformed
 * campaigns. So this reads LH2's real export of the healthy reference campaign
 * (campaign 6), reconstructs the source text from its own template ASTs, and
 * demands DEEP EQUALITY of the whole compiled chain against it.
 *
 * The oracle's digest is pinned, and the comparison is mutation-checked, so
 * neither a silent edit of the fixture nor a comparison that always agrees can
 * pass unnoticed.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSequenceDocument, createVariation } from '../src/lib/sequenceBuilder'
import {
  compileSequenceCampaigns,
  type CanonicalAction,
  type VerifiedAccountSnapshot,
} from '../src/lib/sequencePublish'

const FIXTURE_PATH = join(__dirname, '..', '..', 'docs', 'platform-ops',
  'linked-helper-campaign-settings-fixture.csv')

// Recorded when the fixture was captured from LH2. An oracle that can be
// edited to agree with the compiler is not an oracle.
const FIXTURE_SHA256 = '133c172ff0c918c87a0e8262e7c08e3f6a601f890f42c44c576dceb79f04ea21'

/** One row of LH2's quoted, wide-format campaign export. */
function parseFixtureRow(csv: string): Record<string, string> {
  const cells: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') { cell += '"'; index += 1 } else { quoted = false }
      } else cell += character
      continue
    }
    if (character === '"') { quoted = true; continue }
    if (character === ',') { row.push(cell); cell = ''; continue }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && csv[index + 1] === '\n') index += 1
      row.push(cell); cell = ''
      if (row.some((value) => value !== '')) cells.push(row)
      row = []
      continue
    }
    cell += character
  }
  row.push(cell)
  if (row.some((value) => value !== '')) cells.push(row)
  const [header, values] = cells
  expect(cells).toHaveLength(2)
  expect(header).toHaveLength(75)
  return Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']))
}

function fixtureActions(row: Record<string, string>): CanonicalAction[] {
  const actions: CanonicalAction[] = []
  for (let index = 1; ; index += 1) {
    const type = row[`action_type_${index}`]
    if (!type) break
    actions.push({
      type,
      settings: JSON.parse(row[`action_settings_${index}`] || '{}'),
      coolDown: Number(row[`action_cool_down_${index}`]),
      maxActionResultsPerIteration: Number(row[`action_max_action_results_per_iteration_${index}`]),
    })
  }
  return actions
}

/** LH2 variable name -> the Sequence Builder token that compiles to it. */
const TOKEN_FOR_VARIABLE: Record<string, string> = {
  firstName: '{firstName}',
  company: '{companyName}',
  position: '{jobTitle}',
}

/**
 * Turn one of the fixture's template ASTs back into editor source text, so the
 * compiler is driven by LH2's own content rather than by text we invented.
 */
function sourceTextOf(template: unknown): string {
  const node = template as { type?: string, variants?: unknown[], child?: unknown, children?: unknown[], value?: string, name?: string }
  if (node?.type === 'variants') {
    expect(node.variants).toHaveLength(1)
    return sourceTextOf((node.variants as { child: unknown }[])[0].child)
  }
  if (node?.type === 'group') return (node.children ?? []).map(sourceTextOf).join('')
  if (node?.type === 'text') return node.value ?? ''
  if (node?.type === 'var') {
    const token = TOKEN_FOR_VARIABLE[node.name ?? '']
    expect(token, `unmapped LH2 variable ${node.name}`).toBeTruthy()
    return token
  }
  throw new Error(`unexpected template node ${JSON.stringify(template)}`)
}

const account: VerifiedAccountSnapshot = {
  instanceId: 'notebook-1',
  machineKey: 'notebook-1',
  accountId: '524650',
  accountName: 'Fixture',
  senderName: 'Fixture Sender',
  workspaceId: '601896',
  lhVersion: '2.130.17',
  compatibilityProfile: 'fixture-v1',
}

describe('Compiler equivalence with the Linked Helper export fixture', () => {
  const csv = readFileSync(FIXTURE_PATH, 'utf8')

  it('reads the exact fixture it was recorded against', () => {
    expect(createHash('sha256').update(readFileSync(FIXTURE_PATH)).digest('hex'))
      .toBe(FIXTURE_SHA256)
  })

  const row = parseFixtureRow(csv)
  const expected = fixtureActions(row)

  it('covers the whole chain the fixture documents', () => {
    expect(expected.map((item) => item.type)).toEqual([
      'VisitAndExtract', 'Follow', 'Waiter', 'InvitePerson',
      'FilterContactsOutOfMyNetwork', 'Waiter', 'MessageToPerson',
      'CheckForReplies', 'MessageToPerson', 'CheckForReplies',
    ])
    expect(row.campaign_type).toBe('People')
  })

  /** The document and options that should reproduce the fixture exactly. */
  function compiled() {
    const invite = expected[3].settings.messageTemplate
    const messageTemplates = expected
      .filter((item) => item.type === 'MessageToPerson')
      .map((item) => item.settings.messageTemplate)
    const document = createSequenceDocument()
    // The fixture has two messages; a fresh document ships one.
    document.steps.push({
      id: 'step_message_2',
      kind: 'message',
      variations: [createVariation()],
    })
    document.steps[0].variations[0].text = sourceTextOf(invite)
    messageTemplates.forEach((template, index) => {
      document.steps[index + 1].variations[0].text = sourceTextOf(template)
    })
    document.branches = [{
      id: 'branch_a',
      name: 'A',
      selections: Object.fromEntries(document.steps.map((step) => [step.id, step.variations[0].id])),
    }]
    const firstCheck = expected[7].settings.moveToSuccessfulAfterMs as number
    return compileSequenceCampaigns('Codex Campaign Export Fixture', document, {
      branchIds: ['branch_a'],
      visit: true,
      follow: true,
      preInviteDelayHours: (expected[2].settings.delay as number),
      inviteToFirstMessageDelayHours: (expected[5].settings.delay as number),
      interMessageDelayHours: [firstCheck / 3_600_000],
    }, account)[0]
  }

  it('produces every action, setting, cooldown and per-iteration limit the fixture has', () => {
    expect(compiled().actions).toEqual(expected)
  })

  it('names the campaign the way the fixture is named', () => {
    // The fixture is campaign 6, exported before branch lettering existed, so
    // only the sequence-name half can match; the letter is this feature's.
    expect(compiled().campaignName).toBe(`${row.campaign_name} A`)
  })

  it('disagrees when the fixture is perturbed', () => {
    // Without this, a comparison that always passes would look identical to a
    // compiler that is actually correct.
    const perturbations: Array<(actions: CanonicalAction[]) => void> = [
      (actions) => { actions[0].coolDown = 1 },
      (actions) => { actions[4].maxActionResultsPerIteration = 10 },
      (actions) => { actions[9].settings.moveToSuccessfulAfterMs = 1 },
      (actions) => { delete (actions[3].settings as Record<string, unknown>).saveAsLeadSN },
      (actions) => { actions[6].settings.rejectIfReplied = true },
      (actions) => { actions.pop() },
      (actions) => { actions[2].settings.delay = 25 },
    ]
    for (const perturb of perturbations) {
      const mutated = JSON.parse(JSON.stringify(expected)) as CanonicalAction[]
      perturb(mutated)
      expect(compiled().actions).not.toEqual(mutated)
    }
  })
})
