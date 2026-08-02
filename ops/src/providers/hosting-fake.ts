/**
 * In-memory hosting adapter.
 *
 * It satisfies the whole canonical contract with no external provider, no
 * network and no credentials, so the capability suite can run anywhere. It
 * reuses `FakeProviderBase`, so before-effect / after-effect / outcome-unknown
 * failure injection behaves exactly as it does for the other fakes.
 *
 * Secret handling is the point of the environment-binding parts: the fake
 * genuinely resolves secret material into a private vault, and no code path
 * returns any of it. A fake that never held a secret could not prove that.
 */

import { createHash } from "node:crypto";

import { canonicalJson, sha256Digest } from "../core/canonical.js";
import { OpsError } from "../core/errors.js";
import { FakeProviderBase, type FailureRule } from "./fakes.js";
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
  type HostingProvider,
  type HostingReleaseHandle,
  type HostingSchedule,
  type HostingTargetHandle,
  type HostingVerificationReport,
  type PromotionRequest,
  type ReleaseBuildRequest,
  type ReleaseBuildResult,
  type RollbackRequest,
  type RolloutResult,
  type ScheduleRegistrationRequest,
  type ScheduleRegistrationResult,
} from "./hosting.js";

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function requestId(method: string, call: number): string {
  return `req_${method.replaceAll(/[^a-z0-9]/gi, "_").toLowerCase()}_${call}`;
}

interface RolloutRecord {
  readonly kind: "promote" | "rollback";
  readonly releaseHandle: HostingReleaseHandle;
  readonly previousReleaseHandle: HostingReleaseHandle | null;
  readonly sequence: number;
  readonly reasonCode: string | null;
}

interface TargetState {
  readonly handle: HostingTargetHandle;
  readonly deterministicName: string;
  readonly ownershipMarkerDigest: string;
  result: DeploymentTargetResult;
  binding?: EnvironmentBindingResult;
  domain?: DomainAssignmentResult;
  readonly releases: Map<HostingReleaseHandle, ReleaseBuildResult>;
  schedules?: {
    readonly releaseHandle: HostingReleaseHandle;
    readonly registered: readonly HostingSchedule[];
    readonly manifestDigest: string;
  };
  readonly rollouts: RolloutRecord[];
}

export interface FakeHostingProviderOptions {
  /**
   * Secret material the adapter is expected to resolve, keyed by secret label
   * or generator ID. Values are consumed into the private vault and are never
   * part of any result.
   */
  readonly secretMaterial?: Readonly<Record<string, string>>;
  readonly certificateReady?: boolean;
  readonly failingRuntimeCheckIds?: readonly string[];
}

export class FakeHostingProvider extends FakeProviderBase implements HostingProvider {
  readonly #targets = new Map<string, TargetState>();
  readonly #byHandle = new Map<HostingTargetHandle, TargetState>();
  /** Resolved secret values. Deliberately unreachable from any public member. */
  readonly #vault = new Map<string, string>();
  readonly #options: FakeHostingProviderOptions;

  constructor(
    rules: readonly FailureRule[] = [],
    options: FakeHostingProviderOptions = {},
  ) {
    super(rules);
    this.#options = options;
  }

  get targetCount(): number {
    return this.#targets.size;
  }

  /** Count only — the fake never exposes stored secret material. */
  get resolvedSecretCount(): number {
    return this.#vault.size;
  }

  releaseCount(targetHandle: HostingTargetHandle): number {
    return this.#byHandle.get(targetHandle)?.releases.size ?? 0;
  }

  activeReleaseHandle(
    targetHandle: HostingTargetHandle,
  ): HostingReleaseHandle | null {
    const state = this.#byHandle.get(targetHandle);
    const last = state?.rollouts.at(-1);
    return last?.releaseHandle ?? null;
  }

  async inspect(
    request: HostingCapabilityInspectionRequest,
  ): Promise<HostingCapabilityInspection> {
    const existing = this.#targets.get(request.deterministicName);
    return this.effect("inspect", () => ({
      controlPlaneAccessible: true,
      deterministicNameAvailable: existing === undefined,
      existingTargetOwned:
        existing?.ownershipMarkerDigest === request.ownership.digest,
      runtimeProfileAvailable: true,
      serverValueBindingSupported: request.requiredServerValueCount >= 0,
      publicValueBindingSupported: request.requiredPublicValueCount >= 0,
      pinnedRevisionBuildSupported: true,
      customDomainSupported: true,
      scheduleCapacityAvailable: request.requiredScheduleCount <= 20,
      rollbackSupported: true,
      automaticPromotionCanBeDisabled: true,
      isolatedPreviewsSupported: true,
      validUntil: "2030-01-01T00:30:00.000Z",
    }));
  }

  async createDeploymentTarget(
    request: DeploymentTargetRequest,
  ): Promise<DeploymentTargetResult> {
    return this.effect("createDeploymentTarget", () => {
      const existing = this.#targets.get(request.deterministicName);
      if (existing !== undefined) {
        if (existing.ownershipMarkerDigest !== request.ownership.digest) {
          throw new OpsError(
            "provider_error",
            "Hosting target ownership marker mismatch",
          );
        }
        existing.result = { ...existing.result, adopted: true };
        return existing.result;
      }
      const handle = stableId("htgt", request.deterministicName);
      const result: DeploymentTargetResult = {
        hostingRequestId: requestId(
          "createDeploymentTarget",
          this.callCount("createDeploymentTarget"),
        ),
        targetHandle: handle,
        deterministicName: request.deterministicName,
        workspaceClass: request.workspaceClass,
        runtimeProfileId: request.runtimeProfileId,
        ownershipMarkerDigest: request.ownership.digest,
        lifecycle: "ready",
        adopted: false,
        automaticPromotionEnabled: false,
        isolatedPreviewsEnabled: false,
      };
      const state: TargetState = {
        handle,
        deterministicName: request.deterministicName,
        ownershipMarkerDigest: request.ownership.digest,
        result,
        releases: new Map(),
        rollouts: [],
      };
      this.#targets.set(request.deterministicName, state);
      this.#byHandle.set(handle, state);
      return result;
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
    const bindingDigest = sha256Digest(
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
    return this.idempotentEffect(
      "bindEnvironment",
      `${request.targetHandle}:${bindingDigest}`,
      () => {
        const state = this.#requireTarget(request.targetHandle);
        for (const binding of request.bindings) {
          const resolved = this.#resolve(binding.source);
          if (resolved !== null) {
            // Written to the target, then held privately. Never returned.
            this.#vault.set(`${state.handle}:${binding.name}`, resolved);
          }
        }
        const result: EnvironmentBindingResult = {
          hostingRequestId: requestId(
            "bindEnvironment",
            this.callCount("bindEnvironment"),
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
    const key = [
      request.targetHandle,
      request.revisionId,
      request.buildRecipeId,
      request.scheduleManifestDigest,
      [...request.publicValueNames].sort().join(","),
    ].join("|");
    return this.idempotentEffect("buildRelease", key, () => {
      const state = this.#requireTarget(request.targetHandle);
      if (!/^[0-9a-f]{40}$/.test(request.revisionId)) {
        throw new OpsError(
          "provider_error",
          "Build requires a full 40-character pinned revision",
        );
      }
      const releaseHandle = stableId("hrel", key);
      const result: ReleaseBuildResult = {
        hostingRequestId: requestId("buildRelease", this.callCount("buildRelease")),
        releaseHandle,
        targetHandle: state.handle,
        revisionId: request.revisionId,
        revisionPinned: true,
        buildRecipeId: request.buildRecipeId,
        publicValueNames: [...request.publicValueNames].sort(),
        scheduleManifestDigest: request.scheduleManifestDigest,
        artifactDigest: sha256Digest(key),
        status: "verified",
      };
      state.releases.set(releaseHandle, result);
      return result;
    });
  }

  async assignDomain(
    request: DomainAssignmentRequest,
  ): Promise<DomainAssignmentResult> {
    return this.idempotentEffect(
      "assignDomain",
      `${request.targetHandle}:${request.hostname}`,
      () => {
        const state = this.#requireTarget(request.targetHandle);
        if (state.ownershipMarkerDigest !== request.ownership.digest) {
          throw new OpsError(
            "provider_error",
            "Domain assignment ownership marker mismatch",
          );
        }
        const result: DomainAssignmentResult = {
          hostingRequestId: requestId("assignDomain", this.callCount("assignDomain")),
          targetHandle: state.handle,
          hostname: request.hostname,
          assigned: true,
          certificateReady: this.#options.certificateReady ?? true,
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
    return this.idempotentEffect(
      "registerSchedules",
      `${request.targetHandle}:${request.releaseHandle}:${computed}`,
      () => {
        const state = this.#requireTarget(request.targetHandle);
        if (!state.releases.has(request.releaseHandle)) {
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
        state.schedules = {
          releaseHandle: request.releaseHandle,
          registered,
          manifestDigest: computed,
        };
        return {
          hostingRequestId: requestId(
            "registerSchedules",
            this.callCount("registerSchedules"),
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
    // Checked before the idempotent effect, because the effect cache is keyed on
    // target+release: without this, returning to a superseded release would
    // silently replay the original promotion instead of recording a rollout.
    // Going back to an already-superseded release is a rollback, and the caller
    // has to say so.
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
    return this.idempotentEffect(
      "promoteRelease",
      `${request.targetHandle}:${request.releaseHandle}`,
      () => {
        const state = this.#requireTarget(request.targetHandle);
        if (!state.releases.has(request.releaseHandle)) {
          throw new OpsError("provider_error", "Unknown release for this target");
        }
        return this.#recordRollout(
          state,
          "promote",
          request.releaseHandle,
          null,
          this.callCount("promoteRelease"),
          "promoteRelease",
        );
      },
    );
  }

  async rollbackRelease(request: RollbackRequest): Promise<RolloutResult> {
    return this.idempotentEffect(
      "rollbackRelease",
      `${request.targetHandle}:${request.releaseHandle}:${request.supersededReleaseHandle}`,
      () => {
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
        return this.#recordRollout(
          state,
          "rollback",
          request.releaseHandle,
          request.reasonCode,
          this.callCount("rollbackRelease"),
          "rollbackRelease",
        );
      },
    );
  }

  async verifyDeployment(
    request: DeploymentVerificationRequest,
  ): Promise<HostingVerificationReport> {
    return this.effect("verifyDeployment", () => {
      const state = this.#requireTarget(request.targetHandle);
      const last = state.rollouts.at(-1) ?? null;
      const activeRelease =
        last === null ? null : (state.releases.get(last.releaseHandle) ?? null);
      const failingChecks = new Set(this.#options.failingRuntimeCheckIds ?? []);
      const failedCheckIds = request.runtimeCheckIds.filter((id) =>
        failingChecks.has(id),
      );
      const passedCheckIds = request.runtimeCheckIds.filter(
        (id) => !failingChecks.has(id),
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

      const activeReleaseMatchesExpected =
        last?.releaseHandle === request.expectedActiveReleaseHandle;
      const domainMatches = state.domain?.hostname === request.expectedHostname;
      const revisionMatches = activeRelease?.revisionId === request.expectedRevisionId;
      const manifestMatchesRelease =
        state.schedules !== undefined &&
        activeRelease !== null &&
        state.schedules.releaseHandle === activeRelease.releaseHandle &&
        state.schedules.manifestDigest === activeRelease.scheduleManifestDigest;

      const passed =
        last !== null &&
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
          this.callCount("verifyDeployment"),
        ),
        targetHandle: state.handle,
        status: passed ? ("passed" as const) : ("failed" as const),
        runtime: {
          reachable: last !== null,
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

  #resolve(
    source: EnvironmentBindingRequest["bindings"][number]["source"],
  ): string | null {
    const material = this.#options.secretMaterial ?? {};
    if (source.kind === "secret_label") {
      return material[source.secretLabel] ?? stableId("val", source.secretLabel);
    }
    if (source.kind === "generated_secret") {
      return material[source.generatorId] ?? stableId("gen", source.generatorId);
    }
    return null;
  }
}
