import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    coverage: {
      include: ["packages/game-core/src/**", "apps/server/src/**"]
    }
  }
});
