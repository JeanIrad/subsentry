import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Needs the docker Postgres from `docker compose up -d` and a migrated schema.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["dotenv/config"],
    fileParallelism: false,
  },
});
