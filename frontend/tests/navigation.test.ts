import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LEGACY_NAVIGATION_ITEMS,
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
  it('keeps the agreed workflows visible and in order, sequences among them', () => {
    const primary = NAVIGATION_SECTIONS.find((section) => section.id === 'primary')
    // Sequence Builder came out of the collapsed Strategy group when sequences
    // became the operating object: it sits directly under the home page.
    expect(primary?.items.map((item) => item.label)).toEqual([
      'Overview',
      'Sequence Builder',
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

  it('leaves Strategy holding only the pages that are still part of the work', () => {
    const strategy = NAVIGATION_SECTIONS.find((section) => section.id === 'strategy')
    expect(strategy?.items.map((item) => item.label)).toEqual([
      'Review',
      'Playbook',
      'Searches',
    ])
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

describe('retired ICP and hypothesis pages', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

  it('shows neither in the rail nor in the command palette', () => {
    const visible = visibleNavigationItems(true).map((item) => item.label)
    expect(visible).not.toContain('ICPs')
    expect(visible).not.toContain('Hypotheses')
    expect(NAVIGATION_SECTIONS.flatMap((section) => section.items.map((item) => item.id)))
      .not.toContain('icps')

    const destinations = buildQuickNavigationDestinations(
      { instances: [instance], campaigns: [campaign] },
      true,
    )
    expect(filterQuickNavigationDestinations(destinations, 'icp')).toEqual([])
    expect(filterQuickNavigationDestinations(destinations, 'hypothes')).toEqual([])
  })

  it('keeps both routes resolving, titled and skeletoned', () => {
    // Hidden means unlisted, not unreachable: briefings and coaching still read
    // these rows, and a direct link has to land on the real page.
    expect(LEGACY_NAVIGATION_ITEMS.map((item) => item.to)).toEqual(['/icp', '/hypotheses'])
    expect(pageNameForPath('/icp')).toBe('ICPs')
    expect(pageNameForPath('/hypotheses')).toBe('Hypotheses')
    expect(skeletonVariantForPath('/icp')).toBe('simple')
    expect(navigationItemForPath('/hypotheses')?.section).toBe('legacy')
  })

  it('still mounts both routes in the router', () => {
    // The registry above can only say what a resolved route would be called;
    // deleting the <Route> is the way this actually breaks.
    expect(app).toContain('APP_ROUTE_SEGMENTS.icp} element={<Icp />}')
    expect(app).toContain('APP_ROUTE_SEGMENTS.hypotheses} element={<Hypotheses />}')
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
