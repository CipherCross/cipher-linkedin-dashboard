/**
 * The provider-path resolver — the one place S27 inverted, and the four flags
 * that share it (`NEON_READS_DEFAULT`, `NEON_WRITES_DEFAULT`,
 * `NEON_AI_PATH_DEFAULT`, and the photo flag's derived half).
 *
 * The four rows below are the deployment states the migration actually has, and
 * one of them — "the owner's, today" — is why the default is derived from the
 * credential rather than simply flipped. A plain inversion resolves that
 * deployment to `neon`, `readNeonConnectionString` throws, and every read 500s:
 * a live dashboard taken down by a merge. Each row is a test, and the last two
 * (an explicit `neon` without a credential, and a refused typo) are the
 * properties whose loss would be *silent*.
 */
import { describe, expect, it } from 'vitest'

import {
  PROVIDER_PATH_VALUES,
  ProviderPathError,
  resolveProviderPath,
} from '../api/_lib/data/providerPath.js'

const VARIABLE = 'NEON_EXAMPLE_PATH'
const held = () => true
const absent = () => false

describe('resolveProviderPath', () => {
  it('resolves `neon` for a tenant: the flag is bound and so is the credential', () => {
    expect(resolveProviderPath(VARIABLE, 'neon', held)).toBe('neon')
  })

  it('resolves `supabase` for a deployment with no flag and no credential', () => {
    // The owner's deployment, today. This is the row that makes the merge safe
    // on its own: no environment change, no ordering hazard, nothing to forget.
    expect(resolveProviderPath(VARIABLE, undefined, absent)).toBe('supabase')
    expect(resolveProviderPath(VARIABLE, '', absent)).toBe('supabase')
    expect(resolveProviderPath(VARIABLE, '   ', absent)).toBe('supabase')
  })

  it('flips itself once the credential arrives, with the flag still unset', () => {
    // The owner's deployment after step 5. The moment it holds a Neon credential
    // is exactly the moment it should stop answering from Supabase.
    expect(resolveProviderPath(VARIABLE, undefined, held)).toBe('neon')
  })

  it('honours an explicit `supabase` from a deployment holding the credential', () => {
    // Deliberately held back. The opt-out has to keep working, or the only way
    // to stay on Supabase would be to give up the credential.
    expect(resolveProviderPath(VARIABLE, 'supabase', held)).toBe('supabase')
  })

  it('keeps an explicit `neon` without a credential, so first use fails loudly', () => {
    // The presence check decides the unset case *only*. If it could override a
    // stated choice, a deployment would read the wrong database while reporting
    // success — the worst outcome this migration has, and a silent one.
    expect(resolveProviderPath(VARIABLE, 'neon', absent)).toBe('neon')
  })

  it('never consults the credential when the value is explicit', () => {
    // Not a performance claim. It is the same property as above, asserted from
    // the other side: a presence check that ran here could grow into one that
    // decides here.
    let asked = 0
    const counting = () => {
      asked += 1
      return false
    }
    resolveProviderPath(VARIABLE, 'neon', counting)
    resolveProviderPath(VARIABLE, 'supabase', counting)
    expect(asked).toBe(0)
  })

  it('trims surrounding whitespace on both values', () => {
    expect(resolveProviderPath(VARIABLE, ' neon ', absent)).toBe('neon')
    expect(resolveProviderPath(VARIABLE, '\tsupabase\n', held)).toBe('supabase')
  })

  it('refuses a value nobody recognises instead of interpreting it', () => {
    // The old rule — anything that is not `neon` means `supabase` — was a safe
    // guess in the old direction. In this one a mistyped opt-out would move a
    // deployment holding the credential onto the provider its live data is not
    // in, so the typo is named rather than resolved.
    for (const value of ['supbase', 'Neon', 'NEON', 'true', '1', 'yes', 'neon2', 'disabled']) {
      expect(() => resolveProviderPath(VARIABLE, value, held)).toThrow(ProviderPathError)
      expect(() => resolveProviderPath(VARIABLE, value, absent)).toThrow(ProviderPathError)
    }
  })

  it('refuses a non-string value the same way, not as unset', () => {
    // An env source is `Record<string, string | undefined>` in types only; a
    // caller passing a parsed config could hand this a number or an object, and
    // reading that as "unset" would make a misconfiguration invisible.
    for (const value of [7, true, {}, []]) {
      expect(() => resolveProviderPath(VARIABLE, value, held)).toThrow(ProviderPathError)
    }
    // `null` and `undefined` are the *absence* of a value, and absence is what
    // the derived default is for.
    expect(resolveProviderPath(VARIABLE, null, absent)).toBe('supabase')
    expect(resolveProviderPath(VARIABLE, undefined, held)).toBe('neon')
  })

  it('names the variable and its legal values in the refusal', () => {
    // The whole point of refusing is diagnosability; an error that did not say
    // which variable it read would be worse than the guess it replaced.
    try {
      resolveProviderPath(VARIABLE, 'supbase', held)
      expect.unreachable('the typo must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderPathError)
      const refusal = error as ProviderPathError
      expect(refusal.variable).toBe(VARIABLE)
      expect(refusal.message).toContain(VARIABLE)
      for (const value of PROVIDER_PATH_VALUES) {
        expect(refusal.message).toContain(`"${value}"`)
      }
    }
  })

  it('lists a caller-supplied vocabulary when there is one', () => {
    // The photo flag has a third legal value (`disabled`) and its refusal has to
    // name it, or the reader goes looking for a bug in the wrong place.
    const refusal = new ProviderPathError('NEON_PHOTOS_DEFAULT', [
      'neon',
      'supabase',
      'disabled',
    ])
    expect(refusal.message).toContain('"disabled"')
  })
})
