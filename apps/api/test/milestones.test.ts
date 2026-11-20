import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import Redis from "ioredis";
import { DEMO_ACCOUNTS, createDb, menuItems, orders, outbox, payments, rewards, seedDemo, type DemoAccount } from "@pass/db";
import type { CartEvent, CartView, MenuAdminView, MenuView, PaymentStartView, TicketView } from "@pass/shared";
import { createApp } from "../src/app";
import { menuMinSeqKey, redisMenuCache } from "../src/cache";
import { MemoryStore, RedisStore, DEFAULT_LIMITS, type Limits } from "../src/rate-limit";
import { expireUnpaid, type PaymentsConfig } from "../src/services/checkout";
import { signWebhook, verifyWebhook } from "../src/services/stripe";
import { testDatabaseUrl, testRedisUrl } from "./containers";

/**
 * The gaps closed after the first release: the shared table cart (FR-4), the
 * menu editor (FR-1), paying before the kitchen sees an order (FR-8, NFR-13),
 * staff sign-in for the kitchen and invite links (FR-22, SEC-2), rate limits
 * (NFR-4) and the shared menu cache (NFR-17).
 */

const TEST_URL = await testDatabaseUrl();
const { db, sql: pg } = createDb({ url: TEST_URL, max: 20, appName: "pass-test-milestones" });
const uploads = await mkdtemp(join(tmpdir(), "pass-uploads-"));
const app = createApp({ db, log: false, uploadDir: uploads, publicOrigin: "https://passplate.test" });

let seed: Awaited<ReturnType<typeof seedDemo>>;
let menu: MenuView;

beforeEach(async () => {
  seed = await seedDemo(db);
  menu = await (await app.request(`/v1/locations/${seed.locationSlug}/menu`)).json();
});
afterAll(async () => {
  await pg.end();
});

const item = (name: string, m: MenuView = menu) => {
  for (const c of m.categories) for (const i of c.items) if (i.name === name) return i;
  throw new Error(`No item ${name}`);
};

function call(
  target: { request: typeof app.request },
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; key?: string; headers?: Record<string, string> } = {},
) {
  return target.request(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      ...(init.cookie ? { Cookie: init.cookie } : {}),
      ...(init.key ? { "Idempotency-Key": init.key } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
const api = (path: string, init: Parameters<typeof call>[2] = {}) => call(app, path, init);

async function signIn(who: DemoAccount): Promise<string> {
  const a = DEMO_ACCOUNTS[who];
  const res = await api("/v1/account/login", { body: { email: a.email, password: a.password } });
  expect(res.status).toBe(200);
  return res.headers.get("Set-Cookie")!.split(";")[0]!;
}

function order(body: Record<string, unknown>, cookie?: string) {
  return api("/v1/orders", {
    body: { locationSlug: seed.locationSlug, type: "pickup", customerName: "Sam", ...body },
    cookie,
    key: crypto.randomUUID(),
  });
}

async function events(type: string) {
  return (await db.select().from(outbox)).filter((e) => e.type === type);
}

describe("shared table cart (FR-4)", () => {
  const table = () => seed.tables.find((t) => t.label === "Table 9")!.token;
  const add = (name: string, by: string, lineId = crypto.randomUUID(), quantity = 1) =>
    api(`/v1/tables/${table()}/cart/lines`, { body: { lineId, menuItemId: item(name).id, quantity, addedBy: by } });

  test("twenty phones adding at the same moment: every dish lands, none twice", async () => {
    const names = ["Fries", "Sparkling water", "Dark chocolate tart", "Fries"];
    const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
    const results = await Promise.all(ids.map((id, i) => add(names[i % names.length]!, `Guest ${i}`, id)));
    expect(results.every((r) => r.status === 200)).toBe(true);

    // A retried add (same line id) changes nothing.
    expect((await add("Fries", "Guest 0", ids[0])).status).toBe(200);

    const cart = (await (await api(`/v1/tables/${table()}/cart`)).json()) as CartView;
    expect(cart.lines).toHaveLength(20);
    expect(new Set(cart.lines.map((l) => l.id))).toEqual(new Set(ids));
    expect(cart.version).toBe(20);
    expect(cart.lines.find((l) => l.addedBy === "Guest 3")?.name).toBe("Fries");
    // Every change was announced on the cart's own channel.
    expect((await events("cart.updated")).every((e) => e.channel === `cart:${cart.cartId}`)).toBe(true);
  });

  test("checks the same rules as ordering", async () => {
    const res = await add("Fire-grilled burger", "Ana");
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("modifier_rules");
    expect((await api(`/v1/tables/nope/cart`)).status).toBe(404);
  });

  test("sending orders exactly the dishes this phone saw; a dish added a moment later stays", async () => {
    await add("Fries", "Ana", undefined, 2);
    await add("Sparkling water", "Ben");
    const seen = (await (await api(`/v1/tables/${table()}/cart`)).json()) as CartView;
    // Someone adds dessert after Ana opened her basket.
    await add("Dark chocolate tart", "Cal");

    const sent = await order({
      type: "dine_in",
      tableToken: table(),
      customerName: "Ana",
      tableCartLineIds: seen.lines.map((l) => l.id),
    });
    expect(sent.status).toBe(201);
    const ticket = (await sent.json()) as TicketView;
    expect(ticket.status).toBe("received");
    expect(ticket.items.map((i) => `${i.quantity} ${i.name}`)).toEqual(["2 Fries", "1 Sparkling water"]);

    const after = (await (await api(`/v1/tables/${table()}/cart`)).json()) as CartView;
    expect(after.lines.map((l) => l.name)).toEqual(["Dark chocolate tart"]);

    // Ben pressed send on the same basket a second later: nothing is ordered twice.
    const again = await order({ type: "dine_in", tableToken: table(), customerName: "Ben", tableCartLineIds: seen.lines.map((l) => l.id) });
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("cart_already_sent");

    // The other phones hear who sent what.
    const last = (await events("cart.updated")).map((e) => e.payload as CartEvent).find((p) => p.sent);
    expect(last?.sent).toMatchObject({ orderId: ticket.id, by: "Ana", count: 3 });
  });

  test("quantities change in place; clearing the table starts a new cart", async () => {
    const lineId = crypto.randomUUID();
    await add("Fries", "Ana", lineId);
    const changed = (await (
      await api(`/v1/tables/${table()}/cart/lines/${lineId}`, { method: "PATCH", body: { quantity: 3 } })
    ).json()) as CartView;
    expect(changed.lines[0]!.quantity).toBe(3);
    const before = (await (await api(`/v1/tables/${table()}/cart`)).json()) as CartView;

    const staff = await signIn("staff");
    const tableId = seed.tables.find((t) => t.label === "Table 9")!.id;
    expect((await api(`/v1/staff/floor/tables/${tableId}/clear`, { method: "POST", cookie: staff })).status).toBe(200);
    const fresh = (await (await api(`/v1/tables/${table()}/cart`)).json()) as CartView;
    expect(fresh.lines).toHaveLength(0);
    expect(fresh.cartId).not.toBe(before.cartId);
  });
});

describe("paying before the kitchen sees it (FR-8)", () => {
  const fries = () => [{ menuItemId: item("Fries").id, quantity: 1 }];

  test("a declined card leaves the order waiting; paying sends it to the kitchen", async () => {
    const t = (await (await order({ items: fries() })).json()) as TicketView;
    const start = (await (await api(`/v1/orders/${t.id}/payment`, { method: "POST" })).json()) as PaymentStartView;
    expect(start).toMatchObject({ provider: "test", amountMinor: 450, clientSecret: null });

    const declined = await api(`/v1/orders/${t.id}/payment/test`, { body: { outcome: "declined" } });
    expect(declined.status).toBe(402);
    expect((await events("ticket.created"))).toHaveLength(0);

    const paid = (await (await api(`/v1/orders/${t.id}/payment/test`, { body: { outcome: "succeeded" } })).json()) as TicketView;
    expect(paid).toMatchObject({ status: "received", paid: true, payment: null });
    expect(await events("ticket.created")).toHaveLength(1);
    // Paying twice is harmless.
    expect((await api(`/v1/orders/${t.id}/payment/test`, { body: { outcome: "succeeded" } })).status).toBe(200);
    expect(await db.select().from(payments).where(eq(payments.orderId, t.id))).toHaveLength(1);
  });

  test("an unpaid order expires: stock and the reward go back", async () => {
    const cookie = await signIn("customer");
    // The demo guest has seven stamps; give them a reward to spend.
    const [done] = await db.select({ id: orders.id }).from(orders).limit(1);
    if (done) await db.insert(rewards).values({ userId: seed.users.customer, earnedOrderId: done.id });
    const tart = item("Dark chocolate tart").id;
    const t = (await (await order({ items: [{ menuItemId: tart, quantity: 3 }] }, cookie)).json()) as TicketView;
    const [held] = await db.select().from(menuItems).where(eq(menuItems.id, tart));
    expect(held!.stock).toBe(3);

    const later = new Date(Date.now() + 16 * 60_000);
    expect(await expireUnpaid(db, { provider: "test" }, later)).toBe(1);
    const [row] = await db.select().from(orders).where(eq(orders.id, t.id));
    expect(row!.status).toBe("cancelled");
    const [back] = await db.select().from(menuItems).where(eq(menuItems.id, tart));
    expect(back!.stock).toBe(6);
    // Too late to pay now.
    expect((await api(`/v1/orders/${t.id}/payment/test`, { body: { outcome: "succeeded" } })).status).toBe(409);
    expect(await expireUnpaid(db, { provider: "test" }, later)).toBe(0);
  });

  test("an unpaid reward order gives the reward back when it expires", async () => {
    const cookie = await signIn("customer");
    const [any] = await db.select({ id: orders.id }).from(orders).limit(1);
    const placed = (await (await order({ items: fries() })).json()) as TicketView;
    await db.insert(rewards).values({ userId: seed.users.customer, earnedOrderId: any?.id ?? placed.id });
    const t = (await (await order({ useReward: true, items: [{ menuItemId: item("Market fish").id, quantity: 2 }] }, cookie)).json()) as TicketView;
    expect(t.discountMinor).toBeGreaterThan(0);
    await expireUnpaid(db, { provider: "test" }, new Date(Date.now() + 16 * 60_000));
    const open = await db.select().from(rewards).where(eq(rewards.userId, seed.users.customer));
    expect(open.every((r) => r.redeemedOrderId === null)).toBe(true);
  });
});

describe("Stripe test mode (FR-8, NFR-13, NFR-19)", () => {
  const secret = "whsec_test_secret";
  const calls: { url: string; body: string; key: string | null }[] = [];
  const fakeStripe: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? ""), key: new Headers(init?.headers).get("Idempotency-Key") });
    if (url.endsWith("/v1/payment_intents")) {
      return Response.json({ id: "pi_123", client_secret: "pi_123_secret_abc", status: "requires_payment_method", amount: 450, currency: "gbp", metadata: {} });
    }
    if (url.includes("/v1/payment_intents/pi_123")) {
      return Response.json({ id: "pi_123", client_secret: "pi_123_secret_abc", status: "requires_payment_method", amount: 450, currency: "gbp", metadata: {} });
    }
    if (url.endsWith("/v1/refunds")) return Response.json({ id: "re_1" });
    return Response.json({ error: { message: "unexpected" } }, { status: 500 });
  }) as typeof fetch;
  const cfg: PaymentsConfig = {
    provider: "stripe",
    stripe: { secretKey: "sk_test_x", publishableKey: "pk_test_x", webhookSecret: secret, fetch: fakeStripe },
  };
  const stripeApp = createApp({ db, log: false, payments: cfg });
  const sapi = (path: string, init: Parameters<typeof call>[2] = {}) => call(stripeApp, path, init);

  function webhook(orderId: string, eventId = `evt_${crypto.randomUUID()}`, sign = true) {
    const body = JSON.stringify({ id: eventId, type: "payment_intent.succeeded", data: { object: { id: "pi_123", metadata: { order_id: orderId } } } });
    return stripeApp.request("/v1/webhooks/stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Stripe-Signature": sign ? signWebhook(body, secret) : "t=1,v1=00" },
      body,
    });
  }

  test("the payment screen gets a PaymentIntent, created once with an idempotency key", async () => {
    calls.length = 0;
    const placed = await sapi("/v1/orders", {
      body: { locationSlug: "passplate", type: "pickup", customerName: "Kim", items: [{ menuItemId: item("Fries").id, quantity: 1 }] },
      key: crypto.randomUUID(),
    });
    const t = (await placed.json()) as TicketView;
    expect(t.payment?.provider).toBe("stripe");
    const a = (await (await sapi(`/v1/orders/${t.id}/payment`, { method: "POST" })).json()) as PaymentStartView;
    expect(a).toMatchObject({ provider: "stripe", clientSecret: "pi_123_secret_abc", publishableKey: "pk_test_x" });
    await sapi(`/v1/orders/${t.id}/payment`, { method: "POST" });
    const creates = calls.filter((c) => c.url.endsWith("/v1/payment_intents"));
    expect(creates).toHaveLength(1);
    expect(creates[0]!.key).toBe(`pi-${t.id}`);
    expect(creates[0]!.body).toContain("amount=450");
    // Test-mode keys only: the test provider's button does nothing here.
    expect((await sapi(`/v1/orders/${t.id}/payment/test`, { body: { outcome: "succeeded" } })).status).toBe(409);
  });

  test("a signed webhook confirms the order once, however often Stripe retries", async () => {
    const t = (await (
      await sapi("/v1/orders", {
        body: { locationSlug: "passplate", type: "pickup", customerName: "Kim", items: [{ menuItemId: item("Fries").id, quantity: 1 }] },
        key: crypto.randomUUID(),
      })
    ).json()) as TicketView;
    expect((await webhook(t.id, "evt_1", false)).status).toBe(400);
    const first = await webhook(t.id, "evt_1");
    expect(first.status).toBe(200);
    expect((await first.json()).duplicate).toBe(false);
    const retry = await webhook(t.id, "evt_1");
    expect((await retry.json()).duplicate).toBe(true);
    // A different event for the same payment is also harmless.
    expect((await webhook(t.id, "evt_2")).status).toBe(200);
    const [row] = await db.select().from(orders).where(eq(orders.id, t.id));
    expect(row!.status).toBe("received");
    expect(await db.select().from(payments).where(eq(payments.orderId, t.id))).toHaveLength(1);
    expect(await events("ticket.created")).toHaveLength(1);
  });

  test("a payment that lands after the order expired is refunded", async () => {
    calls.length = 0;
    const t = (await (
      await sapi("/v1/orders", {
        body: { locationSlug: "passplate", type: "pickup", customerName: "Kim", items: [{ menuItemId: item("Fries").id, quantity: 1 }] },
        key: crypto.randomUUID(),
      })
    ).json()) as TicketView;
    await db.update(orders).set({ paymentRef: "pi_123" }).where(eq(orders.id, t.id));
    await expireUnpaid(db, cfg, new Date(Date.now() + 16 * 60_000));
    expect((await webhook(t.id)).status).toBe(200);
    expect(calls.some((c) => c.url.endsWith("/v1/refunds") && c.body.includes("payment_intent=pi_123"))).toBe(true);
  });

  test("signatures: wrong secret, tampered body and old timestamps are refused", () => {
    const body = JSON.stringify({ id: "evt", type: "x", data: { object: { id: "pi" } } });
    expect(() => verifyWebhook(body, signWebhook(body, "whsec_other"), secret)).toThrow();
    expect(() => verifyWebhook(body + " ", signWebhook(body, secret), secret)).toThrow();
    expect(() => verifyWebhook(body, signWebhook(body, secret, Date.now() - 10 * 60_000), secret)).toThrow();
    expect(verifyWebhook(body, signWebhook(body, secret), secret).id).toBe("evt");
  });
});

describe("menu editor (FR-1)", () => {
  const base = (categoryId: string) => ({
    categoryId,
    name: "Crab toast",
    description: "Brown and white crab, lemon",
    priceMinor: 1200,
    allergens: ["crustaceans", "gluten"],
    dietary: [],
    image: null,
    featured: false,
    stock: null,
    soldOut: false,
    modifierGroups: [{ name: "Bread", minSelect: 1, maxSelect: 1, modifiers: [{ name: "Sourdough", priceDeltaMinor: 0 }, { name: "Rye", priceDeltaMinor: 50 }] }],
  });

  test("only admins can edit", async () => {
    expect((await api("/v1/staff/admin/menu", { cookie: await signIn("staff") })).status).toBe(403);
    expect((await api("/v1/staff/admin/menu", { cookie: await signIn("admin") })).status).toBe(200);
  });

  test("a new section and dish appear on the public menu, and open menus are told", async () => {
    const admin = await signIn("admin");
    const cat = await (await api("/v1/staff/admin/menu/categories", { cookie: admin, body: { name: "Specials", blurb: "This week only" } })).json();
    const created = await api("/v1/staff/admin/menu/items", { cookie: admin, body: base(cat.id) });
    expect(created.status).toBe(201);
    const fresh = (await (await api("/v1/locations/passplate/menu")).json()) as MenuView;
    const specials = fresh.categories.find((c) => c.name === "Specials")!;
    expect(specials.blurb).toBe("This week only");
    expect(specials.items[0]!.modifierGroups[0]!.modifiers.map((m) => m.name)).toEqual(["Sourdough", "Rye"]);
    expect((await events("menu.changed")).length).toBeGreaterThanOrEqual(2);
  });

  test("editing keeps option ids, so dishes already in carts still order", async () => {
    const admin = await signIn("admin");
    const burger = item("Fire-grilled burger");
    const view = (await (await api("/v1/staff/admin/menu", { cookie: admin })).json()) as MenuAdminView;
    const cat = view.categories.find((c) => c.items.some((i) => i.id === burger.id))!;
    const current = cat.items.find((i) => i.id === burger.id)!;
    const res = await api(`/v1/staff/admin/menu/items/${burger.id}`, {
      method: "PUT",
      cookie: admin,
      body: { ...current, priceMinor: 1650, modifierGroups: current.modifierGroups },
    });
    expect(res.status).toBe(200);
    const t = (await (
      await order({ items: [{ menuItemId: burger.id, quantity: 1, modifierIds: [burger.modifierGroups[0]!.modifiers[0]!.id] }] })
    ).json()) as TicketView;
    expect(t.subtotalMinor).toBe(1650);
  });

  test("taking a dish off hides it and stops orders; restoring brings it back", async () => {
    const admin = await signIn("admin");
    const fries = item("Fries").id;
    expect((await api(`/v1/staff/admin/menu/items/${fries}`, { method: "DELETE", cookie: admin })).status).toBe(200);
    const fresh = (await (await api("/v1/locations/passplate/menu")).json()) as MenuView;
    expect(() => item("Fries", fresh)).toThrow();
    const res = await order({ items: [{ menuItemId: fries, quantity: 1 }] });
    expect((await res.json()).error.code).toBe("unknown_item");
    await api(`/v1/staff/admin/menu/items/${fries}/restore`, { method: "POST", cookie: admin });
    expect((await order({ items: [{ menuItemId: fries, quantity: 1 }] })).status).toBe(201);
  });

  test("bad input is explained", async () => {
    const admin = await signIn("admin");
    const view = (await (await api("/v1/staff/admin/menu", { cookie: admin })).json()) as MenuAdminView;
    const body = base(view.categories[0]!.id);
    body.modifierGroups[0]!.maxSelect = 5;
    const res = await api("/v1/staff/admin/menu/items", { cookie: admin, body: { ...body, image: "https://example.com/x.jpg" } });
    expect(res.status).toBe(400);
    const issues = (await res.json()).error.details.map((d: { path: string }) => d.path);
    expect(issues).toContain("image");
    expect(issues).toContain("modifierGroups.0.maxSelect");
  });

  test("photos upload by content, and anything that is not an image is refused", async () => {
    const admin = await signIn("admin");
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const upload = (bytes: Uint8Array<ArrayBuffer>, name: string) => {
      const form = new FormData();
      form.append("photo", new File([bytes], name));
      return app.request("/v1/staff/admin/menu/photos", { method: "POST", headers: { Cookie: admin }, body: form });
    };
    const ok = await upload(png, "dish.png");
    expect(ok.status).toBe(201);
    const { path } = await ok.json();
    expect(path).toMatch(/^\/api\/v1\/media\/[a-f0-9]{32}\.png$/);
    const served = await app.request(path.replace("/api", ""));
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(served.headers.get("Cache-Control")).toContain("immutable");
    const fake = await upload(new TextEncoder().encode("<script>alert(1)</script>"), "dish.png");
    expect(fake.status).toBe(415);
  });
});

describe("staff accounts and invites (FR-22)", () => {
  test("an invite link makes a staff account once, and that account opens the kitchen", async () => {
    const admin = await signIn("admin");
    const made = await (await api("/v1/staff/admin/invites", { cookie: admin, body: { role: "staff", name: "Jo" } })).json();
    expect(made.url).toStartWith("https://passplate.test/join/");
    const token = made.url.split("/join/")[1];
    expect((await (await api(`/v1/invites/${token}`)).json())).toMatchObject({ role: "staff", restaurant: "PassPlate", name: "Jo" });

    const accepted = await api(`/v1/invites/${token}/accept`, { body: { name: "Jo Bell", email: "jo@passplate.test", password: "a-long-password" } });
    expect(accepted.status).toBe(201);
    const cookie = accepted.headers.get("Set-Cookie")!.split(";")[0]!;
    expect((await api(`/v1/kitchen/${seed.locationId}/tickets`, { cookie })).status).toBe(200);

    const reuse = await api(`/v1/invites/${token}/accept`, { body: { name: "Eve", email: "eve@passplate.test", password: "a-long-password" } });
    expect(reuse.status).toBe(410);
    const pending = await (await api("/v1/staff/admin/invites", { cookie: admin })).json();
    expect(pending.invites).toHaveLength(0);
  });

  test("drivers cannot open the kitchen, and made-up links do nothing", async () => {
    expect((await api(`/v1/kitchen/${seed.locationId}/tickets`, { cookie: await signIn("driver") })).status).toBe(403);
    expect((await api("/v1/invites/not-a-real-invite-token-at-all")).status).toBe(404);
  });
});

describe("rate limits (NFR-4)", () => {
  const tight: Limits = {
    ...DEFAULT_LIMITS,
    ip: { ...DEFAULT_LIMITS.ip, read: { capacity: 3, refillPerSec: 1 }, order: { capacity: 2, refillPerSec: 0.5 } },
  };

  test("over the limit gets 429 with Retry-After, and the bucket refills", async () => {
    let now = 1_000_000;
    const limited = createApp({ db, log: false, rateLimit: { store: new MemoryStore(), limits: tight, now: () => now } });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await limited.request("/v1/locations/passplate/menu")).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const blocked = await limited.request("/v1/locations/passplate/menu");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    now += 2000;
    expect((await limited.request("/v1/locations/passplate/menu")).status).toBe(200);
    // Health checks are never limited.
    expect((await limited.request("/health/live")).status).toBe(200);
  });

  test("buckets live in Redis, so every API instance shares them", async () => {
    const redis = new Redis(await testRedisUrl());
    await redis.flushall();
    const store = new RedisStore(redis);
    await new Promise((r) => setTimeout(r, 50));
    const one = createApp({ db, log: false, rateLimit: { store, limits: tight } });
    const two = createApp({ db, log: false, rateLimit: { store, limits: tight } });
    const body = { locationSlug: "passplate", type: "pickup", customerName: "Al", items: [{ menuItemId: item("Fries").id, quantity: 1 }] };
    const statuses = [];
    for (const target of [one, two, one]) statuses.push((await call(target, "/v1/orders", { body, key: crypto.randomUUID() })).status);
    expect(statuses).toEqual([201, 201, 429]);
    redis.disconnect();
  });
});

describe("menu cache (NFR-17)", () => {
  test("served from Redis until a menu event clears it; a stale copy is never served", async () => {
    const redis = new Redis(await testRedisUrl());
    await redis.flushall();
    await new Promise((r) => setTimeout(r, 50));
    const cached = createApp({ db, log: false, menuCache: redisMenuCache(redis) });
    const first = await cached.request("/v1/locations/passplate/menu");
    expect(first.headers.get("X-Menu-Cache")).toBe("miss");
    expect(first.headers.get("Cache-Control")).toContain("s-maxage");
    expect((await cached.request("/v1/locations/passplate/menu")).headers.get("X-Menu-Cache")).toBe("hit");

    // What the relay does when it publishes a menu event with a newer seq.
    const copy = (await first.json()) as MenuView;
    await redis.set(menuMinSeqKey(copy.location.id), copy.seq + 1);
    expect((await cached.request("/v1/locations/passplate/menu")).headers.get("X-Menu-Cache")).toBe("miss");
    redis.disconnect();
  });
});


