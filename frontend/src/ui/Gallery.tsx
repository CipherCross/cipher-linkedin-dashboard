import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { DateRangePicker } from '../components/DateRangePicker'
import { presetRanges } from '../lib/leads'
import {
  ArrowRight, Check, CircleAlert, Clock, Download, Filter, Inbox, Laptop, MoreHorizontal, Plus,
  RefreshCw, SearchX, Smartphone, Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Toaster } from '../components/ui/sonner'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '../components/ui/command'
import {
  AccountIdentity, ActiveFilters, Badge, Button, Checkbox, Dialog, EmptyState, FilterCount,
  FilterDialog, IconButton, InitialsBadge, InlineError, LinkButton, PageHeader, Panel, RadioGroup,
  SaveStatus, SectionHeader,
  SegmentedControl, SelectField, SortHeader, StatusText, Table, TableFrame, TableToolbar, Tabs,
  TextField, TextareaField, Toolbar, UpdatingNote, businessTimeLabelled, analyticsDate,
} from './index'
import { FollowUpRow } from '../components/FollowUpRow'
import { KpiGrid, KpiTile } from '../components/KpiTile'

/**
 * Dev-only reference for the UI standard: every primitive in every state, plus
 * four compositions that stand in for the four hardest real screens (an
 * analytics page, a three-pane workspace, a filtered list, a long-form editor).
 *
 * It is reachable at `#/ui-gallery` in `vite dev` only — `import.meta.env.DEV`
 * is statically false in a production build, so the module is dropped entirely
 * and no production route exists. It reads no API and writes nothing: the
 * fixtures below are literals, chosen to cover the cases that broke real
 * screens — a duplicate person name, a 100+ character campaign title, an
 * unknown contact, zero coverage, and a partial sentiment dataset.
 */

/* Fixed date so the gallery renders identically on every run. */
const GALLERY_PRESETS = presetRanges(new Date('2026-09-15T00:00:00.000Z'))

const PEOPLE = [
  { name: 'Mykyta Shevchenko', account: 'notebook-1', campaign: 'Q3 · Founders (DACH)' },
  { name: 'Mykyta Shevchenko', account: 'notebook-3', campaign: 'Q3 · Founders (DACH)' },
  { name: null, account: 'notebook-2', campaign: 'Long-running outbound programme for mid-market operations leaders in logistics and freight forwarding — wave 4' },
  { name: 'Ivan Petrenko', account: 'uitop', campaign: 'Reactivation' },
]

function Swatch({ token, note }: { token: string; note: string }) {
  return (
    <div className="ui-gallery__swatch">
      <div style={{ background: `var(${token})`, height: 40, borderRadius: 6, border: '1px solid var(--border)' }} />
      <div style={{ marginTop: 'var(--space-sm)', fontFamily: 'var(--font-mono)' }}>{token}</div>
      <div className="muted">{note}</div>
    </div>
  )
}

export function Gallery() {
  const [tab, setTab] = useState<'states' | 'composition' | 'list-chrome' | 'widgets'>('states')
  const [period, setPeriod] = useState<'7d' | '28d' | 'all'>('28d')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busyDialogOpen, setBusyDialogOpen] = useState(false)
  const [filterDraft, setFilterDraft] = useState<null | { stage: string; owner: string }>(null)
  const [appliedFilters, setAppliedFilters] = useState({ stage: 'all', owner: 'all' })
  const [choice, setChoice] = useState<'positive' | 'neutral' | 'negative'>('neutral')
  const [range, setRange] = useState(GALLERY_PRESETS[1] ?? GALLERY_PRESETS[0])
  const [reviewPane, setReviewPane] = useState(false)
  const [loading, setLoading] = useState(false)

  return (
    <MemoryRouter>
      <div className="page">
        <PageHeader
          title="UI standard"
          breadcrumb={[{ label: 'Internal' }, { label: 'UI standard' }]}
          description="Every shared primitive in every state, at the sizes and contrast the product ships. Dev-only — this route does not exist in a production build."
          context={<Badge tone="neutral">Light · PC only · English</Badge>}
          actions={<Button variant="primary" icon={<Plus />}>Primary action</Button>}
        />

        <Tabs
          label="Gallery sections"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'states', label: 'Primitives' },
            { id: 'composition', label: 'Compositions' },
            { id: 'list-chrome', label: 'List chrome' },
            { id: 'widgets', label: 'Widgets' },
          ]}
        />

        {tab === 'widgets' ? (
          <WidgetTier />
        ) : tab === 'states' ? (
          <div className="ui-gallery">
            <Panel>
              <SectionHeader title="Palette" description="Opaque surfaces only — no tint, blur or rim." />
              <div className="ui-gallery__swatches">
                <Swatch token="--bg" note="page" />
                <Swatch token="--surface-1" note="card / dialog" />
                <Swatch token="--surface-2" note="subtle / disabled" />
                <Swatch token="--border" note="separator" />
                <Swatch token="--border-strong" note="input border 3.69:1" />
                <Swatch token="--accent" note="5.17:1 on white" />
                <Swatch token="--success" note="4.99:1" />
                <Swatch token="--warning" note="7.19:1" />
                <Swatch token="--danger" note="6.42:1" />
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Type scale" description="Body, table and controls 14/20 · prose 16/24 · metadata 13/18 floor." />
              <div className="ui-gallery__ruler">
                <div style={{ font: '600 var(--text-page)/var(--leading-page) var(--font-sans)' }}>Page title — 24/32</div>
                <div style={{ font: '600 var(--text-section)/var(--leading-section) var(--font-sans)' }}>Section — 16/24</div>
                <div style={{ font: '600 var(--text-subsection)/var(--leading-subsection) var(--font-sans)' }}>Subsection — 14/20</div>
                <div style={{ font: 'var(--text-body)/var(--leading-body) var(--font-sans)' }}>Body — 14/20</div>
                <div style={{ font: 'var(--text-table)/var(--leading-table) var(--font-sans)' }}>Table content — 14/20</div>
                <div className="muted" style={{ font: 'var(--text-meta)/var(--leading-meta) var(--font-sans)' }}>Metadata — 13/18</div>
                <div className="tabular" style={{ font: '600 var(--text-kpi)/var(--leading-kpi) var(--font-sans)' }}>1,284</div>
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Buttons" description="36px tall, 28px small. Loading keeps the width; disabled states say why elsewhere." />
              <div className="ui-gallery__row">
                <Button variant="primary">Primary</Button>
                <Button variant="secondary" icon={<RefreshCw />}>Secondary</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="danger" icon={<Trash2 />}>Danger</Button>
                <Button variant="primary" loading loadingLabel="Saving">Save</Button>
                <Button variant="primary" disabled>Disabled</Button>
                <Button variant="secondary" aria-pressed>Pressed</Button>
                <LinkButton to="/" variant="secondary" icon={<ArrowRight />}>Link button</LinkButton>
                <IconButton label="Download" icon={<Download />} bordered />
                <IconButton label="Delete" icon={<Trash2 />} tone="danger" />
              </div>
              <div className="ui-gallery__row" style={{ marginTop: 'var(--space-md)' }}>
                <Button size="sm" variant="secondary">Dense · in-row only</Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={loading}
                  onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1200) }}
                >
                  Click for pending
                </Button>
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Fields" description="Visible label, wired help/error ids, error never colour-only." />
              <div style={{ display: 'grid', gap: 'var(--space-lg)', maxWidth: 560 }}>
                <TextField label="Campaign name" placeholder="Q3 · Founders (DACH)" help="Shown to the team only." />
                <TextField label="Owner email" required error="Enter a work email address." defaultValue="not-an-email" />
                <SelectField label="Account" defaultValue="notebook-1">
                  {PEOPLE.map((person) => (
                    <option key={person.account} value={person.account}>
                      {person.name ?? 'LinkedIn contact'} · {person.account}
                    </option>
                  ))}
                </SelectField>
                <TextareaField label="Comment" help="Context for the decision — optional." />
                <TextField label="Read-only" value="notebook-1:42" readOnly disabled help="Set by the sync agent." />
                <Checkbox label="Do not contact" hint="Cancels dashboard reminders. Stop the Linked Helper campaign separately." />
                <RadioGroup
                  legend="Sentiment"
                  name="gallery-sentiment"
                  value={choice}
                  onChange={setChoice}
                  row
                  options={[
                    { value: 'positive', label: 'Positive' },
                    { value: 'neutral', label: 'Neutral' },
                    { value: 'negative', label: 'Negative' },
                  ]}
                />
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Selection" description="Tabs switch a section; segmented switches a mode or period." />
              <div className="ui-gallery__row">
                <SegmentedControl
                  label="Period"
                  value={period}
                  onChange={setPeriod}
                  items={[
                    { id: '7d', label: 'Last 7 days' },
                    { id: '28d', label: 'Last 28 days' },
                    { id: 'all', label: 'All time' },
                  ]}
                />
              </div>
              <div className="ui-gallery__row">
                <SegmentedControl
                  label="Preview device"
                  value={period === '7d' ? 'web' : 'mobile'}
                  onChange={(next) => setPeriod(next === 'web' ? '7d' : '28d')}
                  items={[
                    { id: 'web', label: <><Laptop size={15} aria-hidden="true" /> Web</> },
                    { id: 'mobile', label: <><Smartphone size={15} aria-hidden="true" /> Mobile</> },
                  ]}
                />
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Status" description="Colour always travels with a word." />
              <div className="ui-gallery__row">
                <Badge tone="neutral">Unreviewed</Badge>
                <Badge tone="accent" icon={<Check size={14} />}>P3 · Buying intent</Badge>
                <Badge tone="success" icon={<Check size={14} />}>Completed</Badge>
                <Badge tone="warning" icon={<Clock size={14} />}>Follow-up overdue</Badge>
                <Badge tone="danger" icon={<CircleAlert size={14} />}>Do not contact</Badge>
                <Badge tone="info">Neutral</Badge>
                <Badge tone="purple">Referral</Badge>
                <StatusText tone="success" icon={<Check size={16} />}>Synced 12m ago</StatusText>
                <StatusText tone="warning" icon={<Clock size={16} />}>Sync aging</StatusText>
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Identity" description="Duplicate names carry their account; unknown contacts are never invented." />
              <div style={{ display: 'grid', gap: 'var(--space-lg)' }}>
                {PEOPLE.map((person, index) => (
                  <AccountIdentity
                    key={index}
                    avatar={<InitialsBadge name={person.name} />}
                    name={person.name ? `${person.name} · ${person.account}` : 'LinkedIn contact'}
                    secondary={person.name ? person.campaign : `${person.account} · profile only`}
                    title={person.campaign}
                  />
                ))}
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Load, empty and failure" description="Four states, never conflated." />
              <div style={{ display: 'grid', gap: 'var(--space-lg)' }}>
                <UpdatingNote>Showing notebook-1 while notebook-3 loads…</UpdatingNote>
                <EmptyState kind="empty" icon={Inbox} title="No replies yet" hint="Replies appear here after the next sync." />
                <EmptyState
                  kind="no-match"
                  icon={SearchX}
                  title="No leads match these filters"
                  hint="Adjust or clear the filters to see more leads."
                  action={<Button variant="secondary" size="sm">Clear filters</Button>}
                />
                <InlineError
                  message="The replies list could not be read. The rest of the page still works."
                  detail={'STATUS_PROFILE_VERSION_MISMATCH\nat readReplies (dashboardReads.ts:412)'}
                  onRetry={() => {}}
                />
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Save status" description="Presentation only; the editor owns the state." />
              <div style={{ display: 'flex', gap: 'var(--space-xl)', flexWrap: 'wrap' }}>
                {(['saved', 'dirty', 'saving', 'conflict', 'error'] as const).map((state) => <SaveStatus key={state} state={state} />)}
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Overlays" description="One contract: name, focus trap, Escape, inert background, returned focus." />
              <div style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
                <Button variant="secondary" onClick={() => setDialogOpen(true)}>Open dialog</Button>
                <Button variant="secondary" onClick={() => setBusyDialogOpen(true)}>Open busy dialog</Button>
                <Button variant="secondary" icon={<Filter aria-hidden="true" />} onClick={() => setFilterDraft({ ...appliedFilters })}>
                  Filters<FilterCount count={Object.values(appliedFilters).filter((value) => value !== 'all').length} />
                </Button>
              </div>
              {busyDialogOpen && (
                <Dialog
                  size="sm"
                  title="Publishing sequence"
                  description="Escape, the backdrop and Close are refused until the action finishes."
                  onRequestClose={() => setBusyDialogOpen(false)}
                  busy
                  footer={<Button variant="secondary" onClick={() => setBusyDialogOpen(false)}>Stop demo</Button>}
                >
                  <p>Sending the snapshot to the notebook…</p>
                </Dialog>
              )}
              {filterDraft && (
                <FilterDialog
                  description="Nothing changes until you apply."
                  selectedCount={Object.values(filterDraft).filter((value) => value !== 'all').length}
                  onClearAll={() => setFilterDraft({ stage: 'all', owner: 'all' })}
                  onCancel={() => setFilterDraft(null)}
                  onApply={() => { setAppliedFilters(filterDraft); setFilterDraft(null) }}
                >
                  <div style={{ display: 'grid', gap: 'var(--space-lg)' }}>
                    <SelectField label="Milestone" value={filterDraft.stage} onChange={(event) => setFilterDraft({ ...filterDraft, stage: event.target.value })}>
                      <option value="all">All milestones</option>
                      <option value="replied">Replied</option>
                    </SelectField>
                    <SelectField label="Owner" value={filterDraft.owner} onChange={(event) => setFilterDraft({ ...filterDraft, owner: event.target.value })}>
                      <option value="all">Anyone</option>
                      <option value="unassigned">Unassigned</option>
                    </SelectField>
                  </div>
                </FilterDialog>
              )}
              {dialogOpen && (
                <Dialog
                  title="New search"
                  description="Saved searches feed the ICP and the import queue."
                  onRequestClose={() => setDialogOpen(false)}
                  footer={
                    <>
                      <Button variant="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
                      <Button variant="primary" onClick={() => setDialogOpen(false)}>Create search</Button>
                    </>
                  }
                  footerNote="Nothing is saved until you press Create."
                >
                  <div style={{ display: 'grid', gap: 'var(--space-lg)' }}>
                    <TextField label="Name" required />
                    <TextareaField label="Search URL or notes" rows={10} />
                    <p className="muted small">
                      The footer stays in the viewport — only this body scrolls.
                    </p>
                  </div>
                </Dialog>
              )}
            </Panel>
          </div>
        ) : tab === 'list-chrome' ? (
          /* The exact top-of-page stack a default list route renders — page
           * header, toolbar, tabs, table frame — with no live data, because
           * data does not move the first row. The standard requires the first
           * result to start no lower than y=340 at 1280×720, and this is what
           * that is measured on. */
          <>
            <PageHeader
              title="Leads"
              description="Filters are kept in the URL, so any view here is shareable."
              actions={<LinkButton to="/" variant="secondary">Open Replies</LinkButton>}
            />
            <Toolbar>
              <TextField className="ui-toolbar__search" label="Search leads" labelHidden type="search" placeholder="Name, headline, company…" />
              <SelectField label="Account" labelHidden defaultValue="all"><option value="all">All accounts</option></SelectField>
              <Button variant="secondary" icon={<Filter />}>Filters</Button>
            </Toolbar>
            <Tabs
              label="Filter leads by reply sentiment"
              value="all"
              onChange={() => {}}
              items={[{ id: 'all', label: 'All leads' }, { id: 'any', label: 'Any reply', count: 146 }]}
            />
            <TableFrame
              scrollLabel="Leads"
              toolbar={<TableToolbar count="4 of 1,284 leads" actions={<Button size="sm" variant="ghost" icon={<Download />}>Export</Button>} />}
            >
              <Table caption="Leads">
                <thead>
                  <tr>
                    <th scope="col">Lead</th>
                    <th scope="col">Account / campaign</th>
                    <th scope="col">Milestone</th>
                    <th scope="col">Latest activity</th>
                  </tr>
                </thead>
                <tbody>
                  {PEOPLE.map((person, index) => (
                    <tr key={index} className="ui-table__row--identity" data-first-result={index === 0 ? 'true' : undefined}>
                      <td><AccountIdentity avatar={<InitialsBadge name={person.name} />} name={person.name ?? 'LinkedIn contact'} /></td>
                      <td>{person.account}</td>
                      <td><Badge tone="accent">Replied</Badge></td>
                      <td>{businessTimeLabelled('2026-09-14T11:20:00Z')}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableFrame>
          </>
        ) : (
          <div className="ui-gallery">
            <Panel>
              <SectionHeader
                title="Filtered list"
                description="Search plus one selector stay on the page; everything else is in the sheet."
                actions={<Button variant="secondary" icon={<Filter />}>Filters<FilterCount count={3} /></Button>}
              />
              <Toolbar>
                <TextField className="ui-toolbar__search" label="Search leads" labelHidden placeholder="Search leads…" />
                <SelectField label="Account" labelHidden defaultValue="all">
                  <option value="all">All accounts</option>
                  <option value="notebook-1">Mykyta Shevchenko · notebook-1</option>
                  <option value="notebook-3">Mykyta Shevchenko · notebook-3</option>
                </SelectField>
              </Toolbar>
              <ActiveFilters
                onClearAll={() => {}}
                filters={[
                  { id: 'stage', label: 'Milestone', value: 'Replied', onRemove: () => {} },
                  { id: 'owner', label: 'Owner', value: 'Mykyta Shevchenko · notebook-1', onRemove: () => {} },
                  { id: 'range', label: 'Range', value: `${analyticsDate('2026-08-17T00:00:00Z')} – ${analyticsDate('2026-09-14T00:00:00Z')} UTC`, onRemove: () => {} },
                ]}
              />
              <TableFrame
                scrollLabel="Leads"
                toolbar={<TableToolbar count="4 of 1,284 leads" actions={<Button size="sm" variant="ghost" icon={<Download />}>Export</Button>} />}
                hint="Scroll inside the table for the remaining columns."
              >
                <Table caption="Leads">
                  <thead>
                    <tr>
                      <SortHeader label="Lead" active={false} direction="asc" onSort={() => {}} />
                      <th scope="col">Account / campaign</th>
                      <th scope="col">Milestone</th>
                      <SortHeader label="Latest activity" active direction="desc" onSort={() => {}} />
                    </tr>
                  </thead>
                  <tbody>
                    {PEOPLE.map((person, index) => (
                      <tr key={index} className="ui-table__row--identity">
                        <td>
                          <AccountIdentity
                            avatar={<InitialsBadge name={person.name} />}
                            name={person.name ?? 'LinkedIn contact'}
                            secondary={person.name ? undefined : 'linkedin.com/in/ACwAAA…'}
                          />
                        </td>
                        <td>
                          <AccountIdentity name={person.account} secondary={person.campaign} title={person.campaign} />
                        </td>
                        <td><Badge tone="accent">Replied</Badge></td>
                        <td>{businessTimeLabelled('2026-09-14T11:20:00Z')}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </TableFrame>
            </Panel>

            {/* These four use the screens' OWN classes, not lookalike inline
                styles. A mock built from `style={{…}}` renders correctly while
                the real stylesheet is broken — that is how a clipped primary
                action and an unreachable review pane both passed a gallery
                pass. If a composition here needs its page's CSS, import it. */}
            <Panel>
              <SectionHeader title="Analytics row" description="One period statement for the block, not one per card." />
              <div  style={{ marginBottom: 'var(--space-md)' }}>
                <DateRangePicker
                  ariaLabel="Gallery date range"
                  presets={GALLERY_PRESETS}
                  value={range}
                  onChange={setRange}
                />
                <SelectField label="Account" labelHidden value="all" onChange={() => {}}>
                  <option value="all">All accounts</option>
                </SelectField>
                <span className="muted small">Both controls are 36px — the date trigger is not a smaller species.</span>
              </div>
              <KpiGrid>
                {[['Invites sent', '1,284'], ['Connected', '512'], ['Replied', '146'], ['P3 · Buying intent', '0']].map(([label, value]) => (
                  <KpiTile key={label} label={label} value={value} sub="UTC day boundaries · recent cohorts still maturing" />
                ))}
              </KpiGrid>
              <p className="muted small" style={{ marginTop: 'var(--space-md)' }}>
                Zero here means no reviewed conversation reached P3 in this window — not that the metric is unavailable.
              </p>
            </Panel>

            <Panel>
              <SectionHeader
                title="Three-pane workspace"
                description="The real Replies classes. Below 1240px of container width it becomes two panes plus the switch that reaches the third."
              />
              <div className="replies-page" style={{ height: 320 }}>
                <div className={`replies-workspace${reviewPane ? ' pane-review' : ''}`}>
                  <aside className="replies-list-pane"><div className="replies-pane-title"><div><h2>Conversations</h2></div></div></aside>
                  <main className="replies-thread-pane">
                    <div className="replies-thread-head"><div><h2>Thread</h2></div></div>
                    <div style={{ flex: 1 }} />
                    <div className="replies-pane-switch">
                      <Button variant="ghost" block onClick={() => setReviewPane(!reviewPane)}>
                        {reviewPane ? '← Back to conversations' : 'Review reply and next step →'}
                      </Button>
                    </div>
                  </main>
                  <aside className="replies-inspector-pane"><div className="replies-pane-title"><div><h2>Review reply</h2></div></div></aside>
                </div>
              </div>
            </Panel>

            <Panel>
              <SectionHeader
                title="Work queue row"
                description="Four zones on one line while they fit, then the message and the actions drop to a second row. The primary action is never clipped and never dense."
              />
              {/* The route's own row component, so this is the real markup. */}
              <Panel as="div" className="p-0 overflow-hidden">
                {PEOPLE.slice(0, 2).map((person, index) => (
                  <FollowUpRow
                    key={index}
                    avatar={<InitialsBadge name={person.name} />}
                    name={person.name ?? 'Unknown contact'}
                    subtitle={person.campaign}
                    dueLabel={`Overdue by ${index + 3} days`}
                    dueTone="danger"
                    owner="Mykyta Shevchenko"
                    campaigns={person.campaign}
                    account={person.account}
                    message={{
                      direction: 'in',
                      body: 'Thanks — could you send the detail across?',
                      snippet: 'Thanks — could you send the detail across?',
                      sentAt: '2026-09-13T01:54:00Z',
                      timeLabel: analyticsDate('2026-09-13T01:54:00Z'),
                    }}
                    linkedinHref="#top"
                    repliesTo="/replies"
                    onOpen={() => {}}
                  />
                ))}
              </Panel>
            </Panel>

            <Panel>
              <SectionHeader
                title="Editor column"
                description="One variation gets the whole writing column; Add variation is an action underneath, not an empty tile of the same size."
              />
              <div className="sequence-variation-grid">
                <div className="p-app-lg border border-app-border rounded-card bg-app-surface">
                  <TextareaField label="Message" rows={8} defaultValue={'Hi {{first_name}},\n\n…'} />
                </div>
              </div>
              <div className="sequence-variation-actions">
                <Button variant="ghost" icon={<Plus aria-hidden="true" />} className="font-normal">Add variation</Button>
              </div>
            </Panel>
          </div>
        )}
      </div>
    </MemoryRouter>
  )
}


/**
 * The widget tier that the hand-built system never had: the controls every
 * new view used to reinvent as raw CSS and `keydown` handlers.
 *
 * These are shadcn components on Base UI, and they read the app's own colours
 * because shadcn's semantic palette is repointed at tokens.css in index.css —
 * nothing here is restyled by hand. Checking them on this page is how that
 * mapping is verified.
 */
function WidgetTier() {
  const people = ['Ivan Petrenko', 'Mykyta Shevchenko', 'Olena Kovalenko', 'Andrii Bondar']
  const [picked, setPicked] = useState<string | null>(null)

  return (
    <div className="ui-gallery">
      <Toaster />

      <Panel>
        <SectionHeader
          title="Overlays"
          description="Positioning, dismissal and focus come from Base UI. Previously each of these was an outside-click listener written per route."
        />
        <div className="controls" style={{ justifyContent: 'flex-start' }}>
          <Popover>
            <PopoverTrigger render={<Button variant="secondary">Popover</Button>} />
            <PopoverContent>
              <p className="small muted" style={{ margin: 0 }}>
                Anchored, collision-aware, dismissed on Escape and outside press.
              </p>
            </PopoverContent>
          </Popover>

          <Tooltip>
            <TooltipTrigger render={<Button variant="secondary">Tooltip</Button>} />
            <TooltipContent>Describes, never the only label</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="secondary" icon={<MoreHorizontal />}>Menu</Button>}
            />
            <DropdownMenuContent>
              <DropdownMenuItem>Export CSV</DropdownMenuItem>
              <DropdownMenuItem>Duplicate</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Panel>

      <Panel>
        <SectionHeader
          title="Command palette"
          description="Type-ahead over a list. Supersedes the hand-rolled Quick Navigation."
        />
        <Command style={{ maxWidth: 420 }}>
          <CommandInput placeholder="Search people…" />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            <CommandGroup heading="People">
              {people.map((name) => (
                <CommandItem key={name} value={name} onSelect={() => setPicked(name)}>
                  {name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        <p className="small muted" style={{ marginTop: 'var(--space-sm)' }}>
          {picked ? `Selected: ${picked}` : 'Nothing selected yet.'}
        </p>
      </Panel>

      <Panel>
        <SectionHeader
          title="Toasts"
          description="Colour never travels alone — every severity ships an icon too."
        />
        <div className="controls" style={{ justifyContent: 'flex-start' }}>
          <Button variant="secondary" onClick={() => toast.success('Sequence published')}>Success</Button>
          <Button variant="secondary" onClick={() => toast.info('Sync started')}>Info</Button>
          <Button variant="secondary" onClick={() => toast.warning('Two accounts are paused')}>Warning</Button>
          <Button variant="danger" onClick={() => toast.error('Publish failed')}>Error</Button>
        </div>
      </Panel>
    </div>
  )
}
