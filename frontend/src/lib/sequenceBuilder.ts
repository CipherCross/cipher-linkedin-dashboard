export type SequenceStepKind = 'connection' | 'message'

export interface SequenceVariation {
  id: string
  label: string
  text: string
}

export interface SequenceStep {
  id: string
  kind: SequenceStepKind
  variations: SequenceVariation[]
}

export interface SequenceBranch {
  id: string
  name: string
  selections: Record<string, string>
}

export interface SequenceSampleData {
  firstName: string
  companyName: string
  jobTitle: string
  senderName: string
}

export interface SequenceDocument {
  version: 1
  steps: SequenceStep[]
  branches: SequenceBranch[]
  sampleData: SequenceSampleData
}

export interface SequenceRecord {
  id: string
  name: string
  document: SequenceDocument
  revision: number
  archived: boolean
  created_by: string
  created_by_name: string
  updated_by: string
  updated_by_name: string
  created_at: string
  updated_at: string
}

export interface SequenceVersion {
  id: number
  sequence_id: string
  revision: number
  name: string
  document: SequenceDocument
  saved_by: string
  saved_by_name: string
  saved_at: string
}

export interface SequenceCommentAnchor {
  start: number
  end: number
  quote: string
}

export interface SequenceCommentMessage {
  id: number
  author_id: string
  author_name: string
  body: string
  created_at: string
}

export interface SequenceCommentThread {
  id: string
  sequence_id: string
  step_id: string | null
  variation_id: string | null
  anchor: SequenceCommentAnchor | null
  created_by: string
  created_by_name: string
  resolved_at: string | null
  resolved_by: string | null
  resolved_by_name: string | null
  created_at: string
  updated_at: string
  messages: SequenceCommentMessage[]
}

export interface SequenceDetail {
  sequence: SequenceRecord
  versions: SequenceVersion[]
  comments: SequenceCommentThread[]
}

export const PERSONALIZATION_TOKENS = [
  '{firstName}',
  '{companyName}',
  '{jobTitle}',
  '{senderName}',
] as const

export const CONNECTION_REQUEST_WARNING_LIMIT = 200

let fallbackId = 0
export function sequenceId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `${prefix}_${uuid.split('-').join('')}`
  fallbackId += 1
  return `${prefix}_${Date.now().toString(36)}_${fallbackId.toString(36)}`
}

export function createVariation(label = 'Variation 1', text = ''): SequenceVariation {
  return { id: sequenceId('variation'), label, text }
}

export function createSequenceDocument(): SequenceDocument {
  const connection = {
    id: sequenceId('step'),
    kind: 'connection' as const,
    variations: [createVariation()],
  }
  const firstMessage = {
    id: sequenceId('step'),
    kind: 'message' as const,
    variations: [createVariation()],
  }
  return {
    version: 1,
    steps: [connection, firstMessage],
    branches: [],
    sampleData: {
      firstName: 'Alex',
      companyName: 'Northstar Labs',
      jobTitle: 'VP of Product',
      senderName: 'You',
    },
  }
}

export function stepTitle(document: SequenceDocument, stepId: string): string {
  const index = document.steps.findIndex((step) => step.id === stepId)
  if (index < 0) return 'Unknown step'
  return index === 0 ? 'Connection request' : `Message ${index}`
}

function variationForStep(step: SequenceStep, selected?: string): string {
  return step.variations.some((variation) => variation.id === selected)
    ? (selected as string)
    : step.variations[0]?.id ?? ''
}

export function repairBranches(document: SequenceDocument): SequenceDocument {
  const branches = document.branches.map((branch) => {
    const selections: Record<string, string> = {}
    for (const step of document.steps) {
      const selected = variationForStep(step, branch.selections[step.id])
      if (selected) selections[step.id] = selected
    }
    return { ...branch, selections }
  })
  return { ...document, branches }
}

export function addMessageStep(document: SequenceDocument): SequenceDocument {
  const step: SequenceStep = {
    id: sequenceId('step'),
    kind: 'message',
    variations: [createVariation()],
  }
  return repairBranches({ ...document, steps: [...document.steps, step] })
}

export function addVariation(document: SequenceDocument, stepId: string): SequenceDocument {
  return repairBranches({
    ...document,
    steps: document.steps.map((step) =>
      step.id === stepId
        ? {
            ...step,
            variations: [
              ...step.variations,
              createVariation(`Variation ${step.variations.length + 1}`),
            ],
          }
        : step,
    ),
  })
}

export function updateVariation(
  document: SequenceDocument,
  stepId: string,
  variationId: string,
  patch: Partial<Pick<SequenceVariation, 'label' | 'text'>>,
): SequenceDocument {
  return {
    ...document,
    steps: document.steps.map((step) =>
      step.id === stepId
        ? {
            ...step,
            variations: step.variations.map((variation) =>
              variation.id === variationId ? { ...variation, ...patch } : variation,
            ),
          }
        : step,
    ),
  }
}

export function removeVariation(
  document: SequenceDocument,
  stepId: string,
  variationId: string,
): SequenceDocument {
  return repairBranches({
    ...document,
    steps: document.steps.map((step) => {
      if (step.id !== stepId) return step
      const next = step.variations.filter((variation) => variation.id !== variationId)
      return { ...step, variations: next.length ? next : [createVariation()] }
    }),
  })
}

export function removeStep(document: SequenceDocument, stepId: string): SequenceDocument {
  const target = document.steps.find((step) => step.id === stepId)
  if (!target || target.kind === 'connection') return document
  return repairBranches({
    ...document,
    steps: document.steps.filter((step) => step.id !== stepId),
  })
}

export function moveMessageStep(
  document: SequenceDocument,
  stepId: string,
  direction: -1 | 1,
): SequenceDocument {
  const index = document.steps.findIndex((step) => step.id === stepId)
  const target = index + direction
  if (index <= 0 || target <= 0 || target >= document.steps.length) return document
  const steps = [...document.steps]
  ;[steps[index], steps[target]] = [steps[target], steps[index]]
  return { ...document, steps }
}

export function moveVariation(
  document: SequenceDocument,
  variationId: string,
  fromStepId: string,
  toStepId: string,
  toIndex?: number,
): SequenceDocument {
  const source = document.steps.find((step) => step.id === fromStepId)
  const target = document.steps.find((step) => step.id === toStepId)
  const variation = source?.variations.find((candidate) => candidate.id === variationId)
  if (!source || !target || !variation) return document

  const steps = document.steps.map((step) => {
    if (fromStepId === toStepId && step.id === fromStepId) {
      const without = step.variations.filter((item) => item.id !== variationId)
      const index = Math.max(0, Math.min(toIndex ?? without.length, without.length))
      without.splice(index, 0, variation)
      return { ...step, variations: without }
    }
    if (step.id === fromStepId) {
      const remaining = step.variations.filter((item) => item.id !== variationId)
      return { ...step, variations: remaining.length ? remaining : [createVariation()] }
    }
    if (step.id === toStepId) {
      const variations = [...step.variations]
      const index = Math.max(0, Math.min(toIndex ?? variations.length, variations.length))
      variations.splice(index, 0, variation)
      return { ...step, variations }
    }
    return step
  })
  return repairBranches({ ...document, steps })
}

/** Swap which step is the connection request while preserving the unique-first invariant. */
export function makeConnectionStep(document: SequenceDocument, stepId: string): SequenceDocument {
  const index = document.steps.findIndex((step) => step.id === stepId)
  if (index <= 0) return document
  const previousConnection = document.steps[0]
  const selected = document.steps[index]
  const messages = document.steps.slice(1).filter((step) => step.id !== stepId)
  const steps: SequenceStep[] = [
    { ...selected, kind: 'connection' },
    ...messages.slice(0, index - 1),
    { ...previousConnection, kind: 'message' },
    ...messages.slice(index - 1),
  ]
  return repairBranches({ ...document, steps })
}

export function addBranch(document: SequenceDocument): SequenceDocument {
  const branchNumber = document.branches.length + 1
  const selections: Record<string, string> = {}
  for (const step of document.steps) {
    if (step.variations[0]) selections[step.id] = step.variations[0].id
  }
  return {
    ...document,
    branches: [
      ...document.branches,
      {
        id: sequenceId('branch'),
        name: String.fromCharCode(64 + Math.min(branchNumber, 26)),
        selections,
      },
    ],
  }
}

export function updateBranch(
  document: SequenceDocument,
  branchId: string,
  patch: Partial<Pick<SequenceBranch, 'name' | 'selections'>>,
): SequenceDocument {
  return repairBranches({
    ...document,
    branches: document.branches.map((branch) =>
      branch.id === branchId ? { ...branch, ...patch } : branch,
    ),
  })
}

export function removeBranch(document: SequenceDocument, branchId: string): SequenceDocument {
  return { ...document, branches: document.branches.filter((branch) => branch.id !== branchId) }
}

export function graphemeCount(value: string): number {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { granularity: 'grapheme' },
    ) => { segment(input: string): Iterable<unknown> }
  }).Segmenter
  if (Segmenter) {
    return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length
  }
  return Array.from(value).length
}

export function interpolateTokens(text: string, sampleData: SequenceSampleData): string {
  return text.replace(/\{(firstName|companyName|jobTitle|senderName)\}/g, (_, key: keyof SequenceSampleData) => sampleData[key])
}

export interface ResolvedAnchor extends SequenceCommentAnchor {
  stale: boolean
}

export function resolveCommentAnchor(
  text: string,
  anchor: SequenceCommentAnchor | null,
): ResolvedAnchor | null {
  if (!anchor) return null
  if (text.slice(anchor.start, anchor.end) === anchor.quote) return { ...anchor, stale: false }
  const first = text.indexOf(anchor.quote)
  if (first < 0 || text.indexOf(anchor.quote, first + 1) >= 0) return { ...anchor, stale: true }
  return { start: first, end: first + anchor.quote.length, quote: anchor.quote, stale: false }
}

export function selectionPreview(
  text: string,
  anchors: readonly SequenceCommentAnchor[],
): { text: string; highlighted: boolean }[] {
  const resolved = anchors
    .map((anchor) => resolveCommentAnchor(text, anchor))
    .filter((anchor): anchor is ResolvedAnchor => Boolean(anchor && !anchor.stale))
    .sort((a, b) => a.start - b.start)
  if (!resolved.length) return [{ text, highlighted: false }]
  const boundaries = new Set<number>([0, text.length])
  for (const anchor of resolved) {
    boundaries.add(anchor.start)
    boundaries.add(anchor.end)
  }
  const points = [...boundaries].sort((a, b) => a - b)
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1]
    return {
      text: text.slice(start, end),
      highlighted: resolved.some((anchor) => start >= anchor.start && end <= anchor.end),
    }
  })
}

export function sequenceCounts(record: SequenceRecord) {
  return {
    steps: Math.max(0, record.document.steps.length - 1),
    variations: record.document.steps.reduce((total, step) => total + step.variations.length, 0),
    branches: record.document.branches.length,
  }
}

export function sequencePreviewText(record: SequenceRecord): string {
  for (const step of record.document.steps) {
    const text = step.variations.find((variation) => variation.text.trim())?.text.trim()
    if (text) return text
  }
  return 'Empty sequence — open it to start writing.'
}
