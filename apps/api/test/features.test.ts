import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DEMO_ACCOUNTS, createDb, orders, payments, seedDemo, type DemoAccount } from "@pass/db";
import {
  localDate,
  type AvailabilityView,
  type FloorView,
  type MenuView,
  type ReservationView,
  type TicketView,
  type TransactionsView,
} from "@pass/shared";
import { createApp } from "../src/app";
import { testDatabaseUrl } from "./containers";

const TEST_URL = await testDatabaseUrl();
const { db, sql: pg } = createDb({ url: TEST_URL, max: 20, appName: "pass-test-features" });
const app = createApp({ db, log: false });

let seed: Awaited<ReturnType<typeof seedDemo>>;
let menu: MenuView;

beforeEach(async () => {
  seed = await seedDemo(db);
  kitchenCookie = "";
  menu = await (await app.request(`/v1/locations/${seed.locationSlug}/menu`)).json();
});
afterAll(async () => {
  await pg.end();
});

const item = (name: string) => {
  for (const c of menu.categories) for (const i of c.items) if (i.name === name) return i;
  throw new Error(`No item ${name}`);
};

/** Signs in and returns a Cookie header for later requests. */
async function signIn(role: DemoAccount): Promise<string> {
  const a = DEMO_ACCOUNTS[role];
  const res = await app.request("/v1/account/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: a.email, password: a.password }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("Set-Cookie")!.split(";")[0]!;
}

function call(path: string, init: { method?: string; body?: unknown; cookie?: string; key?: string } = {}) {
  return app.request(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      ...(init.cookie ? { Cookie: init.cookie } : {}),
      ...(init.key ? { "Idempotency-Key": init.key } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/**
 * Places an order. Collect and delivery orders are then paid with the test
 * provider (unless `unpaid`), so the response is the order the kitchen sees.
 */
async function placeOrder(body: Record<string, unknown>, cookie?: string, opts: { unpaid?: boolean } = {}) {
  const res = await call("/v1/orders", {
    body: { locationSlug: seed.locationSlug, type: "pickup", customerName: "Sam", ...body },
    cookie,
    key: crypto.randomUUID(),
  });
  if (res.status !== 201 || body.type === "dine_in" || opts.unpaid) return res;
  const placed = (await res.json()) as TicketView;
  const paid = await call(`/v1/orders/${placed.id}/payment/test`, { body: { outcome: "succeeded" } });
  expect(paid.status).toBe(200);
  return new Response(await paid.text(), { status: 201, headers: { "Content-Type": "application/json" } });
}

let kitchenCookie = "";
async function kitchen() {
  kitchenCookie ||= await signIn("kitchen");
  return { "Content-Type": "application/json", Cookie: kitchenCookie };
}

async function finish(orderId: string, type: "pickup" | "dine_in" = "pickup") {
  const headers = await kitchen();
  for (const [from, to] of [
    ["received", "cooking"],
    ["cooking", "ready"],
    ["ready", "completed"],
  ] as const) {
    const res = await app.request(`/v1/kitchen/${seed.locationId}/tickets/${orderId}/transition`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from, to, actionId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(200);
  }
  void type;
}

/** A bookable day with late hours: at least two days out, not a Monday (closed) or a Sunday (shuts at 21:00). */
function bookableDate(): string {
  const d = new Date(Date.now() + 2 * 86_400_000);
  while (d.getUTCDay() === 1 || d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return localDate("Europe/London", d);
}

describe("accounts", () => {
  test("register signs you in, and the session cookie works", async () => {
    const res = await call("/v1/account/register", {
      body: { name: "Rae", email: "Rae@Example.test", password: "a-long-password" },
    });
    expect(res.status).toBe(201);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain("HttpOnly");
    const me = await (await call("/v1/account/me", { cookie: cookie.split(";")[0] })).json();
    expect(me.user.email).toBe("rae@example.test");
    expect(me.rewards.stamps).toBe(0);
  });

  test("a second account with the same email is refused", async () => {
    const body = { name: "Rae", email: "rae@example.test", password: "a-long-password" };
    expect((await call("/v1/account/register", { body })).status).toBe(201);
    expect((await call("/v1/account/register", { body })).status).toBe(409);
  });

  test("wrong password and unknown email look the same", async () => {
    const wrong = await call("/v1/account/login", { body: { email: DEMO_ACCOUNTS.admin.email, password: "nope-nope" } });
    const unknown = await call("/v1/account/login", { body: { email: "nobody@passplate.test", password: "nope-nope" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((await wrong.json()).error.code).toBe((await unknown.json()).error.code);
  });

  test("staff screens need the right role", async () => {
    expect((await call("/v1/staff/floor")).status).toBe(401);
    expect((await call("/v1/staff/floor", { cookie: await signIn("customer") })).status).toBe(403);
    expect((await call("/v1/staff/floor", { cookie: await signIn("staff") })).status).toBe(200);
    expect((await call("/v1/staff/admin/transactions", { cookie: await signIn("staff") })).status).toBe(403);
    expect((await call("/v1/staff/admin/transactions", { cookie: await signIn("admin") })).status).toBe(200);
  });

  test("the admin overview adds up two weeks of takings", async () => {
    await placeOrder({ items: [{ menuItemId: item("Fries").id, quantity: 2 }] });
    const res = await call("/v1/staff/admin/overview", { cookie: await signIn("admin") });
    expect(res.status).toBe(200);
    const o = await res.json();
    expect(o.days).toHaveLength(14);
    expect(o.today.revenueMinor).toBe(900);
    expect(o.topItems[0].name).toBe("Fries");
  });

  test("signing out ends the session", async () => {
    const cookie = await signIn("customer");
    await call("/v1/account/logout", { method: "POST", cookie });
    const me = await (await call("/v1/account/me", { cookie })).json();
    expect(me.user).toBeNull();
  });
});

describe("rewards", () => {
  test("eight finished orders earn 20% off the next one, used once", async () => {
    const cookie = await signIn("customer");
    const fries = item("Fries").id;
    for (let i = 0; i < 8; i++) {
      const t = (await (await placeOrder({ items: [{ menuItemId: fries, quantity: 1 }] }, cookie)).json()) as TicketView;
      await finish(t.id);
    }
    const me = await (await call("/v1/account/me", { cookie })).json();
    expect(me.rewards.completedOrders).toBe(8);
    expect(me.rewards.stamps).toBe(0);
    expect(me.rewards.available).toBe(1);

    const steak = item("Flat iron steak");
    const res = await placeOrder(
      { useReward: true, items: [{ menuItemId: steak.id, quantity: 2, modifierIds: [steak.modifierGroups[0]!.modifiers[0]!.id] }] },
      cookie,
    );
    expect(res.status).toBe(201);
    const t = (await res.json()) as TicketView;
    expect(t.discountMinor).toBe(Math.min(1500, Math.round(t.subtotalMinor * 0.2)));
    expect(t.totalMinor).toBe(t.subtotalMinor - t.discountMinor);

    const again = await placeOrder({ useReward: true, items: [{ menuItemId: fries, quantity: 1 }] }, cookie);
    expect(again.status).toBe(409);
  });

  test("a reward needs an account", async () => {
    const res = await placeOrder({ useReward: true, items: [{ menuItemId: item("Fries").id, quantity: 1 }] });
    expect(res.status).toBe(401);
  });
});

describe("booking", () => {
  test("availability lists slots, and booking takes a table", async () => {
    const date = bookableDate();
    const avail = (await (await call(`/v1/locations/passplate/availability?date=${date}&party=2`)).json()) as AvailabilityView;
    expect(avail.closed).toBe(false);
    expect(avail.slots[0]!.time).toBe("12:00");
    expect(avail.slots.every((s) => s.available)).toBe(true);

    const res = await call("/v1/reservations", {
      body: { locationSlug: "passplate", date, time: "19:00", party: 2, name: "Lee", phone: "07700 900456" },
    });
    expect(res.status).toBe(201);
    const r = (await res.json()) as ReservationView;
    expect(r.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(r.tableLabel).toBeTruthy();

    const looked = await (await call(`/v1/reservations/${r.code}`)).json();
    expect(looked.phone.endsWith("456")).toBe(true);
    expect(looked.phone).not.toContain("07700");
  });

  test("the only eight-seat table is booked once, even when five people try at the same moment", async () => {
    const date = bookableDate();
    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        call("/v1/reservations", {
          body: { locationSlug: "passplate", date, time: "20:00", party: 8, name: `Party ${i}`, phone: "07700 900111" },
        }),
      ),
    );
    const codes = attempts.map((a) => a.status).sort();
    expect(codes.filter((s) => s === 201)).toHaveLength(1);
    expect(codes.filter((s) => s === 409)).toHaveLength(4);

    const avail = (await (await call(`/v1/locations/passplate/availability?date=${date}&party=8`)).json()) as AvailabilityView;
    expect(avail.slots.find((s) => s.time === "20:00")!.available).toBe(false);
    // Two and a half hours later the table is free again.
    expect(avail.slots.find((s) => s.time === "22:30")?.available ?? true).toBe(true);
  });

  test("cancelling frees the slot", async () => {
    const date = bookableDate();
    const body = { locationSlug: "passplate", date, time: "20:00", party: 8, name: "Big", phone: "07700 900111" };
    const r = (await (await call("/v1/reservations", { body })).json()) as ReservationView;
    expect((await call("/v1/reservations", { body })).status).toBe(409);
    expect((await call(`/v1/reservations/${r.code}/cancel`, { method: "POST" })).status).toBe(200);
    expect((await call("/v1/reservations", { body })).status).toBe(201);
  });

  test("Mondays are closed and the past cannot be booked", async () => {
    const d = new Date(Date.now() + 3 * 86_400_000);
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    const monday = (await (await call(`/v1/locations/passplate/availability?date=${localDate("Europe/London", d)}&party=2`)).json()) as AvailabilityView;
    expect(monday.closed).toBe(true);
    const past = await call(`/v1/locations/passplate/availability?date=2020-01-01&party=2`);
    expect(past.status).toBe(422);
  });
});

describe("floor", () => {
  test("seat, order, settle, clear: the table walks through its states and the money is recorded", async () => {
    const staff = await signIn("staff");
    const floor = (await (await call("/v1/staff/floor", { cookie: staff })).json()) as FloorView;
    const table = floor.tables.find((t) => t.label === "Table 7")!;
    expect(table.status).toBe("free");

    const seated = await (await call("/v1/staff/floor/seat", { cookie: staff, body: { tableId: table.id, party: 3, name: "Walk-in" } })).json();
    expect(seated.status).toBe("seated");

    const token = seed.tables.find((t) => t.label === "Table 7")!.token;
    const t = (await (
      await placeOrder({ type: "dine_in", tableToken: token, items: [{ menuItemId: item("Fries").id, quantity: 2 }] })
    ).json()) as TicketView;
    expect(t.paid).toBe(false);
    let now = (await (await call("/v1/staff/floor", { cookie: staff })).json()) as FloorView;
    expect(now.tables.find((x) => x.id === table.id)!.status).toBe("ordered");

    await finish(t.id, "dine_in");
    now = (await (await call("/v1/staff/floor", { cookie: staff })).json()) as FloorView;
    const eating = now.tables.find((x) => x.id === table.id)!;
    expect(eating.status).toBe("eating");
    expect(eating.openMinor).toBe(900);

    expect((await call(`/v1/staff/floor/tables/${table.id}/clear`, { method: "POST", cookie: staff })).status).toBe(409);
    const settled = await (await call(`/v1/staff/floor/tables/${table.id}/settle`, { cookie: staff, body: { method: "card" } })).json();
    expect(settled.status).toBe("clearing");
    const cleared = await (await call(`/v1/staff/floor/tables/${table.id}/clear`, { method: "POST", cookie: staff })).json();
    expect(cleared.status).toBe("free");

    const admin = await signIn("admin");
    const tx = (await (await call("/v1/staff/admin/transactions", { cookie: admin })).json()) as TransactionsView;
    const mine = tx.transactions.find((x) => x.order.id === t.id)!;
    expect(mine.method).toBe("card");
    expect(mine.amountMinor).toBe(900);
    expect(mine.takenBy).toBe(DEMO_ACCOUNTS.staff.name);
  });

  test("a cancelled online order is refunded", async () => {
    const t = (await (await placeOrder({ items: [{ menuItemId: item("Fries").id, quantity: 1 }] })).json()) as TicketView;
    await app.request(`/v1/kitchen/${seed.locationId}/tickets/${t.id}/transition`, {
      method: "POST",
      headers: await kitchen(),
      body: JSON.stringify({ from: "received", to: "cancelled", actionId: crypto.randomUUID() }),
    });
    const rows = await db.select().from(payments).where(eq(payments.orderId, t.id));
    expect(rows.map((r) => r.kind).sort()).toEqual(["payment", "refund"]);
  });
});

describe("delivery", () => {
  const near = { line1: "1 Queen Square", postcode: "BS1 4LH", lat: 51.4512, lng: -2.5945 };

  test("too far away is refused; nearby pays the delivery fee", async () => {
    const steak = item("Flat iron steak");
    const items = [{ menuItemId: steak.id, quantity: 1, modifierIds: [steak.modifierGroups[0]!.modifiers[0]!.id] }];
    const far = await placeOrder({ type: "delivery", phone: "07700 900222", delivery: { ...near, lat: 51.5072, lng: -0.1276 }, items });
    expect(far.status).toBe(422);
    expect((await far.json()).error.code).toBe("out_of_range");

    const small = await placeOrder({ type: "delivery", phone: "07700 900222", delivery: near, items: [{ menuItemId: item("Fries").id, quantity: 1 }] });
    expect((await small.json()).error.code).toBe("below_minimum");

    const ok = await placeOrder({ type: "delivery", phone: "07700 900222", delivery: near, items });
    expect(ok.status).toBe(201);
    const t = (await ok.json()) as TicketView;
    expect(t.deliveryFeeMinor).toBe(250);
    expect(t.totalMinor).toBe(t.subtotalMinor + 250);
    expect(t.delivery?.postcode).toBe("BS1 4LH");
  });

  test("a driver takes it, shares where they are, and hands it over", async () => {
    const steak = item("Flat iron steak");
    const t = (await (
      await placeOrder({
        type: "delivery",
        phone: "07700 900222",
        delivery: near,
        items: [{ menuItemId: steak.id, quantity: 1, modifierIds: [steak.modifierGroups[0]!.modifiers[0]!.id] }],
      })
    ).json()) as TicketView;
    const headers = await kitchen();
    for (const [from, to] of [["received", "cooking"], ["cooking", "ready"]]) {
      await app.request(`/v1/kitchen/${seed.locationId}/tickets/${t.id}/transition`, {
        method: "POST",
        headers,
        body: JSON.stringify({ from, to, actionId: crypto.randomUUID() }),
      });
    }
    const driver = await signIn("driver");
    const board = await (await call("/v1/staff/driver", { cookie: driver })).json();
    expect(board.waiting.map((w: TicketView) => w.id)).toContain(t.id);

    expect((await call(`/v1/staff/driver/orders/${t.id}/take`, { method: "POST", cookie: driver })).status).toBe(200);
    expect((await call(`/v1/staff/driver/orders/${t.id}/take`, { method: "POST", cookie: driver })).status).toBe(409);
    const loc = await call(`/v1/staff/driver/orders/${t.id}/location`, { cookie: driver, body: { lat: 51.4505, lng: -2.595 } });
    expect(loc.status).toBe(200);
    const done = (await (await call(`/v1/staff/driver/orders/${t.id}/delivered`, { method: "POST", cookie: driver })).json()) as TicketView;
    expect(done.status).toBe("delivered");
    expect(done.delivery?.driverName).toBe(DEMO_ACCOUNTS.driver.name);

    const [row] = await db.select().from(orders).where(eq(orders.id, t.id));
    expect(row!.driverLat).toBeCloseTo(51.4505);
  });
});
