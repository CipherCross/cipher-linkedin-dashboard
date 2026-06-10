import { useState } from 'react'
import type { Instance } from '../lib/types'
import { instanceName } from '../lib/leads'

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
