import { assertOps } from "./errors.js";
import { OnboardingExecutor } from "./onboarding-executor.js";
import {
  DisposableOnboardingPlanner,
  executionContextFromPlan,
  type DisposableDryRun,
} from "./onboarding-planner.js";
import type {
  DisposablePreflightReport,
} from "./provider-preflight.js";
import type {
  ApplyRequest,
  OperationState,
  PlanEnvelope,
} from "./types.js";
import { validateProviderSnapshots } from "./semantic-validation.js";
import { onboardingBusinessInputsSchema } from "../mcp/schemas.js";
import type { OnboardingProviders } from "../providers/interfaces.js";
import type { Registry } from "../state/registry.js";

export interface AdvanceOnboardingResult {
  readonly operationId: string;
  readonly state: OperationState;
  readonly resumed: boolean;
  readonly executedOrdinal: number | null;
}

export class DisposableOnboardingCore {
  readonly #registry: Registry;
  readonly #providers: OnboardingProviders;
  readonly #planner: DisposableOnboardingPlanner;
  readonly #clock: () => Date;

  constructor(
    registry: Registry,
    providers: OnboardingProviders,
    planner: DisposableOnboardingPlanner,
    clock: () => Date = () => new Date(),
  ) {
    this.#registry = registry;
    this.#providers = providers;
    this.#planner = planner;
    this.#clock = clock;
  }

  preflight(inputs: unknown): Promise<DisposablePreflightReport> {
    return this.#planner.preflight(inputs);
  }

  dryRunPlan(inputs: unknown): Promise<DisposableDryRun> {
    return this.#planner.dryRun(inputs);
  }

  planOnboarding(inputs: unknown): Promise<DisposableDryRun> {
    return this.#planner.planAndStore(inputs);
  }

  async applyOrResume(request: ApplyRequest): Promise<AdvanceOnboardingResult> {
    const plan = this.#registry.getPlan(request.plan_id);
    assertOps(plan, "invalid_plan", "Unknown onboarding plan");
    this.#assertDisposable(plan);
    const inputs = this.#businessInputs(plan);
    const preflight = await this.#planner.preflight(inputs);
    assertOps(
      preflight.status === "passed",
      "provider_snapshot_drift",
      "Disposable onboarding preflight no longer passes",
    );
    validateProviderSnapshots(plan, preflight.snapshots, this.#clock());
    const started = this.#registry.startOrResumeOperation(
      request,
      "owner-mcp",
      preflight.snapshots,
      this.#clock(),
    );
    if (started.state !== "running") {
      return {
        operationId: started.operationId,
        state: started.state,
        resumed: started.resumed,
        executedOrdinal: null,
      };
    }
    const executor = new OnboardingExecutor(this.#registry, this.#providers);
    const result = await executor.executeNext(
      executionContextFromPlan(
        plan,
        started.operationId,
        started.fencingToken,
        this.#registry.ownerUuid,
      ),
    );
    const operation = this.#registry.getOperation(started.operationId);
    assertOps(operation, "invalid_plan", "Onboarding operation disappeared");
    return {
      operationId: started.operationId,
      state: operation.state,
      resumed: started.resumed,
      executedOrdinal: result.ordinal,
    };
  }

  #assertDisposable(plan: PlanEnvelope): void {
    const spec = plan.spec as Record<string, unknown>;
    const inputs = spec.inputs as Record<string, unknown>;
    assertOps(
      inputs.workspace_class === "disposable" &&
        inputs.release_channel === "canary",
      "unsupported_contract",
      "P4-B apply is limited to disposable canary tenants",
    );
  }

  #businessInputs(plan: PlanEnvelope): unknown {
    const spec = plan.spec as Record<string, unknown>;
    const planInputs = spec.inputs as Record<string, unknown>;
    const { support_access: supportAccess, ...rest } = planInputs;
    return onboardingBusinessInputsSchema.parse({
      ...rest,
      support_access_policy: supportAccess,
    });
  }
}
