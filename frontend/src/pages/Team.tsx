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
import type { ReactNode } from 'react'
import { ShieldCheck, UserPlus, Users } from 'lucide-react'
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
import {
  Badge, Button, Checkbox, Dialog, EmptyState, InlineError, PageHeader, Panel, SelectField,
  StatusText, Table, TableFrame, TextField, UpdatingNote, useDirtyGuard,
} from '../ui'

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

  const inviteDirty = inviteName.trim() !== '' || inviteEmail.trim() !== '' || inviteRole !== 'member'

  return (
    <>
      <PageHeader
        title="Team"
        description="Everyone can view the directory. Admins manage login access and roles."
        actions={isAdmin && (
          <Button variant="primary" icon={<UserPlus size={18} aria-hidden="true" />} onClick={() => setInviteOpen(true)}>
            Add teammate
          </Button>
        )}
      />

      <TeamSummary loading={loading} items={[
        { label: 'Active teammates', value: activeCount },
        { label: 'Directory entries', value: members.length },
        { label: 'Active admins', value: adminCount },
      ]} />

      {loadError && <InlineError title={loadError} />}

      {inviteOpen && isAdmin && (
        <InviteDialog
          title="Add teammate"
          description="Creates the account and its team membership in one transaction, then emails them a one-time link for setting their own password."
          submitLabel={inviteBusy ? 'Adding…' : 'Add teammate'}
          busy={inviteBusy}
          canSubmit={Boolean(inviteName.trim() && inviteEmail.trim())}
          dirty={inviteDirty}
          onSubmit={() => void submitInvite()}
          onCancel={resetInvite}
        >
          <TextField
            label="Name"
            value={inviteName}
            maxLength={100}
            onChange={(event) => setInviteName(event.target.value)}
            placeholder="Teammate name"
          />
          <TextField
            label="Email"
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="name@company.com"
          />
          <RoleSelect label="Role" value={inviteRole} onChange={setInviteRole} />
        </InviteDialog>
      )}

      <MemberTable
        showActions={isAdmin}
        loading={loading}
        empty={members.length === 0}
      >
        {members.map((row) => {
          const editing = editingUserId === row.userId
          const isCurrent = currentMember?.id === row.id
          return (
            <tr key={row.userId}>
              <td><MemberName name={row.name} current={isCurrent} /></td>
              <td><MemberLogin email={row.email} detail="Login enabled" /></td>
              <td>
                {editing
                  ? <RoleSelect label={`Role for ${row.name}`} labelHidden value={editRole} onChange={setEditRole} />
                  : <RoleMark role={row.role} />}
              </td>
              <td>
                {editing
                  ? <Checkbox label="Active" checked={editActive} onChange={(event) => setEditActive(event.target.checked)} />
                  : <ActiveMark active={row.active} />}
              </td>
              {isAdmin && (
                <td className="text-right whitespace-nowrap">
                  <RowEditActions
                    name={row.name}
                    editing={editing}
                    busy={editBusy}
                    onEdit={() => beginEdit(row)}
                    onSave={() => void saveEdit(row)}
                    onCancel={() => setEditingUserId(null)}
                  />
                </td>
              )}
            </tr>
          )
        })}
      </MemberTable>
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

  const inviteDirty = existingId !== '' || inviteName.trim() !== '' || inviteEmail.trim() !== '' || inviteRole !== 'member'
  const showActions = isAdmin && canManage

  return (
    <>
      <PageHeader
        title="Team"
        description={canManage
          ? 'Everyone can view the directory. Admins manage login access and roles.'
          : 'Read-only directory: this dashboard is reading the team from the application API, '
            + 'whose member ids are not the ones the team writer resolves. Every member here can sign in.'}
        actions={isAdmin && canManage && (
          <Button variant="primary" icon={<UserPlus size={18} aria-hidden="true" />} onClick={() => setInviteOpen(true)}>
            Invite teammate
          </Button>
        )}
      />

      <TeamSummary items={[
        { label: 'Active teammates', value: members.filter((member) => member.active).length },
        { label: 'Login-enabled', value: members.filter(hasLogin).length },
        { label: 'Active admins', value: members.filter((member) => member.role === 'admin' && member.active && hasLogin(member)).length },
      ]} />

      {inviteOpen && isAdmin && canManage && (
        <InviteDialog
          title="Invite teammate"
          description="Link an assignment-only teammate or create a new directory entry."
          submitLabel={inviteBusy ? 'Sending…' : 'Send invitation'}
          busy={inviteBusy}
          canSubmit={Boolean(inviteName.trim() && inviteEmail.trim())}
          dirty={inviteDirty}
          onSubmit={() => void submitInvite()}
          onCancel={resetInvite}
        >
          <SelectField label="Existing teammate" value={existingId} onChange={(event) => chooseExisting(event.target.value)}>
            <option value="">Create new</option>
            {assignmentOnly.map((member) => (
              <option key={member.id} value={member.id}>{member.name}</option>
            ))}
          </SelectField>
          <TextField
            label="Name"
            value={inviteName}
            maxLength={100}
            onChange={(event) => setInviteName(event.target.value)}
            placeholder="Teammate name"
          />
          <TextField
            label="Email"
            type="email"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            placeholder="name@company.com"
          />
          <RoleSelect label="Role" value={inviteRole} onChange={setInviteRole} />
        </InviteDialog>
      )}

      <MemberTable showActions={showActions} loading={false} empty={members.length === 0}>
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
                  <TextField
                    label={`Name for ${teamMember.name}`}
                    labelHidden
                    value={editName}
                    maxLength={100}
                    onChange={(event) => setEditName(event.target.value)}
                  />
                ) : (
                  <MemberName name={teamMember.name} current={isCurrent} />
                )}
              </td>
              <td>
                <MemberLogin
                  email={teamMember.email}
                  detail={hasLogin(teamMember) ? 'Login enabled' : 'Assignment only'}
                />
              </td>
              <td>
                {editing
                  ? <RoleSelect label={`Role for ${teamMember.name}`} labelHidden value={editRole} onChange={setEditRole} />
                  : <RoleMark role={teamMember.role} />}
              </td>
              <td>
                {editing
                  ? <Checkbox label="Active" checked={editActive} onChange={(event) => setEditActive(event.target.checked)} />
                  : <ActiveMark active={teamMember.active} />}
              </td>
              {showActions && (
                <td className="text-right whitespace-nowrap">
                  <RowEditActions
                    name={teamMember.name}
                    editing={editing}
                    busy={editBusy}
                    onEdit={() => beginEdit(teamMember)}
                    onSave={() => void saveEdit()}
                    onCancel={() => setEditingId(null)}
                  />
                </td>
              )}
            </tr>
          )
        })}
      </MemberTable>
    </>
  )
}

// ---------------------------------------------------------------------------
// Presentation shared by both paths. Each receives values and callbacks from
// its path's state; none of them owns a draft, a request or an id.
// ---------------------------------------------------------------------------

type Role = 'member' | 'admin'

/** While the roster is still loading the counts are unknown, not zero. */
function TeamSummary({ items, loading = false }: { items: { label: string; value: number }[]; loading?: boolean }) {
  return (
    <Panel className="mb-app-xl">
      <dl className="m-0 grid grid-cols-3 gap-app-xl max-[700px]:grid-cols-1">
        {items.map((item) => (
          <div className="flex flex-col-reverse gap-app-xs" key={item.label}>
            <dt className="text-app-meta text-app-text-muted">{item.label}</dt>
            <dd className="m-0 text-app-kpi font-semibold tabular-nums">{loading ? '—' : item.value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}

function InviteDialog({
  title, description, submitLabel, busy, canSubmit, dirty, onSubmit, onCancel, children,
}: {
  title: string
  description: string
  submitLabel: string
  busy: boolean
  canSubmit: boolean
  dirty: boolean
  onSubmit: () => void
  onCancel: () => void
  children: ReactNode
}) {
  const { guard, prompt } = useDirtyGuard(dirty && !busy)
  return (
    <>
      <Dialog
        title={title}
        description={description}
        onRequestClose={() => guard(onCancel)}
        busy={busy}
        busyMessage="Wait for the invitation to finish before closing."
        footer={<>
          <Button variant="secondary" disabled={busy} onClick={() => guard(onCancel)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={onSubmit}>{submitLabel}</Button>
        </>}
      >
        <div className="grid grid-cols-2 gap-app-lg max-[700px]:grid-cols-1">{children}</div>
      </Dialog>
      {prompt}
    </>
  )
}

function RoleSelect({ label, labelHidden, value, onChange }: {
  label: string
  labelHidden?: boolean
  value: Role
  onChange: (role: Role) => void
}) {
  return (
    <SelectField label={label} labelHidden={labelHidden} value={value} onChange={(event) => onChange(event.target.value as Role)}>
      <option value="member">Member</option>
      <option value="admin">Admin</option>
    </SelectField>
  )
}

function MemberTable({ showActions, loading, empty, children }: {
  showActions: boolean
  loading: boolean
  empty: boolean
  children: ReactNode
}) {
  return (
    <TableFrame scrollLabel="Team members" className="min-w-0">
      <Table caption="Team members" className="min-w-[720px]">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email / login</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
            {showActions && <th scope="col" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {children}
          {loading && empty && (
            <tr><td colSpan={showActions ? 5 : 4}><UpdatingNote>Loading teammates…</UpdatingNote></td></tr>
          )}
          {!loading && empty && (
            <tr>
              <td colSpan={showActions ? 5 : 4}>
                <EmptyState icon={Users} title="No teammates to show" />
              </td>
            </tr>
          )}
        </tbody>
      </Table>
    </TableFrame>
  )
}

function MemberName({ name, current }: { name: string; current: boolean }) {
  return (
    <span className="inline-flex items-center gap-app-sm font-semibold">
      {name}
      {current && <Badge tone="info">You</Badge>}
    </span>
  )
}

function MemberLogin({ email, detail }: { email: string | null | undefined; detail: string }) {
  return (
    <>
      <div>{email || <span className="text-app-text-muted">No login email</span>}</div>
      <div className="text-app-meta text-app-text-muted">{detail}</div>
    </>
  )
}

function RoleMark({ role }: { role: Role }) {
  return role === 'admin'
    ? <Badge tone="accent" icon={<ShieldCheck size={14} aria-hidden="true" />}>Admin</Badge>
    : <Badge>Member</Badge>
}

function ActiveMark({ active }: { active: boolean }) {
  return (
    <StatusText tone={active ? 'success' : 'neutral'} icon={<span className="size-[7px] rounded-full bg-current" aria-hidden="true" />}>
      {active ? 'Active' : 'Inactive'}
    </StatusText>
  )
}

function RowEditActions({ name, editing, busy, onEdit, onSave, onCancel }: {
  name: string
  editing: boolean
  busy: boolean
  onEdit: () => void
  onSave: () => void
  onCancel: () => void
}) {
  if (!editing) {
    return <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${name}`}>Edit</Button>
  }
  return (
    <span className="inline-flex gap-app-sm">
      <Button variant="primary" size="sm" loading={busy} onClick={onSave}>{busy ? 'Saving…' : 'Save'}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>Cancel</Button>
    </span>
  )
}
