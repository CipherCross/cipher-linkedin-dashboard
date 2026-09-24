import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
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
  PanelRight,
  LoaderCircle,
  MessageCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Filter,
  SearchX,
  Send,
  ShieldCheck,
  Smartphone,
  Split,
  Trash2,
  UserRoundPlus,
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
  publishStatusTone,
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
import {
  Badge, Button, Checkbox, Dialog, EmptyState, FilterCount, FilterDialog, IconButton, InlineError,
  Input, LinkButton, PageHeader, Panel, SaveStatus, SectionHeader, SegmentedControl, Select,
  SelectField, Table, TableFrame, Tabs, TextField, Textarea, TextareaField, Toolbar,
  type SaveState,
} from '../ui'

type EditorTab = 'build' | 'branches' | 'preview'
type PreviewDevice = 'web' | 'mobile'

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

type DeploymentFilters = {
  notebook: string
  runtime: 'any' | CampaignRuntimeStatus | 'unknown'
  archive: 'current' | 'all' | 'archived'
  source: string
  freshness: 'any' | 'fresh' | 'stale' | 'unsupported'
}

const DEFAULT_DEPLOYMENT_FILTERS: DeploymentFilters = {
  notebook: 'any', runtime: 'any', archive: 'current', source: 'any', freshness: 'any',
}

/* Archive defaults to "current", so it only counts as engaged when moved. */
function deploymentFilterCount(filters: DeploymentFilters): number {
  return (Object.keys(DEFAULT_DEPLOYMENT_FILTERS) as Array<keyof DeploymentFilters>)
    .filter((key) => filters[key] !== DEFAULT_DEPLOYMENT_FILTERS[key]).length
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
  // Applied filters drive the table; the overlay edits a draft that only
  // replaces them on Apply, so Cancel/Escape leave the table untouched.
  const [filters, setFilters] = useState<DeploymentFilters>(DEFAULT_DEPLOYMENT_FILTERS)
  const [filterDraft, setFilterDraft] = useState<DeploymentFilters | null>(null)
  const [creating, setCreating] = useState(false)
  const appliedFilterCount = deploymentFilterCount(filters)

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
        if (filters.notebook !== 'any' && deployment.instance_id !== filters.notebook) return false
        const runtime = parseCampaignRuntimeStatus(deployment.runtime_status) ?? 'unknown'
        if (filters.runtime !== 'any' && runtime !== filters.runtime) return false
        if (filters.archive === 'current' && deployment.is_archived !== false) return false
        if (filters.archive === 'archived' && deployment.is_archived !== true) return false
        if (filters.source !== 'any' && deployment.status_source !== filters.source) return false
        const health = campaignObservationHealth(deployment)
        if (filters.freshness === 'fresh' && health !== 'fresh') return false
        if (filters.freshness === 'stale' && health !== 'stale') return false
        if (filters.freshness === 'unsupported' && !['unsupported', 'awaiting_first_sync'].includes(health)) return false
        if (needle && !`${item.name} ${deployment.campaign_name} ${deployment.account_name ?? ''} ${deployment.instance_id}`.toLowerCase().includes(needle)) return false
        return true
      })
      return { item, deployments: filtered }
    }).filter((group) => group.deployments.length > 0)
  }, [hub, query, filters])

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

  const totalDeployments = hub?.items.reduce((count, item) => count + item.deployments.length, 0) ?? 0
  const currentCount = items.filter((item) => !item.archived).length
  const archivedCount = items.length - currentCount

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

  const setDraft = <K extends keyof DeploymentFilters>(key: K, value: DeploymentFilters[K]) =>
    setFilterDraft((current) => current && { ...current, [key]: value })

  return (
    <div className="sequence-library">
      <PageHeader
        title="Sequences"
        description="The last observed Linked Helper state on every notebook. Runtime, publishing and sync health stay separate readings."
        actions={
          <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={create} loading={creating} loadingLabel="Creating a sequence">
            New sequence
          </Button>
        }
      />

      <Toolbar>
        <TextField
          className="ui-toolbar__search"
          label={view === 'deployments' ? 'Search deployments' : 'Search sequences'}
          labelHidden
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={view === 'deployments' ? 'Search sequences, campaigns or notebooks' : 'Search sequences'}
        />
        <div className="ui-toolbar__spacer" />
        {view === 'deployments' && (
          <Button variant="secondary" icon={<Filter size={18} aria-hidden="true" />} onClick={() => setFilterDraft(filters)}>
            Filters<FilterCount count={appliedFilterCount} />
          </Button>
        )}
      </Toolbar>

      <Tabs
        label="Sequences section"
        value={view}
        onChange={(next) => setView(next as typeof view)}
        items={[
          { id: 'deployments', label: 'Deployments', count: totalDeployments },
          { id: 'build', label: 'Build', count: currentCount },
        ]}
      />

      {view === 'deployments' && filterDraft && (
        <FilterDialog
          title="Deployment filters"
          selectedCount={deploymentFilterCount(filterDraft)}
          onClearAll={() => setFilterDraft(DEFAULT_DEPLOYMENT_FILTERS)}
          onCancel={() => setFilterDraft(null)}
          onApply={() => { setFilters(filterDraft); setFilterDraft(null) }}
        >
          <div className="flex flex-col gap-app-lg">
            <SelectField label="Notebook" value={filterDraft.notebook} onChange={(event) => setDraft('notebook', event.target.value)}>
              <option value="any">All notebooks</option>
              {notebookOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </SelectField>
            <SelectField label="Runtime" value={filterDraft.runtime} onChange={(event) => setDraft('runtime', event.target.value as DeploymentFilters['runtime'])}>
              <option value="any">All statuses</option>
              {CAMPAIGN_RUNTIME_STATUSES.map((status) => <option key={status} value={status}>{campaignRuntimeLabel(status)}</option>)}
              <option value="unknown">Unknown</option>
            </SelectField>
            <SelectField label="Archive" value={filterDraft.archive} onChange={(event) => setDraft('archive', event.target.value as DeploymentFilters['archive'])}>
              <option value="current">Current</option>
              <option value="all">All</option>
              <option value="archived">Archived</option>
            </SelectField>
            <SelectField label="Observation" value={filterDraft.freshness} onChange={(event) => setDraft('freshness', event.target.value as DeploymentFilters['freshness'])}>
              <option value="any">Any freshness</option>
              <option value="fresh">Fresh</option>
              <option value="stale">Stale</option>
              <option value="unsupported">Unsupported / waiting</option>
            </SelectField>
            {/* Where a status reading came from is diagnostic, not a filter an
                SDR reaches for; it stays available, one disclosure down. */}
            <details className="deployment-advanced">
              <summary>Advanced diagnostics</summary>
              <SelectField label="Status source" value={filterDraft.source} onChange={(event) => setDraft('source', event.target.value)}>
                <option value="any">All sources</option>
                {sourceOptions.map((source) => <option key={source} value={source}>{source}</option>)}
              </SelectField>
            </details>
          </div>
        </FilterDialog>
      )}

      {loading ? (
        <div className="sequence-card-grid" role="status" aria-label="Loading sequences">
          {[0, 1, 2].map((key) => <div key={key} className="sequence-card min-h-[300px] [background:linear-gradient(90deg,var(--surface-1),var(--surface-2),var(--surface-1))] [background-size:200%_100%] animate-[sequence-shimmer_1.4s_infinite]" />)}
        </div>
      ) : view === 'deployments' ? (
        hubError ? (
          <InlineError title="Deployments are not available." detail={hubError} onRetry={() => void load()} />
        ) : deployments.length === 0 ? (
          <Panel>
            {totalDeployments > 0 ? (
              <EmptyState
                kind="no-match"
                icon={SearchX}
                title="No deployments match these filters"
                hint="Set Archive to All to include campaigns whose archive membership is still unknown."
                action={(appliedFilterCount > 0 || query) && (
                  <Button variant="secondary" onClick={() => { setFilters(DEFAULT_DEPLOYMENT_FILTERS); setQuery('') }}>Clear filters</Button>
                )}
              />
            ) : (
              <EmptyState icon={Split} title="No deployments yet" hint="Campaigns appear here after a notebook syncs them." />
            )}
          </Panel>
        ) : (
          /* One table, one header row, a banner row per sequence. Every group
             used to be its own card repeating the same six column headers, so
             a 1280px window showed about two of sixty-six deployments. */
          <TableFrame className="mb-app-xl" scrollLabel="Deployments">
            <Table className="deployment-table" caption="Deployments by sequence">
              <thead><tr>
                <th scope="col">Campaign / notebook</th><th scope="col">Linked Helper runtime</th><th scope="col">Publish</th>
                <th scope="col" className="ui-table__num">Leads</th><th scope="col" className="ui-table__num">Replies</th><th scope="col">Sync</th>
              </tr></thead>
              {deployments.map(({ item, deployments: rows }) => (
                <tbody key={item.id}>
                  <tr className="deployment-group-row">
                    <th colSpan={6} scope="colgroup">
                      <div className="deployment-group-head">
                        <div>
                          <span className="flex items-center gap-1.5 text-app-accent text-[length:var(--text-2xs)] font-[750] tracking-[var(--tracking-caps)] uppercase">{item.kind === 'managed' ? 'Sequence Builder' : 'External Linked Helper'}</span>
                          <span className="text-[length:var(--text-subsection)] font-semibold" id={`deployment-${item.id}`}>{item.name}</span>
                          <span className="text-app-text-muted text-app-meta">{rows.length} campaign{rows.length === 1 ? '' : 's'}</span>
                        </div>
                        {item.sequence_document_id && (
                          <LinkButton
                            variant="ghost"
                            size="sm"
                            to={`/sequences/${encodeURIComponent(item.sequence_document_id)}`}
                            aria-label={`Open ${item.name} in the builder`}
                          >
                            Open builder <ChevronRight size={16} aria-hidden="true" />
                          </LinkButton>
                        )}
                      </div>
                    </th>
                  </tr>
                  {rows.map((deployment) => (
                    <tr key={deployment.key}>
                      <td>
                        <div>{deployment.campaign_id
                          ? <Link className="text-app-text no-underline hover:text-app-accent hover:underline" to={`/campaign/${encodeURIComponent(deployment.campaign_id)}`}>{deployment.campaign_name}</Link>
                          : <span>{deployment.campaign_name}</span>}</div>
                        <span className="text-app-text-muted text-app-meta">{deployment.account_name ?? deployment.instance_id} · {deployment.instance_id}</span>
                      </td>
                      <td><CampaignRuntimeStatusView campaign={deployment} compact /></td>
                      <td>{deployment.publish_status ? <>
                        <Badge tone={publishStatusTone(deployment.publish_status)}>{publishStatusLabel(deployment.publish_status)}</Badge>
                        {deployment.awaiting_sync && <div className="text-app-text-muted text-app-meta">Awaiting campaign sync</div>}
                      </> : <span className="text-app-text-muted text-app-meta">External campaign</span>}</td>
                      <td className="ui-table__num">{num(deployment.leads)}</td><td className="ui-table__num">{num(deployment.replies)}</td>
                      <td className="text-app-text-muted text-app-meta">{deployment.last_sync_at ? ago(deployment.last_sync_at) : 'Never synced'}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </Table>
          </TableFrame>
        )
      ) : error ? (
        <InlineError title="Sequence Builder is not available." detail={error} onRetry={() => void load()} />
      ) : (
        <>
          <SegmentedControl
            className="mb-app-lg"
            label="Builder sequence status"
            value={showArchived ? 'archived' : 'current'}
            onChange={(next) => setShowArchived(next === 'archived')}
            items={[
              { id: 'current', label: 'Current', count: currentCount },
              { id: 'archived', label: 'Archived', count: archivedCount },
            ]}
          />
          {visible.length === 0 ? (
            <Panel>
              <EmptyState
                kind={query ? 'no-match' : 'empty'}
                icon={query ? SearchX : MessageSquarePlus}
                title={query ? 'No matching sequences' : showArchived ? 'No archived sequences' : 'Start with a blank canvas'}
                hint={query ? 'Try another name or message fragment.' : 'Connection request, follow-ups and variations all stay together.'}
                action={query
                  ? <Button variant="secondary" onClick={() => setQuery('')}>Clear search</Button>
                  : !showArchived && <Button variant="primary" icon={<Plus size={18} aria-hidden="true" />} onClick={create} loading={creating} loadingLabel="Creating a sequence">New sequence</Button>}
              />
            </Panel>
          ) : (
            <div className="sequence-card-grid">
              {visible.map((item) => {
                const counts = sequenceCounts(item)
                return (
                  // The title link is the keyboard and screen-reader path; the
                  // card click is a pointer convenience for the same URL.
                  <article key={item.id} className="sequence-card" onClick={() => navigate(`/sequences/${item.id}`)}>
                    <div className="flex items-center justify-between">
                      <div className="size-[38px] grid place-items-center rounded-[11px] text-app-accent bg-app-accent-subtle border border-app-accent-border" aria-hidden="true"><Split size={19} /></div>
                      <IconButton
                        label={item.archived ? `Restore ${item.name}` : `Archive ${item.name}`}
                        icon={item.archived ? <ArchiveRestore size={20} aria-hidden="true" /> : <Archive size={20} aria-hidden="true" />}
                        onClick={(event) => void archive(event, item)}
                      />
                    </div>
                    <h2>
                      <Link
                        className="text-app-text no-underline hover:text-app-accent focus-visible:outline-none"
                        to={`/sequences/${item.id}`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {item.name}
                      </Link>
                    </h2>
                    <p className="line-clamp-2 min-h-[42px] m-0 text-app-text-secondary text-[length:var(--text-sm)] leading-[1.55]">{sequencePreviewText(item)}</p>
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
                      <span><Clock3 size={12} aria-hidden="true" /> {formatUpdated(item.updated_at)}</span>
                      <ChevronRight size={16} aria-hidden="true" />
                    </footer>
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SortableStepShell({ step, children }: { step: SequenceStep; children: (handle: ReactNode) => ReactNode }) {
  const sortable = useSortable({ id: step.id, data: { type: 'step', stepId: step.id }, disabled: step.kind === 'connection' })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0.45 : 1,
  }
  const handle = (
    <IconButton
      label="Drag message step"
      icon={<GripVertical size={17} aria-hidden="true" />}
      disabled={step.kind === 'connection'}
      className="cursor-grab touch-none"
      {...sortable.attributes}
      {...sortable.listeners}
    />
  )
  return <section ref={sortable.setNodeRef} style={style} className="border border-app-border rounded-[15px] bg-app-surface [box-shadow:var(--shadow-sm)] overflow-hidden">{children(handle)}</section>
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
    <IconButton
      label="Drag variation"
      icon={<GripVertical size={15} aria-hidden="true" />}
      className="cursor-grab touch-none"
      {...sortable.attributes}
      {...sortable.listeners}
    />
  )
  return <article ref={sortable.setNodeRef} style={style} className="min-w-0 p-2.5 border border-app-border rounded-[12px] bg-app-surface-2">{children(handle)}</article>
}

export function CommentComposer({
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
    <Dialog
      title="Add comment"
      description={target.label}
      size="sm"
      onRequestClose={onClose}
      busy={busy}
      busyMessage="Adding the comment — wait for it to finish before closing."
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} loadingLabel="Adding…" disabled={!body.trim()} onClick={() => onSubmit(body.trim())}>Add comment</Button>
      </>}
    >
      {target.anchor && (
        <blockquote className="mt-2 mb-3 px-[11px] py-[9px] border-l-[3px] border-app-accent rounded-r-[6px] bg-app-accent-subtle text-app-text-secondary">
          “{target.anchor.quote}”
        </blockquote>
      )}
      <TextareaField
        label="Comment"
        rows={4}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="What should change, or what do you want the team to consider?"
      />
    </Dialog>
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
        <Input
          className="min-h-control-sm"
          value={variation.label}
          onChange={(event) => onDocument(updateVariation(document, step.id, variation.id, { label: event.target.value }))}
          aria-label="Variation name"
        />
        <span className="flex items-center gap-[3px] text-app-text-muted text-[length:var(--text-meta)]"><MessageCircle size={13} aria-hidden="true" /> {relevant.length}</span>
        <IconButton
          tone="danger"
          label="Remove variation"
          icon={<Trash2 size={14} aria-hidden="true" />}
          onClick={() => onDocument(removeVariation(document, step.id, variation.id))}
        />
      </header>
      <div className="sequence-text-tools">
        {PERSONALIZATION_TOKENS.map((token) => (
          <Button key={token} size="sm" variant="secondary" className="font-normal" onClick={() => insertText(token)}>{token}</Button>
        ))}
        <span className="inline-flex gap-app-xs ml-auto">
          {['😊', '👋', '🚀', '💡'].map((emoji) => <Button key={emoji} size="sm" variant="secondary" className="font-normal" onClick={() => insertText(emoji)}>{emoji}</Button>)}
        </span>
      </div>
      <Textarea
        ref={textareaRef}
        className="w-full min-h-[220px] resize-y leading-[1.6] bg-app-surface"
        value={variation.text}
        onChange={(event) => onDocument(updateVariation(document, step.id, variation.id, { text: event.target.value }))}
        onSelect={captureSelection}
        onKeyUp={captureSelection}
        onMouseUp={captureSelection}
        placeholder={step.kind === 'connection' ? 'Connection note can be empty…' : 'Write this variation…'}
        rows={7}
        aria-label="Variation text"
      />
      <div className="flex items-center justify-between pt-[5px]">
        <Button variant="ghost" size="sm" onClick={addSelectionComment}>
          <MessageCircle size={13} aria-hidden="true" />
          {selection && selection.end > selection.start ? 'Comment on selection' : 'Comment'}
        </Button>
        <span className={overLimit ? 'text-app-warning text-[length:var(--text-2xs)] font-bold' : 'text-app-text-muted'}>{count}{step.kind === 'connection' ? ` / ${CONNECTION_REQUEST_WARNING_LIMIT}` : ''}</span>
      </div>
      {overLimit && <p className="[margin:5px_0_0] text-app-warning text-[length:var(--text-meta)]">LinkedIn may reject this connection note. This is a warning only.</p>}
      {anchors.length > 0 && (
        <div className="sequence-commented-copy" aria-label="Commented text preview">
          {highlighted.map((part, index) => part.highlighted ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}
        </div>
      )}
      <label className="sequence-move-variation">
        <span className="whitespace-nowrap">Move to</span>
        <Select
          value={step.id}
          onChange={(event) => onDocument(moveVariation(document, variation.id, step.id, event.target.value))}
        >
          {document.steps.map((candidate) => <option key={candidate.id} value={candidate.id}>{stepTitle(document, candidate.id)}</option>)}
        </Select>
      </label>
    </>
  )
}

/* Steps and variations share one DndContext. With closestCenter alone a step
 * always landed over a variation droppable, which dragEnd ignores, so step
 * drags did nothing. A step drag now only considers step droppables; a
 * variation drag keeps every droppable, as before (it may land on a step). */
export const stepAwareCollision: CollisionDetection = (args) => {
  if (args.active.data.current?.type !== 'step') return closestCenter(args)
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => container.data.current?.type === 'step'),
  })
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
    <DndContext sensors={sensors} collisionDetection={stepAwareCollision} onDragEnd={dragEnd}>
      <SortableContext items={document.steps.slice(1).map((step) => step.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-3">
          {document.steps.map((step, index) => (
            <SortableStepShell key={step.id} step={step}>
              {(stepHandle) => (
                <>
                  <header className="sequence-step-head">
                    <div
                      className={
                        step.kind === 'connection'
                          ? 'grid place-items-center size-9 flex-none rounded-[11px] text-app-accent bg-app-accent-subtle border border-app-accent-border'
                          : 'grid place-items-center size-9 flex-none rounded-[11px] text-[var(--purple)] bg-[var(--purple-subtle)] border border-[var(--purple-border)]'
                      }
                    >
                      {step.kind === 'connection' ? <UserRoundPlus size={17} aria-hidden="true" /> : <MessageCircle size={17} aria-hidden="true" />}
                    </div>
                    <div>
                      <span className="flex items-center gap-1.5 text-app-accent text-[length:var(--text-2xs)] font-[750] tracking-[var(--tracking-caps)] uppercase">Step {index + 1}</span>
                      <h2>{stepTitle(document, step.id)}</h2>
                    </div>
                    <span className="sequence-step-meta">{step.variations.length} variation{step.variations.length === 1 ? '' : 's'}</span>
                    <div className="sequence-step-actions">
                      <Button size="sm" variant="secondary" icon={<MessageCircle size={13} aria-hidden="true" />} onClick={() => onComment({ stepId: step.id, variationId: null, anchor: null, label: stepTitle(document, step.id) })}>Comment</Button>
                      {step.kind === 'message' && <Button size="sm" variant="secondary" icon={<UserRoundPlus size={13} aria-hidden="true" />} onClick={() => onDocument(makeConnectionStep(document, step.id))}>Make CR</Button>}
                      <IconButton label="Move step up" icon={<ArrowUp size={14} aria-hidden="true" />} disabled={index <= 1} onClick={() => onDocument(moveMessageStep(document, step.id, -1))} />
                      <IconButton label="Move step down" icon={<ArrowDown size={14} aria-hidden="true" />} disabled={index === 0 || index === document.steps.length - 1} onClick={() => onDocument(moveMessageStep(document, step.id, 1))} />
                      {stepHandle}
                      {step.kind === 'message' && <IconButton tone="danger" label="Remove step" icon={<Trash2 size={14} aria-hidden="true" />} onClick={() => onDocument(removeStep(document, step.id))} />}
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
                    </div>
                    {/* Add variation is an action under the editors, not a
                        grid cell: as a cell it claimed half the row and left
                        a single variation editing in ~460px. */}
                    <div className="sequence-variation-actions">
                      <Button variant="ghost" icon={<Plus size={18} aria-hidden="true" />} className="font-normal" onClick={() => onDocument(addVariation(document, step.id))}>
                        Add variation
                      </Button>
                    </div>
                  </SortableContext>
                </>
              )}
            </SortableStepShell>
          ))}
          <Button
            variant="secondary"
            icon={<Plus size={18} aria-hidden="true" />}
            className="self-center w-[min(320px,100%)] justify-center"
            onClick={() => onDocument(addMessageStep(document))}
          >
            Add message
          </Button>
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
    <div>
      <div className="flex items-center gap-1.5 text-app-accent text-[length:var(--text-2xs)] font-[750] tracking-[var(--tracking-caps)] uppercase"><Split size={14} aria-hidden="true" /> Sequence versions</div>
      <SectionHeader
        title="Build A/B/C branches"
        description="Choose one variation from every step. These branches are prepared sequences, not live traffic experiments."
        actions={
          <Button variant="primary" icon={<Plus size={15} aria-hidden="true" />} onClick={() => onDocument(addBranch(document))}>Add branch</Button>
        }
      />
      {document.branches.length === 0 ? (
        <Panel>
          <EmptyState
            icon={Split}
            title="No branches yet"
            hint="Add A, B and C after you have explored a few message variations."
            action={<Button variant="secondary" icon={<Plus size={15} aria-hidden="true" />} onClick={() => onDocument(addBranch(document))}>Create branch A</Button>}
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(330px,100%),1fr))] gap-3">
          {document.branches.map((branch, branchIndex) => (
            <Panel as="article" key={branch.id} className="sequence-branch-card">
              <header>
                <span className="grid place-items-center size-[34px] rounded-[10px] bg-[var(--purple-subtle)] border border-[var(--purple-border)] text-[var(--purple)] font-extrabold">{branch.name.trim().slice(0, 2) || branchIndex + 1}</span>
                <Input
                  value={branch.name}
                  onChange={(event) => onDocument(updateBranch(document, branch.id, { name: event.target.value }))}
                  aria-label="Branch name"
                />
                <IconButton tone="danger" label="Remove branch" icon={<Trash2 size={15} aria-hidden="true" />} onClick={() => onDocument(removeBranch(document, branch.id))} />
              </header>
              <div className="sequence-branch-path">
                {document.steps.map((step) => (
                  <label key={step.id}>
                    <span>{stepTitle(document, step.id)}</span>
                    <Select
                      value={branch.selections[step.id] ?? step.variations[0]?.id ?? ''}
                      onChange={(event) => onDocument(updateBranch(document, branch.id, { selections: { ...branch.selections, [step.id]: event.target.value } }))}
                    >
                      {step.variations.map((variation) => <option key={variation.id} value={variation.id}>{variation.label || 'Untitled variation'}</option>)}
                    </Select>
                    <small>{step.variations.find((variation) => variation.id === branch.selections[step.id])?.text || 'Empty message'}</small>
                  </label>
                ))}
              </div>
              <Button block icon={<Eye size={14} aria-hidden="true" />} onClick={() => onPreview(branch.id)}>Preview branch {branch.name}</Button>
            </Panel>
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
    <div>
      <div className="flex items-center gap-1.5 text-app-accent text-[length:var(--text-2xs)] font-[750] tracking-[var(--tracking-caps)] uppercase"><Eye size={14} aria-hidden="true" /> Recipient view</div>
      <SectionHeader
        title="LinkedIn preview"
        description="An approximate rendering for reading the whole flow. LinkedIn can change its UI and limits independently."
        actions={
          <SegmentedControl
            label="Preview device"
            value={device}
            onChange={setDevice}
            items={[
              { id: 'web', label: <><Laptop size={15} aria-hidden="true" /> Web</> },
              { id: 'mobile', label: <><Smartphone size={15} aria-hidden="true" /> Mobile</> },
            ]}
          />
        }
      />
      <div className="sequence-preview-layout">
        <Panel as="aside" className="sequence-preview-controls">
          <SelectField
            label="Prepared branch"
            value={branchId ?? ''}
            onChange={(event) => onBranchId(event.target.value || null)}
          >
            <option value="">Custom selection</option>
            {document.branches.map((candidate) => <option key={candidate.id} value={candidate.id}>Branch {candidate.name}</option>)}
          </SelectField>
          {previewSteps.map(({ step, variation }) => (
            <SelectField
              key={step.id}
              label={stepTitle(document, step.id)}
              value={variation?.id ?? ''}
              disabled={Boolean(branch)}
              onChange={(event) => setCustom((current) => ({ ...current, [step.id]: event.target.value }))}
            >
              {step.variations.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </SelectField>
          ))}
          <div className="sequence-sample-fields">
            <strong>Sample personalization</strong>
            {Object.entries(document.sampleData).map(([key, value]) => <span key={key}><b>{`{${key}}`}</b>{value}</span>)}
          </div>
        </Panel>
        <div
          data-device={device}
          className="w-[min(780px,100%)] min-h-[620px] my-0 mx-auto [border:1px_solid_#d4d8dd] rounded-[10px] bg-white text-[#191919] [box-shadow:var(--shadow-overlay)] overflow-hidden data-[device=mobile]:w-[min(390px,100%)] data-[device=mobile]:border-[8px] data-[device=mobile]:border-[#24272b] data-[device=mobile]:rounded-[34px]"
        >
          {device === 'mobile' && <div className="w-[120px] h-[20px] my-0 mx-auto [border-radius:0_0_13px_13px] [background:#24272b]" />}
          <div className="linkedin-preview-topbar">
            <div className="text-[#666] text-[28px] leading-none">‹</div>
            <div className="linkedin-avatar">A</div>
            <div><strong>{document.sampleData.firstName}</strong><span>{document.sampleData.jobTitle}</span></div>
            <MoreHorizontal size={18} aria-hidden="true" />
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
                    <small data-warn={graphemeCount(variation?.text ?? '') > CONNECTION_REQUEST_WARNING_LIMIT ? '' : undefined}>{graphemeCount(variation?.text ?? '')} characters</small>
                  </div>
                )
              }
              return (
                <div key={step.id} className="linkedin-message-row">
                  <span className="linkedin-message-label">Message {index}</span>
                  <div className="linkedin-message-bubble">{text || <em>Empty message</em>}</div>
                  <small>10:{String(index * 3 + 8).padStart(2, '0')} AM</small>
                </div>
              )
            })}
          </div>
          <div className="linkedin-composer"><span>Write a message…</span><span className="linkedin-composer-send" aria-hidden="true">➤</span></div>
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
      <SegmentedControl
        className="m-[9px] [&>button]:flex-1"
        label="Review panel"
        value={view}
        onChange={(next) => setView(next as typeof view)}
        items={[
          { id: 'comments', label: <><MessageCircle size={14} aria-hidden="true" /> Comments</> },
          { id: 'history', label: <><History size={14} aria-hidden="true" /> History</> },
        ]}
      />
      {view === 'comments' ? (
        <>
          <Checkbox
            className="[padding:3px_12px_10px]"
            label="Show resolved"
            checked={showResolved}
            onChange={(event) => setShowResolved(event.target.checked)}
          />
          <div className="sequence-comment-list">
            {visible.length === 0 && (
              <EmptyState icon={MessageCircle} title={`No ${showResolved ? '' : 'open '}comments.`} />
            )}
            {visible.map((thread) => {
              const step = document.steps.find((candidate) => candidate.id === thread.step_id)
              const variation = step?.variations.find((candidate) => candidate.id === thread.variation_id)
              const anchor = resolveCommentAnchor(variation?.text ?? '', thread.anchor)
              return (
                <article key={thread.id} className="sequence-comment-thread" data-resolved={thread.resolved_at ? '' : undefined}>
                  <header><span>{location(thread)}</span>{thread.resolved_at && <b>Resolved</b>}</header>
                  {thread.anchor && <blockquote data-stale={anchor?.stale ? '' : undefined}>{anchor?.stale ? 'Selected text was changed or removed: ' : ''}“{thread.anchor.quote}”</blockquote>}
                  <div className="sequence-comment-messages">
                    {thread.messages.map((message) => (
                      <div key={message.id}><strong>{message.author_name}</strong><p>{message.body}</p><time>{formatUpdated(message.created_at)}</time></div>
                    ))}
                  </div>
                  {replying === thread.id ? (
                    <div className="sequence-reply-box">
                      <Textarea rows={2} aria-label="Reply" value={replyBody} onChange={(event) => setReplyBody(event.target.value)} autoFocus />
                      <div>
                        <Button variant="ghost" size="sm" onClick={() => { setReplying(null); setReplyBody('') }}>Cancel</Button>
                        <Button variant="primary" size="sm" disabled={!replyBody.trim()} onClick={async () => { await onReply(thread.id, replyBody.trim()); setReplying(null); setReplyBody('') }}>Reply</Button>
                      </div>
                    </div>
                  ) : (
                    <footer>
                      <Button variant="ghost" size="sm" onClick={() => setReplying(thread.id)}>Reply</Button>
                      <Button variant="ghost" size="sm" onClick={() => void onResolved(thread.id, !thread.resolved_at)}>{thread.resolved_at ? 'Reopen' : 'Resolve'}</Button>
                    </footer>
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
              {index > 0 && <Button size="sm" variant="secondary" icon={<RotateCcw size={13} aria-hidden="true" />} onClick={() => onRestore(version)}>Restore as new version</Button>}
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

const shortFingerprint = (value?: string | null) => value ? `${value.slice(0, 12)}…` : 'Not measured'

function compatibilityLabel(target: SequencePublishTarget): string {
  switch (target.compatibility_state) {
    case 'approved': return 'Approved contract'
    case 'canary_pending': return 'Canary pending'
    case 'rejected': return 'Contract rejected'
    case 'unknown': return 'Unknown contract'
    default: return target.compatible ? 'Approved contract' : 'Compatibility unknown'
  }
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
    <Dialog
      title="Publish campaign"
      description={`${sequence.name} · revision ${sequence.revision}`}
      closeLabel="Close publish campaign"
      size="lg"
      onRequestClose={onClose}
      busy={busy}
      busyMessage="Queueing paused campaigns — wait for it to finish before closing."
      bodyClassName="sequence-publish-dialog-body"
      footerNote={step === 2 ? `${branchIds.length} of ${document.branches.length} branches selected` : step === 3 ? `${preview.length} paused ${preview.length === 1 ? 'campaign' : 'campaigns'} will be queued` : 'No changes are made until the final step'}
      footer={<>
        {step === 1 ? <Button variant="secondary" onClick={onClose}>Cancel</Button> : <Button variant="secondary" onClick={() => setStep(step - 1)} disabled={busy}>Back</Button>}
        {step < 3 ? (
          <Button variant="primary" disabled={step === 1 ? !target?.compatible || !account : !branchIds.length || Boolean(previewError)} onClick={() => goToStep(step + 1)}>
            Continue <ChevronRight size={14} aria-hidden="true" />
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Send size={14} aria-hidden="true" />}
            loading={busy}
            loadingLabel="Queueing…"
            disabled={!preview.length || Boolean(previewError)}
            onClick={() => void submit()}
          >
            Queue {preview.length} paused {preview.length === 1 ? 'campaign' : 'campaigns'}
          </Button>
        )}
      </>}
    >
      <ol className="sequence-publish-steps" aria-label="Publishing steps">
        {[
          { number: 1, label: 'Destination' },
          { number: 2, label: 'Setup' },
          { number: 3, label: 'Review' },
        ].map((item) => (
          <li key={item.number} data-state={item.number < step ? 'complete' : undefined}>
            <Button variant="ghost" disabled={item.number > furthestStep} onClick={() => setStep(item.number)} aria-current={step === item.number ? 'step' : undefined}>
              <span>{item.number < step ? <Check size={13} aria-hidden="true" /> : item.number}</span>
              <b>{item.label}</b>
            </Button>
          </li>
        ))}
      </ol>

      <div className="sequence-publish-body">
        {step === 1 && <section className="sequence-publish-section" aria-labelledby="publish-destination-title">
          <div className="sequence-publish-section-head">
            <div><span>Step 1 of 3</span><h3 id="publish-destination-title">Where should these campaigns go?</h3><p>Choose the LinkedIn account that will own the campaigns in Linked Helper.</p></div>
          </div>
          {loadingTargets && (
            <div role="status" className="flex items-center gap-2 p-3 border border-app-border rounded-[11px] bg-app-surface-2 text-app-text-muted text-[length:var(--text-sm)]">
              <LoaderCircle size={20} className="animate-spin" aria-hidden="true" />
              <span>Checking available accounts…</span>
            </div>
          )}
          {!loadingTargets && targetsError && (
            <InlineError title="Accounts could not be loaded" message={targetsError} onRetry={loadTargets} retryLabel="Try again" />
          )}
          {!loadingTargets && !targetsError && targets.length === 0 && (
            <EmptyState icon={Laptop} title="No publishing destinations yet" hint="Open Linked Helper on an approved machine and wait for its next sync." />
          )}
          {!loadingTargets && !targetsError && targets.length > 0 && <div className="grid gap-[9px]">
            {targets.map((item) => {
              const normalized = normalizeVerifiedAccountSnapshot(item.account_snapshot, { instanceId: item.instance_id, machineKey: item.machine_key })
              const available = item.compatible && Boolean(normalized)
              const selected = item.instance_id === targetId
              return <label key={item.instance_id} className="sequence-publish-target" data-selected={selected || undefined} data-unavailable={!available || undefined}>
                {/* ui-exception(publish-target-card): a rich destination card around a hidden native radio; verify: sequencePublishWizard. */}
                <input type="radio" name="publish-target" value={item.instance_id} checked={selected} disabled={!available} onChange={() => setTargetId(item.instance_id)} />
                <span className="size-10 grid place-items-center rounded-full bg-app-accent-subtle text-app-accent text-[length:var(--text-md)] font-[780]">{publishAccountName(item).slice(0, 1).toUpperCase()}</span>
                <span className="sequence-publish-target-copy">
                  <strong>{publishAccountName(item)}</strong>
                  <small>{item.machine_key} · {item.instance_id}</small>
                  <small>LH2 {item.measured_lh_version ?? 'unknown'} · {compatibilityLabel(item)}</small>
                  <small title={item.contract_fingerprint ?? undefined}>Observed {shortFingerprint(item.contract_fingerprint)}{item.approved_contract_fingerprint ? ` · approved ${shortFingerprint(item.approved_contract_fingerprint)}` : ''}</small>
                </span>
                <Badge tone={available ? 'success' : 'warning'} icon={available ? <CheckCircle2 size={13} aria-hidden="true" /> : <AlertCircle size={13} aria-hidden="true" />}>{available ? 'Ready' : 'Not ready'}</Badge>
                {!available && <small className="[grid-column:2_/_-1] -mt-[5px] text-app-warning text-[length:var(--text-meta)] capitalize">{item.compatibility_error_code ? item.compatibility_error_code.split('_').join(' ') : 'Account details could not be verified'}</small>}
              </label>
            })}
          </div>}
          {unavailableTargets.length > 0 && <p className="flex items-center gap-1.5 [margin:12px_2px_0] text-app-text-muted text-[length:var(--text-2xs)]"><ShieldCheck size={14} /> Unavailable machines stay visible so you know why they cannot receive a campaign.</p>}
        </section>}

        {step === 2 && <section className="sequence-publish-section" aria-labelledby="publish-setup-title">
          <div className="sequence-publish-section-head">
            <div><span>Step 2 of 3</span><h3 id="publish-setup-title">Choose branches and timing</h3><p>Each selected branch becomes a separate paused campaign.</p></div>
            <Button variant="ghost" size="sm" className="shrink-0 mb-0.5" onClick={() => setBranchIds(allBranchesSelected ? [] : document.branches.map((branch) => branch.id))}>
              {allBranchesSelected ? 'Clear all' : 'Select all'}
            </Button>
          </div>
          <div className="sequence-publish-branch-list">
            {document.branches.length === 0 && <div className="[grid-column:1_/_-1] flex items-center gap-2 p-3 [border:1px_dashed_var(--warning-border)] rounded-[11px] bg-app-warning-subtle text-app-warning text-[length:var(--text-xs)]"><Split size={18} /><span>No branches configured yet. Add a branch in the Branches tab before publishing.</span></div>}
            {document.branches.map((branch, index) => {
              const checked = branchIds.includes(branch.id)
              return <label key={branch.id} data-selected={checked || undefined}>
                {/* ui-exception(publish-branch-tile): a branch tile around a hidden native checkbox; verify: sequencePublishWizard. */}
                <input type="checkbox" checked={checked} onChange={(event) => setBranchIds((current) => event.target.checked ? [...current, branch.id] : current.filter((id) => id !== branch.id))} />
                <span className="sequence-publish-branch-letter size-8 grid place-items-center border border-app-border rounded-[9px] bg-app-surface text-app-text-muted font-[780]">{String.fromCharCode(65 + index)}</span>
                <span><strong>{branch.name}</strong><small>{sequence.name} {String.fromCharCode(65 + index)}</small></span>
                <Check size={15} aria-hidden="true" />
              </label>
            })}
          </div>
          <div className="sequence-publish-config-grid">
            <div className="p-[13px] border border-app-border rounded-[13px] [background:color-mix(in_srgb,var(--surface-2)_65%,transparent)]">
              <div className="sequence-publish-config-title"><Laptop size={16} /><div><strong>Profile actions</strong><small>Optional actions before the invite</small></div></div>
              <Checkbox label="Visit profile" hint="Open and extract the profile first" checked={visit} onChange={(event) => setVisit(event.target.checked)} />
              <Checkbox label="Follow profile" hint="Follow before sending the invite" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
            </div>
            <div className="p-[13px] border border-app-border rounded-[13px] [background:color-mix(in_srgb,var(--surface-2)_65%,transparent)]">
              <div className="sequence-publish-config-title"><Clock3 size={16} /><div><strong>Timing</strong><small>Hours between campaign actions</small></div></div>
              <label className="sequence-publish-delay"><span><strong>Before connection request</strong><small>Optional</small></span><Input aria-label="Hours before connection request" type="number" min="1" max="720" placeholder="None" value={preInviteDelay} onChange={(event) => setPreInviteDelay(event.target.value)} /><b>hours</b></label>
              <label className="sequence-publish-delay"><span><strong>After connection</strong><small>Before Message 1</small></span><Input aria-label="Hours after connection" type="number" min="1" max="720" value={inviteDelay} onChange={(event) => setInviteDelay(event.target.value)} /><b>hours</b></label>
              {messageDelays.map((value, index) => <label key={index} className="sequence-publish-delay"><span><strong>After Message {index + 1}</strong><small>Before Message {index + 2}</small></span><Input aria-label={`Hours after message ${index + 1}`} type="number" min="1" max="720" value={value} onChange={(event) => setMessageDelays((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} /><b>hours</b></label>)}
            </div>
          </div>
          {previewError && (
            <div role="alert" className="mt-[11px] flex items-start gap-[7px] px-[10px] py-[9px] border border-app-warning-border rounded-[9px] bg-app-warning-subtle text-app-warning text-[length:var(--text-xs)]">
              <AlertCircle size={15} className="shrink-0 mt-px" aria-hidden="true" />
              <span>{previewError}</span>
            </div>
          )}
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
          {previewError ? <InlineError title="Preview needs attention" message={previewError} /> : <div className="grid gap-[9px]">
            {preview.map((campaign) => <article key={campaign.branchId} className="p-3 border border-app-border rounded-[13px] [background:color-mix(in_srgb,var(--surface-2)_62%,transparent)]">
              <div className="sequence-publish-preview-head"><span>{campaign.branchLetter}</span><div><strong>{campaign.campaignName}</strong><small>{campaign.actions.length} campaign actions</small></div><CheckCircle2 size={17} /></div>
              <div className="sequence-publish-action-flow">{campaign.actions.map((action, index) => <span key={`${action.type}-${index}`}>{PUBLISH_ACTION_LABELS[action.type] ?? action.type}</span>)}</div>
            </article>)}
          </div>}
          <div className="sequence-publish-safety"><ShieldCheck size={18} /><div><strong>Safe by default</strong><p>Campaigns are created empty and paused. Nothing is sent on LinkedIn until someone adds leads and starts a campaign in Linked Helper.</p></div></div>
        </section>}
      </div>
    </Dialog>
  )
}

/** The editor's latest-publish strip, in the same tone as the Hub's status
 *  badge: `publishStatusTone` owns the meaning; `info` keeps the base accent. */
const PUBLISH_STRIP_TONE: Record<ReturnType<typeof publishStatusTone>, { strip: string; icon: string }> = {
  success: { strip: 'border-app-success-border bg-app-success-subtle', icon: 'text-app-success' },
  warning: { strip: 'border-app-warning-border bg-app-warning-subtle', icon: 'text-app-warning' },
  danger: { strip: 'border-app-danger-border bg-app-danger-subtle', icon: 'text-app-danger' },
  info: { strip: '', icon: 'text-app-accent' },
}

export function PublishJobStrip({ job }: { job: SequencePublishJob }) {
  const tone = publishStatusTone(job.status)
  return (
    <section
      className={`sequence-publish-job-strip ${PUBLISH_STRIP_TONE[tone].strip}`}
      data-tone={tone}
      aria-label="Latest campaign publishing status"
    >
      <span className={`size-7 grid place-items-center rounded-[8px] bg-app-surface ${PUBLISH_STRIP_TONE[tone].icon}`}>
        {tone === 'success'
          ? <CheckCircle2 size={17} aria-hidden="true" />
          : tone === 'info'
            ? <LoaderCircle size={17} aria-hidden="true" className="animate-spin" />
            : <AlertCircle size={17} aria-hidden="true" />}
      </span>
      <div><strong>{publishStatusLabel(job.status)}</strong><small>{job.target_machine_key} · revision {job.sequence_revision}</small>{job.replaces_job_id && <small>Replacement for job {job.replaces_job_id.slice(0, 8)}</small>}{job.replaced_by_job_id && <small>Replaced by job {job.replaced_by_job_id.slice(0, 8)}</small>}</div>
      <span>{job.branches.length} {job.branches.length === 1 ? 'campaign' : 'campaigns'}</span>
    </section>
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
  const [reviewOpen, setReviewOpen] = useState(false)
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

  if (loading) return <div className="max-w-[900px] [margin:30px_auto]"><div className="sequence-card min-h-[300px] cursor-default [background:linear-gradient(90deg,var(--surface-1),var(--surface-2),var(--surface-1))] [background-size:200%_100%] animate-[sequence-shimmer_1.4s_infinite]" /></div>
  if (error || !detail || !document) return (
    <div className="flex flex-col gap-app-lg">
      <PageHeader breadcrumb={[{ label: 'Sequences', to: '/sequences' }, { label: 'Sequence' }]} title="Sequence" />
      <InlineError title="Could not open sequence" message={error ?? 'Unknown sequence.'} />
      <Button variant="secondary" className="self-start" onClick={() => navigate('/sequences')}>Back to sequences</Button>
    </div>
  )

  return (
    <div className="sequence-editor-page">
      {/* One entry to Preview (the tab below), one primary action (Publish).
          The topbar used to carry a second Preview button of its own. */}
      <header className="sequence-editor-topbar">
        <IconButton
          label="Back to sequences"
          icon={<ArrowLeft size={20} aria-hidden="true" />}
          onClick={() => navigate('/sequences')}
        />
        <div className="sequence-name-field">
          {/* The route's one h1. The visible title is the editable name below. */}
          <h1 className="sr-only">{name.trim() || 'Untitled sequence'}</h1>
          <Input
            className="w-[min(520px,100%)] py-0 px-app-md border border-app-border-strong bg-app-surface text-[length:var(--text-lg)] font-semibold"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Sequence name"
          />
          <span>Edited by {detail.sequence.updated_by_name}</span>
        </div>
        <SaveStatus state={saveState} />
        <Button
          variant="secondary"
          icon={<MessageCircle size={18} aria-hidden="true" />}
          onClick={() => setCommentTarget({ stepId: null, variationId: null, anchor: null, label: 'Whole sequence' })}
        >Comment</Button>
        <Button
          variant="secondary"
          icon={<PanelRight size={18} aria-hidden="true" />}
          aria-pressed={reviewOpen}
          onClick={() => setReviewOpen((open) => !open)}
        >
          Comments &amp; history
        </Button>
        {isAdmin && (
          <Button
            variant="primary"
            icon={<Laptop size={18} aria-hidden="true" />}
            disabled={saveState !== 'saved'}
            title={saveState === 'saved' ? 'Publish this saved sequence' : 'Wait for the latest changes to save'}
            onClick={() => setPublishOpen(true)}
          >Publish</Button>
        )}
      </header>

      {conflict && (
        <InlineError
          title="This sequence changed in another session."
          message="Your local draft has not been overwritten. Load the newer saved version before continuing."
          onRetry={() => void load()}
          retryLabel="Load newer version"
        />
      )}

      {isAdmin && publishJobs.length > 0 && <PublishJobStrip job={publishJobs[0]} />}

      <Tabs
        label="Sequence sections"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'build', label: <><MessageCircle size={15} aria-hidden="true" /> Build</> },
          { id: 'branches', label: <><Split size={15} aria-hidden="true" /> Branches</>, count: document.branches.length },
          { id: 'preview', label: <><Eye size={15} aria-hidden="true" /> Preview</> },
        ]}
      />

      {/* The review rail is collapsed by default: it used to take a third of
          the editor's width even with no comments on the sequence. */}
      <div className={`sequence-editor-body${reviewOpen ? ' with-review' : ''}`}>
        <main className="min-w-0">
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
        {reviewOpen && <CommentsPanel
          document={document}
          comments={detail.comments}
          versions={detail.versions}
          onReply={async (threadId, body) => { await replySequenceComment(threadId, body); await refreshReview() }}
          onResolved={async (threadId, resolved) => { await setSequenceCommentResolved(threadId, resolved); await refreshReview() }}
          onRestore={(version) => { setName(version.name); updateDocument(version.document); toast.success(`Revision ${version.revision} loaded as a draft.`) }}
        />}
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
