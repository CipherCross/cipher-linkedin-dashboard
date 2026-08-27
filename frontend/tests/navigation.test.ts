import { describe, expect, it } from 'vitest'
import {
  NAVIGATION_ITEMS,
  NAVIGATION_SECTIONS,
  buildQuickNavigationDestinations,
  filterQuickNavigationDestinations,
  navigationItemForPath,
  pageNameForPath,
  skeletonVariantForPath,
  visibleNavigationItems,
} from '../src/lib/navigation'
import type { CampaignMetrics, Instance } from '../src/lib/types'

const instance = {
  id: 'notebook 1',
  label: 'Notebook 1',
  account_name: 'Alyona Account',
} as Instance

const campaign = {
  campaign_id: 'notebook 1:42',
  campaign_name: 'Healthcare founders',
  instance_id: 'notebook 1',
} as CampaignMetrics

describe('sidebar information architecture', () => {
  it('keeps the five agreed workflows visible and in order', () => {
    const primary = NAVIGATION_SECTIONS.find((section) => section.id === 'primary')
    expect(primary?.items.map((item) => item.label)).toEqual([
      'Overview',
      'Follow-ups',
      'Pipeline',
      'Leads',
      'Chat',
    ])
    expect(primary?.collapsible).toBe(false)
  })

  it('contains no persistent account or campaign navigation', () => {
    expect(NAVIGATION_ITEMS.some((item) => /account|campaign/i.test(item.label))).toBe(false)
    expect(NAVIGATION_SECTIONS.map((section) => section.id)).toEqual([
      'primary',
      'strategy',
      'administration',
    ])
  })

  it('keeps admin visibility separate from route matching', () => {
    expect(visibleNavigationItems(false).map((item) => item.label)).not.toContain('CSV Import')
    expect(visibleNavigationItems(true).map((item) => item.label)).toContain('CSV Import')
    expect(navigationItemForPath('/csv-import')?.adminOnly).toBe(true)
  })

  it('derives titles, active matching, and loading shapes from one registry', () => {
    expect(pageNameForPath('/')).toBe('Overview')
    expect(pageNameForPath('/leads/anything')).toBe('Leads')
    expect(pageNameForPath('/account/notebook-1')).toBeNull()
    expect(skeletonVariantForPath('/follow-ups')).toBe('table')
    expect(skeletonVariantForPath('/playbook')).toBe('simple')
    expect(pageNameForPath('/sequences')).toBe('Sequence Builder')
    expect(pageNameForPath('/sequences/example-id')).toBe('Sequence Builder')
    expect(skeletonVariantForPath('/campaign/notebook-1%3A42')).toBe('overview')
  })
})

describe('quick navigation', () => {
  it('keeps rare account and campaign destinations searchable but out of the rail', () => {
    const destinations = buildQuickNavigationDestinations({
      instances: [instance],
      campaigns: [campaign],
    }, false)

    expect(filterQuickNavigationDestinations(destinations, 'alyona')).toContainEqual(
      expect.objectContaining({
        label: 'Alyona Account',
        kind: 'account',
        to: '/account/notebook%201',
      }),
    )
    expect(filterQuickNavigationDestinations(destinations, 'healthcare alyona')).toMatchObject([
      {
        label: 'Healthcare founders',
        kind: 'campaign',
        to: '/campaign/notebook%201%3A42',
      },
    ])
  })

  it('shows only pages before a query and ranks exact page matches first', () => {
    const destinations = buildQuickNavigationDestinations({
      instances: [instance],
      campaigns: [campaign],
    }, true)
    const initial = filterQuickNavigationDestinations(destinations, '')
    expect(initial.every((item) => item.kind === 'page')).toBe(true)
    expect(filterQuickNavigationDestinations(destinations, 'leads')[0]).toMatchObject({
      label: 'Leads',
      kind: 'page',
    })
  })
})
