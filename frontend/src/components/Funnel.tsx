import { Fragment } from 'react'
import type { Lead } from '../lib/types'
import { num, pct } from '../lib/format'
import { useData } from '../lib/DataContext'
import { leadKey } from '../lib/leads'
import { PIPELINE_CHECKPOINTS, checkpointCount, reachByPerson } from '../lib/pipeline'

/** One continuous vertical funnel. The automated milestones (Leads → Invited →
 *  Accepted → Replied), computed client-side from lead timestamps, flow straight
 *  into the manual-pipeline checkpoints (Interested → … → Client) without a break
 *  in the bar sequence. The conversion rate between two consecutive stages rides
 *  the connector between their bars, so drop-off reads top-to-bottom.
 *
 *  With `showPipeline`, the manual half is appended. "Reached" combines each
 *  lead's current stage with the deepest stage it ever touched (from
 *  pipeline_events), so a lead that advanced then went cold still counts. The
 *  manual half is visually distinguished (tinted rows + a labelled divider) and
 *  self-hides entirely when no lead has ever been staged — so it is a no-op in
 *  prod until the team starts using the pipeline board. */

interface FunnelRow {
  key: string
  label: string
  count: number
  color: string
  /** Base for the conversion connector above this row (previous stage count);
   *  null on the first row (Leads), which has no connector. */
  base: number | null
  /** Verb describing the transition into this stage (rides the connector). */
  verb: string
  /** Manual-pipeline row — gets the distinct visual treatment. */
  pipeline?: boolean
  /** First manual row — its connector renders the "Manual pipeline" divider. */
  boundary?: boolean
}

// Short verbs for the manual checkpoints, keyed by checkpoint id — parallel to
// the automated "invited / accepted / replied" transitions.
const PIPELINE_VERB: Record<string, string> = {
  interested: 'interested',
  negotiations_call: 'to negotiations',
  call_booked: 'call booked',
  call_done: 'call done',
  proposal_presented: 'proposal sent',
  client: 'became clients',
}

export function Funnel({ leads, showPipeline }: { leads: Lead[]; showPipeline?: boolean }) {
  const { data } = useData()
  // Merge lead ROWS into persons by leadKey(instance, profile) before counting:
  // the same person can hold a row in several campaigns of one instance (e.g. an
  // invite campaign + a messenger campaign over existing connections), and
  // counting rows double-counts them at every stage. A person's milestones are
  // the union across their rows.
  const persons = new Map<string, { invited: boolean; connected: boolean; replied: boolean }>()
  for (const l of leads) {
    const k = leadKey(l.instance_id, l.profile_url)
    const p = persons.get(k) ?? { invited: false, connected: false, replied: false }
    p.invited ||= !!l.invited_at
    p.connected ||= !!l.connected_at
    p.replied ||= !!l.replied_at
    persons.set(k, p)
  }
  // Strict invite-cohort chain: each stage is a subset of the previous one, so
  // every connector is a true conversion rate. People who connected without ever
  // being invited (messenger campaigns over existing connections) are excluded
  // from the automated half and disclosed in the footer instead — counting them
  // as "Accepted" would inflate invite acceptance. They still count in the
  // manual-pipeline half below: a staged deal is a deal wherever it came from.
  const total = persons.size
  let invited = 0
  let accepted = 0
  let replied = 0
  let pending = 0
  let preExisting = 0
  for (const p of persons.values()) {
    if (p.invited) invited++
    if (p.invited && p.connected) accepted++
    if (p.invited && p.connected && p.replied) replied++
    if (p.invited && !p.connected) pending++
    if (p.connected && !p.invited) preExisting++
  }

  // How far each person reached in the manual pipeline (current stage ∪ event
  // history), scoped to the leads passed in (events are filtered to these ids).
  const reach = showPipeline ? reachByPerson(leads, data?.pipelineEvents ?? []) : null
  const pipelineRows =
    reach && reach.size > 0
      ? PIPELINE_CHECKPOINTS.map((cp) => ({ ...cp, count: checkpointCount(reach, cp) }))
      : null

  const rows: FunnelRow[] = [
    { key: 'leads', label: 'Leads', count: total, color: '', base: null, verb: '' },
    { key: 'invited', label: 'Invited', count: invited, color: '', base: total, verb: 'invited' },
    { key: 'accepted', label: 'Accepted', count: accepted, color: '', base: invited, verb: 'accepted' },
    { key: 'replied', label: 'Replied', count: replied, color: '', base: accepted, verb: 'replied' },
  ]

  if (pipelineRows) {
    let prev = replied
    pipelineRows.forEach((r, i) => {
      rows.push({
        key: r.id,
        label: r.label,
        count: r.count,
        color: '',
        base: prev,
        verb: PIPELINE_VERB[r.id] ?? '',
        pipeline: true,
        boundary: i === 0,
      })
      prev = r.count
    })
  }

  // One hue ramp for the whole funnel — accent at the top deepening into success
  // (= "won") at the bottom — so the bar colors read as progression instead of a
  // categorical palette. The Leads baseline row stays neutral. (The pipeline
  // BOARD keeps its per-stage categorical colors from stageColor(); this ramp is
  // funnel-only.)
  const ramp = rows.length - 2 // colored rows after Leads, zero-indexed span
  rows.forEach((r, i) => {
    r.color =
      i === 0
        ? 'var(--text-muted)'
        : `color-mix(in srgb, var(--success) ${ramp > 0 ? Math.round((100 * (i - 1)) / ramp) : 0}%, var(--accent))`
  })

  // Overall Lead → Client conversion (only when pipeline data exists).
  const clients = pipelineRows ? pipelineRows[pipelineRows.length - 1].count : 0

  // Manual-pipeline rows re-scale to their own widest stage: on the lead-count
  // scale they render as invisible slivers (12 vs 2,802), hiding exactly the
  // drop-offs this section exists to show. It reads as a zoomed inset — the
  // "Manual pipeline" divider fences it off and the footer states the zoom;
  // the connector rates carry the true stage-to-stage conversion either way.
  const pipelineMax = pipelineRows ? Math.max(...pipelineRows.map((r) => r.count)) : 0
  const pipelineBase = pipelineMax > 0 ? pipelineMax : total
  const barWidth = (count: number, pipeline?: boolean) => {
    const base = pipeline ? pipelineBase : total
    return base > 0 ? `${Math.max((100 * count) / base, count > 0 ? 2 : 0)}%` : 0
  }

  return (
    <div className="card">
      <h2>Funnel</h2>
      <div className="funnel">
        {rows.map((s, i) => (
          <Fragment key={s.key}>
            {i > 0 &&
              (s.boundary ? (
                <div className="funnel-divider">
                  <span className="funnel-divider-label">Manual pipeline</span>
                  <span className="funnel-conv-inline">
                    <span className="funnel-conv-rate">
                      {s.base && s.base > 0 ? pct(s.count, s.base) : '—'}
                    </span>
                    <span className="funnel-conv-verb">{s.verb}</span>
                  </span>
                </div>
              ) : (
                <div className="funnel-conv">
                  <span className="funnel-conv-rate">
                    {s.base && s.base > 0 ? pct(s.count, s.base) : '—'}
                  </span>
                  <span className="funnel-conv-verb">{s.verb}</span>
                </div>
              ))}
            <div className={`funnel-row${s.pipeline ? ' funnel-row--pipeline' : ''}`}>
              <span className="funnel-label">{s.label}</span>
              <div className="funnel-track">
                <div
                  className="funnel-bar"
                  style={{ width: barWidth(s.count, s.pipeline), background: s.color }}
                />
              </div>
              <span className="funnel-count">{num(s.count)}</span>
            </div>
          </Fragment>
        ))}
      </div>

      <div className="funnel-footer">
        <span className="muted small">
          {num(pending)} invites still pending (sent, not yet accepted)
          {preExisting > 0 &&
            ` · ${num(preExisting)} existing connections (never invited) excluded`}
          {pipelineRows && pipelineMax > 0 && ' · manual-pipeline bars use their own zoomed scale'}
        </span>
        {pipelineRows && (
          <span className="funnel-overall">
            <strong>{num(clients)}</strong> clients from {num(total)} leads ·{' '}
            <strong>{total > 0 ? pct(clients, total) : '—'}</strong> Lead→Client
          </span>
        )}
      </div>
    </div>
  )
}
