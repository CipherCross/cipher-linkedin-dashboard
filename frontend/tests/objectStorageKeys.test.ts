/**
 * Tenant object-key isolation: what the grammar accepts, and the much longer
 * list of what it refuses.
 *
 * The deny cases are written as a table on purpose. `keys.ts` accepts a small
 * character set rather than blocking a list of tricks, so each row here
 * *documents* a property that already holds rather than creating it — which is
 * the difference between this and the blocklist in `src/lib/leadPhotos.ts` that
 * it will eventually replace. If a future change turns the allowlist back into
 * a blocklist, these rows go red together rather than one at a time.
 */

import { describe, expect, it } from 'vitest'

import {
  assertKeyBelongsToTenant,
  buildTenantObjectKey,
  isValidKeySegment,
  MAX_OBJECT_KEY_LENGTH,
  ObjectKeyError,
  parseTenantObjectKey,
} from '../api/_lib/storage/keys.js'

const TENANT = 'acme'

describe('building a tenant object key', () => {
  it('produces the documented namespaced shape', () => {
    expect(
      buildTenantObjectKey({
        tenantId: TENANT,
        objectClass: 'lead-photos',
        segments: ['notebook-1', 'jane-doe.jpg'],
      }),
    ).toBe('t/acme/lead-photos/notebook-1/jane-doe.jpg')
  })

  it('round-trips through the parser', () => {
    const key = buildTenantObjectKey({
      tenantId: TENANT,
      objectClass: 'lead-photos',
      segments: ['notebook-1', 'jane-doe.jpg'],
    })
    expect(parseTenantObjectKey(key)).toEqual({
      tenantId: TENANT,
      objectClass: 'lead-photos',
      segments: ['notebook-1', 'jane-doe.jpg'],
    })
  })

  it('refuses an object class that is not on the allowlist', () => {
    expect(() =>
      buildTenantObjectKey({
        tenantId: TENANT,
        // Deliberately outside the union: the check must survive a caller that
        // reached this with an unchecked string from a request body.
        objectClass: 'invoices' as 'lead-photos',
        segments: ['a.pdf'],
      }),
    ).toThrow(ObjectKeyError)
  })

  it('refuses a key with no segments', () => {
    expect(() =>
      buildTenantObjectKey({
        tenantId: TENANT,
        objectClass: 'lead-photos',
        segments: [],
      }),
    ).toThrow(ObjectKeyError)
  })

  it('refuses a key over the provider byte limit', () => {
    const segment = 'a'.repeat(200)
    expect(() =>
      buildTenantObjectKey({
        tenantId: TENANT,
        objectClass: 'lead-photos',
        segments: Array.from({ length: 8 }, () => segment),
      }),
    ).toThrow(/bytes, over the 1024-byte limit/)
    expect(MAX_OBJECT_KEY_LENGTH).toBe(1024)
  })
})

describe('segments the grammar refuses', () => {
  const REFUSED: ReadonlyArray<readonly [string, string]> = [
    ['..', 'parent traversal'],
    ['.', 'current directory'],
    ['...', 'a dot run that is not an extension'],
    ['%2e%2e', 'percent-encoded traversal'],
    ['a/b', 'an embedded separator'],
    ['a\\b', 'a backslash separator'],
    ['a?b', 'a query delimiter'],
    ['a#b', 'a fragment delimiter'],
    ['', 'an empty segment'],
    [' a', 'a leading space'],
    ['a ', 'a trailing space'],
    ['a\u0000b', 'an embedded NUL'],
    ['a\nb', 'an embedded newline'],
    ['ａ', 'a full-width homoglyph'],
    ['a／b', 'a full-width solidus'],
    ['.hidden', 'a leading dot'],
    ['a.', 'a trailing dot'],
    ['a.b.c', 'more than one extension'],
    ['a.toolongext', 'an over-long extension'],
  ]

  for (const [segment, why] of REFUSED) {
    it(`refuses ${why}`, () => {
      expect(isValidKeySegment(segment)).toBe(false)
      expect(() =>
        buildTenantObjectKey({
          tenantId: TENANT,
          objectClass: 'lead-photos',
          segments: [segment],
        }),
      ).toThrow(ObjectKeyError)
    })
  }
})

describe('keys the parser refuses', () => {
  const REFUSED: ReadonlyArray<readonly [unknown, string]> = [
    ['', 'the empty string'],
    [null, 'null'],
    [42, 'a number'],
    ['lead-photos/a.jpg', 'a key with no tenant namespace'],
    ['/t/acme/lead-photos/a.jpg', 'an absolute path'],
    ['t/acme/lead-photos', 'a key with no segment'],
    ['t/acme/lead-photos//a.jpg', 'a doubled separator'],
    ['t/acme/lead-photos/a.jpg/', 'a trailing separator'],
    ['t/acme/lead-photos/../../etc/passwd', 'traversal out of the class'],
    ['t/acme/invoices/a.pdf', 'an unlisted object class'],
    ['t/ACME/lead-photos/a.jpg', 'an upper-case tenant'],
    ['T/acme/lead-photos/a.jpg', 'an upper-case namespace'],
    ['https://evil.example/t/acme/lead-photos/a.jpg', 'an absolute URL'],
  ]

  for (const [key, why] of REFUSED) {
    it(`refuses ${why}`, () => {
      expect(() => parseTenantObjectKey(key)).toThrow(ObjectKeyError)
    })
  }
})

describe('binding a key to one tenant', () => {
  it('accepts a key belonging to the tenant', () => {
    const key = 't/acme/lead-photos/a.jpg'
    expect(assertKeyBelongsToTenant(key, 'acme').tenantId).toBe('acme')
  })

  it("refuses another tenant's key", () => {
    expect(() =>
      assertKeyBelongsToTenant('t/globex/lead-photos/a.jpg', 'acme'),
    ).toThrow(ObjectKeyError)
  })

  /**
   * The reason `assertKeyBelongsToTenant` parses instead of comparing a
   * prefix. `'t/acme-evil/…'.startsWith('t/acme/')` is false, but the sloppier
   * spelling — `startsWith('t/' + tenantId)` — accepts it, and that spelling is
   * the one someone reaches for first.
   */
  it('refuses a tenant id that merely starts with the bound tenant', () => {
    expect(() =>
      assertKeyBelongsToTenant('t/acme-evil/lead-photos/a.jpg', 'acme'),
    ).toThrow(ObjectKeyError)
  })

  it('refuses a bound tenant id that is not a legal tenant id', () => {
    expect(() =>
      assertKeyBelongsToTenant('t/acme/lead-photos/a.jpg', '../acme'),
    ).toThrow(ObjectKeyError)
  })

  it('does not name the key owner in its refusal', () => {
    // A refusal should not become a way to enumerate which tenants exist.
    try {
      assertKeyBelongsToTenant('t/globex/lead-photos/a.jpg', 'acme')
      expect.unreachable('should have refused')
    } catch (error) {
      expect((error as Error).message).not.toContain('globex')
    }
  })
})
