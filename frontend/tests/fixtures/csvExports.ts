// Synthetic CSV exports in the current export format. The real attached files
// contain personal data and stay out of the repository; every row here is
// invented, but the headers, the multi-line quoted cells and the data quirks
// (mixed-case domains, `http://www.` websites, `0` founding years, `0.0 ONE`
// revenue, trailing spaces in titles, numeric company LinkedIn IDs, a lead
// whose e-mail domain differs from its company domain) mirror the exports.

const COMPANY_HEADERS = [
  'Company Name',
  'Company Domain',
  'Company Website URL',
  'Company Linkedin URL Unique ID',
  'Company Location',
  'Company Headquarters (Full Address)',
  'Company Industry',
  'Company Employee Exact Count',
  'Company Employee Growth %',
  'Company Year Founded',
  'Company Revenue',
  'Company Type',
  'Company Description',
  'Company Specialities',
  'Department Headcounts',
  'Company Logo URL',
  'Matches Filters',
  'No Match Reasons',
] as const

const PERSON_HEADERS = [
  'First Name',
  'Last Name',
  'Current Job',
  'Linkedin URL Public',
  'Email',
  'Email Status',
  'Phone',
  'Profile Summary',
  'Person Location',
] as const

export type CompanyFixture = Partial<Record<(typeof COMPANY_HEADERS)[number], string>>
export type PersonFixture = Partial<Record<(typeof PERSON_HEADERS)[number], string>>

function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export const companyFixture = (overrides: CompanyFixture = {}): CompanyFixture => ({
  'Company Name': 'Northwind Health',
  'Company Domain': 'NorthwindHealth.example',
  'Company Website URL': 'http://www.northwindhealth.example/',
  'Company Linkedin URL Unique ID': 'https://www.linkedin.com/company/109209384',
  'Company Location': 'Berlin, Berlin, Germany',
  'Company Headquarters (Full Address)': 'Example Str. 1, 10115 Berlin, Germany',
  'Company Industry': 'Hospital & Health Care',
  'Company Employee Exact Count': '42',
  'Company Employee Growth %': '12.5',
  'Company Year Founded': '2019',
  'Company Revenue': '0.0 ONE',
  'Company Type': 'Privately Held',
  'Company Description': 'Invented company, used only in tests.',
  'Company Specialities': 'telehealth, diagnostics',
  'Department Headcounts': 'Engineering: 10\nSales: 4\nOperations: 3',
  'Company Logo URL': 'https://logo.example/northwind.png',
  'Matches Filters': 'true',
  'No Match Reasons': '',
  ...overrides,
})

export const personFixture = (overrides: PersonFixture = {}): PersonFixture => ({
  'First Name': 'Avery',
  'Last Name': 'Example',
  'Current Job': 'Founder & CEO ',
  'Linkedin URL Public': 'https://www.linkedin.com/in/avery-example/',
  Email: 'avery@othermail.example',
  'Email Status': 'verified',
  Phone: '+1 555 0100',
  'Profile Summary': 'Private profile text\nthat must never leave the browser.',
  'Person Location': 'Berlin, Germany',
  ...overrides,
})

export function companiesCsv(rows: CompanyFixture[]): string {
  return [
    COMPANY_HEADERS.join(','),
    ...rows.map((row) => COMPANY_HEADERS.map((header) => cell(row[header] ?? '')).join(',')),
  ].join('\r\n')
}

export function leadsCsv(rows: Array<{ person: PersonFixture; company: CompanyFixture }>): string {
  const headers = [...PERSON_HEADERS, ...COMPANY_HEADERS]
  return [
    headers.join(','),
    ...rows.map(({ person, company }) =>
      [
        ...PERSON_HEADERS.map((header) => cell(person[header] ?? '')),
        ...COMPANY_HEADERS.map((header) => cell(company[header] ?? '')),
      ].join(','),
    ),
  ].join('\r\n')
}

export const csvFile = (text: string, name = 'export.csv') =>
  new File([text], name, { type: 'text/csv' })

/** Private columns that must never appear in anything sent to the server. */
export const PRIVATE_VALUES = [
  'avery@othermail.example',
  'verified',
  '+1 555 0100',
  'Private profile text',
  '0.0 ONE',
  'Engineering: 10',
  'https://logo.example/northwind.png',
]
