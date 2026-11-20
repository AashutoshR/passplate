import { and, asc, eq, isNotNull, lt } from "drizzle-orm";
import {
  locations,
  orderTransitions,
  orders,
  rewards,
  stripeEvents,
  type Db,
  type Tx,
} from "@pass/db";
import { channels, type PaymentProvider, type PaymentStartView, type TicketView } from "@pass/shared";
import { AppError } from "../errors";
import { enqueue, type OutboxEvent } from "../outbox";
import { loadTicket } from "../views";
import { restock } from "./kitchen";
import { recordPayment } from "./payments";
import {
  cancelPaymentIntent,
  createPaymentIntent,
  refundPaymentIntent,
  retrievePaymentIntent,
  verifyWebhook,
  type StripeConfig,
} from "./stripe";

/**
 * Paying for collect and delivery orders (FR-8, FR-10).
 *
 * An order is saved as awaiting_payment with its stock held. The kitchen only
 * hears about it once the payment is confirmed: by Stripe's webhook, or by the
 * built-in test provider. Unpaid orders expire after fifteen minutes and give
 * their stock and any reward back.
 */

export type PaymentsConfig = { provider: "test" } | { provider: "stripe"; stripe: StripeConfig };

export const PAYMENT_WINDOW_MS = 15 * 60_000;

type Order = typeof orders.$inferSelect;
type Location = typeof locations.$inferSelect;

async function orderAndLocation(db: Db | Tx, orderId: string, lock = false) {
  const q = db
    .select({ order: orders, loc: locations })
    .from(orders)
    .innerJoin(locations, eq(locations.id, orders.locationId))
    .where(eq(orders.id, orderId));
  const [row] = lock ? await q.for("update", { of: orders }) : await q;
  if (!row) throw new AppError(404, "order_not_found", "Order not found");
  return row;
}

/** What the payment screen needs. Creates the Stripe PaymentIntent on first use. */
export async function startPayment(db: Db, cfg: PaymentsConfig, orderId: string): Promise<PaymentStartView> {
  const { order, loc } = await orderAndLocation(db, orderId);
  if (order.status !== "awaiting_payment" || !order.paymentExpiresAt) {
    throw new AppError(409, "not_awaiting_payment", order.paidAt ? "This order is already paid" : "This order can no longer be paid");
  }
  const base = {
    amountMinor: order.totalMinor,
    currency: order.currency,
    expiresAt: order.paymentExpiresAt.toISOString(),
  };
  if (cfg.provider === "test" || order.paymentProvider !== "stripe") {
    return { provider: "test", ...base, clientSecret: null, publishableKey: null };
  }
  let intent = order.paymentRef ? await retrievePaymentIntent(cfg.stripe, order.paymentRef) : null;
  if (!intent) {
    intent = await createPaymentIntent(cfg.stripe, {
      orderId: order.id,
      amountMinor: order.totalMinor,
      currency: order.currency,
      description: `${loc.name} order ${order.number}`,
    });
    // Two tabs racing both get the same intent: Stripe dedupes on the idempotency key.
    await db.update(orders).set({ paymentRef: intent.id }).where(and(eq(orders.id, order.id)));
  }
  return { provider: "stripe", ...base, clientSecret: intent.client_secret, publishableKey: cfg.stripe.publishableKey };
}

export type ConfirmResult =
  | { kind: "confirmed"; ticket: TicketView }
  | { kind: "already"; ticket: TicketView }
  /** Paid after the order expired: the money must go back. */
  | { kind: "late"; order: Order };

/**
 * Marks an order paid and sends it to the kitchen, in the caller's
 * transaction. Safe to call twice: the second call changes nothing.
 */
export async function confirmPaidTx(
  tx: Tx,
  orderId: string,
  provider: PaymentProvider,
  ref: string | null,
): Promise<ConfirmResult> {
  const { order, loc } = await orderAndLocation(tx, orderId, true);
  if (order.status !== "awaiting_payment") {
    if (order.paidAt) return { kind: "already", ticket: (await loadTicket(tx, orderId))! };
    return { kind: "late", order };
  }
  const now = new Date();
  await tx
    .update(orders)
    .set({
      status: "received",
      version: order.version + 1,
      paymentExpiresAt: null,
      paymentRef: ref ?? order.paymentRef,
      // The kitchen's clock starts when the money is in, not when the basket was opened.
      createdAt: now,
      updatedAt: now,
    })
    .where(eq(orders.id, orderId));
  await tx.insert(orderTransitions).values({
    orderId,
    fromStatus: "awaiting_payment",
    toStatus: "received",
    actor: `payment:${provider}`,
    device: null,
    actionId: crypto.randomUUID(),
  });
  const [fresh] = await tx.select().from(orders).where(eq(orders.id, orderId));
  const paymentEvents = await recordPayment(tx, loc, fresh!, "online", null);
  const ticket = (await loadTicket(tx, orderId))!;
  const events: OutboxEvent[] = [
    ...paymentEvents.filter((e) => e.type !== "order.updated"),
    { channel: channels.kitchen(loc.id), type: "ticket.created", payload: ticket },
    { channel: channels.order(orderId), type: "order.updated", payload: ticket },
  ];
  if (order.type === "delivery") {
    events.push({ channel: channels.drivers(loc.id), type: "delivery.updated", payload: ticket });
  }
  await enqueue(tx, loc.tenantId, events);
  return { kind: "confirmed", ticket };
}

/** The built-in provider: the guest chooses to succeed or to see a declined card. */
export async function testPayment(
  db: Db,
  cfg: PaymentsConfig,
  orderId: string,
  outcome: "succeeded" | "declined",
): Promise<TicketView> {
  const { order } = await orderAndLocation(db, orderId);
  if (cfg.provider !== "test" || order.paymentProvider !== "test") {
    throw new AppError(409, "wrong_provider", "This order is paid through Stripe");
  }
  if (outcome === "declined") {
    if (order.status !== "awaiting_payment") throw new AppError(409, "not_awaiting_payment", "This order can no longer be paid");
    throw new AppError(402, "card_declined", "Your card was declined. Nothing was taken. Try another card.");
  }
  const result = await db.transaction((tx) => confirmPaidTx(tx, orderId, "test", `test_${orderId}`));
  if (result.kind === "late") throw new AppError(409, "expired", "This order expired before it was paid. Please order again.");
  return result.ticket;
}

/**
 * Stripe webhook (NFR-13). The event id is recorded in the same transaction
 * as its effect, so a retried delivery is a no-op, and a delivery that failed
 * halfway is retried in full.
 */
export async function stripeWebhook(
  db: Db,
  cfg: PaymentsConfig,
  rawBody: string,
  signature: string | undefined,
  now = Date.now(),
): Promise<{ duplicate: boolean; handled: string }> {
  if (cfg.provider !== "stripe") throw new AppError(404, "not_found", "Not found");
  const event = verifyWebhook(rawBody, signature, cfg.stripe.webhookSecret, now);
  let late: Order | null = null;
  const outcome = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });
    if (inserted.length === 0) return { duplicate: true, handled: event.type };
    if (event.type === "payment_intent.succeeded") {
      const orderId = event.data.object.metadata?.order_id;
      if (!orderId) return { duplicate: false, handled: "ignored" };
      const result = await confirmPaidTx(tx, orderId, "stripe", event.data.object.id);
      if (result.kind === "late") late = result.order;
    }
    return { duplicate: false, handled: event.type };
  });
  if (late) await refundPaymentIntent(cfg.stripe, (late as Order).paymentRef ?? event.data.object.id);
  return outcome;
}

/** Sends money back through Stripe for an order paid there. Test payments have nothing to send. */
export async function refundOnline(cfg: PaymentsConfig, order: Pick<Order, "paymentProvider" | "paymentRef">): Promise<void> {
  if (cfg.provider === "stripe" && order.paymentProvider === "stripe" && order.paymentRef) {
    await refundPaymentIntent(cfg.stripe, order.paymentRef);
  }
}

/**
 * Cancels orders whose payment window has passed: stock goes back on the
 * menu and a reward spent on them is returned. Safe on several API instances
 * at once: each row is claimed with SKIP LOCKED.
 */
export async function expireUnpaid(db: Db, cfg: PaymentsConfig, now = new Date()): Promise<number> {
  const stripeRefs: string[] = [];
  const count = await db.transaction(async (tx) => {
    const due = await tx
      .select({ order: orders, loc: locations })
      .from(orders)
      .innerJoin(locations, eq(locations.id, orders.locationId))
      .where(and(eq(orders.status, "awaiting_payment"), isNotNull(orders.paymentExpiresAt), lt(orders.paymentExpiresAt, now)))
      .orderBy(asc(orders.paymentExpiresAt))
      .limit(50)
      .for("update", { of: orders, skipLocked: true });
    for (const { order, loc } of due) {
      await tx
        .update(orders)
        .set({ status: "cancelled", version: order.version + 1, paymentExpiresAt: null, updatedAt: now })
        .where(eq(orders.id, order.id));
      await tx.insert(orderTransitions).values({
        orderId: order.id,
        fromStatus: "awaiting_payment",
        toStatus: "cancelled",
        actor: "payment:expired",
        device: null,
        actionId: crypto.randomUUID(),
      });
      await tx.update(rewards).set({ redeemedOrderId: null, redeemedAt: null }).where(eq(rewards.redeemedOrderId, order.id));
      const restocked = await restock(tx, loc.id, order.id);
      const ticket = (await loadTicket(tx, order.id))!;
      await enqueue(tx, loc.tenantId, [
        { channel: channels.order(order.id), type: "order.updated", payload: ticket },
        ...restocked.map((change) => ({ channel: channels.menu(loc.id), type: "menu.item_updated" as const, payload: change })),
      ]);
      if (order.paymentProvider === "stripe" && order.paymentRef) stripeRefs.push(order.paymentRef);
    }
    return due.length;
  });
  // Stop a guest paying for an order that no longer exists. If this fails, a
  // late payment is refunded by the webhook instead.
  if (cfg.provider === "stripe") {
    for (const ref of stripeRefs) await cancelPaymentIntent(cfg.stripe, ref).catch(() => {});
  }
  return count;
}
