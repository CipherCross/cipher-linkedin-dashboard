import type { DataStoreUnavailableCode } from './contracts.js'

const SOCKET_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
])

/** Shared by the application and identity pools; never returns driver text. */
export function unavailableCodeFor(
  error: unknown,
  phase: 'connect' | 'statement',
): DataStoreUnavailableCode | null {
  const failure = error as { code?: unknown; message?: unknown } | null
  const code = typeof failure?.code === 'string' ? failure.code : ''
  const cls = /^[0-9A-Za-z]{5}$/.test(code) ? code.slice(0, 2) : null
  // 53000 alone means insufficient resources, not necessarily a quota. Match
  // Neon's known refusal as well, without copying any provider text out.
  if (code === '53000' && typeof failure?.message === 'string' &&
      failure.message.startsWith('Your account or project has exceeded the quota.')) {
    return 'DATASTORE_QUOTA_EXCEEDED'
  }
  if (cls === '28') return 'DATASTORE_CREDENTIAL_REJECTED'
  if (cls === '08' || ['57P01', '57P02', '57P03'].includes(code) ||
      SOCKET_ERROR_CODES.has(code) ||
      failure?.message === 'Connection terminated unexpectedly') {
    return phase === 'connect' ? 'DATASTORE_CONNECT_FAILED' : 'DATASTORE_CONNECTION_LOST'
  }
  if (code === '53300') return 'DATASTORE_CONNECT_FAILED'
  // Pool acquisition timeouts have no SQLSTATE. Other statement failures keep
  // their existing constraint/schema/authorization handling.
  return phase === 'connect' ? 'DATASTORE_CONNECT_FAILED' : null
}
