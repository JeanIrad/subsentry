import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Live LLM eval: RUN_EVALS=1 npm run eval (EVAL_ONLY=<id substring> to run a subset).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.eval.test.ts"],
    environment: "node",
    setupFiles: ["dotenv/config"],
    testTimeout: 30 * 60_000,
  },
});
