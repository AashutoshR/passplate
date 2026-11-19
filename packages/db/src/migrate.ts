import { runMigrations } from "./migrate-lib";

const url = process.argv[2] ?? process.env.DATABASE_URL;
await runMigrations(url);
console.log(`Migrations applied${url ? ` to ${new URL(url).pathname.slice(1)}` : ""}.`);
