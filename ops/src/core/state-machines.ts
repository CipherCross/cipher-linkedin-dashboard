import { OpsError } from "./errors.js";
import type {
  OperationState,
  PlanState,
  StepState,
  TenantLifecycle,
} from "./types.js";

const planTransitions: Readonly<Record<PlanState, readonly PlanState[]>> = {
  draft: ["valid", "blocked"],
  valid: ["consumed", "expired", "invalidated"],
  blocked: ["invalidated"],
  consumed: [],
  expired: [],
  invalidated: [],
};

const tenantTransitions: Readonly<Record<TenantLifecycle, readonly TenantLifecycle[]>> = {
  absent: ["planned"],
  planned: ["provisioning"],
  provisioning: ["verifying", "quarantined"],
  verifying: ["active", "quarantined"],
  active: ["suspended", "offboarding_planned"],
  quarantined: ["provisioning", "verifying"],
  suspended: ["active", "offboarding_planned"],
  offboarding_planned: ["retained"],
  retained: [],
};

const operationTransitions: Readonly<Record<OperationState, readonly OperationState[]>> = {
  pending: ["running"],
  running: [
    "waiting_provider",
    "failed",
    "quarantined",
    "succeeded",
    "partially_succeeded",
  ],
  waiting_provider: ["running", "failed", "quarantined"],
  failed: ["running", "quarantined"],
  quarantined: ["running"],
  succeeded: [],
  partially_succeeded: [],
};

const stepTransitions: Readonly<Record<StepState, readonly StepState[]>> = {
  pending: ["running"],
  running: ["waiting_provider", "failed", "outcome_unknown", "succeeded"],
  waiting_provider: ["running", "failed", "outcome_unknown"],
  failed: ["running"],
  outcome_unknown: ["running", "failed", "succeeded"],
  succeeded: [],
  not_applicable: [],
};

function assertTransition<T extends string>(
  machine: Readonly<Record<T, readonly T[]>>,
  entity: string,
  from: T,
  to: T,
): void {
  if (!machine[from].includes(to)) {
    throw new OpsError(
      "invalid_state_transition",
      `Invalid ${entity} state transition: ${from} -> ${to}`,
      { entity, from, to },
    );
  }
}

export function assertPlanTransition(from: PlanState, to: PlanState): void {
  assertTransition(planTransitions, "plan", from, to);
}

export function assertTenantTransition(
  from: TenantLifecycle,
  to: TenantLifecycle,
): void {
  assertTransition(tenantTransitions, "tenant", from, to);
}

export function assertOperationTransition(
  from: OperationState,
  to: OperationState,
  operationKind: "tenant_onboarding" | "release",
): void {
  assertTransition(operationTransitions, "operation", from, to);
  if (to === "partially_succeeded" && operationKind !== "release") {
    throw new OpsError(
      "invalid_state_transition",
      "Only release operations may partially succeed",
      { operationKind, from, to },
    );
  }
}

export function assertStepTransition(from: StepState, to: StepState): void {
  assertTransition(stepTransitions, "step", from, to);
}
