import { useState } from 'react'
import {
  CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts'
import type { CampaignMetrics } from '../lib/types'
import { num } from '../lib/format'
import { Panel, SectionHeader, SegmentedControl } from '../ui'
import { AXIS, CATEGORICAL as PALETTE, CHART_TEXT_SIZE, GRID } from './chartTheme'

type Metric = 'reply' | 'accept'

interface Point {
  name: string
  x: number // volume (leads)
  y: number // rate %
  num: number
  den: number
  color: string
}

/** Quality vs volume quadrant: each campaign is a bubble at (leads, rate);
 *  bubble size = leads. Crosshairs at the means split winners (up-right) from
 *  thin-sample flukes (up-left). */
export function RateVolumeScatter({ campaigns }: { campaigns: CampaignMetrics[] }) {
  const [metric, setMetric] = useState<Metric>('reply')

  const points: Point[] = campaigns
    .map((c, i) => {
      const rate = metric === 'reply' ? c.reply_rate : c.acceptance_rate
      if (rate == null) return null
      return {
        name: c.campaign_name,
        x: c.total_leads,
        y: rate,
        num: metric === 'reply' ? c.replies : c.accepted,
        den: metric === 'reply' ? c.accepted : c.invites_sent,
        color: PALETTE[i % PALETTE.length],
      }
    })
    .filter((p): p is Point => p !== null)

  const avgX = points.length ? points.reduce((s, p) => s + p.x, 0) / points.length : 0
  const avgY = points.length ? points.reduce((s, p) => s + p.y, 0) / points.length : 0
  const yLabel = metric === 'reply' ? 'Reply %' : 'Accept %'
  // Per-bubble labels overlap once there are more than a handful of campaigns;
  // past that, drop them and lean on the tooltip + a colour-chip legend instead.
  const showLabels = points.length <= 3

  return (
    <Panel>
      <SectionHeader
        title="Quality vs volume"
        actions={
          <SegmentedControl
            label="Metric"
            value={metric}
            onChange={setMetric}
            items={[
              { id: 'reply', label: 'Reply %' },
              { id: 'accept', label: 'Accept %' },
            ]}
          />
        }
      />
      <ResponsiveContainer width="100%" height={320}>
        <ScatterChart margin={{ top: 16, right: 24, left: -8, bottom: 8 }}>
          <CartesianGrid {...GRID} />
          <XAxis
            type="number" dataKey="x" name="Leads" {...AXIS}
            label={{ value: 'Leads (volume)', position: 'insideBottom', offset: -4, fill: 'var(--text-muted)', fontSize: CHART_TEXT_SIZE }}
          />
          <YAxis type="number" dataKey="y" name={yLabel} unit="%" {...AXIS} />
          <ZAxis type="number" dataKey="x" range={[80, 600]} />
          {points.length > 1 && (
            <>
              <ReferenceLine x={avgX} stroke="var(--border-strong)" strokeDasharray="4 4"
                label={{ value: 'avg leads', fill: 'var(--text-muted)', fontSize: CHART_TEXT_SIZE, position: 'insideTopRight' }} />
              <ReferenceLine y={avgY} stroke="var(--border-strong)" strokeDasharray="4 4"
                label={{ value: `avg ${yLabel}`, fill: 'var(--text-muted)', fontSize: CHART_TEXT_SIZE, position: 'insideTopLeft' }} />
            </>
          )}
          <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<PointTooltip metric={metric} />} />
          <Scatter data={points} fillOpacity={0.78} isAnimationActive={false}>
            {points.map((p) => (
              <Cell key={p.name} fill={p.color} />
            ))}
            {showLabels && (
              <LabelList
                dataKey="name"
                position="top"
                formatter={truncName}
                style={{ fill: 'var(--text)', fontSize: CHART_TEXT_SIZE }}
              />
            )}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
      {!showLabels && points.length > 0 && (
        <div className="flex flex-wrap gap-x-app-md gap-y-app-xs mt-app-sm">
          {points.map((p) => (
            <span
              key={p.name}
              title={p.name}
              className="inline-flex items-center gap-app-xs text-app-meta text-app-text-secondary"
              style={{ maxWidth: 220 }}
            >
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: p.color, display: 'inline-block', flexShrink: 0 }} />
              <span className="overflow-hidden text-ellipsis whitespace-nowrap" style={{ maxWidth: 200 }}>{p.name}</span>
            </span>
          ))}
        </div>
      )}
      <p className="text-app-meta text-app-text-muted mt-app-sm">
        Bubble size = lead volume. Up-and-right = strong rate on a real sample;
        up-and-left = high rate but few leads, so treat with caution.
      </p>
    </Panel>
  )
}

/** Keep on-bubble labels short so they don't clip the plot area. */
function truncName(value: unknown): string {
  const s = String(value ?? '')
  return s.length > 18 ? `${s.slice(0, 17)}…` : s
}

function PointTooltip({ active, payload, metric }: {
  active?: boolean; payload?: Array<{ payload: Point }>; metric: Metric
}) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const kind = metric === 'reply' ? 'replies / accepted' : 'accepted / invites'
  return (
    <div className="bg-app-surface border border-app-border rounded-md shadow-[var(--shadow-overlay)] px-app-md py-app-sm">
      <div className="text-app-text font-semibold mb-0.5">{p.name}</div>
      <div className="text-app-text-muted text-app-meta tabular-nums">{num(p.x)} leads</div>
      <div className="text-app-text-muted text-app-meta tabular-nums">
        {p.y.toFixed(1)}% — {num(p.num)} / {num(p.den)} {kind}
      </div>
    </div>
  )
}
