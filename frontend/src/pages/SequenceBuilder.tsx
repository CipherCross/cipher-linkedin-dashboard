import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Archive,
  ArchiveRestore,
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  GripVertical,
  History,
  Laptop,
  LoaderCircle,
  MessageCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Split,
  Trash2,
  UserRoundPlus,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useToast } from '../lib/ToastContext'
import { useAuth } from '../lib/AuthContext'
import {
  CONNECTION_REQUEST_WARNING_LIMIT,
  PERSONALIZATION_TOKENS,
  addBranch,
  addMessageStep,
  addVariation,
  createSequenceDocument,
  graphemeCount,
  interpolateTokens,
  makeConnectionStep,
  moveMessageStep,
  moveVariation,
  publishStatusLabel,
  removeBranch,
  removeStep,
  removeVariation,
  repairBranches,
  resolveCommentAnchor,
  selectionPreview,
  sequenceCounts,
  sequencePreviewText,
  stepTitle,
  updateBranch,
  updateVariation,
  type SequenceCommentAnchor,
  type SequenceCommentThread,
  type SequenceDetail,
  type SequenceDocument,
  type SequenceRecord,
  type SequenceStep,
  type SequenceVariation,
  type SequenceVersion,
} from '../lib/sequenceBuilder'
import {
  SequenceBuilderApiError,
  createSequence,
  createSequenceComment,
  getSequence,
  listSequences,
  replySequenceComment,
  saveSequence,
  setSequenceArchived,
  setSequenceCommentResolved,
  createSequencePublishJob,
  listSequencePublishJobs,
  listSequencePublishTargets,
  type SequencePublishJob,
  type SequencePublishTarget,
} from '../lib/sequenceBuilderApi'
import { compileSequenceCampaigns, normalizeVerifiedAccountSnapshot, type SequencePublishOptions } from '../lib/sequencePublish'
import { fetchNeonSequenceHub } from '../lib/dashboardReads'
import type { CampaignRuntimeStatus, SequenceHubSnapshot } from '../lib/types'
import {
  CAMPAIGN_RUNTIME_STATUSES,
  campaignObservationHealth,
  campaignRuntimeLabel,
  parseCampaignRuntimeStatus,
} from '../lib/campaignRuntime'
import { CampaignRuntimeStatusView } from '../components/CampaignRuntimeStatus'
import { ago, num } from '../lib/format'

type EditorTab = 'build' | 'branches' | 'preview'
type PreviewDevice = 'web' | 'mobile'
type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

interface CommentTarget {
  stepId: string | null
  variationId: string | null
  anchor: SequenceCommentAnchor | null
  label: string
}

function formatUpdated(value: string): string {
  const date = new Date(value)
  const delta = Date.now() - date.valueOf()
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function SequenceLibrary() {
  const navigate = useNavigate()
  const toast = useToast()
  const [items, setItems] = useState<SequenceRecord[]>([])
  const [hub, setHub] = useState<SequenceHubSnapshot | null>(null)
  const [view, setView] = useState<'deployments' | 'build'>('deployments')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hubError, setHubError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [notebookFilter, setNotebookFilter] = useState('any')
  const [runtimeFilter, setRuntimeFilter] = useState<'any' | CampaignRuntimeStatus | 'unknown'>('any')
  const [archiveFilter, setArchiveFilter] = useState<'current' | 'all' | 'archived'>('current')
  const [sourceFilter, setSourceFilter] = useState('any')
  const [freshnessFilter, setFreshnessFilter] = useState<'any' | 'fresh' | 'stale' | 'unsupported'>('any')
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setHubError(null)
    const [builderResult, hubResult] = await Promise.allSettled([
      listSequences(), fetchNeonSequenceHub(),
    ])
    if (builderResult.status === 'fulfilled') setItems(builderResult.value)
    else setError(builderResult.reason instanceof Error ? builderResult.reason.message : 'Could not load sequences.')
    if (hubResult.status === 'fulfilled') setHub(hubResult.value)
    else setHubError(hubResult.reason instanceof Error ? hubResult.reason.message : 'Could not load deployments.')
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return items.filter((item) => {
      if (item.archived !== showArchived) return false
      if (!needle) return true
      return `${item.name} ${sequencePreviewText(item)} ${item.updated_by_name}`
        .toLowerCase()
        .includes(needle)
    })
  }, [items, query, showArchived])

  const deployments = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (hub?.items ?? []).map((item) => {
      const filtered = item.deployments.filter((deployment) => {
        if (notebookFilter !== 'any' && deployment.instance_id !== notebookFilter) return false
        const runtime = parseCampaignRuntimeStatus(deployment.runtime_status) ?? 'unknown'
        if (runtimeFilter !== 'any' && runtime !== runtimeFilter) return false
        if (archiveFilter === 'current' && deployment.is_archived !== false) return false
        if (archiveFilter === 'archived' && deployment.is_archived !== true) return false
        if (sourceFilter !== 'any' && deployment.status_source !== sourceFilter) return false
        const health = campaignObservationHealth(deployment)
        if (freshnessFilter === 'fresh' && health !== 'fresh') return false
        if (freshnessFilter === 'stale' && health !== 'stale') return false
        if (freshnessFilter === 'unsupported' && !['unsupported', 'awaiting_first_sync'].includes(health)) return false
        if (needle && !`${item.name} ${deployment.campaign_name} ${deployment.account_name ?? ''} ${deployment.instance_id}`.toLowerCase().includes(needle)) return false
        return true
      })
      return { item, deployments: filtered }
    }).filter((group) => group.deployments.length > 0)
  }, [hub, query, notebookFilter, runtimeFilter, archiveFilter, sourceFilter, freshnessFilter])

  const notebookOptions = useMemo(() => {
    const names = new Map<string, string>()
    for (const item of hub?.items ?? []) {
      for (const deployment of item.deployments) {
        names.set(deployment.instance_id, deployment.account_name ?? deployment.instance_id)
      }
    }
    return [...names.entries()].sort((left, right) => left[1].localeCompare(right[1]))
  }, [hub])

  const sourceOptions = useMemo(() => [...new Set(
    (hub?.items ?? []).flatMap((item) => item.deployments.map((deployment) => deployment.status_source).filter(Boolean)),
  )].sort() as string[], [hub])

  const create = async () => {
    setCreating(true)
    try {
      const sequence = await createSequence('Untitled sequence', createSequenceDocument())
      navigate(`/sequences/${sequence.id}`)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not create sequence.')
    } finally {
      setCreating(false)
    }
  }

  const archive = async (event: React.MouseEvent, item: SequenceRecord) => {
    event.stopPropagation()
    try {
      const updated = await setSequenceArchived(item.id, !item.archived)
      setItems((current) => current.map((entry) => (entry.id === item.id ? updated : entry)))
      toast.success(item.archived ? 'Sequence restored.' : 'Sequence archived.')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not update sequence.')
    }
  }

  return (
    <div className="sequence-library page-stack">
      <header className="sequence-library-hero">
        <div>
          <div className="eyebrow"><Sparkles size={14} /> Sequence → notebook deployments</div>
          <h1>Sequence Hub</h1>
          <p>See the last observed Linked Helper state on every notebook. Runtime, publishing and sync health stay separate.</p>
        </div>
        <button className="btn primary sequence-create-btn" onClick={create} disabled={creating}>
          <Plus size={16} /> {creating ? 'Creating…' : 'New sequence'}
        </button>
      </header>

      <div className="sequence-library-toolbar card">
        <label className="sequence-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={view === 'deployments' ? 'Search sequences, campaigns or notebooks' : 'Search sequences'}
            aria-label={view === 'deployments' ? 'Search deployments' : 'Search sequences'}
          />
        </label>
        <div className="sequence-library-switch" role="tablist" aria-label="Sequence Hub section">
          <button role="tab" aria-selected={view === 'deployments'} className={view === 'deployments' ? 'active' : ''} onClick={() => setView('deployments')}>
            Deployments <span>{hub?.items.reduce((count, item) => count + item.deployments.length, 0) ?? 0}</span>
          </button>
          <button role="tab" aria-selected={view === 'build'} className={view === 'build' ? 'active' : ''} onClick={() => setView('build')}>
            Build <span>{items.filter((item) => !item.archived).length}</span>
          </button>
        </div>
      </div>

      {view === 'deployments' && (
        <div className="deployment-filters card" aria-label="Deployment filters">
          <label><span>Notebook</span><select aria-label="Filter deployments by notebook" value={notebookFilter} onChange={(event) => setNotebookFilter(event.target.value)}><option value="any">All notebooks</option>{notebookOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label><span>Runtime</span><select aria-label="Filter deployments by runtime status" value={runtimeFilter} onChange={(event) => setRuntimeFilter(event.target.value as typeof runtimeFilter)}><option value="any">All statuses</option>{CAMPAIGN_RUNTIME_STATUSES.map((status) => <option key={status} value={status}>{campaignRuntimeLabel(status)}</option>)}<option value="unknown">Unknown</option></select></label>
          <label><span>Archive</span><select aria-label="Filter deployments by archive state" value={archiveFilter} onChange={(event) => setArchiveFilter(event.target.value as typeof archiveFilter)}><option value="current">Current</option><option value="all">All</option><option value="archived">Archived</option></select></label>
          <label><span>Source</span><select aria-label="Filter deployments by status source" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}><option value="any">All sources</option>{sourceOptions.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
          <label><span>Observation</span><select aria-label="Filter deployments by observation health" value={freshnessFilter} onChange={(event) => setFreshnessFilter(event.target.value as typeof freshnessFilter)}><option value="any">Any freshness</option><option value="fresh">Fresh</option><option value="stale">Stale</option><option value="unsupported">Unsupported / waiting</option></select></label>
        </div>
      )}

      {loading ? (
        <div className="sequence-card-grid" aria-label="Loading sequences">
          {[0, 1, 2].map((key) => <div key={key} className="sequence-card sequence-card-skeleton" />)}
        </div>
      ) : view === 'deployments' ? (
        hubError ? (
          <div className="card sequence-empty-state"><h2>Deployments are not available</h2><p>{hubError}</p><button className="btn" onClick={() => void load()}>Try again</button></div>
        ) : deployments.length === 0 ? (
          <div className="card sequence-empty-state"><h2>No deployments match these filters</h2><p>Use All archive states to include campaigns whose archive membership is still unknown.</p></div>
        ) : (
          <div className="deployment-groups">
            {deployments.map(({ item, deployments: rows }) => (
              <section className="card deployment-group" key={item.id} aria-labelledby={`deployment-${item.id}`}>
                <div className="deployment-group-head">
                  <div><div className="eyebrow">{item.kind === 'managed' ? 'Sequence Builder' : 'External Linked Helper'}</div><h2 id={`deployment-${item.id}`}>{item.name}</h2></div>
                  {item.sequence_document_id && <Link className="link-btn" to={`/sequences/${encodeURIComponent(item.sequence_document_id)}`}>Open builder <ChevronRight size={14} /></Link>}
                </div>
                <div className="deployment-table-scroll">
                  <table className="deployment-table"><thead><tr><th>Campaign / notebook</th><th>Linked Helper runtime</th><th>Publish</th><th className="num">Leads</th><th className="num">Replies</th><th>Sync</th></tr></thead><tbody>
                    {rows.map((deployment) => (
                      <tr key={deployment.key}>
                        <td><div>{deployment.campaign_id
                          ? <Link className="row-link" to={`/campaign/${encodeURIComponent(deployment.campaign_id)}`}>{deployment.campaign_name}</Link>
                          : <span>{deployment.campaign_name}</span>}</div><span className="muted small">{deployment.account_name ?? deployment.instance_id} · {deployment.instance_id}</span></td>
                        <td><CampaignRuntimeStatusView campaign={deployment} compact /></td>
                        <td>{deployment.publish_status ? <><span className={`badge publish-${deployment.publish_status}`}>{publishStatusLabel(deployment.publish_status)}</span>{deployment.awaiting_sync && <div className="muted small">Awaiting campaign sync</div>}</> : <span className="muted small">External campaign</span>}</td>
                        <td className="num">{num(deployment.leads)}</td><td className="num">{num(deployment.replies)}</td>
                        <td className="muted small">{deployment.last_sync_at ? ago(deployment.last_sync_at) : 'Never synced'}</td>
                      </tr>
                    ))}
                  </tbody></table>
                </div>
              </section>
            ))}
          </div>
        )
      ) : error ? (
        <div className="card sequence-empty-state">
          <h2>Sequence Builder is not available</h2>
          <p>{error}</p>
          <button className="btn" onClick={() => void load()}>Try again</button>
        </div>
      ) : visible.length === 0 ? (
        <div className="card sequence-empty-state">
          <div className="sequence-empty-icon"><MessageSquarePlus size={26} /></div>
          <h2>{query ? 'No matching sequences' : showArchived ? 'No archived sequences' : 'Start with a blank canvas'}</h2>
          <p>{query ? 'Try another name or message fragment.' : 'Connection request, follow-ups and variations all stay together.'}</p>
          {!query && !showArchived && (
            <button className="btn primary" onClick={create} disabled={creating}><Plus size={15} /> New sequence</button>
          )}
        </div>
      ) : (
        <>
        <div className="sequence-library-switch build-archive-switch" role="group" aria-label="Builder sequence status">
          <button className={!showArchived ? 'active' : ''} onClick={() => setShowArchived(false)}>Current <span>{items.filter((item) => !item.archived).length}</span></button>
          <button className={showArchived ? 'active' : ''} onClick={() => setShowArchived(true)}>Archived <span>{items.filter((item) => item.archived).length}</span></button>
        </div>
        <div className="sequence-card-grid">
          {visible.map((item) => {
            const counts = sequenceCounts(item)
            return (
              <article
                key={item.id}
                className="sequence-card"
                tabIndex={0}
                role="button"
                onClick={() => navigate(`/sequences/${item.id}`)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') navigate(`/sequences/${item.id}`)
                }}
              >
                <div className="sequence-card-top">
                  <div className="sequence-card-glyph"><Split size={19} /></div>
                  <button
                    className="icon-only-btn"
                    aria-label={item.archived ? 'Restore sequence' : 'Archive sequence'}
                    title={item.archived ? 'Restore' : 'Archive'}
                    onClick={(event) => void archive(event, item)}
                  >
                    {item.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                  </button>
                </div>
                <h2>{item.name}</h2>
                <p className="sequence-card-preview">{sequencePreviewText(item)}</p>
                <div className="sequence-mini-flow" aria-hidden="true">
                  {item.document.steps.slice(0, 5).map((step, index) => (
                    <span key={step.id} className={step.kind === 'connection' ? 'connection' : ''}>
                      {index === 0 ? 'CR' : index}
                      <i>{step.variations.length}</i>
                    </span>
                  ))}
                  {item.document.steps.length > 5 && <b>+{item.document.steps.length - 5}</b>}
                </div>
                <div className="sequence-card-counts">
                  <span>{counts.steps} messages</span>
                  <span>{counts.variations} variations</span>
                  <span>{counts.branches} branches</span>
                </div>
                <footer>
                  <span>Edited by {item.updated_by_name}</span>
                  <span><Clock3 size={12} /> {formatUpdated(item.updated_at)}</span>
                  <ChevronRight size={16} />
                </footer>
              </article>
            )
          })}
        </div></>
      )}
    </div>
  )
}

function SaveIndicator({ state }: { state: SaveState }) {
  const labels: Record<SaveState, string> = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    conflict: 'Newer version found',
    error: 'Save failed',
  }
  return <span className={`sequence-save-state ${state}`}><i />{labels[state]}</span>
}

function SortableStepShell({ step, children }: { step: SequenceStep; children: (handle: ReactNode) => ReactNode }) {
  const sortable = useSortable({ id: step.id, data: { type: 'step', stepId: step.id }, disabled: step.kind === 'connection' })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.45 : 1,
  }
  const handle = (
    <button
      type="button"
      className="sequence-drag-handle"
      aria-label="Drag message step"
      disabled={step.kind === 'connection'}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <GripVertical size={17} />
    </button>
  )
  return <section ref={sortable.setNodeRef} style={style} className="sequence-step-card">{children(handle)}</section>
}

function SortableVariationShell({
  stepId,
  variation,
  children,
}: {
  stepId: string
  variation: SequenceVariation
  children: (handle: ReactNode) => ReactNode
}) {
  const sortable = useSortable({
    id: variation.id,
    data: { type: 'variation', stepId, variationId: variation.id },
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.4 : 1,
  }
  const handle = (
    <button
      type="button"
      className="sequence-variation-drag"
      aria-label="Drag variation"
      {...sortable.attributes}
      {...sortable.listeners}
    >
      <GripVertical size={15} />
    </button>
  )
  return <article ref={sortable.setNodeRef} style={style} className="sequence-variation-card">{children(handle)}</article>
}

function CommentComposer({
  target,
  busy,
  onClose,
  onSubmit,
}: {
  target: CommentTarget
  busy: boolean
  onClose: () => void
  onSubmit: (body: string) => void
}) {
  const [body, setBody] = useState('')
  return (
    <div className="pipe-modal-overlay" onClick={onClose}>
      <div className="pipe-modal sequence-comment-modal" role="dialog" aria-modal="true" aria-label="Add comment" onClick={(event) => event.stopPropagation()}>
        <div className="pipe-modal-head">
          <span>Add comment</span>
          <button className="conv-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="sequence-comment-compose">
          <p className="muted">{target.label}</p>
          {target.anchor && <blockquote>“{target.anchor.quote}”</blockquote>}
          <textarea autoFocus rows={4} value={body} onChange={(event) => setBody(event.target.value)} placeholder="What should change, or what do you want the team to consider?" />
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={busy || !body.trim()} onClick={() => onSubmit(body.trim())}>{busy ? 'Adding…' : 'Add comment'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

interface VariationEditorProps {
  document: SequenceDocument
  step: SequenceStep
  variation: SequenceVariation
  comments: SequenceCommentThread[]
  selection: { start: number; end: number } | undefined
  onSelection: (selection: { start: number; end: number }) => void
  onDocument: (document: SequenceDocument) => void
  onComment: (target: CommentTarget) => void
  dragHandle: ReactNode
}

function VariationEditor({
  document,
  step,
  variation,
  comments,
  selection,
  onSelection,
  onDocument,
  onComment,
  dragHandle,
}: VariationEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const relevant = comments.filter((thread) => thread.variation_id === variation.id && !thread.resolved_at)
  const anchors = relevant.flatMap((thread) => (thread.anchor ? [thread.anchor] : []))
  const highlighted = selectionPreview(variation.text, anchors)
  const count = graphemeCount(variation.text)
  const overLimit = step.kind === 'connection' && count > CONNECTION_REQUEST_WARNING_LIMIT

  const captureSelection = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    onSelection({ start: textarea.selectionStart, end: textarea.selectionEnd })
  }

  const insertText = (text: string) => {
    const start = selection?.start ?? variation.text.length
    const end = selection?.end ?? start
    const next = `${variation.text.slice(0, start)}${text}${variation.text.slice(end)}`
    onDocument(updateVariation(document, step.id, variation.id, { text: next }))
    const cursor = start + text.length
    onSelection({ start: cursor, end: cursor })
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(cursor, cursor)
    })
  }

  const addSelectionComment = () => {
    const start = selection?.start ?? 0
    const end = selection?.end ?? 0
    const quote = end > start ? variation.text.slice(start, end) : ''
    onComment({
      stepId: step.id,
      variationId: variation.id,
      anchor: quote ? { start, end, quote } : null,
      label: quote ? `${stepTitle(document, step.id)} · ${variation.label} · selected text` : `${stepTitle(document, step.id)} · ${variation.label}`,
    })
  }

  return (
    <>
      <header className="sequence-variation-head">
        {dragHandle}
        <input
          value={variation.label}
          onChange={(event) => onDocument(updateVariation(document, step.id, variation.id, { label: event.target.value }))}
          aria-label="Variation name"
        />
        <span className="sequence-comment-count"><MessageCircle size={13} /> {relevant.length}</span>
        <button
          className="icon-only-btn danger"
          aria-label="Remove variation"
          onClick={() => onDocument(removeVariation(document, step.id, variation.id))}
        >
          <Trash2 size={14} />
        </button>
      </header>
      <div className="sequence-text-tools">
        {PERSONALIZATION_TOKENS.map((token) => (
          <button key={token} type="button" onClick={() => insertText(token)}>{token}</button>
        ))}
        <span className="sequence-emoji-tools">
          {['😊', '👋', '🚀', '💡'].map((emoji) => <button key={emoji} type="button" onClick={() => insertText(emoji)}>{emoji}</button>)}
        </span>
      </div>
      <textarea
        ref={textareaRef}
        className="sequence-message-textarea"
        value={variation.text}
        onChange={(event) => onDocument(updateVariation(document, step.id, variation.id, { text: event.target.value }))}
        onSelect={captureSelection}
        onKeyUp={captureSelection}
        onMouseUp={captureSelection}
        placeholder={step.kind === 'connection' ? 'Connection note can be empty…' : 'Write this variation…'}
        rows={7}
      />
      <div className="sequence-variation-footer">
        <button className="link-btn" onClick={addSelectionComment}>
          <MessageCircle size={13} />
          {selection && selection.end > selection.start ? 'Comment on selection' : 'Comment'}
        </button>
        <span className={overLimit ? 'char-warning' : 'muted'}>{count}{step.kind === 'connection' ? ` / ${CONNECTION_REQUEST_WARNING_LIMIT}` : ''}</span>
      </div>
      {overLimit && <p className="sequence-inline-warning">LinkedIn may reject this connection note. This is a warning only.</p>}
      {anchors.length > 0 && (
        <div className="sequence-commented-copy" aria-label="Commented text preview">
          {highlighted.map((part, index) => part.highlighted ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}
        </div>
      )}
      <label className="sequence-move-variation">
        Move to
        <select
          value={step.id}
          onChange={(event) => onDocument(moveVariation(document, variation.id, step.id, event.target.value))}
        >
          {document.steps.map((candidate) => <option key={candidate.id} value={candidate.id}>{stepTitle(document, candidate.id)}</option>)}
        </select>
      </label>
    </>
  )
}

function BuildCanvas({
  document,
  comments,
  selections,
  onSelection,
  onDocument,
  onComment,
}: {
  document: SequenceDocument
  comments: SequenceCommentThread[]
  selections: Record<string, { start: number; end: number }>
  onSelection: (key: string, selection: { start: number; end: number }) => void
  onDocument: (document: SequenceDocument) => void
  onComment: (target: CommentTarget) => void
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 7 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const dragEnd = (event: DragEndEvent) => {
    const activeType = event.active.data.current?.type
    if (!event.over || event.active.id === event.over.id) return
    if (activeType === 'step') {
      const oldIndex = document.steps.findIndex((step) => step.id === event.active.id)
      const newIndex = document.steps.findIndex((step) => step.id === event.over?.id)
      if (oldIndex > 0 && newIndex > 0) onDocument({ ...document, steps: [document.steps[0], ...arrayMove(document.steps.slice(1), oldIndex - 1, newIndex - 1)] })
      return
    }
    if (activeType === 'variation') {
      const fromStepId = String(event.active.data.current?.stepId ?? '')
      const overStepId = String(event.over.data.current?.stepId ?? '')
      const targetStep = document.steps.find((step) => step.id === overStepId)
      const overIndex = targetStep?.variations.findIndex((variation) => variation.id === event.over?.id)
      if (fromStepId && overStepId) onDocument(moveVariation(document, String(event.active.id), fromStepId, overStepId, overIndex !== undefined && overIndex >= 0 ? overIndex : undefined))
    }
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
      <SortableContext items={document.steps.slice(1).map((step) => step.id)} strategy={verticalListSortingStrategy}>
        <div className="sequence-step-list">
          {document.steps.map((step, index) => (
            <SortableStepShell key={step.id} step={step}>
              {(stepHandle) => (
                <>
                  <header className="sequence-step-head">
                    <div className={`sequence-step-icon ${step.kind}`}>
                      {step.kind === 'connection' ? <UserRoundPlus size={17} /> : <MessageCircle size={17} />}
                    </div>
                    <div>
                      <span className="eyebrow">Step {index + 1}</span>
                      <h2>{stepTitle(document, step.id)}</h2>
                    </div>
                    <span className="sequence-step-meta">{step.variations.length} variation{step.variations.length === 1 ? '' : 's'}</span>
                    <div className="sequence-step-actions">
                      <button className="btn sm" onClick={() => onComment({ stepId: step.id, variationId: null, anchor: null, label: stepTitle(document, step.id) })}><MessageCircle size={13} /> Comment</button>
                      {step.kind === 'message' && <button className="btn sm" onClick={() => onDocument(makeConnectionStep(document, step.id))}><UserRoundPlus size={13} /> Make CR</button>}
                      <button className="icon-only-btn" disabled={index <= 1} aria-label="Move step up" onClick={() => onDocument(moveMessageStep(document, step.id, -1))}><ArrowUp size={14} /></button>
                      <button className="icon-only-btn" disabled={index === 0 || index === document.steps.length - 1} aria-label="Move step down" onClick={() => onDocument(moveMessageStep(document, step.id, 1))}><ArrowDown size={14} /></button>
                      {stepHandle}
                      {step.kind === 'message' && <button className="icon-only-btn danger" aria-label="Remove step" onClick={() => onDocument(removeStep(document, step.id))}><Trash2 size={14} /></button>}
                    </div>
                  </header>

                  <SortableContext items={step.variations.map((variation) => variation.id)} strategy={rectSortingStrategy}>
                    <div className="sequence-variation-grid">
                      {step.variations.map((variation) => (
                        <SortableVariationShell key={variation.id} stepId={step.id} variation={variation}>
                          {(variationHandle) => (
                            <VariationEditor
                              document={document}
                              step={step}
                              variation={variation}
                              comments={comments}
                              selection={selections[`${step.id}:${variation.id}`]}
                              onSelection={(selection) => onSelection(`${step.id}:${variation.id}`, selection)}
                              onDocument={onDocument}
                              onComment={onComment}
                              dragHandle={variationHandle}
                            />
                          )}
                        </SortableVariationShell>
                      ))}
                      <button className="sequence-add-variation" onClick={() => onDocument(addVariation(document, step.id))}>
                        <Plus size={18} /><span>Add variation</span>
                      </button>
                    </div>
                  </SortableContext>
                </>
              )}
            </SortableStepShell>
          ))}
          <button className="sequence-add-step" onClick={() => onDocument(addMessageStep(document))}>
            <Plus size={18} /> Add message
          </button>
        </div>
      </SortableContext>
    </DndContext>
  )
}

function BranchBuilder({
  document,
  onDocument,
  onPreview,
}: {
  document: SequenceDocument
  onDocument: (document: SequenceDocument) => void
  onPreview: (branchId: string) => void
}) {
  return (
    <div className="sequence-branch-workspace">
      <header className="sequence-section-intro">
        <div>
          <div className="eyebrow"><Split size={14} /> Sequence versions</div>
          <h2>Build A/B/C branches</h2>
          <p>Choose one variation from every step. These branches are prepared sequences, not live traffic experiments.</p>
        </div>
        <button className="btn primary" onClick={() => onDocument(addBranch(document))}><Plus size={15} /> Add branch</button>
      </header>
      {document.branches.length === 0 ? (
        <div className="card sequence-branch-empty">
          <Split size={28} />
          <h3>No branches yet</h3>
          <p>Add A, B and C after you have explored a few message variations.</p>
          <button className="btn" onClick={() => onDocument(addBranch(document))}><Plus size={15} /> Create branch A</button>
        </div>
      ) : (
        <div className="sequence-branch-grid">
          {document.branches.map((branch, branchIndex) => (
            <article key={branch.id} className="card sequence-branch-card">
              <header>
                <span className="sequence-branch-letter">{branch.name.trim().slice(0, 2) || branchIndex + 1}</span>
                <input
                  value={branch.name}
                  onChange={(event) => onDocument(updateBranch(document, branch.id, { name: event.target.value }))}
                  aria-label="Branch name"
                />
                <button className="icon-only-btn danger" aria-label="Remove branch" onClick={() => onDocument(removeBranch(document, branch.id))}><Trash2 size={15} /></button>
              </header>
              <div className="sequence-branch-path">
                {document.steps.map((step) => (
                  <label key={step.id}>
                    <span>{stepTitle(document, step.id)}</span>
                    <select
                      value={branch.selections[step.id] ?? step.variations[0]?.id ?? ''}
                      onChange={(event) => onDocument(updateBranch(document, branch.id, { selections: { ...branch.selections, [step.id]: event.target.value } }))}
                    >
                      {step.variations.map((variation) => <option key={variation.id} value={variation.id}>{variation.label || 'Untitled variation'}</option>)}
                    </select>
                    <small>{step.variations.find((variation) => variation.id === branch.selections[step.id])?.text || 'Empty message'}</small>
                  </label>
                ))}
              </div>
              <button className="btn sequence-preview-branch" onClick={() => onPreview(branch.id)}><Eye size={14} /> Preview branch {branch.name}</button>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

function PreviewPanel({
  document,
  branchId,
  onBranchId,
}: {
  document: SequenceDocument
  branchId: string | null
  onBranchId: (id: string | null) => void
}) {
  const [device, setDevice] = useState<PreviewDevice>('web')
  const branch = document.branches.find((candidate) => candidate.id === branchId) ?? null
  const [custom, setCustom] = useState<Record<string, string>>(() => {
    const selections: Record<string, string> = {}
    for (const step of document.steps) if (step.variations[0]) selections[step.id] = step.variations[0].id
    return selections
  })
  const selections = branch?.selections ?? custom
  const previewSteps = document.steps.map((step) => ({
    step,
    variation: step.variations.find((variation) => variation.id === selections[step.id]) ?? step.variations[0],
  }))

  return (
    <div className="sequence-preview-workspace">
      <header className="sequence-section-intro">
        <div>
          <div className="eyebrow"><Eye size={14} /> Recipient view</div>
          <h2>LinkedIn preview</h2>
          <p>An approximate rendering for reading the whole flow. LinkedIn can change its UI and limits independently.</p>
        </div>
        <div className="sequence-device-toggle" role="group" aria-label="Preview device">
          <button className={device === 'web' ? 'active' : ''} onClick={() => setDevice('web')}><Laptop size={15} /> Web</button>
          <button className={device === 'mobile' ? 'active' : ''} onClick={() => setDevice('mobile')}><Smartphone size={15} /> Mobile</button>
        </div>
      </header>
      <div className="sequence-preview-layout">
        <aside className="card sequence-preview-controls">
          <label>
            <span>Prepared branch</span>
            <select value={branchId ?? ''} onChange={(event) => onBranchId(event.target.value || null)}>
              <option value="">Custom selection</option>
              {document.branches.map((candidate) => <option key={candidate.id} value={candidate.id}>Branch {candidate.name}</option>)}
            </select>
          </label>
          {previewSteps.map(({ step, variation }) => (
            <label key={step.id}>
              <span>{stepTitle(document, step.id)}</span>
              <select
                value={variation?.id ?? ''}
                disabled={Boolean(branch)}
                onChange={(event) => setCustom((current) => ({ ...current, [step.id]: event.target.value }))}
              >
                {step.variations.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
              </select>
            </label>
          ))}
          <div className="sequence-sample-fields">
            <strong>Sample personalization</strong>
            {Object.entries(document.sampleData).map(([key, value]) => <span key={key}><b>{`{${key}}`}</b>{value}</span>)}
          </div>
        </aside>
        <div className={`linkedin-preview ${device}`}>
          {device === 'mobile' && <div className="linkedin-phone-notch" />}
          <div className="linkedin-preview-topbar">
            <div className="linkedin-back">‹</div>
            <div className="linkedin-avatar">A</div>
            <div><strong>{document.sampleData.firstName}</strong><span>{document.sampleData.jobTitle}</span></div>
            <MoreHorizontal size={18} />
          </div>
          <div className="linkedin-preview-thread">
            <div className="linkedin-profile-chip">
              <div className="linkedin-avatar large">A</div>
              <strong>{document.sampleData.firstName}</strong>
              <span>{document.sampleData.jobTitle} at {document.sampleData.companyName}</span>
            </div>
            {previewSteps.map(({ step, variation }, index) => {
              const text = interpolateTokens(variation?.text ?? '', document.sampleData)
              if (step.kind === 'connection') {
                return (
                  <div key={step.id} className="linkedin-connection-preview">
                    <span>Connection request</span>
                    <p>{text || 'No connection note'}</p>
                    <small className={graphemeCount(variation?.text ?? '') > CONNECTION_REQUEST_WARNING_LIMIT ? 'warn' : ''}>{graphemeCount(variation?.text ?? '')} characters</small>
                  </div>
                )
              }
              return (
                <div key={step.id} className="linkedin-message-row outgoing">
                  <span className="linkedin-message-label">Message {index}</span>
                  <div className="linkedin-message-bubble">{text || <em>Empty message</em>}</div>
                  <small>10:{String(index * 3 + 8).padStart(2, '0')} AM</small>
                </div>
              )
            })}
          </div>
          <div className="linkedin-composer"><span>Write a message…</span><button>➤</button></div>
        </div>
      </div>
    </div>
  )
}

function CommentsPanel({
  document,
  comments,
  versions,
  onReply,
  onResolved,
  onRestore,
}: {
  document: SequenceDocument
  comments: SequenceCommentThread[]
  versions: SequenceVersion[]
  onReply: (threadId: string, body: string) => Promise<void>
  onResolved: (threadId: string, resolved: boolean) => Promise<void>
  onRestore: (version: SequenceVersion) => void
}) {
  const [showResolved, setShowResolved] = useState(false)
  const [replying, setReplying] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')
  const [view, setView] = useState<'comments' | 'history'>('comments')
  const visible = comments.filter((thread) => showResolved || !thread.resolved_at)

  const location = (thread: SequenceCommentThread) => {
    if (!thread.step_id) return 'Whole sequence'
    const title = stepTitle(document, thread.step_id)
    if (!thread.variation_id) return title
    const variation = document.steps.flatMap((step) => step.variations).find((item) => item.id === thread.variation_id)
    return `${title} · ${variation?.label ?? 'Moved variation'}`
  }

  return (
    <aside className="sequence-review-panel">
      <div className="sequence-review-tabs">
        <button className={view === 'comments' ? 'active' : ''} onClick={() => setView('comments')}><MessageCircle size={14} /> Comments</button>
        <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}><History size={14} /> History</button>
      </div>
      {view === 'comments' ? (
        <>
          <label className="sequence-resolved-toggle"><input type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} /> Show resolved</label>
          <div className="sequence-comment-list">
            {visible.length === 0 && <div className="sequence-panel-empty"><MessageCircle size={22} /><p>No {showResolved ? '' : 'open '}comments.</p></div>}
            {visible.map((thread) => {
              const step = document.steps.find((candidate) => candidate.id === thread.step_id)
              const variation = step?.variations.find((candidate) => candidate.id === thread.variation_id)
              const anchor = resolveCommentAnchor(variation?.text ?? '', thread.anchor)
              return (
                <article key={thread.id} className={`sequence-comment-thread ${thread.resolved_at ? 'resolved' : ''}`}>
                  <header><span>{location(thread)}</span>{thread.resolved_at && <b>Resolved</b>}</header>
                  {thread.anchor && <blockquote className={anchor?.stale ? 'stale' : ''}>{anchor?.stale ? 'Selected text was changed or removed: ' : ''}“{thread.anchor.quote}”</blockquote>}
                  <div className="sequence-comment-messages">
                    {thread.messages.map((message) => (
                      <div key={message.id}><strong>{message.author_name}</strong><p>{message.body}</p><time>{formatUpdated(message.created_at)}</time></div>
                    ))}
                  </div>
                  {replying === thread.id ? (
                    <div className="sequence-reply-box">
                      <textarea rows={2} value={replyBody} onChange={(event) => setReplyBody(event.target.value)} autoFocus />
                      <div><button className="link-btn" onClick={() => { setReplying(null); setReplyBody('') }}>Cancel</button><button className="btn sm primary" disabled={!replyBody.trim()} onClick={async () => { await onReply(thread.id, replyBody.trim()); setReplying(null); setReplyBody('') }}>Reply</button></div>
                    </div>
                  ) : (
                    <footer><button className="link-btn" onClick={() => setReplying(thread.id)}>Reply</button><button className="link-btn" onClick={() => void onResolved(thread.id, !thread.resolved_at)}>{thread.resolved_at ? 'Reopen' : 'Resolve'}</button></footer>
                  )}
                </article>
              )
            })}
          </div>
        </>
      ) : (
        <div className="sequence-version-list">
          {versions.map((version, index) => (
            <article key={version.id}>
              <span>v{version.revision}{index === 0 && <b>Current</b>}</span>
              <strong>{version.name}</strong>
              <small>{version.saved_by_name} · {formatUpdated(version.saved_at)}</small>
              {index > 0 && <button className="btn sm" onClick={() => onRestore(version)}><RotateCcw size={13} /> Restore as new version</button>}
            </article>
          ))}
        </div>
      )}
    </aside>
  )
}

const PUBLISH_ACTION_LABELS: Record<string, string> = {
  VisitAndExtract: 'Visit profile',
  Follow: 'Follow profile',
  Waiter: 'Wait',
  InvitePerson: 'Send connection request',
  FilterContactsOutOfMyNetwork: 'Wait for connection',
  MessageToPerson: 'Send message',
  CheckForReplies: 'Check for reply',
}

function publishAccountName(target: SequencePublishTarget): string {
  const value = target.account_snapshot.accountName ?? target.account_snapshot.account_name
  return typeof value === 'string' && value.trim() ? value.trim() : 'Account unavailable'
}

export function PublishWizard({
  sequence,
  document,
  onClose,
  onCreated,
}: {
  sequence: SequenceRecord
  document: SequenceDocument
  onClose: () => void
  onCreated: (job: SequencePublishJob) => void
}) {
  const toast = useToast()
  const [targets, setTargets] = useState<SequencePublishTarget[]>([])
  const [targetId, setTargetId] = useState('')
  const [branchIds, setBranchIds] = useState<string[]>(document.branches.map((branch) => branch.id))
  const [visit, setVisit] = useState(false)
  const [follow, setFollow] = useState(false)
  const [preInviteDelay, setPreInviteDelay] = useState('')
  const [inviteDelay, setInviteDelay] = useState('24')
  const [messageDelays, setMessageDelays] = useState<string[]>(() => document.steps.slice(2).map(() => '24'))
  const [loadingTargets, setLoadingTargets] = useState(true)
  const [targetsError, setTargetsError] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState(1)
  const [furthestStep, setFurthestStep] = useState(1)

  const loadTargets = useCallback(() => {
    setLoadingTargets(true)
    setTargetsError('')
    void listSequencePublishTargets().then((items) => {
      setTargets(items)
      const first = items.find((item) => item.compatible && normalizeVerifiedAccountSnapshot(item.account_snapshot, {
        instanceId: item.instance_id,
        machineKey: item.machine_key,
      }))
      setTargetId((current) => current || first?.instance_id || '')
    }).catch((error) => {
      const message = error instanceof Error ? error.message : 'Could not load publishing targets.'
      setTargetsError(message)
    }).finally(() => setLoadingTargets(false))
  }, [])

  useEffect(() => { loadTargets() }, [loadTargets])

  useEffect(() => {
    setMessageDelays((current) => document.steps.slice(2).map((_, index) => current[index] ?? '24'))
  }, [document.steps.length])

  const target = targets.find((item) => item.instance_id === targetId)
  const account = target && normalizeVerifiedAccountSnapshot(target.account_snapshot, {
    instanceId: target.instance_id,
    machineKey: target.machine_key,
  })
  const options: SequencePublishOptions = {
    branchIds,
    visit,
    follow,
    preInviteDelayHours: preInviteDelay === '' ? undefined : Number(preInviteDelay),
    inviteToFirstMessageDelayHours: inviteDelay === '' ? undefined : Number(inviteDelay),
    interMessageDelayHours: messageDelays.map(Number),
  }
  let preview: ReturnType<typeof compileSequenceCampaigns> = []
  let previewError = ''
  if (account) {
    try { preview = compileSequenceCampaigns(sequence.name, document, options, account) } catch (error) { previewError = error instanceof Error ? error.message : 'Preview is invalid.' }
  }
  const goToStep = (next: number) => {
    setStep(next)
    setFurthestStep((current) => Math.max(current, next))
  }
  const allBranchesSelected = document.branches.length > 0 && branchIds.length === document.branches.length
  const unavailableTargets = targets.filter((item) => !item.compatible || !normalizeVerifiedAccountSnapshot(item.account_snapshot, {
    instanceId: item.instance_id,
    machineKey: item.machine_key,
  }))
  const submit = async () => {
    if (!target || !account || previewError) return
    setBusy(true)
    try {
      const job = await createSequencePublishJob({
        sequenceId: sequence.id,
        targetInstanceId: target.instance_id,
        idempotencyKey: `sequence-publish-${crypto.randomUUID()}`,
        options: options as unknown as Record<string, unknown>,
      })
      onCreated(job)
      toast.success('Paused campaign creation queued.')
      onClose()
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not queue publishing.') } finally { setBusy(false) }
  }
  return (
    <div className="pipe-modal-overlay sequence-publish-overlay" onClick={() => { if (!busy) onClose() }}>
      <div className="pipe-modal sequence-publish-modal" role="dialog" aria-modal="true" aria-labelledby="sequence-publish-title" onClick={(event) => event.stopPropagation()}>
        <header className="sequence-publish-head">
          <div className="sequence-publish-head-icon"><Send size={19} /></div>
          <div>
            <span className="eyebrow">Linked Helper</span>
            <h2 id="sequence-publish-title">Publish campaign</h2>
            <p>{sequence.name} · revision {sequence.revision}</p>
          </div>
          <button className="conv-close" onClick={onClose} disabled={busy} aria-label="Close publish campaign"><X size={17} /></button>
        </header>

        <ol className="sequence-publish-steps" aria-label="Publishing steps">
          {[
            { number: 1, label: 'Destination' },
            { number: 2, label: 'Setup' },
            { number: 3, label: 'Review' },
          ].map((item) => (
            <li key={item.number} className={step === item.number ? 'active' : item.number < step ? 'complete' : ''}>
              <button type="button" disabled={item.number > furthestStep} onClick={() => setStep(item.number)} aria-current={step === item.number ? 'step' : undefined}>
                <span>{item.number < step ? <Check size={13} /> : item.number}</span>
                <b>{item.label}</b>
              </button>
            </li>
          ))}
        </ol>

        <div className="sequence-publish-body">
          {step === 1 && <section className="sequence-publish-section" aria-labelledby="publish-destination-title">
            <div className="sequence-publish-section-head">
              <div><span>Step 1 of 3</span><h3 id="publish-destination-title">Where should these campaigns go?</h3><p>Choose the LinkedIn account that will own the campaigns in Linked Helper.</p></div>
            </div>
            {loadingTargets && <div className="sequence-publish-loading"><LoaderCircle size={20} /><span>Checking available accounts…</span></div>}
            {!loadingTargets && targetsError && <div className="sequence-publish-state error"><AlertCircle size={20} /><div><strong>Accounts could not be loaded</strong><p>{targetsError}</p></div><button className="btn sm" onClick={loadTargets}>Try again</button></div>}
            {!loadingTargets && !targetsError && targets.length === 0 && <div className="sequence-publish-state"><Laptop size={22} /><div><strong>No publishing destinations yet</strong><p>Open Linked Helper on an approved machine and wait for its next sync.</p></div></div>}
            {!loadingTargets && !targetsError && targets.length > 0 && <div className="sequence-publish-target-list">
              {targets.map((item) => {
                const normalized = normalizeVerifiedAccountSnapshot(item.account_snapshot, { instanceId: item.instance_id, machineKey: item.machine_key })
                const available = item.compatible && Boolean(normalized)
                const selected = item.instance_id === targetId
                return <label key={item.instance_id} className={`sequence-publish-target ${selected ? 'selected' : ''} ${!available ? 'unavailable' : ''}`}>
                  <input type="radio" name="publish-target" value={item.instance_id} checked={selected} disabled={!available} onChange={() => setTargetId(item.instance_id)} />
                  <span className="sequence-publish-target-avatar">{publishAccountName(item).slice(0, 1).toUpperCase()}</span>
                  <span className="sequence-publish-target-copy">
                    <strong>{publishAccountName(item)}</strong>
                    <small>{item.machine_key} · {item.instance_id}</small>
                  </span>
                  <span className={`sequence-publish-readiness ${available ? 'ready' : ''}`}>{available ? <><CheckCircle2 size={13} /> Ready</> : <><AlertCircle size={13} /> Not ready</>}</span>
                  {!available && <small className="sequence-publish-target-error">{item.compatibility_error_code ? item.compatibility_error_code.split('_').join(' ') : 'Account details could not be verified'}</small>}
                </label>
              })}
            </div>}
            {unavailableTargets.length > 0 && <p className="sequence-publish-help"><ShieldCheck size={14} /> Unavailable machines stay visible so you know why they cannot receive a campaign.</p>}
          </section>}

          {step === 2 && <section className="sequence-publish-section" aria-labelledby="publish-setup-title">
            <div className="sequence-publish-section-head with-action">
              <div><span>Step 2 of 3</span><h3 id="publish-setup-title">Choose branches and timing</h3><p>Each selected branch becomes a separate paused campaign.</p></div>
              <button className="link-btn" onClick={() => setBranchIds(allBranchesSelected ? [] : document.branches.map((branch) => branch.id))}>{allBranchesSelected ? 'Clear all' : 'Select all'}</button>
            </div>
            <div className="sequence-publish-branch-list">
              {document.branches.length === 0 && <div className="sequence-publish-no-branches"><Split size={18} /><span>No branches configured yet. Add a branch in the Branches tab before publishing.</span></div>}
              {document.branches.map((branch, index) => {
                const checked = branchIds.includes(branch.id)
                return <label key={branch.id} className={checked ? 'selected' : ''}>
                  <input type="checkbox" checked={checked} onChange={(event) => setBranchIds((current) => event.target.checked ? [...current, branch.id] : current.filter((id) => id !== branch.id))} />
                  <span className="sequence-publish-branch-letter">{String.fromCharCode(65 + index)}</span>
                  <span><strong>{branch.name}</strong><small>{sequence.name} {String.fromCharCode(65 + index)}</small></span>
                  <Check size={15} />
                </label>
              })}
            </div>
            <div className="sequence-publish-config-grid">
              <div className="sequence-publish-config-card">
                <div className="sequence-publish-config-title"><Laptop size={16} /><div><strong>Profile actions</strong><small>Optional actions before the invite</small></div></div>
                <label className="sequence-publish-switch"><span><strong>Visit profile</strong><small>Open and extract the profile first</small></span><input type="checkbox" checked={visit} onChange={(event) => setVisit(event.target.checked)} /><i /></label>
                <label className="sequence-publish-switch"><span><strong>Follow profile</strong><small>Follow before sending the invite</small></span><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /><i /></label>
              </div>
              <div className="sequence-publish-config-card">
                <div className="sequence-publish-config-title"><Clock3 size={16} /><div><strong>Timing</strong><small>Hours between campaign actions</small></div></div>
                <label className="sequence-publish-delay"><span><strong>Before connection request</strong><small>Optional</small></span><input aria-label="Hours before connection request" type="number" min="1" max="720" placeholder="None" value={preInviteDelay} onChange={(event) => setPreInviteDelay(event.target.value)} /><b>hours</b></label>
                <label className="sequence-publish-delay"><span><strong>After connection</strong><small>Before Message 1</small></span><input aria-label="Hours after connection" type="number" min="1" max="720" value={inviteDelay} onChange={(event) => setInviteDelay(event.target.value)} /><b>hours</b></label>
                {messageDelays.map((value, index) => <label key={index} className="sequence-publish-delay"><span><strong>After Message {index + 1}</strong><small>Before Message {index + 2}</small></span><input aria-label={`Hours after message ${index + 1}`} type="number" min="1" max="720" value={value} onChange={(event) => setMessageDelays((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} /><b>hours</b></label>)}
              </div>
            </div>
            {previewError && <div className="sequence-publish-validation"><AlertCircle size={15} /><span>{previewError}</span></div>}
          </section>}

          {step === 3 && <section className="sequence-publish-section" aria-labelledby="publish-review-title">
            <div className="sequence-publish-section-head">
              <div><span>Step 3 of 3</span><h3 id="publish-review-title">Review before publishing</h3><p>Confirm the destination and campaign flow. This snapshot will not change if the sequence is edited later.</p></div>
            </div>
            <div className="sequence-publish-summary">
              <div><span>Destination</span><strong>{account?.accountName}</strong><small>{target?.machine_key}</small></div>
              <div><span>Campaigns</span><strong>{preview.length}</strong><small>{branchIds.length} selected {branchIds.length === 1 ? 'branch' : 'branches'}</small></div>
              <div><span>Sequence version</span><strong>Revision {sequence.revision}</strong><small>Immutable snapshot</small></div>
            </div>
            {previewError ? <div className="sequence-publish-state error"><AlertCircle size={20} /><div><strong>Preview needs attention</strong><p>{previewError}</p></div></div> : <div className="sequence-publish-preview-list">
              {preview.map((campaign) => <article key={campaign.branchId} className="sequence-publish-preview">
                <div className="sequence-publish-preview-head"><span>{campaign.branchLetter}</span><div><strong>{campaign.campaignName}</strong><small>{campaign.actions.length} campaign actions</small></div><CheckCircle2 size={17} /></div>
                <div className="sequence-publish-action-flow">{campaign.actions.map((action, index) => <span key={`${action.type}-${index}`}>{PUBLISH_ACTION_LABELS[action.type] ?? action.type}</span>)}</div>
              </article>)}
            </div>}
            <div className="sequence-publish-safety"><ShieldCheck size={18} /><div><strong>Safe by default</strong><p>Campaigns are created empty and paused. Nothing is sent on LinkedIn until someone adds leads and starts a campaign in Linked Helper.</p></div></div>
          </section>}
        </div>

        <footer className="sequence-publish-footer">
          <span>{step === 2 ? `${branchIds.length} of ${document.branches.length} branches selected` : step === 3 ? `${preview.length} paused ${preview.length === 1 ? 'campaign' : 'campaigns'} will be queued` : 'No changes are made until the final step'}</span>
          <div>
            {step === 1 ? <button className="btn" onClick={onClose}>Cancel</button> : <button className="btn" onClick={() => setStep(step - 1)} disabled={busy}>Back</button>}
            {step < 3 ? <button className="btn primary" disabled={step === 1 ? !target?.compatible || !account : !branchIds.length || Boolean(previewError)} onClick={() => goToStep(step + 1)}>Continue <ChevronRight size={14} /></button> : <button className="btn primary sequence-publish-submit" disabled={busy || !preview.length || Boolean(previewError)} onClick={() => void submit()}>{busy ? <><LoaderCircle size={14} /> Queueing…</> : <><Send size={14} /> Queue {preview.length} paused {preview.length === 1 ? 'campaign' : 'campaigns'}</>}</button>}
          </div>
        </footer>
      </div>
    </div>
  )
}

function SequenceEditor({ id }: { id: string }) {
  const navigate = useNavigate()
  const toast = useToast()
  const { isAdmin } = useAuth()
  const [detail, setDetail] = useState<SequenceDetail | null>(null)
  const [name, setName] = useState('')
  const [document, setDocument] = useState<SequenceDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<EditorTab>('build')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [conflict, setConflict] = useState<SequenceRecord | null>(null)
  const [commentTarget, setCommentTarget] = useState<CommentTarget | null>(null)
  const [commentBusy, setCommentBusy] = useState(false)
  const [selections, setSelections] = useState<Record<string, { start: number; end: number }>>({})
  const [previewBranch, setPreviewBranch] = useState<string | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishJobs, setPublishJobs] = useState<SequencePublishJob[]>([])
  const lastSavedRef = useRef('')
  const draftKeyRef = useRef('')
  const savingRef = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await getSequence(id)
      setDetail(next)
      setName(next.sequence.name)
      setDocument(next.sequence.document)
      lastSavedRef.current = JSON.stringify({ name: next.sequence.name, document: next.sequence.document })
      setSaveState('saved')
      setConflict(null)
      if (isAdmin) void listSequencePublishJobs(id).then(setPublishJobs).catch(() => undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load sequence.')
    } finally {
      setLoading(false)
    }
  }, [id, isAdmin])

  useEffect(() => { void load() }, [load])

  const draftKey = useMemo(() => document ? JSON.stringify({ name: name.trim() || 'Untitled sequence', document }) : '', [name, document])
  draftKeyRef.current = draftKey

  useEffect(() => {
    if (!detail || !document || !draftKey || draftKey === lastSavedRef.current || conflict || savingRef.current) return
    setSaveState('dirty')
    const timer = window.setTimeout(async () => {
      savingRef.current = true
      setSaveState('saving')
      const payloadKey = draftKey
      try {
        const saved = await saveSequence({
          id: detail.sequence.id,
          expectedRevision: detail.sequence.revision,
          name: name.trim() || 'Untitled sequence',
          document,
        })
        lastSavedRef.current = payloadKey
        savingRef.current = false
        setDetail((current) => current ? {
          ...current,
          sequence: saved,
          versions: [{
            id: -saved.revision,
            sequence_id: saved.id,
            revision: saved.revision,
            name: saved.name,
            document: saved.document,
            saved_by: saved.updated_by,
            saved_by_name: saved.updated_by_name,
            saved_at: saved.updated_at,
          }, ...current.versions.filter((version) => version.revision !== saved.revision)],
        } : current)
        setSaveState(payloadKey === draftKeyRef.current ? 'saved' : 'dirty')
      } catch (cause) {
        savingRef.current = false
        if (cause instanceof SequenceBuilderApiError && cause.status === 409) {
          setConflict(cause.current)
          setSaveState('conflict')
        } else {
          setSaveState('error')
          toast.error(cause instanceof Error ? cause.message : 'Autosave failed.')
        }
      }
    }, 900)
    return () => window.clearTimeout(timer)
  }, [conflict, detail?.sequence.id, detail?.sequence.revision, document, draftKey, name, toast])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draftKey !== lastSavedRef.current) event.preventDefault()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [draftKey])

  const updateDocument = (next: SequenceDocument) => {
    setDocument(repairBranches(next))
    if (saveState !== 'conflict') setSaveState('dirty')
  }

  const refreshReview = async () => {
    const next = await getSequence(id)
    setDetail((current) => current ? { ...current, comments: next.comments, versions: next.versions } : next)
  }

  const submitComment = async (body: string) => {
    if (!commentTarget) return
    setCommentBusy(true)
    try {
      await createSequenceComment({
        sequenceId: id,
        stepId: commentTarget.stepId,
        variationId: commentTarget.variationId,
        anchor: commentTarget.anchor,
        body,
      })
      await refreshReview()
      setCommentTarget(null)
      toast.success('Comment added.')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not add comment.')
    } finally {
      setCommentBusy(false)
    }
  }

  if (loading) return <div className="sequence-editor-loading"><div className="sequence-card sequence-card-skeleton" /></div>
  if (error || !detail || !document) return <div className="card sequence-empty-state"><h2>Could not open sequence</h2><p>{error ?? 'Unknown sequence.'}</p><button className="btn" onClick={() => navigate('/sequences')}>Back to sequences</button></div>

  return (
    <div className="sequence-editor-page">
      <header className="sequence-editor-topbar">
        <button className="icon-only-btn" onClick={() => navigate('/sequences')} aria-label="Back to sequences"><ArrowLeft size={18} /></button>
        <div className="sequence-name-field">
          <input value={name} onChange={(event) => setName(event.target.value)} aria-label="Sequence name" />
          <span>Edited by {detail.sequence.updated_by_name}</span>
        </div>
        <SaveIndicator state={saveState} />
        <button className="btn" onClick={() => setCommentTarget({ stepId: null, variationId: null, anchor: null, label: 'Whole sequence' })}><MessageCircle size={14} /> Comment</button>
        <button className="btn primary" onClick={() => setTab('preview')}><Eye size={14} /> Preview</button>
        {isAdmin && <button className="btn" disabled={saveState !== 'saved'} title={saveState === 'saved' ? 'Publish this saved sequence' : 'Wait for the latest changes to save'} onClick={() => setPublishOpen(true)}><Laptop size={14} /> Publish</button>}
      </header>

      {conflict && (
        <div className="sequence-conflict-banner">
          <div><strong>This sequence changed in another session.</strong><span>Your local draft has not been overwritten. Load the newer saved version before continuing.</span></div>
          <button className="btn" onClick={() => void load()}>Load newer version</button>
        </div>
      )}

      {isAdmin && publishJobs.length > 0 && (
        <section className={`sequence-publish-job-strip ${publishJobs[0].status}`} aria-label="Latest campaign publishing status">
          <span className="sequence-publish-job-icon">{publishJobs[0].status === 'success' ? <CheckCircle2 size={17} /> : ['partial_failure', 'conflict', 'failed'].includes(publishJobs[0].status) ? <AlertCircle size={17} /> : <LoaderCircle size={17} />}</span>
          <div><strong>{publishStatusLabel(publishJobs[0].status)}</strong><small>{publishJobs[0].target_machine_key} · revision {publishJobs[0].sequence_revision}</small></div>
          <span>{publishJobs[0].branches.length} {publishJobs[0].branches.length === 1 ? 'campaign' : 'campaigns'}</span>
        </section>
      )}

      <nav className="sequence-editor-tabs" aria-label="Sequence Builder sections">
        <button className={tab === 'build' ? 'active' : ''} onClick={() => setTab('build')}><MessageCircle size={15} /> Build</button>
        <button className={tab === 'branches' ? 'active' : ''} onClick={() => setTab('branches')}><Split size={15} /> Branches <span>{document.branches.length}</span></button>
        <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}><Eye size={15} /> Preview</button>
      </nav>

      <div className="sequence-editor-body">
        <main className="sequence-editor-canvas">
          {tab === 'build' && (
            <BuildCanvas
              document={document}
              comments={detail.comments}
              selections={selections}
              onSelection={(key, selection) => setSelections((current) => ({ ...current, [key]: selection }))}
              onDocument={updateDocument}
              onComment={setCommentTarget}
            />
          )}
          {tab === 'branches' && (
            <BranchBuilder
              document={document}
              onDocument={updateDocument}
              onPreview={(branchId) => { setPreviewBranch(branchId); setTab('preview') }}
            />
          )}
          {tab === 'preview' && <PreviewPanel document={document} branchId={previewBranch} onBranchId={setPreviewBranch} />}
        </main>
        <CommentsPanel
          document={document}
          comments={detail.comments}
          versions={detail.versions}
          onReply={async (threadId, body) => { await replySequenceComment(threadId, body); await refreshReview() }}
          onResolved={async (threadId, resolved) => { await setSequenceCommentResolved(threadId, resolved); await refreshReview() }}
          onRestore={(version) => { setName(version.name); updateDocument(version.document); toast.success(`Revision ${version.revision} loaded as a draft.`) }}
        />
      </div>

      {commentTarget && <CommentComposer target={commentTarget} busy={commentBusy} onClose={() => setCommentTarget(null)} onSubmit={(body) => void submitComment(body)} />}
      {publishOpen && <PublishWizard sequence={detail.sequence} document={document} onClose={() => setPublishOpen(false)} onCreated={(job) => setPublishJobs((current) => [job, ...current])} />}
    </div>
  )
}

export function SequenceBuilder() {
  const { id } = useParams<{ id?: string }>()
  return id ? <SequenceEditor id={id} /> : <SequenceLibrary />
}
