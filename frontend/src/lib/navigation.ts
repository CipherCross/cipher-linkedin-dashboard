import {
  Activity,
  BookOpen,
  CalendarCheck2,
  ClipboardCheck,
  FileSpreadsheet,
  FlaskConical,
  KanbanSquare,
  LayoutDashboard,
  Search,
  Sparkles,
  Target,
  UserCog,
  Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { instanceName } from './leads'
import type { CampaignMetrics, Instance } from './types'

export type SkeletonVariant = 'overview' | 'table' | 'list' | 'simple'
export type NavigationSectionId = 'primary' | 'strategy' | 'administration'
export type NavigationPlacement = 'main' | 'footer'

export const APP_ROUTE_SEGMENTS = {
  campaign: 'campaign/:id',
  accountsRedirect: 'accounts',
  account: 'account/:id',
  leads: 'leads',
  pipeline: 'pipeline',
  followUps: 'follow-ups',
  repliesRedirect: 'replies',
  review: 'review',
  csvImport: 'csv-import',
  playbook: 'playbook',
  searches: 'searches',
  icp: 'icp',
  hypotheses: 'hypotheses',
  health: 'health',
  team: 'team',
  chat: 'chat',
  neonActivity: 'neon-activity',
} as const

function routeTo(segment: string): string {
  return `/${segment}`
}

export interface NavigationItem {
  id: string
  to: string
  label: string
  icon: LucideIcon
  section: NavigationSectionId
  end?: boolean
  adminOnly?: boolean
  skeleton: SkeletonVariant
  keywords?: string[]
}

export interface NavigationSection {
  id: NavigationSectionId
  label: string | null
  collapsible: boolean
  placement: NavigationPlacement
  items: NavigationItem[]
}

const ITEMS: Record<string, Omit<NavigationItem, 'section'>> = {
  overview: {
    id: 'overview',
    to: '/',
    label: 'Overview',
    icon: LayoutDashboard,
    end: true,
    skeleton: 'overview',
    keywords: ['home', 'dashboard'],
  },
  followUps: {
    id: 'follow-ups',
    to: routeTo(APP_ROUTE_SEGMENTS.followUps),
    label: 'Follow-ups',
    icon: CalendarCheck2,
    skeleton: 'table',
    keywords: ['tasks', 'next actions'],
  },
  pipeline: {
    id: 'pipeline',
    to: routeTo(APP_ROUTE_SEGMENTS.pipeline),
    label: 'Pipeline',
    icon: KanbanSquare,
    skeleton: 'table',
    keywords: ['crm', 'deals'],
  },
  leads: {
    id: 'leads',
    to: routeTo(APP_ROUTE_SEGMENTS.leads),
    label: 'Leads',
    icon: Users,
    skeleton: 'table',
    keywords: ['people', 'replies'],
  },
  chat: {
    id: 'chat',
    to: routeTo(APP_ROUTE_SEGMENTS.chat),
    label: 'Chat',
    icon: Sparkles,
    skeleton: 'simple',
    keywords: ['assistant', 'ai'],
  },
  review: {
    id: 'review',
    to: routeTo(APP_ROUTE_SEGMENTS.review),
    label: 'Review',
    icon: ClipboardCheck,
    skeleton: 'table',
    keywords: ['results', 'analysis'],
  },
  playbook: {
    id: 'playbook',
    to: routeTo(APP_ROUTE_SEGMENTS.playbook),
    label: 'Playbook',
    icon: BookOpen,
    skeleton: 'simple',
    keywords: ['guidance', 'process'],
  },
  searches: {
    id: 'searches',
    to: routeTo(APP_ROUTE_SEGMENTS.searches),
    label: 'Searches',
    icon: Search,
    skeleton: 'simple',
    keywords: ['saved searches', 'sourcing'],
  },
  icps: {
    id: 'icps',
    to: routeTo(APP_ROUTE_SEGMENTS.icp),
    label: 'ICPs',
    icon: Target,
    skeleton: 'simple',
    keywords: ['ideal customer profiles', 'audiences'],
  },
  hypotheses: {
    id: 'hypotheses',
    to: routeTo(APP_ROUTE_SEGMENTS.hypotheses),
    label: 'Hypotheses',
    icon: FlaskConical,
    skeleton: 'simple',
    keywords: ['experiments', 'ideas'],
  },
  team: {
    id: 'team',
    to: routeTo(APP_ROUTE_SEGMENTS.team),
    label: 'Team',
    icon: UserCog,
    skeleton: 'overview',
    keywords: ['members', 'users'],
  },
  csvImport: {
    id: 'csv-import',
    to: routeTo(APP_ROUTE_SEGMENTS.csvImport),
    label: 'CSV Import',
    icon: FileSpreadsheet,
    adminOnly: true,
    skeleton: 'table',
    keywords: ['apollo', 'airtable', 'upload'],
  },
  health: {
    id: 'health',
    to: routeTo(APP_ROUTE_SEGMENTS.health),
    label: 'Health',
    icon: Activity,
    skeleton: 'table',
    keywords: ['sync', 'status', 'agents'],
  },
}

function inSection(
  section: NavigationSectionId,
  item: Omit<NavigationItem, 'section'>,
): NavigationItem {
  return { ...item, section }
}

export const NAVIGATION_SECTIONS: NavigationSection[] = [
  {
    id: 'primary',
    label: null,
    collapsible: false,
    placement: 'main',
    items: [
      inSection('primary', ITEMS.overview),
      inSection('primary', ITEMS.followUps),
      inSection('primary', ITEMS.pipeline),
      inSection('primary', ITEMS.leads),
      inSection('primary', ITEMS.chat),
    ],
  },
  {
    id: 'strategy',
    label: 'Strategy',
    collapsible: true,
    placement: 'main',
    items: [
      inSection('strategy', ITEMS.review),
      inSection('strategy', ITEMS.playbook),
      inSection('strategy', ITEMS.searches),
      inSection('strategy', ITEMS.icps),
      inSection('strategy', ITEMS.hypotheses),
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    collapsible: true,
    placement: 'footer',
    items: [
      inSection('administration', ITEMS.team),
      inSection('administration', ITEMS.csvImport),
      inSection('administration', ITEMS.health),
    ],
  },
]

export const NAVIGATION_ITEMS = NAVIGATION_SECTIONS.flatMap((section) => section.items)

export function navigationItemMatches(pathname: string, item: NavigationItem): boolean {
  return item.end
    ? pathname === item.to
    : pathname === item.to || pathname.startsWith(`${item.to}/`)
}

export function navigationItemForPath(pathname: string): NavigationItem | null {
  return NAVIGATION_ITEMS.find((item) => navigationItemMatches(pathname, item)) ?? null
}

export function pageNameForPath(pathname: string): string | null {
  return navigationItemForPath(pathname)?.label ?? null
}

export function skeletonVariantForPath(pathname: string): SkeletonVariant {
  return navigationItemForPath(pathname)?.skeleton ?? 'overview'
}

export function visibleNavigationItems(isAdmin: boolean): NavigationItem[] {
  return NAVIGATION_ITEMS.filter((item) => !item.adminOnly || isAdmin)
}

export type QuickNavigationKind = 'page' | 'account' | 'campaign'

export interface QuickNavigationDestination {
  id: string
  to: string
  label: string
  meta: string
  kind: QuickNavigationKind
  searchText: string
  icon?: LucideIcon
}

export interface QuickNavigationSource {
  instances: Instance[]
  campaigns: CampaignMetrics[]
}

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

export function buildQuickNavigationDestinations(
  source: QuickNavigationSource | null,
  isAdmin: boolean,
): QuickNavigationDestination[] {
  const pages = visibleNavigationItems(isAdmin).map((item) => {
    const section = NAVIGATION_SECTIONS.find((candidate) => candidate.id === item.section)
    const meta = section?.label ?? 'Main'
    return {
      id: `page:${item.id}`,
      to: item.to,
      label: item.label,
      meta,
      kind: 'page' as const,
      searchText: normalized([item.label, meta, ...(item.keywords ?? [])].join(' ')),
      icon: item.icon,
    }
  })

  if (!source) return pages

  const names = new Map(source.instances.map((instance) => [
    instance.id,
    instanceName(instance),
  ]))
  const accounts: QuickNavigationDestination[] = source.instances.map((instance) => {
    const label = instanceName(instance)
    return {
      id: `account:${instance.id}`,
      to: `/${APP_ROUTE_SEGMENTS.account.replace(':id', encodeURIComponent(instance.id))}`,
      label,
      meta: 'Account',
      kind: 'account',
      searchText: normalized(`${label} ${instance.id} account`),
    }
  })
  const campaigns: QuickNavigationDestination[] = source.campaigns.map((campaign) => {
    const account = names.get(campaign.instance_id) ?? campaign.instance_id
    return {
      id: `campaign:${campaign.campaign_id}`,
      to: `/${APP_ROUTE_SEGMENTS.campaign.replace(':id', encodeURIComponent(campaign.campaign_id))}`,
      label: campaign.campaign_name,
      meta: `Campaign · ${account}`,
      kind: 'campaign',
      searchText: normalized(
        `${campaign.campaign_name} ${campaign.campaign_id} ${account} campaign`,
      ),
    }
  })

  return [...pages, ...accounts, ...campaigns]
}

export function filterQuickNavigationDestinations(
  destinations: QuickNavigationDestination[],
  query: string,
  limit = 16,
): QuickNavigationDestination[] {
  const q = normalized(query)
  if (!q) return destinations.filter((item) => item.kind === 'page').slice(0, limit)

  const tokens = q.split(/\s+/).filter(Boolean)
  return destinations
    .filter((item) => tokens.every((token) => item.searchText.includes(token)))
    .sort((a, b) => {
      const aLabel = normalized(a.label)
      const bLabel = normalized(b.label)
      const aExact = aLabel === q ? 0 : aLabel.startsWith(q) ? 1 : 2
      const bExact = bLabel === q ? 0 : bLabel.startsWith(q) ? 1 : 2
      if (aExact !== bExact) return aExact - bExact
      if (a.kind !== b.kind) return a.kind === 'page' ? -1 : b.kind === 'page' ? 1 : 0
      return a.label.localeCompare(b.label)
    })
    .slice(0, limit)
}
