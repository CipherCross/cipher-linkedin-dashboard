import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          BRIDGE_BEARER_SECRET: "worker-test-bridge-credential",
          NEON_API_TOKEN: "worker-test-neon-credential",
          NEON_REGION_ID: "worker-test-only",
          NEON_TIER_ID: "worker-test-only",
          NEON_COMPUTE_ID: "worker-test-only",
          NEON_BACKUP_PROFILE_ID: "worker-test-only",
          VERCEL_API_TOKEN: "worker-test-vercel-credential",
          RESEND_API_KEY: "worker-test-resend-credential",
          RESEND_SMOKE_RECIPIENT: "worker-test@example.invalid",
          BETTER_AUTH_TEMPLATE_SET_ID: "worker-test-only",
          RELEASE_COMPATIBILITY_ID: "worker-test-only",
          APPROVED_APPLICATION_VERSION: "worker-test-only",
          APPROVED_SCHEDULE_MANIFEST_DIGEST: `sha256:${"0".repeat(64)}`,
          SOURCE_REPOSITORY_TOKEN: "worker-test-source-credential",
        },
      },
    }),
  ],
  test: {
    include: ["worker-test/**/*.test.ts"],
  },
});
