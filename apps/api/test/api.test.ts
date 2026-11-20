import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  DEMO_ACCOUNTS,
  createDb,
  locations,
  menuItems,
  orders,
  orderTransitions,
  outbox,
  seedDemo,
} from "@pass/db";
import type { MenuView, TicketView } from "@pass/shared";
import { createApp } from "../src/app";
import { testDatabaseUrl } from "./containers";

const TEST_URL = await testDatabaseUrl();
const { db, sql: pg } = createDb({ url: TEST_URL, max: 20, appName: "pass-test" });
const app = createApp({ db, log: false });

let seed: Awaited<ReturnType<typeof seedDemo>>;
let menu: MenuView;
let kitchenHeaders: Record<string, string>;

beforeEach(async () => {
  seed = await seedDemo(db);
  menu = await (await app.request(`/v1/locations/${seed.locationSlug}/menu`)).json();
  // The kitchen screen signs in with a staff account (FR-22).
  const login = await app.request("/v1/account/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DEMO_ACCOUNTS.kitchen.email, password: DEMO_ACCOUNTS.kitchen.password }),
  });
  kitchenHeaders = { "Content-Type": "application/json", Cookie: login.headers.get("Set-Cookie")!.split(";")[0]! };
});
afterAll(async () => {
  await pg.end();
});

const item = (name: string) => {
  for (const c of menu.categories) for (const i of c.items) if (i.name === name) return i;
  throw new Error(`No item ${name}`);
};

function order(body: Record<string, unknown>, key = crypto.randomUUID()) {
  return app.request("/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ locationSlug: seed.locationSlug, type: "pickup", customerName: "Sam", ...body }),
  });
}

/** Pays for a collect or delivery order with the built-in test provider. */
function pay(orderId: string, outcome: "succeeded" | "declined" = "succeeded") {
  return app.request(`/v1/orders/${orderId}/payment/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outcome }),
  });
}

/** Orders to collect and pays, so the kitchen has the ticket. */
async function paidOrder(body: Record<string, unknown>): Promise<TicketView> {
  const placed = (await (await order(body)).json()) as TicketView;
  const res = await pay(placed.id);
  expect(res.status).toBe(200);
  return (await res.json()) as TicketView;
}

function transition(orderId: string, from: string, to: string, actionId = crypto.randomUUID()) {
  return app.request(`/v1/kitchen/${seed.locationId}/tickets/${orderId}/transition`, {
    method: "POST",
    headers: kitchenHeaders,
    body: JSON.stringify({ from, to, actionId, device: "test" }),
  });
}

describe("menu", () => {
  test("returns categories, items and modifier rules", () => {
    expect(menu.location.slug).toBe("passplate");
    expect(menu.location.isOpen).toBe(true);
    expect(item("Fire-grilled burger").modifierGroups.map((g) => g.name)).toEqual(["Cooked", "Extras"]);
  });

  test("supports conditional requests with ETag", async () => {
    const first = await app.request(`/v1/locations/${seed.locationSlug}/menu`);
    const tag = first.headers.get("ETag");
    expect(tag).toBeTruthy();
    const second = await app.request(`/v1/locations/${seed.locationSlug}/menu`, {
      headers: { "If-None-Match": tag! },
    });
    expect(second.status).toBe(304);
  });
});

describe("placing orders", () => {
  test("creates the order, prices it on the server and writes outbox events", async () => {
    const burger = item("Fire-grilled burger");
    const [cooked, extras] = burger.modifierGroups;
    const res = await order({
      items: [
        {
          menuItemId: burger.id,
          quantity: 2,
          modifierIds: [cooked!.modifiers[0]!.id, extras!.modifiers[0]!.id],
        },
      ],
    });
    expect(res.status).toBe(201);
    const ticket = (await res.json()) as TicketView;
    expect(ticket.subtotalMinor).toBe((1550 + 150) * 2);
    expect(ticket.items[0]!.modifiers).toEqual(["Medium", "Bacon"]);
    expect(ticket.totalMinor).toBe(ticket.subtotalMinor);
    // FR-8: collect orders wait for payment, and the kitchen hears nothing yet.
    expect(ticket.status).toBe("awaiting_payment");
    expect(ticket.paid).toBe(false);
    expect(ticket.payment?.provider).toBe("test");
    expect((await db.select().from(outbox)).map((e) => e.type)).toEqual(["order.updated"]);
  });

  test("enforces modifier rules", async () => {
    const res = await order({ items: [{ menuItemId: item("Fire-grilled burger").id, quantity: 1 }] });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("modifier_rules");
  });

  test("dine-in needs a real table", async () => {
    const water = item("Sparkling water").id;
    const bad = await order({ type: "dine_in", tableToken: "nope", items: [{ menuItemId: water, quantity: 1 }] });
    expect(bad.status).toBe(404);
    const good = await order({
      type: "dine_in",
      tableToken: seed.tables[3]!.token,
      items: [{ menuItemId: water, quantity: 1 }],
    });
    expect(good.status).toBe(201);
    expect(((await good.json()) as TicketView).tableLabel).toBe("Table 4");
  });

  test("rejects invalid bodies and missing idempotency keys", async () => {
    expect((await order({ items: [] })).status).toBe(400);
    const noKey = await app.request("/v1/orders", { method: "POST", body: "{}" });
    expect(noKey.status).toBe(400);
  });

  test("blocks orders outside opening hours", async () => {
    await db.update(locations).set({ openingHours: {} }).where(eq(locations.id, seed.locationId));
    const res = await order({ items: [{ menuItemId: item("Fries").id, quantity: 1 }] });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("closed");
  });
});

describe("idempotency (FR-7)", () => {
  test("the same key returns the same order without a second one", async () => {
    const key = crypto.randomUUID();
    const body = { items: [{ menuItemId: item("Fries").id, quantity: 1 }] };
    const a = await order(body, key);
    const b = await order(body, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    expect(((await a.json()) as TicketView).id).toBe(((await b.json()) as TicketView).id);
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(orders);
    expect(row!.count).toBe(1);
  });

  test("ten simultaneous double taps create one order", async () => {
    const key = crypto.randomUUID();
    const body = { items: [{ menuItemId: item("Market fish").id, quantity: 1 }] };
    const results = await Promise.all(Array.from({ length: 10 }, () => order(body, key)));
    const ids = new Set(await Promise.all(results.map(async (r) => ((await r.json()) as TicketView).id)));
    expect(ids.size).toBe(1);
    const [fish] = await db.select().from(menuItems).where(eq(menuItems.id, item("Market fish").id));
    expect(fish!.stock).toBe(9);
  });

  test("reusing a key for a different order is refused", async () => {
    const key = crypto.randomUUID();
    await order({ items: [{ menuItemId: item("Fries").id, quantity: 1 }] }, key);
    const res = await order({ items: [{ menuItemId: item("Fries").id, quantity: 2 }] }, key);
    expect(res.status).toBe(422);
  });
});

describe("stock (FR-6)", () => {
  test("ten diners racing for the last portion: exactly one wins", async () => {
    const lamb = item("Slow roast lamb shoulder").id;
    await db.update(menuItems).set({ stock: 1 }).where(eq(menuItems.id, lamb));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => order({ items: [{ menuItemId: lamb, quantity: 1 }] })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    const [row] = await db.select().from(menuItems).where(eq(menuItems.id, lamb));
    expect(row!.stock).toBe(0);
  });

  test("sold out items cannot be ordered and the kitchen can toggle them", async () => {
    const fries = item("Fries").id;
    const toggle = await app.request(`/v1/kitchen/${seed.locationId}/items/${fries}`, {
      method: "PATCH",
      headers: kitchenHeaders,
      body: JSON.stringify({ soldOut: true }),
    });
    expect(toggle.status).toBe(200);
    const res = await order({ items: [{ menuItemId: fries, quantity: 1 }] });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("sold_out");
  });
});

describe("kitchen (FR-10, FR-11, FR-13)", () => {
  test("needs a staff sign-in for this restaurant", async () => {
    expect((await app.request(`/v1/kitchen/${seed.locationId}/tickets`)).status).toBe(401);
    const guest = await app.request("/v1/account/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: DEMO_ACCOUNTS.customer.email, password: DEMO_ACCOUNTS.customer.password }),
    });
    const cookie = guest.headers.get("Set-Cookie")!.split(";")[0]!;
    expect((await app.request(`/v1/kitchen/${seed.locationId}/tickets`, { headers: { Cookie: cookie } })).status).toBe(403);
  });

  test("snapshot lists active tickets", async () => {
    await paidOrder({ items: [{ menuItemId: item("Fries").id, quantity: 1 }] });
    // An unpaid order is not on the kitchen screen.
    await order({ items: [{ menuItemId: item("Fries").id, quantity: 1 }] });
    const res = await app.request(`/v1/kitchen/${seed.locationId}/tickets`, { headers: kitchenHeaders });
    const snap = await res.json();
    expect(snap.tickets).toHaveLength(1);
    expect(typeof snap.seq).toBe("number");
  });

  test("moves tickets through the state machine and records who did it", async () => {
    const t = await paidOrder({ items: [{ menuItemId: item("Fries").id, quantity: 1 }] });
    expect((await transition(t.id, "received", "cooking")).status).toBe(200);
    expect((await transition(t.id, "cooking", "ready")).status).toBe(200);
    const done = await transition(t.id, "ready", "completed");
    expect(((await done.json()) as TicketView).status).toBe("completed");
    const trail = await db.select().from(orderTransitions).where(eq(orderTransitions.orderId, t.id));
    // The payment moved it to received; staff did the rest, and the trail says who.
    expect(trail.map((r) => r.toStatus)).toEqual(["received", "cooking", "ready", "completed"]);
    expect(trail[0]!.actor).toBe("payment:test");
    expect(trail.slice(1).every((r) => r.device === "test" && r.actor.startsWith("staff:"))).toBe(true);
  });

  test("rejects invalid jumps", async () => {
    const t = await paidOrder({ items: [{ menuItemId: item("Fries").id, quantity: 1 }] });
    const res = await transition(t.id, "received", "completed");
    expect(res.status).toBe(422);
  });

  test("replaying the same action is safe, a stale one is refused", async () => {
    const t = await paidOrder({ items: [{ menuItemId: item("Fries").id, quantity: 1 }] });
    const actionId = crypto.randomUUID();
    const first = await transition(t.id, "received", "cooking", actionId);
    const again = await transition(t.id, "received", "cooking", actionId);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    const trail = await db.select().from(orderTransitions).where(eq(orderTransitions.orderId, t.id));
    expect(trail.filter((r) => r.actor.startsWith("staff:"))).toHaveLength(1);

    await transition(t.id, "cooking", "ready");
    const stale = await transition(t.id, "cooking", "cancelled");
    expect(stale.status).toBe(409);
  });

  test("cancelling gives counted stock back", async () => {
    const tart = item("Dark chocolate tart").id;
    const t = await paidOrder({ items: [{ menuItemId: tart, quantity: 2 }] });
    await transition(t.id, "received", "cancelled");
    const [row] = await db
      .select()
      .from(menuItems)
      .where(and(eq(menuItems.id, tart), eq(menuItems.locationId, seed.locationId)));
    expect(row!.stock).toBe(6);
  });
});
