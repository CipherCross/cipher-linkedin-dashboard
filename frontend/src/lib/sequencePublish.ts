import type { SequenceDocument, SequenceStep } from './sequenceBuilder'

export const SEQUENCE_PUBLISH_COMPILER_VERSION = 'lh2-sequence-v1'

export type PublishInsertion = 'before_invite' | 'after_invite'

export interface SequencePublishOptions {
  branchIds: string[]
  visit: boolean
  follow: boolean
  preInviteDelayHours?: number
  inviteToFirstMessageDelayHours?: number
  interMessageDelayHours: number[]
}

export interface VerifiedAccountSnapshot {
  instanceId: string
  machineKey: string
  accountId: string
  accountName: string
  senderName: string
  workspaceId: string
  lhVersion: string
  compatibilityProfile: string
}

export interface TemplateGroup {
  type: 'group'
  children: Array<{ type: 'text'; value: string } | { type: 'var'; name: string }>
}

export interface CanonicalAction {
  type: string
  settings: Record<string, unknown>
  coolDown: number
  maxActionResultsPerIteration: number
}

export interface CanonicalCampaign {
  branchId: string
  branchOrdinal: number
  branchLetter: string
  campaignName: string
  account: VerifiedAccountSnapshot
  actions: CanonicalAction[]
  compilerVersion: string
  actionFingerprint: string
}

const VARIABLE_NAMES: Record<string, string> = {
  firstName: 'firstName',
  companyName: 'company',
  jobTitle: 'position',
}

export class SequencePublishValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('; '))
    this.name = 'SequencePublishValidationError'
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Small synchronous SHA-256 used in both the browser preview and server validation. */
export function sha256Hex(input: string): string {
  const rightRotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount))
  const maxWord = 2 ** 32
  const words: number[] = []
  const ascii = unescape(encodeURIComponent(input))
  const bitLength = ascii.length * 8
  const hash: number[] = []
  const primes: number[] = []
  for (let candidate = 2; primes.length < 64; candidate += 1) {
    if (primes.every((prime) => candidate % prime)) {
      primes.push(candidate)
      if (hash.length < 8) hash.push((candidate ** 0.5 * maxWord) | 0)
    }
  }
  const constants = primes.map((prime) => (prime ** (1 / 3) * maxWord) | 0)
  let message = `${ascii}\x80`
  while (message.length % 64 !== 56) message += '\x00'
  for (let index = 0; index < message.length; index += 1) {
    words[index >> 2] |= message.charCodeAt(index) << ((3 - index) % 4) * 8
  }
  words.push((bitLength / maxWord) | 0, bitLength | 0)
  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = words.slice(offset, offset + 16)
    const previous = hash.slice()
    for (let index = 0; index < 64; index += 1) {
      const w15 = schedule[index - 15]
      const w2 = schedule[index - 2]
      const a = previous[0]
      const e = previous[4]
      const word = index < 16
        ? schedule[index]
        : (schedule[index - 16] + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) + schedule[index - 7] + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) | 0
      schedule[index] = word
      const temp1 = (previous[7] + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) + ((e & previous[5]) ^ (~e & previous[6])) + constants[index] + word) | 0
      const temp2 = ((rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) + ((a & previous[1]) ^ (a & previous[2]) ^ (previous[1] & previous[2]))) | 0
      previous.pop()
      previous.unshift((temp1 + temp2) | 0)
      previous[4] = (previous[4] + temp1) | 0
    }
    for (let index = 0; index < 8; index += 1) hash[index] = (hash[index] + previous[index]) | 0
  }
  return hash.map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('')
}

export function compileTemplate(text: string, senderName: string): TemplateGroup {
  const children: TemplateGroup['children'] = []
  const tokenPattern = /\{([^{}]+)\}/g
  let cursor = 0
  for (let match = tokenPattern.exec(text); match; match = tokenPattern.exec(text)) {
    if (match.index > cursor) children.push({ type: 'text', value: text.slice(cursor, match.index) })
    const token = match[1]
    if (token === 'senderName') {
      if (senderName) children.push({ type: 'text', value: senderName })
    } else if (VARIABLE_NAMES[token]) {
      children.push({ type: 'var', name: VARIABLE_NAMES[token] })
    } else {
      throw new SequencePublishValidationError([`Unknown personalization token {${token}}`])
    }
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) children.push({ type: 'text', value: text.slice(cursor) })
  return { type: 'group', children }
}

const variants = (group: TemplateGroup) => ({
  type: 'variants',
  variants: [{ type: 'variant', child: group }],
})

const action = (
  type: string,
  settings: Record<string, unknown>,
  coolDown: number,
  maxActionResultsPerIteration: number,
): CanonicalAction => ({ type, settings, coolDown, maxActionResultsPerIteration })

const wait = (hours: number) => action('Waiter', { delay: hours }, 0, -1)

function chosenText(step: SequenceStep, branchSelections: Record<string, string>): string | null {
  const chosen = branchSelections[step.id] ?? step.variations[0]?.id
  return step.variations.find((variation) => variation.id === chosen)?.text ?? null
}

function assertHours(value: number | undefined, label: string, issues: string[]) {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 1 || value > 720) issues.push(`${label} must be an integer from 1 to 720 hours`)
}

export function compileSequenceCampaigns(
  sequenceName: string,
  document: SequenceDocument,
  options: SequencePublishOptions,
  account: VerifiedAccountSnapshot,
): CanonicalCampaign[] {
  const issues: string[] = []
  const name = sequenceName.trim()
  if (!name) issues.push('Sequence name is required')
  if (!document.steps.length || document.steps[0]?.kind !== 'connection') issues.push('The first step must be the connection request')
  if (!options.branchIds.length) issues.push('Select at least one branch')
  assertHours(options.preInviteDelayHours, 'Pre-invite delay', issues)
  assertHours(options.inviteToFirstMessageDelayHours, 'Invite-to-message delay', issues)
  options.interMessageDelayHours.forEach((hours, index) => assertHours(hours, `Message ${index + 1} delay`, issues))
  const branchSet = new Set(options.branchIds)
  if (branchSet.size !== options.branchIds.length) issues.push('Selected branch ids must be unique')
  const selected = document.branches
    .map((branch, branchOrdinal) => ({ branch, branchOrdinal }))
    .filter(({ branch }) => branchSet.has(branch.id))
  if (selected.length !== options.branchIds.length) issues.push('A selected branch does not exist in this sequence revision')
  if (issues.length) throw new SequencePublishValidationError(issues)

  return selected.map(({ branch, branchOrdinal }) => {
    const branchLetter = String.fromCharCode(65 + branchOrdinal)
    const campaignName = `${name} ${branchLetter}`
    if (campaignName.length > 160) throw new SequencePublishValidationError([`Campaign name ${branchLetter} exceeds 160 characters`])
    const actions: CanonicalAction[] = []
    if (options.visit) actions.push(action('VisitAndExtract', {}, 60_000, 10))
    if (options.follow) actions.push(action('Follow', { mode: 'follow', skipIfUnfollowable: true }, 60_000, 10))
    if (options.preInviteDelayHours !== undefined) actions.push(wait(options.preInviteDelayHours))

    const connectionText = chosenText(document.steps[0], branch.selections)
    if (connectionText === null) throw new SequencePublishValidationError([`Branch ${branchLetter} has no connection-request variation`])
    actions.push(action('InvitePerson', {
      messageTemplate: variants(compileTemplate(connectionText, account.senderName)),
      saveAsLeadSN: false,
      emailCustomFieldName: null,
    }, 60_000, 10))
    actions.push(action('FilterContactsOutOfMyNetwork', {
      maxScrollDepth: 200,
      checkUntil: 'PreviouslyFound',
      cancelInvitesOlderThan: 2_592_000_000,
      launchAutoAcceptInvites: false,
      launchAutoCancelInvites: false,
    }, 3_600_000, -1))
    if (options.inviteToFirstMessageDelayHours !== undefined) actions.push(wait(options.inviteToFirstMessageDelayHours))

    const messages = document.steps.slice(1)
    messages.forEach((step, index) => {
      const text = chosenText(step, branch.selections)
      if (text === null) throw new SequencePublishValidationError([`Branch ${branchLetter} has no variation for message ${index + 1}`])
      if (!text.trim()) throw new SequencePublishValidationError([`Branch ${branchLetter} message ${index + 1} cannot be empty`])
      actions.push(action('MessageToPerson', {
        subjectTemplate: { type: 'group', children: [] },
        messageTemplate: variants(compileTemplate(text, account.senderName)),
        rejectIfReplied: false,
        rejectIfRepliedWithinCampaign: true,
        rejectIfMessagedAfterPreviousCampaignMessage: true,
        rejectIfMessaged: false,
      }, 60_000, 10))
      const nextDelay = index < messages.length - 1 ? options.interMessageDelayHours[index] : undefined
      if (index < messages.length - 1 && nextDelay === undefined) {
        throw new SequencePublishValidationError([`Delay after message ${index + 1} is required`])
      }
      actions.push(action('CheckForReplies', {
        moveToSuccessfulAfterMs: nextDelay === undefined ? null : nextDelay * 3_600_000,
        treatMessageAcceptedAsReply: false,
        keepInQueueIfRequestIsNotAccepted: true,
      }, 3_600_000, -1))
    })
    const fingerprintInput = { compilerVersion: SEQUENCE_PUBLISH_COMPILER_VERSION, accountId: account.accountId, actions }
    return {
      branchId: branch.id,
      branchOrdinal,
      branchLetter,
      campaignName,
      account,
      actions,
      compilerVersion: SEQUENCE_PUBLISH_COMPILER_VERSION,
      actionFingerprint: sha256Hex(canonicalJson(fingerprintInput)),
    }
  })
}

export function sequencePublishPayloadDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
