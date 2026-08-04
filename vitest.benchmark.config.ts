import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 30_000,
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
