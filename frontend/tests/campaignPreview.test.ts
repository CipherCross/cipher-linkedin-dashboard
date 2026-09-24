// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { sequenceMessages, useCampaignPreview } from '../src/lib/campaignPreview'
import type { CampaignPreview } from '../src/lib/types'

vi.mock('../src/lib/dashboardReads', () => ({ fetchNeonCampaignPreview: vi.fn() }))

const payload = (id: string, name: string): CampaignPreview => ({
  campaign: { campaign_id: id, campaign_name: name, instance_id: 'one' },
  leads: [],
  steps: [],
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const target = (id: string) => ({ campaignId: id, campaignName: `Campaign ${id}`, instanceId: 'one' })

describe('useCampaignPreview', () => {
  it('never lets a slow answer for A paint over B', async () => {
    const a = deferred<CampaignPreview>()
    const b = deferred<CampaignPreview>()
    const signals: AbortSignal[] = []
    const fetcher = vi.fn((id: string, signal: AbortSignal) => {
      signals.push(signal)
      return id === 'a' ? a.promise : b.promise
    })
    const { result } = renderHook(() => useCampaignPreview(fetcher))

    act(() => result.current.open(target('a')))
    act(() => result.current.open(target('b')))
    expect(signals[0].aborted).toBe(true)

    await act(async () => { b.resolve(payload('b', 'B')) })
    await act(async () => { a.resolve(payload('a', 'A')) })
    expect(result.current.state).toMatchObject({ status: 'ready', campaignId: 'b' })
  })

  it('ignores an answer that arrives after close, and aborts the request', async () => {
    const a = deferred<CampaignPreview>()
    let signal: AbortSignal | undefined
    const { result } = renderHook(() => useCampaignPreview((_id, s) => { signal = s; return a.promise }))
    act(() => result.current.open(target('a')))
    act(() => result.current.close())
    expect(signal?.aborted).toBe(true)
    await act(async () => { a.resolve(payload('a', 'A')) })
    expect(result.current.state).toEqual({ status: 'closed' })
  })

  it('serves a reopened campaign from the session cache; Retry always refetches', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(payload('a', 'A'))
    const { result } = renderHook(() => useCampaignPreview(fetcher))

    act(() => result.current.open(target('a')))
    await waitFor(() => expect(result.current.state.status).toBe('error'))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.state.status).toBe('ready'))
    act(() => result.current.close())
    act(() => result.current.open(target('a')))
    expect(result.current.state.status).toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('sequenceMessages', () => {
  it('labels copy by what the lead receives, in step order, skipping blank templates', () => {
    expect(sequenceMessages([
      { step_index: 5, step_label: null, step_type: 'MessageToPerson', template_body: 'Second' },
      { step_index: 0, step_label: null, step_type: 'InvitePerson', template_body: 'Hi {firstName}' },
      { step_index: 3, step_label: null, step_type: 'MessageToPerson', template_body: '   ' },
      { step_index: 2, step_label: null, step_type: 'MessageToPerson', template_body: 'First' },
    ])).toEqual([
      { key: '0', label: 'Connection request', body: 'Hi {firstName}' },
      { key: '2', label: 'Message 1', body: 'First' },
      { key: '5', label: 'Message 2', body: 'Second' },
    ])
  })
})
