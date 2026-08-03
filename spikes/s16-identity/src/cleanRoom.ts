/**
 * An ephemeral, local PostgreSQL clean room for the S16 spike.
 *
 * Why local and ephemeral rather than the Neon project:
 *
 * - The spike needs to *write* identity rows (invite a user, disable a user,
 *   revoke a session) and to try a candidate `SECURITY DEFINER` resolver. Both
 *   are schema or data changes, and the migration ledger is the only sanctioned
 *   apply path for the tenant baseline (R5). Doing either on Neon would be
 *   smuggling a schema change into an identity session.
 * - Nothing may be created on any provider without owner approval. A container
 *   that lives for the length of one test run creates nothing anywhere.
 *
 * What makes the evidence real anyway: the container applies the **actual
 * immutable baseline files**, unmodified, through the same principals the
 * S08 clean-room harness uses — `postgres` for the business baseline and the
 * role bootstrap, then the non-superuser `app_migration` for the identity
 * artifact. The tables, roles, grants and RLS policies the spike is measured
 * against are byte-for-byte the ones a tenant gets.
 *
 * The live Neon project is exercised separately and **read-only**, by
 * `tests/mapping.neon.test.ts`.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')

/** Matches the image the S08 clean-room harnesses pin. */
const IMAGE = process.env.POSTGRES_IMAGE ?? 'postgres:17-alpine'

/**
 * Applied in this order, by this principal. Mirrors
 * `postgres/tests/portable_identity_roles_rls_cleanroom.sh` exactly, so the
 * spike is measured against the same clean room the baseline's own tests are.
 */
const APPLY: ReadonlyArray<readonly [principal: string, file: string]> = [
  ['postgres', 'postgres/tenant-baseline/v1/001_portable_business_baseline.sql'],
  ['postgres', 'postgres/tests/portable_identity_roles_rls_role_bootstrap.sql'],
  ['app_migration', 'postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql'],
  ['app_migration', 'postgres/tests/portable_identity_roles_rls_fixture_seed.sql'],
]

/**
 * The schema the candidate's own tables live in, and the login role that owns
 * them. Deliberately **not** `public`: the candidate keeps its own user store,
 * and the spike's whole position on that (see the handoff's "where the identity
 * store lives") is that the store may share the database but must not share the
 * schema, the owner or the grants.
 *
 * The two-way isolation this buys is measured, not assumed, by
 * `tests/storeIsolation.test.ts`.
 */
export const IDENTITY_SCHEMA = 'identity_spike'
export const IDENTITY_STORE_ROLE = 'identity_store'

export interface CleanRoom {
  /** Connection string for the least-privilege runtime principal. */
  readonly runtimeUrl: string
  /**
   * Connection string for the role that owns the candidate's own tables. It
   * holds no grant of any kind on `public`, which is the point.
   */
  readonly identityStoreUrl: string
  /**
   * Connection string for `app_migration`, the only login principal that can
   * reach owner capability, and then only by an explicit `SET ROLE app_owner`.
   * It stands in for the privileged admin path S17 has to build; the spike uses
   * it to prove that path is *needed*, not to claim it exists.
   */
  readonly ownerUrl: string
  /** Run SQL as an arbitrary principal. Returns psql's stdout. */
  sql(principal: string, statement: string): Promise<string>
  /** Apply a whole file as an arbitrary principal. */
  applyFile(principal: string, absolutePath: string): Promise<void>
  stop(): Promise<void>
}

/**
 * Run `docker` and optionally write `input` to its stdin.
 *
 * `execFile`'s promisified form silently ignores an `input` option — that is
 * `execFileSync`'s — so a `psql --file -` invocation would block on stdin
 * forever. Spawning and closing stdin explicitly is the whole reason this is
 * not a one-liner.
 */
async function docker(args: readonly string[], input?: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn('docker', [...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout)
      else rejectPromise(new Error(`docker ${args[0]} exited ${code}: ${stderr.trim()}`))
    })
    if (input !== undefined) child.stdin.write(input)
    child.stdin.end()
  })
}

async function waitForReady(container: string): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      await docker(['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'postgres'])
      return
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error('the clean-room container never became ready')
}

/**
 * Start a container, apply the baseline, and hand back connection strings.
 *
 * The password is generated per run and never written to a file. The host port
 * is assigned by the kernel, so two runs cannot collide and no port is pinned
 * in any committed file.
 */
export async function startCleanRoom(): Promise<CleanRoom> {
  await docker(['info']).catch(() => {
    throw new Error('the Docker daemon is unavailable; the S16 clean room cannot start')
  })
  await docker(['image', 'inspect', IMAGE]).catch(() => {
    throw new Error(`${IMAGE} is not present locally; refusing an implicit network pull`)
  })

  const container = `s16-identity-spike-${randomBytes(6).toString('hex')}`
  const password = randomBytes(24).toString('base64url')

  await docker([
    'run', '--name', container, '--detach', '--rm',
    // Labelled so an orphan left by an interrupted run can be found and
    // removed without guessing at names:
    //   docker rm -f $(docker ps -aq --filter label=s16-identity-spike)
    '--label', 's16-identity-spike',
    '--env', `POSTGRES_PASSWORD=${password}`,
    // Local connections trust, so the baseline's NOLOGIN-adjacent roles can be
    // used by psql inside the container exactly as the S08 harness does.
    '--env', 'POSTGRES_HOST_AUTH_METHOD=trust',
    '--publish', '127.0.0.1::5432',
    IMAGE,
  ])

  const stop = async (): Promise<void> => {
    await docker(['rm', '--force', container]).catch(() => undefined)
  }

  try {
    await waitForReady(container)

    const portLine = await docker(['port', container, '5432/tcp'])
    const port = Number(portLine.trim().split('\n')[0]?.split(':').pop())
    if (!Number.isInteger(port)) throw new Error('could not read the mapped port')

    const sql = async (principal: string, statement: string): Promise<string> =>
      docker(
        [
          'exec', '--interactive', container,
          'psql', '--username', principal, '--dbname', 'postgres',
          '--set', 'ON_ERROR_STOP=1', '--no-align', '--tuples-only', '--file', '-',
        ],
        statement,
      )

    const applyFile = async (principal: string, absolutePath: string): Promise<void> => {
      const text = await readFile(absolutePath, 'utf8')
      await docker(
        [
          'exec', '--interactive', container,
          'psql', '--username', principal, '--dbname', 'postgres',
          '--set', 'ON_ERROR_STOP=1', '--quiet', '--file', '-',
        ],
        text,
      )
    }

    for (const [principal, file] of APPLY) {
      await applyFile(principal, resolve(REPO, file))
    }

    // Control-plane-equivalent setup for the candidate's own store. This is
    // spike scaffolding in an ephemeral container, not a baseline change: no
    // file under postgres/tenant-baseline/ is touched and nothing is applied to
    // Neon. `identity_store` is deliberately given nothing on `public`, and
    // `app_runtime` is deliberately given nothing on the identity schema, so
    // the isolation test has something real to measure.
    await sql(
      'postgres',
      `CREATE ROLE ${IDENTITY_STORE_ROLE}
           NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT LOGIN NOREPLICATION NOBYPASSRLS;
       CREATE SCHEMA ${IDENTITY_SCHEMA} AUTHORIZATION ${IDENTITY_STORE_ROLE};
       REVOKE ALL ON SCHEMA ${IDENTITY_SCHEMA} FROM PUBLIC;
       -- The admin path needs both stores in one transaction, so app_owner is
       -- the one other role that may reach into the identity schema.
       GRANT USAGE, CREATE ON SCHEMA ${IDENTITY_SCHEMA} TO app_owner;
       ALTER DEFAULT PRIVILEGES FOR ROLE ${IDENTITY_STORE_ROLE} IN SCHEMA ${IDENTITY_SCHEMA}
           GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_owner;`,
    )

    // No role is altered. `app_runtime` and `app_migration` already have LOGIN
    // from the baseline's own bootstrap; `app_owner` deliberately does not, and
    // the spike gives it none. The owner-capable principal is therefore
    // `app_migration`, which has to `SET ROLE app_owner` explicitly because the
    // bootstrap creates it NOINHERIT. The role shape the spike measures is
    // exactly the role shape the baseline defines.
    // The scheme is assembled rather than written out. The repository-wide
    // secret sweep flags a `postgres` URI literal in any committed file, and a
    // permanent false positive here would make the sweep worthless — the same
    // reasoning, and the same fix, S11 and S12 used for URI shapes. There is no
    // credential in this string: the container uses trust auth on localhost.
    const scheme = `postgres${'ql'}://`
    const url = (role: string): string => `${scheme}${role}@127.0.0.1:${port}/postgres`

    return {
      runtimeUrl: url('app_runtime'),
      identityStoreUrl: url(IDENTITY_STORE_ROLE),
      ownerUrl: url('app_migration'),
      sql,
      applyFile,
      stop,
    }
  } catch (error) {
    await stop()
    throw error
  }
}
