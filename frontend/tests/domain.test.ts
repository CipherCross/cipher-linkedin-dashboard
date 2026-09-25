import { describe, expect, it } from 'vitest'
import { normalizeDomain, parseDomain } from '../src/lib/domain'

describe('company domain normalizer', () => {
  const collapses: Array<[string, string]> = [
    ['clioassist.de', 'clioassist.de'],
    ['https://www.clioassist.de', 'clioassist.de'],
    ['https://www.Acme.com/path', 'acme.com'],
    ['ACME.COM', 'acme.com'],
    ['acme.com.', 'acme.com'],
    ['  http://www.BeWell.help/  ', 'bewell.help'],
    ['BeWell.help', 'bewell.help'],
    ['https://example.com/pricing?utm=1#top', 'example.com'],
    ['https://example.com:8443/', 'example.com'],
    ['https://user:secret@example.com/', 'example.com'],
    ['www2.example.com', 'example.com'],
    ['WWW.EXAMPLE.COM...', 'example.com'],
    ['https://bücher.de', 'xn--bcher-kva.de'],
    ['acme.webflow.io', 'acme.webflow.io'],
    ['https://de.acme.com/', 'de.acme.com'],
    ['http://clubpilates.com/studio/42', 'clubpilates.com'],
  ]
  for (const [input, expected] of collapses) {
    it(`normalizes ${JSON.stringify(input)} → ${expected}`, () => {
      expect(normalizeDomain(input)).toBe(expected)
    })
  }

  it('collapses the listed junk forms to one key', () => {
    const keys = new Set(
      ['https://www.Acme.com/path', 'ACME.COM', 'acme.com.', 'http://acme.com', 'www.acme.com/'].map(normalizeDomain),
    )
    expect([...keys]).toEqual(['acme.com'])
  })

  const rejected: Array<[string, 'missing' | 'invalid' | 'non_company']> = [
    ['', 'missing'],
    ['   ', 'missing'],
    ['true. Women\'s Health', 'invalid'],
    ['SGP s.r.l', 'invalid'],
    ['localhost', 'invalid'],
    ['acme', 'invalid'],
    ['192.168.0.1', 'invalid'],
    ['http://10.0.0.1/admin', 'invalid'],
    ['http://[::1]/', 'invalid'],
    ['example.123', 'invalid'],
    ['ftp://example.com', 'invalid'],
    ['mailto:someone@example.com', 'invalid'],
    ['someone@example.com', 'invalid'],
    ['https://', 'invalid'],
    ['exa mple.com', 'invalid'],
    ['foo_bar.com', 'invalid'],
    ['https://linktr.ee/acme', 'non_company'],
    ['https://www.linkedin.com/company/109209384', 'non_company'],
    ['uk.linkedin.com/company/acme', 'non_company'],
    ['facebook.com/acme', 'non_company'],
    ['m.facebook.com/acme', 'non_company'],
    ['instagram.com/acme', 'non_company'],
    ['x.com/acme', 'non_company'],
    ['twitter.com/acme', 'non_company'],
    ['youtube.com/@acme', 'non_company'],
    ['https://sites.google.com/view/acme', 'non_company'],
    ['google.com', 'non_company'],
    ['bit.ly/3abc', 'non_company'],
  ]
  for (const [input, issue] of rejected) {
    it(`rejects ${JSON.stringify(input)} as ${issue}`, () => {
      expect(parseDomain(input)).toEqual({ domain: '', issue })
    })
  }

  it('keeps x.com-like hosts that only share a suffix with a blocked host', () => {
    expect(normalizeDomain('https://box.com')).toBe('box.com')
    expect(normalizeDomain('mylinkedin.com')).toBe('mylinkedin.com')
  })

  it('only ever returns characters that are safe inside an Airtable formula', () => {
    for (const [input] of collapses) {
      expect(normalizeDomain(input)).toMatch(/^[a-z0-9.-]+$/)
    }
  })

  it('is idempotent', () => {
    for (const [input] of collapses) {
      const once = normalizeDomain(input)
      expect(normalizeDomain(once)).toBe(once)
    }
  })
})
