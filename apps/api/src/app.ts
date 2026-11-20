import { networkInterfaces } from "node:os";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";
import { eq, sql } from "drizzle-orm";
import { diningTables, locations, type Db } from "@pass/db";
import {
  CartAddSchema,
  CartQuantitySchema,
  IdempotencyKeySchema,
  PlaceOrderSchema,
  StockUpdateSchema,
  TestPaymentSchema,
  TransitionSchema,
} from "@pass/shared";
import { AppError, parse } from "./errors";
import { noCache, type MenuCache } from "./cache";
import { rateLimit, type Limits, type Store } from "./rate-limit";
import { getMenu, updateStock } from "./services/menu";
import { getOrder, placeOrder } from "./services/orders";
import { kitchenSnapshot, transitionTicket, type KitchenLocation } from "./services/kitchen";
import { addToCart, getCart, setCartQuantity } from "./services/cart";
import { startPayment, stripeWebhook, testPayment, type PaymentsConfig } from "./services/checkout";
import { mediaFile } from "./services/media";
import { UUID_PATTERN } from "./util";
import { loadUser, type SessionUser } from "./auth";
import { accountRoutes, bookingRoutes, inviteRoutes, staffRoutes } from "./routes";

type Env = { Variables: { requestId: string; kitchen: KitchenLocation; user: SessionUser | null } };

export interface AppOptions {
  db: Db;
  /** Exposes /v1/dev/* helpers. Never true in production. */
  dev?: boolean;
  log?: boolean;
  webPort?: number;
  /** Online payments: the built-in test provider, or Stripe in test mode. */
  payments?: PaymentsConfig;
  /** Shared menu cache (NFR-17). Off by default, so tests read the database. */
  menuCache?: MenuCache;
  /** Rate limits (NFR-4). Off when not given. */
  rateLimit?: { store: Store; limits?: Limits; trustProxy?: boolean; now?: () => number };
  /** The site guests and staff open, used to build invite links. */
  publicOrigin?: string;
  /** Where uploaded dish photos are kept. */
  uploadDir?: string;
}

/** Routes whose bodies may be larger than the usual 64 KB. */
const UPLOAD_PATH = "/v1/staff/admin/menu/photos";

export function createApp({
  db,
  dev = false,
  log = true,
  webPort = 3000,
  payments = { provider: "test" },
  menuCache = noCache,
  rateLimit: limiter,
  publicOrigin = `http://localhost:${webPort}`,
  uploadDir,
}: AppOptions) {
  const app = new Hono<Env>();

  app.use(requestId());
  app.use(secureHeaders({ crossOriginResourcePolicy: "same-site" }));
  if (log) app.use(requestLog());
  // NFR-6: bounded bodies and bounded time for every request.
  const small = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => c.json({ error: { code: "too_large", message: "Request body too large" } }, 413),
  });
  const upload = bodyLimit({
    maxSize: 3 * 1024 * 1024 + 64 * 1024,
    onError: (c) => c.json({ error: { code: "too_large", message: "Photos can be up to 3 MB" } }, 413),
  });
  app.use((c, next) => (c.req.path === UPLOAD_PATH ? upload(c, next) : small(c, next)));
  app.use(timeout(10_000));
  app.use(loadUser(db));
  if (limiter) app.use(rateLimit(limiter));

  app.get("/health/live", (c) => c.json({ ok: true }));
  app.get("/health/ready", async (c) => {
    await db.execute(sql`select 1`);
    return c.json({ ok: true });
  });

  // Public menu (NFR-17, NFR-18). Served from the shared Redis cache when it
  // can be; the ETag lets phones skip re-downloading an unchanged menu, and
  // s-maxage lets a CDN answer for a few seconds. Live events cover the gap.
  app.get("/v1/locations/:slug/menu", etag(), async (c) => {
    const slug = c.req.param("slug");
    let menu = await menuCache.get(slug);
    c.header("X-Menu-Cache", menu ? "hit" : "miss");
    if (!menu) {
      menu = await getMenu(db, slug);
      await menuCache.set(menu);
    }
    c.header("Cache-Control", "public, max-age=5, s-maxage=10, stale-while-revalidate=30");
    return c.json(menu);
  });

  // Uploaded dish photos: named by content, so they never change (NFR-17).
  app.get("/v1/media/:name", async (c) => {
    const { file, type } = mediaFile(c.req.param("name"), uploadDir);
    if (!(await file.exists())) throw new AppError(404, "not_found", "Not found");
    c.header("Content-Type", type);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(file.stream());
  });

  app.get("/v1/tables/:token", async (c) => {
    const [row] = await db
      .select({ label: diningTables.label, locationSlug: locations.slug })
      .from(diningTables)
      .innerJoin(locations, eq(locations.id, diningTables.locationId))
      .where(eq(diningTables.qrToken, c.req.param("token")));
    if (!row) throw new AppError(404, "table_not_found", "This table code is not valid");
    return c.json(row);
  });

  // The shared table cart (FR-4). The QR token is the key to it.
  app.get("/v1/tables/:token/cart", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await getCart(db, c.req.param("token")));
  });
  app.post("/v1/tables/:token/cart/lines", async (c) => {
    const body = parse(CartAddSchema, await readJson(c));
    return c.json(await addToCart(db, c.req.param("token"), body));
  });
  app.patch("/v1/tables/:token/cart/lines/:lineId", async (c) => {
    const lineId = c.req.param("lineId");
    if (!UUID_PATTERN.test(lineId)) throw new AppError(404, "not_found", "Not found");
    const body = parse(CartQuantitySchema, await readJson(c));
    return c.json(await setCartQuantity(db, c.req.param("token"), lineId, body.quantity));
  });

  app.post("/v1/orders", async (c) => {
    const key = parse(IdempotencyKeySchema, c.req.header("Idempotency-Key") ?? "");
    const body = parse(PlaceOrderSchema, await readJson(c));
    const result = await placeOrder(db, body, key, new Date(), c.get("user")?.id ?? null, payments);
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(result.ticket, result.replayed ? 200 : 201);
  });

  app.get("/v1/orders/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) throw new AppError(404, "order_not_found", "Order not found");
    c.header("Cache-Control", "no-store");
    return c.json(await getOrder(db, id));
  });

  // Paying for collect and delivery orders (FR-8).
  app.post("/v1/orders/:id/payment", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) throw new AppError(404, "order_not_found", "Order not found");
    c.header("Cache-Control", "no-store");
    return c.json(await startPayment(db, payments, id));
  });
  app.post("/v1/orders/:id/payment/test", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) throw new AppError(404, "order_not_found", "Order not found");
    const body = parse(TestPaymentSchema, await readJson(c));
    return c.json(await testPayment(db, payments, id, body.outcome));
  });
  // Stripe calls this. The raw body is needed to check the signature (NFR-13).
  app.post("/v1/webhooks/stripe", async (c) => {
    const raw = await c.req.text();
    return c.json(await stripeWebhook(db, payments, raw, c.req.header("Stripe-Signature")));
  });

  // Kitchen (FR-10 to FR-13), behind a staff sign-in (FR-22, SEC-2).
  const kitchen = new Hono<Env>();
  kitchen.use("/:locationId/*", kitchenAuth(db));
  kitchen.get("/:locationId/session", (c) => {
    const loc = c.get("kitchen");
    return c.json({ location: { id: loc.id, slug: loc.slug, name: loc.name } });
  });
  kitchen.get("/:locationId/tickets", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await kitchenSnapshot(db, c.get("kitchen")));
  });
  kitchen.post("/:locationId/tickets/:orderId/transition", async (c) => {
    const orderId = c.req.param("orderId");
    if (!UUID_PATTERN.test(orderId)) throw new AppError(404, "order_not_found", "Ticket not found");
    const body = parse(TransitionSchema, await readJson(c));
    const result = await transitionTicket(db, c.get("kitchen"), orderId, body, `staff:${c.get("user")!.id}`, payments);
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(result.ticket);
  });
  kitchen.patch("/:locationId/items/:itemId", async (c) => {
    const itemId = c.req.param("itemId");
    if (!UUID_PATTERN.test(itemId)) throw new AppError(404, "item_not_found", "Menu item not found");
    const body = parse(StockUpdateSchema, await readJson(c));
    const loc = c.get("kitchen");
    return c.json(await updateStock(db, loc.id, loc.tenantId, itemId, body));
  });
  app.route("/v1/kitchen", kitchen);
  app.route("/v1/account", accountRoutes(db));
  app.route("/v1", bookingRoutes(db));
  app.route("/v1/staff", staffRoutes(db, { payments, publicOrigin, uploadDir }));
  app.route("/v1/invites", inviteRoutes(db));

  if (dev) {
    // Lets the demo page link a phone on the same Wi-Fi to the right table.
    app.get("/v1/dev/demo", async (c) => {
      const [loc] = await db.select().from(locations).limit(1);
      if (!loc) throw new AppError(404, "not_seeded", "Run bun run db:seed first");
      const tables = await db
        .select({ label: diningTables.label, token: diningTables.qrToken })
        .from(diningTables)
        .where(eq(diningTables.locationId, loc.id));
      tables.sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
      const lanUrls = Object.values(networkInterfaces())
        .flat()
        .filter((n) => n && n.family === "IPv4" && !n.internal)
        .map((n) => n!.address)
        // Home Wi-Fi first; 172.16-31 is usually a WSL or Docker adapter phones cannot reach.
        .sort((a, b) => Number(/^172\.(1[6-9]|2\d|3[01])\./.test(a)) - Number(/^172\.(1[6-9]|2\d|3[01])\./.test(b)))
        .map((address) => `http://${address}:${webPort}`);
      return c.json({
        location: { id: loc.id, slug: loc.slug, name: loc.name },
        tables,
        lanUrls,
      });
    });
  }

  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    }
    if (err instanceof HTTPException) {
      const status = err.status;
      const code = status === 504 ? "timeout" : "http_error";
      return c.json({ error: { code, message: err.message || "Request failed" } }, status);
    }
    console.error(
      JSON.stringify({
        level: "error",
        msg: "unhandled",
        requestId: c.get("requestId"),
        error: String(err),
        // Drizzle wraps the driver's error; the database's own reason is in the cause.
        cause: (err as { cause?: unknown }).cause ? String((err as { cause?: unknown }).cause) : undefined,
        stack: (err as Error).stack,
      }),
    );
    return c.json({ error: { code: "internal", message: "Something went wrong" } }, 500);
  });

  return app;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError(400, "invalid_json", "The request body must be JSON");
  }
}

/** Staff of this restaurant (or its admin), signed in with their own account. */
function kitchenAuth(db: Db): MiddlewareHandler<Env> {
  return async (c, next) => {
    const locationId = c.req.param("locationId") ?? "";
    if (!UUID_PATTERN.test(locationId)) throw new AppError(404, "location_not_found", "Restaurant not found");
    const user = c.get("user");
    if (!user) throw new AppError(401, "signed_out", "Please sign in");
    if (!["staff", "admin"].includes(user.role) || user.locationId !== locationId) {
      throw new AppError(403, "forbidden", "Sign in with a staff account for this restaurant");
    }
    const [loc] = await db.select().from(locations).where(eq(locations.id, locationId));
    if (!loc) throw new AppError(404, "location_not_found", "Restaurant not found");
    c.set("kitchen", loc);
    await next();
  };
}

/** OBS-2: one structured line per request. */
function requestLog(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const start = performance.now();
    await next();
    console.log(
      JSON.stringify({
        level: c.res.status >= 500 ? "error" : "info",
        msg: "request",
        requestId: c.get("requestId"),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round((performance.now() - start) * 10) / 10,
      }),
    );
  };
}
