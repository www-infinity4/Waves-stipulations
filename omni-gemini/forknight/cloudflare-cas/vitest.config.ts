import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        serviceBindings: {
          TEST_EXECUTOR: async () => Response.json({ outcome: "verified", details: { source: "test-executor" } }),
        },
      },
    }),
  ],
});
