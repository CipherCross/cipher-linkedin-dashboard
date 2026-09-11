import { authFetch, authPost } from './api'

export const REPLY_SENTIMENTS = [
  'positive', 'neutral', 'negative', 'objection', 'referral', 'auto',
] as const
export type ReplyReviewSentiment = (typeof REPLY_SENTIMENTS)[number]

export const REPLY_INTENT_STATES = ['unreviewed', 'none', 'level', 'not_applicable'] as const
export type ReplyIntentState = (typeof REPLY_INTENT_STATES)[number]
export const REPLY_INTENT_LEVELS = ['p1', 'p2', 'p3'] as const
export type ReplyIntentLevel = (typeof REPLY_INTENT_LEVELS)[number]

export const REPLY_REASON_IDS = [
  'no_need', 'timing', 'budget', 'existing_solution', 'offer_fit', 'wrong_person',
  'trust_information', 'do_not_contact', 'other',
] as const
export type ReplyReasonId = (typeof REPLY_REASON_IDS)[number]

export const REPLY_ACTIONS = [
  'needs_reply', 'follow_up', 'awaiting_reply', 'resolved', 'closed_soft', 'closed_hard',
] as const
export type ReplyWorkflowAction = (typeof REPLY_ACTIONS)[number]

export const SENTIMENT_LABELS: Record<ReplyReviewSentiment, string> = {
  positive: 'Положительный', neutral: 'Нейтральный', negative: 'Негативный',
  objection: 'Возражение', referral: 'Реферал', auto: 'Автоответ',
}
export const INTENT_STATE_LABELS: Record<ReplyIntentState, string> = {
  unreviewed: 'Не оценён', none: 'Нет intent', level: 'Коммерческий intent',
  not_applicable: 'Не применимо',
}
export const INTENT_LEVEL_LABELS: Record<ReplyIntentLevel, string> = {
  p1: 'P1 · вежливый позитив', p2: 'P2 · интерес к проблеме', p3: 'P3 · покупательский intent',
}
export const REASON_LABELS: Record<ReplyReasonId, string> = {
  no_need: 'Нет потребности / неинтересно', timing: 'Не сейчас / неверный тайминг',
  budget: 'Нет бюджета / дорого', existing_solution: 'Уже есть решение',
  offer_fit: 'Не подходит продукт или предложение', wrong_person: 'Не тот человек / перенаправление',
  trust_information: 'Недоверие / недостаточно информации', do_not_contact: 'Не связываться / unsubscribe',
  other: 'Другое',
}
export const ACTION_LABELS: Record<ReplyWorkflowAction, string> = {
  needs_reply: 'Нужен ответ', follow_up: 'Follow-up позже', awaiting_reply: 'Ждём ответа',
  resolved: 'Завершено', closed_soft: 'Закрыт · мягкий отказ', closed_hard: 'Закрыт · окончательный отказ',
}

export const REASON_HELP: Record<ReplyReasonId, string> = {
  no_need: 'Нет задачи или интереса; не угадывайте причину отказа.', timing: 'Срок не подходит сейчас.',
  budget: 'Денежное ограничение или цена.', existing_solution: 'Уже есть поставщик или внутреннее решение.',
  offer_fit: 'Конкретное несоответствие продукта или предложения.', wrong_person: 'Контакт перенаправляет к другому человеку.',
  trust_information: 'Не хватает доверия или информации.', do_not_contact: 'Явная просьба не связываться.',
  other: 'Причина, которой нет в справочнике; добавьте комментарий.',
}

export interface ReplyReviewDraft {
  sentiment: ReplyReviewSentiment | null
  intent_state: ReplyIntentState
  intent_level: ReplyIntentLevel | null
  reason_ids: ReplyReasonId[]
  comment: string
}
export interface ReplyReview extends ReplyReviewDraft {
  message_id: number
  taxonomy_version: string
  reviewed_by: number | string | null
  reviewed_at: string | null
  revision: number
  provenance: 'human' | 'legacy_manual'
  complete: boolean
}
export interface ReplyThreadMessage {
  id: number
  instance_id: string
  profile_url: string
  campaign_id: string | null
  direction: string
  body: string | null
  sent_at: string
  first_seen_at?: string | null
  source?: string | null
  review?: ReplyReview | null
}
export interface ReplyWorkflow {
  instance_id: string
  profile_url: string
  action: ReplyWorkflowAction | null
  owner_id: number | null
  next_follow_up_date: string | null
  do_not_contact: boolean
  revision: number
  acknowledged_inbound_revision: number
  inbound_revision?: number
  supporting_message_id?: number | null
}
export interface RepliesInboxItem {
  instance_id: string
  profile_url: string
  name?: string | null
  company?: string | null
  headline?: string | null
  campaign_id?: string | null
  latest_snippet: string | null
  latest_direction: string | null
  latest_sent_at: string | null
  selected_message_id: number | null
  pending_count: number
  owner_id: number | null
  action: ReplyWorkflowAction | null
  next_follow_up_date: string | null
  do_not_contact: boolean
  review_revision: number
  workflow_revision: number
  /** Backend's single workflow revision; the split aliases remain for adapters. */
  revision: number
  inbound_revision: number
  acknowledged_inbound_revision: number
}
export interface ReplyListFacets {
  sentiments?: Partial<Record<ReplyReviewSentiment, number>>
  actions?: Partial<Record<ReplyWorkflowAction, number>>
  reasons?: Partial<Record<ReplyReasonId, number>>
  owners?: Array<{ id: number; name: string }>
}
export interface RepliesInboxResponse {
  items: RepliesInboxItem[]
  next_cursor: string | null
  facets?: ReplyListFacets
  scope: ReplyInboxScope
  dataset_at?: string
}
/** Save+next ordering: finish the current bounded thread before moving to the
 * next dialog whose server-computed pending_count still needs work. */
export function nextUnreviewedReply(
  messages: readonly ReplyThreadMessage[],
  items: readonly RepliesInboxItem[],
  currentMessageId: number,
  currentThread: { instance_id: string; profile_url: string },
): { kind: 'message'; value: ReplyThreadMessage } | { kind: 'thread'; value: RepliesInboxItem } | null {
  const index = messages.findIndex((message) => message.id === currentMessageId)
  const message = messages.slice(index + 1).find((candidate) => candidate.direction === 'in' && !candidate.review?.complete)
  if (message) return { kind: 'message', value: message }
  const itemIndex = items.findIndex((item) => item.instance_id === currentThread.instance_id && item.profile_url === currentThread.profile_url)
  const next = items.slice(itemIndex + 1).find((item) => item.pending_count > 0)
  return next ? { kind: 'thread', value: next } : null
}
export interface RepliesThreadResponse {
  messages: ReplyThreadMessage[]
  older_cursor?: string | null
  newer_cursor?: string | null
  inbound_revision?: number
  workflow?: ReplyWorkflow | null
  next_focus_message_id?: number | null
}
export interface ReplyReviewHistoryEntry {
  event_id: number | string
  message_id: number | null
  actor: string | null
  provenance: string
  before: Partial<ReplyReviewDraft> | null
  after: Partial<ReplyReviewDraft> | null
  occurred_at: string
}
export interface ReplyCapabilities {
  available: boolean
  /** Schema presence is distinct from a tenant being activated for manual review. */
  active?: boolean
  manual_ready?: boolean
  activation_in_progress?: boolean
  activation_processed?: number
  activation_total?: number
  mode?: 'prepared' | 'manual' | null
  reason?: 'schema_unavailable' | 'not_activated'
  members?: Array<{ id: number; name: string; active: boolean }>
  instances?: Array<{ id: string; label: string }>
  campaigns?: Array<{ id: string; name: string; instance_id: string }>
  unavailable_reason?: string
  facets?: ReplyListFacets
}

export function isReplyManualReady(capabilities: ReplyCapabilities | null | undefined): boolean {
  return capabilities?.available === true && capabilities.active !== false && capabilities.manual_ready !== false && capabilities.mode !== 'prepared' && capabilities.activation_in_progress !== true
}

export type RepliesInboxView = 'all' | 'unreviewed' | 'needs_reply' | 'deferred' | 'completed'
export interface ReplyMetricScope {
  kind: 'sentiment' | 'reason' | 'workflow' | 'coverage'
  value: string
}
export type RepliesInboxScope = 'new' | 'historical' | 'all'
export interface ReplyInboxScope {
  view: RepliesInboxView
  scope: RepliesInboxScope
  account: string | null
  campaign: string | null
  owner: string | null
  my: boolean
  unacknowledged: boolean
  unowned: boolean
  overdue: boolean
  action: ReplyWorkflowAction | 'unassigned' | null
  sentiment: ReplyReviewSentiment | null
  reason: ReplyReasonId | null
  query: string
  cursor: string | null
  limit: number
  from: string | null
  to: string | null
  metric_scope: ReplyMetricScope | null
  thread: { instance_id: string; profile_url: string; focus_message_id: number | null } | null
}

export const DEFAULT_REPLY_SCOPE: ReplyInboxScope = {
  view: 'unreviewed', scope: 'new', account: null, campaign: null, owner: null,
  my: false, unacknowledged: false, unowned: false, overdue: false,
  action: null, sentiment: null, reason: null, query: '', cursor: null, limit: 50,
  from: null, to: null, metric_scope: null, thread: null,
}

const MAX_QUERY = 200
export const REPLY_SEARCH_DEBOUNCE_MS = 300
const VALID_ACTIONS = new Set<string>(REPLY_ACTIONS)
const VALID_SENTIMENTS = new Set<string>(REPLY_SENTIMENTS)
const VALID_REASONS = new Set<string>(REPLY_REASON_IDS)

export function validateReview(draft: ReplyReviewDraft): Record<string, string> {
  const errors: Record<string, string> = {}
  if ((draft.sentiment === 'negative' || draft.sentiment === 'objection') && draft.reason_ids.length === 0) {
    errors.reason_ids = 'Для negative и objection выберите хотя бы одну причину.'
  }
  const unique = new Set(draft.reason_ids)
  if (unique.size !== draft.reason_ids.length || [...unique].some((id) => !VALID_REASONS.has(id))) {
    errors.reason_ids = 'Причины должны быть уникальными и входить в справочник.'
  }
  if (draft.reason_ids.includes('other') && !draft.comment.trim()) errors.comment = 'Для причины «Другое» нужен комментарий.'
  if (draft.comment.length > 1000) errors.comment = 'Комментарий не может быть длиннее 1000 символов.'
  // Existing values are intentionally retained while an SDR changes a message
  // to auto; the panel asks for an explicit confirmation before clearing them.
  if (draft.intent_state === 'not_applicable' && draft.sentiment !== 'auto') {
    errors.intent_state = '«Не применимо» допустимо только для auto.'
  }
  if (draft.intent_state === 'level' && !draft.intent_level) errors.intent_level = 'Выберите P1, P2 или P3.'
  if (draft.intent_state !== 'level' && draft.intent_level) errors.intent_level = 'Уровень intent допустим только для состояния level.'
  return errors
}

export function draftFromReview(review: ReplyReview | null | undefined): ReplyReviewDraft {
  return {
    sentiment: review?.sentiment ?? null,
    intent_state: review?.intent_state ?? 'unreviewed', intent_level: review?.intent_level ?? null,
    reason_ids: review?.reason_ids ? [...review.reason_ids] : [], comment: review?.comment ?? '',
  }
}

export function needsAutoResetConfirmation(draft: ReplyReviewDraft): boolean {
  return draft.sentiment === 'auto' && (draft.reason_ids.length > 0 || draft.intent_state !== 'not_applicable' || !!draft.intent_level)
}

export function encodeReplyScope(scope: Partial<ReplyInboxScope>): URLSearchParams {
  const merged = { ...DEFAULT_REPLY_SCOPE, ...scope }
  const params = new URLSearchParams()
  if (merged.view !== DEFAULT_REPLY_SCOPE.view) params.set('view', merged.view)
  if (merged.scope !== DEFAULT_REPLY_SCOPE.scope) params.set('scope', merged.scope)
  for (const [key, value] of [['account', merged.account], ['campaign', merged.campaign], ['owner', merged.owner], ['action', merged.action], ['sentiment', merged.sentiment], ['reason', merged.reason], ['from', merged.from], ['to', merged.to]] as const) {
    if (value) params.set(key, value)
  }
  if (merged.my) params.set('my', '1')
  if (merged.unacknowledged) params.set('unacknowledged', '1')
  if (merged.unowned) params.set('unowned', '1')
  if (merged.overdue) params.set('overdue', '1')
  if (merged.metric_scope) params.set('metric_scope', `${merged.metric_scope.kind}:${merged.metric_scope.value}`)
  if (merged.query) params.set('q', merged.query.slice(0, MAX_QUERY))
  if (merged.cursor) params.set('cursor', merged.cursor)
  if (merged.thread) {
    params.set('thread', `${merged.thread.instance_id}|${merged.thread.profile_url}`)
    if (merged.thread.focus_message_id != null) params.set('focus', String(merged.thread.focus_message_id))
  }
  return params
}

export function decodeReplyScope(params: URLSearchParams): ReplyInboxScope {
  const scope = params.get('scope')
  const action = params.get('action')
  const sentiment = params.get('sentiment')
  const reason = params.get('reason')
  const threadKey = params.get('thread')
  const separator = threadKey?.indexOf('|') ?? -1
  const metric = params.get('metric_scope')?.split(':') ?? []
  const metricKind = metric[0]
  const metricScope = metricKind === 'sentiment' || metricKind === 'reason' || metricKind === 'workflow' || metricKind === 'coverage'
    ? { kind: metricKind, value: metric.slice(1).join(':') } as ReplyMetricScope
    : null
  const rawView = params.get('view')
  const view: RepliesInboxView = rawView === null ? DEFAULT_REPLY_SCOPE.view : rawView === 'unreviewed' || rawView === 'needs_reply' || rawView === 'deferred' || rawView === 'completed' ? rawView : 'all'
  return {
    ...DEFAULT_REPLY_SCOPE,
    view,
    scope: scope === 'historical' || scope === 'all' ? scope : 'new',
    account: params.get('account'), campaign: params.get('campaign'), owner: params.get('owner'),
    my: params.get('my') === '1', unacknowledged: params.get('unacknowledged') === '1', unowned: params.get('unowned') === '1', overdue: params.get('overdue') === '1',
    action: action === 'unassigned' || VALID_ACTIONS.has(action ?? '') ? action as ReplyInboxScope['action'] : null,
    sentiment: VALID_SENTIMENTS.has(sentiment ?? '') ? sentiment as ReplyReviewSentiment : null,
    reason: VALID_REASONS.has(reason ?? '') ? reason as ReplyReasonId : null,
    query: (params.get('q') ?? '').slice(0, MAX_QUERY), cursor: params.get('cursor'),
    from: params.get('from'), to: params.get('to'), metric_scope: metricScope,
    thread: separator > 0 ? { instance_id: threadKey!.slice(0, separator), profile_url: threadKey!.slice(separator + 1), focus_message_id: parseFocus(params.get('focus')) } : null,
  }
}

function parseFocus(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export interface ReplyReadClient {
  capabilities(signal?: AbortSignal): Promise<ReplyCapabilities>
  inbox(scope: ReplyInboxScope, signal?: AbortSignal): Promise<RepliesInboxResponse>
  thread(request: { instance_id: string; profile_url: string; focus_message_id?: number | null; cursor?: string | null; direction?: 'older' | 'newer'; limit?: number }, signal?: AbortSignal): Promise<RepliesThreadResponse>
  history(request: { instance_id: string; profile_url: string; message_id?: number | null; cursor?: string | null; limit?: number }, signal?: AbortSignal): Promise<{ items: ReplyReviewHistoryEntry[]; next_cursor: string | null }>
}

async function readJson<T>(response: Response): Promise<T> {
  let payload: unknown = null
  try { payload = await response.json() } catch { /* preserve status below */ }
  if (!response.ok) {
    const body = payload as { error?: string; code?: string; current?: unknown } | null
    const error = new Error(body?.error ?? `Request failed (${response.status})`) as Error & { status?: number; code?: string; current?: unknown }
    error.status = response.status; error.code = body?.code; error.current = body?.current
    throw error
  }
  return payload as T
}

async function read<T>(op: string, params: Record<string, string | number | null | undefined>, signal?: AbortSignal): Promise<T> {
  const query = new URLSearchParams({ op })
  for (const [key, value] of Object.entries(params)) if (value != null && value !== '') query.set(key, String(value))
  return readJson<T>(await authFetch(`/api/activity-daily?${query.toString()}`, { signal }))
}

export const defaultReplyReadClient: ReplyReadClient = {
  async capabilities(signal) {
    const payload = await read<unknown>('replies.capabilities', {}, signal)
    if (payload && typeof payload === 'object' && 'items' in payload) {
      const items = (payload as { items?: ReplyCapabilities[] }).items
      return items?.[0] ?? { available: false, unavailable_reason: 'Схема manual review недоступна.' }
    }
    return payload as ReplyCapabilities
  },
  async inbox(scope, signal) {
    const payload = await read<Partial<RepliesInboxResponse> & { nextCursor?: string | null }>('replies.inbox', { view: scope.view, scope: scope.scope, instance_id: scope.account, campaign_id: scope.campaign, owner_id: scope.owner && scope.owner !== 'unassigned' ? scope.owner : null, my: scope.my ? 1 : null, unacknowledged: scope.unacknowledged ? 1 : null, unowned: scope.unowned ? 1 : null, overdue: scope.overdue ? 1 : null, action: scope.action === 'unassigned' ? null : scope.action, sentiment: scope.sentiment, reason_id: scope.reason, query: scope.query, cursor: scope.cursor, limit: scope.limit, from: scope.from, to: scope.to, metric_scope: scope.metric_scope ? `${scope.metric_scope.kind}:${scope.metric_scope.value}` : null }, signal)
    return { ...payload, items: payload.items ?? [], next_cursor: payload.next_cursor ?? payload.nextCursor ?? null, scope: payload.scope ?? scope }
  },
  async thread(request, signal) {
    const payload = await read<Partial<RepliesThreadResponse> & { items?: ReplyThreadMessage[]; nextCursor?: string | null }>('replies.thread', { instance_id: request.instance_id, profile_url: request.profile_url, focus_message_id: request.focus_message_id, cursor: request.cursor, direction: request.direction, limit: request.limit ?? 50 }, signal)
    if (payload.messages) return payload as RepliesThreadResponse
    return { messages: payload.items ?? [], older_cursor: payload.nextCursor ?? null, newer_cursor: null, inbound_revision: 0, workflow: null, next_focus_message_id: request.focus_message_id ?? null }
  },
  async history(request, signal) {
    const payload = await read<{ items: ReplyReviewHistoryEntry[]; next_cursor?: string | null; nextCursor?: string | null }>('replies.reviewHistory', { instance_id: request.instance_id, profile_url: request.profile_url, message_id: request.message_id, cursor: request.cursor, limit: request.limit ?? 50 }, signal)
    return { items: payload.items ?? [], next_cursor: payload.next_cursor ?? payload.nextCursor ?? null }
  },
}

export interface SaveReplyReviewRequest {
  action: 'save_reply_review'
  mutation_id: string
  instance_id: string
  profile_url: string
  message_id: number
  expected_review_revision: number
  review: ReplyReviewDraft
  workflow?: ReplyWorkflowMutation
}
export interface ReplyWorkflowMutation {
  expected_revision: number
  observed_inbound_revision: number
  action: ReplyWorkflowAction | null
  owner_id: number | null
  next_follow_up_date: string | null
  do_not_contact: boolean
  change_reason: string | null
}
export interface SaveReplyReviewResult {
  review: ReplyReview
  workflow: ReplyWorkflow | null
  inbound_revision: number
  needs_action_confirmation: boolean
  mutation_id: string
}
export interface SetReplyWorkflowRequest {
  action: 'set_reply_workflow'
  mutation_id: string
  instance_id: string
  profile_url: string
  workflow: ReplyWorkflowMutation
}
export async function saveReplyReview(request: SaveReplyReviewRequest): Promise<SaveReplyReviewResult> {
  return readJson(await authPost('/api/pipeline', { ...request, review: { ...request.review, comment: request.review.comment.trim() || null }, workflow: request.workflow ? { ...request.workflow, change_reason: request.workflow.change_reason?.trim() || null } : undefined }))
}
export async function setReplyWorkflow(request: SetReplyWorkflowRequest): Promise<SaveReplyReviewResult> {
  return readJson(await authPost('/api/pipeline', { ...request, workflow: { ...request.workflow, change_reason: request.workflow.change_reason?.trim() || null } }))
}

export function newMutationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // The API validates mutation_id as UUID even on browsers without randomUUID.
  const entropy = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.replace(/[^0-9a-f]/gi, '').padEnd(12, '0').slice(-12)
  return `00000000-0000-4000-8000-${entropy}`
}
