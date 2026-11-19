import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { locations, menuItems, orderItems, orderTransitions, orders, type Db } from "@pass/db";
import { maybeEarnReward } from "./accounts";
import { tableEvents } from "./floor";
import { refundOrder } from "./payments";
import {
  ACTIVE_STATUSES,
  canTransition,
  channels,
  type KitchenSnapshot,
  type StockChange,
  type TicketView,
  type TransitionInput,
} from "@pass/shared";
import { AppError, isUniqueViolation } from "../errors";
import { enqueue, type OutboxEvent } from "../outbox";
import { currentSeq, loadTicket, loadTickets } from "../views";

export type KitchenLocation = typeof locations.$inferSelect;

/** Active tickets plus the sequence they are consistent with. */
export async function kitchenSnapshot(db: Db, loc: KitchenLocation): Promise<KitchenSnapshot> {
  return db.transaction(
    async (tx) => {
      const seq = await currentSeq(tx);
      const active = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.locationId, loc.id), inArray(orders.status, [...ACTIVE_STATUSES])))
        .orderBy(asc(orders.createdAt));
      const tickets = await loadTickets(
        tx,
        active.map((o) => o.id),
      );
      return {
        location: {
          id: loc.id,
          slug: loc.slug,
          name: loc.name,
          targetPrepSeconds: loc.targetPrepSeconds,
          currency: loc.currency,
        },
        tickets,
        seq,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export interface TransitionResult {
  ticket: TicketView;
  replayed: boolean;
}

/**
 * FR-11 and FR-13. The change only applies if the ticket is still in `from`,
 * and an `actionId` seen before returns the current ticket instead of acting
 * twice, so an offline queue can replay its taps safely.
 */
export async function transitionTicket(
  db: Db,
  loc: KitchenLocation,
  orderId: string,
  input: TransitionInput,
  actor: string,
): Promise<TransitionResult> {
  try {
    return await db.transaction(async (tx) => {
      const [seen] = await tx
        .select({ id: orderTransitions.id })
        .from(orderTransitions)
        .where(eq(orderTransitions.actionId, input.actionId));
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.locationId, loc.id)))
        .for("update");
      if (!order) throw new AppError(404, "order_not_found", "Ticket not found");
      if (seen) return { ticket: (await loadTicket(tx, orderId))!, replayed: true };

      if (order.status !== input.from) {
        // Someone else already made the same move: treat it as done.
        if (order.status === input.to) return { ticket: (await loadTicket(tx, orderId))!, replayed: true };
        throw new AppError(409, "stale_status", "This ticket was changed on another screen", {
          current: await loadTicket(tx, orderId),
        });
      }
      if (!canTransition(order.type, input.from, input.to)) {
        throw new AppError(422, "invalid_transition", `A ticket cannot go from ${input.from} to ${input.to}`);
      }

      await tx
        .update(orders)
        .set({ status: input.to, version: order.version + 1, updatedAt: new Date() })
        .where(eq(orders.id, orderId));
      await tx.insert(orderTransitions).values({
        orderId,
        fromStatus: input.from,
        toStatus: input.to,
        actor,
        device: input.device ?? null,
        actionId: input.actionId,
      });

      const restocked = input.to === "cancelled" ? await restock(tx, loc.id, orderId) : [];
      const extra: OutboxEvent[] = [];
      if (input.to === "completed" || input.to === "delivered") await maybeEarnReward(tx, order.userId, orderId);
      if (input.to === "cancelled") extra.push(...(await refundOrder(tx, loc, order, null)));
      if (order.tableId) extra.push(...(await tableEvents(tx, loc, [order.tableId])));
      const ticket = (await loadTicket(tx, orderId))!;
      if (order.type === "delivery") {
        extra.push({ channel: channels.drivers(loc.id), type: "delivery.updated", payload: ticket });
      }
      const events: OutboxEvent[] = [
        { channel: channels.kitchen(loc.id), type: "ticket.updated", payload: ticket },
        { channel: channels.order(orderId), type: "order.updated", payload: ticket },
        ...extra,
        ...restocked.map((change) => ({
          channel: channels.menu(loc.id),
          type: "menu.item_updated" as const,
          payload: change,
        })),
      ];
      await enqueue(tx, loc.tenantId, events);
      return { ticket, replayed: false };
    });
  } catch (err) {
    // Two replays of one action raced: the loser hits the unique actionId.
    if (isUniqueViolation(err)) {
      const ticket = await loadTicket(db, orderId);
      if (ticket) return { ticket, replayed: true };
    }
    throw err;
  }
}

/** A cancelled order gives its counted portions back. */
async function restock(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  locationId: string,
  orderId: string,
): Promise<StockChange[]> {
  const lines = await tx
    .select({ menuItemId: orderItems.menuItemId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  const qty = new Map<string, number>();
  for (const l of lines) qty.set(l.menuItemId, (qty.get(l.menuItemId) ?? 0) + l.quantity);

  const changes: StockChange[] = [];
  for (const id of [...qty.keys()].sort()) {
    const [row] = await tx
      .update(menuItems)
      .set({ stock: sql`${menuItems.stock} + ${qty.get(id)!}`, updatedAt: new Date() })
      .where(
        and(eq(menuItems.id, id), eq(menuItems.locationId, locationId), sql`${menuItems.stock} is not null`),
      )
      .returning({ id: menuItems.id, stock: menuItems.stock, soldOut: menuItems.soldOut });
    if (row) changes.push(row);
  }
  return changes;
}
