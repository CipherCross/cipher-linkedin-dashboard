import type { CSSProperties } from 'react'

// Shimmer placeholders for initial load. The shell (app bar) is already on screen
// by the time these render, so the page fills in place instead of flashing a
// spinner. The shimmer is animation-only, so prefers-reduced-motion (guarded
// globally in styles.css) collapses it to a static block.

export function Skeleton({
  width,
  height,
  radius,
  className = '',
  style,
}: {
  width?: number | string
  height?: number | string
  radius?: number | string
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      className={`skeleton ${className}`.trim()}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden="true"
    />
  )
}

type Variant = 'overview' | 'table' | 'list' | 'simple'

/** Route-appropriate loading state, chosen by Layout from the pathname. */
export function PageSkeleton({ variant }: { variant: Variant }) {
  return (
    <div aria-busy="true">
      <SkelHeader withControl={variant !== 'simple'} />
      {variant === 'overview' && <OverviewSkeleton />}
      {variant === 'table' && <TableSkeleton />}
      {variant === 'list' && <ListSkeleton />}
      {variant === 'simple' && <SimpleSkeleton />}
    </div>
  )
}

function SkelHeader({ withControl }: { withControl: boolean }) {
  return (
    <div className="flex justify-between items-end gap-app-lg flex-wrap mb-5">
      <div className="flex flex-col gap-app-sm min-w-0">
        <Skeleton width={150} height={22} />
        <Skeleton width={260} height={13} />
      </div>
      {withControl && <Skeleton width={190} height={34} radius="var(--radius-md)" />}
    </div>
  )
}

function KpiRowSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-app-lg mb-app-xl">
      {Array.from({ length: 4 }).map((_, i) => (
        <div className="card flex flex-col gap-app-sm min-w-0" key={i}>
          <div className="flex items-center justify-between gap-app-sm">
            <Skeleton width={90} height={12} />
            <Skeleton width={42} height={16} radius="var(--radius-pill)" />
          </div>
          <Skeleton width={72} height={26} />
          <Skeleton width="100%" height={28} style={{ marginTop: 4 }} />
        </div>
      ))}
    </div>
  )
}

function PanelLines({ count = 6 }: { count?: number }) {
  // Deterministic staggered widths so it reads as text without Math.random.
  const widths = ['92%', '78%', '85%', '64%', '88%', '72%', '80%', '58%']
  return (
    <div className="flex flex-col gap-2.5">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} width={widths[i % widths.length]} height={13} />
      ))}
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <>
      <KpiRowSkeleton />
      <div className="card flex flex-col gap-app-sm min-w-0" style={{ marginBottom: 18 }}>
        <Skeleton width={200} height={15} />
        <PanelLines count={3} />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] max-[900px]:grid-cols-1 gap-app-lg">
        {Array.from({ length: 2 }).map((_, i) => (
          <div className="card flex flex-col gap-app-sm min-w-0" key={i}>
            <div className="flex items-center gap-app-md">
              <Skeleton width={40} height={40} radius="50%" />
              <div className="flex flex-col gap-app-sm min-w-0 flex-1">
                <Skeleton width={140} height={16} />
                <Skeleton width={90} height={12} />
              </div>
            </div>
            <Skeleton width="100%" height={44} radius="var(--radius-md)" />
            <PanelLines count={2} />
          </div>
        ))}
      </div>
    </>
  )
}

function TableSkeleton() {
  return (
    <>
      <div className="card flex items-center gap-app-md flex-wrap" style={{ marginBottom: 12 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} width={150} height={34} radius="var(--radius-md)" />
        ))}
      </div>
      <div className="card flex flex-col gap-app-sm min-w-0">
        <Skeleton width="100%" height={14} />
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} width="100%" height={20} />
        ))}
      </div>
    </>
  )
}

function ListSkeleton() {
  return (
    <>
      <Skeleton width={280} height={38} radius="var(--radius-md)" style={{ marginBottom: 12 }} />
      <div className="card flex flex-col gap-app-sm min-w-0">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="flex items-center gap-app-md" key={i}>
            <Skeleton width={34} height={34} radius="50%" />
            <div className="flex flex-col gap-app-sm min-w-0 flex-1">
              <Skeleton width="45%" height={14} />
              <Skeleton width="80%" height={12} />
            </div>
            <Skeleton width={60} height={12} />
          </div>
        ))}
      </div>
    </>
  )
}

function SimpleSkeleton() {
  return (
    <div className="card flex flex-col gap-app-sm min-w-0">
      <Skeleton width={200} height={15} />
      <PanelLines count={10} />
    </div>
  )
}
