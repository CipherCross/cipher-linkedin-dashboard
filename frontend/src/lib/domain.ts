// The one company-domain normalizer. The CSV parser in the browser and the
// Airtable importer on the server both call it, so a domain is compared and
// written in exactly one form: a bare lower-case hostname such as
// `clioassist.de`. Scheme, credentials, port, path, query, fragment, `www.`,
// case and trailing dots are removed; IDN hosts become punycode.
//
// Subdomains other than `www<n>.` are deliberately kept. There is no
// public-suffix collapsing, so `acme.webflow.io` and `de.acme.com` are never
// merged into another company.

/**
 * Hosts that identify a platform rather than a company. A website that
 * normalizes to one of these (or a subdomain of one) is "no usable domain".
 */
export const NON_COMPANY_HOSTS: readonly string[] = [
  'linktr.ee',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'google.com',
  'sites.google.com',
  'bit.ly',
]

export type DomainIssue = 'missing' | 'invalid' | 'non_company'

export type DomainResult =
  | { domain: string; issue: null }
  | { domain: ''; issue: DomainIssue }

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

export function isNonCompanyHost(host: string): boolean {
  return NON_COMPANY_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))
}

export function parseDomain(value: string | null | undefined): DomainResult {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return { domain: '', issue: 'missing' }
  if (/\s/.test(trimmed)) return { domain: '', issue: 'invalid' }

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)
  if (scheme && !/^https?$/i.test(scheme[1])) return { domain: '', issue: 'invalid' }
  // `mailto:a@b.com` or a bare e-mail address is not a website.
  if (!scheme && /^[^/]*@/.test(trimmed)) return { domain: '', issue: 'invalid' }

  let host: string
  try {
    host = new URL(scheme ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return { domain: '', issue: 'invalid' }
  }

  host = host.toLowerCase().replace(/\.+$/, '').replace(/^www\d*\./, '')
  if (!host || host.startsWith('[') || IPV4.test(host)) return { domain: '', issue: 'invalid' }

  const labels = host.split('.')
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return { domain: '', issue: 'invalid' }
  }
  if (!TLD.test(labels[labels.length - 1])) return { domain: '', issue: 'invalid' }
  if (isNonCompanyHost(host)) return { domain: '', issue: 'non_company' }
  return { domain: host, issue: null }
}

/** The bare company domain, or `''` when the value has no usable one. */
export function normalizeDomain(value: string | null | undefined): string {
  return parseDomain(value).domain
}

export const DOMAIN_ISSUE_LABEL: Record<DomainIssue, string> = {
  missing: 'No company domain or website',
  invalid: 'The company website is not a valid domain',
  non_company: 'The company website is a platform page (LinkedIn, Linktree, …), not a company domain',
}
