import { defineConfig } from "vitest/config";

// Needs Docker (Linux containers) and openssl; run with `npm run test:contract`. Not part of CI's
// default `npm test`: GitHub's windows-latest runners cannot run Linux containers.
export default defineConfig({
  test: {
    include: ["packages/*/contract/**/*.contract.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
