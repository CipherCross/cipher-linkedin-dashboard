import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchNeonCampaignPreview } from './dashboardReads'
import type { CampaignPreview, CampaignPreviewStep } from './types'

/**
 * The Campaign comparison preview's request lifecycle.
 *
 * - Opening a campaign issues at most one `campaign.preview` read.
 * - A ready payload is cached per campaign for as long as Overview is mounted;
 *   reopening it renders at once and starts no refetch. Retry always refetches.
 * - Closing, or opening another campaign, aborts the obsolete request, and any
 *   response whose request id is no longer the active one is dropped — so a slow
 *   answer for campaign A can never paint over campaign B.
 */
export interface PreviewTarget {
  campaignId: string
  campaignName: string
  instanceId: string
}

export type CampaignPreviewState =
  | { status: 'closed' }
  | ({ status: 'loading' } & PreviewTarget)
  | ({ status: 'ready'; preview: CampaignPreview } & PreviewTarget)
  | ({ status: 'error'; error: string } & PreviewTarget)

const pick = ({ campaignId, campaignName, instanceId }: PreviewTarget): PreviewTarget =>
  ({ campaignId, campaignName, instanceId })

type Fetcher = (campaignId: string, signal: AbortSignal) => Promise<CampaignPreview>

const defaultFetcher: Fetcher = (campaignId, signal) =>
  fetchNeonCampaignPreview(campaignId, undefined, signal)

export function useCampaignPreview(fetcher: Fetcher = defaultFetcher) {
  const [state, setState] = useState<CampaignPreviewState>({ status: 'closed' })
  const stateRef = useRef(state)
  stateRef.current = state
  const cache = useRef(new Map<string, CampaignPreview>())
  const active = useRef<{ id: number; controller: AbortController } | null>(null)
  const nextId = useRef(0)

  const cancel = useCallback(() => {
    active.current?.controller.abort()
    active.current = null
  }, [])

  const load = useCallback((target: PreviewTarget) => {
    cancel()
    const request = { id: ++nextId.current, controller: new AbortController() }
    active.current = request
    setState({ status: 'loading', ...pick(target) })
    fetcher(target.campaignId, request.controller.signal).then(
      (preview) => {
        if (active.current?.id !== request.id) return
        active.current = null
        cache.current.set(target.campaignId, preview)
        setState({ status: 'ready', preview, ...pick(target) })
      },
      (error: unknown) => {
        if (active.current?.id !== request.id) return
        active.current = null
        setState({ status: 'error', error: error instanceof Error ? error.message : String(error), ...pick(target) })
      },
    )
  }, [cancel, fetcher])

  const open = useCallback((target: PreviewTarget) => {
    const cached = cache.current.get(target.campaignId)
    if (cached) {
      cancel()
      setState({ status: 'ready', preview: cached, ...pick(target) })
      return
    }
    load(target)
  }, [cancel, load])

  const retry = useCallback(() => {
    const current = stateRef.current
    if (current.status !== 'error') return
    load(pick(current))
  }, [load])

  const close = useCallback(() => {
    cancel()
    setState({ status: 'closed' })
  }, [cancel])

  useEffect(() => cancel, [cancel])

  return { state, open, retry, close }
}

export interface SequenceMessage {
  key: string
  label: string
  body: string
}

/**
 * Copy-bearing synced steps in Linked Helper order, labelled by what the lead
 * receives: `Connection request`, then `Message 1`, `Message 2`… counting only
 * the messages shown. Blank templates are dropped defensively; order is never
 * reinterpreted. Variables such as `{firstName}` stay literal.
 */
export function sequenceMessages(steps: readonly CampaignPreviewStep[]): SequenceMessage[] {
  let message = 0
  return [...steps]
    .sort((a, b) => a.step_index - b.step_index)
    .filter((step) => step.template_body.trim() !== '')
    .map((step) => ({
      key: String(step.step_index),
      label: step.step_type === 'InvitePerson' ? 'Connection request' : `Message ${++message}`,
      body: step.template_body,
    }))
}
