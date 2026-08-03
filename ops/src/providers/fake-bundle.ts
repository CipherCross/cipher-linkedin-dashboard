/**
 * The in-memory onboarding provider bundle.
 *
 * It lives beside `fakes.ts` rather than inside it because `hosting-fake.ts`
 * extends `FakeProviderBase` from `fakes.ts`; assembling the bundle there would
 * make the two modules import each other and leave `FakeProviderBase`
 * uninitialised at class-evaluation time.
 */

import {
  FakeAuthProvider,
  FakeDomainProvider,
  FakeSmtpProvider,
  FakeSourceRepositoryProvider,
  FakeSupabaseProvider,
  type FailureRule,
} from "./fakes.js";
import {
  FakeHostingProvider,
  type FakeHostingProviderOptions,
} from "./hosting-fake.js";
import type { OnboardingProviders } from "./interfaces.js";

export interface FakeProviderFailureRules {
  readonly supabase?: readonly FailureRule[];
  readonly hosting?: readonly FailureRule[];
  readonly auth?: readonly FailureRule[];
  readonly smtp?: readonly FailureRule[];
  readonly domain?: readonly FailureRule[];
  readonly sourceRepository?: readonly FailureRule[];
}

export class FakeOnboardingProviderBundle implements OnboardingProviders {
  readonly supabase: FakeSupabaseProvider;
  readonly hosting: FakeHostingProvider;
  readonly auth: FakeAuthProvider;
  readonly smtp: FakeSmtpProvider;
  readonly domain: FakeDomainProvider;
  readonly sourceRepository: FakeSourceRepositoryProvider;

  constructor(
    rules: FakeProviderFailureRules = {},
    hostingOptions: FakeHostingProviderOptions = {},
  ) {
    this.supabase = new FakeSupabaseProvider(rules.supabase);
    this.hosting = new FakeHostingProvider(rules.hosting, hostingOptions);
    this.auth = new FakeAuthProvider(rules.auth);
    this.smtp = new FakeSmtpProvider(rules.smtp);
    this.domain = new FakeDomainProvider(rules.domain);
    this.sourceRepository = new FakeSourceRepositoryProvider(
      rules.sourceRepository,
    );
  }
}
