import { useEffect, useMemo, useState } from 'react'
import {
  Archive, ArchiveRestore, Copy, Pencil, Plus, Search as SearchIcon, Trash2, X,
} from 'lucide-react'
import { useData } from '../lib/DataContext'
import { useToast } from '../lib/ToastContext'
import { adminPost } from '../lib/admin'
import { usePipelineActions } from '../lib/usePipelineActions'
import { ChipInput } from '../components/ChipInput'
import { EmptyState } from '../components/EmptyState'
import { shortDate } from '../lib/format'
import type { SavedSearch } from '../lib/types'

// Free-text platform with UI suggestions — deliberately not an enum ("and
// others" was an explicit requirement).
const PLATFORM_SUGGESTIONS = ['Apollo', 'Sales Navigator', 'esun']

type FilterValue = string | number | boolean | string[]

/** Coerce a scalar filter row's raw text into the flat jsonb value type the
 *  server accepts. Sensible, conservative coercion: exact true/false →
 *  boolean, pure numeric → number, else string. Array-ness is tracked
 *  explicitly per row (`isList`) rather than sniffed from commas here — a
 *  stored scalar like "New York, NY" must never flip into an array just
 *  because it's re-saved untouched.
 *  Note: this still re-coerces on every save, so a stored string that merely
 *  looks numeric (e.g. "10001") becomes a JSON number after any edit cycle. */
function coerceFilterValue(raw: string): Exclude<FilterValue, string[]> {
  const t = raw.trim()
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return t
}

/** Render a stored scalar filter value back into an editable string. */
function scalarValueToInput(v: Exclude<FilterValue, string[]>): string {
  return String(v)
}

interface FilterRow {
  key: string
  value: string
  list: string[]
  isList: boolean
}

interface Draft {
  id?: number
  name: string
  platform: string
  description: string
  include: string[]
  exclude: string[]
  boolean_query: string
  filterRows: FilterRow[]
  notes: string
  author: string
  archived: boolean
}

function toDraft(s: SavedSearch | null, defaultAuthor: string): Draft {
  if (!s)
    return {
      name: '', platform: '', description: '', include: [], exclude: [],
      boolean_query: '', filterRows: [], notes: '', author: defaultAuthor, archived: false,
    }
  return {
    id: s.id,
    name: s.name,
    platform: s.platform,
    description: s.description ?? '',
    include: s.include_keywords ?? [],
    exclude: s.exclude_keywords ?? [],
    boolean_query: s.boolean_query ?? '',
    filterRows: Object.entries(s.filters ?? {}).map(([key, v]) => {
      const isList = Array.isArray(v)
      return {
        key,
        isList,
        // List values are kept as an array end-to-end (chips in, chips out) —
        // never joined into text and re-split, which is what silently broke
        // elements containing a literal comma.
        value: isList ? '' : scalarValueToInput(v as Exclude<FilterValue, string[]>),
        list: isList ? (v as string[]) : [],
      }
    }),
    notes: s.notes ?? '',
    author: s.author ?? '',
    archived: s.archived,
  }
}

export function SearchLibrary() {
  const { data, upsertSavedSearch, removeSavedSearch } = useData()
  const toast = useToast()
  const { actor } = usePipelineActions()

  const [platform, setPlatform] = useState('all')
  const [q, setQ] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  // null = list only; 'new' = create form; a row = edit form.
  const [editing, setEditing] = useState<SavedSearch | 'new' | null>(null)

  const all = data?.savedSearches ?? []

  // Distinct platforms present (for the filter chips), sorted.
  const platforms = useMemo(() => {
    const set = new Set<string>()
    for (const s of all) if (showArchived || !s.archived) set.add(s.platform)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [all, showArchived])

  // Filtered + grouped by platform.
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const rows = all.filter((s) => {
      if (!showArchived && s.archived) return false
      if (platform !== 'all' && s.platform !== platform) return false
      if (needle) {
        const hay = [
          s.name, s.description ?? '', s.boolean_query ?? '',
          ...(s.include_keywords ?? []), ...(s.exclude_keywords ?? []),
        ]
          .join(' ')
          .toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
    const byPlatform = new Map<string, SavedSearch[]>()
    for (const s of rows) {
      const list = byPlatform.get(s.platform) ?? []
      list.push(s)
      byPlatform.set(s.platform, list)
    }
    return [...byPlatform.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, list]) => ({
        name,
        list: list.sort((a, b) => a.name.localeCompare(b.name)),
      }))
  }, [all, q, platform, showArchived])

  const archivedCount = useMemo(() => all.filter((s) => s.archived).length, [all])
  const total = groups.reduce((n, g) => n + g.list.length, 0)

  const copyQuery = async (query: string) => {
    try {
      await navigator.clipboard.writeText(query)
      toast.success('Boolean query copied — paste it into the platform.')
    } catch {
      toast.error("Couldn't copy to clipboard.")
    }
  }

  // Archive / unarchive is a partial save (id + archived only).
  const setArchived = async (s: SavedSearch, archived: boolean) => {
    try {
      const res = await adminPost('/api/playbook', {
        action: 'save_search',
        search: { id: s.id, archived },
      })
      const j = await res.json().catch(() => ({}))
      if (res.status === 401) return toast.error('Wrong admin secret.')
      if (!res.ok) return toast.error(`Couldn't update: ${j.error ?? res.status}`)
      upsertSavedSearch(j.search)
      toast.success(archived ? 'Search archived.' : 'Search restored.')
    } catch (e) {
      toast.error(`Couldn't update: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const del = async (s: SavedSearch) => {
    if (!window.confirm(`Delete “${s.name}”? This can't be undone.`)) return
    try {
      const res = await adminPost('/api/playbook', { action: 'delete_search', id: s.id })
      const j = await res.json().catch(() => ({}))
      if (res.status === 401) return toast.error('Wrong admin secret.')
      if (!res.ok) return toast.error(`Couldn't delete: ${j.error ?? res.status}`)
      removeSavedSearch(s.id)
      toast.success('Search deleted.')
    } catch (e) {
      toast.error(`Couldn't delete: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <>
      <header>
        <div>
          <h1>Searches</h1>
          <div className="muted small">
            Shared sourcing recipes for Apollo, Sales Navigator, esun and others — copy the
            boolean query and paste it into the platform.
          </div>
        </div>
        <div className="controls">
          <button className="btn accent sm" onClick={() => setEditing('new')}>
            <Plus size={14} /> New search
          </button>
        </div>
      </header>

      <div className="filter-bar card">
        <label className="filter-field filter-field-grow">
          <span className="filter-label">Search</span>
          <input
            type="search"
            placeholder="Name, description, keywords…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <div className="filter-field">
          <span className="filter-label">Archived</span>
          <label className="col-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived{archivedCount ? ` (${archivedCount})` : ''}
          </label>
        </div>
      </div>

      {platforms.length > 0 && (
        <div className="active-filters">
          <button
            className={`filter-chip${platform === 'all' ? ' active' : ''}`}
            onClick={() => setPlatform('all')}
          >
            All platforms
          </button>
          {platforms.map((p) => (
            <button
              key={p}
              className={`filter-chip${platform === p ? ' active' : ''}`}
              onClick={() => setPlatform(platform === p ? 'all' : p)}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {total === 0 ? (
        <div className="card">
          <EmptyState
            icon={SearchIcon}
            title={all.length === 0 ? 'No searches yet' : 'No searches match these filters'}
            hint={
              all.length === 0
                ? 'Save a sourcing search so the team can reuse it without a screen-share.'
                : 'Adjust the platform, search text, or archived toggle.'
            }
            action={
              all.length === 0 ? (
                <button className="link-btn" onClick={() => setEditing('new')}>
                  New search
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        groups.map((g) => (
          <section className="search-group" key={g.name}>
            <h2 className="search-group-head">
              {g.name} <span className="muted small">· {g.list.length}</span>
            </h2>
            <div className="search-grid">
              {g.list.map((s) => (
                <SearchCard
                  key={s.id}
                  search={s}
                  onEdit={() => setEditing(s)}
                  onCopy={() => copyQuery(s.boolean_query ?? '')}
                  onArchive={() => setArchived(s, !s.archived)}
                  onDelete={() => del(s)}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {editing && (
        <SearchEditor
          search={editing === 'new' ? null : editing}
          defaultAuthor={actor}
          onClose={() => setEditing(null)}
          onSaved={(row) => {
            upsertSavedSearch(row)
            setEditing(null)
          }}
        />
      )}
    </>
  )
}

function SearchCard({
  search: s,
  onEdit,
  onCopy,
  onArchive,
  onDelete,
}: {
  search: SavedSearch
  onEdit: () => void
  onCopy: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const filterEntries = Object.entries(s.filters ?? {})
  return (
    <article className={`card search-card${s.archived ? ' archived' : ''}`}>
      <div className="search-card-head">
        <div className="search-card-title">
          <span className="search-card-name">{s.name}</span>
          {s.archived && <span className="badge">Archived</span>}
        </div>
        <div className="search-card-actions">
          <button className="icon-only-btn" title="Edit" onClick={onEdit}>
            <Pencil size={14} />
          </button>
          <button
            className="icon-only-btn"
            title={s.archived ? 'Restore' : 'Archive'}
            onClick={onArchive}
          >
            {s.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </button>
          <button className="icon-only-btn danger" title="Delete" onClick={onDelete}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {s.description && <p className="search-card-desc small">{s.description}</p>}

      {((s.include_keywords?.length ?? 0) > 0 || (s.exclude_keywords?.length ?? 0) > 0) && (
        <div className="search-chips">
          {s.include_keywords?.map((k) => (
            <span className="chip include" key={`i-${k}`}>{k}</span>
          ))}
          {s.exclude_keywords?.map((k) => (
            <span className="chip exclude" key={`e-${k}`}>−{k}</span>
          ))}
        </div>
      )}

      {s.boolean_query && (
        <div className="search-query">
          <code className="search-query-text">{s.boolean_query}</code>
          <button className="btn sm" title="Copy boolean query" onClick={onCopy}>
            <Copy size={13} /> Copy
          </button>
        </div>
      )}

      {filterEntries.length > 0 && (
        <dl className="search-filters small">
          {filterEntries.map(([k, v]) => (
            <div className="search-filter-row" key={k}>
              <dt className="muted">{k}</dt>
              <dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}

      {s.notes && <p className="search-card-notes small muted">{s.notes}</p>}

      <div className="search-card-foot muted small">
        {s.author ? `${s.author} · ` : ''}updated {shortDate(s.updated_at)}
      </div>
    </article>
  )
}

function SearchEditor({
  search,
  defaultAuthor,
  onClose,
  onSaved,
}: {
  search: SavedSearch | null
  defaultAuthor: string
  onClose: () => void
  onSaved: (row: SavedSearch) => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState<Draft>(() => toDraft(search, defaultAuthor))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const setFilterRow = (i: number, patch: Partial<FilterRow>) =>
    setDraft((d) => ({
      ...d,
      filterRows: d.filterRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    }))

  const copyQuery = async () => {
    try {
      await navigator.clipboard.writeText(draft.boolean_query)
      toast.success('Boolean query copied.')
    } catch {
      toast.error("Couldn't copy to clipboard.")
    }
  }

  const save = async () => {
    if (!draft.name.trim() || !draft.platform.trim()) {
      setError('Name and platform are required.')
      return
    }
    const filters: Record<string, FilterValue> = {}
    for (const { key, value, list, isList } of draft.filterRows) {
      const k = key.trim()
      if (!k) continue
      filters[k] = isList ? list.map((s) => s.trim()).filter(Boolean) : coerceFilterValue(value)
    }
    const payload = {
      ...(draft.id ? { id: draft.id } : {}),
      name: draft.name.trim(),
      platform: draft.platform.trim(),
      description: draft.description.trim(),
      include_keywords: draft.include,
      exclude_keywords: draft.exclude,
      boolean_query: draft.boolean_query.trim(),
      filters,
      notes: draft.notes.trim(),
      author: draft.author.trim(),
      archived: draft.archived,
    }
    setSaving(true)
    setError(null)
    try {
      const res = await adminPost('/api/playbook', { action: 'save_search', search: payload })
      const j = await res.json().catch(() => ({}))
      if (res.status === 409) {
        setError('A search with this name already exists on this platform.')
        return
      }
      if (res.status === 401) {
        setError('Admin secret is required (or was wrong) to save.')
        return
      }
      if (!res.ok) {
        setError(j.error ?? `Save failed (${res.status}).`)
        return
      }
      onSaved(j.search as SavedSearch)
      toast.success('Search saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="pipe-modal-overlay" onClick={onClose}>
      <div
        className="pipe-modal search-modal"
        role="dialog"
        aria-modal="true"
        aria-label={draft.id ? 'Edit search' : 'New search'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pipe-modal-head">
          <span>{draft.id ? 'Edit search' : 'New search'}</span>
          <button className="conv-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="search-form">
          <div className="search-form-grid">
            <label className="filter-field">
              <span className="filter-label">Name</span>
              <input
                autoFocus
                value={draft.name}
                placeholder="e.g. Fintech VPs, US, 200–1000"
                onChange={(e) => set('name', e.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="filter-label">Platform</span>
              <input
                list="platform-suggestions"
                value={draft.platform}
                placeholder="Apollo / Sales Navigator / esun"
                onChange={(e) => set('platform', e.target.value)}
              />
              <datalist id="platform-suggestions">
                {PLATFORM_SUGGESTIONS.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </label>
          </div>

          <label className="filter-field">
            <span className="filter-label">Description</span>
            <textarea
              rows={2}
              value={draft.description}
              placeholder="What this search targets, in a line or two."
              onChange={(e) => set('description', e.target.value)}
            />
          </label>

          <label className="filter-field">
            <span className="filter-label">Include keywords</span>
            <ChipInput
              values={draft.include}
              variant="include"
              placeholder="Type a keyword, press Enter"
              onChange={(v) => set('include', v)}
            />
          </label>

          <label className="filter-field">
            <span className="filter-label">Exclude keywords</span>
            <ChipInput
              values={draft.exclude}
              variant="exclude"
              placeholder="Type a keyword, press Enter"
              onChange={(v) => set('exclude', v)}
            />
          </label>

          <div className="filter-field">
            <span className="filter-label">
              Boolean query
              <button
                type="button"
                className="btn sm search-copy-inline"
                onClick={copyQuery}
                disabled={!draft.boolean_query.trim()}
              >
                <Copy size={13} /> Copy
              </button>
            </span>
            <textarea
              className="mono"
              rows={3}
              value={draft.boolean_query}
              placeholder={'("VP Sales" OR "Head of Sales") NOT intern'}
              onChange={(e) => set('boolean_query', e.target.value)}
            />
          </div>

          <div className="filter-field">
            <span className="filter-label">Filters</span>
            <div className="kv-editor">
              {draft.filterRows.map((row, i) => (
                <div className="kv-row" key={i}>
                  <input
                    className="kv-key"
                    value={row.key}
                    placeholder="key (e.g. seniority)"
                    onChange={(e) => setFilterRow(i, { key: e.target.value })}
                  />
                  <div className="kv-value">
                    {row.isList ? (
                      <ChipInput
                        values={row.list}
                        variant="include"
                        placeholder="Type a value, press Enter"
                        onChange={(v) => setFilterRow(i, { list: v })}
                      />
                    ) : (
                      <input
                        value={row.value}
                        placeholder="value (text, number, or true/false)"
                        onChange={(e) => setFilterRow(i, { value: e.target.value })}
                      />
                    )}
                  </div>
                  <label className="col-toggle" title="Store as multiple values">
                    <input
                      type="checkbox"
                      checked={row.isList}
                      onChange={(e) => {
                        const checked = e.target.checked
                        // Switch representation explicitly rather than
                        // inferring array-ness from punctuation — see the
                        // coerceFilterValue comment for why.
                        setFilterRow(
                          i,
                          checked
                            ? { isList: true, list: row.value.trim() ? [row.value.trim()] : [] }
                            : { isList: false, value: row.list[0] ?? '' },
                        )
                      }}
                    />
                    List
                  </label>
                  <button
                    type="button"
                    className="icon-only-btn danger"
                    aria-label="Remove filter"
                    onClick={() =>
                      set('filterRows', draft.filterRows.filter((_, idx) => idx !== i))
                    }
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="link-btn"
                onClick={() =>
                  set('filterRows', [
                    ...draft.filterRows,
                    { key: '', value: '', list: [], isList: false },
                  ])
                }
              >
                <Plus size={13} /> Add filter
              </button>
            </div>
          </div>

          <div className="search-form-grid">
            <label className="filter-field">
              <span className="filter-label">Author</span>
              <input
                value={draft.author}
                placeholder="Who owns this search"
                onChange={(e) => set('author', e.target.value)}
              />
            </label>
            <label className="filter-field">
              <span className="filter-label">Notes</span>
              <textarea
                rows={2}
                value={draft.notes}
                placeholder="Anything else worth knowing."
                onChange={(e) => set('notes', e.target.value)}
              />
            </label>
          </div>
        </div>

        {error && <div className="banner conv-error">{error}</div>}

        <div className="pipe-modal-actions">
          <button className="btn ghost sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn accent sm"
            onClick={save}
            disabled={saving || !draft.name.trim() || !draft.platform.trim()}
          >
            {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Create search'}
          </button>
        </div>
      </div>
    </div>
  )
}
