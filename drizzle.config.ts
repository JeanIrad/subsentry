import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Migrations need a direct connection, not a pooler (Neon: DATABASE_URL_UNPOOLED).
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: { url },
  strict: true,
});
