import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Needs the docker Postgres from `docker compose up -d`.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    // Own database (<dev db>_test), created + migrated before the run.
    globalSetup: ["tests/integration/global-setup.ts"],
    setupFiles: ["dotenv/config", "tests/integration/use-test-db.ts"],
    fileParallelism: false,
  },
});
