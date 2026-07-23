import Papa from 'papaparse'

export const CSV_IMPORT_LIMITS = {
  maxFileBytes: 5_000_000,
  maxRows: 500,
} as const

export const TARGET_FIELDS = [
  'personLinkedin',
  'firstName',
  'lastName',
  'title',
  'companyName',
  'companyWebsite',
  'companyLinkedin',
] as const

export type TargetField = (typeof TARGET_FIELDS)[number]
export type CsvMapping = Record<TargetField, string>

export interface CsvDocument {
  fileName: string
  fileSize: number
  headers: string[]
  rows: Record<string, string>[]
  mapping: CsvMapping
  warnings: string[]
}

export interface ContactImportRow {
  rowNumber: number
  personLinkedin: string
  firstName: string
  lastName: string
  fullName: string
  title: string
  companyName: string
  companyWebsite: string
  companyLinkedin: string
}

export interface ImportRowOutcome {
  rowNumber: number
  status: string
  detail?: string
  contactId?: string
  companyId?: string
  companyName?: string
}

export const TARGET_LABELS: Record<TargetField, string> = {
  personLinkedin: 'Person LinkedIn',
  firstName: 'First name',
  lastName: 'Last name',
  title: 'Title',
  companyName: 'Company name',
  companyWebsite: 'Company website',
  companyLinkedin: 'Company LinkedIn',
}

export const REQUIRED_TARGETS = new Set<TargetField>([
  'personLinkedin',
  'firstName',
  'lastName',
  'title',
  'companyName',
])

const APOLLO_MAPPING: CsvMapping = {
  personLinkedin: 'Person Linkedin Url',
  firstName: 'First Name',
  lastName: 'Last Name',
  title: 'Title',
  companyName: 'Company Name',
  companyWebsite: 'Website',
  companyLinkedin: 'Company Linkedin Url',
}

function blankMapping(): CsvMapping {
  return {
    personLinkedin: '',
    firstName: '',
    lastName: '',
    title: '',
    companyName: '',
    companyWebsite: '',
    companyLinkedin: '',
  }
}

function findHeader(headers: string[], wanted: string): string {
  return headers.find((header) => header.toLowerCase() === wanted.toLowerCase()) ?? ''
}

export function suggestApolloMapping(headers: string[]): CsvMapping {
  const mapping = blankMapping()
  for (const target of TARGET_FIELDS) {
    mapping[target] = findHeader(headers, APOLLO_MAPPING[target])
  }
  return mapping
}

function nonEmptyRows(data: string[][]): string[][] {
  return data.filter((row) => row.some((cell) => String(cell ?? '').trim()))
}

export async function parseCsvFile(file: File): Promise<CsvDocument> {
  if (!file.name.toLowerCase().endsWith('.csv')) {
    throw new Error('Choose a .csv file exported from Apollo.')
  }
  if (file.size > CSV_IMPORT_LIMITS.maxFileBytes) {
    throw new Error('The CSV is larger than 5 MB. Split the Apollo export and try again.')
  }

  const text = await file.text()
  const parsed = Papa.parse<string[]>(text, {
    skipEmptyLines: 'greedy',
  })
  const data = nonEmptyRows(parsed.data)
  if (parsed.errors.length) {
    const first = parsed.errors[0]
    throw new Error(`CSV parse error${first.row !== undefined ? ` near row ${first.row + 1}` : ''}: ${first.message}`)
  }
  if (data.length < 2) throw new Error('The CSV has a header but no contact rows.')

  const headers = data[0].map((value) => String(value ?? '').replace(/^\uFEFF/, '').trim())
  if (headers.some((header) => !header)) {
    throw new Error('The CSV contains a blank column header.')
  }
  const seen = new Set<string>()
  for (const header of headers) {
    const key = header.toLowerCase()
    if (seen.has(key)) throw new Error(`The CSV contains the duplicate header “${header}”.`)
    seen.add(key)
  }

  const sourceRows = data.slice(1)
  if (sourceRows.length > CSV_IMPORT_LIMITS.maxRows) {
    throw new Error(`The CSV contains ${sourceRows.length} rows. The current limit is 500.`)
  }
  const badWidth = sourceRows.findIndex((row) => row.length !== headers.length)
  if (badWidth >= 0) {
    throw new Error(
      `CSV row ${badWidth + 2} has ${sourceRows[badWidth].length} columns; expected ${headers.length}.`,
    )
  }

  const mapping = suggestApolloMapping(headers)
  if (!mapping.personLinkedin && headers.includes('URI') && headers.includes('LinkedIn')) {
    throw new Error('This looks like an Ensun company export. This importer accepts Apollo people exports only.')
  }
  if (!mapping.personLinkedin) {
    throw new Error('This does not look like an Apollo people export: “Person Linkedin Url” is missing.')
  }

  const warnings: string[] = []
  if (!mapping.companyWebsite) warnings.push('Website was not found; company matching will use LinkedIn and name.')
  if (!mapping.companyLinkedin) warnings.push('Company Linkedin Url was not found; company matching will use website and name.')

  const rows = sourceRows.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? '').trim()])),
  )
  return {
    fileName: file.name,
    fileSize: file.size,
    headers,
    rows,
    mapping,
    warnings,
  }
}

export function mappingErrors(mapping: CsvMapping): string[] {
  const errors: string[] = []
  for (const target of REQUIRED_TARGETS) {
    if (!mapping[target]) errors.push(`${TARGET_LABELS[target]} is required.`)
  }
  const selected = TARGET_FIELDS.map((target) => mapping[target]).filter(Boolean)
  const duplicates = selected.filter((header, index) => selected.indexOf(header) !== index)
  if (duplicates.length) errors.push(`A source column can only be mapped once: ${[...new Set(duplicates)].join(', ')}.`)
  return errors
}

export function buildContactRows(document: CsvDocument, mapping: CsvMapping): ContactImportRow[] {
  const errors = mappingErrors(mapping)
  if (errors.length) throw new Error(errors[0])
  const value = (row: Record<string, string>, target: TargetField) =>
    mapping[target] ? row[mapping[target]]?.trim() ?? '' : ''

  return document.rows.map((row, index) => {
    const firstName = value(row, 'firstName')
    const lastName = value(row, 'lastName')
    return {
      rowNumber: index + 2,
      personLinkedin: value(row, 'personLinkedin'),
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' '),
      title: value(row, 'title'),
      companyName: value(row, 'companyName'),
      companyWebsite: value(row, 'companyWebsite'),
      companyLinkedin: value(row, 'companyLinkedin'),
    }
  })
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

export function downloadImportResults(
  fileName: string,
  rows: ContactImportRow[],
  outcomes: ImportRowOutcome[],
) {
  const byRow = new Map(outcomes.map((outcome) => [outcome.rowNumber, outcome]))
  const headers = [
    'Source Row',
    'Person LinkedIn',
    'Full Name',
    'Title',
    'Company',
    'Import Status',
    'Detail',
    'Airtable Contact ID',
    'Airtable Company ID',
  ]
  const lines = [
    headers.map(csvCell).join(','),
    ...rows.map((row) => {
      const result = byRow.get(row.rowNumber)
      return [
        row.rowNumber,
        row.personLinkedin,
        row.fullName,
        row.title,
        result?.companyName ?? row.companyName,
        result?.status ?? 'not_imported',
        result?.detail ?? '',
        result?.contactId ?? '',
        result?.companyId ?? '',
      ]
        .map(csvCell)
        .join(',')
    }),
  ]
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = window.document.createElement('a')
  link.href = url
  link.download = `${fileName.replace(/\.csv$/i, '')}-import-results.csv`
  link.click()
  URL.revokeObjectURL(url)
}
