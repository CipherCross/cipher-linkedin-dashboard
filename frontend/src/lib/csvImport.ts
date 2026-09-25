import Papa from 'papaparse'
import { normalizeDomain } from './domain'

// Two independent uploads, one parser each:
//   companies export → Airtable DB (for approval), and
//   leads export     → Airtable Contacts (linked to a confirmed Companies record).
//
// The header names target the current export format (`Company Domain`,
// `Linkedin URL Public`, …). Apollo People/Accounts header names are kept as
// aliases so older exports still parse. Everything not named here is dropped
// at this allowlist: email, phone, revenue and every other column never leave
// the browser.

export const CSV_IMPORT_LIMITS = {
  maxFileBytes: 5_000_000,
  maxRows: 500,
} as const

export type CsvFileKind = 'companies' | 'leads'

export interface CsvSource {
  fileName: string
  fileSize: number
  headers: string[]
  rowCount: number
}

export interface CompanyImportRow {
  rowNumber: number
  companyName: string
  /** The raw value the domain was taken from: `Company Domain`, else the website. */
  website: string
  linkedin: string
  country: string
  employees: string
  foundedYear: string
  industry: string
  keywords: string
  description: string
}

export interface LeadImportRow {
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

export interface CompanyCsvDocument extends CsvSource {
  kind: 'companies'
  rows: CompanyImportRow[]
}

export interface LeadCsvDocument extends CsvSource {
  kind: 'leads'
  rows: LeadImportRow[]
}

/** Header aliases per field, first match wins. Compared case-insensitively. */
const COMPANY_COLUMNS = {
  companyName: ['Company Name'],
  domain: ['Company Domain'],
  website: ['Company Website URL', 'Website', 'Company Website'],
  linkedin: ['Company Linkedin URL Unique ID', 'Company Linkedin URL', 'Company Linkedin Url'],
  location: ['Company Location'],
  headquarters: ['Company Headquarters (Full Address)'],
  country: ['Company Country'],
  employees: ['Company Employee Exact Count', '# Employees'],
  foundedYear: ['Company Year Founded', 'Founded Year'],
  industry: ['Company Industry', 'Industry'],
  keywords: ['Company Specialities', 'Company Specialties', 'Keywords'],
  description: ['Company Description', 'Short Description'],
} as const

const LEAD_COLUMNS = {
  personLinkedin: ['Linkedin URL Public', 'Person Linkedin Url', 'LinkedIn URL Public'],
  firstName: ['First Name'],
  lastName: ['Last Name'],
  title: ['Current Job', 'Title', 'Job Title'],
} as const

/** Columns that only a people export has. Their presence decides the file kind. */
const PERSON_SIGNATURE = [...LEAD_COLUMNS.personLinkedin, 'First Name', 'Last Name']

type HeaderMap<T extends Record<string, readonly string[]>> = Record<keyof T, string>

function findHeader(headers: string[], aliases: readonly string[]): string {
  for (const alias of aliases) {
    const found = headers.find((header) => header.toLowerCase() === alias.toLowerCase())
    if (found) return found
  }
  return ''
}

function mapHeaders<T extends Record<string, readonly string[]>>(
  headers: string[],
  columns: T,
): HeaderMap<T> {
  return Object.fromEntries(
    Object.entries(columns).map(([key, aliases]) => [key, findHeader(headers, aliases)]),
  ) as HeaderMap<T>
}

export function detectCsvKind(headers: string[]): CsvFileKind | null {
  if (findHeader(headers, PERSON_SIGNATURE)) return 'leads'
  if (findHeader(headers, COMPANY_COLUMNS.companyName)) return 'companies'
  return null
}

function nonEmptyRows(data: string[][]): string[][] {
  return data.filter((row) => row.some((cell) => String(cell ?? '').trim()))
}

async function parseRawCsv(file: File) {
  if (!file.name.toLowerCase().endsWith('.csv')) {
    throw new Error('Choose a .csv file.')
  }
  if (file.size > CSV_IMPORT_LIMITS.maxFileBytes) {
    throw new Error('The CSV is larger than 5 MB. Split the export and try again.')
  }

  const text = await file.text()
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' })
  const data = nonEmptyRows(parsed.data)
  if (parsed.errors.length) {
    const first = parsed.errors[0]
    throw new Error(`CSV parse error${first.row !== undefined ? ` near row ${first.row + 1}` : ''}: ${first.message}`)
  }
  if (data.length < 2) throw new Error('The CSV has a header but no data rows.')

  const headers = data[0].map((value) => String(value ?? '').replace(/^﻿/, '').trim())
  if (headers.some((header) => !header)) throw new Error('The CSV contains a blank column header.')
  const seen = new Set<string>()
  for (const header of headers) {
    const key = header.toLowerCase()
    if (seen.has(key)) throw new Error(`The CSV contains the duplicate header “${header}”.`)
    seen.add(key)
  }

  const sourceRows = data.slice(1)
  if (sourceRows.length > CSV_IMPORT_LIMITS.maxRows) {
    throw new Error(`The CSV contains ${sourceRows.length} rows. The current limit is ${CSV_IMPORT_LIMITS.maxRows}.`)
  }
  const badWidth = sourceRows.findIndex((row) => row.length !== headers.length)
  if (badWidth >= 0) {
    throw new Error(
      `CSV row ${badWidth + 2} has ${sourceRows[badWidth].length} columns; expected ${headers.length}.`,
    )
  }
  return {
    headers,
    rows: sourceRows.map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, String(values[index] ?? '').trim()])),
    ),
  }
}

/** Whole numbers only. `1,234` and `12.0` are accepted; anything else is blank. */
export function lenientInteger(value: string): string {
  const compact = value.trim().replace(/[\s,_]/g, '')
  const match = /^(\d+)(?:\.0+)?$/.exec(compact)
  if (!match) return ''
  const parsed = Number(match[1])
  return Number.isSafeInteger(parsed) ? String(parsed) : ''
}

/** A plausible founding year, else blank. Exports write `0` for "unknown". */
export function lenientYear(value: string): string {
  const year = lenientInteger(value)
  if (!year) return ''
  const parsed = Number(year)
  return parsed >= 1700 && parsed <= new Date().getUTCFullYear() + 1 ? year : ''
}

/** The last comma segment of a location: `Berlin, Berlin, Germany` → `Germany`. */
export function countryFromLocation(value: string): string {
  const segments = value.split(',').map((segment) => segment.trim()).filter(Boolean)
  return segments[segments.length - 1] ?? ''
}

/** Prefer `Company Domain` when it normalizes; otherwise fall back to the website. */
function pickWebsite(domain: string, website: string): string {
  if (normalizeDomain(domain)) return domain
  if (normalizeDomain(website)) return website
  return domain || website
}

function wrongFile(expected: CsvFileKind, found: CsvFileKind | null): Error {
  if (expected === 'companies' && found === 'leads') {
    return new Error(
      'This looks like a leads export: it has person columns such as “Linkedin URL Public” or “First Name”. Upload it in the Leads → Contacts tab.',
    )
  }
  if (expected === 'leads' && found === 'companies') {
    return new Error(
      'This looks like a companies export: it has company columns but no person columns. Upload it in the Companies → DB tab.',
    )
  }
  return expected === 'companies'
    ? new Error('This does not look like a companies export: “Company Name” is missing.')
    : new Error('This does not look like a leads export: “Linkedin URL Public” is missing.')
}

function companyValues(row: Record<string, string>, map: HeaderMap<typeof COMPANY_COLUMNS>) {
  const value = (key: keyof typeof COMPANY_COLUMNS) => (map[key] ? row[map[key]]?.trim() ?? '' : '')
  return {
    companyName: value('companyName'),
    website: pickWebsite(value('domain'), value('website')),
    linkedin: value('linkedin'),
    country:
      countryFromLocation(value('location')) ||
      countryFromLocation(value('headquarters')) ||
      value('country'),
    employees: lenientInteger(value('employees')),
    foundedYear: lenientYear(value('foundedYear')),
    industry: value('industry'),
    keywords: value('keywords'),
    description: value('description'),
  }
}

export async function parseCompanyCsvFile(file: File): Promise<CompanyCsvDocument> {
  const parsed = await parseRawCsv(file)
  const kind = detectCsvKind(parsed.headers)
  if (kind !== 'companies') throw wrongFile('companies', kind)
  const map = mapHeaders(parsed.headers, COMPANY_COLUMNS)
  if (!map.domain && !map.website) {
    throw new Error('This companies export has neither “Company Domain” nor “Company Website URL”.')
  }
  return {
    kind: 'companies',
    fileName: file.name,
    fileSize: file.size,
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    rows: parsed.rows.map((row, index) => ({ rowNumber: index + 2, ...companyValues(row, map) })),
  }
}

export async function parseLeadCsvFile(file: File): Promise<LeadCsvDocument> {
  const parsed = await parseRawCsv(file)
  const kind = detectCsvKind(parsed.headers)
  const leadMap = mapHeaders(parsed.headers, LEAD_COLUMNS)
  if (kind !== 'leads' || !leadMap.personLinkedin) throw wrongFile('leads', kind)
  const companyMap = mapHeaders(parsed.headers, COMPANY_COLUMNS)
  if (!companyMap.companyName) {
    throw new Error('This leads export has no “Company Name” column, so its leads cannot be linked to companies.')
  }
  return {
    kind: 'leads',
    fileName: file.name,
    fileSize: file.size,
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    rows: parsed.rows.map((row, index) => {
      const value = (key: keyof typeof LEAD_COLUMNS) =>
        leadMap[key] ? row[leadMap[key]]?.trim() ?? '' : ''
      const company = companyValues(row, companyMap)
      const firstName = value('firstName')
      const lastName = value('lastName')
      return {
        rowNumber: index + 2,
        personLinkedin: value('personLinkedin'),
        firstName,
        lastName,
        fullName: [firstName, lastName].filter(Boolean).join(' '),
        title: value('title'),
        companyName: company.companyName,
        companyWebsite: company.website,
        companyLinkedin: company.linkedin,
      }
    }),
  }
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

/** Builds and downloads a row-level report. */
export function downloadCsvReport(
  fileName: string,
  suffix: string,
  headers: string[],
  rows: unknown[][],
) {
  const lines = [headers.map(csvCell).join(','), ...rows.map((row) => row.map(csvCell).join(','))]
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = window.document.createElement('a')
  link.href = url
  link.download = `${fileName.replace(/\.csv$/i, '')}-${suffix}.csv`
  link.click()
  URL.revokeObjectURL(url)
}
