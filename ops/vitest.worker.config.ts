import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          BRIDGE_BEARER_SECRET: "worker-test-only",
          NEON_API_TOKEN: "worker-test-only",
          NEON_REGION_ID: "worker-test-only",
          NEON_TIER_ID: "worker-test-only",
          NEON_COMPUTE_ID: "worker-test-only",
          NEON_BACKUP_PROFILE_ID: "worker-test-only",
          VERCEL_API_TOKEN: "worker-test-only",
          RESEND_API_KEY: "worker-test-only",
          RESEND_SMOKE_RECIPIENT: "worker-test@example.invalid",
          BETTER_AUTH_SESSION_SECRET: "worker-test-only",
          BETTER_AUTH_TEMPLATE_SET_ID: "worker-test-only",
          RELEASE_COMPATIBILITY_ID: "worker-test-only",
          APPROVED_APPLICATION_VERSION: "worker-test-only",
          APPROVED_SCHEDULE_MANIFEST_DIGEST: `sha256:${"0".repeat(64)}`,
          TENANT_DATABASE_URL: "postgresql://worker-test.invalid/example",
          TENANT_DATA_API_PUBLIC_KEY: "worker-test-only",
          TENANT_DATA_API_ADMIN_KEY: "worker-test-only",
          TENANT_SCHEDULE_INVOKE_SECRET: "worker-test-only",
          TENANT_INGEST_INVOKE_SECRET: "worker-test-only",
          TENANT_TOOL_BRIDGE_SECRET: "worker-test-only",
          SOURCE_REPOSITORY_TOKEN: "worker-test-only",
        },
      },
    }),
  ],
  test: {
    include: ["worker-test/**/*.test.ts"],
  },
});
