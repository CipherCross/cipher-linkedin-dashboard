import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'
import { DataProvider } from './lib/DataContext'
import { AuthProvider, useAuth, type AppRole } from './lib/auth'
import { Layout } from './components/Layout'
import { Login } from './pages/Login'
import { Overview } from './pages/Overview'
import { CampaignDetail } from './pages/CampaignDetail'
import { AccountDetail } from './pages/AccountDetail'
import { LeadsExplorer } from './pages/LeadsExplorer'
import { Replies } from './pages/Replies'
import { Health } from './pages/Health'
import { Chat } from './pages/Chat'
import { Members } from './pages/Members'

// Route guard: redirect to Overview if the user lacks the minimum role. The
// server re-checks roles on every /api call, so this is UX, not the security
// boundary.
function RequireRole({ min, children }: { min: AppRole; children: ReactNode }) {
  const { hasRole } = useAuth()
  return hasRole(min) ? <>{children}</> : <Navigate to="/" replace />
}

function AuthedApp() {
  const { loading, configured, session } = useAuth()

  if (loading) {
    return <div className="center muted login-page">Loading…</div>
  }
  if (!configured || !session) {
    return <Login />
  }

  return (
    <DataProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Overview />} />
            <Route path="campaign/:id" element={<CampaignDetail />} />
            <Route path="accounts" element={<Navigate to="/" replace />} />
            <Route path="account/:id" element={<AccountDetail />} />
            <Route path="leads" element={<LeadsExplorer />} />
            <Route path="replies" element={<Replies />} />
            <Route path="health" element={<Health />} />
            <Route
              path="chat"
              element={
                <RequireRole min="member">
                  <Chat />
                </RequireRole>
              }
            />
            <Route
              path="members"
              element={
                <RequireRole min="admin">
                  <Members />
                </RequireRole>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </DataProvider>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AuthedApp />
    </AuthProvider>
  )
}
