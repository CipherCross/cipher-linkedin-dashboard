// The Airtable bases the CSV importers can write to. Each base is a copy of the
// same layout (DB → Companies → Contacts, same table and field IDs), so one
// importer serves all of them; only the base ID differs. The server maps each
// key to its own env var (see `BASE_ENV` in api/_lib/airtable.ts), and a base
// whose env var is unset answers 503 rather than falling back to another base.

export const AIRTABLE_BASES = [
  { id: 'web2mob', label: 'Web 2 Mob' },
  { id: 'fintech_arabic', label: 'Fintech (Arabic)' },
] as const

export type AirtableBaseId = (typeof AIRTABLE_BASES)[number]['id']

/** The base a request without a `base` field means: the only one before Fintech (Arabic). */
export const DEFAULT_AIRTABLE_BASE: AirtableBaseId = 'web2mob'

export function isAirtableBase(value: unknown): value is AirtableBaseId {
  return AIRTABLE_BASES.some((base) => base.id === value)
}

export function airtableBaseLabel(id: AirtableBaseId): string {
  return AIRTABLE_BASES.find((base) => base.id === id)?.label ?? id
}
