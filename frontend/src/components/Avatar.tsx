import { useEffect, useState } from 'react'
import type { Instance, Lead } from '../lib/types'
import { instanceName } from '../lib/leads'
import { leadPhotoUrls, type LeadPhotoSource } from '../lib/leadPhotos'

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

/** A lead's synced profile photo from the private lead-photo bucket. The signed
 * URL expires after five minutes and is minted by whichever path the deployment
 * serves — the authenticated Supabase client, or `/api/activity-daily` against
 * object storage (`src/lib/leadPhotos.ts` chooses). The fixed-size initials
 * fallback prevents layout shift while the URL loads or when delivery fails. */
export function LeadAvatar({
  lead,
  size = 32,
  /**
   * Where signed URLs come from. Defaults to the shared source, which picks the
   * provider by flag; injectable so a rendering test can assert what reaches the
   * `src` attribute without a network or a session.
   */
  photos = leadPhotoUrls,
}: {
  lead: Lead
  size?: number
  photos?: LeadPhotoSource
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const name = lead.full_name || lead.profile_url

  useEffect(() => {
    let current = true
    setUrl(null)
    setFailed(false)
    // The whole lead, not its path: the API path addresses a photo by lead id and
    // must never let the browser name an object key. See `leadPhotos.ts`.
    void photos.get(lead).then((signedUrl) => {
      if (current) setUrl(signedUrl)
    })
    return () => {
      current = false
    }
    // `lead.id` as well as the path: on the API path the id is what identifies the
    // request, so a row swapped in place must re-fetch even if both paths are null.
  }, [lead.id, lead.photo_path])

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
