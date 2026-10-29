import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/cache/**/*.test.ts"], testTimeout: 100_000, hookTimeout: 180_000, fileParallelism: false } });
