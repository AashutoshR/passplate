import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { locations, orderTransitions, orders, type Db } from "@pass/db";
import { channels, type DriverLocation, type TicketView } from "@pass/shared";
import { AppError } from "../errors";
import { enqueue } from "../outbox";
import { currentSeq, loadTicket, loadTickets } from "../views";
import { maybeEarnReward } from "./accounts";

type Location = typeof locations.$inferSelect;

export interface DriverBoard {
  location: { id: string; name: string; lat: number; lng: number; currency: string };
  /** Cooking or ready, waiting for someone to take them. */
  waiting: TicketView[];
  /** Out with this driver now. */
  mine: TicketView[];
  seq: number;
}

/** What a driver needs: deliveries coming up from the kitchen and the ones they are carrying. */
export async function driverBoard(db: Db, loc: Location, driverId: string): Promise<DriverBoard> {
  return db.transaction(
    async (tx) => {
      const seq = await currentSeq(tx);
      const rows = await tx
        .select({ id: orders.id, status: orders.status, driverId: orders.driverId })
        .from(orders)
        .where(
          and(
            eq(orders.locationId, loc.id),
            eq(orders.type, "delivery"),
            or(
              inArray(orders.status, ["received", "cooking", "ready"]),
              and(eq(orders.status, "out_for_delivery"), eq(orders.driverId, driverId)),
            ),
          ),
        )
        .orderBy(asc(orders.createdAt));
      const tickets = await loadTickets(tx, rows.map((r) => r.id));
      return {
        location: { id: loc.id, name: loc.name, lat: loc.lat, lng: loc.lng, currency: loc.currency },
        waiting: tickets.filter((t) => t.status !== "out_for_delivery"),
        mine: tickets.filter((t) => t.status === "out_for_delivery"),
        seq,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function move(
  db: Db,
  loc: Location,
  orderId: string,
  from: "ready" | "out_for_delivery",
  to: "out_for_delivery" | "delivered",
  driver: { id: string; name: string },
): Promise<TicketView> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.locationId, loc.id), eq(orders.type, "delivery")))
      .for("update");
    if (!order) throw new AppError(404, "order_not_found", "Delivery not found");
    if (order.status !== from) {
      throw new AppError(409, "stale_status", from === "ready" ? "Someone else has taken this delivery" : "This delivery is not out with you");
    }
    if (from === "out_for_delivery" && order.driverId !== driver.id) {
      throw new AppError(403, "forbidden", "This delivery is with another driver");
    }
    await tx
      .update(orders)
      .set({
        status: to,
        version: order.version + 1,
        updatedAt: new Date(),
        ...(to === "out_for_delivery" ? { driverId: driver.id, driverLat: loc.lat, driverLng: loc.lng, driverAt: new Date() } : {}),
      })
      .where(eq(orders.id, orderId));
    await tx.insert(orderTransitions).values({
      orderId,
      fromStatus: from,
      toStatus: to,
      actor: `driver:${driver.name}`,
      device: "driver",
      actionId: randomUUID(),
    });
    if (to === "delivered") await maybeEarnReward(tx, order.userId, orderId);
    const ticket = (await loadTicket(tx, orderId))!;
    await enqueue(tx, loc.tenantId, [
      { channel: channels.kitchen(loc.id), type: "ticket.updated", payload: ticket },
      { channel: channels.order(orderId), type: "order.updated", payload: ticket },
      { channel: channels.drivers(loc.id), type: "delivery.updated", payload: ticket },
    ]);
    return ticket;
  });
}

export const takeDelivery = (db: Db, loc: Location, orderId: string, driver: { id: string; name: string }) =>
  move(db, loc, orderId, "ready", "out_for_delivery", driver);

export const completeDelivery = (db: Db, loc: Location, orderId: string, driver: { id: string; name: string }) =>
  move(db, loc, orderId, "out_for_delivery", "delivered", driver);

/** A position from the driver's phone, passed straight on to the guest's map. */
export async function updateDriverLocation(
  db: Db,
  loc: Location,
  orderId: string,
  driverId: string,
  pos: { lat: number; lng: number },
): Promise<DriverLocation> {
  return db.transaction(async (tx) => {
    const at = new Date();
    const [row] = await tx
      .update(orders)
      .set({ driverLat: pos.lat, driverLng: pos.lng, driverAt: at })
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.locationId, loc.id),
          eq(orders.driverId, driverId),
          eq(orders.status, "out_for_delivery"),
        ),
      )
      .returning({ id: orders.id });
    if (!row) throw new AppError(409, "not_out", "This delivery is not out with you");
    const payload: DriverLocation = { orderId, lat: pos.lat, lng: pos.lng, at: at.toISOString() };
    await enqueue(tx, loc.tenantId, [{ channel: channels.order(orderId), type: "order.driver_location", payload }]);
    return payload;
  });
}
