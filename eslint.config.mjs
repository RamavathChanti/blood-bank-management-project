import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", ".tools/**", "out/**", "coverage/**", "playwright-report/**", "test-results/**", ".npm-cache/**", "next-env.d.ts"]),
  {
    files: ["src/core/**/*.ts", "src/workers/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: ["next", "next/*", "react", "react/*", "@/server/*", "node:*", "mongodb", "@clerk/*", "inngest"]
      }]
    }
  }
]);
