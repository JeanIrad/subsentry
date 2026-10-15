import { testDatabaseUrl } from "./test-db";

// setupFile: runs in each test worker before any module reads env.
if (process.env.DATABASE_URL) process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL);
