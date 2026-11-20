import { and, asc, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import { latestReceiptFor, locations, orders, receipts, receiptView, type Db } from "@pass/db";
import {
  localDate,
  ORDER_TYPES,
  PAYMENT_METHODS,
  vatIncluded,
  zonedTime,
  type DayReportView,
  type OrderType,
  type PaymentMethod,
  type ReceiptView,
} from "@pass/shared";
import { AppError } from "../errors";

type Location = typeof locations.$inferSelect;

/**
 * The guest's receipt, found by order id (the same private link as the order
 * page). 404 receipt_pending while the worker has not written it yet, which
 * is normally under a second after payment.
 */
export async function receiptForOrder(db: Db, orderId: string): Promise<ReceiptView> {
  const [order] = await db
    .select({ paidAt: orders.paidAt, currency: locations.currency, timezone: locations.timezone })
    .from(orders)
    .innerJoin(locations, eq(locations.id, orders.locationId))
    .where(eq(orders.id, orderId));
  if (!order) throw new AppError(404, "order_not_found", "Order not found");
  if (!order.paidAt) throw new AppError(404, "not_paid", "There is no receipt until the order is paid");
  const row = await latestReceiptFor(db, orderId);
  if (!row) throw new AppError(404, "receipt_pending", "Your receipt is being prepared");
  return receiptView(row, order);
}

export async function staffReceipt(db: Db, loc: Location, id: string): Promise<ReceiptView> {
  const [row] = await db.select().from(receipts).where(and(eq(receipts.id, id), eq(receipts.locationId, loc.id)));
  if (!row) throw new AppError(404, "receipt_not_found", "Receipt not found");
  return receiptView(row, loc);
}

/** The newest receipt for an order, for the floor's "Print receipt" right after settling. */
export async function staffReceiptForOrder(db: Db, loc: Location, orderId: string): Promise<ReceiptView> {
  const row = await latestReceiptFor(db, orderId);
  if (!row || row.locationId !== loc.id) throw new AppError(404, "receipt_pending", "The receipt is being prepared");
  return receiptView(row, loc);
}

/**
 * Staff print a receipt. The count is kept so a second print is marked
 * "Copy", as a till does. Returns whether this print is a copy.
 */
export async function markPrinted(db: Db, loc: Location, id: string): Promise<{ copy: boolean; receipt: ReceiptView }> {
  const [row] = await db
    .update(receipts)
    .set({ printedCount: sql`${receipts.printedCount} + 1`, lastPrintedAt: new Date() })
    .where(and(eq(receipts.id, id), eq(receipts.locationId, loc.id)))
    .returning();
  if (!row) throw new AppError(404, "receipt_not_found", "Receipt not found");
  return { copy: row.printedCount > 1, receipt: receiptView(row, loc) };
}

export interface ReceiptHit {
  id: string;
  number: number;
  kind: "sale" | "refund";
  totalMinor: number;
  issuedAt: string;
  customerName: string;
  orderNumbers: number[];
  type: OrderType;
  tableLabel: string | null;
}

/**
 * Find a receipt a guest asks about: by receipt number (R-000123 or 123),
 * by order number (#45), or by name. With no query, the latest ones.
 */
export async function searchReceipts(db: Db, loc: Location, q: string): Promise<{ currency: string; hits: ReceiptHit[] }> {
  const text = q.trim();
  const conds = [];
  const receiptNo = /^r-?0*(\d{1,9})$/i.exec(text)?.[1] ?? (/^\d{1,9}$/.test(text) ? text : null);
  const orderNo = /^#\s*(\d{1,9})$/.exec(text)?.[1] ?? (/^\d{1,9}$/.test(text) ? text : null);
  if (receiptNo) conds.push(eq(receipts.number, Number(receiptNo)));
  if (orderNo) conds.push(sql`${receipts.body} -> 'service' -> 'orderNumbers' @> ${JSON.stringify([Number(orderNo)])}::jsonb`);
  if (text && !receiptNo && !orderNo) conds.push(ilike(sql`${receipts.body} -> 'service' ->> 'customerName'`, `%${text.replace(/[%_\\]/g, "\\$&")}%`));
  const rows = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.locationId, loc.id), conds.length ? or(...conds) : undefined))
    .orderBy(desc(receipts.issuedAt))
    .limit(25);
  return {
    currency: loc.currency,
    hits: rows.map((r) => ({
      id: r.id,
      number: r.number,
      kind: r.kind,
      totalMinor: r.totalMinor,
      issuedAt: r.issuedAt.toISOString(),
      customerName: r.body.service.customerName,
      orderNumbers: r.body.service.orderNumbers,
      type: r.body.service.type,
      tableLabel: r.body.service.tableLabel,
    })),
  };
}

/** End of day for the till: every receipt of one local day, totalled. */
export async function dayReport(db: Db, loc: Location, date: string = localDate(loc.timezone)): Promise<DayReportView> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, "bad_date", "Use a date like 2026-11-20");
  const from = zonedTime(date, "00:00", loc.timezone);
  const next = localDate(loc.timezone, new Date(from.getTime() + 36 * 3_600_000));
  const to = zonedTime(next, "00:00", loc.timezone);
  const rows = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.locationId, loc.id), gte(receipts.issuedAt, from), lt(receipts.issuedAt, to)))
    .orderBy(asc(receipts.number));

  const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, { count: 0, amountMinor: 0 }])) as Record<
    PaymentMethod,
    { count: number; amountMinor: number }
  >;
  const byType = Object.fromEntries(ORDER_TYPES.map((t) => [t, { count: 0, amountMinor: 0 }])) as Record<
    OrderType,
    { count: number; amountMinor: number }
  >;
  const sales = { count: 0, grossMinor: 0, discountsMinor: 0, deliveryFeesMinor: 0 };
  const refunds = { count: 0, amountMinor: 0 };
  for (const r of rows) {
    const sign = r.kind === "refund" ? -1 : 1;
    if (r.kind === "refund") {
      refunds.count++;
      refunds.amountMinor += r.totalMinor;
    } else {
      sales.count++;
      sales.grossMinor += r.totalMinor;
      sales.discountsMinor += r.body.discountMinor;
      sales.deliveryFeesMinor += r.body.deliveryFeeMinor;
    }
    const m = byMethod[r.body.payment.method];
    m.count += 1;
    m.amountMinor += sign * r.totalMinor;
    const t = byType[r.body.service.type];
    t.count += 1;
    t.amountMinor += sign * r.totalMinor;
  }
  const net = sales.grossMinor - refunds.amountMinor;
  return {
    date,
    currency: loc.currency,
    timezone: loc.timezone,
    restaurant: {
      name: loc.name,
      legalName: loc.legalName ?? loc.name,
      address: loc.address,
      phone: loc.phone,
      vatNumber: loc.vatNumber,
    },
    generatedAt: new Date().toISOString(),
    receipts: { count: rows.length, first: rows[0]?.number ?? null, last: rows[rows.length - 1]?.number ?? null },
    sales,
    refunds,
    netMinor: net,
    vat: { rateBp: loc.vatRateBp, ...vatIncluded(net, loc.vatRateBp) },
    byMethod,
    byType,
  };
}
