import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { DataProvider } from './lib/DataContext'
import { Layout } from './components/Layout'
import { Overview } from './pages/Overview'
import { CampaignDetail } from './pages/CampaignDetail'
import { Accounts } from './pages/Accounts'
import { AccountDetail } from './pages/AccountDetail'
import { LeadsExplorer } from './pages/LeadsExplorer'
import { Replies } from './pages/Replies'
import { Health } from './pages/Health'
import { Chat } from './pages/Chat'

export default function App() {
  return (
    <DataProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Overview />} />
            <Route path="campaign/:id" element={<CampaignDetail />} />
            <Route path="accounts" element={<Accounts />} />
            <Route path="account/:id" element={<AccountDetail />} />
            <Route path="leads" element={<LeadsExplorer />} />
            <Route path="replies" element={<Replies />} />
            <Route path="health" element={<Health />} />
            <Route path="chat" element={<Chat />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    </DataProvider>
  )
}
