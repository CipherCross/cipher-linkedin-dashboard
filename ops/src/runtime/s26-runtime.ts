import { DisposableOnboardingCore } from "../core/onboarding-core.js";
import { DisposableOnboardingPlanner } from "../core/onboarding-planner.js";
import {
  ProviderPreflightService,
  type DisposableOnboardingProfile,
} from "../core/provider-preflight.js";
import { Redactor } from "../core/redaction.js";
import { RegistryOwnerOperationsAdapter } from "../mcp/adapter.js";
import type { S26OperationsApiBundle } from "../providers/apis.js";
import { S26ProviderBackedOperations } from "../providers/s26-provider-backed.js";
import { TenantRecoveryService } from "../recovery/tenant-recovery.js";
import type { Registry } from "../state/registry.js";

export interface S26Runtime {
  readonly ownerOperations: RegistryOwnerOperationsAdapter;
  readonly recovery: TenantRecoveryService;
}

/**
 * Wires reviewed provider-backed adapters into the existing provider-neutral
 * operations core. It intentionally accepts a profile generated from current
 * approved catalogs; this session does not manufacture an owner plan or reuse
 * the expired S26 plan.
 */
export function createS26Runtime(
  registry: Registry,
  profile: DisposableOnboardingProfile,
  apis: S26OperationsApiBundle,
  redactor = new Redactor(),
  clock: () => Date = () => new Date(),
): S26Runtime {
  const providers = new S26ProviderBackedOperations(apis, redactor);
  const preflight = new ProviderPreflightService(providers.onboarding, profile, {
    redactor,
    clock,
  });
  const planner = new DisposableOnboardingPlanner(registry, profile, preflight, clock);
  const core = new DisposableOnboardingCore(
    registry,
    providers.onboarding,
    planner,
    clock,
    true,
  );
  return {
    ownerOperations: new RegistryOwnerOperationsAdapter(registry, () => [], core),
    recovery: new TenantRecoveryService(providers.recovery, redactor),
  };
}
