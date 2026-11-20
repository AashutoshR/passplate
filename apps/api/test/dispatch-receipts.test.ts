import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { DEMO_ACCOUNTS, createDb, issuePendingReceipts, orders, outbox, payments, receipts, seedDemo, type DemoAccount } from "@pass/db";
import {
  decodePolyline,
  encodePolyline,
  vatIncluded,
  type DayReportView,
  type DispatchView,
  type MenuView,
  type ReceiptView,
  type TicketView,
  type TransactionsView,
} from "@pass/shared";
import { createApp } from "../src/app";
import { googleRoutes, straightRoutes, type RoutesProvider } from "../src/services/maps";
import { testDatabaseUrl } from "./containers";

/**
 * Receipts (written by the worker, NFR-22), the dispatch map (FR-14, FR-15),
 * proof of delivery and the 200 m arrival alert (FR-16, FR-18), and road
 * routes from Google with the straight-line fallback (FR-20, NFR-19 to 21).
 */

const TEST_URL = await testDatabaseUrl();
const { db, sql: pg } = createDb({ url: TEST_URL, max: 20, appName: "pass-test-dispatch" });

// A Google Routes stand-in: a fixed road route, and a count of calls.
const road = [
  { lat: 51.4497, lng: -2.5966 },
  { lat: 51.4505, lng: -2.5958 },
  { lat: 51.4512, lng: -2.5945 },
];
let routeCalls = 0;
const fakeGoogle: RoutesProvider = {
  name: "google",
  route: async () => {
    routeCalls++;
    return { provider: "google", polyline: encodePolyline(road), distanceM: 1400, durationS: 420 };
  },
};
const app = createApp({ db, log: false, routes: fakeGoogle });

let seed: Awaited<ReturnType<typeof seedDemo>>;
let menu: MenuView;
beforeEach(async () => {
  seed = await seedDemo(db);
  menu = await (await app.request(`/v1/locations/${seed.locationSlug}/menu`)).json();
  routeCalls = 0;
});
afterAll(async () => {
  await pg.end();
});

const item = (name: string) => {
  for (const c of menu.categories) for (const i of c.items) if (i.name === name) return i;
  throw new Error(`No item ${name}`);
};

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
async function json<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  const body = await r.json();
  if (r.status !== status) throw new Error(`Expected ${status}, got ${r.status}: ${JSON.stringify(body)}`);
  return body as T;
}
async function signIn(who: DemoAccount): Promise<string> {
  const a = DEMO_ACCOUNTS[who];
  const res = await call("/v1/account/login", { body: { email: a.email, password: a.password } });
  expect(res.status).toBe(200);
  return res.headers.get("Set-Cookie")!.split(";")[0]!;
}

const home = { line1: "1 Queen Square", postcode: "BS1 4LH", lat: 51.4512, lng: -2.5945 };
async function paidDelivery(name = "Ravi"): Promise<TicketView> {
  const steak = item("Flat iron steak");
  const t = await json<TicketView>(
    call("/v1/orders", {
      key: crypto.randomUUID(),
      body: {
        locationSlug: seed.locationSlug,
        type: "delivery",
        customerName: name,
        phone: "07700 900222",
        delivery: home,
        items: [{ menuItemId: steak.id, quantity: 1, modifierIds: [steak.modifierGroups[0]!.modifiers[0]!.id] }],
      },
    }),
    201,
  );
  await json(call(`/v1/orders/${t.id}/payment/test`, { body: { outcome: "succeeded" } }));
  return t;
}
async function cook(orderId: string) {
  const kitchen = await signIn("kitchen");
  for (const [from, to] of [
    ["received", "cooking"],
    ["cooking", "ready"],
  ]) {
    await json(call(`/v1/kitchen/${seed.locationId}/tickets/${orderId}/transition`, { cookie: kitchen, body: { from, to, actionId: crypto.randomUUID() } }));
  }
}
const userId = async (cookie: string) => (await json<{ user: { id: string } }>(call("/v1/account/me", { cookie }))).user.id;

describe("receipts (NFR-22)", () => {
  test("written by the worker after payment, never inside the request; one per payment, once", async () => {
    const t = await paidDelivery();
    // The request that took the money wrote no receipt.
    const pending = await call(`/v1/orders/${t.id}/receipt`);
    expect(pending.status).toBe(404);
    expect((await pending.json()).error.code).toBe("receipt_pending");

    expect(await issuePendingReceipts(db)).toBe(1);
    expect(await issuePendingReceipts(db)).toBe(0);

    const r = await json<ReceiptView>(call(`/v1/orders/${t.id}/receipt`));
    expect(r.number).toBe(1);
    expect(r.kind).toBe("sale");
    expect(r.body.totalMinor).toBe(t.totalMinor);
    expect(r.body.deliveryFeeMinor).toBe(t.deliveryFeeMinor);
    expect(r.body.restaurant.vatNumber).toBeTruthy();
    expect(r.body.restaurant.address.length).toBeGreaterThan(0);
    // 20% VAT inside a VAT-inclusive total.
    expect(r.body.vat.vatMinor + r.body.vat.netMinor).toBe(t.totalMinor);
    expect(r.body.vat.vatMinor).toBe(Math.round((t.totalMinor * 2000) / 12000));
    expect(r.body.lines[0]!.modifiers.length).toBe(1);

    // The order now points at it, and the guest's page was told.
    const order = await json<{ ticket: TicketView }>(call(`/v1/orders/${t.id}`));
    expect(order.ticket.receipt).toEqual({ id: r.id, number: 1 });
    const told = (await db.select().from(outbox)).filter((e) => e.type === "receipt.issued");
    expect(told.map((e) => e.channel).sort()).toEqual([`admin:${seed.locationId}`, `order:${t.id}`].sort());
  });

  test("a table settled at once gets one receipt for every round", async () => {
    const staff = await signIn("staff");
    const floor = await json<{ tables: { id: string; label: string }[] }>(call("/v1/staff/floor", { cookie: staff }));
    const table = floor.tables.find((x) => x.label === "Table 7")!;
    await json(call("/v1/staff/floor/seat", { cookie: staff, body: { tableId: table.id, party: 2 } }));
    const token = seed.tables.find((x) => x.label === "Table 7")!.token;
    const rounds: TicketView[] = [];
    for (const dish of ["Fries", "Sparkling water"]) {
      rounds.push(
        await json<TicketView>(
          call("/v1/orders", {
            key: crypto.randomUUID(),
            body: { locationSlug: seed.locationSlug, type: "dine_in", tableToken: token, customerName: "Walk-in", items: [{ menuItemId: item(dish).id, quantity: 1 }] },
          }),
          201,
        ),
      );
    }
    const settled = await json<{ settledOrderId: string | null }>(call(`/v1/staff/floor/tables/${table.id}/settle`, { cookie: staff, body: { method: "cash" } }));
    expect(rounds.map((r) => r.id)).toContain(settled.settledOrderId!);
    expect(await issuePendingReceipts(db)).toBe(1);

    const r = await json<ReceiptView>(call(`/v1/staff/receipts/order/${rounds[1]!.id}`, { cookie: staff }));
    expect(r.orderIds.sort()).toEqual(rounds.map((x) => x.id).sort());
    expect(r.body.service.orderNumbers).toEqual(rounds.map((x) => x.number));
    expect(r.body.lines.map((l) => l.name)).toEqual(["Fries", "Sparkling water"]);
    expect(r.body.payment.method).toBe("cash");
    expect(r.body.payment.takenBy).toBe(DEMO_ACCOUNTS.staff.name);
    expect(r.body.totalMinor).toBe(rounds[0]!.totalMinor + rounds[1]!.totalMinor);

    // Printing: the first is the original, every later one says Copy.
    const first = await json<{ copy: boolean; receipt: ReceiptView }>(call(`/v1/staff/receipts/${r.id}/printed`, { method: "POST", cookie: staff }));
    const second = await json<{ copy: boolean; receipt: ReceiptView }>(call(`/v1/staff/receipts/${r.id}/printed`, { method: "POST", cookie: staff }));
    expect([first.copy, second.copy]).toEqual([false, true]);
    expect(second.receipt.printedCount).toBe(2);
  });

  test("a refund gets its own receipt pointing back at the sale", async () => {
    const t = await paidDelivery();
    await issuePendingReceipts(db);
    const sale = await json<ReceiptView>(call(`/v1/orders/${t.id}/receipt`));
    const admin = await signIn("admin");
    await json(call(`/v1/staff/admin/orders/${t.id}/refund`, { method: "POST", cookie: admin }));
    expect(await issuePendingReceipts(db)).toBe(1);
    const refund = await json<ReceiptView>(call(`/v1/orders/${t.id}/receipt`));
    expect(refund.kind).toBe("refund");
    expect(refund.number).toBe(sale.number + 1);
    expect(refund.body.refundOf).toEqual({ id: sale.id, number: sale.number });

    // The transactions list links both, and the day's report nets them out.
    const tx = await json<TransactionsView>(call("/v1/staff/admin/transactions", { cookie: admin }));
    expect(tx.transactions.map((x) => x.receipt?.number).sort()).toEqual([sale.number, refund.number].sort());
    const day = await json<DayReportView>(call("/v1/staff/receipts/day", { cookie: admin }));
    expect(day.receipts.count).toBe(2);
    expect(day.sales.grossMinor).toBe(t.totalMinor);
    expect(day.refunds.amountMinor).toBe(t.totalMinor);
    expect(day.netMinor).toBe(0);
  });

  test("numbers stay gap-free with several workers writing at once", async () => {
    const orders: TicketView[] = [];
    for (let i = 0; i < 12; i++) orders.push(await paidDelivery(`Guest ${i}`));
    const issued = await Promise.all([issuePendingReceipts(db), issuePendingReceipts(db), issuePendingReceipts(db), issuePendingReceipts(db)]);
    expect(issued.reduce((a, b) => a + b, 0)).toBe(12);
    const rows = await db.select({ n: receipts.number }).from(receipts);
    expect(rows.map((r) => r.n).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect((await db.select().from(payments)).every((p) => p.receiptId)).toBe(true);
  }, 30_000);

  test("staff find a receipt by its number, the order number or the name", async () => {
    const t = await paidDelivery("Priya Natarajan");
    await issuePendingReceipts(db);
    const staff = await signIn("staff");
    type Hits = { hits: { number: number; customerName: string }[] };
    for (const q of ["R-000001", "1", `#${t.number}`, "natara"]) {
      const res = await json<Hits>(call(`/v1/staff/receipts?q=${encodeURIComponent(q)}`, { cookie: staff }));
      expect(res.hits.map((h) => h.customerName)).toContain("Priya Natarajan");
    }
    expect((await json<Hits>(call(`/v1/staff/receipts?q=nobody`, { cookie: staff }))).hits).toHaveLength(0);
    // Guests and drivers cannot browse receipts.
    expect((await call(`/v1/staff/receipts`, { cookie: await signIn("driver") })).status).toBe(403);
    expect((await call(`/v1/staff/receipts/day`, { cookie: staff })).status).toBe(403);
  });

  test("unpaid orders have no receipt", async () => {
    const t = await json<TicketView>(
      call("/v1/orders", {
        key: crypto.randomUUID(),
        body: { locationSlug: seed.locationSlug, type: "pickup", customerName: "Sam", items: [{ menuItemId: item("Fries").id, quantity: 1 }] },
      }),
      201,
    );
    const res = await call(`/v1/orders/${t.id}/receipt`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_paid");
  });
});

describe("dispatch (FR-14 to FR-18)", () => {
  test("assign to a driver on shift; only they can collect; the route is fetched once", async () => {
    const t = await paidDelivery();
    const floor = await signIn("staff");
    const dee = await signIn("driver");
    const tom = await signIn("driver2");
    const deeId = await userId(dee);

    // Nobody on shift yet: nobody to give it to.
    expect((await call(`/v1/staff/dispatch/orders/${t.id}/assign`, { cookie: floor, body: { driverId: deeId } })).status).toBe(409);
    await json(call("/v1/staff/driver/shift", { cookie: dee, body: { on: true } }));
    await json(call("/v1/staff/driver/shift", { cookie: tom, body: { on: true } }));

    let board = await json<DispatchView>(call("/v1/staff/dispatch", { cookie: floor }));
    expect(board.waiting.map((w) => w.id)).toEqual([t.id]);
    expect(board.suggested).toHaveLength(2);
    expect(board.drivers.filter((d) => d.onShift)).toHaveLength(2);

    const assigned = await json<TicketView>(call(`/v1/staff/dispatch/orders/${t.id}/assign`, { cookie: floor, body: { driverId: deeId } }));
    expect(assigned.delivery?.driverId).toBe(deeId);
    expect(assigned.delivery?.assignedAt).toBeTruthy();
    // Once Dee has one waiting, the other driver is suggested first.
    board = await json<DispatchView>(call("/v1/staff/dispatch", { cookie: floor }));
    expect(board.suggested[0]).toBe(await userId(tom));

    // It shows on Dee's phone as hers, and not on Tom's.
    const deeBoard = await json<{ waiting: TicketView[] }>(call("/v1/staff/driver", { cookie: dee }));
    const tomBoard = await json<{ waiting: TicketView[] }>(call("/v1/staff/driver", { cookie: tom }));
    expect(deeBoard.waiting.map((w) => w.id)).toContain(t.id);
    expect(tomBoard.waiting.map((w) => w.id)).not.toContain(t.id);

    await cook(t.id);
    const grab = await call(`/v1/staff/driver/orders/${t.id}/take`, { method: "POST", cookie: tom });
    expect(grab.status).toBe(409);
    expect((await grab.json()).error.code).toBe("assigned_elsewhere");

    const out = await json<TicketView>(call(`/v1/staff/driver/orders/${t.id}/take`, { method: "POST", cookie: dee }));
    expect(out.status).toBe("out_for_delivery");
    expect(out.delivery?.pickedUpAt).toBeTruthy();
    expect(out.delivery?.route).toEqual({ provider: "google", polyline: encodePolyline(road), distanceM: 1400, durationS: 420 });
    expect(decodePolyline(out.delivery!.route!.polyline!)).toEqual(road);
    expect(out.delivery?.etaAt).toBeTruthy();
    expect(routeCalls).toBe(1);

    // Positions do not ask for the route again (NFR-20).
    await json(call(`/v1/staff/driver/orders/${t.id}/location`, { cookie: dee, body: { lat: 51.4501, lng: -2.5962 } }));
    await json(call(`/v1/staff/driver/orders/${t.id}/location`, { cookie: dee, body: { lat: 51.4503, lng: -2.596 } }));
    expect(routeCalls).toBe(1);

    // Going off shift in the middle of a delivery is refused.
    expect((await call("/v1/staff/driver/shift", { cookie: dee, body: { on: false } })).status).toBe(409);
  });

  test("within 200 m the guest is told once; delivered with proof; the dispatch board keeps it for the day", async () => {
    const t = await paidDelivery();
    const dee = await signIn("driver");
    await json(call("/v1/staff/driver/shift", { cookie: dee, body: { on: true } }));
    await cook(t.id);
    await json(call(`/v1/staff/driver/orders/${t.id}/take`, { method: "POST", cookie: dee }));

    const far = await json<{ arriving: boolean; etaAt: string }>(call(`/v1/staff/driver/orders/${t.id}/location`, { cookie: dee, body: { lat: 51.4497, lng: -2.5966 } }));
    expect(far.arriving).toBe(false);
    // About 120 m from the door.
    const near = await json<{ arriving: boolean }>(call(`/v1/staff/driver/orders/${t.id}/location`, { cookie: dee, body: { lat: 51.4503, lng: -2.5955 } }));
    expect(near.arriving).toBe(true);
    await json(call(`/v1/staff/driver/orders/${t.id}/location`, { cookie: dee, body: { lat: 51.4508, lng: -2.595 } }));
    const told = (await db.select().from(outbox)).filter((e) => e.channel === `order:${t.id}` && e.type === "order.updated");
    const arrivedNotices = told.filter((e) => (e.payload as TicketView).delivery?.arrivingAt);
    expect(arrivedNotices.length).toBeGreaterThanOrEqual(1);
    const [row] = await db.select({ arrivingAt: orders.arrivingAt }).from(orders).where(eq(orders.id, t.id));
    expect(row!.arrivingAt).toBeTruthy();
    // The dispatch map hears every position; drivers' own channel does not.
    const positions = (await db.select().from(outbox)).filter((e) => e.type === "driver.location");
    expect(positions.every((e) => e.channel === `dispatch:${seed.locationId}`)).toBe(true);
    expect(positions).toHaveLength(3);

    const bad = await call(`/v1/staff/driver/orders/${t.id}/delivered`, { cookie: dee, body: { proof: "thrown_over_fence" } });
    expect(bad.status).toBe(400);
    const done = await json<TicketView>(
      call(`/v1/staff/driver/orders/${t.id}/delivered`, { cookie: dee, body: { proof: "safe_place", note: "Behind the blue gate", lat: home.lat, lng: home.lng } }),
    );
    expect(done.status).toBe("delivered");
    expect(done.delivery?.deliveredAt).toBeTruthy();
    expect(done.delivery?.proof).toEqual({ kind: "safe_place", note: "Behind the blue gate", lat: home.lat, lng: home.lng, distanceM: 0 });

    const floor = await signIn("staff");
    const board = await json<DispatchView>(call("/v1/staff/dispatch", { cookie: floor }));
    expect(board.delivered.map((d) => d.id)).toEqual([t.id]);
    expect(board.onTheRoad).toHaveLength(0);
    const me = board.drivers.find((d) => d.name === DEMO_ACCOUNTS.driver.name)!;
    expect(me.deliveredToday).toBe(1);
    // An idle driver's position is where they dropped off: nobody is tracked between jobs.
    expect(me.position).toMatchObject({ lat: home.lat, lng: home.lng });
  });

  test("going off shift hands back deliveries assigned but not collected", async () => {
    const t = await paidDelivery();
    const floor = await signIn("staff");
    const dee = await signIn("driver");
    await json(call("/v1/staff/driver/shift", { cookie: dee, body: { on: true } }));
    await json(call(`/v1/staff/dispatch/orders/${t.id}/assign`, { cookie: floor, body: { driverId: await userId(dee) } }));
    await json(call("/v1/staff/driver/shift", { cookie: dee, body: { on: false } }));
    const [row] = await db.select({ driverId: orders.driverId }).from(orders).where(eq(orders.id, t.id));
    expect(row!.driverId).toBeNull();
  });

  test("only front of house and admins see the dispatch map", async () => {
    expect((await call("/v1/staff/dispatch", { cookie: await signIn("driver") })).status).toBe(403);
    expect((await call("/v1/staff/dispatch", { cookie: await signIn("customer") })).status).toBe(403);
    expect((await call("/v1/staff/dispatch")).status).toBe(401);
  });
});

describe("Google routes with fallback (FR-20, NFR-19 to NFR-21)", () => {
  const from = { lat: 51.4497, lng: -2.5966 };
  const to = { lat: 51.4628, lng: -2.611 };

  test("asks for only the fields it uses, and reads the answer", async () => {
    let sent: { headers: Record<string, string>; body: unknown } | null = null;
    const g = googleRoutes({
      apiKey: "test-key",
      fetch: (async (_url: string, init: RequestInit) => {
        sent = { headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
        return Response.json({ routes: [{ distanceMeters: 2300, duration: "540s", polyline: { encodedPolyline: encodePolyline([from, to]) } }] });
      }) as unknown as typeof fetch,
    });
    const plan = await g.route(from, to);
    expect(plan).toEqual({ provider: "google", polyline: encodePolyline([from, to]), distanceM: 2300, durationS: 540 });
    expect(sent!.headers["X-Goog-FieldMask"]).toBe("routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline");
    expect(sent!.headers["X-Goog-Api-Key"]).toBe("test-key");
  });

  test("a refused key or an outage falls back to a straight line; five failures open the breaker", async () => {
    let calls = 0;
    const g = googleRoutes({
      apiKey: "bad",
      fetch: (async () => {
        calls++;
        return new Response(JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
      }) as unknown as typeof fetch,
    });
    const straight = await straightRoutes.route(from, to);
    for (let i = 0; i < 5; i++) expect(await g.route(from, to)).toEqual(straight);
    // Three tries each (with jitter) until the breaker opened.
    expect(calls).toBe(15);
    expect(g.breakerOpen()).toBe(true);
    expect(await g.route(from, to)).toEqual(straight);
    expect(calls).toBe(15);

    // A 403 (key refused) is not retried.
    let refused = 0;
    const r = googleRoutes({ apiKey: "bad", fetch: (async () => {
        refused++;
        return new Response("denied", { status: 403 });
      }) as unknown as typeof fetch });
    expect((await r.route(from, to)).provider).toBe("straight");
    expect(refused).toBe(1);
  });

  test("VAT is worked out inside the price", () => {
    expect(vatIncluded(1200, 2000)).toEqual({ netMinor: 1000, vatMinor: 200 });
    expect(vatIncluded(999, 2000)).toEqual({ netMinor: 832, vatMinor: 167 });
  });
});
