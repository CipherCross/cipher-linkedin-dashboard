/**
 * The machine token: what it looks like, how it is hashed, and the three admin
 * operations that mint, retire and list the credentials behind it.
 *
 * ## The token is two halves, and both are required
 *
 * `lha.<credential id>.<secret>` — a fixed prefix, the credential's uuid, and 32
 * bytes of CSPRNG output in base64url. The database stores a SHA-256 of the
 * secret half and never the secret itself.
 *
 * The separator is a dot because base64url's alphabet is `[A-Za-z0-9_-]`: an
 * underscore separator was written first, and a test issuing real secrets caught
 * it immediately — roughly three tokens in four carry an underscore or a hyphen
 * of their own, so the parse split into four parts and refused a token this
 * process had just minted. A dot cannot occur in either half.
 *
 * Carrying the id in the token rather than looking a credential up by its secret
 * buys two things. A request can be *logged* by credential id, which is what an
 * operator needs to answer "which notebook did this?", without the log line
 * containing anything that authenticates. And the lookup is by primary key with
 * the hash as a second condition, so the stored hash is never the index a caller
 * can probe — presenting a secret alone is not a query this system can answer.
 *
 * ## Why SHA-256 and not a password KDF
 *
 * The secret is 256 bits from `randomBytes`, so there is no dictionary to run
 * against it and no human memory that shortened it: an attacker holding the hash
 * faces 2^256 candidates whether the function is fast or slow. What a slow KDF
 * would buy — resistance to guessing a *low-entropy* input — is not a property
 * this input lacks. What matters instead is that the comparison is constant-time
 * and that the secret is never stored, and both are true.
 *
 * `timingSafeEqual` guards the one comparison this file performs. The database's
 * own comparison is ordinary SQL equality, and `009_machine_ingest_path.sql`
 * section E states why that is acceptable: what leaks is the hash, which the
 * caller must already hold to be asking.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import type { ActorContext, DataStore } from '../data/contracts.js'
import {
  AGENT_ADMIN_COMMANDS,
  AGENT_ADMIN_OPERATIONS,
  type CredentialDirectoryRow,
  type IssuedCredential,
  type RevokedCredential,
} from '../data/operations/index.js'

/** Recognisable, greppable, and not a word that appears in ordinary text. */
export const AGENT_TOKEN_PREFIX = 'lha'
/** Outside base64url's alphabet, which is the whole reason it is this and not `_`. */
const TOKEN_SEPARATOR = '.'

/** 32 bytes. Base64url, so the token survives a header and a shell alike. */
const SECRET_BYTES = 32
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MAX_CREDENTIAL_LABEL = 200
export const MAX_REVOKE_REASON = 500
/** Step 009's `agent_credential_tenant_id_check`, restated where it is built. */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

export interface ParsedAgentToken {
  readonly credentialId: string
  readonly secret: string
}

/** Generate a secret. Never logged, never stored, returned exactly once. */
export function generateAgentSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

export function formatAgentToken(credentialId: string, secret: string): string {
  return [AGENT_TOKEN_PREFIX, credentialId, secret].join(TOKEN_SEPARATOR)
}

/**
 * Parse a presented token, or `null`.
 *
 * Every refusal is the same `null`: a token with the wrong prefix, a malformed
 * id, a secret of the wrong length and a token with extra separators are
 * indistinguishable to the caller, because distinguishing them would tell
 * somebody probing the endpoint which half they got right.
 */
export function parseAgentToken(raw: unknown): ParsedAgentToken | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  const parts = value.split(TOKEN_SEPARATOR)
  if (parts.length !== 3) return null
  const [prefix, credentialId, secret] = parts
  if (prefix !== AGENT_TOKEN_PREFIX) return null
  if (!UUID_PATTERN.test(credentialId)) return null
  if (!SECRET_PATTERN.test(secret)) return null
  return { credentialId: credentialId.toLowerCase(), secret }
}

/** Read a presented token out of an `Authorization: Bearer …` header. */
export function tokenFromAuthorization(header: string | null): ParsedAgentToken | null {
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!match) return null
  return parseAgentToken(match[1])
}

export function hashAgentSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/**
 * Constant-time hash comparison, for the one place this process compares two
 * hashes itself rather than asking the database to.
 */
export function secretHashMatches(left: string, right: string): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

// ---------------------------------------------------------------------------
// The admin operations.
// ---------------------------------------------------------------------------

export interface IssueCredentialInput {
  readonly tenantId: string
  readonly instanceId: string
  readonly label?: string
  /** ISO-8601. Absent means a credential that does not expire on its own. */
  readonly expiresAt?: string | null
}

export class AgentCredentialError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AgentCredentialError'
    this.status = status
  }
}

/**
 * Validate an issue request. Separated from the call so every rule is reachable
 * by a test that needs no database — the endpoint that performs the call
 * resolves an actor first and is therefore not reachable offline at all.
 */
export function parseIssueInput(body: unknown): IssueCredentialInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentCredentialError(400, 'a JSON object body is required')
  }
  const record = body as Record<string, unknown>

  const tenantId = String(record.tenant_id ?? '').trim()
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new AgentCredentialError(
      400,
      'tenant_id must be lowercase alphanumeric with hyphens, 1-63 characters',
    )
  }

  const instanceId = String(record.instance_id ?? '').trim()
  if (instanceId === '' || instanceId.length > 200) {
    throw new AgentCredentialError(400, 'instance_id is required, at most 200 characters')
  }

  const label = String(record.label ?? '').trim()
  if (label.length > MAX_CREDENTIAL_LABEL) {
    throw new AgentCredentialError(
      400,
      `label must be at most ${MAX_CREDENTIAL_LABEL} characters`,
    )
  }

  let expiresAt: string | null = null
  if (record.expires_at !== undefined && record.expires_at !== null && record.expires_at !== '') {
    const raw = String(record.expires_at)
    const parsed = new Date(raw)
    if (Number.isNaN(parsed.valueOf())) {
      throw new AgentCredentialError(400, 'expires_at must be an ISO-8601 instant')
    }
    expiresAt = parsed.toISOString()
  }

  return { tenantId, instanceId, label, expiresAt }
}

export function parseRevokeInput(body: unknown): {
  readonly credentialId: string
  readonly reason: string
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentCredentialError(400, 'a JSON object body is required')
  }
  const record = body as Record<string, unknown>
  const credentialId = String(record.credential_id ?? '').trim()
  if (!UUID_PATTERN.test(credentialId)) {
    throw new AgentCredentialError(400, 'credential_id must be a uuid')
  }
  const reason = String(record.reason ?? '').trim().slice(0, MAX_REVOKE_REASON)
  return { credentialId, reason }
}

export interface IssuedCredentialToken {
  readonly credential: IssuedCredential
  /**
   * The full token, and the only time it exists. Nothing stores it and nothing
   * can recover it: a lost token is replaced by issuing another and revoking
   * this one.
   */
  readonly token: string
}

export async function issueAgentCredential(
  store: DataStore,
  actor: ActorContext,
  input: IssueCredentialInput,
): Promise<IssuedCredentialToken> {
  const secret = generateAgentSecret()
  const credential = await store.transaction(actor, (transaction) =>
    transaction.execute<IssuedCredential | null>({
      operation: AGENT_ADMIN_COMMANDS.issueCredential,
      params: {
        tenantId: input.tenantId,
        instanceId: input.instanceId,
        label: input.label ?? '',
        secretHash: hashAgentSecret(secret),
        expiresAt: input.expiresAt ?? '',
      },
    }),
  )

  if (!credential) {
    // The function returns exactly one row or raises. Zero rows would mean the
    // insert silently did nothing, which no code path in step 009 produces.
    throw new AgentCredentialError(500, 'the credential could not be issued')
  }

  return { credential, token: formatAgentToken(credential.id, secret) }
}

export async function revokeAgentCredential(
  store: DataStore,
  actor: ActorContext,
  credentialId: string,
  reason: string,
): Promise<RevokedCredential | null> {
  return store.transaction(actor, (transaction) =>
    transaction.execute<RevokedCredential | null>({
      operation: AGENT_ADMIN_COMMANDS.revokeCredential,
      params: { credentialId, reason },
    }),
  )
}

export async function listAgentCredentials(
  store: DataStore,
  actor: ActorContext,
): Promise<readonly CredentialDirectoryRow[]> {
  const page = await store.query<CredentialDirectoryRow>(actor, {
    operation: AGENT_ADMIN_OPERATIONS.credentialDirectory,
    page: { limit: 200 },
  })
  return page.items
}
