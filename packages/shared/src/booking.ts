import { dateFormat } from "./format-cache";
import { z } from "zod";
import { WEEKDAYS, type OpeningHours } from "./hours";

/**
 * Table booking. Slots every 15 minutes inside the restaurant's hours; a
 * table is held for longer the more people sit at it. The database refuses
 * two live bookings on one table at overlapping times, so the last table on
 * a busy night can only be booked once.
 */

export const SLOT_MINUTES = 15;
export const MAX_PARTY = 12;
export const BOOK_DAYS_AHEAD = 60;
/** Last booking this long before closing. */
export const LAST_SEATING_BEFORE_CLOSE = 90;

export function sittingMinutes(party: number): number {
  if (party <= 2) return 90;
  if (party <= 6) return 120;
  return 150;
}

export const TABLE_SHAPES = ["round", "square", "rect", "booth", "stool"] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];

export const RESERVATION_STATUSES = ["booked", "seated", "completed", "cancelled", "no_show"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** What staff see on the floor plan, most urgent first. */
export const TABLE_STATUSES = ["clearing", "eating", "ordered", "seated", "reserved", "free"] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const TABLE_STATUS_LABELS: Record<TableStatus, string> = {
  free: "Free",
  reserved: "Reserved",
  seated: "Seated",
  ordered: "Food on the way",
  eating: "Eating",
  clearing: "Needs clearing",
};

/** One line staff can act on, for each status. */
export const TABLE_STATUS_HINTS: Record<TableStatus, string> = {
  free: "Ready for guests",
  reserved: "A booking arrives within the hour",
  seated: "Guests are in, nothing ordered yet",
  ordered: "The kitchen is cooking for this table",
  eating: "Everything served; bill not settled",
  clearing: "Bill paid; reset the table",
};

export const AvailabilityQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  party: z.coerce.number().int().min(1).max(MAX_PARTY),
});

export const BookTableSchema = z.object({
  locationSlug: z.string().min(1).max(64),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  party: z.number().int().min(1).max(MAX_PARTY),
  name: z.string().trim().min(1, "Tell us your name").max(80),
  phone: z.string().trim().min(6, "We need a number in case something changes").max(30),
  email: z.string().trim().toLowerCase().email().max(200).optional().or(z.literal("")),
  notes: z.string().trim().max(300).optional(),
});
export type BookTableInput = z.infer<typeof BookTableSchema>;

export const SeatWalkInSchema = z.object({
  tableId: z.uuid(),
  party: z.number().int().min(1).max(MAX_PARTY),
  name: z.string().trim().max(80).optional(),
  waitlistId: z.uuid().optional(),
  reservationId: z.uuid().optional(),
});

export const SettleSchema = z.object({ method: z.enum(["card", "cash"]) });

export const WaitlistAddSchema = z.object({
  name: z.string().trim().min(1).max(80),
  party: z.number().int().min(1).max(MAX_PARTY),
  phone: z.string().trim().max(30).optional(),
  quotedMinutes: z.number().int().min(0).max(240).default(20),
});

export const ReservationActionSchema = z.object({
  action: z.enum(["cancel", "no_show"]),
});

export interface SlotView {
  time: string;
  available: boolean;
}

export interface AvailabilityView {
  date: string;
  party: number;
  /** Closed all day. */
  closed: boolean;
  slots: SlotView[];
  seq: number;
}

export interface ReservationView {
  id: string;
  code: string;
  name: string;
  phone: string;
  email: string | null;
  party: number;
  startsAt: string;
  endsAt: string;
  status: ReservationStatus;
  tableLabel: string | null;
  tableId: string | null;
  notes: string | null;
  source: "online" | "phone" | "walk_in";
}

export interface TableView {
  id: string;
  label: string;
  seats: number;
  area: string;
  shape: TableShape;
  x: number;
  y: number;
  w: number;
  h: number;
  status: TableStatus;
  /** Who is sitting there now. */
  party: number | null;
  guestName: string | null;
  seatedAt: string | null;
  /** The next live booking today, if any. */
  next: { id: string; name: string; party: number; startsAt: string; code: string } | null;
  /** Unpaid food and drink on the table. */
  openMinor: number;
  activeOrders: number;
  /** While the table is being cleared: an order on the bill just paid, to print its receipt. */
  settledOrderId: string | null;
}

export interface WaitlistEntryView {
  id: string;
  name: string;
  party: number;
  phone: string | null;
  quotedMinutes: number;
  createdAt: string;
}

export interface FloorView {
  location: { id: string; slug: string; name: string; currency: string; timezone: string };
  tables: TableView[];
  waitlist: WaitlistEntryView[];
  reservations: ReservationView[];
  seq: number;
}

/** Booking start times for one local date, ignoring what is already booked. */
export function slotTimes(hours: OpeningHours, date: string): string[] {
  const day = WEEKDAYS[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7]!;
  const out: string[] = [];
  for (const [open, close] of hours[day] ?? []) {
    const o = toMinutes(open);
    let c = toMinutes(close);
    if (c <= o) c += 24 * 60;
    for (let m = o; m <= c - LAST_SEATING_BEFORE_CLOSE; m += SLOT_MINUTES) {
      if (m >= 24 * 60) break;
      out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
    }
  }
  return out;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * The UTC instant of a local wall-clock time in a time zone. Works for any
 * zone without a library: guess, measure the zone's offset at the guess, correct.
 */
export function zonedTime(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  const offset = (d: Date) => {
    const parts = dateFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return asUtc - d.getTime();
  };
  const first = new Date(guess.getTime() - offset(guess));
  return new Date(guess.getTime() - offset(first));
}

/** Today's date in the restaurant's time zone, as YYYY-MM-DD. */
export function localDate(timeZone: string, now: Date = new Date()): string {
  return dateFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function localTime(iso: string, timeZone: string): string {
  return dateFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(iso),
  );
}
