import { describe, expect, it } from 'vitest'
import {
  countryFromLocation,
  detectCsvKind,
  lenientInteger,
  lenientYear,
  parseCompanyCsvFile,
  parseLeadCsvFile,
} from '../src/lib/csvImport'
import {
  PRIVATE_VALUES,
  companiesCsv,
  companyFixture,
  csvFile,
  leadsCsv,
  personFixture,
} from './fixtures/csvExports'

describe('companies export parsing', () => {
  it('maps the export columns to the DB allowlist, including multi-line cells', async () => {
    const document = await parseCompanyCsvFile(csvFile(companiesCsv([companyFixture()])))
    expect(document.kind).toBe('companies')
    expect(document.rows).toEqual([
      {
        rowNumber: 2,
        companyName: 'Northwind Health',
        website: 'NorthwindHealth.example',
        linkedin: 'https://www.linkedin.com/company/109209384',
        country: 'Germany',
        employees: '42',
        foundedYear: '2019',
        industry: 'Hospital & Health Care',
        keywords: 'telehealth, diagnostics',
        description: 'Invented company, used only in tests.',
      },
    ])
  })

  it('falls back to the website when Company Domain is unusable, and blanks a 0 year', async () => {
    const document = await parseCompanyCsvFile(
      csvFile(
        companiesCsv([
          companyFixture({
            'Company Domain': '',
            'Company Website URL': 'http://www.Fallback.example/',
            'Company Year Founded': '0',
            'Company Location': '',
          }),
        ]),
      ),
    )
    expect(document.rows[0]).toMatchObject({
      website: 'http://www.Fallback.example/',
      foundedYear: '',
      country: 'Germany',
    })
  })

  it('never carries unmapped columns (revenue, headcounts, logo) into a row', async () => {
    const document = await parseCompanyCsvFile(csvFile(companiesCsv([companyFixture()])))
    const serialized = JSON.stringify(document.rows)
    for (const value of PRIVATE_VALUES) expect(serialized).not.toContain(value)
  })

  it('accepts an older Apollo Accounts export through the aliases', async () => {
    const csv = [
      'Company Name,Website,Company Linkedin Url,Company Country,# Employees,Industry,Keywords,Short Description,Founded Year,Apollo Record Id',
      'Analytical Engines,https://analytical.example,http://www.linkedin.com/company/analytical-engines/,United Kingdom,"1,200",Computer Software,"analysis, engines",A computing company.,1843,abc',
    ].join('\n')
    const [row] = (await parseCompanyCsvFile(csvFile(csv))).rows
    expect(row).toMatchObject({
      companyName: 'Analytical Engines',
      website: 'https://analytical.example',
      country: 'United Kingdom',
      employees: '1200',
      foundedYear: '1843',
      keywords: 'analysis, engines',
    })
  })

  it('rejects a leads export with a pointer to the right tab', async () => {
    const csv = leadsCsv([{ person: personFixture(), company: companyFixture() }])
    await expect(parseCompanyCsvFile(csvFile(csv))).rejects.toThrow('Leads → Contacts tab')
  })

  it('rejects a file that is neither export', async () => {
    await expect(parseCompanyCsvFile(csvFile('Name,URI\nAcme,https://acme.example\n'))).rejects.toThrow(
      '“Company Name” is missing',
    )
  })
})

describe('leads export parsing', () => {
  it('maps person and company columns and trims the title', async () => {
    const csv = leadsCsv([{ person: personFixture(), company: companyFixture() }])
    const document = await parseLeadCsvFile(csvFile(csv))
    expect(document.kind).toBe('leads')
    expect(document.rows).toEqual([
      {
        rowNumber: 2,
        personLinkedin: 'https://www.linkedin.com/in/avery-example/',
        firstName: 'Avery',
        lastName: 'Example',
        fullName: 'Avery Example',
        title: 'Founder & CEO',
        companyName: 'Northwind Health',
        companyWebsite: 'NorthwindHealth.example',
        companyLinkedin: 'https://www.linkedin.com/company/109209384',
      },
    ])
  })

  it('drops email, email status, phone and profile summary at the allowlist', async () => {
    const csv = leadsCsv([{ person: personFixture(), company: companyFixture() }])
    const serialized = JSON.stringify((await parseLeadCsvFile(csvFile(csv))).rows)
    for (const value of PRIVATE_VALUES) expect(serialized).not.toContain(value)
    expect(serialized).not.toContain('othermail')
  })

  it('accepts an older Apollo People export through the aliases', async () => {
    const csv = [
      'First Name,Last Name,Title,Company Name,Person Linkedin Url,Website,Company Linkedin Url,Email',
      'Ada,Lovelace,"Founder, CEO",Analytical Engines,https://www.linkedin.com/in/ada-lovelace/,https://analytical.example,https://www.linkedin.com/company/analytical-engines/,ada@example.test',
    ].join('\r\n')
    const [row] = (await parseLeadCsvFile(csvFile(csv))).rows
    expect(row).toMatchObject({
      personLinkedin: 'https://www.linkedin.com/in/ada-lovelace/',
      title: 'Founder, CEO',
      companyWebsite: 'https://analytical.example',
    })
    expect(JSON.stringify(row)).not.toContain('ada@example.test')
  })

  it('rejects a companies export with a pointer to the right tab', async () => {
    await expect(parseLeadCsvFile(csvFile(companiesCsv([companyFixture()])))).rejects.toThrow(
      'Companies → DB tab',
    )
  })
})

describe('shared parsing rules', () => {
  it('detects the file kind from the header signature', () => {
    expect(detectCsvKind(['Company Name', 'Company Domain'])).toBe('companies')
    expect(detectCsvKind(['First Name', 'Company Name'])).toBe('leads')
    expect(detectCsvKind(['Person Linkedin Url'])).toBe('leads')
    expect(detectCsvKind(['Name', 'URI'])).toBeNull()
  })

  it('parses numbers leniently', () => {
    expect(lenientInteger('1,234')).toBe('1234')
    expect(lenientInteger('12.0')).toBe('12')
    expect(lenientInteger('0.0 ONE')).toBe('')
    expect(lenientInteger('12.5')).toBe('')
    expect(lenientYear('0')).toBe('')
    expect(lenientYear('1699')).toBe('')
    expect(lenientYear('2019')).toBe('2019')
    expect(lenientYear(String(new Date().getUTCFullYear() + 5))).toBe('')
  })

  it('takes the country from the last location segment', () => {
    expect(countryFromLocation('Austin, Texas, United States')).toBe('United States')
    expect(countryFromLocation('Germany')).toBe('Germany')
    expect(countryFromLocation('')).toBe('')
  })

  it('rejects duplicate headers, a ragged row and an oversized file', async () => {
    await expect(parseCompanyCsvFile(csvFile('Company Name,company name\na,b\n'))).rejects.toThrow('duplicate header')
    await expect(parseCompanyCsvFile(csvFile('Company Name,Company Domain\na,b\nc,d,e\n'))).rejects.toThrow('row 3 has 3 columns')
    const rows = Array.from({ length: 501 }, (_, index) => `Co ${index},co${index}.example`)
    await expect(
      parseCompanyCsvFile(csvFile(['Company Name,Company Domain', ...rows].join('\n'))),
    ).rejects.toThrow('limit is 500')
  })
})
