import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { diningTables, locations, orders, payments, users, type Db, type Executor } from "@pass/db";
import {
  channels,
  ORDER_TYPES,
  PAYMENT_METHODS,
  type OrderType,
  type PaymentMethod,
  type TransactionView,
  type TransactionsView,
} from "@pass/shared";
import { AppError } from "../errors";
import { refundOnline, type PaymentsConfig } from "./checkout";
import { enqueue, type OutboxEvent } from "../outbox";
import { currentSeq, loadTicket } from "../views";

type Location = typeof locations.$inferSelect;
type Order = typeof orders.$inferSelect;

async function transactionView(db: Executor, paymentId: string): Promise<TransactionView> {
  const [row] = await db
    .select({ p: payments, o: orders, tableLabel: diningTables.label, takenBy: users.name })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
    .leftJoin(users, eq(users.id, payments.takenBy))
    .where(eq(payments.id, paymentId));
  return toView(row!);
}

function toView(row: {
  p: typeof payments.$inferSelect;
  o: Order;
  tableLabel: string | null;
  takenBy: string | null;
}): TransactionView {
  return {
    id: row.p.id,
    kind: row.p.kind,
    method: row.p.method,
    amountMinor: row.p.amountMinor,
    createdAt: row.p.createdAt.toISOString(),
    order: {
      id: row.o.id,
      number: row.o.number,
      type: row.o.type,
      status: row.o.status,
      customerName: row.o.customerName,
      tableLabel: row.tableLabel,
      subtotalMinor: row.o.subtotalMinor,
      discountMinor: row.o.discountMinor,
      deliveryFeeMinor: row.o.deliveryFeeMinor,
    },
    takenBy: row.takenBy,
  };
}

/**
 * Records money taken for an order, in the caller's transaction, and returns
 * the events that tell the admin screen and the guest's order page.
 */
export async function recordPayment(
  tx: Executor,
  loc: Location,
  order: Order,
  method: PaymentMethod,
  takenBy: string | null,
): Promise<OutboxEvent[]> {
  if (order.paidAt) return [];
  const [p] = await tx
    .insert(payments)
    .values({
      tenantId: loc.tenantId,
      locationId: loc.id,
      orderId: order.id,
      method,
      amountMinor: order.totalMinor,
      takenBy,
    })
    .returning({ id: payments.id });
  await tx.update(orders).set({ paidAt: new Date(), updatedAt: new Date() }).where(eq(orders.id, order.id));
  const ticket = await loadTicket(tx, order.id);
  return [
    { channel: channels.admin(loc.id), type: "payment.recorded", payload: await transactionView(tx, p!.id) },
    { channel: channels.order(order.id), type: "order.updated", payload: ticket },
  ];
}

/** Money back for a paid order that will not be fulfilled. */
export async function refundOrder(tx: Executor, loc: Location, order: Order, takenBy: string | null): Promise<OutboxEvent[]> {
  if (!order.paidAt) return [];
  const [already] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.kind, "refund")));
  if (already) return [];
  const [paid] = await tx
    .select({ method: payments.method, amount: payments.amountMinor })
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.kind, "payment")));
  if (!paid) return [];
  const [p] = await tx
    .insert(payments)
    .values({
      tenantId: loc.tenantId,
      locationId: loc.id,
      orderId: order.id,
      kind: "refund",
      method: paid.method,
      amountMinor: paid.amount,
      takenBy,
    })
    .returning({ id: payments.id });
  return [{ channel: channels.admin(loc.id), type: "payment.recorded", payload: await transactionView(tx, p!.id) }];
}

export async function adminRefund(
  db: Db,
  loc: Location,
  orderId: string,
  takenBy: string,
  payments: PaymentsConfig = { provider: "test" },
): Promise<TransactionView> {
  const { view, order } = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.locationId, loc.id)))
      .for("update");
    if (!order) throw new AppError(404, "order_not_found", "Order not found");
    if (!order.paidAt) throw new AppError(409, "unpaid", "This order was never paid");
    const events = await refundOrder(tx, loc, order, takenBy);
    if (events.length === 0) throw new AppError(409, "already_refunded", "This order has already been refunded");
    await enqueue(tx, loc.tenantId, events);
    return { view: events[0]!.payload as TransactionView, order };
  });
  await refundOnline(payments, order);
  return view;
}

export interface TransactionFilter {
  from: Date;
  to: Date;
  method?: PaymentMethod;
  type?: OrderType;
}

export async function listTransactions(db: Db, loc: Location, f: TransactionFilter): Promise<TransactionsView> {
  return db.transaction(
    async (tx) => {
      const seq = await currentSeq(tx);
      const conds = [eq(payments.locationId, loc.id), gte(payments.createdAt, f.from), lt(payments.createdAt, f.to)];
      if (f.method) conds.push(eq(payments.method, f.method));
      if (f.type) conds.push(eq(orders.type, f.type));
      const rows = await tx
        .select({ p: payments, o: orders, tableLabel: diningTables.label, takenBy: users.name })
        .from(payments)
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
        .leftJoin(users, eq(users.id, payments.takenBy))
        .where(and(...conds))
        .orderBy(desc(payments.createdAt))
        .limit(1000);
      const transactions = rows.map(toView);
      const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, 0])) as Record<PaymentMethod, number>;
      const byType = Object.fromEntries(ORDER_TYPES.map((t) => [t, 0])) as Record<OrderType, number>;
      let gross = 0;
      let refunds = 0;
      let discounts = 0;
      for (const t of transactions) {
        const sign = t.kind === "refund" ? -1 : 1;
        if (t.kind === "refund") refunds += t.amountMinor;
        else {
          gross += t.amountMinor;
          discounts += t.order.discountMinor;
        }
        byMethod[t.method] += sign * t.amountMinor;
        byType[t.order.type] += sign * t.amountMinor;
      }
      return {
        currency: loc.currency,
        transactions,
        totals: {
          grossMinor: gross,
          refundsMinor: refunds,
          discountsMinor: discounts,
          netMinor: gross - refunds,
          count: transactions.filter((t) => t.kind === "payment").length,
        },
        byMethod,
        byType,
        seq,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Takings so far, used by the overview. */
export async function takings(db: Executor, locationId: string, from: Date, to: Date): Promise<number> {
  const [row] = await db
    .select({
      net: sql<number>`coalesce(sum(case when ${payments.kind} = 'refund' then -${payments.amountMinor} else ${payments.amountMinor} end), 0)::int`,
    })
    .from(payments)
    .where(and(eq(payments.locationId, locationId), gte(payments.createdAt, from), lt(payments.createdAt, to)));
  return row?.net ?? 0;
}
