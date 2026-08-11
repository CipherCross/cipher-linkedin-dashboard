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
import businessCatalogSmoke from "../../../postgres/tests/portable_business_catalog_assertions.sql";
import identityCatalogSmoke from "../../../postgres/tests/portable_identity_roles_rls_catalog_assertions.sql";
import identityWritePathSmoke from "../../../postgres/tests/portable_identity_write_path_catalog_assertions.sql";
import functionsCatalogSmoke from "../../../postgres/tests/portable_functions_triggers_ai_guard_catalog_assertions.sql";
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
};

const smokeArtifacts = [
  { text: businessCatalogSmoke, sha256: "b57b998d3e460b529f4de3f7fe3f37c7184f4db7730d3873d1b88e23ca735c63" },
  { text: identityCatalogSmoke, sha256: "409d24fb619226cf46dd50949012705980ea046ffc556eb495fe76b425bdc22b" },
  { text: identityWritePathSmoke, sha256: "10caa332cc33cf90fc9c95c6a8a541bc84aae4d505b8cac78d5be7699b185744" },
  { text: functionsCatalogSmoke, sha256: "8fece15b86539c9626b1b1efd19e706a08fec6ec04a0c8a69bd51f8f581a466f" },
] as const;
const restoreVerificationSha256 = "dc088ba179c648c82ac9ee92c33f8e04c767b5b6918d061ad8f45104db805865";

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
  if (manifest.ledger_contract !== "portable-tenant-baseline-ledger" || manifest.steps.length !== 10) {
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
  for (const artifact of smokeArtifacts) {
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
 * This matters because the artifacts are not all re-runnable against the state
 * they leave behind. The seven-role bootstrap ends with
 * `ALTER SCHEMA public OWNER TO app_owner`, and once that has run the executing
 * principal is only a NON-INHERITING member of the new owner, so PostgreSQL's
 * ownership check fails on the second attempt. That surfaces as a plain SQLSTATE
 * and becomes a `provider_error`, which is the 409 a resumed step 3 used to hit.
 * The artifacts themselves are digest-pinned and must not be edited, so the
 * decision to run them is made here instead — the same shape as the ledger
 * bootstrap's own `to_regclass` guard below.
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

export async function readBootstrapState(owner: BootstrapProbeClient): Promise<BootstrapState> {
  const observed = await owner.query(
    `SELECT
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
         AS machine_ingest`,
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
      const ledgerExists = await runner.query(
        "SELECT to_regclass('app_ledger.applied_migration') IS NOT NULL AS present",
      );
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

export async function runPinnedPortableSmoke(ownerConnectionUri: string): Promise<void> {
  await assertPinnedArtifacts();
  await withConnection(ownerConnectionUri, async (sql) => {
    for (const artifact of smokeArtifacts) {
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
