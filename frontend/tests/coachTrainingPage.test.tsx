// @vitest-environment jsdom
/**
 * The Coach training page over an injected client: opening a conversation
 * runs the working prompt on it, marks reach the server with the run they
 * judge, Improve sends the revision the page saw, a hand edit blocks Publish,
 * and Publish asks first.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CoachTrainingClient, PromptVersion, TrainingCaseDetail, TrainingRun, TrainingState,
} from '../src/lib/coachTraining'

const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn() }
vi.mock('../src/lib/ToastContext', () => ({ useToast: () => toast }))

const { CoachTraining } = await import('../src/pages/CoachTraining')

const version = (n: number, over: Partial<PromptVersion> = {}): PromptVersion => ({
  id: n, n, source: n === 1 ? 'seed' : 'feedback', parent_id: n > 1 ? n - 1 : null, changelog: [], unaddressed: [],
  note: null, created_by_name: 'Trainer', created_at: '2026-10-20T10:00:00Z', prompt: `PROMPT V${n}`, parent_prompt: null, ...over,
})

const output = {
  next_action: 'reply' as const,
  summary: 'Answer the price question.',
  issues: [],
  ideas: [
    { angle: 'Answer first', message: 'Pricing is [price range].', why: 'Direct.' },
    { angle: 'Question', message: 'Is it the whole team?', why: 'Clarifies.' },
  ],
  scope: { hand_written: 0, sequence: 1, message_count: 2, last_sent_at: null },
}

function makeClient() {
  let revision = 1
  let versions = [version(1)]
  let runs: TrainingRun[] = []
  const caseRow = {
    id: 5, instance_id: 'nb', profile_url: 'https://example.test/in/casey', campaign_id: null, cut_after_message_id: null,
    note: null, created_at: '2026-10-20T10:00:00Z', full_name: 'Casey Example', headline: 'Ops lead', message_count: 2,
    last_in_at: null, run_id: null, run_at: null, run_error: null, run_cut_after_message_id: null, pending_feedback: 0,
  }
  const state = (): TrainingState => ({
    scope: 'global', revision, working: versions[versions.length - 1], published: null,
    versions: [...versions].reverse(), cases: [{ ...caseRow, run_id: runs.at(-1)?.id ?? null }],
    pending: { feedback: 1, comments: 1, good: 0, bad: 1, cases: 1 }, leaks: [], max_cases: 25,
  })
  const detail = (): TrainingCaseDetail => ({
    case: caseRow,
    thread: [
      { id: 1, direction: 'out', body: 'Thanks for connecting.', sent_at: '2026-10-18T09:00:00Z', source: 'sync', origin: 'sequence', step_type: 'MessageToPerson', message_ordinal: 1 },
      { id: 2, direction: 'in', body: 'What does it cost?', sent_at: '2026-10-19T09:00:00Z', source: 'sync', origin: null, step_type: null, message_ordinal: null },
    ],
    runs: [...runs].reverse(),
    feedback: [],
  })
  const client = {
    state: vi.fn(async () => state()),
    version: vi.fn(async (id: number) => ({ version: versions.find((v) => v.id === id)! })),
    search: vi.fn(async () => ({ results: [] })),
    caseDetail: vi.fn(async () => detail()),
    addCase: vi.fn(async () => ({ case_id: 5 })),
    setCut: vi.fn(async () => ({ ok: true as const })),
    archiveCase: vi.fn(async () => ({ ok: true as const })),
    run: vi.fn(async (caseId: number, versionId?: number) => {
      const v = versions.find((x) => x.id === versionId) ?? versions[versions.length - 1]
      const run: TrainingRun = {
        id: runs.length + 100, case_id: caseId, version_id: v.id, version_n: v.n, cut_after_message_id: null,
        thread_marker: 'm', output, model: 'test', error: null, created_at: '2026-10-20T10:00:00Z', stale: false,
      }
      runs = [...runs, run]
      return { run }
    }),
    feedback: vi.fn(async (args: { runId: number; target: 'take' | 'idea' | 'issue'; targetIndex: number | null; verdict: 'good' | 'bad' | null; comment: string | null }) => ({
      feedback: {
        id: 1, run_id: args.runId, case_id: 5, version_id: 1, target: args.target, target_index: args.targetIndex,
        verdict: args.verdict, comment: args.comment, consumed_by_version_id: null, created_by_name: 'Trainer', updated_at: 'now',
      },
    })),
    improve: vi.fn(async () => {
      versions = [...versions, version(versions.length + 1, { changelog: ['Answer price questions first'] })]
      revision += 1
      return { version_id: versions.length, n: versions.length, revision, changelog: ['Answer price questions first'], unaddressed: [] }
    }),
    instruct: vi.fn(),
    saveManual: vi.fn(),
    revert: vi.fn(),
    publish: vi.fn(async () => { revision += 1; return { version_id: 1, n: 1, revision } }),
  }
  return client as unknown as CoachTrainingClient & typeof client
}

let client: ReturnType<typeof makeClient>

async function paint(path = '/coach-training?case=5') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <CoachTraining client={client} />
    </MemoryRouter>,
  )
  await act(async () => {})
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  client = makeClient()
})

describe('the Coach training page', () => {
  it('runs the working prompt on an opened conversation once, and shows its take', async () => {
    await paint()
    await waitFor(() => expect(client.run).toHaveBeenCalledWith(5, 1))
    const coach = screen.getByRole('region', { name: 'Coach output' })
    expect(await within(coach).findByText('Pricing is [price range].')).toBeTruthy()
    // The thread is tagged with what produced each message.
    expect(within(screen.getByRole('region', { name: 'Conversation' })).getByText('Sequence · message 1')).toBeTruthy()
    await act(async () => {})
    expect(client.run).toHaveBeenCalledTimes(1)
  })

  it('sends a mark with the run it judges', async () => {
    await paint()
    fireEvent.click(await screen.findByRole('button', { name: 'Idea 2: bad' }))
    await act(async () => {})
    expect(client.feedback).toHaveBeenCalledWith({ runId: 100, target: 'idea', targetIndex: 1, verdict: 'bad', comment: null })
    expect(screen.getByRole('button', { name: 'Idea 2: bad' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('improves against the revision it saw, then shows what changed and re-runs on the new version', async () => {
    await paint()
    await screen.findByText('Pricing is [price range].')
    fireEvent.change(screen.getByRole('textbox', { name: 'General feedback' }), { target: { value: 'Be brief' } })
    fireEvent.click(screen.getByRole('button', { name: 'Improve prompt' }))
    await act(async () => {})
    expect(client.improve).toHaveBeenCalledWith(1, 'Be brief')
    expect(await screen.findByRole('dialog', { name: 'v2 — what changed' })).toBeTruthy()
    expect(screen.getByText('Answer price questions first')).toBeTruthy()
    await waitFor(() => expect(client.run).toHaveBeenCalledWith(5, 2))
  })

  it('blocks Publish while the prompt has an unsaved hand edit, and asks before publishing', async () => {
    await paint()
    fireEvent.click(screen.getByRole('tab', { name: /Prompt v1/ }))
    const editor = screen.getByRole('textbox', { name: 'Coach prompt' }) as HTMLTextAreaElement
    expect(editor.value).toBe('PROMPT V1')
    fireEvent.change(editor, { target: { value: 'PROMPT V1 edited' } })
    const publish = screen.getByRole('button', { name: 'Publish v1' }) as HTMLButtonElement
    expect(publish.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Discard edit' }))
    expect(publish.disabled).toBe(false)
    fireEvent.click(publish)
    const confirm = screen.getByRole('dialog', { name: 'Publish prompt v1?' })
    expect(client.publish).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Publish v1' }))
    await act(async () => {})
    expect(client.publish).toHaveBeenCalledWith(1, 1)
  })
})
