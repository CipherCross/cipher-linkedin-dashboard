// Shared sync-freshness tiers. Agents run every ~30 min, so a notebook whose
// last sync is <2h old is healthy, <24h is aging (worth a look), and ≥24h — or
// never synced — is stale. Used by the header SyncChip (Layout) and the Health
// page account dots so both read the same thresholds.

export type FreshnessLevel = 'ok' | 'warn' | 'stale'

/** Tier for a single instance's most recent sync timestamp. */
export function freshnessLevel(lastSyncAt: string | null | undefined): FreshnessLevel {
  if (!lastSyncAt) return 'stale'
  const hours = (Date.now() - new Date(lastSyncAt).getTime()) / 3_600_000
  return hours >= 24 ? 'stale' : hours >= 2 ? 'warn' : 'ok'
}
