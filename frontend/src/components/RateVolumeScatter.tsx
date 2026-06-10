import { useState } from 'react'
import {
  CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts'
import type { CampaignMetrics } from '../lib/types'

const PALETTE = [
  '#4f8ef7', '#34c98e', '#f7b94f', '#f76a5c', '#b48cf2',
  '#3fc9d6', '#e87fb0', '#9ccc65', '#ffa94d', '#7c89a8',
]

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

  return (
    <div className="card chart-card">
      <div className="cmp-chart-head">
        <h2>Quality vs volume</h2>
        <div className="range-group">
          <button className={metric === 'reply' ? 'active' : ''} onClick={() => setMetric('reply')}>Reply %</button>
          <button className={metric === 'accept' ? 'active' : ''} onClick={() => setMetric('accept')}>Accept %</button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <ScatterChart margin={{ top: 16, right: 24, left: -8, bottom: 8 }}>
          <CartesianGrid stroke="#26304a" strokeDasharray="3 3" />
          <XAxis
            type="number" dataKey="x" name="Leads" stroke="#7c89a8" fontSize={11}
            label={{ value: 'Leads (volume)', position: 'insideBottom', offset: -4, fill: '#7c89a8', fontSize: 11 }}
          />
          <YAxis
            type="number" dataKey="y" name={yLabel} unit="%" stroke="#7c89a8" fontSize={11}
          />
          <ZAxis type="number" dataKey="x" range={[80, 600]} />
          {points.length > 1 && (
            <>
              <ReferenceLine x={avgX} stroke="#46527a" strokeDasharray="4 4"
                label={{ value: 'avg leads', fill: '#7c89a8', fontSize: 10, position: 'insideTopRight' }} />
              <ReferenceLine y={avgY} stroke="#46527a" strokeDasharray="4 4"
                label={{ value: `avg ${yLabel}`, fill: '#7c89a8', fontSize: 10, position: 'insideTopLeft' }} />
            </>
          )}
          <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<PointTooltip metric={metric} />} />
          <Scatter data={points} fillOpacity={0.78}>
            {points.map((p) => (
              <Cell key={p.name} fill={p.color} />
            ))}
            <LabelList dataKey="name" position="top" style={{ fill: '#e7ecf5', fontSize: 11 }} />
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
      <div className="muted small">
        Bubble size = lead volume. Up-and-right = strong rate on a real sample;
        up-and-left = high rate but few leads, so treat with caution.
      </div>
    </div>
  )
}

function PointTooltip({ active, payload, metric }: {
  active?: boolean; payload?: Array<{ payload: Point }>; metric: Metric
}) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const kind = metric === 'reply' ? 'replies / accepted' : 'accepted / invites'
  return (
    <div style={{ background: '#141a2b', border: '1px solid #26304a', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ color: '#e7ecf5', fontWeight: 600, marginBottom: 2 }}>{p.name}</div>
      <div style={{ color: '#7c89a8', fontSize: 12 }}>{p.x.toLocaleString('en-US')} leads</div>
      <div style={{ color: '#7c89a8', fontSize: 12 }}>
        {p.y.toFixed(1)}% — {p.num.toLocaleString('en-US')} / {p.den.toLocaleString('en-US')} {kind}
      </div>
    </div>
  )
}
