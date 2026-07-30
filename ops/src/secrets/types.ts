import { OpsError } from "../core/errors.js";

export const PLATFORM_SECRET_NAMES = [
  "registry.backup_passphrase",
  "smtp.password",
  "smtp.username",
  "supabase.management_token",
  "vercel.team_token",
] as const;

export const TENANT_SECRET_NAMES = [
  "airtable.imports",
  "anthropic.api_key",
  "cron.secret",
  "mcp.secret",
  "notify.secret",
  "slack.briefings",
  "slack.reply_alerts",
  "smtp.password",
  "smtp.username",
  "supabase.database_password",
  "supabase.service_role_key",
] as const;

export type SecretScope = "platform" | "tenant";
export type PlatformSecretName = (typeof PLATFORM_SECRET_NAMES)[number];
export type TenantSecretName = (typeof TENANT_SECRET_NAMES)[number];
export type SecretName = PlatformSecretName | TenantSecretName;

export interface SecretLocator {
  readonly scope: SecretScope;
  readonly name: SecretName;
  readonly tenantSlug?: string | undefined;
}

export interface KeychainLabels {
  readonly service: "lh2-platform";
  readonly account: string;
}

export interface SecretStore {
  set(labels: KeychainLabels, value: string): Promise<void>;
  get(labels: KeychainLabels): Promise<string>;
  has(labels: KeychainLabels): Promise<boolean>;
}

export function isSecretName(scope: SecretScope, name: string): name is SecretName {
  return (
    scope === "platform"
      ? (PLATFORM_SECRET_NAMES as readonly string[])
      : (TENANT_SECRET_NAMES as readonly string[])
  ).includes(name);
}

export function labelsForSecret(locator: SecretLocator): KeychainLabels {
  if (locator.scope === "platform") {
    return {
      service: "lh2-platform",
      account: `platform/${locator.name}`,
    };
  }
  if (locator.tenantSlug === undefined) {
    throw new OpsError(
      "secret_invalid",
      "Tenant slug is required for a tenant secret",
    );
  }
  return {
    service: "lh2-platform",
    account: `tenant/${locator.tenantSlug}/${locator.name}`,
  };
}
