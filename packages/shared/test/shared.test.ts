import { describe, expect, test } from "bun:test";
import {
  ALWAYS_OPEN,
  PlaceOrderSchema,
  backoffDelay,
  canTransition,
  isOpen,
  lineTotal,
  nextKitchenStep,
} from "../src";

describe("order state machine", () => {
  test("allows the normal kitchen flow", () => {
    expect(canTransition("dine_in", "received", "cooking")).toBe(true);
    expect(canTransition("dine_in", "cooking", "ready")).toBe(true);
    expect(canTransition("dine_in", "ready", "completed")).toBe(true);
    expect(canTransition("delivery", "ready", "out_for_delivery")).toBe(true);
  });

  test("rejects skipped and backwards steps", () => {
    expect(canTransition("pickup", "received", "ready")).toBe(false);
    expect(canTransition("pickup", "ready", "cooking")).toBe(false);
    expect(canTransition("pickup", "completed", "cancelled")).toBe(false);
  });

  test("ties completion to the order type", () => {
    expect(canTransition("delivery", "ready", "completed")).toBe(false);
    expect(canTransition("pickup", "ready", "out_for_delivery")).toBe(false);
  });

  test("labels the kitchen button by order type", () => {
    expect(nextKitchenStep("dine_in", "ready")?.label).toBe("Served");
    expect(nextKitchenStep("pickup", "ready")?.label).toBe("Collected");
    expect(nextKitchenStep("delivery", "ready")).toBeNull();
  });
});

describe("opening hours", () => {
  const tz = "Europe/London";
  // 2026-11-18 is a Wednesday. London is on GMT in November.
  const at = (hhmm: string, day = "2026-11-18") => new Date(`${day}T${hhmm}:00Z`);

  test("open inside a normal range, closed outside", () => {
    const hours = { wed: [["11:00", "22:00"]] as [string, string][] };
    expect(isOpen(hours, tz, at("12:30"))).toBe(true);
    expect(isOpen(hours, tz, at("10:59"))).toBe(false);
    expect(isOpen(hours, tz, at("22:00"))).toBe(false);
  });

  test("ranges past midnight count on the next day", () => {
    const hours = { tue: [["18:00", "02:00"]] as [string, string][] };
    expect(isOpen(hours, tz, at("01:30"))).toBe(true);
    expect(isOpen(hours, tz, at("02:30"))).toBe(false);
  });

  test("always open covers every minute", () => {
    expect(isOpen(ALWAYS_OPEN, tz, at("00:00"))).toBe(true);
    expect(isOpen(ALWAYS_OPEN, tz, at("23:59"))).toBe(true);
  });

  test("uses the restaurant time zone, not UTC", () => {
    const hours = { wed: [["09:00", "10:00"]] as [string, string][] };
    // 09:30 in New York is 14:30 UTC.
    expect(isOpen(hours, "America/New_York", at("14:30"))).toBe(true);
    expect(isOpen(hours, "America/New_York", at("09:30"))).toBe(false);
  });
});

describe("money and validation", () => {
  test("line totals use integer minor units", () => {
    expect(lineTotal(1250, [100, 150], 2)).toBe(3000);
  });

  test("dine-in orders need a table token", () => {
    const result = PlaceOrderSchema.safeParse({
      locationSlug: "x",
      type: "dine_in",
      customerName: "Sam",
      items: [{ menuItemId: crypto.randomUUID(), quantity: 1 }],
    });
    expect(result.success).toBe(false);
  });

  test("backoff stays within its cap", () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const d = backoffDelay(attempt, 500, 15_000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(15_000);
    }
  });
});
