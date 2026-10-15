import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { testDatabaseUrl } from "./test-db";

/** Creates the test database if needed and applies all migrations. */
export default async function setup(): Promise<void> {
  const devUrl = process.env.DATABASE_URL;
  if (!devUrl) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
  const testUrl = testDatabaseUrl(devUrl);
  const name = new URL(testUrl).pathname.slice(1);

  const admin = new Client({ connectionString: devUrl });
  await admin.connect();
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${name.replace(/"/g, "")}"`);
  await admin.end();

  const client = new Client({ connectionString: testUrl });
  await client.connect();
  await migrate(drizzle(client), { migrationsFolder: "src/db/migrations" });
  await client.end();
}
