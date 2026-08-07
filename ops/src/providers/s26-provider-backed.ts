import { Redactor } from "../core/redaction.js";
import type { OnboardingProviders, TenantRecoveryProviders } from "./interfaces.js";
import {
  IdentityOperationsAdapter,
  NeonDataAdapter,
  R2ObjectStorageAdapter,
  StrictDomainAdapter,
  StrictHostingAdapter,
  StrictSmtpAdapter,
  StrictSourceRepositoryAdapter,
} from "./adapters.js";
import type { S26OperationsApiBundle } from "./apis.js";

/**
 * The production composition point for S26.  This is deliberately separate
 * from `p4c-sdk.ts`: passing a retained Supabase/P4-C port here is impossible
 * at compile time because the bundle requires the recovery capabilities in
 * addition to the approved Neon, Better Auth, R2 and Vercel named APIs.
 *
 * It has no constructor side effects. Provider credentials are consumed only
 * by the reviewed backend when an owner-approved core operation reaches it;
 * planning and tests can supply mocked provider contracts without a network.
 */
export class S26ProviderBackedOperations {
  readonly onboarding: OnboardingProviders;
  readonly recovery: TenantRecoveryProviders;

  constructor(apis: S26OperationsApiBundle, redactor = new Redactor()) {
    this.onboarding = {
      data: new NeonDataAdapter(apis.data, redactor),
      identity: new IdentityOperationsAdapter(apis.identity, redactor),
      objectStorage: new R2ObjectStorageAdapter(apis.objectStorage, redactor),
      hosting: new StrictHostingAdapter(apis.hosting, redactor),
      email: new StrictSmtpAdapter(apis.email, redactor),
      domain: new StrictDomainAdapter(apis.domain, redactor),
      sourceRepository: new StrictSourceRepositoryAdapter(apis.sourceRepository, redactor),
    };
    this.recovery = {
      data: apis.data,
      identity: apis.identity,
      objectStorage: apis.objectStorage,
      hosting: apis.hosting,
    };
  }
}
