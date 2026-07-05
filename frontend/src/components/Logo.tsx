/** Outreach Deck brand mark — a rounded badge with a descending "funnel" glyph.
 *  Mirrors public/favicon.svg. Self-contained colors so it reads on any surface. */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      role="img"
      aria-label="Outreach Deck"
    >
      <defs>
        <linearGradient id="od-logo-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5b9bff" />
          <stop offset="1" stopColor="#4f8ef7" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#od-logo-bg)" />
      <g fill="var(--linkedin-fg)">
        <rect x="8" y="9" width="16" height="4" rx="2" />
        <rect x="10" y="15" width="12" height="4" rx="2" opacity="0.85" />
        <rect x="12" y="21" width="8" height="4" rx="2" opacity="0.7" />
      </g>
    </svg>
  )
}
