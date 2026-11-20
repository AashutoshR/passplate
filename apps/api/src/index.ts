import Redis from "ioredis";
import { DEFAULT_POOLED_URL, createDb } from "@pass/db";
import { createApp } from "./app";
import { redisMenuCache } from "./cache";
import { RedisStore } from "./rate-limit";
import { expireUnpaid, type PaymentsConfig } from "./services/checkout";
import { googleRoutes, straightRoutes } from "./services/maps";
import { assertTestMode } from "./services/stripe";

const port = Number(process.env.API_PORT ?? 4000);
const webPort = Number(process.env.WEB_PORT ?? 3000);

// NFR-14: the API talks to Postgres through PgBouncer. Set DATABASE_POOL_URL
// to an empty string to connect straight to Postgres instead.
const pooledUrl = process.env.DATABASE_POOL_URL ?? DEFAULT_POOLED_URL;
const { db, sql } = pooledUrl
  ? createDb({ url: pooledUrl, pooled: true, appName: "pass-api", max: Number(process.env.DB_POOL_MAX ?? 20) })
  : createDb({ appName: "pass-api", max: Number(process.env.DB_POOL_MAX ?? 10) });

// Redis backs the menu cache and the rate limits. Both keep working without
// it (straight from the database, and per-process buckets).
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6380", {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 250,
});
redis.on("error", () => {});

function paymentsConfig(): PaymentsConfig {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return { provider: "test" };
  const stripe = {
    secretKey,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  };
  assertTestMode(stripe);
  if (!stripe.webhookSecret.startsWith("whsec_")) throw new Error("Set STRIPE_WEBHOOK_SECRET (whsec_...) to use Stripe.");
  return { provider: "stripe", stripe };
}
const payments = paymentsConfig();

// FR-20: Google's Routes API when a server key is set, straight lines otherwise.
const routes = process.env.GOOGLE_MAPS_SERVER_KEY
  ? googleRoutes({
      apiKey: process.env.GOOGLE_MAPS_SERVER_KEY,
      travelMode: process.env.GOOGLE_ROUTES_MODE,
      log: (msg, extra) => console.log(JSON.stringify({ level: "warn", msg, ...extra })),
    })
  : straightRoutes;

const app = createApp({
  db,
  dev: process.env.NODE_ENV !== "production",
  webPort,
  payments,
  menuCache: redisMenuCache(redis),
  rateLimit: process.env.RATE_LIMIT === "off" ? undefined : { store: new RedisStore(redis), trustProxy: process.env.TRUST_PROXY === "1" },
  publicOrigin: process.env.PUBLIC_ORIGIN ?? `http://localhost:${webPort}`,
  routes,
});

const server = Bun.serve({ port, fetch: (req, srv) => app.fetch(req, { server: srv }) });
console.log(
  JSON.stringify({ level: "info", msg: "api listening", port: server.port, payments: payments.provider, routes: routes.name, pooled: Boolean(pooledUrl) }),
);

// Unpaid collect and delivery orders give their stock back after 15 minutes.
const sweep = setInterval(() => {
  expireUnpaid(db, payments)
    .then((n) => n > 0 && console.log(JSON.stringify({ level: "info", msg: "expired unpaid orders", count: n })))
    .catch((err) => console.error(JSON.stringify({ level: "error", msg: "expiry sweep failed", error: String(err) })));
}, 30_000);

// Finish in-flight requests, then close the pool.
async function shutdown(signal: string) {
  console.log(JSON.stringify({ level: "info", msg: "api shutting down", signal }));
  clearInterval(sweep);
  await server.stop();
  await sql.end({ timeout: 5 });
  redis.disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
