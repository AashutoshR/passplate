import { randomInt, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { localDate, sittingMinutes, zonedTime } from "@pass/shared";
import type { Db } from "./client";
import { diningTables, locations, menuItems, orderItems, orders, payments, reservations, rewards, waitlist } from "./schema";
import type { SeedResult } from "./seed";

/**
 * Two weeks of made-up trade for development: past orders with payments, the
 * demo guest one order away from a reward, tonight's bookings, a few tables
 * mid-service and people waiting at the door. Never run against real data.
 */
const GUESTS = ["Amara", "Tom", "Priya", "Jonah", "Mei", "Ola", "Hugo", "Isla", "Ravi", "Nell", "Kofi", "Ana", "Ben", "Zoe"];
const pick = <T>(xs: readonly T[]) => xs[randomInt(xs.length)]!;

export async function seedSampleActivity(db: Db, seed: SeedResult, now = new Date()): Promise<void> {
  const [loc] = await db.select().from(locations).where(eq(locations.id, seed.locationId));
  if (!loc) throw new Error("seed first");
  const items = (await db.select().from(menuItems).where(eq(menuItems.locationId, loc.id))).filter((i) => i.stock === null);
  const tables = await db.select().from(diningTables).where(eq(diningTables.locationId, loc.id));
  let number = 1;

  async function pastOrder(at: Date, type: "dine_in" | "pickup" | "delivery", opts: { userId?: string; name?: string; status?: "completed" | "delivered" | "cancelled" } = {}) {
    const lines = Array.from({ length: 1 + randomInt(4) }, () => ({ item: pick(items), qty: 1 + randomInt(2) }));
    const subtotal = lines.reduce((s, l) => s + l.item.priceMinor * l.qty, 0);
    const fee = type === "delivery" ? pick([250, 350, 495]) : 0;
    const status = opts.status ?? (type === "delivery" ? "delivered" : "completed");
    const table = type === "dine_in" ? pick(tables) : null;
    const [o] = await db
      .insert(orders)
      .values({
        tenantId: loc!.tenantId,
        locationId: loc!.id,
        number: number++,
        type,
        tableId: table?.id ?? null,
        customerName: opts.name ?? pick(GUESTS),
        userId: opts.userId ?? null,
        status,
        subtotalMinor: subtotal,
        deliveryFeeMinor: fee,
        totalMinor: subtotal + fee,
        paidAt: at,
        currency: loc!.currency,
        idempotencyKey: randomUUID(),
        requestHash: "sample",
        createdAt: at,
        updatedAt: at,
        ...(type === "delivery"
          ? {
              deliveryLine1: `${1 + randomInt(80)} ${pick(["Queen Square", "Prince Street", "Redcliff Hill", "Park Row", "Gloucester Road"])}`,
              deliveryPostcode: pick(["BS1 4LH", "BS1 6DB", "BS8 1RT", "BS7 8AT"]),
              deliveryLat: loc!.lat + (randomInt(400) - 200) / 10_000,
              deliveryLng: loc!.lng + (randomInt(400) - 200) / 10_000,
              phone: "07700 900000",
            }
          : {}),
      })
      .returning();
    await db.insert(orderItems).values(
      lines.map((l, position) => ({
        orderId: o!.id,
        menuItemId: l.item.id,
        name: l.item.name,
        quantity: l.qty,
        unitPriceMinor: l.item.priceMinor,
        lineTotalMinor: l.item.priceMinor * l.qty,
        position,
      })),
    );
    const method = type === "dine_in" ? pick(["card", "card", "card", "cash"] as const) : ("online" as const);
    await db.insert(payments).values({
      tenantId: loc!.tenantId,
      locationId: loc!.id,
      orderId: o!.id,
      method,
      amountMinor: subtotal + fee,
      createdAt: at,
      takenBy: type === "dine_in" ? seed.users.staff : null,
    });
    if (status === "cancelled") {
      await db.insert(payments).values({
        tenantId: loc!.tenantId,
        locationId: loc!.id,
        orderId: o!.id,
        kind: "refund",
        method,
        amountMinor: subtotal + fee,
        createdAt: new Date(at.getTime() + 10 * 60_000),
      });
    }
    return o!;
  }

  // Two weeks of trade, busier at weekends.
  for (let d = 14; d >= 1; d--) {
    const day = new Date(now.getTime() - d * 86_400_000);
    const weekday = day.getUTCDay();
    if (weekday === 1) continue;
    const count = (weekday === 5 || weekday === 6 ? 16 : 9) + randomInt(5);
    for (let i = 0; i < count; i++) {
      const at = zonedTime(localDate(loc.timezone, day), `${12 + randomInt(10)}:${String(randomInt(60)).padStart(2, "0")}`, loc.timezone);
      const type = pick(["dine_in", "dine_in", "dine_in", "pickup", "delivery"] as const);
      await pastOrder(at, type, i === 0 && d % 5 === 0 ? { status: "cancelled" } : {});
    }
  }

  // The demo guest: seven finished orders, so the next one earns the reward.
  for (let i = 0; i < 7; i++) {
    await pastOrder(new Date(now.getTime() - (20 - i * 2) * 86_400_000), "pickup", {
      userId: seed.users.customer,
      name: "Sam",
    });
  }

  // Tonight: bookings across the evening.
  const today = localDate(loc.timezone, now);
  // Bookings spread over the next few hours from whenever the seed runs, so the
  // floor always has guests on their way.
  const quarter = 15 * 60_000;
  const base = Math.ceil(now.getTime() / quarter) * quarter;
  const bookings: [string, number, number][] = [
    ["Okafor", 2, 1], ["Lindqvist", 4, 2], ["Haddad", 6, 3], ["Brennan", 2, 5],
    ["Novak", 8, 6], ["Ito", 4, 8], ["Mensah", 2, 10], ["Costa", 3, 12],
  ];
  void today;
  const used = new Set<string>();
  for (const [name, party, quarters] of bookings) {
    const start = new Date(base + quarters * quarter);
    const table = tables
      .filter((t) => t.seats >= party && t.seats <= party + 2 && t.shape !== "stool" && !used.has(t.id))
      .sort((a, b) => a.seats - b.seats)[0];
    if (!table) continue;
    used.add(table.id);
    await db.insert(reservations).values({
      locationId: loc.id,
      tableId: table.id,
      code: Array.from({ length: 6 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[randomInt(31)]).join(""),
      name,
      phone: "07700 900" + String(100 + randomInt(800)),
      partySize: party,
      startsAt: start,
      endsAt: new Date(start.getTime() + sittingMinutes(party) * 60_000),
      source: pick(["online", "online", "phone"] as const),
      notes: name === "Haddad" ? "Birthday, a candle on dessert please" : null,
    });
  }

  // Mid-service: one table eating, one just sat down, one waiting to be reset.
  const free = tables.filter((t) => !used.has(t.id) && t.shape !== "stool");
  const [eating, sat, clearing] = [free[0], free[1], free[2]];
  if (eating) {
    await db.update(diningTables).set({ state: "seated", seatedAt: new Date(now.getTime() - 50 * 60_000), seatedParty: 3, seatedName: "Walk-in" }).where(eq(diningTables.id, eating.id));
    const o = await pastOrder(new Date(now.getTime() - 40 * 60_000), "dine_in", { name: "Walk-in" });
    await db.update(orders).set({ tableId: eating.id, paidAt: null }).where(eq(orders.id, o.id));
    await db.delete(payments).where(eq(payments.orderId, o.id));
  }
  if (sat) {
    await db.update(diningTables).set({ state: "seated", seatedAt: new Date(now.getTime() - 5 * 60_000), seatedParty: 2, seatedName: "Ellis" }).where(eq(diningTables.id, sat.id));
  }
  if (clearing) await db.update(diningTables).set({ state: "clearing" }).where(eq(diningTables.id, clearing.id));

  await db.insert(waitlist).values([
    { locationId: loc.id, name: "Garcia", partySize: 2, phone: "07700 900321", quotedMinutes: 15, createdAt: new Date(now.getTime() - 8 * 60_000) },
    { locationId: loc.id, name: "Walsh", partySize: 4, quotedMinutes: 25, createdAt: new Date(now.getTime() - 3 * 60_000) },
  ]);
  // New orders carry on numbering after the sample ones.
  await db.update(locations).set({ nextOrderNumber: number }).where(eq(locations.id, loc.id));
  void rewards;
}
