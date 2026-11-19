import { createDb } from "@pass/db";
import { createApp } from "./app";

const port = Number(process.env.API_PORT ?? 4000);
const { db, sql } = createDb({ appName: "pass-api", max: Number(process.env.DB_POOL_MAX ?? 10) });
const app = createApp({
  db,
  dev: process.env.NODE_ENV !== "production",
  webPort: Number(process.env.WEB_PORT ?? 3000),
});

const server = Bun.serve({ port, fetch: app.fetch });
console.log(JSON.stringify({ level: "info", msg: "api listening", port: server.port }));

// Finish in-flight requests, then close the pool.
async function shutdown(signal: string) {
  console.log(JSON.stringify({ level: "info", msg: "api shutting down", signal }));
  await server.stop();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
