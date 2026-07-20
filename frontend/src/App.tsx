import { lazy } from 'react'
import { HashRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import { DataProvider } from './lib/DataContext'
import { ToastProvider } from './lib/ToastContext'
import { ThemeProvider } from './lib/ThemeContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/Layout'

// Pages are code-split so each route ships its own chunk — the initial bundle no
// longer carries all nine. These modules use named exports, so map to default.
const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })))
const CampaignDetail = lazy(() => import('./pages/CampaignDetail').then((m) => ({ default: m.CampaignDetail })))
const AccountDetail = lazy(() => import('./pages/AccountDetail').then((m) => ({ default: m.AccountDetail })))
const LeadsExplorer = lazy(() => import('./pages/LeadsExplorer').then((m) => ({ default: m.LeadsExplorer })))
const Pipeline = lazy(() => import('./pages/Pipeline').then((m) => ({ default: m.Pipeline })))
const Playbook = lazy(() => import('./pages/Playbook').then((m) => ({ default: m.Playbook })))
const SearchLibrary = lazy(() => import('./pages/SearchLibrary').then((m) => ({ default: m.SearchLibrary })))
const Icp = lazy(() => import('./pages/Icp').then((m) => ({ default: m.Icp })))
const Hypotheses = lazy(() => import('./pages/Hypotheses').then((m) => ({ default: m.Hypotheses })))
const Health = lazy(() => import('./pages/Health').then((m) => ({ default: m.Health })))
const Chat = lazy(() => import('./pages/Chat').then((m) => ({ default: m.Chat })))
const Review = lazy(() => import('./pages/Review').then((m) => ({ default: m.Review })))

/** Replies folded into Leads, but old deep links carried a `sentiment` query
 *  param (positive/curious/neutral/negative/later/other/unclassified) — forward
 *  it as-is to /leads, defaulting to `any` when absent. */
function RepliesRedirect() {
  const [params] = useSearchParams()
  const sentiment = params.get('sentiment') ?? 'any'
  return <Navigate to={`/leads?sentiment=${encodeURIComponent(sentiment)}`} replace />
}

export default function App() {
  return (
    <ErrorBoundary variant="screen">
      <ThemeProvider>
      <DataProvider>
        <ToastProvider>
        <HashRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Overview />} />
              <Route path="campaign/:id" element={<CampaignDetail />} />
              <Route path="accounts" element={<Navigate to="/" replace />} />
              <Route path="account/:id" element={<AccountDetail />} />
              <Route path="leads" element={<LeadsExplorer />} />
              <Route path="pipeline" element={<Pipeline />} />
              {/* Replies folded into Leads — deep links land on replied leads. */}
              <Route path="replies" element={<RepliesRedirect />} />
              <Route path="review" element={<Review />} />
              <Route path="playbook" element={<Playbook />} />
              <Route path="searches" element={<SearchLibrary />} />
              <Route path="icp" element={<Icp />} />
              <Route path="hypotheses" element={<Hypotheses />} />
              <Route path="health" element={<Health />} />
              <Route path="chat" element={<Chat />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </HashRouter>
        </ToastProvider>
      </DataProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}
