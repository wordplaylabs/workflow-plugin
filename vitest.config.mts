import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    setupFiles: ["test/setup.ts"],
    // The hooks' tests start node processes; beside another executor's run, or another
    // project's, a test past vitest's 5 s is the machine's load, not the test.
    testTimeout: 30_000,
  },
});
