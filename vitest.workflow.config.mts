import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "server-only": fileURLToPath(new URL("./tests/integration/server-only.ts", import.meta.url)) } },
  test: { setupFiles: ["./tests/integration/audit-setup.ts"], environment: "node", env: { VERCEL: "", INNGEST_DEV: "1", INNGEST_BASE_URL: "http://127.0.0.1:8288", INNGEST_EVENT_KEY: "", INNGEST_SIGNING_KEY: "" }, include: ["tests/workflow-live/**/*.test.ts"], fileParallelism: false, testTimeout: 90_000, hookTimeout: 90_000 }
});
