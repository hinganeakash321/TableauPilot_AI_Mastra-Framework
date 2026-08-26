import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tableau file IO + workflow runs share the workspace; run serially to avoid
    // clobbering the working/output directories.
    fileParallelism: false,
    globals: false,
  },
});
