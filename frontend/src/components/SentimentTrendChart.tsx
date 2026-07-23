import { useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { Message } from '../lib/types'
import { INTENT_META, SENTIMENT_META } from '../lib/leads'
import {
  INTENT_TREND_BUCKETS, TREND_BUCKETS, intentTrend, sentimentTrend,
} from '../lib/review'
import type { IntentTrendBucket, TrendBucket } from '../lib/review'
import { AXIS, BAR_CURSOR, ChartEmpty, GRID, TOOLTIP, dateTick, legendText } from './chartTheme'

// Bucket → the `.senti.*` colour it wears everywhere else, so a sentiment is the
// same hue on the trend as on the reply badges. `unclassified` is a neutral grey.
const BUCKET_COLOR: Record<TrendBucket, string> = {
  positive: 'var(--success)',
  objection: 'var(--warning)',
  neutral: 'var(--info)',
  referral: 'var(--purple)',
  negative: 'var(--danger)',
  auto: 'var(--text-muted)',
  unclassified: 'var(--border-strong)',
}

const BUCKET_LABEL: Record<TrendBucket, string> = {
  positive: SENTIMENT_META.positive.label,
  objection: SENTIMENT_META.objection.label,
  neutral: SENTIMENT_META.neutral.label,
  referral: SENTIMENT_META.referral.label,
  negative: SENTIMENT_META.negative.label,
  auto: SENTIMENT_META.auto.label,
  unclassified: 'Unclassified',
}

const INTENT_COLOR: Record<IntentTrendBucket, string> = {
  p1: 'var(--info)',
  p2: 'var(--warning)',
  p3: 'var(--success)',
  no_intent: 'var(--text-muted)',
  unclassified: 'var(--border-strong)',
}

const INTENT_LABEL: Record<IntentTrendBucket, string> = {
  p1: `${INTENT_META.p1.short} · ${INTENT_META.p1.label}`,
  p2: `${INTENT_META.p2.short} · ${INTENT_META.p2.label}`,
  p3: `${INTENT_META.p3.short} · ${INTENT_META.p3.label}`,
  no_intent: 'No intent',
  unclassified: 'Unclassified',
}

type Mode = 'counts' | 'share'
type Dimension = 'sentiment' | 'intent'

/** Weekly stacked bars of inbound-reply sentiment, with a counts / share (100%-
 *  stacked) toggle. Scoped to the page's account filter. */
export function SentimentTrendChart({
  messages, instanceId, weeks,
}: { messages: Message[]; instanceId?: string; weeks: number }) {
  const [mode, setMode] = useState<Mode>('counts')
  const [dimension, setDimension] = useState<Dimension>('intent')

  const chartData = useMemo(() => {
    const trend =
      dimension === 'intent'
        ? intentTrend(messages, { instanceId, weeks })
        : sentimentTrend(messages, { instanceId, weeks })
    return trend.map((w) => ({ week: w.week, total: w.total, ...w.counts }))
  }, [messages, instanceId, weeks, dimension])
  const buckets: readonly string[] =
    dimension === 'intent' ? INTENT_TREND_BUCKETS : TREND_BUCKETS

  const hasData = chartData.some((d) => d.total > 0)

  return (
    <div className="card chart-card">
      <div className="card-head">
        <h2>Reply classification trend</h2>
        <div className="segmented" role="tablist" aria-label="Classification dimension">
          <button
            className={`segmented-item ${dimension === 'intent' ? 'active' : ''}`}
            onClick={() => setDimension('intent')}
          >
            P1–P3 intent
          </button>
          <button
            className={`segmented-item ${dimension === 'sentiment' ? 'active' : ''}`}
            onClick={() => setDimension('sentiment')}
          >
            Sentiment
          </button>
        </div>
        <div className="segmented" role="tablist" aria-label="Scale">
          <button
            className={`segmented-item ${mode === 'counts' ? 'active' : ''}`}
            role="tab"
            aria-selected={mode === 'counts'}
            onClick={() => setMode('counts')}
          >
            Counts
          </button>
          <button
            className={`segmented-item ${mode === 'share' ? 'active' : ''}`}
            role="tab"
            aria-selected={mode === 'share'}
            onClick={() => setMode('share')}
          >
            Share
          </button>
        </div>
      </div>

      {!hasData ? (
        <ChartEmpty label="No replies in this window" />
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart
            data={chartData}
            stackOffset={mode === 'share' ? 'expand' : 'none'}
            margin={{ top: 8, right: 0, left: -16, bottom: 0 }}
          >
            <CartesianGrid {...GRID} />
            <XAxis dataKey="week" {...AXIS} tickFormatter={dateTick} minTickGap={24} />
            <YAxis
              {...AXIS}
              allowDecimals={false}
              {...(mode === 'share'
                ? { domain: [0, 1] as [number, number], tickFormatter: (v: number) => `${Math.round(v * 100)}%` }
                : {})}
            />
            <Tooltip {...TOOLTIP} labelFormatter={dateTick} cursor={BAR_CURSOR} />
            <Legend formatter={legendText} />
            {buckets.map((b) => (
              <Bar
                key={b}
                dataKey={b}
                name={
                  dimension === 'intent'
                    ? INTENT_LABEL[b as IntentTrendBucket]
                    : BUCKET_LABEL[b as TrendBucket]
                }
                stackId="s"
                fill={
                  dimension === 'intent'
                    ? INTENT_COLOR[b as IntentTrendBucket]
                    : BUCKET_COLOR[b as TrendBucket]
                }
                maxBarSize={34}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      )}

      <div className="muted small">
        Inbound replies bucketed by the week they landed. Synced message times are
        LH2 action-run times (they can lag the real message by hours or days), so the
        weekly split is approximate.
      </div>
    </div>
  )
}
