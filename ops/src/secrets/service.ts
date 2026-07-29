import { OpsError, assertOps } from "../core/errors.js";
import { Redactor } from "../core/redaction.js";
import type { Registry, SecretReference } from "../state/registry.js";
import {
  isSecretName,
  labelsForSecret,
  type SecretLocator,
  type SecretStore,
} from "./types.js";

export interface SecretSetResult {
  readonly scope: "platform" | "tenant";
  readonly tenantSlug?: string | undefined;
  readonly name: string;
  readonly keychainServiceLabel: string;
  readonly keychainAccountLabel: string;
  readonly version: number;
  readonly rotatedAt: string;
}

export class SecretBootstrapService {
  readonly #registry: Registry;
  readonly #store: SecretStore;
  readonly #redactor: Redactor;

  constructor(registry: Registry, store: SecretStore, redactor: Redactor) {
    this.#registry = registry;
    this.#store = store;
    this.#redactor = redactor;
  }

  async set(
    rawLocator: {
      readonly scope: "platform" | "tenant";
      readonly name: string;
      readonly tenantSlug?: string | undefined;
    },
    value: string,
    actor = "owner-cli",
    now = new Date(),
  ): Promise<SecretSetResult> {
    assertOps(
      isSecretName(rawLocator.scope, rawLocator.name),
      "secret_invalid",
      `Unsupported ${rawLocator.scope} secret name`,
    );
    if (rawLocator.scope === "platform") {
      assertOps(
        rawLocator.tenantSlug === undefined,
        "secret_invalid",
        "Platform secrets cannot have a tenant slug",
      );
    } else {
      assertOps(
        rawLocator.tenantSlug !== undefined,
        "secret_invalid",
        "Tenant secrets require a tenant slug",
      );
    }
    const locator = rawLocator as SecretLocator;
    const labels = labelsForSecret(locator);
    const tenant =
      locator.scope === "tenant"
        ? this.#registry.getTenantBySlug(locator.tenantSlug!)
        : undefined;
    if (locator.scope === "tenant") {
      assertOps(tenant, "secret_invalid", "Unknown tenant slug");
    }

    this.#redactor.registerSecret(value);
    await this.#store.set(labels, value);
    const reference = this.#registry.saveSecretReference(
      {
        scope: locator.scope,
        tenantId: tenant?.tenantId,
        secretName: locator.name,
        keychainServiceLabel: labels.service,
        keychainAccountLabel: labels.account,
      },
      actor,
      now,
    );
    return toResult(reference, locator.tenantSlug);
  }

  async check(
    locator: SecretLocator,
  ): Promise<{ readonly available: boolean; readonly labels: string }> {
    assertOps(
      isSecretName(locator.scope, locator.name),
      "secret_invalid",
      "Unsupported secret name",
    );
    const labels = labelsForSecret(locator);
    return {
      available: await this.#store.has(labels),
      labels: `${labels.service}/${labels.account}`,
    };
  }
}

function toResult(
  reference: SecretReference,
  tenantSlug?: string,
): SecretSetResult {
  return {
    scope: reference.scope,
    ...(tenantSlug === undefined ? {} : { tenantSlug }),
    name: reference.secretName,
    keychainServiceLabel: reference.keychainServiceLabel,
    keychainAccountLabel: reference.keychainAccountLabel,
    version: reference.version,
    rotatedAt: reference.rotatedAt,
  };
}

export class MemorySecretStore implements SecretStore {
  readonly #values = new Map<string, string>();

  async set(labels: ReturnType<typeof labelsForSecret>, value: string): Promise<void> {
    this.#values.set(`${labels.service}/${labels.account}`, value);
  }

  async get(labels: ReturnType<typeof labelsForSecret>): Promise<string> {
    const value = this.#values.get(`${labels.service}/${labels.account}`);
    if (value === undefined) {
      throw new OpsError("secret_store_error", "Secret is not available");
    }
    return value;
  }

  async has(labels: ReturnType<typeof labelsForSecret>): Promise<boolean> {
    return this.#values.has(`${labels.service}/${labels.account}`);
  }
}
