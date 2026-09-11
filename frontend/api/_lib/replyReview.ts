/** Canonical server contract for manual reply review.
 *
 * This module is deliberately free of database and browser imports.  It is the
 * vocabulary shared by the dispatch layer, Neon operations and the UI.  A
 * missing review is not an AI review: the only values accepted as current
 * labels are the values written by an authenticated member through this path.
 */

import { createHash } from 'node:crypto'

export const REPLY_SENTIMENTS = [
  'positive',
  'neutral',
  'negative',
  'objection',
  'referral',
  'auto',
] as const
export type ReplySentiment = (typeof REPLY_SENTIMENTS)[number]

export const REPLY_REASON_IDS = [
  'no_need',
  'timing',
  'budget',
  'existing_solution',
  'offer_fit',
  'wrong_person',
  'trust_information',
  'do_not_contact',
  'other',
] as const
export type ReplyReasonId = (typeof REPLY_REASON_IDS)[number]

export const REPLY_INTENT_STATES = [
  'unreviewed',
  'none',
  'level',
  'not_applicable',
] as const
export type ReplyIntentState = (typeof REPLY_INTENT_STATES)[number]

export const REPLY_INTENT_LEVELS = ['p1', 'p2', 'p3'] as const
export type ReplyIntentLevel = (typeof REPLY_INTENT_LEVELS)[number]

export const REPLY_ACTIONS = [
  'needs_reply',
  'follow_up',
  'awaiting_reply',
  'resolved',
  'closed_soft',
  'closed_hard',
] as const
export type ReplyAction = (typeof REPLY_ACTIONS)[number]

export const REPLY_REASONS_VERSION = 'reply-reasons-v1'
export const REPLY_REVIEW_TAXONOMY_VERSION = 'reply-review-v1'
export const REPLY_REVIEW_MAX_COMMENT = 1_000
export const REPLY_INBOX_DEFAULT_LIMIT = 50
export const REPLY_INBOX_MAX_LIMIT = 100
export const REPLY_THREAD_DEFAULT_LIMIT = 50
export const REPLY_THREAD_MAX_LIMIT = 100
export const REPLY_HISTORY_DEFAULT_LIMIT = 50
export const REPLY_HISTORY_MAX_LIMIT = 100

export interface ReplyReviewDto {
  readonly message_id: number
  readonly sentiment: ReplySentiment | null
  readonly intent_state: ReplyIntentState
  readonly intent_level: ReplyIntentLevel | null
  readonly reason_ids: readonly ReplyReasonId[]
  readonly comment: string | null
  readonly taxonomy_version: string
  readonly reviewed_by: string | null
  readonly provenance: 'human' | 'legacy_manual' | 'system' | 'machine'
  readonly reviewed_at: string | null
  readonly revision: number
  readonly complete: boolean
}

export interface ReplyWorkflowDto {
  readonly action: ReplyAction | null
  readonly owner_id: number | null
  readonly next_follow_up_date: string | null
  readonly do_not_contact: boolean
  readonly acknowledged_inbound_revision: number
  readonly inbound_revision: number
  readonly revision: number
  readonly supporting_message_id: number | null
  readonly updated_at: string
  readonly updated_by: string | null
}

export interface ReplyMutationResult {
  readonly review: ReplyReviewDto | null
  readonly workflow: ReplyWorkflowDto | null
  readonly inbound_revision: number
  readonly needs_action_confirmation: boolean
  readonly mutation_id: string
}

export interface ReplyReviewInput {
  readonly sentiment: ReplySentiment | null
  readonly intent_state: ReplyIntentState
  readonly intent_level: ReplyIntentLevel | null
  readonly reason_ids: readonly ReplyReasonId[]
  readonly comment: string | null
}

export interface ReplyWorkflowInput {
  readonly expected_revision: number
  readonly observed_inbound_revision: number
  readonly action: ReplyAction | null
  readonly owner_id: number | null
  readonly next_follow_up_date: string | null
  readonly do_not_contact: boolean
  readonly supporting_message_id?: number | null
  readonly change_reason: string | null
}

export interface SaveReplyReviewRequest {
  readonly action: 'save_reply_review'
  readonly mutation_id: string
  readonly instance_id: string
  readonly profile_url: string
  readonly message_id: number
  readonly expected_review_revision: number
  readonly review: ReplyReviewInput
  readonly workflow?: ReplyWorkflowInput
}

export interface SetReplyWorkflowRequest {
  readonly action: 'set_reply_workflow'
  readonly mutation_id: string
  readonly instance_id: string
  readonly profile_url: string
  readonly workflow: ReplyWorkflowInput
}

export interface ActivateManualReplyReviewRequest {
  readonly action: 'activate_manual_reply_review'
  readonly mutation_id: string
  /** One bounded database batch per HTTP call; the server defaults to 500. */
  readonly batch_size?: number
}

export type ReplyWriteRequest =
  | SaveReplyReviewRequest
  | SetReplyWorkflowRequest
  | ActivateManualReplyReviewRequest

export type ReplyInboxScope = 'new' | 'historical' | 'all'
/** List views are mutually exclusive server predicates, not UI labels. */
export type ReplyInboxView = 'all' | 'unreviewed' | 'needs_reply' | 'deferred' | 'completed'

export interface ReplyUtcBounds {
  readonly from: string
  readonly to: string
}

export interface ReplyMetricScope {
  readonly kind: 'sentiment' | 'reason' | 'workflow' | 'coverage'
  readonly value: string
  /** The metric's denominator unit, retained when drilling into Replies. */
  readonly base?: 'dialogues' | 'messages' | 'manual_dialogues' | 'manual_messages'
  /** Exact half-open UTC interval used by the metric, if it differs from defaults. */
  readonly bounds?: ReplyUtcBounds
}

export interface ReplyFilter {
  readonly instance_id?: string | null
  readonly campaign_id?: string | null
  readonly owner_id?: number | null
  readonly sentiment?: ReplySentiment | null
  readonly reason_id?: ReplyReasonId | null
  readonly action?: ReplyAction | null
  readonly query?: string | null
  readonly from?: string | null
  readonly to?: string | null
  readonly metric_scope?: ReplyMetricScope | null
  readonly metric_base_from?: string | null
  readonly metric_base_to?: string | null
}

export interface ReplyInboxRequest extends ReplyFilter {
  readonly view: ReplyInboxView
  readonly scope: ReplyInboxScope
  readonly unacknowledged?: boolean
  readonly unowned?: boolean
  readonly overdue?: boolean
  readonly my?: boolean
  readonly current_actor_id?: string | null
  readonly cursor?: string | null
  readonly limit?: number
}

export interface ReplyInboxItem {
  readonly instance_id: string
  readonly profile_url: string
  readonly name: string | null
  readonly company: string | null
  readonly headline: string | null
  readonly campaign_id: string | null
  readonly latest_snippet: string | null
  readonly latest_direction: 'in' | 'out' | null
  readonly latest_sent_at: string | null
  readonly selected_message_id: number | null
  readonly pending_count: number
  readonly owner_id: number | null
  readonly action: ReplyAction | null
  readonly next_follow_up_date: string | null
  readonly do_not_contact: boolean
  readonly revision: number
  readonly review_revision: number
  readonly workflow_revision: number
  readonly inbound_revision: number
  readonly acknowledged_inbound_revision: number
  readonly campaign_ids: readonly string[]
  readonly first_seen_at: string | null
}

export interface ReplyInboxResponse {
  readonly items: readonly ReplyInboxItem[]
  readonly next_cursor: string | null
  readonly facets: ReplyFacets
  readonly scope: ReplyInboxScope
}

export interface ReplyFacets {
  readonly accounts: readonly { readonly id: string; readonly count: number }[]
  readonly campaigns: readonly { readonly id: string | null; readonly count: number }[]
  readonly owners: readonly { readonly id: number | null; readonly count: number }[]
  readonly actions: readonly { readonly value: ReplyAction | null; readonly count: number }[]
  readonly sentiments: readonly { readonly value: ReplySentiment | null; readonly count: number }[]
  readonly reasons: readonly { readonly value: ReplyReasonId | null; readonly count: number }[]
}

export interface ReplyThreadRequest {
  readonly instance_id: string
  readonly profile_url: string
  readonly focus_message_id?: number | null
  readonly cursor?: string | null
  /** Cursor direction is explicit so a bounded focus window never masquerades as a forward-only page. */
  readonly direction?: 'around' | 'older' | 'newer'
  readonly limit?: number
}

export interface ReplyThreadMessage {
  readonly id: number
  readonly instance_id: string
  readonly profile_url: string
  readonly campaign_id: string | null
  readonly direction: 'in' | 'out'
  readonly body: string | null
  readonly sent_at: string
  readonly first_seen_at: string | null
  readonly review: ReplyReviewDto | null
  readonly has_older?: boolean
  readonly has_newer?: boolean
}

export interface ReplyThreadResponse {
  readonly instance_id: string
  readonly profile_url: string
  readonly messages: readonly ReplyThreadMessage[]
  readonly older_cursor: string | null
  readonly newer_cursor: string | null
  readonly focus_message_id: number | null
  readonly has_older: boolean
  readonly has_newer: boolean
}

export interface ReplyReviewHistoryItem {
  readonly id: string
  readonly event_id: string
  readonly instance_id: string
  readonly profile_url: string
  readonly message_id: number | null
  readonly actor_id: string | null
  readonly actor: string | null
  readonly provenance: 'human' | 'legacy_manual' | 'system' | 'machine'
  readonly before: Readonly<Record<string, unknown>>
  readonly after: Readonly<Record<string, unknown>>
  readonly occurred_at: string
  readonly mutation_id: string
}

export interface ReplyAnalyticsRequest extends ReplyFilter {
  readonly from: string
  readonly to: string
  readonly bounds?: ReplyUtcBounds
}

export interface ReplyMetric {
  readonly numerator: number
  readonly denominator: number
  readonly rate: number | null
  readonly drilldown: ReplyMetricScope
  readonly base?: 'dialogues' | 'messages' | 'manual_dialogues' | 'manual_messages'
  readonly bounds?: ReplyUtcBounds
}

export interface ReplyAnalyticsResponse {
  readonly coverage: Readonly<Record<string, ReplyMetric>>
  readonly sentiment: Readonly<Record<string, ReplyMetric>>
  readonly reasons: Readonly<Record<string, ReplyMetric>>
  readonly weekly_trend: readonly Readonly<Record<string, unknown>>[]
  readonly workflow: Readonly<Record<string, ReplyMetric>>
  readonly comparison: readonly Readonly<Record<string, unknown>>[]
  readonly dataset_at: string
}

export interface ReplyCapability {
  readonly available: boolean
  /** `available` means the schema/read path exists; `active` gates manual readers and writes. */
  readonly active: boolean
  readonly manual_ready: boolean
  readonly mode: 'prepared' | 'manual' | null
  readonly schema_version: string | null
  readonly capture_started_at: string | null
  readonly activated_at: string | null
  readonly activation_in_progress: boolean
  readonly activation_cursor: number
  readonly activation_processed: number
  readonly activation_total: number
  readonly activation_cutoff: number | null
  readonly activation_batch_size: number | null
  readonly activation_mutation_id: string | null
  readonly reason?: 'schema_unavailable' | 'not_activated'
}

export class ReplyReviewValidationError extends Error {
  readonly code = 'REPLY_REVIEW_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'ReplyReviewValidationError'
  }
}

export class ReplyReviewConflictError extends Error {
  readonly code = 'REPLY_REVIEW_CONFLICT'
  readonly current?: unknown
  constructor(message: string, current?: unknown) {
    super(message)
    this.name = 'ReplyReviewConflictError'
    this.current = current
  }
}

export class ReplyReviewUnavailableError extends Error {
  readonly code = 'REPLY_REVIEW_UNAVAILABLE'
  constructor(message = 'Manual reply review is unavailable for this tenant') {
    super(message)
    this.name = 'ReplyReviewUnavailableError'
  }
}

/** A requested thread/message is not present in this tenant. */
export class ReplyReviewNotFoundError extends Error {
  readonly code = 'REPLY_REVIEW_NOT_FOUND'
  constructor(message = 'The requested reply or thread was not found') {
    super(message)
    this.name = 'ReplyReviewNotFoundError'
  }
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && values.includes(value as T)

export function isReplySentiment(value: unknown): value is ReplySentiment {
  return isOneOf(REPLY_SENTIMENTS, value)
}
export function isReplyReasonId(value: unknown): value is ReplyReasonId {
  return isOneOf(REPLY_REASON_IDS, value)
}
export function isReplyAction(value: unknown): value is ReplyAction {
  return isOneOf(REPLY_ACTIONS, value)
}
export function isReplyIntentState(value: unknown): value is ReplyIntentState {
  return isOneOf(REPLY_INTENT_STATES, value)
}
export function isReplyIntentLevel(value: unknown): value is ReplyIntentLevel {
  return isOneOf(REPLY_INTENT_LEVELS, value)
}

export function validateReplyReviewInput(input: ReplyReviewInput): ReplyReviewInput {
  if (input.sentiment !== null && !isReplySentiment(input.sentiment)) {
    throw new ReplyReviewValidationError('sentiment is invalid')
  }
  if (!isReplyIntentState(input.intent_state)) {
    throw new ReplyReviewValidationError('intent_state is invalid')
  }
  if (input.intent_level !== null && !isReplyIntentLevel(input.intent_level)) {
    throw new ReplyReviewValidationError('intent_level is invalid')
  }
  if (input.intent_state === 'level' && input.intent_level === null) {
    throw new ReplyReviewValidationError('intent_level is required for level intent')
  }
  if (input.intent_state !== 'level' && input.intent_level !== null) {
    throw new ReplyReviewValidationError('intent_level requires level intent')
  }
  if (input.sentiment === 'auto' && input.intent_state !== 'not_applicable') {
    throw new ReplyReviewValidationError('auto sentiment requires not_applicable intent')
  }
  if (input.sentiment !== 'auto' && input.intent_state === 'not_applicable') {
    throw new ReplyReviewValidationError('not_applicable intent is only valid for auto')
  }
  const reason_ids = [...input.reason_ids]
  if (reason_ids.some((id) => !isReplyReasonId(id))) {
    throw new ReplyReviewValidationError('reason_ids contains an unknown reason')
  }
  if (new Set(reason_ids).size !== reason_ids.length) {
    throw new ReplyReviewValidationError('reason_ids must be unique')
  }
  const comment = input.comment === null ? null : input.comment.trim()
  if (comment !== null && comment.length > REPLY_REVIEW_MAX_COMMENT) {
    throw new ReplyReviewValidationError('comment exceeds 1000 characters')
  }
  if (reason_ids.includes('other') && !comment) {
    throw new ReplyReviewValidationError('comment is required when reason_ids includes other')
  }
  if ((input.sentiment === 'negative' || input.sentiment === 'objection') && reason_ids.length === 0) {
    throw new ReplyReviewValidationError('at least one reason is required for negative or objection')
  }
  return { ...input, reason_ids, comment: comment || null }
}

export function validateReplyWorkflowInput(input: ReplyWorkflowInput): ReplyWorkflowInput {
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) {
    throw new ReplyReviewValidationError('expected_revision must be a non-negative integer')
  }
  if (!Number.isSafeInteger(input.observed_inbound_revision) || input.observed_inbound_revision < 0) {
    throw new ReplyReviewValidationError('observed_inbound_revision must be a non-negative integer')
  }
  if (input.action !== null && !isReplyAction(input.action)) {
    throw new ReplyReviewValidationError('action is invalid')
  }
  if (input.owner_id !== null && (!Number.isSafeInteger(input.owner_id) || input.owner_id <= 0)) {
    throw new ReplyReviewValidationError('owner_id must be a positive integer or null')
  }
  if (input.next_follow_up_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.next_follow_up_date)) {
    throw new ReplyReviewValidationError('next_follow_up_date must be YYYY-MM-DD or null')
  }
  if (input.next_follow_up_date !== null) {
    const todayMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    if (input.next_follow_up_date < todayMadrid) throw new ReplyReviewValidationError('next_follow_up_date cannot be before today')
  }
  if (input.action === 'follow_up' && (!input.owner_id || !input.next_follow_up_date)) {
    throw new ReplyReviewValidationError('follow_up requires owner_id and next_follow_up_date')
  }
  if (input.action !== null && !input.owner_id) {
    throw new ReplyReviewValidationError(`${input.action} requires owner_id`)
  }
  if (input.action !== 'follow_up' && input.next_follow_up_date !== null) {
    throw new ReplyReviewValidationError('next_follow_up_date is only valid for follow_up')
  }
  if (input.do_not_contact && input.action !== 'resolved') {
    throw new ReplyReviewValidationError('do_not_contact requires resolved action')
  }
  if (input.change_reason !== null && input.change_reason.length > REPLY_REVIEW_MAX_COMMENT) {
    throw new ReplyReviewValidationError('change_reason exceeds 1000 characters')
  }
  return { ...input, change_reason: input.change_reason?.trim() || null }
}

export function validateThreadKey(instanceId: string, profileUrl: string): void {
  if (!instanceId.trim() || instanceId.length > 200) throw new ReplyReviewValidationError('instance_id is invalid')
  if (!profileUrl.trim() || profileUrl.length > 2_000) throw new ReplyReviewValidationError('profile_url is invalid')
}

/** Canonical, stable payload hash used by mutation replay protection. */
export function replyMutationFingerprint(payload: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)]))
    }
    return value
  }
  return createHash('sha256').update(JSON.stringify(normalize(payload))).digest('hex')
}

export function replyMetricRate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

/**
 * A small, deterministic codec for operation-facing drill-down cursors.
 * Neon also binds cursors to operation/params/actor, but this fingerprint is
 * deliberately carried in the token so an API handler can reject a cursor
 * before composing a query and can distinguish a cursor from another filter
 * scope.  It is not a capability or authorization token.
 */
export interface ReplyCursorPayload {
  readonly fingerprint: string
  readonly sort: 'first_seen' | 'latest'
  readonly direction: 'older' | 'newer'
  readonly key: readonly (string | number | null)[]
}

function canonicalCursorValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCursorValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalCursorValue(item)]))
  }
  return value
}

export function replyCursorFingerprint(scope: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalCursorValue(scope))).digest('hex')
}

export function encodeReplyCursor(scope: unknown, payload: Omit<ReplyCursorPayload, 'fingerprint'>): string {
  const value: ReplyCursorPayload = { ...payload, fingerprint: replyCursorFingerprint(scope) }
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function decodeReplyCursor(token: string, scope: unknown): ReplyCursorPayload {
  let value: unknown
  try { value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) } catch {
    throw new ReplyReviewValidationError('cursor is invalid or belongs to another scope')
  }
  if (!value || typeof value !== 'object') throw new ReplyReviewValidationError('cursor is invalid or belongs to another scope')
  const row = value as Record<string, unknown>
  const key = row.key
  if (row.fingerprint !== replyCursorFingerprint(scope) ||
      (row.sort !== 'first_seen' && row.sort !== 'latest') ||
      (row.direction !== 'older' && row.direction !== 'newer') ||
      !Array.isArray(key) || key.length < 2 || key.length > 4 ||
      key.some((part) => part !== null && typeof part !== 'string' && typeof part !== 'number')) {
    throw new ReplyReviewValidationError('cursor is invalid or belongs to another scope')
  }
  return { fingerprint: String(row.fingerprint), sort: row.sort as ReplyCursorPayload['sort'], direction: row.direction as ReplyCursorPayload['direction'], key: key as ReplyCursorPayload['key'] }
}
