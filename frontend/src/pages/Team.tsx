import { useMemo, useState } from 'react'
import { ShieldCheck, UserPlus } from 'lucide-react'
import { authPost } from '../lib/api'
import { useAuth } from '../lib/AuthContext'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import type { TeamMember } from '../lib/types'

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

export function Team() {
  const { data, refetch } = useData()
  const { member: currentMember, isAdmin, revalidate } = useAuth()
  const toast = useToast()
  const members = data?.teamMembers ?? []
  const assignmentOnly = useMemo(
    () => members.filter((member) => !member.auth_user_id),
    [members],
  )

  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [existingId, setExistingId] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState<'member' | 'admin'>('member')
  const [editActive, setEditActive] = useState(true)
  const [editBusy, setEditBusy] = useState(false)

  if (!data) return null

  const resetInvite = () => {
    setExistingId('')
    setInviteName('')
    setInviteEmail('')
    setInviteRole('member')
    setInviteOpen(false)
  }

  const chooseExisting = (value: string) => {
    setExistingId(value)
    const existing = members.find((member) => String(member.id) === value)
    if (existing) setInviteName(existing.name)
  }

  const submitInvite = async () => {
    if (!inviteName.trim() || !inviteEmail.trim() || inviteBusy) return
    setInviteBusy(true)
    try {
      const response = await authPost('/api/pipeline', {
        action: 'invite_member',
        ...(existingId ? { member_id: Number(existingId) } : {}),
        name: inviteName.trim(),
        email: inviteEmail.trim(),
        role: inviteRole,
      })
      const body = await responseBody(response)
      if (!response.ok) throw new Error(String(body.error ?? `HTTP ${response.status}`))
      toast.success(
        body.invited === false
          ? 'Existing Auth user linked to the team.'
          : 'Invitation sent.',
      )
      resetInvite()
      await refetch()
    } catch (error) {
      toast.error(`Couldn’t invite teammate: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setInviteBusy(false)
    }
  }

  const beginEdit = (member: TeamMember) => {
    setEditingId(member.id)
    setEditName(member.name)
    setEditRole(member.role)
    setEditActive(member.active)
  }

  const saveEdit = async () => {
    if (editingId == null || !editName.trim() || editBusy) return
    setEditBusy(true)
    try {
      const response = await authPost('/api/pipeline', {
        action: 'update_member',
        member_id: editingId,
        name: editName.trim(),
        role: editRole,
        active: editActive,
      })
      const body = await responseBody(response)
      if (!response.ok) throw new Error(String(body.error ?? `HTTP ${response.status}`))
      toast.success('Team member updated.')
      setEditingId(null)
      await refetch()
      if (currentMember?.id === editingId) await revalidate()
    } catch (error) {
      toast.error(`Couldn’t update teammate: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setEditBusy(false)
    }
  }

  return (
    <>
      <header>
        <div>
          <h1>Team</h1>
          <div className="muted small">
            Everyone can view the directory. Admins manage login access and roles.
          </div>
        </div>
        {isAdmin && (
          <button className="btn accent" type="button" onClick={() => setInviteOpen(true)}>
            <UserPlus size={15} />
            Invite teammate
          </button>
        )}
      </header>

      <div className="team-summary card">
        <div>
          <span className="metric-value">{members.filter((member) => member.active).length}</span>
          <span className="metric-label">Active teammates</span>
        </div>
        <div>
          <span className="metric-value">{members.filter((member) => member.auth_user_id).length}</span>
          <span className="metric-label">Login-enabled</span>
        </div>
        <div>
          <span className="metric-value">
            {members.filter((member) => member.role === 'admin' && member.active && member.auth_user_id).length}
          </span>
          <span className="metric-label">Active admins</span>
        </div>
      </div>

      {inviteOpen && isAdmin && (
        <section className="card team-form" aria-label="Invite teammate">
          <div className="team-form-head">
            <div>
              <h2>Invite teammate</h2>
              <p className="muted small">
                Link an assignment-only teammate or create a new directory entry.
              </p>
            </div>
            <button className="btn ghost sm" type="button" onClick={resetInvite}>Cancel</button>
          </div>
          <div className="team-form-grid">
            <label>
              Existing teammate
              <select value={existingId} onChange={(event) => chooseExisting(event.target.value)}>
                <option value="">Create new</option>
                {assignmentOnly.map((member) => (
                  <option key={member.id} value={member.id}>{member.name}</option>
                ))}
              </select>
            </label>
            <label>
              Name
              <input
                value={inviteName}
                maxLength={100}
                onChange={(event) => setInviteName(event.target.value)}
                placeholder="Teammate name"
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="name@company.com"
              />
            </label>
            <label>
              Role
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as 'member' | 'admin')}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </label>
          </div>
          <button
            className="btn accent"
            type="button"
            disabled={inviteBusy || !inviteName.trim() || !inviteEmail.trim()}
            onClick={() => void submitInvite()}
          >
            {inviteBusy ? 'Sending…' : 'Send invitation'}
          </button>
        </section>
      )}

      <section className="card team-table-wrap">
        <table className="team-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email / login</th>
              <th>Role</th>
              <th>Status</th>
              {isAdmin && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {members.map((teamMember) => {
              const editing = editingId === teamMember.id
              const isCurrent = currentMember?.id === teamMember.id
              return (
                <tr key={teamMember.id}>
                  <td>
                    {editing ? (
                      <input
                        value={editName}
                        maxLength={100}
                        onChange={(event) => setEditName(event.target.value)}
                      />
                    ) : (
                      <span className="team-name">
                        {teamMember.name}
                        {isCurrent && <span className="badge">You</span>}
                      </span>
                    )}
                  </td>
                  <td>
                    <div>{teamMember.email || <span className="muted">No login email</span>}</div>
                    <div className="muted small">
                      {teamMember.auth_user_id ? 'Login enabled' : 'Assignment only'}
                    </div>
                  </td>
                  <td>
                    {editing ? (
                      <select
                        value={editRole}
                        onChange={(event) => setEditRole(event.target.value as 'member' | 'admin')}
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    ) : (
                      <span className={`role-badge ${teamMember.role}`}>
                        {teamMember.role === 'admin' && <ShieldCheck size={13} />}
                        {teamMember.role}
                      </span>
                    )}
                  </td>
                  <td>
                    {editing ? (
                      <label className="team-active-toggle">
                        <input
                          type="checkbox"
                          checked={editActive}
                          onChange={(event) => setEditActive(event.target.checked)}
                        />
                        Active
                      </label>
                    ) : (
                      <span className={`status-dot-label ${teamMember.active ? 'active' : 'inactive'}`}>
                        <span aria-hidden="true" />
                        {teamMember.active ? 'Active' : 'Inactive'}
                      </span>
                    )}
                  </td>
                  {isAdmin && (
                    <td className="team-actions">
                      {editing ? (
                        <>
                          <button className="btn accent sm" disabled={editBusy} onClick={() => void saveEdit()}>
                            {editBusy ? 'Saving…' : 'Save'}
                          </button>
                          <button className="btn ghost sm" disabled={editBusy} onClick={() => setEditingId(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="btn ghost sm" onClick={() => beginEdit(teamMember)}>
                          Edit
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
    </>
  )
}
