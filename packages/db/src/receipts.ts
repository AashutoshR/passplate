import { and, arrayContains, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { receiptCode, vatIncluded, type ReceiptBody, type ReceiptView } from "@pass/shared";
import type { Db, Executor } from "./client";
import { diningTables, locations, orderItems, orders, outbox, payments, receipts, users } from "./schema";

/**
 * Receipts are written here, by the background worker, never inside the
 * request that took the money (NFR-22). Each run picks up payments that have
 * no receipt yet. Payments taken together (every round on a table settled at
 * once) share a batch id and get one receipt between them.
 *
 * Numbers are gap-free per restaurant: a transaction-scoped advisory lock
 * per restaurant hands them out one at a time, so two workers can never take
 * the same number or skip one.
 */
export async function issuePendingReceipts(db: Db, limit = 50): Promise<number> {
  const waiting = await db
    .select({ id: payments.id, batchId: payments.batchId })
    .from(payments)
    .where(isNull(payments.receiptId))
    .orderBy(asc(payments.createdAt), asc(payments.id))
    .limit(limit * 4);
  const keys: string[] = [];
  for (const p of waiting) {
    const key = p.batchId ?? p.id;
    if (!keys.includes(key)) keys.push(key);
    if (keys.length >= limit) break;
  }
  let issued = 0;
  for (const key of keys) if (await issueReceipt(db, key)) issued++;
  return issued;
}

/** Writes the receipt for one payment, or one batch of payments. Returns null if it already exists. */
export async function issueReceipt(db: Db, key: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const paid = await tx
      .select()
      .from(payments)
      .where(and(isNull(payments.receiptId), or(eq(payments.batchId, key), eq(payments.id, key))))
      .orderBy(asc(payments.createdAt))
      .for("update", { skipLocked: true });
    if (paid.length === 0) return null;

    const [loc] = await tx.select().from(locations).where(eq(locations.id, paid[0]!.locationId));
    if (!loc) return null;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"receipts:" + loc.id}, 0))`);
    const [{ next } = { next: 1 }] = await tx
      .select({ next: sql<number>`coalesce(max(${receipts.number}), 0)::int + 1` })
      .from(receipts)
      .where(eq(receipts.locationId, loc.id));

    const orderIds = [...new Set(paid.map((p) => p.orderId))];
    const orderRows = await tx
      .select({ o: orders, tableLabel: diningTables.label })
      .from(orders)
      .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
      .where(inArray(orders.id, orderIds))
      .orderBy(asc(orders.number));
    const items = await tx
      .select()
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds))
      .orderBy(asc(orderItems.position));
    const byOrder = new Map(orderRows.map((r) => [r.o.id, r]));
    const lines = orderRows.flatMap((r) =>
      items
        .filter((i) => i.orderId === r.o.id)
        .map((i) => ({
          name: i.name,
          quantity: i.quantity,
          modifiers: i.modifiers.map((m) => m.name),
          unitPriceMinor: Math.round(i.lineTotalMinor / Math.max(1, i.quantity)),
          lineTotalMinor: i.lineTotalMinor,
        })),
    );

    const refund = paid[0]!.kind === "refund";
    let refundOf: ReceiptBody["refundOf"] = null;
    if (refund) {
      const [orig] = await tx
        .select({ id: receipts.id, number: receipts.number })
        .from(receipts)
        .where(and(eq(receipts.locationId, loc.id), eq(receipts.kind, "sale"), arrayContains(receipts.orderIds, [orderIds[0]!])))
        .limit(1);
      refundOf = orig ?? null;
    }

    const amount = paid.reduce((n, p) => n + p.amountMinor, 0);
    const first = orderRows[0]!.o;
    const [taker] = paid[0]!.takenBy
      ? await tx.select({ name: users.name }).from(users).where(eq(users.id, paid[0]!.takenBy!))
      : [];
    const issuedAt = paid[paid.length - 1]!.createdAt;
    const body: ReceiptBody = {
      restaurant: {
        name: loc.name,
        legalName: loc.legalName ?? loc.name,
        address: loc.address,
        phone: loc.phone,
        vatNumber: loc.vatNumber,
      },
      service: {
        type: first.type,
        tableLabel: orderRows[0]!.tableLabel,
        orderNumbers: orderRows.map((r) => r.o.number),
        customerName: first.customerName,
      },
      lines,
      subtotalMinor: orderRows.reduce((n, r) => n + r.o.subtotalMinor, 0),
      discountMinor: orderRows.reduce((n, r) => n + r.o.discountMinor, 0),
      deliveryFeeMinor: orderRows.reduce((n, r) => n + r.o.deliveryFeeMinor, 0),
      totalMinor: amount,
      vat: { rateBp: loc.vatRateBp, ...vatIncluded(amount, loc.vatRateBp) },
      payment: { method: paid[0]!.method, amountMinor: amount, takenBy: taker?.name ?? null, at: issuedAt.toISOString() },
      refundOf,
    };
    const [row] = await tx
      .insert(receipts)
      .values({
        locationId: loc.id,
        number: next,
        kind: refund ? "refund" : "sale",
        orderIds,
        totalMinor: amount,
        body,
        issuedAt,
      })
      .returning();
    await tx
      .update(payments)
      .set({ receiptId: row!.id })
      .where(inArray(payments.id, paid.map((p) => p.id)));

    const summary = { id: row!.id, number: row!.number, code: receiptCode(row!.number), kind: row!.kind, orderIds };
    await tx.insert(outbox).values([
      ...orderIds.filter((id) => byOrder.has(id)).map((id) => ({
        tenantId: loc.tenantId,
        channel: `order:${id}`,
        type: "receipt.issued",
        payload: summary,
      })),
      { tenantId: loc.tenantId, channel: `admin:${loc.id}`, type: "receipt.issued", payload: summary },
    ]);
    return row!.id;
  });
}

export function receiptView(row: typeof receipts.$inferSelect, loc: { currency: string; timezone: string }): ReceiptView {
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    currency: loc.currency,
    timezone: loc.timezone,
    issuedAt: row.issuedAt.toISOString(),
    orderIds: row.orderIds,
    printedCount: row.printedCount,
    body: row.body,
  };
}

/** The newest receipt that covers an order: the sale, or a refund after it. */
export async function latestReceiptFor(db: Executor, orderId: string) {
  const [row] = await db
    .select()
    .from(receipts)
    .where(arrayContains(receipts.orderIds, [orderId]))
    .orderBy(desc(receipts.issuedAt), desc(receipts.number))
    .limit(1);
  return row ?? null;
}
