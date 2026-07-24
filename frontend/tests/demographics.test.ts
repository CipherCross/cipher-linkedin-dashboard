import { describe, expect, it } from 'vitest'
import { ageRange, campaignDemographics } from '../src/lib/leads'
import type { Lead } from '../src/lib/types'

const lead = (id: string, profile: string, patch: Partial<Lead> = {}): Lead =>
  ({
    id,
    instance_id: 'i1',
    campaign_id: 'i1:c1',
    profile_url: profile,
    full_name: null,
    headline: null,
    company: null,
    added_at: null,
    invited_at: null,
    connected_at: null,
    first_message_at: null,
    replied_at: null,
    last_action_at: null,
    pipeline_stage: null,
    pipeline_substatus: null,
    lost_reason: null,
    pipeline_stage_changed_at: null,
    assigned_to: null,
    ...patch,
  }) as Lead

describe('lead demographics', () => {
  it('keeps pending evaluation separate from an evaluated unknown gender', () => {
    const demo = campaignDemographics([
      lead('pending', 'https://linkedin.test/in/pending'),
      lead('unknown', 'https://linkedin.test/in/unknown', {
        gender: 'unknown',
        gender_inferred_at: '2026-07-24T00:00:00Z',
      }),
      lead('female', 'https://linkedin.test/in/female', { gender: 'female' }),
    ])

    expect(Object.fromEntries(demo.gender.map((g) => [g.id, g.count]))).toEqual({
      female: 1,
      male: 0,
      unknown: 1,
      pending: 1,
    })
  })

  it('renders the full stored age range instead of implying a point estimate', () => {
    const year = new Date().getUTCFullYear()
    expect(
      ageRange(
        lead('age', 'https://linkedin.test/in/age', {
          birth_year_min: year - 42,
          birth_year_max: year - 36,
        })
      )
    ).toBe('36–42')
  })

  it('deduplicates demographic chart totals by account and profile', () => {
    const profile = 'https://linkedin.test/in/repeated'
    const demo = campaignDemographics([
      lead('one', profile, { gender: 'male' }),
      lead('two', profile, { gender: 'male', campaign_id: 'i1:c2' }),
    ])
    expect(demo.total).toBe(1)
    expect(demo.gender.find((g) => g.id === 'male')?.count).toBe(1)
  })
})
