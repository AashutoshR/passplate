import { z } from "zod";
import type { OrderType } from "./schemas";
import type { PaymentMethod } from "./views";

/**
 * A receipt is written once, by the background worker, from the payments
 * taken together (one online payment, or every round on a table settled at
 * once). What it says is frozen in `body`, so a later menu or price edit never
 * changes a receipt a guest already has.
 */
export interface ReceiptBody {
  restaurant: {
    name: string;
    legalName: string;
    address: string[];
    phone: string | null;
    vatNumber: string | null;
  };
  /** Where and how the food was served. */
  service: { type: OrderType; tableLabel: string | null; orderNumbers: number[]; customerName: string };
  lines: { name: string; quantity: number; modifiers: string[]; unitPriceMinor: number; lineTotalMinor: number }[];
  subtotalMinor: number;
  discountMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  /** Prices include VAT. This is the VAT inside the total, at the restaurant's rate. */
  vat: { rateBp: number; netMinor: number; vatMinor: number };
  payment: { method: PaymentMethod; amountMinor: number; takenBy: string | null; at: string };
  /** For a refund, the receipt it gives money back on. */
  refundOf: { id: string; number: number } | null;
}

export interface ReceiptView {
  id: string;
  /** Gap-free per restaurant, the number a guest quotes. */
  number: number;
  kind: "sale" | "refund";
  currency: string;
  timezone: string;
  issuedAt: string;
  orderIds: string[];
  /** How many times staff have printed it. A second print says "Copy". */
  printedCount: number;
  body: ReceiptBody;
}

/** The VAT inside a VAT-inclusive amount, rounded to the penny. */
export function vatIncluded(totalMinor: number, rateBp: number): { netMinor: number; vatMinor: number } {
  const vat = Math.round((totalMinor * rateBp) / (10_000 + rateBp));
  return { netMinor: totalMinor - vat, vatMinor: vat };
}

/** R-000123: how a receipt number is printed. */
export const receiptCode = (n: number) => `R-${String(n).padStart(6, "0")}`;

/** End of day: every receipt of one local day, totalled for the till. */
export interface DayReportView {
  date: string;
  currency: string;
  timezone: string;
  restaurant: ReceiptBody["restaurant"];
  generatedAt: string;
  receipts: { count: number; first: number | null; last: number | null };
  sales: { count: number; grossMinor: number; discountsMinor: number; deliveryFeesMinor: number };
  refunds: { count: number; amountMinor: number };
  netMinor: number;
  vat: { rateBp: number; netMinor: number; vatMinor: number };
  byMethod: Record<PaymentMethod, { count: number; amountMinor: number }>;
  byType: Record<OrderType, { count: number; amountMinor: number }>;
}

export const ReceiptSearchSchema = z.object({
  q: z.string().trim().min(1).max(60),
});
