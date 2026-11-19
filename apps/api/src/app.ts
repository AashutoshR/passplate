import { networkInterfaces } from "node:os";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";
import { eq, sql } from "drizzle-orm";
import { DEMO_KITCHEN_CODE, diningTables, locations, type Db } from "@pass/db";
import {
  IdempotencyKeySchema,
  KitchenLoginSchema,
  PlaceOrderSchema,
  StockUpdateSchema,
  TransitionSchema,
} from "@pass/shared";
import { AppError, parse } from "./errors";
import { getMenu, updateStock } from "./services/menu";
import { getOrder, placeOrder } from "./services/orders";
import { kitchenSnapshot, transitionTicket, type KitchenLocation } from "./services/kitchen";
import { UUID_PATTERN, safeEqualHex, sha256 } from "./util";
import { loadUser, type SessionUser } from "./auth";
import { accountRoutes, bookingRoutes, staffRoutes } from "./routes";

type Env = { Variables: { requestId: string; kitchen: KitchenLocation; user: SessionUser | null } };

export interface AppOptions {
  db: Db;
  /** Exposes /v1/dev/* helpers. Never true in production. */
  dev?: boolean;
  log?: boolean;
  webPort?: number;
}

export function createApp({ db, dev = false, log = true, webPort = 3000 }: AppOptions) {
  const app = new Hono<Env>();

  app.use(requestId());
  app.use(secureHeaders());
  if (log) app.use(requestLog());
  // NFR-6: bounded bodies and bounded time for every request.
  app.use(
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: { code: "too_large", message: "Request body too large" } }, 413),
    }),
  );
  app.use(timeout(10_000));
  app.use(loadUser(db));

  app.get("/health/live", (c) => c.json({ ok: true }));
  app.get("/health/ready", async (c) => {
    await db.execute(sql`select 1`);
    return c.json({ ok: true });
  });

  // Public menu. ETag lets phones skip re-downloading an unchanged menu (NFR-18).
  app.get("/v1/locations/:slug/menu", etag(), async (c) => {
    const menu = await getMenu(db, c.req.param("slug"));
    c.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
    return c.json(menu);
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

  app.post("/v1/orders", async (c) => {
    const key = parse(IdempotencyKeySchema, c.req.header("Idempotency-Key") ?? "");
    const body = parse(PlaceOrderSchema, await readJson(c));
    const result = await placeOrder(db, body, key, new Date(), c.get("user")?.id ?? null);
    if (result.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(result.ticket, result.replayed ? 200 : 201);
  });

  app.get("/v1/orders/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) throw new AppError(404, "order_not_found", "Order not found");
    c.header("Cache-Control", "no-store");
    return c.json(await getOrder(db, id));
  });

  // Kitchen. A device code stands in for staff accounts until Milestone 4.
  const kitchen = new Hono<Env>();
  // Registered before the auth middleware, so it answers without a token.
  kitchen.post("/login", async (c) => {
    const body = parse(KitchenLoginSchema, await readJson(c));
    const [loc] = await db.select().from(locations).where(eq(locations.slug, body.slug));
    if (!loc || !safeEqualHex(loc.kitchenTokenHash, sha256(body.code))) {
      throw new AppError(401, "invalid_code", "That kitchen code is not right");
    }
    return c.json({ location: { id: loc.id, slug: loc.slug, name: loc.name } });
  });
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
    const result = await transitionTicket(db, c.get("kitchen"), orderId, body, "kitchen");
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
  app.route("/v1/staff", staffRoutes(db));

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
        kitchenCode: DEMO_KITCHEN_CODE,
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
      JSON.stringify({ level: "error", msg: "unhandled", requestId: c.get("requestId"), error: String(err), stack: (err as Error).stack }),
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

function kitchenAuth(db: Db): MiddlewareHandler<Env> {
  return async (c, next) => {
    const locationId = c.req.param("locationId") ?? "";
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!UUID_PATTERN.test(locationId) || !token) {
      throw new AppError(401, "unauthorized", "Kitchen code required");
    }
    const [loc] = await db.select().from(locations).where(eq(locations.id, locationId));
    if (!loc || !safeEqualHex(loc.kitchenTokenHash, sha256(token))) {
      throw new AppError(401, "unauthorized", "Kitchen code required");
    }
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
