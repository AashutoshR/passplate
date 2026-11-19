import { and, asc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { diningTables, locations, orders, reservations, waitlist, type Db, type Executor, type Tx } from "@pass/db";
import {
  ACTIVE_STATUSES,
  channels,
  localDate,
  type FloorView,
  type TableStatus,
  type TableView,
  type WaitlistEntryView,
} from "@pass/shared";
import { AppError } from "../errors";
import { enqueue, type OutboxEvent } from "../outbox";
import { currentSeq } from "../views";
import { reservationsForDay, reservationView } from "./booking";
import { recordPayment } from "./payments";

type Location = typeof locations.$inferSelect;

/** A booking this close counts as "reserved" on the plan. */
export const RESERVED_WINDOW_MS = 60 * 60_000;

/**
 * Works out what each table is doing right now. Staff only ever set
 * seated and clearing by hand; everything else follows bookings and orders.
 */
export async function tableViews(db: Executor, loc: Location, ids?: string[], now = new Date()): Promise<TableView[]> {
  const tables = await db
    .select()
    .from(diningTables)
    .where(ids ? and(eq(diningTables.locationId, loc.id), inArray(diningTables.id, ids)) : eq(diningTables.locationId, loc.id));
  if (tables.length === 0) return [];
  const tableIds = tables.map((t) => t.id);

  const open = await db
    .select({ tableId: orders.tableId, status: orders.status, totalMinor: orders.totalMinor })
    .from(orders)
    .where(
      and(
        inArray(orders.tableId, tableIds),
        eq(orders.type, "dine_in"),
        isNull(orders.paidAt),
        ne(orders.status, "cancelled"),
      ),
    );
  const upcoming = await db
    .select()
    .from(reservations)
    .where(
      and(
        inArray(reservations.tableId, tableIds),
        eq(reservations.status, "booked"),
        gt(reservations.endsAt, now),
        // Today only: the plan is for tonight's service.
        gt(reservations.startsAt, new Date(now.getTime() - 3 * 3_600_000)),
      ),
    )
    .orderBy(asc(reservations.startsAt));
  const today = localDate(loc.timezone, now);

  return tables
    .sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }))
    .map((t) => {
      const mine = open.filter((o) => o.tableId === t.id);
      const active = mine.filter((o) => ACTIVE_STATUSES.includes(o.status)).length;
      const openMinor = mine.reduce((s, o) => s + o.totalMinor, 0);
      const next = upcoming.find((r) => r.tableId === t.id && localDate(loc.timezone, r.startsAt) === today);

      let status: TableStatus;
      if (t.state === "clearing") status = "clearing";
      else if (active > 0) status = "ordered";
      else if (mine.length > 0) status = "eating";
      else if (t.state === "seated") status = "seated";
      else if (next && next.startsAt.getTime() - now.getTime() <= RESERVED_WINDOW_MS) status = "reserved";
      else status = "free";

      return {
        id: t.id,
        label: t.label,
        seats: t.seats,
        area: t.area,
        shape: t.shape,
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
        status,
        party: t.seatedParty,
        guestName: t.seatedName,
        seatedAt: t.seatedAt?.toISOString() ?? null,
        next: next
          ? { id: next.id, name: next.name, party: next.partySize, startsAt: next.startsAt.toISOString(), code: next.code }
          : null,
        openMinor,
        activeOrders: active,
      };
    });
}

export async function waitlistViews(db: Executor, locationId: string): Promise<WaitlistEntryView[]> {
  const rows = await db
    .select()
    .from(waitlist)
    .where(and(eq(waitlist.locationId, locationId), eq(waitlist.status, "waiting")))
    .orderBy(asc(waitlist.createdAt));
  return rows.map((w) => ({
    id: w.id,
    name: w.name,
    party: w.partySize,
    phone: w.phone,
    quotedMinutes: w.quotedMinutes,
    createdAt: w.createdAt.toISOString(),
  }));
}

export async function floorSnapshot(db: Db, loc: Location, now = new Date()): Promise<FloorView> {
  return db.transaction(
    async (tx) => {
      const seq = await currentSeq(tx);
      return {
        location: { id: loc.id, slug: loc.slug, name: loc.name, currency: loc.currency, timezone: loc.timezone },
        tables: await tableViews(tx, loc, undefined, now),
        waitlist: await waitlistViews(tx, loc.id),
        reservations: await reservationsForDay(tx, loc, localDate(loc.timezone, now)),
        seq,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Floor events for some tables, to enqueue in the caller's transaction. */
export async function tableEvents(tx: Executor, loc: Location, ids: (string | null | undefined)[]): Promise<OutboxEvent[]> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return [];
  const views = await tableViews(tx, loc, wanted);
  return views.map((v) => ({ channel: channels.floor(loc.id), type: "floor.table" as const, payload: v }));
}

async function lockTable(tx: Tx, loc: Location, tableId: string) {
  const [t] = await tx
    .select()
    .from(diningTables)
    .where(and(eq(diningTables.id, tableId), eq(diningTables.locationId, loc.id)))
    .for("update");
  if (!t) throw new AppError(404, "table_not_found", "No such table");
  return t;
}

async function waitlistEvent(tx: Executor, loc: Location): Promise<OutboxEvent> {
  return { channel: channels.floor(loc.id), type: "floor.waitlist", payload: await waitlistViews(tx, loc.id) };
}

/** Seats a party: a walk-in, someone from the waitlist, or a booking that has arrived. */
export async function seatTable(
  db: Db,
  loc: Location,
  input: { tableId: string; party: number; name?: string; waitlistId?: string; reservationId?: string },
): Promise<TableView> {
  return db.transaction(async (tx) => {
    const t = await lockTable(tx, loc, input.tableId);
    if (t.state !== "free") throw new AppError(409, "table_busy", `${t.label} is not free`);
    const events: OutboxEvent[] = [];
    let name = input.name?.trim() || null;
    let reservationId: string | null = null;

    if (input.reservationId) {
      const [r] = await tx
        .update(reservations)
        .set({ status: "seated", tableId: t.id, updatedAt: new Date() })
        .where(and(eq(reservations.id, input.reservationId), eq(reservations.locationId, loc.id), eq(reservations.status, "booked")))
        .returning();
      if (!r) throw new AppError(409, "not_live", "That booking is no longer waiting");
      name = r.name;
      reservationId = r.id;
      events.push({
        channel: channels.floor(loc.id),
        type: "floor.reservation",
        payload: reservationView(r, t.label),
      });
    }
    if (input.waitlistId) {
      const [w] = await tx
        .update(waitlist)
        .set({ status: "seated", tableId: t.id, seatedAt: new Date() })
        .where(and(eq(waitlist.id, input.waitlistId), eq(waitlist.locationId, loc.id), eq(waitlist.status, "waiting")))
        .returning();
      if (!w) throw new AppError(409, "not_waiting", "That party is no longer on the list");
      name = w.name;
      events.push(await waitlistEvent(tx, loc));
    }

    await tx
      .update(diningTables)
      .set({ state: "seated", seatedAt: new Date(), seatedParty: input.party, seatedName: name, reservationId })
      .where(eq(diningTables.id, t.id));
    events.push(...(await tableEvents(tx, loc, [t.id])));
    events.push({ channel: channels.availability(loc.id), type: "availability.changed", payload: { date: localDate(loc.timezone) } });
    await enqueue(tx, loc.tenantId, events);
    return (await tableViews(tx, loc, [t.id]))[0]!;
  });
}

/** Takes payment for everything unpaid on the table, then marks it for clearing. */
export async function settleTable(
  db: Db,
  loc: Location,
  tableId: string,
  method: "card" | "cash",
  takenBy: string,
): Promise<TableView> {
  return db.transaction(async (tx) => {
    const t = await lockTable(tx, loc, tableId);
    const unpaid = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.tableId, t.id), eq(orders.type, "dine_in"), isNull(orders.paidAt), ne(orders.status, "cancelled")))
      .for("update");
    if (unpaid.length === 0 && t.state !== "seated") throw new AppError(409, "nothing_to_pay", "There is nothing to pay on this table");
    const events: OutboxEvent[] = [];
    for (const o of unpaid) events.push(...(await recordPayment(tx, loc, o, method, takenBy)));
    if (t.reservationId) {
      await tx
        .update(reservations)
        .set({ status: "completed", updatedAt: new Date() })
        .where(and(eq(reservations.id, t.reservationId), eq(reservations.status, "seated")));
    }
    await tx.update(diningTables).set({ state: "clearing" }).where(eq(diningTables.id, t.id));
    events.push(...(await tableEvents(tx, loc, [t.id])));
    await enqueue(tx, loc.tenantId, events);
    return (await tableViews(tx, loc, [t.id]))[0]!;
  });
}

/** The table is reset and ready for the next guests. */
export async function clearTable(db: Db, loc: Location, tableId: string): Promise<TableView> {
  return db.transaction(async (tx) => {
    const t = await lockTable(tx, loc, tableId);
    const unpaid = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.tableId, t.id), eq(orders.type, "dine_in"), isNull(orders.paidAt), ne(orders.status, "cancelled")));
    if (unpaid.length > 0) throw new AppError(409, "unpaid", "Settle the bill before clearing this table");
    if (t.reservationId) {
      await tx
        .update(reservations)
        .set({ status: "completed", updatedAt: new Date() })
        .where(and(eq(reservations.id, t.reservationId), eq(reservations.status, "seated")));
    }
    await tx
      .update(diningTables)
      .set({ state: "free", seatedAt: null, seatedParty: null, seatedName: null, reservationId: null })
      .where(eq(diningTables.id, t.id));
    const events = await tableEvents(tx, loc, [t.id]);
    events.push({ channel: channels.availability(loc.id), type: "availability.changed", payload: { date: localDate(loc.timezone) } });
    await enqueue(tx, loc.tenantId, events);
    return (await tableViews(tx, loc, [t.id]))[0]!;
  });
}

export async function addToWaitlist(
  db: Db,
  loc: Location,
  input: { name: string; party: number; phone?: string; quotedMinutes: number },
): Promise<WaitlistEntryView[]> {
  return db.transaction(async (tx) => {
    await tx.insert(waitlist).values({
      locationId: loc.id,
      name: input.name,
      partySize: input.party,
      phone: input.phone || null,
      quotedMinutes: input.quotedMinutes,
    });
    const ev = await waitlistEvent(tx, loc);
    await enqueue(tx, loc.tenantId, [ev]);
    return ev.payload as WaitlistEntryView[];
  });
}

export async function leaveWaitlist(db: Db, loc: Location, id: string): Promise<WaitlistEntryView[]> {
  return db.transaction(async (tx) => {
    await tx
      .update(waitlist)
      .set({ status: "left" })
      .where(and(eq(waitlist.id, id), eq(waitlist.locationId, loc.id), eq(waitlist.status, "waiting")));
    const ev = await waitlistEvent(tx, loc);
    await enqueue(tx, loc.tenantId, [ev]);
    return ev.payload as WaitlistEntryView[];
  });
}
