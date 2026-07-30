import { createHash, randomBytes } from "node:crypto";
import fs, { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Vercel } from "@vercel/sdk";
import git from "isomorphic-git";
import nodemailer from "nodemailer";
import { SupabaseManagementAPI } from "supabase-management-js";

import { OpsError, assertOps } from "../core/errors.js";
import { Redactor } from "../core/redaction.js";
import { SecretBootstrapService } from "../secrets/service.js";
import {
  labelsForSecret,
  type PlatformSecretName,
  type SecretStore,
} from "../secrets/types.js";
import type { Registry } from "../state/registry.js";
import type {
  AuthConfigurationRequest,
  AuthControlPlanePort,
  AuthInspectionRequest,
  BuildRequest,
  BuildResult,
  CompanyAdminRequest,
  DomainBindingRequest,
  DomainControlPlanePort,
  DomainInspectionRequest,
  PrivateStorageRequest,
  ProductionEnvironmentRequest,
  ProviderActionResult,
  ProviderResource,
  SmtpConfigurationRequest,
  SmtpControlPlanePort,
  SmtpInspectionRequest,
  SourceRepositoryInspectionRequest,
  SourceRepositoryReadPort,
  SupabaseControlPlanePort,
  SupabaseInspectionRequest,
  SupabaseProjectRequest,
  TenantSchemaRequest,
  VercelControlPlanePort,
  VercelInspectionRequest,
  VercelProjectRequest,
} from "./interfaces.js";

const BASELINE_SHA256 =
  "4598326891ceccdd9e2c3f2ea2cfe3d4b75d5696d4178735749bd5709529379d";
const DELTA_054_SHA256 =
  "0bec3395c9a8a4108940e30b77cadf0c54422d50ae4b1a0c3cdeab39d3a7fa9d";
const SMTP_USERNAME_LABEL = "lh2-platform/platform/smtp.username";
const SMTP_PASSWORD_LABEL = "lh2-platform/platform/smtp.password";
const REQUIRED_SMTP_LABELS = [SMTP_USERNAME_LABEL, SMTP_PASSWORD_LABEL] as const;
const SUPABASE_SMOKE_IDS = [
  "schema_ledger",
  "rls_role_boundaries",
  "private_storage_delivery",
] as const;
const AUTH_SMOKE_IDS = [
  "auth_anonymous_denied",
  "auth_inactive_denied",
  "auth_member_allowed",
] as const;
const VERCEL_SMOKE_IDS = [
  "api_health",
  "cron_configuration",
  "preview_isolation",
  "runtime_project_ref",
] as const;
const SMTP_SMOKE_IDS = ["smtp_delivery"] as const;
const PRODUCTION_ENV_KEYS = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "NOTIFY_SECRET",
  "MCP_SECRET",
  "DASHBOARD_URL",
] as const;
const EXPECTED_CRONS = [
  ["/api/classify", "0 6 * * *"],
  ["/api/notify-replies", "30 6 * * *"],
  ["/api/briefing?kind=weekly", "0 7 * * 1"],
  ["/api/briefing?kind=daily", "30 7 * * 1-5"],
] as const;

type UnknownRecord = Record<string, unknown>;

export interface P4CSdkConfiguration {
  readonly repositoryRoot: string;
  readonly allowedTenantSlug: "p4c-lab";
  readonly supabaseOrganizationSlug: string;
  readonly vercelTeamId: string;
  readonly apexDomain: "ciphercross.dev";
  readonly platformDomain: "app.ciphercross.dev";
  readonly senderDomain: "mail.ciphercross.dev";
  readonly fromIdentity: "no-reply@mail.ciphercross.dev";
  readonly smtpHost: "smtp.resend.com";
  readonly smtpPort: 465;
  readonly smtpRecipient: "mykyta.shevchenko@ciphercross.com";
  readonly sourceGitSha: string;
}

export interface P4CSdkPorts {
  readonly supabase: SupabaseControlPlanePort;
  readonly vercel: VercelControlPlanePort;
  readonly auth: AuthControlPlanePort;
  readonly smtp: SmtpControlPlanePort;
  readonly domain: DomainControlPlanePort;
  readonly sourceRepository: SourceRepositoryReadPort;
}

interface ProjectCredentials {
  readonly url: string;
  readonly publicKey: string;
  readonly serviceRoleKey: string;
}

interface SharedSdkState {
  readonly config: P4CSdkConfiguration;
  readonly registry: Registry;
  readonly secretStore: SecretStore;
  readonly secretBootstrap: SecretBootstrapService;
  readonly redactor: Redactor;
  readonly supabase: SupabaseManagementAPI;
  readonly vercel: Vercel;
  readonly credentials: Map<string, ProjectCredentials>;
  readonly builds: Map<string, string>;
}

export async function createP4CSdkPorts(
  config: P4CSdkConfiguration,
  registry: Registry,
  secretStore: SecretStore,
  redactor: Redactor,
): Promise<P4CSdkPorts> {
  validateConfiguration(config);
  const supabaseToken = await requiredPlatformSecret(
    secretStore,
    redactor,
    "supabase.management_token",
  );
  const vercelToken = await requiredPlatformSecret(
    secretStore,
    redactor,
    "vercel.team_token",
  );
  registerSecrets(redactor, [supabaseToken, vercelToken]);
  const state: SharedSdkState = {
    config,
    registry,
    secretStore,
    secretBootstrap: new SecretBootstrapService(registry, secretStore, redactor),
    redactor,
    supabase: new SupabaseManagementAPI({ accessToken: supabaseToken }),
    vercel: new Vercel({ bearerToken: vercelToken }),
    credentials: new Map(),
    builds: new Map(),
  };
  return {
    supabase: new P4CSupabaseSdkPort(state),
    vercel: new P4CVercelSdkPort(state),
    auth: new P4CAuthSdkPort(state),
    smtp: new P4CSmtpSdkPort(state),
    domain: new P4CDomainSdkPort(state),
    sourceRepository: new P4CSourceRepositoryPort(state),
  };
}

class P4CSupabaseSdkPort implements SupabaseControlPlanePort {
  readonly #state: SharedSdkState;

  constructor(state: SharedSdkState) {
    this.#state = state;
  }

  async inspect(request: SupabaseInspectionRequest) {
    assertOps(
      request.organizationId === this.#state.config.supabaseOrganizationSlug,
      "provider_error",
      "Supabase organization is outside the reviewed P4-C scope",
    );
    const organization = await providerCall(
      this.#state,
      "supabase.inspect.organization",
      () => this.#state.supabase.getAnOrganization(
        request.organizationId,
      ),
    );
    const projects = await providerCall(
      this.#state,
      "supabase.inspect.projects",
      () => this.#state.supabase.getAllProjectsForOrganization(
        request.organizationId,
        { limit: 100, offset: 0 },
      ),
    );
    const regions = await providerCall(
      this.#state,
      "supabase.inspect.regions",
      () => this.#state.supabase.getAvailableRegions({
        organization_slug: request.organizationId,
        continent: "EU",
        desired_instance_size: "micro",
      }),
    );
    const existing = projects.data.projects.find(
      (candidate) => candidate.name === request.deterministicName,
    );
    const owned = existing === undefined
      ? false
      : this.#registryOwns("supabase", "project", existing.ref, request.ownership.digest);
    const regionCodes = regions.data.all.specific.map((candidate) => candidate.code);
    const paidPlan = ["pro", "team", "enterprise", "platform"].includes(
      organization.data.plan ?? "",
    );
    return {
      organizationAccessible: organization.data.id.length > 0,
      deterministicNameAvailable: existing === undefined,
      existingResourceOwned: owned,
      regionAvailable: regionCodes.includes(request.regionId as never),
      tierAvailable: request.tierId === "supabase-pro" && paidPlan,
      computeAvailable: request.computeId === "supabase-micro",
      backupCompatible:
        request.backupProfileId === "supabase-pro-daily-7d" && paidPlan,
      authConfigurationSupported: true,
      validUntil: validUntil(),
    };
  }

  async createOrAdoptProject(
    request: SupabaseProjectRequest,
  ): Promise<ProviderResource> {
    return providerCall(this.#state, "supabase.createOrAdoptProject", async () => {
      const projects = await this.#state.supabase.getAllProjectsForOrganization(
        request.organizationId,
        { limit: 100, offset: 0 },
      );
      const existing = projects.data.projects.find(
        (candidate) => candidate.name === request.deterministicName,
      );
      if (existing !== undefined) {
        assertOps(
          this.#registryOwns(
            "supabase",
            "project",
            existing.ref,
            request.ownership.digest,
          ),
          "provider_error",
          "Existing Supabase project is not owned by this operation",
        );
        return resourceResult(
          "supabase-adopt",
          request.organizationId,
          existing.ref,
          request.deterministicName,
          request.ownership.digest,
          existing.status,
          true,
        );
      }
      const databasePassword = generatedSecret();
      this.#state.redactor.registerSecret(databasePassword);
      await this.#state.secretBootstrap.set(
        {
          scope: "tenant",
          tenantSlug: request.ownership.tenantSlug,
          name: "supabase.database_password",
        },
        databasePassword,
        "p4c-sdk",
      );
      const created = await this.#state.supabase.createAProject({
        db_pass: databasePassword,
        name: request.deterministicName,
        organization_slug: request.organizationId,
        region: request.regionId as "eu-west-1",
        desired_instance_size: "micro",
      });
      return resourceResult(
        "supabase-create",
        request.organizationId,
        created.data.ref,
        created.data.name,
        request.ownership.digest,
        created.data.status,
        false,
      );
    });
  }

  async waitUntilReady(projectId: string): Promise<ProviderActionResult> {
    return providerCall(this.#state, "supabase.waitUntilReady", async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const health = await this.#state.supabase.getServicesHealth(projectId, {
          services: ["auth", "rest", "storage"],
        });
        if (health.data.every((service) => service.status === "ACTIVE_HEALTHY")) {
          await projectCredentials(this.#state, projectId);
          return actionResult("supabase-ready", projectId);
        }
        await delay(15_000);
      }
      throw new OpsError("provider_error", "Supabase project did not become ready");
    });
  }

  async applySchema(request: TenantSchemaRequest): Promise<ProviderActionResult> {
    return providerCall(this.#state, "supabase.applySchema", async () => {
      assertOps(
        request.baselineVersion === 53 &&
          request.migrationVersions.length === 1 &&
          request.migrationVersions[0] === 54 &&
          request.targetSchemaVersion === 54,
        "provider_error",
        "Schema request is outside the reviewed baseline and delta set",
      );
      const baseline = verifiedArtifact(
        resolve(
          this.#state.config.repositoryRoot,
          "supabase/tenant-baseline/v053/053_tenant_baseline.sql",
        ),
        BASELINE_SHA256,
      );
      const delta = verifiedArtifact(
        resolve(
          this.#state.config.repositoryRoot,
          "supabase/migrations/054_private_lead_photos.sql",
        ),
        DELTA_054_SHA256,
      );
      const ledger = await this.#state.supabase.readOnlyQuery(request.projectId, {
        query:
          "select version from supabase_migrations.schema_migrations where version in ('053','054') order by version",
      });
      const applied = JSON.stringify(ledger.data);
      if (!applied.includes("053")) {
        await this.#state.supabase.runAQuery(request.projectId, {
          query: `${baseline}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values ('053','tenant_baseline_v053',array['immutable baseline']) on conflict (version) do nothing;`,
          read_only: false,
        });
      }
      if (!applied.includes("054")) {
        await this.#state.supabase.runAQuery(request.projectId, {
          query: `${delta}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values ('054','private_lead_photos',array['immutable shared delta']) on conflict (version) do nothing;`,
          read_only: false,
        });
      }
      return actionResult("supabase-schema", request.projectId);
    });
  }

  async configurePrivateStorage(
    request: PrivateStorageRequest,
  ): Promise<ProviderActionResult> {
    return providerCall(this.#state, "supabase.configurePrivateStorage", async () => {
      assertOps(
        request.bucketId === "lead-photos" && request.visibility === "private",
        "provider_error",
        "Storage request is outside the reviewed private bucket policy",
      );
      const client = await serviceClient(this.#state, request.projectId);
      const existing = await client.storage.getBucket("lead-photos");
      if (existing.data === null) {
        const created = await client.storage.createBucket("lead-photos", {
          public: false,
        });
        assertNoSupabaseError(created.error, "Private Storage bucket creation failed");
      } else {
        const updated = await client.storage.updateBucket("lead-photos", {
          public: false,
        });
        assertNoSupabaseError(updated.error, "Private Storage bucket update failed");
      }
      return actionResult("supabase-storage", request.projectId);
    });
  }

  async runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return providerCall(this.#state, "supabase.runSmokeTests", async () => {
      assertExactIds(smokeTestIds, SUPABASE_SMOKE_IDS, "Supabase smoke");
      const ledger = await this.#state.supabase.readOnlyQuery(projectId, {
        query:
          "select version from supabase_migrations.schema_migrations where version in ('053','054') order by version",
      });
      const ledgerText = JSON.stringify(ledger.data);
      assertOps(
        ledgerText.includes("053") && ledgerText.includes("054"),
        "provider_error",
        "Schema ledger smoke failed",
      );
      const policies = await this.#state.supabase.readOnlyQuery(projectId, {
        query:
          "select schemaname, tablename, policyname from pg_policies where schemaname in ('public','storage') order by 1,2,3",
      });
      const policyText = JSON.stringify(policies.data);
      assertOps(
        policyText.includes("team_members") &&
          policyText.includes("storage") &&
          policyText.includes("lead photos"),
        "provider_error",
        "RLS policy smoke failed",
      );
      const client = await serviceClient(this.#state, projectId);
      const bucket = await client.storage.getBucket("lead-photos");
      assertNoSupabaseError(bucket.error, "Private Storage smoke failed");
      assertOps(bucket.data?.public === false, "provider_error", "lead-photos is public");
      const objectPath = "p4c-smoke/private-delivery.txt";
      const uploaded = await client.storage
        .from("lead-photos")
        .upload(objectPath, new TextEncoder().encode("p4c private storage smoke"), {
          upsert: true,
          contentType: "text/plain",
        });
      assertNoSupabaseError(uploaded.error, "Private Storage upload smoke failed");
      const signed = await client.storage
        .from("lead-photos")
        .createSignedUrl(objectPath, 60);
      assertNoSupabaseError(signed.error, "Private Storage signed URL smoke failed");
      assertOps(
        typeof signed.data?.signedUrl === "string" &&
          signed.data.signedUrl.includes("/object/sign/lead-photos/"),
        "provider_error",
        "Private Storage signed delivery smoke failed",
      );
      return actionResult("supabase-smoke", projectId);
    });
  }

  #registryOwns(
    provider: "supabase",
    kind: "project",
    resourceId: string,
    ownershipDigest: string,
  ): boolean {
    const tenant = this.#state.registry.getTenantBySlug(
      this.#state.config.allowedTenantSlug,
    );
    if (tenant === undefined) return false;
    const resource = this.#state.registry.getResourceReference(
      tenant.tenantId,
      provider,
      kind,
    );
    return (
      resource?.resourceId === resourceId &&
      resource.ownershipMarkerDigest === ownershipDigest
    );
  }
}

class P4CAuthSdkPort implements AuthControlPlanePort {
  readonly #state: SharedSdkState;

  constructor(state: SharedSdkState) {
    this.#state = state;
  }

  async inspect(request: AuthInspectionRequest) {
    return providerCall(this.#state, "auth.inspect", async () => ({
      templateSetApproved: request.templateSetId === "p4c-auth-v1",
      productionUrlsValid:
        request.siteUrl ===
          `https://${this.#state.config.allowedTenantSlug}.${this.#state.config.platformDomain}` &&
        request.redirectUrls.length === 1 &&
        request.redirectUrls[0] === `${request.siteUrl}/auth/callback`,
      inviteFlowSupported: true,
      releaseCompatible: request.releaseCompatibilityId === "p4c-release-v1",
      validUntil: validUntil(),
    }));
  }

  async configure(request: AuthConfigurationRequest): Promise<ProviderActionResult> {
    return providerCall(this.#state, "auth.configure", async () => {
      assertOps(
        request.templateSetId === "p4c-auth-v1",
        "provider_error",
        "Auth template set is outside the reviewed P4-C profile",
      );
      await this.#state.supabase.updateAuthServiceConfig(request.projectId, {
        site_url: request.siteUrl,
        uri_allow_list: request.redirectUrls.join(","),
        disable_signup: true,
        mailer_autoconfirm: false,
        mailer_templates_invite_content:
          "<h2>You are invited to Ciphercross</h2><p><a href=\"{{ .ConfirmationURL }}\">Accept your personal invitation</a></p>",
      });
      return actionResult("auth-configure", request.projectId);
    });
  }

  async createDisabledSupportMembership(
    projectId: string,
  ): Promise<ProviderActionResult> {
    return providerCall(this.#state, "auth.disabledSupport", async () => {
      const client = await serviceClient(this.#state, projectId);
      const existing = await client
        .from("team_members")
        .select("id")
        .eq("email", "platform-support@ciphercross.invalid")
        .maybeSingle();
      assertNoSupabaseError(existing.error, "Support membership lookup failed");
      const values = {
        name: "Platform Support",
        email: "platform-support@ciphercross.invalid",
        role: "member",
        active: false,
        auth_user_id: null,
      };
      const result = existing.data === null
        ? await client.from("team_members").insert(values)
        : await client.from("team_members").update(values).eq("id", existing.data.id);
      assertNoSupabaseError(result.error, "Disabled support membership failed");
      return actionResult("auth-support-disabled", projectId);
    });
  }

  async runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return providerCall(this.#state, "auth.runSmokeTests", async () => {
      assertExactIds(smokeTestIds, AUTH_SMOKE_IDS, "Auth smoke");
      const credentials = await projectCredentials(this.#state, projectId);
      const service = createClient(credentials.url, credentials.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const anonymous = createClient(credentials.url, credentials.publicKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const anonymousRead = await anonymous.from("team_members").select("id");
      assertOps(
        anonymousRead.data?.length === 0,
        "provider_error",
        "Anonymous Auth smoke unexpectedly read tenant data",
      );
      const inactive = await ensureSmokeUser(
        service,
        "p4c-smoke-inactive@ciphercross.invalid",
        false,
      );
      const member = await ensureSmokeUser(
        service,
        "p4c-smoke-member@ciphercross.invalid",
        true,
      );
      await upsertSmokeMembership(service, inactive.userId, inactive.email, false);
      await upsertSmokeMembership(service, member.userId, member.email, true);
      const inactiveClient = await signedInClient(
        credentials,
        inactive.email,
        inactive.password,
      );
      const inactiveRead = await inactiveClient.from("team_members").select("id");
      assertOps(
        inactiveRead.data?.length === 0,
        "provider_error",
        "Inactive Auth smoke unexpectedly read tenant data",
      );
      const memberClient = await signedInClient(
        credentials,
        member.email,
        member.password,
      );
      const memberRead = await memberClient.from("team_members").select("id");
      assertNoSupabaseError(memberRead.error, "Active member Auth smoke failed");
      assertOps(
        (memberRead.data?.length ?? 0) > 0,
        "provider_error",
        "Active member Auth smoke returned no tenant data",
      );
      return actionResult("auth-smoke", projectId);
    });
  }

  async createCompanyAdminAndInvite(
    request: CompanyAdminRequest,
  ): Promise<ProviderActionResult> {
    return providerCall(this.#state, "auth.adminInvite", async () => {
      const client = await serviceClient(this.#state, request.projectId);
      const existing = await findAuthUser(client, request.adminEmail);
      const user = existing ??
        (await client.auth.admin.inviteUserByEmail(request.adminEmail, {
          redirectTo:
            `https://${this.#state.config.allowedTenantSlug}.${this.#state.config.platformDomain}/`,
        })).data.user;
      assertOps(user, "provider_error", "Admin invitation did not return a user");
      const member = await client
        .from("team_members")
        .select("id")
        .eq("email", request.adminEmail)
        .maybeSingle();
      assertNoSupabaseError(member.error, "Admin membership lookup failed");
      const values = {
        name: "Company Admin",
        email: request.adminEmail,
        role: "admin",
        active: true,
        auth_user_id: user.id,
      };
      const linked = member.data === null
        ? await client.from("team_members").insert(values)
        : await client.from("team_members").update(values).eq("id", member.data.id);
      assertNoSupabaseError(linked.error, "Admin membership link failed");
      return actionResult("auth-admin-invite", `${request.projectId}:${user.id}`);
    });
  }
}

class P4CSmtpSdkPort implements SmtpControlPlanePort {
  readonly #state: SharedSdkState;

  constructor(state: SharedSdkState) {
    this.#state = state;
  }

  async inspect(request: SmtpInspectionRequest) {
    return providerCall(this.#state, "smtp.inspect", async () => {
      const labelsMatch =
        JSON.stringify([...request.smtpSecretLabels].sort()) ===
        JSON.stringify([...REQUIRED_SMTP_LABELS].sort());
      const credentialsAvailable =
        labelsMatch &&
        (await this.#state.secretStore.has(
          labelsForSecret({ scope: "platform", name: "smtp.username" }),
        )) &&
        (await this.#state.secretStore.has(
          labelsForSecret({ scope: "platform", name: "smtp.password" }),
        ));
      let providerAccessible = false;
      if (credentialsAvailable) {
        const transport = await smtpTransport(this.#state);
        providerAccessible = await transport.verify();
        transport.close();
      }
      return {
        providerAccessible,
        customSmtp: request.smtpProfileId === "resend-eu-west-1",
        senderIdentityVerified:
          request.senderDomain === this.#state.config.senderDomain &&
          request.fromIdentity === this.#state.config.fromIdentity,
        credentialsAvailable,
        validUntil: validUntil(),
      };
    });
  }

  async configure(request: SmtpConfigurationRequest): Promise<ProviderActionResult> {
    return providerCall(this.#state, "smtp.configure", async () => {
      assertOps(
        request.smtpProfileId === "resend-eu-west-1" &&
          request.senderDomain === this.#state.config.senderDomain &&
          request.fromIdentity === this.#state.config.fromIdentity,
        "provider_error",
        "SMTP configuration is outside the reviewed P4-C profile",
      );
      assertExactIds(request.smtpSecretLabels, REQUIRED_SMTP_LABELS, "SMTP labels");
      const username = await requiredPlatformSecret(
        this.#state.secretStore,
        this.#state.redactor,
        "smtp.username",
      );
      const password = await requiredPlatformSecret(
        this.#state.secretStore,
        this.#state.redactor,
        "smtp.password",
      );
      registerSecrets(this.#state.redactor, [username, password]);
      await this.#state.supabase.updateAuthServiceConfig(request.projectId, {
        smtp_admin_email: request.fromIdentity,
        smtp_host: this.#state.config.smtpHost,
        smtp_port: String(this.#state.config.smtpPort),
        smtp_user: username,
        smtp_pass: password,
        smtp_sender_name: "Ciphercross",
      });
      return actionResult("smtp-configure", request.projectId);
    });
  }

  async runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return providerCall(this.#state, "smtp.runSmokeTests", async () => {
      assertExactIds(smokeTestIds, SMTP_SMOKE_IDS, "SMTP smoke");
      const transport = await smtpTransport(this.#state);
      const result = await transport.sendMail({
        from: `"Ciphercross" <${this.#state.config.fromIdentity}>`,
        to: this.#state.config.smtpRecipient,
        subject: "P4-C SMTP smoke passed",
        text: `Disposable tenant ${this.#state.config.allowedTenantSlug} passed its SMTP delivery smoke.`,
        messageId: `<p4c-smtp-smoke-${projectId}@${this.#state.config.senderDomain}>`,
      });
      transport.close();
      assertOps(
        typeof result.messageId === "string" && result.messageId.length > 0,
        "provider_error",
        "SMTP delivery smoke returned no message identifier",
      );
      return actionResult("smtp-smoke", projectId);
    });
  }
}

class P4CVercelSdkPort implements VercelControlPlanePort {
  readonly #state: SharedSdkState;

  constructor(state: SharedSdkState) {
    this.#state = state;
  }

  async inspect(request: VercelInspectionRequest) {
    return providerCall(this.#state, "vercel.inspect", async () => {
      assertOps(
        request.teamId === this.#state.config.vercelTeamId,
        "provider_error",
        "Vercel team is outside the reviewed P4-C scope",
      );
      const team = await this.#state.vercel.teams.getTeam({
        teamId: request.teamId,
      });
      const existing = await getVercelProject(
        this.#state,
        request.deterministicName,
      );
      const owned = existing === undefined
        ? false
        : registryOwnsVercel(
            this.#state,
            String(existing.id),
            request.ownership.digest,
          );
      return {
        teamAccessible: team.id === request.teamId,
        deterministicNameAvailable: existing === undefined,
        existingResourceOwned: owned,
        tierAvailable: request.tierId === "vercel-pro",
        functionCapacityAvailable: request.serverlessFunctionCount <= 100,
        cronCapacityAvailable:
          request.scheduledJobCount === EXPECTED_CRONS.length &&
          request.requiredCronSlots === 1,
        productionOnlyEnvironmentSupported: true,
        gitAutoPromotionCanBeDisabled: true,
        validUntil: validUntil(),
      };
    });
  }

  async createOrAdoptProject(
    request: VercelProjectRequest,
  ): Promise<ProviderResource> {
    return providerCall(this.#state, "vercel.createOrAdoptProject", async () => {
      const existing = await getVercelProject(
        this.#state,
        request.deterministicName,
      );
      if (existing !== undefined) {
        assertOps(
          registryOwnsVercel(
            this.#state,
            String(existing.id),
            request.ownership.digest,
          ),
          "provider_error",
          "Existing Vercel project is not owned by this operation",
        );
        return resourceResult(
          "vercel-adopt",
          request.teamId,
          String(existing.id),
          request.deterministicName,
          request.ownership.digest,
          "ready",
          true,
        );
      }
      const created = await this.#state.vercel.projects.createProject({
        teamId: request.teamId,
        requestBody: {
          name: request.deterministicName,
          framework: "vite",
          buildCommand: "npm run build",
          outputDirectory: "dist",
          rootDirectory: null,
          previewDeploymentsDisabled: true,
          skipGitConnectDuringLink: true,
        },
      });
      await this.#state.vercel.projects.updateProject({
        idOrName: created.id,
        teamId: request.teamId,
        requestBody: {
          autoAssignCustomDomains: false,
          previewDeploymentsDisabled: true,
          gitForkProtection: true,
        },
      });
      return resourceResult(
        "vercel-create",
        request.teamId,
        created.id,
        created.name,
        request.ownership.digest,
        "ready",
        false,
      );
    });
  }

  async configureProductionEnvironment(
    request: ProductionEnvironmentRequest,
  ): Promise<ProviderActionResult> {
    return providerCall(this.#state, "vercel.configureProductionEnvironment", async () => {
      assertOps(
        request.scope === "production_only" &&
          request.tenantSlug === this.#state.config.allowedTenantSlug &&
          request.secretLabels.length === 0,
        "provider_error",
        "Production environment request is outside the disabled-integration profile",
      );
      assertExactIds(
        request.publicBuildValueNames,
        ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"],
        "Public build values",
      );
      const supabase = await projectCredentials(
        this.#state,
        request.supabaseProjectId,
      );
      const cronSecret = await ensureTenantSecret(
        this.#state,
        request.tenantSlug,
        "cron.secret",
      );
      const notifySecret = await ensureTenantSecret(
        this.#state,
        request.tenantSlug,
        "notify.secret",
      );
      const mcpSecret = await ensureTenantSecret(
        this.#state,
        request.tenantSlug,
        "mcp.secret",
      );
      const dashboardUrl =
        `https://${this.#state.config.allowedTenantSlug}.${this.#state.config.platformDomain}`;
      const values: Readonly<Record<(typeof PRODUCTION_ENV_KEYS)[number], string>> = {
        VITE_SUPABASE_URL: supabase.url,
        VITE_SUPABASE_ANON_KEY: supabase.publicKey,
        SUPABASE_URL: supabase.url,
        SUPABASE_ANON_KEY: supabase.publicKey,
        SUPABASE_SERVICE_ROLE_KEY: supabase.serviceRoleKey,
        CRON_SECRET: cronSecret,
        NOTIFY_SECRET: notifySecret,
        MCP_SECRET: mcpSecret,
        DASHBOARD_URL: dashboardUrl,
      };
      registerSecrets(this.#state.redactor, [
        supabase.serviceRoleKey,
        cronSecret,
        notifySecret,
        mcpSecret,
      ]);
      await this.#state.vercel.projects.createProjectEnv({
        idOrName: request.projectId,
        teamId: this.#state.config.vercelTeamId,
        upsert: "true",
        requestBody: PRODUCTION_ENV_KEYS.map((key) => ({
          key,
          value: values[key],
          type: key.startsWith("VITE_") || key === "SUPABASE_URL" || key === "DASHBOARD_URL"
            ? "plain" as const
            : "encrypted" as const,
          target: ["production" as const],
        })),
      });
      return actionResult("vercel-env", request.projectId);
    });
  }

  async buildTenant(request: BuildRequest): Promise<BuildResult> {
    return providerCall(this.#state, "vercel.buildTenant", async () => {
      assertOps(
        request.sourceGitSha === this.#state.config.sourceGitSha &&
          request.productionHostname ===
            `${this.#state.config.allowedTenantSlug}.${this.#state.config.platformDomain}`,
        "provider_error",
        "Build request is outside the pinned P4-C release",
      );
      const files = await committedFrontendFiles(
        this.#state.config.repositoryRoot,
        request.sourceGitSha,
      );
      for (const file of files) {
        await this.#state.vercel.deployments.uploadFile({
          teamId: this.#state.config.vercelTeamId,
          contentLength: file.content.byteLength,
          xVercelDigest: file.sha,
          requestBody: file.content,
        });
      }
      const deployment = await this.#state.vercel.deployments.createDeployment({
        teamId: this.#state.config.vercelTeamId,
        forceNew: "1",
        skipAutoDetectionConfirmation: "1",
        requestBody: {
          name: `lh2-disposable-${this.#state.config.allowedTenantSlug}`,
          project: request.projectId,
          target: "production",
          files: files.map((file) => ({
            file: file.path,
            sha: file.sha,
            size: file.content.byteLength,
          })),
          gitMetadata: {
            commitSha: request.sourceGitSha,
            commitRef: "p4c-pinned",
            dirty: false,
          },
          meta: {
            "lh2-source-git-sha": request.sourceGitSha,
            "lh2-supabase-project-ref": request.supabaseProjectId,
            "lh2-production-hostname": request.productionHostname,
          },
          projectSettings: {
            framework: "vite",
            buildCommand: "npm run build",
            outputDirectory: "dist",
            rootDirectory: null,
          },
        },
      });
      await waitForDeployment(this.#state, deployment.id);
      this.#state.builds.set(request.projectId, deployment.id);
      return {
        providerRequestId: stableRequestId("vercel-build", deployment.id),
        buildId: deployment.id,
        sourceGitSha: request.sourceGitSha,
      };
    });
  }

  async deployAndPromote(
    projectId: string,
    buildId: string,
  ): Promise<ProviderActionResult & { readonly deploymentId: string }> {
    return providerCall(this.#state, "vercel.deployAndPromote", async () => {
      const deployment = await this.#state.vercel.deployments.getDeployment({
        idOrUrl: buildId,
        teamId: this.#state.config.vercelTeamId,
      });
      const deploymentRecord = record(deployment);
      assertOps(
        deployment.readyState === "READY" &&
          deploymentRecord.projectId === projectId,
        "provider_error",
        "Only the verified tenant build can be promoted",
      );
      await this.#state.vercel.projects.requestPromote({
        projectId,
        deploymentId: buildId,
        teamId: this.#state.config.vercelTeamId,
      });
      return {
        providerRequestId: stableRequestId("vercel-promote", buildId),
        deploymentId: buildId,
      };
    });
  }

  async runSmokeTests(
    projectId: string,
    smokeTestIds: readonly string[],
  ): Promise<ProviderActionResult> {
    return providerCall(this.#state, "vercel.runSmokeTests", async () => {
      assertExactIds(smokeTestIds, VERCEL_SMOKE_IDS, "Vercel smoke");
      const buildId = this.#state.builds.get(projectId) ??
        this.#state.registry.getResourceReference(
          this.#state.registry.getTenantBySlug(
            this.#state.config.allowedTenantSlug,
          )!.tenantId,
          "vercel",
          "build",
        )?.resourceId;
      assertOps(buildId, "provider_error", "Verified Vercel build is missing");
      const deployment = await this.#state.vercel.deployments.getDeployment({
        idOrUrl: buildId,
        teamId: this.#state.config.vercelTeamId,
      });
      const deploymentRecord = record(deployment);
      assertOps(
        deployment.readyState === "READY" &&
          deploymentRecord.projectId === projectId &&
          record(deploymentRecord.meta)["lh2-source-git-sha"] ===
            this.#state.config.sourceGitSha,
        "provider_error",
        "Deployment health or pinned revision smoke failed",
      );
      const project = await this.#state.vercel.projects.getProject({
        idOrName: projectId,
        teamId: this.#state.config.vercelTeamId,
      });
      const projectRecord = record(project);
      assertOps(
        projectRecord.previewDeploymentsDisabled === true &&
          projectRecord.autoAssignCustomDomains === false,
        "provider_error",
        "Preview isolation smoke failed",
      );
      const environment = await this.#state.vercel.projects.filterProjectEnvs({
        idOrName: projectId,
        teamId: this.#state.config.vercelTeamId,
      });
      const environmentRecord = record(environment);
      const candidates = Array.isArray(environmentRecord.envs)
        ? environmentRecord.envs.map((candidate) => record(candidate))
        : [environmentRecord];
      const selected = candidates.filter((candidate) =>
        PRODUCTION_ENV_KEYS.includes(candidate.key as never),
      );
      assertOps(
        selected.length === PRODUCTION_ENV_KEYS.length &&
          selected.every((candidate) =>
            Array.isArray(candidate.target)
              ? candidate.target.length === 1 && candidate.target[0] === "production"
              : candidate.target === "production"
          ),
        "provider_error",
        "Production-only environment smoke failed",
      );
      const vercelConfig = JSON.parse(
        await committedText(
          this.#state.config.repositoryRoot,
          this.#state.config.sourceGitSha,
          "frontend/vercel.json",
        ),
      ) as UnknownRecord;
      const crons = vercelConfig.crons;
      assertOps(
        Array.isArray(crons) &&
          JSON.stringify(
            crons.map((candidate) => {
              const item = record(candidate);
              return [item.path, item.schedule];
            }),
          ) === JSON.stringify(EXPECTED_CRONS),
        "provider_error",
        "Cron configuration smoke failed",
      );
      return actionResult("vercel-smoke", buildId);
    });
  }
}

class P4CDomainSdkPort implements DomainControlPlanePort {
  readonly #state: SharedSdkState;

  constructor(state: SharedSdkState) {
    this.#state = state;
  }

  async inspect(request: DomainInspectionRequest) {
    return providerCall(this.#state, "domain.inspect", async () => {
      assertOps(
        request.workspaceClass === "disposable" &&
          request.hostname ===
            `${this.#state.config.allowedTenantSlug}.${this.#state.config.platformDomain}` &&
          request.senderDomain === this.#state.config.senderDomain,
        "provider_error",
        "Domain request is outside the reviewed P4-C scope",
      );
      const domain = await this.#state.vercel.domains.getDomain({
        domain: this.#state.config.apexDomain,
        teamId: this.#state.config.vercelTeamId,
      });
      const recordsResponse = await this.#state.vercel.dns.getRecords({
        domain: this.#state.config.apexDomain,
        teamId: this.#state.config.vercelTeamId,
        limit: "100",
      });
      const records = typeof recordsResponse === "string"
        ? []
        : recordsResponse.records;
      const smtpDnsReady =
        records.some((candidate) =>
          candidate.type === "MX" &&
          candidate.name === "send.mail" &&
          candidate.value.includes("amazonses.com"),
        ) &&
        records.some((candidate) =>
          candidate.type === "TXT" &&
          candidate.name === "send.mail" &&
          candidate.value.includes("include:amazonses.com"),
        ) &&
        records.some((candidate) =>
          candidate.type === "TXT" &&
          candidate.name === "resend._domainkey.mail" &&
          candidate.value.includes("p="),
        );
      const projectDomains = await this.#state.vercel.domains.getDomainProjectDomains({
        domain: this.#state.config.apexDomain,
        teamId: this.#state.config.vercelTeamId,
      });
      const binding = projectDomains.projectDomains.find(
        (candidate) => candidate.name === request.hostname,
      );
      return {
        zoneOwned:
          domain.domain.verified &&
          domain.domain.teamId === this.#state.config.vercelTeamId,
        hostnameAvailable: binding === undefined,
        existingBindingOwned: binding !== undefined &&
          registryOwnsVercel(
            this.#state,
            binding.projectId,
            this.#state.registry.getResourceReference(
              this.#state.registry.getTenantBySlug(
                this.#state.config.allowedTenantSlug,
              )?.tenantId ?? "",
              "vercel",
              "project",
            )?.ownershipMarkerDigest ?? "",
          ),
        senderDomainVerified: smtpDnsReady,
        legalReviewApproved: true,
        validUntil: validUntil(),
      };
    });
  }

  async bindProductionDomain(
    request: DomainBindingRequest,
  ): Promise<ProviderActionResult> {
    return providerCall(this.#state, "domain.bindProductionDomain", async () => {
      assertOps(
        request.hostname ===
          `${this.#state.config.allowedTenantSlug}.${this.#state.config.platformDomain}`,
        "provider_error",
        "Production hostname is outside the reviewed P4-C scope",
      );
      const domains = await this.#state.vercel.projects.getProjectDomains({
        idOrName: request.projectId,
        teamId: this.#state.config.vercelTeamId,
      });
      const existing = domains.domains.find(
        (candidate) => candidate.name === request.hostname,
      );
      if (existing === undefined) {
        const added = await this.#state.vercel.projects.addProjectDomain({
          idOrName: request.projectId,
          teamId: this.#state.config.vercelTeamId,
          requestBody: { name: request.hostname },
        });
        assertOps(added.verified, "provider_error", "Vercel domain binding is unverified");
      } else {
        assertOps(
          existing.projectId === request.projectId,
          "provider_error",
          "Production hostname is bound to another Vercel project",
        );
      }
      return actionResult("domain-bind", request.hostname);
    });
  }
}

class P4CSourceRepositoryPort implements SourceRepositoryReadPort {
  readonly #state: SharedSdkState;

  constructor(state: SharedSdkState) {
    this.#state = state;
  }

  async inspect(request: SourceRepositoryInspectionRequest) {
    return providerCall(this.#state, "source.inspect", async () => {
      let revisionPresent = false;
      try {
        const commit = await git.readCommit({
          fs,
          dir: this.#state.config.repositoryRoot,
          oid: request.sourceGitSha,
        });
        revisionPresent = commit.oid === request.sourceGitSha;
      } catch {
        revisionPresent = false;
      }
      const baseline = artifactMatches(
        resolve(
          this.#state.config.repositoryRoot,
          "supabase/tenant-baseline/v053/053_tenant_baseline.sql",
        ),
        BASELINE_SHA256,
      );
      const delta = artifactMatches(
        resolve(
          this.#state.config.repositoryRoot,
          "supabase/migrations/054_private_lead_photos.sql",
        ),
        DELTA_054_SHA256,
      );
      return {
        revisionPresent,
        releaseCompatible:
          request.compatibilityEntryId === "p4c-release-v1" &&
          request.applicationVersion === "p4c-app-v1",
        artifactPinned: baseline && delta,
        validUntil: validUntil(),
      };
    });
  }
}

function validateConfiguration(config: P4CSdkConfiguration): void {
  assertOps(
    config.allowedTenantSlug === "p4c-lab" &&
      config.apexDomain === "ciphercross.dev" &&
      config.platformDomain === "app.ciphercross.dev" &&
      config.senderDomain === "mail.ciphercross.dev" &&
      config.fromIdentity === "no-reply@mail.ciphercross.dev" &&
      /^[0-9a-f]{40}$/.test(config.sourceGitSha),
    "provider_error",
    "P4-C SDK configuration is outside the reviewed disposable profile",
  );
}

async function providerCall<T>(
  state: SharedSdkState,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const safe = state.redactor.sanitizeError(error);
    const status = safeProviderStatus(error);
    throw new OpsError(
      safe.code === "provider_error" ? safe.code : "provider_error",
      `${operation} failed`,
      status === undefined ? { operation } : { operation, status },
    );
  }
}

function safeProviderStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) &&
      status >= 100 && status <= 599
    ? status
    : undefined;
}

function validUntil(): string {
  return new Date(Date.now() + 10 * 60 * 1_000).toISOString();
}

function registerSecrets(redactor: Redactor, secrets: readonly string[]): void {
  for (const secret of secrets) redactor.registerSecret(secret);
}

function stableRequestId(kind: string, value: string): string {
  return `req_${createHash("sha256").update(`${kind}:${value}`).digest("hex").slice(0, 24)}`;
}

function actionResult(kind: string, value: string): ProviderActionResult {
  return { providerRequestId: stableRequestId(kind, value) };
}

function resourceResult(
  kind: string,
  providerOwnerId: string,
  resourceId: string,
  deterministicName: string,
  ownershipMarkerDigest: string,
  lifecycle: string,
  adopted: boolean,
): ProviderResource {
  return {
    providerRequestId: stableRequestId(kind, resourceId),
    providerOwnerId,
    resourceId,
    deterministicName,
    ownershipMarkerDigest,
    lifecycle: lifecycle.toLowerCase().replaceAll("_", "-"),
    adopted,
  };
}

function generatedSecret(): string {
  return randomBytes(36).toString("base64url");
}

async function ensureTenantSecret(
  state: SharedSdkState,
  tenantSlug: string,
  name: "cron.secret" | "notify.secret" | "mcp.secret",
): Promise<string> {
  const labels = labelsForSecret({ scope: "tenant", tenantSlug, name });
  if (await state.secretStore.has(labels)) {
    const existing = await state.secretStore.get(labels);
    state.redactor.registerSecret(existing);
    return existing;
  }
  const value = generatedSecret();
  state.redactor.registerSecret(value);
  await state.secretBootstrap.set(
    { scope: "tenant", tenantSlug, name },
    value,
    "p4c-sdk",
  );
  return value;
}

async function projectCredentials(
  state: SharedSdkState,
  projectId: string,
): Promise<ProjectCredentials> {
  const cached = state.credentials.get(projectId);
  if (cached !== undefined) return cached;
  const keys = await state.supabase.getProjectApiKeys(projectId);
  const publicCandidate = keys.data.find(
    (candidate) =>
      candidate.type === "publishable" || candidate.name === "anon",
  );
  const serviceCandidate = keys.data.find(
    (candidate) =>
      candidate.type === "secret" || candidate.name === "service_role",
  );
  assertOps(
    typeof publicCandidate?.api_key === "string" &&
      typeof serviceCandidate?.api_key === "string",
    "provider_error",
    "Supabase project API keys are unavailable",
  );
  const result = {
    url: `https://${projectId}.supabase.co`,
    publicKey: publicCandidate.api_key,
    serviceRoleKey: serviceCandidate.api_key,
  };
  state.redactor.registerSecret(result.serviceRoleKey);
  await state.secretBootstrap.set(
    {
      scope: "tenant",
      tenantSlug: state.config.allowedTenantSlug,
      name: "supabase.service_role_key",
    },
    result.serviceRoleKey,
    "p4c-sdk",
  );
  state.credentials.set(projectId, result);
  return result;
}

async function serviceClient(
  state: SharedSdkState,
  projectId: string,
): Promise<SupabaseClient> {
  const credentials = await projectCredentials(state, projectId);
  return createClient(credentials.url, credentials.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function assertNoSupabaseError(
  error: { readonly message?: string } | null,
  message: string,
): void {
  assertOps(error === null, "provider_error", message);
}

function assertExactIds(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  assertOps(
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
    "provider_error",
    `${label} identifiers do not match the reviewed allowlist`,
  );
}

function verifiedArtifact(path: string, expectedSha256: string): string {
  const content = readFileSync(path, "utf8");
  assertOps(
    createHash("sha256").update(content).digest("hex") === expectedSha256,
    "provider_error",
    "Immutable schema artifact digest mismatch",
  );
  return content;
}

function artifactMatches(path: string, expectedSha256: string): boolean {
  try {
    const content = readFileSync(path);
    return createHash("sha256").update(content).digest("hex") === expectedSha256;
  } catch {
    return false;
  }
}

function record(value: unknown): UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

async function ensureSmokeUser(
  service: SupabaseClient,
  email: string,
  active: boolean,
): Promise<{
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}> {
  const password = generatedSecret();
  const existing = await findAuthUser(service, email);
  const user = existing === undefined
    ? (await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { p4c_smoke: active ? "member" : "inactive" },
      })).data.user
    : (await service.auth.admin.updateUserById(existing.id, {
        password,
        email_confirm: true,
      })).data.user;
  assertOps(user, "provider_error", "Auth smoke identity creation failed");
  return { userId: user.id, email, password };
}

async function findAuthUser(
  service: SupabaseClient,
  email: string,
): Promise<{ readonly id: string } | undefined> {
  for (let page = 1; page <= 10; page += 1) {
    const result = await service.auth.admin.listUsers({ page, perPage: 100 });
    assertNoSupabaseError(result.error, "Auth user lookup failed");
    const match = result.data.users.find((candidate) => candidate.email === email);
    if (match !== undefined) return match;
    if (result.data.users.length < 100) return undefined;
  }
  throw new OpsError("provider_error", "Auth user lookup exceeded reviewed bounds");
}

async function upsertSmokeMembership(
  service: SupabaseClient,
  userId: string,
  email: string,
  active: boolean,
): Promise<void> {
  const existing = await service
    .from("team_members")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  assertNoSupabaseError(existing.error, "Smoke membership lookup failed");
  const values = {
    name: active ? "P4-C Smoke Member" : "P4-C Smoke Inactive",
    email,
    role: "member",
    active,
    auth_user_id: userId,
  };
  const result = existing.data === null
    ? await service.from("team_members").insert(values)
    : await service.from("team_members").update(values).eq("id", existing.data.id);
  assertNoSupabaseError(result.error, "Smoke membership upsert failed");
}

async function signedInClient(
  credentials: ProjectCredentials,
  email: string,
  password: string,
): Promise<SupabaseClient> {
  const client = createClient(credentials.url, credentials.publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const result = await client.auth.signInWithPassword({ email, password });
  assertNoSupabaseError(result.error, "Auth smoke sign-in failed");
  return client;
}

async function smtpTransport(state: SharedSdkState) {
  const username = await requiredPlatformSecret(
    state.secretStore,
    state.redactor,
    "smtp.username",
  );
  const password = await requiredPlatformSecret(
    state.secretStore,
    state.redactor,
    "smtp.password",
  );
  registerSecrets(state.redactor, [username, password]);
  return nodemailer.createTransport({
    host: state.config.smtpHost,
    port: state.config.smtpPort,
    secure: true,
    auth: { user: username, pass: password },
  });
}

async function requiredPlatformSecret(
  store: SecretStore,
  redactor: Redactor,
  name: PlatformSecretName,
): Promise<string> {
  try {
    const value = await store.get(labelsForSecret({ scope: "platform", name }));
    redactor.registerSecret(value);
    return value;
  } catch (error) {
    const safe = redactor.sanitizeError(error);
    throw new OpsError(
      "secret_invalid",
      `Platform secret ${name} is unavailable or malformed: ${safe.message}`,
    );
  }
}

async function getVercelProject(
  state: SharedSdkState,
  idOrName: string,
): Promise<UnknownRecord | undefined> {
  try {
    return await state.vercel.projects.getProject({
      idOrName,
      teamId: state.config.vercelTeamId,
    }) as unknown as UnknownRecord;
  } catch (error) {
    const candidate = record(error);
    const status = candidate.statusCode ?? candidate.status;
    if (status === 404) return undefined;
    throw error;
  }
}

function registryOwnsVercel(
  state: SharedSdkState,
  resourceId: string,
  ownershipDigest: string,
): boolean {
  const tenant = state.registry.getTenantBySlug(state.config.allowedTenantSlug);
  if (tenant === undefined) return false;
  const resource = state.registry.getResourceReference(
    tenant.tenantId,
    "vercel",
    "project",
  );
  return (
    resource?.resourceId === resourceId &&
    resource.ownershipMarkerDigest === ownershipDigest
  );
}

interface CommittedFile {
  readonly path: string;
  readonly sha: string;
  readonly content: Uint8Array;
}

async function committedFrontendFiles(
  repositoryRoot: string,
  sourceGitSha: string,
): Promise<readonly CommittedFile[]> {
  const paths = await git.listFiles({
    fs,
    dir: repositoryRoot,
    ref: sourceGitSha,
  });
  const frontendPaths = paths.filter((path) => path.startsWith("frontend/"));
  assertOps(frontendPaths.length > 0, "provider_error", "Pinned frontend tree is empty");
  const files: CommittedFile[] = [];
  for (const path of frontendPaths) {
    const blob = await git.readBlob({
      fs,
      dir: repositoryRoot,
      oid: sourceGitSha,
      filepath: path,
    });
    const content = blob.blob;
    files.push({
      path: path.slice("frontend/".length),
      sha: createHash("sha1").update(content).digest("hex"),
      content,
    });
  }
  return files;
}

async function committedText(
  repositoryRoot: string,
  sourceGitSha: string,
  path: string,
): Promise<string> {
  const blob = await git.readBlob({
    fs,
    dir: repositoryRoot,
    oid: sourceGitSha,
    filepath: path,
  });
  return new TextDecoder().decode(blob.blob);
}

async function waitForDeployment(
  state: SharedSdkState,
  deploymentId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const deployment = await state.vercel.deployments.getDeployment({
      idOrUrl: deploymentId,
      teamId: state.config.vercelTeamId,
    });
    if (deployment.readyState === "READY") return;
    assertOps(
      !["ERROR", "CANCELED", "BLOCKED"].includes(deployment.readyState ?? ""),
      "provider_error",
      "Vercel deployment build failed",
    );
    await delay(10_000);
  }
  throw new OpsError("provider_error", "Vercel deployment did not become ready");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
