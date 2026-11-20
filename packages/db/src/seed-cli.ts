import { createDb } from "./client";
import { seedSampleActivity } from "./sample";
import { DEMO_ACCOUNTS, seedDemo } from "./seed";

const { db, sql } = createDb({ max: 1, appName: "pass-seed" });
try {
  const result = await seedDemo(db);
  if (!process.argv.includes("--empty")) await seedSampleActivity(db, result);
  console.log(`Seeded "${result.locationSlug}" with ${result.tables.length} tables.`);
  console.log("Development accounts (test values only):");
  for (const [key, a] of Object.entries(DEMO_ACCOUNTS)) console.log(`  ${key.padEnd(8)} ${a.email}  ${a.password}`);
} finally {
  await sql.end();
}
