import { randomInt } from "node:crypto";
import { and, asc, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { diningTables, locations, reservations, type Db, type Executor } from "@pass/db";
import {
  BOOK_DAYS_AHEAD,
  channels,
  localDate,
  sittingMinutes,
  slotTimes,
  zonedTime,
  type AvailabilityView,
  type BookTableInput,
  type ReservationView,
} from "@pass/shared";
import { AppError } from "../errors";
import { enqueue } from "../outbox";
import { currentSeq } from "../views";
import { tableViews } from "./floor";

type Location = typeof locations.$inferSelect;
type Table = typeof diningTables.$inferSelect;
type Reservation = typeof reservations.$inferSelect;

const LIVE = ["booked", "seated"] as const;
/** Guests cannot book a slot that starts sooner than this. */
const LEAD_MINUTES = 30;

export function reservationView(r: Reservation, tableLabel: string | null): ReservationView {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    phone: r.phone,
    email: r.email,
    party: r.partySize,
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    status: r.status,
    tableLabel,
    tableId: r.tableId,
    notes: r.notes,
    source: r.source,
  };
}

/** Tables that suit a party, best fit first. Stools are for two at most; nobody gets an eight-top for two. */
export function candidateTables(tables: Table[], party: number): Table[] {
  const fits = tables.filter((t) => t.seats >= party && !(t.shape === "stool" && party > 2));
  const snug = fits.filter((t) => t.seats <= party + 2);
  return (snug.length ? snug : fits).sort((a, b) => a.seats - b.seats || a.label.localeCompare(b.label, "en", { numeric: true }));
}

interface Busy {
  tableId: string;
  start: number;
  end: number;
}

/** Bookings and walk-ins that hold tables around a day. */
async function busyTimes(db: Executor, loc: Location, from: Date, to: Date, tables: Table[]): Promise<Busy[]> {
  const rows = await db
    .select({ tableId: reservations.tableId, startsAt: reservations.startsAt, endsAt: reservations.endsAt })
    .from(reservations)
    .where(
      and(
        eq(reservations.locationId, loc.id),
        inArray(reservations.status, [...LIVE]),
        lt(reservations.startsAt, to),
        gt(reservations.endsAt, from),
      ),
    );
  const busy: Busy[] = rows
    .filter((r) => r.tableId)
    .map((r) => ({ tableId: r.tableId!, start: r.startsAt.getTime(), end: r.endsAt.getTime() }));
  // A walk-in holds the table for a normal sitting from when they sat down.
  for (const t of tables) {
    if (t.state === "seated" && t.seatedAt && !t.reservationId) {
      const start = t.seatedAt.getTime();
      busy.push({ tableId: t.id, start, end: start + sittingMinutes(t.seatedParty ?? 2) * 60_000 });
    }
    if (t.state === "clearing") busy.push({ tableId: t.id, start: Date.now(), end: Date.now() + 10 * 60_000 });
  }
  return busy;
}

function freeTable(cands: Table[], busy: Busy[], start: number, end: number): Table | undefined {
  return cands.find((t) => !busy.some((b) => b.tableId === t.id && b.start < end && b.end > start));
}

async function loadLocation(db: Executor, slug: string): Promise<Location> {
  const [loc] = await db.select().from(locations).where(eq(locations.slug, slug));
  if (!loc) throw new AppError(404, "location_not_found", "Restaurant not found");
  return loc;
}

function checkDate(loc: Location, date: string, now: Date) {
  const today = localDate(loc.timezone, now);
  const last = localDate(loc.timezone, new Date(now.getTime() + BOOK_DAYS_AHEAD * 86_400_000));
  if (date < today) throw new AppError(422, "past_date", "That date has passed");
  if (date > last) throw new AppError(422, "too_far", `Bookings open ${BOOK_DAYS_AHEAD} days ahead`);
}

export async function availability(
  db: Db,
  slug: string,
  date: string,
  party: number,
  now = new Date(),
): Promise<AvailabilityView> {
  return db.transaction(
    async (tx) => {
      const seq = await currentSeq(tx);
      const loc = await loadLocation(tx, slug);
      checkDate(loc, date, now);
      const times = slotTimes(loc.bookingHours, date);
      if (times.length === 0) return { date, party, closed: true, slots: [], seq };

      const tables = await tx.select().from(diningTables).where(eq(diningTables.locationId, loc.id));
      const cands = candidateTables(tables, party);
      const dayStart = zonedTime(date, "00:00", loc.timezone);
      const busy = await busyTimes(tx, loc, new Date(dayStart.getTime() - 6 * 3_600_000), new Date(dayStart.getTime() + 30 * 3_600_000), tables);
      const length = sittingMinutes(party) * 60_000;
      const earliest = now.getTime() + LEAD_MINUTES * 60_000;

      const slots = times.map((time) => {
        const start = zonedTime(date, time, loc.timezone).getTime();
        const ok = start >= earliest && cands.length > 0 && Boolean(freeTable(cands, busy, start, start + length));
        return { time, available: ok };
      });
      return { date, party, closed: false, slots, seq };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newCode(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

/** Exclusion constraint: two live bookings overlapping on one table. */
function isOverlap(err: unknown): boolean {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23P01") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Books the best free table. If two guests race for the last table, the
 * database lets one in; the other gets the next free table or a clear "taken".
 */
export async function bookTable(
  db: Db,
  input: BookTableInput,
  opts: { userId?: string | null; source?: "online" | "phone" | "walk_in"; now?: Date; skipLead?: boolean } = {},
): Promise<ReservationView> {
  const now = opts.now ?? new Date();
  // A guest who loses a race tries the next free table. With thirty people
  // pressing "book" at once for ten tables, losing several times in a row is
  // normal, so there are enough attempts to reach every table.
  for (let attempt = 0; attempt < 16; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.random() * 15 * Math.min(attempt, 4)));
    try {
      return await db.transaction(async (tx) => {
        const loc = await loadLocation(tx, input.locationSlug);
        checkDate(loc, input.date, now);
        if (!slotTimes(loc.bookingHours, input.date).includes(input.time)) {
          throw new AppError(422, "not_a_slot", "We are not taking bookings at that time");
        }
        const startsAt = zonedTime(input.date, input.time, loc.timezone);
        if (!opts.skipLead && startsAt.getTime() < now.getTime() + LEAD_MINUTES * 60_000) {
          throw new AppError(422, "too_soon", "That time is too soon to book online. Call us and we will fit you in.");
        }
        const endsAt = new Date(startsAt.getTime() + sittingMinutes(input.party) * 60_000);

        const tables = await tx.select().from(diningTables).where(eq(diningTables.locationId, loc.id));
        const cands = candidateTables(tables, input.party);
        const busy = await busyTimes(tx, loc, new Date(startsAt.getTime() - 6 * 3_600_000), new Date(endsAt.getTime() + 6 * 3_600_000), tables);
        const table = freeTable(cands, busy, startsAt.getTime(), endsAt.getTime());
        if (!table) throw new AppError(409, "fully_booked", "That time has just been taken. Pick another.");

        const [row] = await tx
          .insert(reservations)
          .values({
            locationId: loc.id,
            tableId: table.id,
            userId: opts.userId ?? null,
            code: newCode(),
            name: input.name,
            phone: input.phone,
            email: input.email || null,
            partySize: input.party,
            startsAt,
            endsAt,
            source: opts.source ?? "online",
            notes: input.notes || null,
          })
          .returning();
        const view = reservationView(row!, table.label);
        const [tv] = await tableViews(tx, loc, [table.id]);
        await enqueue(tx, loc.tenantId, [
          { channel: channels.availability(loc.id), type: "availability.changed", payload: { date: input.date } },
          { channel: channels.floor(loc.id), type: "floor.reservation", payload: view },
          ...(tv ? [{ channel: channels.floor(loc.id), type: "floor.table" as const, payload: tv }] : []),
        ]);
        return view;
      });
    } catch (err) {
      // Lost a race for a table, a code collided, or two bookings waiting on
      // each other's uncommitted rows were broken up by Postgres (deadlock).
      // All mean the same: try again with fresh data.
      if (isOverlap(err) || ["23505", "40P01", "40001"].includes(pgCode(err) ?? "")) continue;
      throw err;
    }
  }
  throw new AppError(409, "fully_booked", "That time has just been taken. Pick another.");
}

export async function reservationByCode(db: Executor, code: string): Promise<ReservationView> {
  const [row] = await db
    .select({ r: reservations, tableLabel: diningTables.label })
    .from(reservations)
    .leftJoin(diningTables, eq(diningTables.id, reservations.tableId))
    .where(eq(reservations.code, code.toUpperCase()));
  if (!row) throw new AppError(404, "booking_not_found", "We could not find that booking");
  return reservationView(row.r, row.tableLabel);
}

/** Hides most of the phone number on the guest's public booking page. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\s/g, "");
  return digits.length <= 3 ? "***" : `${"•".repeat(Math.max(0, digits.length - 3))}${digits.slice(-3)}`;
}

/** Cancels a live booking and frees its slot for everyone watching. */
export async function changeReservation(
  db: Db,
  where: { code?: string; id?: string; locationId?: string },
  to: "cancelled" | "no_show" | "completed",
): Promise<ReservationView> {
  return db.transaction(async (tx) => {
    const cond = where.code ? eq(reservations.code, where.code.toUpperCase()) : eq(reservations.id, where.id!);
    const [r] = await tx
      .select()
      .from(reservations)
      .where(where.locationId ? and(cond, eq(reservations.locationId, where.locationId)) : cond)
      .for("update");
    if (!r) throw new AppError(404, "booking_not_found", "We could not find that booking");
    if (r.status !== "booked" && !(to === "completed" && r.status === "seated")) {
      throw new AppError(409, "not_live", "This booking can no longer be changed");
    }
    const [row] = await tx
      .update(reservations)
      .set({ status: to, updatedAt: new Date() })
      .where(eq(reservations.id, r.id))
      .returning();
    const [loc] = await tx.select().from(locations).where(eq(locations.id, r.locationId));
    const label = r.tableId
      ? (await tx.select({ label: diningTables.label }).from(diningTables).where(eq(diningTables.id, r.tableId)))[0]?.label ?? null
      : null;
    const view = reservationView(row!, label);
    const tvs = r.tableId ? await tableViews(tx, loc!, [r.tableId]) : [];
    await enqueue(tx, loc!.tenantId, [
      { channel: channels.availability(loc!.id), type: "availability.changed", payload: { date: localDate(loc!.timezone, r.startsAt) } },
      { channel: channels.floor(loc!.id), type: "floor.reservation", payload: view },
      ...tvs.map((tv) => ({ channel: channels.floor(loc!.id), type: "floor.table" as const, payload: tv })),
    ]);
    return view;
  });
}

/** Today's bookings for the floor screen, in time order. */
export async function reservationsForDay(db: Executor, loc: Location, date: string): Promise<ReservationView[]> {
  const from = zonedTime(date, "00:00", loc.timezone);
  const to = new Date(from.getTime() + 30 * 3_600_000);
  const rows = await db
    .select({ r: reservations, tableLabel: diningTables.label })
    .from(reservations)
    .leftJoin(diningTables, eq(diningTables.id, reservations.tableId))
    .where(
      and(
        eq(reservations.locationId, loc.id),
        gt(reservations.startsAt, from),
        lt(reservations.startsAt, to),
        ne(reservations.status, "cancelled"),
      ),
    )
    .orderBy(asc(reservations.startsAt));
  return rows.map(({ r, tableLabel }) => reservationView(r, tableLabel));
}

/** The Postgres error code, looking through Drizzle's wrapping. */
function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: string }).code;
    if (typeof code === "string") return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
