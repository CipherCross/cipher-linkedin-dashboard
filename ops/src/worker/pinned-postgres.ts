import { Pool, type PoolClient } from "@neondatabase/serverless";

import { OpsError } from "../core/errors.js";

import manifestText from "../../../postgres/tenant-baseline/v1/ledger.manifest.json";
import roleBootstrap from "../../../postgres/tenant-baseline/v1/000_control_plane_role_bootstrap.sql";
import identityRoleBootstrap from "../../../postgres/tenant-baseline/v1/000_identity_store_role_bootstrap.sql";
import aiRoleBootstrap from "../../../postgres/tenant-baseline/v1/000_ai_execution_role_bootstrap.sql";
import machineRoleBootstrap from "../../../postgres/tenant-baseline/v1/000_machine_ingest_role_bootstrap.sql";
import ledgerBootstrap from "../../../postgres/tenant-baseline/v1/000_migration_ledger.sql";
import step001 from "../../../postgres/tenant-baseline/v1/001_portable_business_baseline.sql";
import step002 from "../../../postgres/tenant-baseline/v1/002_identity_roles_actor_rls.sql";
import step003 from "../../../postgres/tenant-baseline/v1/003_functions_triggers_ai_guard.sql";
import step004 from "../../../postgres/tenant-baseline/v1/004_identity_write_path_and_store.sql";
import step005 from "../../../postgres/tenant-baseline/v1/005_identity_atomic_invite.sql";
import step006 from "../../../postgres/tenant-baseline/v1/006_messages_direction_seek_index.sql";
import step007 from "../../../postgres/tenant-baseline/v1/007_ai_system_write_path.sql";
import step008 from "../../../postgres/tenant-baseline/v1/008_ai_system_auto_advance_execute.sql";
import step009 from "../../../postgres/tenant-baseline/v1/009_machine_ingest_path.sql";
import step010 from "../../../postgres/tenant-baseline/v1/010_machine_schema_usage.sql";
import step011 from "../../../postgres/tenant-baseline/v1/011_sequence_builder_workspace.sql";
import step012 from "../../../postgres/tenant-baseline/v1/012_sequence_publish_jobs.sql";
import liveRlsRoleBoundaries from "../../../postgres/tests/portable_live_rls_role_boundaries.sql";
import restoreVerification from "../../../postgres/tests/portable_restore_reconciliation.sql";

interface ManifestStep {
  readonly step: number;
  readonly artifact: string;
  readonly sha256: string;
}

interface LedgerManifest {
  readonly ledger_contract: string;
  readonly ledger_version: string;
  readonly role_bootstrap: { readonly artifact: string; readonly sha256: string };
  readonly role_bootstrap_extensions: readonly { readonly artifact: string; readonly sha256: string }[];
  readonly ledger_bootstrap: { readonly artifact: string; readonly sha256: string };
  readonly steps: readonly ManifestStep[];
}

const rawManifest: unknown = manifestText;
const manifest = (typeof rawManifest === "string" ? JSON.parse(rawManifest) : rawManifest) as LedgerManifest;
const textByArtifact: Readonly<Record<string, string>> = {
  "000_control_plane_role_bootstrap.sql": roleBootstrap,
  "000_identity_store_role_bootstrap.sql": identityRoleBootstrap,
  "000_ai_execution_role_bootstrap.sql": aiRoleBootstrap,
  "000_machine_ingest_role_bootstrap.sql": machineRoleBootstrap,
  "000_migration_ledger.sql": ledgerBootstrap,
  "001_portable_business_baseline.sql": step001,
  "002_identity_roles_actor_rls.sql": step002,
  "003_functions_triggers_ai_guard.sql": step003,
  "004_identity_write_path_and_store.sql": step004,
  "005_identity_atomic_invite.sql": step005,
  "006_messages_direction_seek_index.sql": step006,
  "007_ai_system_write_path.sql": step007,
  "008_ai_system_auto_advance_execute.sql": step008,
  "009_machine_ingest_path.sql": step009,
  "010_machine_schema_usage.sql": step010,
  "011_sequence_builder_workspace.sql": step011,
  "012_sequence_publish_jobs.sql": step012,
};

/**
 * The pinned SQL the live data smoke runs, by canonical smoke test ID.
 *
 * This deliberately does NOT include the four portable_*_catalog_assertions.sql
 * artifacts the live smoke used to run. Each of those belongs to the cleanroom
 * harness that applies its own step and asserts exact counts for the state right
 * after it — portable_business_catalog_assertions.sql requires `tables = 25` and
 * `rls_tables = 0`, which is the state after step 001 alone. Against a tenant at
 * baseline 053 plus migration 054 all four fail by construction, and all four
 * also require `provider_roles = 0` and `provider_schemas = 0`, which a managed
 * provider's own principals break independently. Running them here would have
 * failed step 11 deterministically, in the same way the wrong-stage
 * ledger-presence probe failed step 3.
 *
 * They are not edited or moved: their cleanroom harnesses still own them, and
 * they remain digest-pinned for those harnesses by the static assertions.
 */
const smokeArtifacts = {
  rls_role_boundaries: {
    text: liveRlsRoleBoundaries,
    sha256: "500915da8f117ff2e631abcde4d1da552d66bddf63c1784ee31de10ecd632a4f",
  },
} as const;
const restoreVerificationSha256 = "dc088ba179c648c82ac9ee92c33f8e04c767b5b6918d061ad8f45104db805865";

/**
 * Every data smoke ID this module can actually run.
 *
 * The executor validates a requested ID against the closed suite vocabulary, and
 * this is the other half of that contract: an ID the plan is entitled to ask for
 * and that nothing here owns must be a visible gap, not a silent skip.
 */
export const DATA_SMOKE_CHECK_IDS: readonly string[] = [
  "schema_ledger",
  ...Object.keys(smokeArtifacts),
];

function postgresSql(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function assertPinnedArtifacts(): Promise<void> {
  if (manifest.ledger_contract !== "portable-tenant-baseline-ledger" || manifest.steps.length !== 12) {
    throw new OpsError("unsupported_contract", "Pinned portable migration manifest is unsupported");
  }
  const entries = [
    manifest.role_bootstrap,
    ...manifest.role_bootstrap_extensions,
    manifest.ledger_bootstrap,
    ...manifest.steps,
  ];
  for (const entry of entries) {
    const text = textByArtifact[entry.artifact];
    if (text === undefined || await sha256Hex(text) !== entry.sha256) {
      throw new OpsError("provider_snapshot_drift", "Pinned portable migration artifact digest mismatch", {
        artifact: entry.artifact,
      });
    }
  }
  for (const artifact of Object.values(smokeArtifacts)) {
    if (await sha256Hex(artifact.text) !== artifact.sha256) {
      throw new OpsError("provider_snapshot_drift", "Pinned portable smoke artifact digest mismatch");
    }
  }
  if (await sha256Hex(restoreVerification) !== restoreVerificationSha256) {
    throw new OpsError("provider_snapshot_drift", "Pinned restore verification artifact digest mismatch");
  }
}

async function withConnection<T>(
  connectionString: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 15_000,
    query_timeout: 15_000,
  });
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Whether each pinned bootstrap artifact has already produced its own effect.
 *
 * Every artifact is sent as one multi-statement simple query, which PostgreSQL
 * runs inside a single implicit transaction, so each of these postconditions is
 * exact: it is true only if that whole artifact committed.
 *
 * This exists so a retry does not reissue privileged role and ownership
 * statements it does not need, and so a partial bootstrap is completed rather
 * than guessed at. It is NOT what unblocks a resumed step 3.
 *
 * An earlier reading of the live step-3 409 blamed a replayed bootstrap, on the
 * theory that `ALTER SCHEMA public OWNER TO app_owner` must fail the second time
 * because the executing principal is only a NON-INHERITING member of the new
 * owner. That is wrong, and
 * `postgres/tests/portable_control_plane_bootstrap_state_cleanroom.sh` now pins
 * the correction: the artifact deliberately grants a non-superuser principal
 * `app_owner WITH SET TRUE` for precisely that statement, and all four artifacts
 * replay cleanly against the state they leave behind. The real cause was the
 * ledger-presence probe — see LEDGER_PRESENCE_SQL.
 */
export interface BootstrapState {
  readonly controlPlane: boolean;
  readonly identityStore: boolean;
  readonly aiExecution: boolean;
  readonly machineIngest: boolean;
}

/** The minimum of a Postgres client this probe needs, so it can be exercised. */
export interface BootstrapProbeClient {
  query(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

export const CONTROL_PLANE_ROLES = [
  "app_owner", "app_migration", "app_runtime", "app_readonly",
  "app_machine", "app_system", "app_ai_runner",
] as const;

export type BootstrapArtifact = "controlPlane" | "identityStore" | "aiExecution" | "machineIngest";

export function bootstrapArtifactsToApply(state: BootstrapState): readonly BootstrapArtifact[] {
  return (["controlPlane", "identityStore", "aiExecution", "machineIngest"] as const)
    .filter((artifact) => !state[artifact]);
}

/**
 * Whether the ledger's own tables are already present.
 *
 * This deliberately reads the catalog instead of resolving
 * `app_ledger.applied_migration` with `to_regclass`. The ledger bootstrap ends
 * by revoking everything on its schema from PUBLIC, leaving
 * `app_ledger` owned by app_owner with no USAGE for anyone else, and
 * app_migration is NOINHERIT. Resolving a schema-qualified name requires USAGE
 * on the schema, so `to_regclass` succeeded on the first apply — when the schema
 * did not exist yet and the name resolved to NULL — and then raised
 * `42501 permission denied for schema app_ledger` on every apply afterwards.
 * That is a deterministic Postgres error, so it became `provider_error`, which
 * the bridge answers with 409: the step-3 409 that a retry could never get past,
 * created by the very act of having succeeded once.
 *
 * `pg_class`/`pg_namespace` are world-readable and need no schema USAGE, so this
 * probe reports the same answer before and after the bootstrap and cannot be
 * defeated by the ACL the bootstrap installs. The reads of the ledger's
 * *contents* below still enter app_owner with SET ROLE, which is what they need.
 */
export const LEDGER_PRESENCE_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'app_ledger' AND c.relname = 'applied_migration'
) AS present`;

/**
 * The bootstrap postcondition probe, exported so a live-shaped harness can run
 * the very same text against a real PostgreSQL 17 role graph. A mocked row of
 * booleans cannot show that this SQL is valid, readable by the principal that
 * issues it, or true of an already-prepared cluster.
 */
export const BOOTSTRAP_STATE_PROBE_SQL = `SELECT
       coalesce(
         (SELECT count(*) FROM pg_roles WHERE rolname = ANY($1::text[])) = $2
         AND (SELECT bool_and(rolcanlogin) FROM pg_roles
               WHERE rolname IN ('app_migration', 'app_runtime'))
         AND (SELECT nspowner FROM pg_namespace WHERE nspname = 'public')
             = (SELECT oid FROM pg_roles WHERE rolname = 'app_owner'),
         false)
         AND EXISTS (
           SELECT 1 FROM pg_auth_members m
             JOIN pg_roles granted ON granted.oid = m.roleid
             JOIN pg_roles member ON member.oid = m.member
            WHERE granted.rolname = 'app_owner'
              AND member.rolname = 'app_migration' AND m.set_option)
         AND EXISTS (
           SELECT 1 FROM pg_auth_members m
             JOIN pg_roles granted ON granted.oid = m.roleid
             JOIN pg_roles member ON member.oid = m.member
            WHERE granted.rolname = 'app_ai_runner'
              AND member.rolname = 'app_owner' AND m.set_option)
         AND coalesce(
           (SELECT has_database_privilege(oid, current_database(), 'CREATE')
              FROM pg_roles WHERE rolname = 'app_owner'),
           false)
         AS control_plane,
       coalesce(
         (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'identity_store')
         AND EXISTS (
           SELECT 1 FROM pg_auth_members m
             JOIN pg_roles granted ON granted.oid = m.roleid
             JOIN pg_roles member ON member.oid = m.member
            WHERE granted.rolname = 'identity_store'
              AND member.rolname = 'app_owner' AND m.set_option),
         false) AS identity_store,
       coalesce((SELECT rolcanlogin FROM pg_roles WHERE rolname = 'app_system'), false)
         AS ai_execution,
       coalesce((SELECT rolcanlogin FROM pg_roles WHERE rolname = 'app_machine'), false)
         AS machine_ingest`;

export async function readBootstrapState(owner: BootstrapProbeClient): Promise<BootstrapState> {
  const observed = await owner.query(
    BOOTSTRAP_STATE_PROBE_SQL,
    [[...CONTROL_PLANE_ROLES], CONTROL_PLANE_ROLES.length],
  );
  const row = observed.rows[0] ?? {};
  return {
    controlPlane: row.control_plane === true,
    identityStore: row.identity_store === true,
    aiExecution: row.ai_execution === true,
    machineIngest: row.machine_ingest === true,
  };
}

function assertApprovedReleaseTuple(
  baselineVersion: number,
  migrationVersions: readonly number[],
  targetSchemaVersion: number,
): void {
  if (
    baselineVersion !== 53 ||
    migrationVersions.length !== 1 ||
    migrationVersions[0] !== 54 ||
    targetSchemaVersion !== 54
  ) {
    throw new OpsError("unsupported_contract", "Portable Postgres release tuple is not the pinned 053 plus 054 set");
  }
}

export async function applyPinnedPortablePostgres(input: {
  readonly ownerConnectionUri: string;
  readonly baselineVersion: number;
  readonly migrationVersions: readonly number[];
  readonly targetSchemaVersion: number;
}): Promise<void> {
  assertApprovedReleaseTuple(input.baselineVersion, input.migrationVersions, input.targetSchemaVersion);
  await assertPinnedArtifacts();

  const passwordBytes = new Uint8Array(32);
  crypto.getRandomValues(passwordBytes);
  const temporaryPassword = [...passwordBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const quotedPassword = temporaryPassword.replaceAll("'", "''");
  const migrationUri = new URL(input.ownerConnectionUri);
  migrationUri.username = "app_migration";
  migrationUri.password = temporaryPassword;

  try {
    await withConnection(input.ownerConnectionUri, async (owner) => {
      // Already-prepared artifacts are adopted rather than replayed; see
      // readBootstrapState. Only the temporary migration credential is always
      // reassigned, because it is deliberately dropped again in the finally.
      const prepared = await readBootstrapState(owner);
      const bootstrapSql: Readonly<Record<BootstrapArtifact, string>> = {
        controlPlane: roleBootstrap,
        identityStore: identityRoleBootstrap,
        aiExecution: aiRoleBootstrap,
        machineIngest: machineRoleBootstrap,
      };
      for (const artifact of bootstrapArtifactsToApply(prepared)) {
        await owner.query(postgresSql(bootstrapSql[artifact]));
      }
      await owner.query(`ALTER ROLE app_migration PASSWORD '${quotedPassword}'`);
    });

    await withConnection(migrationUri.toString(), async (runner) => {
      const ledgerExists = await runner.query(LEDGER_PRESENCE_SQL);
      if (ledgerExists.rows[0]?.present !== true) {
        await runner.query(postgresSql(ledgerBootstrap));
        const requiredRoles = [
          "app_owner", "app_migration", "app_runtime", "app_readonly",
          "app_machine", "app_system", "app_ai_runner",
        ];
        await runner.query("SET ROLE app_owner");
        await runner.query(
          `INSERT INTO app_ledger.role_bootstrap (artifact, sha256, ledger_version, required_roles)
           VALUES ($1, $2, $3, $4::text[])`,
          [manifest.role_bootstrap.artifact, manifest.role_bootstrap.sha256, manifest.ledger_version, requiredRoles],
        );
        await runner.query("RESET ROLE");
      }

      for (const step of manifest.steps) {
        await runner.query("SET ROLE app_owner");
        const applied = await runner.query(
          "SELECT sha256 FROM app_ledger.applied_migration WHERE step = $1",
          [step.step],
        );
        await runner.query("RESET ROLE");
        if (applied.rows.length > 0) {
          if (applied.rows[0]?.sha256 !== step.sha256) {
            throw new OpsError("provider_snapshot_drift", "Portable migration ledger digest mismatch", {
              artifact: step.artifact,
            });
          }
          continue;
        }
        const artifact = textByArtifact[step.artifact];
        if (artifact === undefined) {
          throw new OpsError("unsupported_contract", "Pinned portable migration artifact is absent");
        }
        await runner.query("BEGIN");
        try {
          await runner.query("SET ROLE app_owner");
          await runner.query(postgresSql(artifact));
          await runner.query("SET ROLE app_owner");
          await runner.query(
            `INSERT INTO app_ledger.applied_migration (step, artifact, sha256, ledger_version)
             VALUES ($1, $2, $3, $4)`,
            [step.step, step.artifact, step.sha256, manifest.ledger_version],
          );
          await runner.query("COMMIT");
        } catch (error) {
          await runner.query("ROLLBACK");
          throw error;
        }
      }
    });
  } finally {
    try {
      await withConnection(input.ownerConnectionUri, async (owner) => {
        await owner.query("ALTER ROLE app_migration PASSWORD NULL");
      });
    } catch {
      // The main operation result is already unknown if cleanup cannot be confirmed.
      throw new OpsError("outcome_unknown", "Temporary migration credential cleanup could not be confirmed", {
        provider_request_id: crypto.randomUUID(),
      });
    }
  }
}

/**
 * Whether step 004's identity store is installed, and whether step 005's atomic
 * invite path is present with its exact six-text signature.
 *
 * Catalog reads, for the same reason as LEDGER_PRESENCE_SQL. These run over the
 * OWNER connection, which on a managed provider is the provider's own principal
 * (`neondb_owner`) and not app_owner. Step 004 creates
 * `CREATE SCHEMA identity AUTHORIZATION identity_store`, revokes PUBLIC and
 * grants USAGE to app_owner alone, and schema `public` is likewise owned by
 * app_owner with USAGE for the contract roles only — so the provider principal
 * holds USAGE on neither. The previous probes resolved
 * `identity."user"` and `public.identity_admin_invite_member_atomic(...)` by
 * name, which requires that USAGE, and both therefore raised
 * `42501 permission denied for schema …` instead of answering. That was step 4's
 * and step 11's copy of the defect that stopped step 3.
 *
 * `pg_class`, `pg_namespace` and `pg_proc` need no schema privilege.
 *
 * The signature check compares argument TYPES, the way the retired
 * `to_regprocedure(...(text,text,...))` lookup did. Step 005 declares the
 * function with named parameters (`p_email text, …`), so comparing
 * `pg_get_function_identity_arguments` against a bare type list silently reports
 * the invite path as absent.
 */
export const IDENTITY_STORE_PRESENCE_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'identity' AND c.relname = 'user'
) AS configured`;

export const IDENTITY_SURFACE_PRESENCE_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'identity' AND c.relname = 'user'
) AS identity_store, EXISTS (
  SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'identity_admin_invite_member_atomic'
     AND pg_catalog.oidvectortypes(p.proargtypes) = 'text, text, text, text, text, text'
) AS invite_path`;

/**
 * The two ledger reads the `schema_ledger` smoke makes, exported so the
 * live-shaped harness runs the same text. `role_bootstrap` is a single-row table
 * by constraint, so it needs no ordering.
 */
export const LEDGER_APPLIED_STEPS_SQL =
  "SELECT step, artifact, sha256 FROM app_ledger.applied_migration ORDER BY step";
export const LEDGER_ROLE_BOOTSTRAP_SQL =
  "SELECT artifact, sha256 FROM app_ledger.role_bootstrap";

/**
 * The `schema_ledger` data smoke: the tenant really is at the release the plan
 * approved, checked against the pinned manifest rather than against a count.
 *
 * The ledger's contents are control-plane state that only app_owner may read, so
 * this enters that role the same way every other ledger read does.
 */
async function verifySchemaLedger(client: PoolClient): Promise<void> {
  await client.query("SET ROLE app_owner");
  const applied = await client.query(LEDGER_APPLIED_STEPS_SQL);
  const bootstrap = await client.query(LEDGER_ROLE_BOOTSTRAP_SQL);
  await client.query("RESET ROLE");

  if (applied.rows.length !== manifest.steps.length) {
    throw new OpsError("provider_error", "Tenant ledger step count does not match the pinned release", {
      applied_steps: applied.rows.length,
      expected_steps: manifest.steps.length,
    });
  }
  for (const [index, step] of manifest.steps.entries()) {
    const row = applied.rows[index];
    if (Number(row?.step) !== step.step || row?.artifact !== step.artifact || row?.sha256 !== step.sha256) {
      throw new OpsError("provider_snapshot_drift", "Tenant ledger does not match the pinned release", {
        step: step.step,
        artifact: step.artifact,
      });
    }
  }
  if (!bootstrap.rows.some((row) => row.artifact === manifest.role_bootstrap.artifact
    && row.sha256 === manifest.role_bootstrap.sha256)) {
    throw new OpsError("provider_snapshot_drift", "Tenant ledger records no matching role bootstrap");
  }
}

/**
 * Runs the data smoke checks the plan asked for, one per canonical ID.
 *
 * The IDs were previously validated and then ignored, with every artifact run
 * regardless. Routing each ID to the single check that owns it is what the
 * closed suite vocabulary is for, and it is what lets a check be written for the
 * state the tenant is actually in.
 */
export async function runPinnedPortableSmoke(
  ownerConnectionUri: string,
  smokeTestIds: readonly string[],
): Promise<void> {
  await assertPinnedArtifacts();
  await withConnection(ownerConnectionUri, async (sql) => {
    for (const id of smokeTestIds) {
      if (id === "schema_ledger") {
        await verifySchemaLedger(sql);
        continue;
      }
      const artifact = smokeArtifacts[id as keyof typeof smokeArtifacts];
      if (artifact === undefined) {
        throw new OpsError("unsupported_contract", "Data smoke test ID has no pinned check");
      }
      await sql.query(postgresSql(artifact.text));
    }
  });
}

export async function runPinnedRestoreVerification(ownerConnectionUri: string): Promise<void> {
  await assertPinnedArtifacts();
  await withConnection(ownerConnectionUri, async (sql) => {
    await sql.query(postgresSql(restoreVerification));
  });
}
