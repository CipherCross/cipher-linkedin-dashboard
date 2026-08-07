import type {
  DataRecoveryPort,
  DataControlPlanePort,
  DomainControlPlanePort,
  HostingRecoveryPort,
  IdentityControlPlanePort,
  IdentityRecoveryPort,
  ObjectStorageRecoveryPort,
  ObjectStorageControlPlanePort,
  SmtpControlPlanePort,
  SourceRepositoryReadPort,
  TenantRecoveryProviders,
} from "./interfaces.js";
import type { HostingControlPlanePort } from "./hosting.js";

/**
 * Adapter-private API contracts. These are named capability methods rather
 * than generic HTTP/SDK escape hatches. S26 composes reviewed Neon/Postgres,
 * Better Auth, R2 and Vercel implementations through these interfaces; the
 * operations core only sees the neutral ports and their redacted canonical
 * results. A provider backend must implement these named methods directly —
 * it cannot receive an arbitrary URL, payload, query, shell command or env map.
 */
export interface NeonOperationsApi extends DataControlPlanePort {}
export interface IdentityOperationsApi extends IdentityControlPlanePort {}
export interface ObjectStorageOperationsApi
  extends ObjectStorageControlPlanePort {}
export interface HostingOperationsApi extends HostingControlPlanePort {}
export interface EmailOperationsApi extends SmtpControlPlanePort {}
export interface DomainOperationsApi extends DomainControlPlanePort {}
export interface SourceRepositoryOperationsApi extends SourceRepositoryReadPort {}

export interface OperationsApiBundle {
  readonly data: NeonOperationsApi;
  readonly identity: IdentityOperationsApi;
  readonly objectStorage: ObjectStorageOperationsApi;
  readonly hosting: HostingOperationsApi;
  readonly email: EmailOperationsApi;
  readonly domain: DomainOperationsApi;
  readonly sourceRepository: SourceRepositoryOperationsApi;
}

/**
 * The provider implementations required for a disposable S26 recovery drill.
 * Recovery is intentionally not folded into onboarding: capture/restore is a
 * distinct reviewed workflow with its own target and verification evidence.
 */
export interface S26RecoveryApiBundle extends TenantRecoveryProviders {
  readonly data: NeonOperationsApi & DataRecoveryPort;
  readonly identity: IdentityOperationsApi & IdentityRecoveryPort;
  readonly objectStorage: ObjectStorageOperationsApi & ObjectStorageRecoveryPort;
  readonly hosting: HostingOperationsApi & HostingRecoveryPort;
}

export interface S26OperationsApiBundle extends OperationsApiBundle {
  readonly data: NeonOperationsApi & DataRecoveryPort;
  readonly identity: IdentityOperationsApi & IdentityRecoveryPort;
  readonly objectStorage: ObjectStorageOperationsApi & ObjectStorageRecoveryPort;
  readonly hosting: HostingOperationsApi & HostingRecoveryPort;
}
