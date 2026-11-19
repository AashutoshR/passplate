import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(url?: string): Promise<void> {
  const { db, sql } = createDb({ url, max: 1, appName: "pass-migrate" });
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end();
  }
}
