import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests must not load personal rules, skills, keys, or runtime state.
    setupFiles: ["./tests/setup.ts"],
  },
});
