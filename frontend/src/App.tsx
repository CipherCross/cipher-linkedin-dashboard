import { lazy, Suspense, type ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { DataProvider } from './lib/DataContext'
import { AuthGate, AuthProvider, useAuth } from './lib/AuthContext'
import { ToastProvider } from './lib/ToastContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/Layout'
import { ResetPassword, resetTokenFromHash } from './pages/ResetPassword'
import { APP_ROUTE_SEGMENTS } from './lib/navigation'
import { Panel } from './ui'

/** Dev-only UI reference (`#/ui-gallery`). `import.meta.env.DEV` is statically
 *  false in a production build, so this import and the branch below are dropped
 *  and no production route exists. */
const Gallery = lazy(() => import('./ui/Gallery').then((m) => ({ default: m.Gallery })))

// Pages are code-split so each route ships its own chunk — the initial bundle no
// longer carries all nine. These modules use named exports, so map to default.
const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })))
const CampaignDetail = lazy(() => import('./pages/CampaignDetail').then((m) => ({ default: m.CampaignDetail })))
const AccountDetail = lazy(() => import('./pages/AccountDetail').then((m) => ({ default: m.AccountDetail })))
const LeadsExplorer = lazy(() => import('./pages/LeadsExplorer').then((m) => ({ default: m.LeadsExplorer })))
const Pipeline = lazy(() => import('./pages/Pipeline').then((m) => ({ default: m.Pipeline })))
const FollowUps = lazy(() => import('./pages/FollowUps').then((m) => ({ default: m.FollowUps })))
const Playbook = lazy(() => import('./pages/Playbook').then((m) => ({ default: m.Playbook })))
const SearchLibrary = lazy(() => import('./pages/SearchLibrary').then((m) => ({ default: m.SearchLibrary })))
const Icp = lazy(() => import('./pages/Icp').then((m) => ({ default: m.Icp })))
const Hypotheses = lazy(() => import('./pages/Hypotheses').then((m) => ({ default: m.Hypotheses })))
const SequenceBuilder = lazy(() => import('./pages/SequenceBuilder').then((m) => ({ default: m.SequenceBuilder })))
const Health = lazy(() => import('./pages/Health').then((m) => ({ default: m.Health })))
const Chat = lazy(() => import('./pages/Chat').then((m) => ({ default: m.Chat })))
const Review = lazy(() => import('./pages/Review').then((m) => ({ default: m.Review })))
const Replies = lazy(() => import('./pages/Replies').then((m) => ({ default: m.Replies })))
const SentimentAnalysis = lazy(() => import('./pages/SentimentAnalysis').then((m) => ({ default: m.SentimentAnalysis })))
const CsvImport = lazy(() => import('./pages/CsvImport').then((m) => ({ default: m.CsvImport })))
const Team = lazy(() => import('./pages/Team').then((m) => ({ default: m.Team })))
const NeonActivity = lazy(() => import('./pages/NeonActivity').then((m) => ({ default: m.NeonActivity })))

export function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth()
  if (isAdmin) return <>{children}</>
  return (
    <Panel>
      <h1 className="m-0 text-app-page">Admin access required</h1>
      <p className="mt-app-sm mb-0 text-app-text-muted">Your account can view dashboard data but cannot run imports.</p>
    </Panel>
  )
}

export default function App() {
  if (import.meta.env.DEV && window.location.hash.startsWith('#/ui-gallery')) {
    // Outside AuthGate on purpose: the gallery reads no API and writes nothing,
    // so it stays usable as a reference with no session and no database.
    return (
      <ErrorBoundary variant="screen">
        <Suspense fallback={null}>
          <Gallery />
        </Suspense>
      </ErrorBoundary>
    )
  }

  // Before the gate, deliberately. A recovery link is opened by somebody who
  // cannot sign in — that is what the link is for — and every route below sits
  // inside `AuthGate`, so a reset screen placed there could never be reached.
  const resetToken = resetTokenFromHash(window.location.hash)
  if (resetToken !== null) {
    return (
      <ErrorBoundary variant="screen">
        <ResetPassword token={resetToken} />
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary variant="screen">
      <AuthProvider>
        <AuthGate>
          <HashRouter>
            <DataProvider>
              <ToastProvider>
                <Routes>
                  <Route element={<Layout />}>
                    <Route index element={<Overview />} />
                    <Route path={APP_ROUTE_SEGMENTS.campaign} element={<CampaignDetail />} />
                    <Route path={APP_ROUTE_SEGMENTS.accountsRedirect} element={<Navigate to="/" replace />} />
                    <Route path={APP_ROUTE_SEGMENTS.account} element={<AccountDetail />} />
                    <Route path={APP_ROUTE_SEGMENTS.leads} element={<LeadsExplorer />} />
                    <Route path={APP_ROUTE_SEGMENTS.pipeline} element={<Pipeline />} />
                    <Route path={APP_ROUTE_SEGMENTS.followUps} element={<FollowUps />} />
                    <Route path={APP_ROUTE_SEGMENTS.replies} element={<Replies />} />
                    <Route path={APP_ROUTE_SEGMENTS.sentimentAnalysis} element={<SentimentAnalysis />} />
                    <Route path={APP_ROUTE_SEGMENTS.review} element={<Review />} />
                    <Route path={APP_ROUTE_SEGMENTS.csvImport} element={<AdminOnly><CsvImport /></AdminOnly>} />
                    <Route path={APP_ROUTE_SEGMENTS.playbook} element={<Playbook />} />
                    <Route path={APP_ROUTE_SEGMENTS.searches} element={<SearchLibrary />} />
                    {/* Legacy: off the rail since sequences became the operating
                        object, but still routed. Briefings and coaching read
                        these rows, so the pages stay reachable by URL until a
                        later migration proves nothing depends on them.
                        See LEGACY_NAVIGATION_ITEMS in lib/navigation.ts. */}
                    <Route path={APP_ROUTE_SEGMENTS.icp} element={<Icp />} />
                    <Route path={APP_ROUTE_SEGMENTS.hypotheses} element={<Hypotheses />} />
                    <Route path={APP_ROUTE_SEGMENTS.sequences} element={<SequenceBuilder />} />
                    <Route path={APP_ROUTE_SEGMENTS.sequence} element={<SequenceBuilder />} />
                    <Route path={APP_ROUTE_SEGMENTS.health} element={<Health />} />
                    <Route path={APP_ROUTE_SEGMENTS.team} element={<Team />} />
                    <Route path={APP_ROUTE_SEGMENTS.chat} element={<Chat />} />
                    {/* S12: one read-only slice served from Neon, beside the
                        Supabase path every other route still uses. */}
                    <Route path={APP_ROUTE_SEGMENTS.neonActivity} element={<NeonActivity />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Route>
                </Routes>
              </ToastProvider>
            </DataProvider>
          </HashRouter>
        </AuthGate>
      </AuthProvider>
    </ErrorBoundary>
  )
}
