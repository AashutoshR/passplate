import { asc, eq, inArray, max } from "drizzle-orm";
import { diningTables, orderItems, orders, outbox, users, type Executor } from "@pass/db";
import type { PaymentProvider, TicketView } from "@pass/shared";

/** Loads orders with their items as ticket views, in the order of `ids`. */
export async function loadTickets(db: Executor, ids: string[]): Promise<TicketView[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ order: orders, tableLabel: diningTables.label, driverName: users.name })
    .from(orders)
    .leftJoin(diningTables, eq(diningTables.id, orders.tableId))
    .leftJoin(users, eq(users.id, orders.driverId))
    .where(inArray(orders.id, ids));
  const items = await db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, ids))
    .orderBy(asc(orderItems.position));

  const byId = new Map(
    rows.map(({ order, tableLabel, driverName }) => [
      order.id,
      {
        id: order.id,
        number: order.number,
        type: order.type,
        status: order.status,
        version: order.version,
        customerName: order.customerName,
        tableLabel,
        currency: order.currency,
        subtotalMinor: order.subtotalMinor,
        discountMinor: order.discountMinor,
        deliveryFeeMinor: order.deliveryFeeMinor,
        totalMinor: order.totalMinor,
        paid: order.paidAt !== null,
        payment:
          order.status === "awaiting_payment" && order.paymentExpiresAt
            ? { provider: (order.paymentProvider ?? "test") as PaymentProvider, expiresAt: order.paymentExpiresAt.toISOString() }
            : null,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
        items: [],
        delivery:
          order.type === "delivery" && order.deliveryLat !== null && order.deliveryLng !== null
            ? {
                line1: order.deliveryLine1 ?? "",
                postcode: order.deliveryPostcode ?? "",
                lat: order.deliveryLat,
                lng: order.deliveryLng,
                instructions: order.deliveryInstructions,
                phone: order.phone,
                driverName,
                driver:
                  order.driverLat !== null && order.driverLng !== null && order.driverAt
                    ? { lat: order.driverLat, lng: order.driverLng, at: order.driverAt.toISOString() }
                    : null,
              }
            : null,
      } satisfies TicketView as TicketView,
    ]),
  );
  for (const item of items) {
    byId.get(item.orderId)?.items.push({
      name: item.name,
      quantity: item.quantity,
      modifiers: item.modifiers.map((m) => m.name),
      notes: item.notes,
      lineTotalMinor: item.lineTotalMinor,
    });
  }
  return ids.map((id) => byId.get(id)).filter((t): t is TicketView => Boolean(t));
}

export async function loadTicket(db: Executor, id: string): Promise<TicketView | undefined> {
  return (await loadTickets(db, [id]))[0];
}

/** Highest published event sequence. A snapshot read in the same transaction includes everything up to it. */
export async function currentSeq(db: Executor): Promise<number> {
  const [row] = await db.select({ seq: max(outbox.seq) }).from(outbox);
  return Number(row?.seq ?? 0);
}
