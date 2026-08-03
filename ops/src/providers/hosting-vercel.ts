/**
 * The concrete hosting adapter: it implements the canonical
 * `HostingControlPlanePort` on top of a narrow, adapter-private transport.
 *
 * Two boundaries meet here and neither is allowed to bleed into the other.
 *
 * *Outward*, this module produces only canonical results. Every handle it
 * issues is derived from canonical inputs — the deterministic name, the pinned
 * revision, the build recipe, the schedule manifest digest — never from a
 * provider resource ID. That is not cosmetic: it is what lets an interrupted
 * apply reconcile an `outcome_unknown` step by deterministic name and ownership
 * marker, and it is why the adapter and the in-memory fake produce byte-equal
 * canonical results for the same plan.
 *
 * *Inward*, `HostingVendorClient` is the only way to reach a provider. It has
 * no `request(url, body)`, no header map and no passthrough: every member is a
 * named hosting operation with a typed, provider-neutral payload. That is
 * deliberate — a general HTTP escape hatch would reopen exactly the boundary
 * `docs/platform-ops/operations-contract-v1.md` closes. The vendor SDK is
 * bound to this interface in `p4c-sdk.ts`, which remains its only importer.
 */

import { createHash } from "node:crypto";

import { canonicalJson, sha256Digest } from "../core/canonical.js";
import { OpsError } from "../core/errors.js";
import type { Redactor } from "../core/redaction.js";
import {
  normalizeSchedules,
  scheduleAsJson,
  scheduleManifestDigest,
  type DeploymentTargetRequest,
  type DeploymentTargetResult,
  type DeploymentVerificationRequest,
  type DomainAssignmentRequest,
  type DomainAssignmentResult,
  type EnvironmentBindingRequest,
  type EnvironmentBindingResult,
  type HostingCapabilityInspection,
  type HostingCapabilityInspectionRequest,
  type HostingLifecycle,
  type HostingProvider,
  type HostingReleaseHandle,
  type HostingSchedule,
  type HostingTargetHandle,
  type HostingValueSource,
  type HostingVerificationReport,
  type PromotionRequest,
  type ReleaseBuildRequest,
  type ReleaseBuildResult,
  type RollbackRequest,
  type RolloutResult,
  type ScheduleRegistrationRequest,
  type ScheduleRegistrationResult,
} from "./hosting.js";

/* ------------------------------------------------------------------ *
 * The narrow vendor transport
 * ------------------------------------------------------------------ */

/** What the provider can do. Answers capability questions, not resource questions. */
export interface HostingVendorCapabilities {
  readonly controlPlaneAccessible: boolean;
  readonly runtimeProfileIds: readonly string[];
  readonly maximumSchedules: number;
  readonly serverValueBindingSupported: boolean;
  readonly publicValueBindingSupported: boolean;
  readonly pinnedRevisionBuildSupported: boolean;
  readonly customDomainSupported: boolean;
  readonly rollbackSupported: boolean;
  readonly automaticPromotionCanBeDisabled: boolean;
  readonly isolatedPreviewsSupported: boolean;
  readonly validUntil: string;
}

export interface HostingVendorTarget {
  /** Provider-side identifier. Never leaves this module. */
  readonly targetId: string;
  readonly name: string;
  readonly lifecycle: HostingLifecycle;
  readonly automaticPromotionEnabled: boolean;
  readonly isolatedPreviewsEnabled: boolean;
  readonly ownershipMarkerDigest: string | null;
}

export interface HostingVendorTargetRequest {
  readonly name: string;
  readonly runtimeProfileId: string;
  readonly ownershipMarkerDigest: string;
  readonly automaticPromotionEnabled: false;
  readonly isolatedPreviewsEnabled: false;
}

export interface HostingVendorEnvironmentValue {
  readonly name: string;
  readonly value: string;
  /** Whether the provider must store the value encrypted rather than in plain text. */
  readonly secret: boolean;
}

export interface HostingVendorRelease {
  readonly releaseId: string;
  readonly targetId: string;
  readonly revisionId: string;
  readonly state: "building" | "ready" | "failed";
  readonly artifactDigest: string;
}

export interface HostingVendorReleaseRequest {
  readonly targetId: string;
  readonly revisionId: string;
  readonly buildRecipeId: string;
  readonly publicValueNames: readonly string[];
}

export interface HostingVendorDomain {
  readonly hostname: string;
  readonly targetId: string;
  readonly certificateReady: boolean;
}

/**
 * A schedule as the *release* declares it. On a file-routing provider the
 * schedule set is part of the built artifact, not a mutable project setting, so
 * reading it back is how the adapter proves the release actually carries the
 * schedules the plan approved.
 */
export interface HostingVendorSchedule {
  readonly routePath: string;
  readonly queryParameters: Readonly<Record<string, string>>;
  readonly expression: string;
}

export interface HostingVendorRuntimeCheck {
  readonly checkId: string;
  readonly passed: boolean;
}

export interface HostingVendorClient {
  describeCapabilities(): Promise<HostingVendorCapabilities>;
  findTarget(name: string): Promise<HostingVendorTarget | undefined>;
  createTarget(request: HostingVendorTargetRequest): Promise<HostingVendorTarget>;
  putEnvironmentValues(
    targetId: string,
    values: readonly HostingVendorEnvironmentValue[],
  ): Promise<void>;
  createRelease(
    request: HostingVendorReleaseRequest,
  ): Promise<HostingVendorRelease>;
  /** The schedule set declared by the built revision itself. */
  readReleaseSchedules(
    revisionId: string,
  ): Promise<readonly HostingVendorSchedule[]>;
  findDomain(
    targetId: string,
    hostname: string,
  ): Promise<HostingVendorDomain | undefined>;
  attachDomain(targetId: string, hostname: string): Promise<HostingVendorDomain>;
  activateRelease(targetId: string, releaseId: string): Promise<void>;
  activeReleaseId(targetId: string): Promise<string | null>;
  runRuntimeChecks(
    targetId: string,
    releaseId: string,
    checkIds: readonly string[],
  ): Promise<readonly HostingVendorRuntimeCheck[]>;
}

/**
 * Turns a declared source into the value to write. Resolution is the caller's
 * business — a key store, a generator, a field of the approved plan — and the
 * resolved value is written to the provider and then dropped. Nothing resolved
 * here reaches a canonical result.
 */
export interface HostingValueResolver {
  resolve(source: HostingValueSource): Promise<string>;
}

/* ------------------------------------------------------------------ *
 * Release routing manifest
 * ------------------------------------------------------------------ */

/**
 * Splits a routing-manifest path into a canonical route and query pair.
 * `/api/briefing?kind=weekly` is one route with one parameter, not a route
 * whose name happens to contain a question mark.
 */
export function splitManifestPath(path: string): {
  readonly routePath: string;
  readonly queryParameters: Readonly<Record<string, string>>;
} {
  const separator = path.indexOf("?");
  if (separator < 0) return { routePath: path, queryParameters: {} };
  const queryParameters: Record<string, string> = {};
  for (const pair of path.slice(separator + 1).split("&")) {
    if (pair.length === 0) continue;
    const equals = pair.indexOf("=");
    const key = equals < 0 ? pair : pair.slice(0, equals);
    const value = equals < 0 ? "" : pair.slice(equals + 1);
    queryParameters[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return { routePath: path.slice(0, separator), queryParameters };
}

/**
 * Reads the schedule set a built revision declares, from the release's own
 * routing manifest. This is the parity anchor: it is parsed, never restated by
 * hand, so a manifest that drifts from `CANONICAL_TENANT_SCHEDULES` fails
 * rather than passing on a copied literal.
 */
export function parseReleaseScheduleManifest(
  manifestJson: string,
): readonly HostingVendorSchedule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    throw new OpsError(
      "provider_error",
      "Release routing manifest is not valid JSON",
    );
  }
  const schedules =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { readonly crons?: unknown }).crons
      : undefined;
  if (!Array.isArray(schedules)) {
    throw new OpsError(
      "provider_error",
      "Release routing manifest declares no schedules",
    );
  }
  return schedules.map((candidate) => {
    const entry = candidate as { readonly path?: unknown; readonly schedule?: unknown };
    if (typeof entry.path !== "string" || typeof entry.schedule !== "string") {
      throw new OpsError(
        "provider_error",
        "Release routing manifest schedule is malformed",
      );
    }
    const { routePath, queryParameters } = splitManifestPath(entry.path);
    return { routePath, queryParameters, expression: entry.schedule };
  });
}

/* ------------------------------------------------------------------ *
 * Canonical identifier derivation
 * ------------------------------------------------------------------ */

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function requestId(method: string, call: number): string {
  return `req_${method.replaceAll(/[^a-z0-9]/gi, "_").toLowerCase()}_${call}`;
}

/** The canonical release key. Identical inputs must yield an identical handle. */
function releaseKey(request: ReleaseBuildRequest): string {
  return [
    request.targetHandle,
    request.revisionId,
    request.buildRecipeId,
    request.scheduleManifestDigest,
    [...request.publicValueNames].sort().join(","),
  ].join("|");
}

function bindingDigestOf(
  descriptors: readonly {
    readonly name: string;
    readonly valueClass: string;
    readonly sourceKind: string;
  }[],
): string {
  return sha256Digest(
    canonicalJson(
      [...descriptors]
        .sort((left, right) => (left.name < right.name ? -1 : 1))
        .map((descriptor) => ({
          name: descriptor.name,
          value_class: descriptor.valueClass,
          source_kind: descriptor.sourceKind,
        })),
    ),
  );
}

function scheduleShape(schedule: HostingSchedule): string {
  return canonicalJson({
    route_path: schedule.routePath,
    query_parameters: { ...schedule.queryParameters },
    expression: schedule.expression,
  });
}

function vendorScheduleShape(schedule: HostingVendorSchedule): string {
  return canonicalJson({
    route_path: schedule.routePath,
    query_parameters: { ...schedule.queryParameters },
    expression: schedule.expression,
  });
}

/* ------------------------------------------------------------------ *
 * Adapter state
 * ------------------------------------------------------------------ */

interface RolloutRecord {
  readonly kind: "promote" | "rollback";
  readonly releaseHandle: HostingReleaseHandle;
  readonly previousReleaseHandle: HostingReleaseHandle | null;
  readonly sequence: number;
  readonly reasonCode: string | null;
}

interface TargetState {
  readonly handle: HostingTargetHandle;
  readonly targetId: string;
  readonly deterministicName: string;
  readonly ownershipMarkerDigest: string;
  result: DeploymentTargetResult;
  binding?: EnvironmentBindingResult;
  domain?: DomainAssignmentResult;
  readonly releases: Map<HostingReleaseHandle, ReleaseBuildResult>;
  readonly releaseIds: Map<HostingReleaseHandle, string>;
  schedules?: {
    readonly releaseHandle: HostingReleaseHandle;
    readonly registered: readonly HostingSchedule[];
    readonly manifestDigest: string;
  };
  readonly rollouts: RolloutRecord[];
}

export interface VercelHostingAdapterOptions {
  /** Registers resolved values so a provider error cannot echo one back. */
  readonly redactor?: Redactor;
}

/* ------------------------------------------------------------------ *
 * The adapter
 * ------------------------------------------------------------------ */

export class VercelHostingAdapter implements HostingProvider {
  readonly #client: HostingVendorClient;
  readonly #resolver: HostingValueResolver;
  readonly #redactor: Redactor | undefined;
  readonly #calls = new Map<string, number>();
  readonly #effects = new Map<string, unknown>();
  readonly #targets = new Map<string, TargetState>();
  readonly #byHandle = new Map<HostingTargetHandle, TargetState>();

  constructor(
    client: HostingVendorClient,
    resolver: HostingValueResolver,
    options: VercelHostingAdapterOptions = {},
  ) {
    this.#client = client;
    this.#resolver = resolver;
    this.#redactor = options.redactor;
  }

  async inspect(
    request: HostingCapabilityInspectionRequest,
  ): Promise<HostingCapabilityInspection> {
    return this.#effect("inspect", async () => {
      const capabilities = await this.#client.describeCapabilities();
      const existing = await this.#client.findTarget(request.deterministicName);
      return {
        controlPlaneAccessible: capabilities.controlPlaneAccessible,
        deterministicNameAvailable: existing === undefined,
        existingTargetOwned:
          existing !== undefined &&
          existing.ownershipMarkerDigest === request.ownership.digest,
        runtimeProfileAvailable: capabilities.runtimeProfileIds.includes(
          request.runtimeProfileId,
        ),
        serverValueBindingSupported:
          capabilities.serverValueBindingSupported &&
          request.requiredServerValueCount >= 0,
        publicValueBindingSupported:
          capabilities.publicValueBindingSupported &&
          request.requiredPublicValueCount >= 0,
        pinnedRevisionBuildSupported: capabilities.pinnedRevisionBuildSupported,
        customDomainSupported: capabilities.customDomainSupported,
        scheduleCapacityAvailable:
          request.requiredScheduleCount <= capabilities.maximumSchedules,
        rollbackSupported: capabilities.rollbackSupported,
        automaticPromotionCanBeDisabled:
          capabilities.automaticPromotionCanBeDisabled,
        isolatedPreviewsSupported: capabilities.isolatedPreviewsSupported,
        validUntil: capabilities.validUntil,
      };
    });
  }

  async createDeploymentTarget(
    request: DeploymentTargetRequest,
  ): Promise<DeploymentTargetResult> {
    return this.#effect("createDeploymentTarget", async () => {
      const known = this.#targets.get(request.deterministicName);
      const existing = await this.#client.findTarget(request.deterministicName);
      if (existing !== undefined) {
        if (existing.ownershipMarkerDigest !== request.ownership.digest) {
          throw new OpsError(
            "provider_error",
            "Hosting target ownership marker mismatch",
          );
        }
        if (known !== undefined) {
          known.result = { ...known.result, adopted: true };
          return known.result;
        }
        return this.#recordTarget(request, existing, true, "createDeploymentTarget");
      }
      const created = await this.#client.createTarget({
        name: request.deterministicName,
        runtimeProfileId: request.runtimeProfileId,
        ownershipMarkerDigest: request.ownership.digest,
        automaticPromotionEnabled: false,
        isolatedPreviewsEnabled: false,
      });
      if (
        created.automaticPromotionEnabled ||
        created.isolatedPreviewsEnabled
      ) {
        throw new OpsError(
          "provider_error",
          "Hosting target was created with automatic promotion or isolated previews enabled",
        );
      }
      return this.#recordTarget(request, created, false, "createDeploymentTarget");
    });
  }

  async bindEnvironment(
    request: EnvironmentBindingRequest,
  ): Promise<EnvironmentBindingResult> {
    const descriptors = request.bindings.map((binding) => ({
      name: binding.name,
      valueClass: binding.valueClass,
      sourceKind: binding.source.kind,
    }));
    const bindingDigest = bindingDigestOf(descriptors);
    return this.#idempotentEffect(
      "bindEnvironment",
      `${request.targetHandle}:${bindingDigest}`,
      async () => {
        const state = this.#requireTarget(request.targetHandle);
        const values: HostingVendorEnvironmentValue[] = [];
        for (const binding of request.bindings) {
          const value = await this.#resolver.resolve(binding.source);
          if (binding.valueClass === "server_secret") {
            this.#redactor?.registerSecret(value);
          }
          values.push({
            name: binding.name,
            value,
            secret: binding.valueClass === "server_secret",
          });
        }
        // Written to the provider, then dropped. `values` is never returned and
        // never stored on the adapter.
        await this.#client.putEnvironmentValues(state.targetId, values);
        const result: EnvironmentBindingResult = {
          hostingRequestId: requestId(
            "bindEnvironment",
            this.#callCount("bindEnvironment"),
          ),
          targetHandle: state.handle,
          scope: request.scope,
          bindings: descriptors,
          bindingDigest,
        };
        state.binding = result;
        return result;
      },
    );
  }

  async buildRelease(request: ReleaseBuildRequest): Promise<ReleaseBuildResult> {
    const key = releaseKey(request);
    return this.#idempotentEffect("buildRelease", key, async () => {
      const state = this.#requireTarget(request.targetHandle);
      if (!/^[0-9a-f]{40}$/.test(request.revisionId)) {
        throw new OpsError(
          "provider_error",
          "Build requires a full 40-character pinned revision",
        );
      }
      const built = await this.#client.createRelease({
        targetId: state.targetId,
        revisionId: request.revisionId,
        buildRecipeId: request.buildRecipeId,
        publicValueNames: [...request.publicValueNames].sort(),
      });
      if (built.state !== "ready") {
        throw new OpsError(
          "provider_error",
          `Pinned build did not reach a verified state (${built.state})`,
        );
      }
      if (built.revisionId !== request.revisionId) {
        throw new OpsError(
          "provider_error",
          "Provider built a different revision than the pinned one",
        );
      }
      const releaseHandle = stableId("hrel", key);
      const result: ReleaseBuildResult = {
        hostingRequestId: requestId(
          "buildRelease",
          this.#callCount("buildRelease"),
        ),
        releaseHandle,
        targetHandle: state.handle,
        revisionId: request.revisionId,
        revisionPinned: true,
        buildRecipeId: request.buildRecipeId,
        publicValueNames: [...request.publicValueNames].sort(),
        scheduleManifestDigest: request.scheduleManifestDigest,
        artifactDigest: built.artifactDigest,
        status: "verified",
      };
      state.releases.set(releaseHandle, result);
      state.releaseIds.set(releaseHandle, built.releaseId);
      return result;
    });
  }

  async assignDomain(
    request: DomainAssignmentRequest,
  ): Promise<DomainAssignmentResult> {
    return this.#idempotentEffect(
      "assignDomain",
      `${request.targetHandle}:${request.hostname}`,
      async () => {
        const state = this.#requireTarget(request.targetHandle);
        if (state.ownershipMarkerDigest !== request.ownership.digest) {
          throw new OpsError(
            "provider_error",
            "Domain assignment ownership marker mismatch",
          );
        }
        const existing = await this.#client.findDomain(
          state.targetId,
          request.hostname,
        );
        if (existing !== undefined && existing.targetId !== state.targetId) {
          throw new OpsError(
            "provider_error",
            "Hostname is already assigned to another deployment target",
          );
        }
        const bound =
          existing ??
          (await this.#client.attachDomain(state.targetId, request.hostname));
        const result: DomainAssignmentResult = {
          hostingRequestId: requestId(
            "assignDomain",
            this.#callCount("assignDomain"),
          ),
          targetHandle: state.handle,
          hostname: request.hostname,
          assigned: true,
          certificateReady: bound.certificateReady,
          certificateMode: request.certificateMode,
          ownershipMarkerDigest: request.ownership.digest,
        };
        state.domain = result;
        return result;
      },
    );
  }

  async registerSchedules(
    request: ScheduleRegistrationRequest,
  ): Promise<ScheduleRegistrationResult> {
    const registered = normalizeSchedules(request.schedules);
    const computed = scheduleManifestDigest(registered);
    return this.#idempotentEffect(
      "registerSchedules",
      `${request.targetHandle}:${request.releaseHandle}:${computed}`,
      async () => {
        const state = this.#requireTarget(request.targetHandle);
        const release = state.releases.get(request.releaseHandle);
        if (release === undefined) {
          throw new OpsError(
            "provider_error",
            "Schedules must be registered against a built release",
          );
        }
        if (computed !== request.manifestDigest) {
          throw new OpsError(
            "provider_error",
            "Schedule manifest digest does not match the submitted schedules",
          );
        }
        const ids = new Set<string>();
        for (const schedule of registered) {
          if (ids.has(schedule.scheduleId)) {
            throw new OpsError(
              "provider_error",
              `Duplicate schedule ${schedule.scheduleId}`,
            );
          }
          ids.add(schedule.scheduleId);
        }
        // The step the fake has no reason to take: on a file-routing provider
        // the schedule set is baked into the release, so the adapter reads it
        // back off the pinned revision and refuses to claim a registration the
        // artifact does not actually carry.
        await this.#assertReleaseDeclaresSchedules(release.revisionId, registered);
        state.schedules = {
          releaseHandle: request.releaseHandle,
          registered,
          manifestDigest: computed,
        };
        return {
          hostingRequestId: requestId(
            "registerSchedules",
            this.#callCount("registerSchedules"),
          ),
          targetHandle: state.handle,
          releaseHandle: request.releaseHandle,
          registered,
          manifestDigest: computed,
        };
      },
    );
  }

  async promoteRelease(request: PromotionRequest): Promise<RolloutResult> {
    // Checked before the idempotent effect for the same reason the fake checks
    // it there: the effect cache is keyed on target+release, so without this a
    // return to a superseded release would silently replay the original
    // promotion instead of recording a rollout.
    const existing = this.#byHandle.get(request.targetHandle);
    if (
      existing !== undefined &&
      existing.rollouts.at(-1)?.releaseHandle !== request.releaseHandle &&
      existing.rollouts.some(
        (rollout) => rollout.releaseHandle === request.releaseHandle,
      )
    ) {
      throw new OpsError(
        "provider_error",
        "This release was already superseded; returning to it is a rollback",
      );
    }
    return this.#idempotentEffect(
      "promoteRelease",
      `${request.targetHandle}:${request.releaseHandle}`,
      async () => {
        const state = this.#requireTarget(request.targetHandle);
        const releaseId = state.releaseIds.get(request.releaseHandle);
        if (releaseId === undefined) {
          throw new OpsError("provider_error", "Unknown release for this target");
        }
        await this.#client.activateRelease(state.targetId, releaseId);
        return this.#recordRollout(
          state,
          "promote",
          request.releaseHandle,
          null,
          this.#callCount("promoteRelease"),
          "promoteRelease",
        );
      },
    );
  }

  async rollbackRelease(request: RollbackRequest): Promise<RolloutResult> {
    return this.#idempotentEffect(
      "rollbackRelease",
      `${request.targetHandle}:${request.releaseHandle}:${request.supersededReleaseHandle}`,
      async () => {
        const state = this.#requireTarget(request.targetHandle);
        const active = state.rollouts.at(-1);
        if (active === undefined) {
          throw new OpsError(
            "provider_error",
            "Nothing has been promoted, so nothing can be rolled back",
          );
        }
        if (active.releaseHandle !== request.supersededReleaseHandle) {
          throw new OpsError(
            "provider_error",
            "Superseded release is not the currently active release",
          );
        }
        if (request.releaseHandle === request.supersededReleaseHandle) {
          throw new OpsError(
            "provider_error",
            "Rollback target must differ from the release being withdrawn",
          );
        }
        const everActive = state.rollouts.some(
          (rollout) => rollout.releaseHandle === request.releaseHandle,
        );
        if (!everActive) {
          throw new OpsError(
            "provider_error",
            "Rollback target was never active on this deployment",
          );
        }
        const releaseId = state.releaseIds.get(request.releaseHandle);
        if (releaseId === undefined) {
          throw new OpsError("provider_error", "Unknown release for this target");
        }
        await this.#client.activateRelease(state.targetId, releaseId);
        return this.#recordRollout(
          state,
          "rollback",
          request.releaseHandle,
          request.reasonCode,
          this.#callCount("rollbackRelease"),
          "rollbackRelease",
        );
      },
    );
  }

  async verifyDeployment(
    request: DeploymentVerificationRequest,
  ): Promise<HostingVerificationReport> {
    return this.#effect("verifyDeployment", async () => {
      const state = this.#requireTarget(request.targetHandle);
      const last = state.rollouts.at(-1) ?? null;
      const activeRelease =
        last === null ? null : (state.releases.get(last.releaseHandle) ?? null);
      const observedReleaseId = await this.#client.activeReleaseId(state.targetId);
      const expectedReleaseId =
        last === null ? null : (state.releaseIds.get(last.releaseHandle) ?? null);
      const checks =
        last === null || expectedReleaseId === null
          ? []
          : await this.#client.runRuntimeChecks(
              state.targetId,
              expectedReleaseId,
              request.runtimeCheckIds,
            );
      const byCheckId = new Map(checks.map((check) => [check.checkId, check.passed]));
      const failedCheckIds = request.runtimeCheckIds.filter(
        (id) => byCheckId.get(id) !== true,
      );
      const passedCheckIds = request.runtimeCheckIds.filter(
        (id) => byCheckId.get(id) === true,
      );

      const registered = state.schedules?.registered ?? [];
      const registeredIds = new Set(registered.map((entry) => entry.scheduleId));
      const expected = normalizeSchedules(request.expectedSchedules);
      const expectedIds = expected.map((entry) => entry.scheduleId);
      const expectedSet = new Set(expectedIds);
      const missingScheduleIds = expectedIds.filter((id) => !registeredIds.has(id));
      const unexpectedScheduleIds = [...registeredIds]
        .filter((id) => !expectedSet.has(id))
        .sort();
      const registeredMatchesExpected =
        canonicalJson(registered.map(scheduleAsJson)) ===
        canonicalJson(expected.map(scheduleAsJson));

      const reachable =
        observedReleaseId !== null && observedReleaseId === expectedReleaseId;
      const activeReleaseMatchesExpected =
        last?.releaseHandle === request.expectedActiveReleaseHandle;
      const domainMatches = state.domain?.hostname === request.expectedHostname;
      const revisionMatches =
        activeRelease?.revisionId === request.expectedRevisionId;
      const manifestMatchesRelease =
        state.schedules !== undefined &&
        activeRelease !== null &&
        state.schedules.releaseHandle === activeRelease.releaseHandle &&
        state.schedules.manifestDigest === activeRelease.scheduleManifestDigest;

      const passed =
        reachable &&
        activeRelease !== null &&
        activeReleaseMatchesExpected &&
        revisionMatches &&
        registeredMatchesExpected &&
        missingScheduleIds.length === 0 &&
        unexpectedScheduleIds.length === 0 &&
        manifestMatchesRelease &&
        (state.domain?.assigned ?? false) &&
        (state.domain?.certificateReady ?? false) &&
        domainMatches &&
        failedCheckIds.length === 0;

      return {
        hostingRequestId: requestId(
          "verifyDeployment",
          this.#callCount("verifyDeployment"),
        ),
        targetHandle: state.handle,
        status: passed ? ("passed" as const) : ("failed" as const),
        runtime: {
          reachable,
          activeReleaseHandle: last?.releaseHandle ?? null,
          activeReleaseMatchesExpected,
          passedCheckIds,
          failedCheckIds,
        },
        schedules: {
          registered,
          expectedScheduleIds: expectedIds,
          missingScheduleIds,
          unexpectedScheduleIds,
          manifestDigest: state.schedules?.manifestDigest ?? null,
          manifestMatchesRelease,
        },
        domain: {
          hostname: state.domain?.hostname ?? null,
          assigned: state.domain?.assigned ?? false,
          certificateReady: state.domain?.certificateReady ?? false,
          matchesExpected: domainMatches,
          servesActiveRelease: domainMatches && last !== null,
        },
        build: {
          releaseHandle: activeRelease?.releaseHandle ?? null,
          revisionId: activeRelease?.revisionId ?? null,
          revisionPinned: activeRelease?.revisionPinned ?? false,
          revisionMatchesExpected: revisionMatches,
          buildRecipeId: activeRelease?.buildRecipeId ?? null,
          artifactDigest: activeRelease?.artifactDigest ?? null,
          publicValueNames: activeRelease?.publicValueNames ?? [],
          scheduleManifestDigest: activeRelease?.scheduleManifestDigest ?? null,
        },
        rollout: {
          rolloutKind: last?.kind ?? null,
          rolloutSequence: last?.sequence ?? 0,
          previousReleaseHandle: last?.previousReleaseHandle ?? null,
        },
      };
    });
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  async #assertReleaseDeclaresSchedules(
    revisionId: string,
    registered: readonly HostingSchedule[],
  ): Promise<void> {
    const declared = await this.#client.readReleaseSchedules(revisionId);
    const declaredShapes = [...declared].map(vendorScheduleShape).sort();
    const requestedShapes = [...registered].map(scheduleShape).sort();
    if (canonicalJson(declaredShapes) !== canonicalJson(requestedShapes)) {
      throw new OpsError(
        "provider_error",
        "The pinned release does not declare the schedules the plan approved",
      );
    }
  }

  #recordTarget(
    request: DeploymentTargetRequest,
    vendor: HostingVendorTarget,
    adopted: boolean,
    method: string,
  ): DeploymentTargetResult {
    const handle = stableId("htgt", request.deterministicName);
    const result: DeploymentTargetResult = {
      hostingRequestId: requestId(method, this.#callCount(method)),
      targetHandle: handle,
      deterministicName: request.deterministicName,
      workspaceClass: request.workspaceClass,
      runtimeProfileId: request.runtimeProfileId,
      ownershipMarkerDigest: request.ownership.digest,
      lifecycle: vendor.lifecycle,
      adopted,
      automaticPromotionEnabled: false,
      isolatedPreviewsEnabled: false,
    };
    const state: TargetState = {
      handle,
      targetId: vendor.targetId,
      deterministicName: request.deterministicName,
      ownershipMarkerDigest: request.ownership.digest,
      result,
      releases: new Map(),
      releaseIds: new Map(),
      rollouts: [],
    };
    this.#targets.set(request.deterministicName, state);
    this.#byHandle.set(handle, state);
    return result;
  }

  #recordRollout(
    state: TargetState,
    kind: "promote" | "rollback",
    releaseHandle: HostingReleaseHandle,
    reasonCode: string | null,
    call: number,
    method: string,
  ): RolloutResult {
    const previous = state.rollouts.at(-1)?.releaseHandle ?? null;
    const sequence = state.rollouts.length + 1;
    state.rollouts.push({
      kind,
      releaseHandle,
      previousReleaseHandle: previous,
      sequence,
      reasonCode,
    });
    return {
      hostingRequestId: requestId(method, call),
      targetHandle: state.handle,
      rolloutHandle: stableId("hroll", `${state.handle}:${kind}:${sequence}`),
      rolloutKind: kind,
      activeReleaseHandle: releaseHandle,
      previousReleaseHandle: previous,
      rolloutSequence: sequence,
      reasonCode,
    };
  }

  #requireTarget(targetHandle: HostingTargetHandle): TargetState {
    const state = this.#byHandle.get(targetHandle);
    if (state === undefined) {
      throw new OpsError("provider_error", "Unknown hosting deployment target");
    }
    return state;
  }

  #callCount(method: string): number {
    return this.#calls.get(method) ?? 0;
  }

  async #effect<T>(method: string, apply: () => Promise<T>): Promise<T> {
    this.#calls.set(method, this.#callCount(method) + 1);
    return apply();
  }

  async #idempotentEffect<T>(
    method: string,
    key: string,
    apply: () => Promise<T>,
  ): Promise<T> {
    return this.#effect(method, async () => {
      const cacheKey = `${method}:${key}`;
      const existing = this.#effects.get(cacheKey);
      if (existing !== undefined) return existing as T;
      const result = await apply();
      this.#effects.set(cacheKey, result);
      return result;
    });
  }
}
