import { useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import {
  ArrowRight, Check, CircleAlert, Clock, Download, Filter, Plus, RefreshCw, Trash2,
} from 'lucide-react'
import {
  AccountIdentity, ActiveFilters, Badge, Button, Checkbox, Dialog, FilterCount, IconButton,
  InitialsBadge, InlineError, LinkButton, PageHeader, Panel, RadioGroup, SectionHeader,
  SegmentedControl, SelectField, StatusText, Table, TableFrame, TableToolbar, Tabs,
  TextField, TextareaField, Toolbar, UpdatingNote, businessTimeLabelled, analyticsDate,
} from './index'

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
      <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)' }}>{token}</div>
      <div className="muted">{note}</div>
    </div>
  )
}

export function Gallery() {
  const [tab, setTab] = useState<'states' | 'composition'>('states')
  const [period, setPeriod] = useState<'7d' | '28d' | 'all'>('28d')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [choice, setChoice] = useState<'positive' | 'neutral' | 'negative'>('neutral')
  const [loading, setLoading] = useState(false)

  return (
    <MemoryRouter>
      <div className="page">
        <PageHeader
          title="UI standard"
          breadcrumb={[{ label: 'Internal' }, { label: 'UI standard' }]}
          description="Every shared primitive in every state, at the sizes and contrast the product ships. Dev-only — this route does not exist in a production build."
          context={<Badge tone="neutral">Light · PC only · English</Badge>}
          actions={<Button variant="primary" icon={<Plus size={18} />}>Primary action</Button>}
        />

        <Tabs
          label="Gallery sections"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'states', label: 'Primitives' },
            { id: 'composition', label: 'Compositions' },
          ]}
        />

        {tab === 'states' ? (
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
              <SectionHeader title="Type scale" description="Body 16/24 · table 14/20 · metadata 13/18 floor." />
              <div className="ui-gallery__ruler">
                <div style={{ font: '600 var(--text-page)/var(--leading-page) var(--font-sans)' }}>Page title — 28/36</div>
                <div style={{ font: '600 var(--text-section)/var(--leading-section) var(--font-sans)' }}>Section — 20/28</div>
                <div style={{ font: '600 var(--text-subsection)/var(--leading-body) var(--font-sans)' }}>Subsection — 16/24</div>
                <div style={{ font: 'var(--text-body)/var(--leading-body) var(--font-sans)' }}>Body — 16/24</div>
                <div style={{ font: 'var(--text-table)/var(--leading-table) var(--font-sans)' }}>Table content — 14/20</div>
                <div className="muted" style={{ font: 'var(--text-meta)/var(--leading-meta) var(--font-sans)' }}>Metadata — 13/18</div>
                <div className="tabular" style={{ font: '600 var(--text-kpi)/var(--leading-kpi) var(--font-sans)' }}>1,284</div>
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Buttons" description="44px tall. Loading keeps the width; disabled states say why elsewhere." />
              <div className="ui-gallery__row">
                <Button variant="primary">Primary</Button>
                <Button variant="secondary" icon={<RefreshCw size={18} />}>Secondary</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="danger" icon={<Trash2 size={18} />}>Danger</Button>
                <Button variant="primary" loading loadingLabel="Saving">Save</Button>
                <Button variant="primary" disabled>Disabled</Button>
                <Button variant="secondary" aria-pressed>Pressed</Button>
                <LinkButton to="/" variant="secondary" icon={<ArrowRight size={18} />}>Link button</LinkButton>
                <IconButton label="Download" icon={<Download size={20} />} bordered />
                <IconButton label="Delete" icon={<Trash2 size={20} />} tone="danger" />
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
            </Panel>

            <Panel>
              <SectionHeader title="Status" description="Colour always travels with a word." />
              <div className="ui-gallery__row">
                <Badge tone="neutral">Unreviewed</Badge>
                <Badge tone="accent" icon={<Check size={14} />}>P3 · Buying intent</Badge>
                <Badge tone="success" icon={<Check size={14} />}>Completed</Badge>
                <Badge tone="warning" icon={<Clock size={14} />}>Follow-up overdue</Badge>
                <Badge tone="danger" icon={<CircleAlert size={14} />}>Do not contact</Badge>
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
                <InlineError
                  message="The replies list could not be read. The rest of the page still works."
                  detail={'STATUS_PROFILE_VERSION_MISMATCH\nat readReplies (dashboardReads.ts:412)'}
                  onRetry={() => {}}
                />
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Overlays" description="One contract: name, focus trap, Escape, inert background, returned focus." />
              <Button variant="secondary" onClick={() => setDialogOpen(true)}>Open dialog</Button>
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
        ) : (
          <div className="ui-gallery">
            <Panel>
              <SectionHeader
                title="Filtered list"
                description="Search plus one selector stay on the page; everything else is in the sheet."
                actions={<Button variant="secondary" icon={<Filter size={18} />}>Filters<FilterCount count={3} /></Button>}
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
                toolbar={<TableToolbar count="4 of 1,284 leads" actions={<Button size="sm" variant="ghost" icon={<Download size={16} />}>Export</Button>} />}
                hint="Scroll inside the table for the remaining columns."
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

            <Panel>
              <SectionHeader title="Analytics row" description="One period statement for the block, not one per card." />
              <p className="muted small">Last 28 days · UTC day boundaries · recent cohorts still maturing</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-lg)' }}>
                {[['Invites sent', '1,284'], ['Connected', '512'], ['Replied', '146'], ['P3 · Buying intent', '0']].map(([label, value]) => (
                  <div key={label} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', padding: 'var(--space-lg)' }}>
                    <div className="muted small">{label}</div>
                    <div className="tabular" style={{ font: '600 var(--text-kpi)/var(--leading-kpi) var(--font-sans)' }}>{value}</div>
                  </div>
                ))}
              </div>
              <p className="muted small" style={{ marginTop: 'var(--space-md)' }}>
                Zero here means no reviewed conversation reached P3 in this window — not that the metric is unavailable.
              </p>
            </Panel>

            <Panel>
              <SectionHeader title="Three-pane workspace" description="list 320 · thread ≥560 · review 360 at ≥1240px of content width." />
              <div style={{ display: 'grid', gridTemplateColumns: '320px minmax(560px, 1fr) 360px', border: '1px solid var(--border)', borderRadius: 'var(--radius-card)', overflow: 'hidden', minHeight: 260 }}>
                <div style={{ borderRight: '1px solid var(--border)', padding: 'var(--space-lg)' }}>
                  <div className="muted small">Conversations</div>
                </div>
                <div style={{ borderRight: '1px solid var(--border)', padding: 'var(--space-lg)' }}>
                  <div className="muted small">Thread</div>
                </div>
                <div style={{ padding: 'var(--space-lg)' }}>
                  <div className="muted small">Review reply</div>
                </div>
              </div>
            </Panel>

            <Panel>
              <SectionHeader title="Editor column" description="Text column ≥560px; comments collapse into a summoned panel." />
              <TextareaField label="Message" rows={10} defaultValue={'Hi {{first_name}},\n\n…'} />
            </Panel>
          </div>
        )}
      </div>
    </MemoryRouter>
  )
}
