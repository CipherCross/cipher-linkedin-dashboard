// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import { CampaignRuntimeStatusView } from '../src/components/CampaignRuntimeStatus'
import { CampaignTable } from '../src/components/CampaignTable'
import {
  campaignObservationHealth,
  campaignRuntimeLabel,
  campaignStatusSummary,
  isOperationalCampaign,
  parseCampaignRuntimeStatus,
} from '../src/lib/campaignRuntime'
import type { CampaignMetrics } from '../src/lib/types'

const NOW = new Date('2026-09-01T13:00:00.000Z')

function campaign(overrides: Partial<CampaignMetrics>): CampaignMetrics {
  return {
    campaign_id: 'notebook-1:1',
    campaign_name: 'Campaign',
    instance_id: 'notebook-1',
    status: 'legacy-active',
    runtime_status: null,
    is_archived: null,
    status_observed_at: null,
    status_source: null,
    status_raw: null,
    total_leads: 1,
    invites_sent: 1,
    accepted: 0,
    replies: 0,
    acceptance_rate: 0,
    reply_rate: 0,
    last_activity_at: null,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
})

describe('Linked Helper runtime semantics', () => {
  it('recognizes only the six exact statuses and never promotes legacy Active', () => {
    expect(['draft', 'running', 'queued', 'sleeping', 'stopped', 'completed']
      .map(parseCampaignRuntimeStatus)).toEqual([
        'draft', 'running', 'queued', 'sleeping', 'stopped', 'completed',
      ])
    expect(parseCampaignRuntimeStatus('active')).toBeNull()
    expect(parseCampaignRuntimeStatus('Running')).toBeNull()
    expect(campaignRuntimeLabel('active')).toBe('Unknown')
  })

  it('requires a non-archived running, queued or sleeping deployment to be operational', () => {
    expect(isOperationalCampaign({ runtime_status: 'running', is_archived: false, status_observed_at: NOW.toISOString() })).toBe(true)
    expect(isOperationalCampaign({ runtime_status: 'queued', is_archived: false, status_observed_at: NOW.toISOString() })).toBe(true)
    expect(isOperationalCampaign({ runtime_status: 'sleeping', is_archived: false, status_observed_at: NOW.toISOString() })).toBe(true)
    expect(isOperationalCampaign({ runtime_status: 'draft', is_archived: false, status_observed_at: NOW.toISOString() })).toBe(false)
    expect(isOperationalCampaign({ runtime_status: 'running', is_archived: true, status_observed_at: NOW.toISOString() })).toBe(false)
    expect(isOperationalCampaign({ runtime_status: 'running', is_archived: null, status_observed_at: NOW.toISOString() })).toBe(false)
  })

  it('treats partial-profile campaigns (null runtime, not archived, observed) as operational', () => {
    expect(isOperationalCampaign({ runtime_status: null, is_archived: false, status_observed_at: NOW.toISOString(), status_source: 'partial-v1-2130-fp57' })).toBe(true)
    expect(isOperationalCampaign({ runtime_status: null, is_archived: false, status_observed_at: NOW.toISOString(), status_source: 'unsupported:STATUS_PROFILE_UNVERIFIED' })).toBe(false)
    expect(isOperationalCampaign({ runtime_status: null, is_archived: false, status_observed_at: null })).toBe(false)
    expect(isOperationalCampaign({ runtime_status: null, is_archived: true, status_observed_at: NOW.toISOString(), status_source: 'partial-v1-2130-fp57' })).toBe(false)
  })

  it('separates stale, unsupported and never-observed states', () => {
    expect(campaignObservationHealth({ runtime_status: 'running', is_archived: false, status_observed_at: '2026-09-01T12:30:00Z', status_source: 'fixture' }, NOW.valueOf())).toBe('fresh')
    expect(campaignObservationHealth({ runtime_status: 'running', is_archived: false, status_observed_at: '2026-09-01T11:59:59Z', status_source: 'fixture' }, NOW.valueOf())).toBe('stale')
    expect(campaignObservationHealth({ runtime_status: null, is_archived: null, status_observed_at: NOW.toISOString(), status_source: 'unsupported:STATUS_PROFILE_UNVERIFIED' }, NOW.valueOf())).toBe('unsupported')
    expect(campaignObservationHealth({ runtime_status: null, is_archived: null, status_observed_at: null }, NOW.valueOf())).toBe('awaiting_first_sync')
  })

  it('partial-profile observation with known archive but null runtime is fresh, not unsupported', () => {
    expect(campaignObservationHealth({ runtime_status: null, is_archived: false, status_observed_at: '2026-09-01T12:30:00Z', status_source: 'partial-v1-2130-fp57' }, NOW.valueOf())).toBe('fresh')
    expect(campaignObservationHealth({ runtime_status: null, is_archived: false, status_observed_at: '2026-09-01T11:59:59Z', status_source: 'partial-v1-2130-fp57' }, NOW.valueOf())).toBe('stale')
    expect(campaignObservationHealth({ runtime_status: null, is_archived: null, status_observed_at: '2026-09-01T12:30:00Z', status_source: 'partial-v1-2130-fp57' }, NOW.valueOf())).toBe('unsupported')
  })

  it('summarizes runtime and archive membership as separate facts', () => {
    expect(campaignStatusSummary([
      { runtime_status: 'running', is_archived: false, status_observed_at: NOW.toISOString() },
      { runtime_status: 'completed', is_archived: true, status_observed_at: NOW.toISOString() },
      { runtime_status: null, is_archived: null, status_observed_at: NOW.toISOString() },
    ])).toBe('1 Running · 1 Archived · 1 Unknown · 1 Archive unknown')
  })
})

describe('shared campaign runtime UI', () => {
  it('shows runtime, archive, source-backed observation age and unsupported state', () => {
    render(<CampaignRuntimeStatusView campaign={{
      runtime_status: null,
      is_archived: null,
      status_observed_at: NOW.toISOString(),
      status_source: 'unsupported:STATUS_PROFILE_UNVERIFIED',
    }} />)
    const status = screen.getByLabelText(/Linked Helper runtime Unknown/)
    expect(within(status).getByText('Unknown')).toBeTruthy()
    expect(within(status).getByText('Archive unknown')).toBeTruthy()
    expect(within(status).getByText('Unsupported')).toBeTruthy()
    expect(within(status).getByText(/Observed/).getAttribute('title'))
      .toBe('unsupported:STATUS_PROFILE_UNVERIFIED')
  })

  it('filters the notebook campaign list by runtime and archive independently', () => {
    render(<MemoryRouter><CampaignTable campaigns={[
      campaign({ campaign_id: 'notebook-1:1', campaign_name: 'Live run', runtime_status: 'running', is_archived: false, status_observed_at: NOW.toISOString(), status_source: 'fixture' }),
      campaign({ campaign_id: 'notebook-1:2', campaign_name: 'Old completed', runtime_status: 'completed', is_archived: true, status_observed_at: NOW.toISOString(), status_source: 'fixture' }),
      campaign({ campaign_id: 'notebook-1:3', campaign_name: 'Unverified', runtime_status: null, is_archived: null, status_observed_at: NOW.toISOString(), status_source: 'unsupported:profile' }),
    ]} instances={[{ id: 'notebook-1', label: 'Notebook One' } as never]} /></MemoryRouter>)

    expect(screen.getByText('Live run')).toBeTruthy()
    expect(screen.queryByText('Old completed')).toBeNull()
    expect(screen.queryByText('Unverified')).toBeNull()

    fireEvent.change(screen.getByLabelText('Filter campaigns by archive state'), { target: { value: 'all' } })
    expect(screen.getByText('Old completed')).toBeTruthy()
    expect(screen.getByText('Unverified')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Filter campaigns by runtime status'), { target: { value: 'completed' } })
    expect(screen.getByText('Old completed')).toBeTruthy()
    expect(screen.queryByText('Live run')).toBeNull()
  })
})
