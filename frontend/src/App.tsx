import { HashRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import { DataProvider } from './lib/DataContext'
import { ToastProvider } from './lib/ToastContext'
import { ThemeProvider } from './lib/ThemeContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/Layout'
import { Overview } from './pages/Overview'
import { CampaignDetail } from './pages/CampaignDetail'
import { AccountDetail } from './pages/AccountDetail'
import { LeadsExplorer } from './pages/LeadsExplorer'
import { Pipeline } from './pages/Pipeline'
import { Playbook } from './pages/Playbook'
import { Health } from './pages/Health'
import { Chat } from './pages/Chat'
import { Review } from './pages/Review'

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
