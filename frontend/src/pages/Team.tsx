/**
 * The team directory, read through the identity surface.
 *
 * - **Where the roster comes from.** `team.roster`, which is
 *   `public.team_roster()` — membership-gated, seven columns, the same for
 *   every caller.
 * - **Every member is a login.** The portable baseline declares
 *   `team_members.user_id uuid NOT NULL`, so there are no assignment-only
 *   teammates and no column or dropdown for them.
 * - **What an admin may change.** The identity path has exactly three admin
 *   functions — invite, `setRole`, `setActive` — and none of them renames
 *   anyone, so this page does not offer a name field it could not save.
 * - **Which id an action names.** `admin.setRole`/`admin.setActive` take the
 *   canonical `users.id` uuid from the roster row's `userId`, and nothing else.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ShieldCheck, UserPlus, Users } from 'lucide-react'
import { useAuth } from '../lib/AuthContext'
import {
  inviteMember,
  setMemberActive,
  setMemberRole,
  teamRoster,
  type RosterMember,
} from '../lib/identityAuth'
import { useToast } from '../lib/ToastContext'
import {
  Badge, Button, Checkbox, Dialog, EmptyState, InlineError, PageHeader, Panel, SelectField,
  StatusText, Table, TableFrame, TextField, UpdatingNote, useDirtyGuard,
} from '../ui'

export function Team() {
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
          <Button variant="primary" icon={<UserPlus aria-hidden="true" />} onClick={() => setInviteOpen(true)}>
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
// Presentation. Each receives values and callbacks from the page's state; none
// of them owns a draft, a request or an id.
// ---------------------------------------------------------------------------

type Role = 'member' | 'admin'

/** While the roster is still loading the counts are unknown, not zero. */
function TeamSummary({ items, loading = false }: { items: { label: string; value: number }[]; loading?: boolean }) {
  return (
    <Panel className="mb-section">
      <dl className="m-0 grid grid-cols-3 gap-section max-[700px]:grid-cols-1">
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
        <div className="grid grid-cols-2 gap-group max-[700px]:grid-cols-1">{children}</div>
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
