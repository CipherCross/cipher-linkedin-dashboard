import { lazy, type ReactNode } from 'react'
import { HashRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import { DataProvider } from './lib/DataContext'
import { AuthGate, AuthProvider, useAuth } from './lib/AuthContext'
import { ToastProvider } from './lib/ToastContext'
import { ThemeProvider } from './lib/ThemeContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/Layout'
import { ResetPassword, resetTokenFromHash } from './pages/ResetPassword'
import { APP_ROUTE_SEGMENTS } from './lib/navigation'

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
const CsvImport = lazy(() => import('./pages/CsvImport').then((m) => ({ default: m.CsvImport })))
const Team = lazy(() => import('./pages/Team').then((m) => ({ default: m.Team })))
const NeonActivity = lazy(() => import('./pages/NeonActivity').then((m) => ({ default: m.NeonActivity })))

/** Replies folded into Leads, but old deep links carried a `sentiment` query
 *  param (positive/neutral/negative/objection/referral/auto/unclassified) — forward
 *  it as-is to /leads, defaulting to `any` when absent. */
function RepliesRedirect() {
  const [params] = useSearchParams()
  const sentiment = params.get('sentiment') ?? 'any'
  return <Navigate to={`/leads?sentiment=${encodeURIComponent(sentiment)}`} replace />
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { isAdmin } = useAuth()
  if (isAdmin) return <>{children}</>
  return (
    <div className="card access-denied">
      <h1>Admin access required</h1>
      <p className="muted">Your account can view dashboard data but cannot run imports.</p>
    </div>
  )
}

export default function App() {
  // Before the gate, deliberately. A recovery link is opened by somebody who
  // cannot sign in — that is what the link is for — and every route below sits
  // inside `AuthGate`, so a reset screen placed there could never be reached.
  const resetToken = resetTokenFromHash(window.location.hash)
  if (resetToken !== null) {
    return (
      <ErrorBoundary variant="screen">
        <ThemeProvider>
          <ResetPassword token={resetToken} />
        </ThemeProvider>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary variant="screen">
      <ThemeProvider>
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
                      {/* Replies folded into Leads — deep links land on replied leads. */}
                      <Route path={APP_ROUTE_SEGMENTS.repliesRedirect} element={<RepliesRedirect />} />
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
      </ThemeProvider>
    </ErrorBoundary>
  )
}
