import type { ReactNode } from 'react'

/**
 * One way to render a person or an account, everywhere.
 *
 * Two people named "Mykyta" appeared in the Overview, Follow-ups, Leads and
 * Sequence-hub selectors with nothing to tell them apart. The rule: show the
 * name, and add the account label whenever the name alone is ambiguous. Never
 * invent a human name out of a profile slug — an unknown contact is a
 * "LinkedIn contact" plus whatever identifier we do have.
 */

export const UNKNOWN_PERSON_LABEL = 'LinkedIn contact'

/** `name` when it is unique in `allNames`, otherwise `name · account`. */
export function disambiguate(
  name: string | null | undefined,
  accountLabel: string | null | undefined,
  allNames: readonly (string | null | undefined)[],
): string {
  const resolved = (name ?? '').trim()
  if (!resolved) return accountLabel ? `${UNKNOWN_PERSON_LABEL} · ${accountLabel}` : UNKNOWN_PERSON_LABEL
  const duplicates = allNames.filter((candidate) => (candidate ?? '').trim() === resolved).length
  return duplicates > 1 && accountLabel ? `${resolved} · ${accountLabel}` : resolved
}

export function initialsOf(name: string | null | undefined): string {
  const raw = (name ?? '').trim()
  // A profile URL is not a name: take its slug, not the "in" path segment a
  // naive prefix strip leaves behind.
  const source = /^https?:\/\//.test(raw)
    ? raw.replace(/\/+$/, '').split('/').pop() ?? ''
    : raw
  if (!source) return '?'
  return (
    source
      .split(/[\s·]+/)
      .map((word) => word[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  )
}

export function AccountIdentity({
  name, secondary, avatar, className = '', title,
}: {
  name: ReactNode
  /** Account, campaign or role — quieter than the name, never the same weight. */
  secondary?: ReactNode
  avatar?: ReactNode
  className?: string
  title?: string
}) {
  return (
    <span className={`ui-identity ${className}`.trim()}>
      {avatar}
      <span className="ui-identity__copy">
        <span className="ui-identity__name" title={title}>{name}</span>
        {secondary && <span className="ui-identity__secondary">{secondary}</span>}
      </span>
    </span>
  )
}

export function InitialsBadge({ name }: { name: string | null | undefined }) {
  return (
    <span className="ui-identity__avatar" aria-hidden="true">
      {initialsOf(name)}
    </span>
  )
}
