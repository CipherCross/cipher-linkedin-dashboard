import type {
  DataControlPlanePort,
  IdentityControlPlanePort,
  ObjectStorageControlPlanePort,
} from "./interfaces.js";
import type { HostingControlPlanePort } from "./hosting.js";

/**
 * Adapter-private API contracts. These are named capability methods rather
 * than generic HTTP/SDK escape hatches. A real Neon, Better Auth, R2 or Vercel
 * client can implement them later; the operations core only sees the neutral
 * ports and their redacted canonical results.
 */
export interface NeonOperationsApi extends DataControlPlanePort {}
export interface IdentityOperationsApi extends IdentityControlPlanePort {}
export interface ObjectStorageOperationsApi
  extends ObjectStorageControlPlanePort {}
export interface HostingOperationsApi extends HostingControlPlanePort {}

export interface OperationsApiBundle {
  readonly data: NeonOperationsApi;
  readonly identity: IdentityOperationsApi;
  readonly objectStorage: ObjectStorageOperationsApi;
  readonly hosting: HostingOperationsApi;
}
