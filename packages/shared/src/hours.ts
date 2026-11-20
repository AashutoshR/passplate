import { dateFormat } from "./format-cache";
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** "HH:MM" pairs per weekday. A close time at or before the open time runs past midnight. */
export type OpeningHours = Partial<Record<Weekday, [string, string][]>>;

const SHORT_TO_WEEKDAY: Record<string, Weekday> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Weekday and minutes since midnight in the restaurant's own time zone. */
export function localClock(timeZone: string, now: Date): { day: Weekday; minutes: number } {
  const parts = dateFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = SHORT_TO_WEEKDAY[get("weekday")];
  if (!day) throw new Error(`Unexpected weekday for time zone ${timeZone}`);
  return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** FR-3: ordering is blocked outside opening hours. */
export function isOpen(hours: OpeningHours, timeZone: string, now: Date = new Date()): boolean {
  const { day, minutes } = localClock(timeZone, now);
  const dayIndex = WEEKDAYS.indexOf(day);
  const yesterday = WEEKDAYS[(dayIndex + 6) % 7]!;

  for (const [open, close] of hours[day] ?? []) {
    const o = toMinutes(open);
    const c = toMinutes(close);
    if (c > o ? minutes >= o && minutes < c : minutes >= o) return true;
  }
  // Ranges from yesterday that run past midnight.
  for (const [open, close] of hours[yesterday] ?? []) {
    const o = toMinutes(open);
    const c = toMinutes(close);
    if (c <= o && minutes < c) return true;
  }
  return false;
}

export const ALWAYS_OPEN: OpeningHours = Object.fromEntries(
  WEEKDAYS.map((d) => [d, [["00:00", "24:00"]]]),
) as OpeningHours;
