import { useEffect, useState } from 'react'
import { Globe } from 'lucide-react'
import { coachContextClient, type CoachContextClient } from '../lib/coachContext'
import { useToast } from '../lib/ToastContext'
import { Button, InlineError, Panel, SaveStatus, SectionHeader, TextField, TextareaField } from '../ui'
import { Skeleton } from './Skeleton'

const PLACEHOLDER = `What we sell, to whom, and why it works. For example:
- What we do: …
- Who it is for: …
- Proof: clients, numbers, case studies the team may mention
- What we never claim: …`

/**
 * "Our company" — what the coach may say about us in every idea. Fetch reads
 * our website as a starting point; the team edits it down to what is true and
 * worth saying, then saves. Admins edit, everyone reads.
 */
export function OurCompanyPanel({
  isAdmin,
  client = coachContextClient,
}: {
  isAdmin: boolean
  client?: Pick<CoachContextClient, 'ourCompany' | 'saveOurCompany' | 'fetchWebsite'>
}) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [website, setWebsite] = useState('')
  const [saved, setSaved] = useState<{ text: string; website: string } | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'save' | 'fetch'>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    client.ourCompany()
      .then((row) => {
        if (cancelled) return
        setText(row.our_company)
        setWebsite(row.our_website ?? '')
        setSaved({ text: row.our_company, website: row.our_website ?? '' })
        setSavedAt(row.updated_at)
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
    return () => { cancelled = true }
  }, [client, attempt])

  const dirty = !!saved && (text.trim() !== saved.text.trim() || website.trim() !== saved.website.trim())

  const fetchSite = async () => {
    setBusy('fetch')
    try {
      const page = await client.fetchWebsite(website.trim())
      if (page.thin) toast.info('The site returned very little text — it may render with JavaScript. Write the summary by hand.')
      const draft = page.text.slice(0, 6000)
      setText((current) => (current.trim() ? `${current.trim()}\n\n--- From ${page.url} ---\n${draft}` : draft))
    } catch (e) {
      toast.error(`Couldn't read the website: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    setBusy('save')
    try {
      const row = await client.saveOurCompany(text.trim(), website.trim() || null)
      setSaved({ text: row.our_company, website: row.our_website ?? '' })
      setSavedAt(row.updated_at)
      toast.success('Saved — every coach uses it from the next take.')
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel className="mt-section" aria-label="Our company">
      <SectionHeader
        title="Our company"
        description="What the AI coach may say about us in every idea. Keep it to facts the team stands behind."
        actions={
          <span className="inline-flex items-center gap-inline">
            <SaveStatus state={busy === 'save' ? 'saving' : dirty ? 'dirty' : 'saved'} />
            <Button variant="primary" onClick={() => void save()} loading={busy === 'save'} disabled={!isAdmin || !dirty}
              title={isAdmin ? undefined : 'Admin access required'}>
              {dirty ? 'Save' : 'Saved'}
            </Button>
          </span>
        }
      />
      {error && <InlineError title="Our company could not load." message={error} onRetry={() => setAttempt((n) => n + 1)} />}
      {!saved && !error && <Skeleton height={160} radius="var(--radius-control)" />}
      {saved && (
        <div className="flex flex-col gap-group">
          <div className="flex items-end gap-inline">
            <TextField
              className="flex-1"
              label="Our website"
              placeholder="https://ciphercross.com"
              value={website}
              disabled={!isAdmin}
              onChange={(e) => setWebsite(e.target.value)}
            />
            <Button
              variant="secondary"
              icon={<Globe aria-hidden="true" />}
              disabled={!isAdmin || !website.trim()}
              loading={busy === 'fetch'}
              loadingLabel="Reading the website…"
              onClick={() => void fetchSite()}
            >
              Fetch website text
            </Button>
          </div>
          <TextareaField
            label="What we sell, to whom, and our proof points"
            rows={12}
            value={text}
            placeholder={PLACEHOLDER}
            disabled={!isAdmin}
            help={savedAt ? `Last saved ${new Date(savedAt).toLocaleDateString('en-GB')}. Fetched text is a draft — edit it down before saving.` : 'Fetched text is a draft — edit it down before saving.'}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      )}
    </Panel>
  )
}
