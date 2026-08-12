/**
 * The team directory, on both authenticators — and, inside the Supabase one, on
 * either read path.
 *
 * The two authenticators are not the same page with a different transport, and
 * pretending they were would misreport what an admin is looking at:
 *
 * - **Where the roster comes from.** Supabase reads `team_members` through
 *   `DataContext`; the identity path calls `team.roster`, which is
 *   `public.team_roster()` — membership-gated, seven columns, the same for every
 *   caller.
 *
 * **A third case sits inside `SupabaseTeam`, and it is why this file changed
 * again.** With `NEON_READS_DEFAULT=neon` the Supabase *authenticator* is still
 * what gates the app, but `DataContext` fills `teamMembers` from
 * `public.team_roster()` on the other database. S13's switch left that list
 * empty, and the page dutifully rendered **"0 Active teammates"** over an empty
 * table — a confidently wrong number, which is the one thing this chain refuses
 * everywhere. The roster now arrives, and `data.rosterPath` says whose it is.
 * Three things follow, and each is rendered rather than smoothed:
 *
 * - **Every member is a login.** `team_members.user_id` is `NOT NULL` in the
 *   portable baseline, so "assignment only" is not a rare row there — it is a
 *   state that cannot exist. The count and the per-row label come from the
 *   schema on that path, not from `auth_user_id`, which is `null` on every row
 *   because there is no Supabase Auth user behind it (`toTeamMember` records
 *   the argument for not filling it in).
 * - **Nothing here may be written.** `invite_member` and `update_member` are
 *   keyed on `team_members.id` and resolve it against Supabase whatever the read
 *   path is, so an "Edit" would rename a different person. The controls are
 *   absent, with the reason stated, rather than present and wrong.
 * - **"You" is not marked.** `currentMember.id` comes from the Supabase
 *   authenticator and the rows' ids come from Neon; the same integer names two
 *   people, so the badge would land on the wrong row.
 * - **Assignment-only teammates.** The Supabase schema lets a `team_members` row
 *   exist with no `auth_user_id`, so a person can be assignable without being
 *   able to sign in, and the invite form can link one to a new login. The
 *   portable baseline declares `team_members.user_id uuid NOT NULL`: every
 *   member *is* a login. So that column and that dropdown are absent on the
 *   identity path rather than rendered empty.
 * - **What an admin may change.** Supabase's `/api/pipeline` updates name, role
 *   and active in one call. The identity path has exactly three admin
 *   functions — invite, `setRole`, `setActive` — and none of them renames
 *   anyone, so this page does not offer a name field it could not save.
 * - **Which id an action names.** `admin.setRole`/`admin.setActive` take the
 *   canonical `users.id` uuid; the Supabase path keys on the `team_members.id`
 *   bigint. Both are in the roster row under different names, and the identity
 *   handlers below pass `userId` and nothing else.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ShieldCheck, UserPlus } from 'lucide-react'
import { authPost } from '../lib/api'
import { useAuth } from '../lib/AuthContext'
import { useData } from '../lib/DataContext'
import {
  inviteMember,
  setMemberActive,
  setMemberRole,
  teamRoster,
  type RosterMember,
} from '../lib/identityAuth'
import { teamAdminWritesAllowed } from '../lib/rosterWrites'
import { useToast } from '../lib/ToastContext'
import type { TeamMember } from '../lib/types'

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>
}

export function Team() {
  const { authPath } = useAuth()
  return authPath === 'identity' ? <IdentityTeam /> : <SupabaseTeam />
}

// ---------------------------------------------------------------------------
// The identity path.
// ---------------------------------------------------------------------------

function IdentityTeam() {
  const { member: currentMember, isAdmin, revalidate } = useAuth()
  const toast = useToast()

  const [members, setMembers] = useState<readonly RosterMember[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteName, setInviteName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member')

  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editRole, setEditRole] = useState<'member' | 'admin'>('member')
  const [editActive, setEditActive] = useState(true)
  const [editBusy, setEditBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const roster = await teamRoster()
    if (roster.kind === 'error') {
      setLoadError(roster.message)
      setMembers([])
    } else {
      setLoadError(null)
      setMembers(roster.members)
      // The read is capped at 200 rows server-side. Say so rather than showing
      // a silently truncated directory as though it were the whole team.
      if (roster.hasMore) {
        setLoadError('Showing the first 200 teammates; the directory is longer.')
      }
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const resetInvite = () => {
    setInviteName('')
    setInviteEmail('')
    setInviteRole('member')
    setInviteOpen(false)
  }

  const submitInvite = async () => {
    if (!inviteName.trim() || !inviteEmail.trim() || inviteBusy) return
    setInviteBusy(true)
    try {
      const address = inviteEmail.trim()
      const result = await inviteMember({
        email: address,
        name: inviteName,
        role: inviteRole,
      })
      if (result.kind === 'error') throw new Error(result.message)
      // The account exists with a passphrase nobody knows — not even whoever
      // ran this — so the email carrying the one-time link is the whole route
      // in. When it did not go out the teammate is unreachable, and only the
      // admin standing here knows it: an error toast, which does not
      // auto-dismiss, rather than a success one that scrolls away.
      if (result.warning) {
        toast.error(result.warning)
      } else {
        toast.success(`Teammate created. An invitation email is on its way to ${address}.`)
      }
      resetInvite()
      await load()
    } catch (error) {
      toast.error(
        `Couldn’t add teammate: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      setInviteBusy(false)
    }
  }

  const beginEdit = (row: RosterMember) => {
    setEditingUserId(row.userId)
    setEditRole(row.role)
    setEditActive(row.active)
  }

  /**
   * Save role and activation as the two separate admin calls they are.
   *
   * Role goes first on purpose. Disabling someone revokes their sessions, and
   * an admin editing their own row would otherwise revoke themselves before the
   * role change had been made — leaving the second call to fail against a
   * session that no longer exists, with the first already committed.
   */
  const saveEdit = async (row: RosterMember) => {
    if (editBusy) return
    setEditBusy(true)
    try {
      if (editRole !== row.role) {
        const result = await setMemberRole(row.userId, editRole)
        if (result.kind === 'error') throw new Error(result.message)
      }
      if (editActive !== row.active) {
        const result = await setMemberActive(row.userId, editActive)
        if (result.kind === 'error') throw new Error(result.message)
        if (result.warning) toast.error(result.warning)
      }
      toast.success('Team member updated.')
      setEditingUserId(null)
      await load()
      if (currentMember?.id === row.id) await revalidate()
    } catch (error) {
      toast.error(
        `Couldn’t update teammate: ${error instanceof Error ? error.message : String(error)}`,
      )
      // The roster is reloaded even on failure: one of the two calls may have
      // landed, and leaving the table showing the pre-edit state would hide it.
      await load()
    } finally {
      setEditBusy(false)
    }
  }

  const activeCount = members.filter((row) => row.active).length
  const adminCount = members.filter((row) => row.role === 'admin' && row.active).length

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
            Add teammate
          </button>
        )}
      </header>

      <div className="team-summary card">
        <div>
          <span className="metric-value">{activeCount}</span>
          <span className="metric-label">Active teammates</span>
        </div>
        <div>
          <span className="metric-value">{members.length}</span>
          <span className="metric-label">Directory entries</span>
        </div>
        <div>
          <span className="metric-value">{adminCount}</span>
          <span className="metric-label">Active admins</span>
        </div>
      </div>

      {loadError && (
        <div className="card auth-error" role="alert">
          {loadError}
        </div>
      )}

      {inviteOpen && isAdmin && (
        <section className="card team-form" aria-label="Add teammate">
          <div className="team-form-head">
            <div>
              <h2>Add teammate</h2>
              <p className="muted small">
                Creates the account and its team membership in one transaction,
                then emails them a one-time link for setting their own password.
              </p>
            </div>
            <button className="btn ghost sm" type="button" onClick={resetInvite}>Cancel</button>
          </div>
          <div className="team-form-grid">
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
            {inviteBusy ? 'Adding…' : 'Add teammate'}
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
            {members.map((row) => {
              const editing = editingUserId === row.userId
              const isCurrent = currentMember?.id === row.id
              return (
                <tr key={row.userId}>
                  <td>
                    <span className="team-name">
                      {row.name}
                      {isCurrent && <span className="badge">You</span>}
                    </span>
                  </td>
                  <td>
                    <div>{row.email || <span className="muted">No login email</span>}</div>
                    <div className="muted small">Login enabled</div>
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
                      <span className={`role-badge ${row.role}`}>
                        {row.role === 'admin' && <ShieldCheck size={13} />}
                        {row.role}
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
                      <span className={`status-dot-label ${row.active ? 'active' : 'inactive'}`}>
                        <span aria-hidden="true" />
                        {row.active ? 'Active' : 'Inactive'}
                      </span>
                    )}
                  </td>
                  {isAdmin && (
                    <td className="team-actions">
                      {editing ? (
                        <>
                          <button
                            className="btn accent sm"
                            disabled={editBusy}
                            onClick={() => void saveEdit(row)}
                          >
                            {editBusy ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            className="btn ghost sm"
                            disabled={editBusy}
                            onClick={() => setEditingUserId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="btn ghost sm" onClick={() => beginEdit(row)}>
                          Edit
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
            {!loading && members.length === 0 && (
              <tr>
                <td colSpan={isAdmin ? 5 : 4} className="muted">
                  No teammates to show.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// The Supabase path — unchanged, and the default everywhere today.
// ---------------------------------------------------------------------------

function SupabaseTeam() {
  const { data, refetch } = useData()
  const { member: currentMember, isAdmin, revalidate } = useAuth()
  const toast = useToast()
  const members = data?.teamMembers ?? []
  /**
   * Whose ids these are. `supabase` on every deployment today, in which case
   * every branch below behaves exactly as it always has.
   */
  const rosterPath = data?.rosterPath ?? 'supabase'
  const canManage = teamAdminWritesAllowed(rosterPath)
  /**
   * Whether a row means "can sign in".
   *
   * On the Supabase roster that is `auth_user_id`, a nullable column with real
   * nulls in it. On the portable baseline it is the schema: `user_id uuid NOT
   * NULL`, so the answer is yes for every row and the column that would have
   * said so does not exist there. Reading `auth_user_id` on that path would
   * report the whole team as assignment-only — a different wrong number in place
   * of the one this page just stopped printing.
   */
  const hasLogin = (member: TeamMember): boolean =>
    canManage ? member.auth_user_id !== null : true
  const assignmentOnly = useMemo(
    () => (canManage ? members.filter((member) => !member.auth_user_id) : []),
    [canManage, members],
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
            {canManage
              ? 'Everyone can view the directory. Admins manage login access and roles.'
              : 'Read-only directory: this dashboard is reading the team from the application API, ' +
                'whose member ids are not the ones the team writer resolves. Every member here can sign in.'}
          </div>
        </div>
        {isAdmin && canManage && (
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
          <span className="metric-value">{members.filter(hasLogin).length}</span>
          <span className="metric-label">Login-enabled</span>
        </div>
        <div>
          <span className="metric-value">
            {members.filter((member) => member.role === 'admin' && member.active && hasLogin(member)).length}
          </span>
          <span className="metric-label">Active admins</span>
        </div>
      </div>

      {inviteOpen && isAdmin && canManage && (
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
              {isAdmin && canManage && <th aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {members.map((teamMember) => {
              const editing = editingId === teamMember.id
              // Only when both sides of the comparison are in one id space.
              // `currentMember` is the Supabase authenticator's row; on the Neon
              // roster the same integer names somebody else, so no badge at all
              // beats a badge on the wrong person.
              const isCurrent = canManage && currentMember?.id === teamMember.id
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
                      {hasLogin(teamMember) ? 'Login enabled' : 'Assignment only'}
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
                  {isAdmin && canManage && (
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
            {members.length === 0 && (
              <tr>
                <td colSpan={isAdmin && canManage ? 5 : 4} className="muted">
                  No teammates to show.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  )
}
