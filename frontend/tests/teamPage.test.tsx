// @vitest-environment jsdom
/**
 * Team is the Phase 3 reference for the directory/table/row-action/dialog
 * grammar. These pin what the redesign must not have changed: who sees the
 * management controls, which admin call each edit makes, that the invite form
 * asks before discarding a draft, and that failed and empty reads say so.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthContext, type AuthContextValue } from '../src/lib/AuthContext'
import type { RosterMember } from '../src/lib/identityAuth'

const identity = vi.hoisted(() => ({
  teamRoster: vi.fn(),
  inviteMember: vi.fn(),
  setMemberRole: vi.fn(),
  setMemberActive: vi.fn(),
}))
const data = vi.hoisted(() => ({ value: null as unknown }))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('../src/lib/identityAuth', () => identity)
vi.mock('../src/lib/DataContext', () => ({ useData: () => ({ data: data.value, refetch: vi.fn() }) }))
vi.mock('../src/lib/ToastContext', () => ({ useToast: () => toast }))

import { Team } from '../src/pages/Team'

const ROSTER: RosterMember[] = [
  { id: 1, userId: 'u-1', name: 'Ada Admin', email: 'ada@x.test', role: 'admin', active: true, createdAt: '2026-01-01' },
  { id: 2, userId: 'u-2', name: 'Max Member', email: 'max@x.test', role: 'member', active: true, createdAt: '2026-01-01' },
]

function auth(isAdmin: boolean, authPath: 'identity' | 'supabase' = 'identity'): AuthContextValue {
  return {
    status: 'ready', authPath, user: null, isAdmin, error: null,
    member: { id: 1, name: 'Ada Admin', role: isAdmin ? 'admin' : 'member' } as never,
    signIn: vi.fn(), requestPasswordReset: vi.fn(), setPassword: vi.fn(), signOut: vi.fn(), revalidate: vi.fn(async () => {}),
  } as AuthContextValue
}

async function renderTeam(value: AuthContextValue) {
  render(<AuthContext.Provider value={value}><Team /></AuthContext.Provider>)
  await act(async () => {})
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  identity.teamRoster.mockResolvedValue({ kind: 'ok', members: ROSTER, hasMore: false })
  identity.inviteMember.mockResolvedValue({ kind: 'ok' })
  identity.setMemberRole.mockResolvedValue({ kind: 'ok' })
  identity.setMemberActive.mockResolvedValue({ kind: 'ok' })
})

describe('Team on the identity path', () => {
  it('gives an admin the invite action and per-row Edit, with counts in the summary', async () => {
    await renderTeam(auth(true))
    expect(screen.getByRole('button', { name: 'Add teammate' })).toBeTruthy()
    const table = screen.getByRole('table', { name: 'Team members' })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(table).getByRole('button', { name: 'Edit Max Member' })).toBeTruthy()
    expect(within(table).getByText('You')).toBeTruthy()
    const summary = screen.getByText('Active admins').closest('div')!
    expect(summary.textContent).toContain('1')
  })

  it('shows a member the directory without any management control', async () => {
    await renderTeam(auth(false))
    expect(screen.queryByRole('button', { name: 'Add teammate' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull()
    expect(screen.getByText('Max Member')).toBeTruthy()
  })

  it('invites through a dialog and asks before discarding a typed draft', async () => {
    await renderTeam(auth(true))
    fireEvent.click(screen.getByRole('button', { name: 'Add teammate' }))
    const dialog = screen.getByRole('dialog', { name: 'Add teammate' })
    const submit = within(dialog).getByRole('button', { name: 'Add teammate' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'New Person' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeTruthy()
    const prompt = screen.getByRole('dialog', { name: 'Discard unsaved changes?' })
    fireEvent.click(within(prompt).getAllByRole('button', { name: 'Keep editing' }).at(-1)!)
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('New Person')

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@x.test' } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } })
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: 'Add teammate' })).getByRole('button', { name: 'Add teammate' })) })
    expect(identity.inviteMember).toHaveBeenCalledWith({ email: 'new@x.test', name: 'New Person', role: 'admin' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(toast.success).toHaveBeenCalled()
  })

  it('closes a clean invite dialog at once', async () => {
    await renderTeam(auth(true))
    fireEvent.click(screen.getByRole('button', { name: 'Add teammate' }))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('saves a role change with setRole only, leaving activation alone', async () => {
    await renderTeam(auth(true))
    fireEvent.click(screen.getByRole('button', { name: 'Edit Max Member' }))
    fireEvent.change(screen.getByLabelText('Role for Max Member'), { target: { value: 'admin' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(identity.setMemberRole).toHaveBeenCalledWith('u-2', 'admin')
    expect(identity.setMemberActive).not.toHaveBeenCalled()
  })

  it('shows unknown counts, not zeros, while the roster loads', async () => {
    identity.teamRoster.mockReturnValueOnce(new Promise(() => {}))
    await renderTeam(auth(true))
    expect(screen.getByText('Active teammates').closest('div')!.textContent).toContain('—')
    expect(screen.getByRole('status').textContent).toContain('Loading teammates…')
  })

  it('reports a failed roster read and an empty directory', async () => {
    identity.teamRoster.mockResolvedValueOnce({ kind: 'error', message: 'Roster read failed: 503' })
    await renderTeam(auth(true))
    expect(screen.getByRole('alert').textContent).toContain('Roster read failed: 503')
    expect(screen.getByText('No teammates to show')).toBeTruthy()
  })
})

describe('Team on the Supabase authenticator', () => {
  const member = (id: number, name: string, auth_user_id: string | null) => ({
    id, name, email: `${id}@x.test`, role: 'member', active: true, created_at: '2026-01-01', auth_user_id,
  })

  it('is read-only on the application-API roster', async () => {
    data.value = { rosterPath: 'neon', teamMembers: [member(5, 'Neon Person', null)] }
    await renderTeam(auth(true, 'supabase'))
    expect(screen.queryByRole('button', { name: 'Invite teammate' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
    expect(screen.getByText('Login enabled')).toBeTruthy()
  })

  it('stays read-only on the Supabase roster too: its writer is retired', async () => {
    data.value = { rosterPath: 'supabase', teamMembers: [member(1, 'Ada Admin', 'a'), member(7, 'Assign Only', null)] }
    await renderTeam(auth(true, 'supabase'))
    expect(screen.queryByRole('button', { name: 'Invite teammate' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
    expect(screen.getAllByText('Login enabled')).toHaveLength(2)
  })
})
