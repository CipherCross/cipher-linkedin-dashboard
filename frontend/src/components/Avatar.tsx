import { useState } from 'react'
import type { Instance, Lead } from '../lib/types'
import { instanceName, leadPhotoUrl } from '../lib/leads'

/** Initials-only circular avatar for entities without a photo (e.g. leads —
 *  LinkedIn contacts have no synced avatar). Neutral fill so it never competes
 *  with the sentiment colours around it. */
export function InitialsAvatar({ name, size = 32 }: { name: string; size?: number }) {
  const initials =
    name
      .replace(/https?:\/\/[^\s]*\//, '')
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  return (
    <span
      className="avatar fallback lead"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden="true"
    >
      {initials}
    </span>
  )
}

/** A lead's synced profile photo (from the public `lead-photos` bucket) with an
 *  initials fallback. The box is a fixed size on either path (photo or initials)
 *  so a slow/broken image never shifts layout; a broken image swaps to initials
 *  via onError. Photos are display-only — never an inference input. */
export function LeadAvatar({ lead, size = 32 }: { lead: Lead; size?: number }) {
  const [failed, setFailed] = useState(false)
  const url = leadPhotoUrl(lead)
  const name = lead.full_name || lead.profile_url
  if (!url || failed) return <InitialsAvatar name={name} size={size} />
  return (
    <img
      className="avatar"
      src={url}
      width={size}
      height={size}
      alt={name}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

/** LinkedIn profile photo with an initials fallback — avatar URLs from
 *  media.licdn.com are signed and can expire between syncs. */
export function Avatar({ inst, size = 32 }: { inst: Instance; size?: number }) {
  const [failed, setFailed] = useState(false)
  const name = instanceName(inst, '?')

  if (!inst.account_avatar || failed) {
    const initials = name
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase()
    return (
      <span
        className="avatar fallback"
        style={{ width: size, height: size, fontSize: size * 0.38 }}
      >
        {initials}
      </span>
    )
  }
  return (
    <img
      className="avatar"
      src={inst.account_avatar}
      width={size}
      height={size}
      alt={name}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}
