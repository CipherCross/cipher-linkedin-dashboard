/**
 * The in-memory onboarding provider bundle.
 *
 * It lives beside `fakes.ts` rather than inside it because `hosting-fake.ts`
 * extends `FakeProviderBase` from `fakes.ts`; assembling the bundle there would
 * make the two modules import each other and leave `FakeProviderBase`
 * uninitialised at class-evaluation time.
 */

import {
  FakeIdentityProvider,
  FakeDomainProvider,
  FakeSmtpProvider,
  FakeSourceRepositoryProvider,
  FakeNeonDataProvider,
  FakeObjectStorageProvider,
  type FailureRule,
} from "./fakes.js";
import {
  FakeHostingProvider,
  type FakeHostingProviderOptions,
} from "./hosting-fake.js";
import type { OnboardingProviders } from "./interfaces.js";

export interface FakeProviderFailureRules {
  readonly data?: readonly FailureRule[];
  readonly identity?: readonly FailureRule[];
  readonly objectStorage?: readonly FailureRule[];
  readonly email?: readonly FailureRule[];
  readonly supabase?: readonly FailureRule[];
  readonly hosting?: readonly FailureRule[];
  readonly auth?: readonly FailureRule[];
  readonly smtp?: readonly FailureRule[];
  readonly domain?: readonly FailureRule[];
  readonly sourceRepository?: readonly FailureRule[];
}

export class FakeOnboardingProviderBundle implements OnboardingProviders {
  readonly data: FakeNeonDataProvider;
  readonly identity: FakeIdentityProvider;
  readonly objectStorage: FakeObjectStorageProvider;
  readonly hosting: FakeHostingProvider;
  readonly email: FakeSmtpProvider;
  readonly domain: FakeDomainProvider;
  readonly sourceRepository: FakeSourceRepositoryProvider;

  constructor(
    rules: FakeProviderFailureRules = {},
    hostingOptions: FakeHostingProviderOptions = {},
  ) {
    this.data = new FakeNeonDataProvider(rules.data ?? rules.supabase);
    this.identity = new FakeIdentityProvider(rules.identity ?? rules.auth);
    this.objectStorage = new FakeObjectStorageProvider(
      rules.objectStorage ?? rules.data ?? rules.supabase,
    );
    this.hosting = new FakeHostingProvider(rules.hosting, hostingOptions);
    this.email = new FakeSmtpProvider(rules.email ?? rules.smtp);
    this.domain = new FakeDomainProvider(rules.domain);
    this.sourceRepository = new FakeSourceRepositoryProvider(
      rules.sourceRepository,
    );
  }
}
