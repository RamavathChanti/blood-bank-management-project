import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "server-only": fileURLToPath(new URL("./tests/integration/server-only.ts", import.meta.url)) } },
  test: { setupFiles: ["./tests/integration/audit-setup.ts"], environment: "node", include: ["tests/integration/**/*.test.ts"], clearMocks: true, testTimeout: 30_000, hookTimeout: 180_000, fileParallelism: false }
});
