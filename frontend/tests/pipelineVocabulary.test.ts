/**
 * The pipeline records sales progress only. Ledger step 025 retired the stages
 * that repeated reply sentiment (interested / neutral / negative): no picker
 * offers them, but pipeline_events history still holds them, so they keep a
 * label and their old rank and funnel counts do not move.
 */
import { describe, expect, it } from 'vitest'

import type { Lead, PipelineEvent } from '../src/lib/types'
import {
  LEGACY_PIPE_FILTER, PIPELINE_CHECKPOINTS, PIPELINE_STAGES, checkpointCount, pipelineRank,
  reachByPerson, stageLabel,
} from '../src/lib/pipeline'

describe('the pipeline vocabulary', () => {
  it('has one Replied stage and none named after a sentiment', () => {
    const ids = PIPELINE_STAGES.map((s) => s.id as string)
    expect(ids).toContain('replied')
    for (const retired of ['interested', 'neutral', 'negative']) expect(ids).not.toContain(retired)
    expect(pipelineRank('replied')).toBe(1)
  })

  it('still labels and ranks a retired stage found in history', () => {
    expect(stageLabel('neutral')).toBe('Neutral (retired)')
    expect(pipelineRank('interested')).toBe(1)
    expect(pipelineRank('negative')).toBe(1)
  })

  it('counts a person whose history holds a retired stage at the first checkpoint', () => {
    const lead = { id: 'l1', instance_id: 'n1', profile_url: 'p', pipeline_stage: 'lost' } as Lead
    const event = { lead_id: 'l1', kind: 'stage', to_stage: 'negative' } as PipelineEvent
    const reach = reachByPerson([lead], [event])
    expect(PIPELINE_CHECKPOINTS[0].id).toBe('replied')
    expect(checkpointCount(reach, PIPELINE_CHECKPOINTS[0])).toBe(1)
  })

  it('sends an old filter value to where its leads moved', () => {
    expect(LEGACY_PIPE_FILTER).toEqual({ interested: 'replied', neutral: 'replied', negative: 'lost' })
  })
})
