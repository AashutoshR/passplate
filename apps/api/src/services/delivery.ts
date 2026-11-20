import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { driverShifts, locations, orderTransitions, orders, users, type Db, type Tx } from "@pass/db";
import {
  ARRIVING_METRES,
  channels,
  distanceKm,
  ETA_EVERY_MS,
  etaMinutes,
  localDate,
  zonedTime,
  type DeliveryProof,
  type DispatchDriver,
  type DispatchView,
  type DriverLocation,
  type TicketView,
} from "@pass/shared";
import { AppError } from "../errors";
import { enqueue, type OutboxEvent } from "../outbox";
import { currentSeq, loadTicket, loadTickets } from "../views";
import { maybeEarnReward } from "./accounts";
import { straightRoutes, type RoutesProvider } from "./maps";

type Location = typeof locations.$inferSelect;
type Order = typeof orders.$inferSelect;
type Driver = { id: string; name: string };

const NOT_OUT = ["received", "cooking", "ready"] as const;

export interface DriverBoard {
  location: { id: string; name: string; lat: number; lng: number; currency: string };
  onShift: boolean;
  /** Cooking or ready: unassigned ones anyone may take, and ones a dispatcher gave to this driver. */
  waiting: TicketView[];
  /** Out with this driver now. */
  mine: TicketView[];
  seq: number;
}

/** Every change to a delivery tells the kitchen, the guest, the drivers and the dispatch map. */
function deliveryEvents(loc: Location, ticket: TicketView): OutboxEvent[] {
  return [
    { channel: channels.kitchen(loc.id), type: "ticket.updated", payload: ticket },
    { channel: channels.order(ticket.id), type: "order.updated", payload: ticket },
    { channel: channels.drivers(loc.id), type: "delivery.updated", payload: ticket },
  ];
}

/** What a driver needs: deliveries coming up from the kitchen and the ones they are carrying. */
export async function driverBoard(db: Db, loc: Location, driverId: string): Promise<DriverBoard> {
  return db.transaction(
    async (tx) => {
      const seq = await currentSeq(tx);
      const rows = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.locationId, loc.id),
            eq(orders.type, "delivery"),
            or(
              and(inArray(orders.status, [...NOT_OUT]), or(isNull(orders.driverId), eq(orders.driverId, driverId))),
              and(eq(orders.status, "out_for_delivery"), eq(orders.driverId, driverId)),
            ),
          ),
        )
        .orderBy(asc(orders.createdAt));
      const tickets = await loadTickets(tx, rows.map((r) => r.id));
      const [shift] = await tx.select({ on: driverShifts.onShift }).from(driverShifts).where(eq(driverShifts.userId, driverId));
      // Ones given to this driver first.
      const waiting = tickets
        .filter((t) => t.status !== "out_for_delivery")
        .sort((a, b) => Number(b.delivery?.driverId === driverId) - Number(a.delivery?.driverId === driverId));
      return {
        location: { id: loc.id, name: loc.name, lat: loc.lat, lng: loc.lng, currency: loc.currency },
        onShift: shift?.on ?? false,
        waiting,
        mine: tickets.filter((t) => t.status === "out_for_delivery"),
        seq,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Driver goes on or off shift. Only drivers on shift are offered to the dispatcher. */
export async function setShift(db: Db, loc: Location, driver: Driver, on: boolean): Promise<{ onShift: boolean }> {
  return db.transaction(async (tx) => {
    if (!on) {
      const [busy] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.driverId, driver.id), eq(orders.status, "out_for_delivery")))
        .limit(1);
      if (busy) throw new AppError(409, "still_delivering", "Finish the delivery you are on before going off shift");
      // Anything assigned but not collected goes back to the pool.
      await tx
        .update(orders)
        .set({ driverId: null, assignedAt: null, updatedAt: new Date() })
        .where(and(eq(orders.driverId, driver.id), inArray(orders.status, [...NOT_OUT])));
    }
    await tx
      .insert(driverShifts)
      .values({ userId: driver.id, locationId: loc.id, onShift: on, lat: loc.lat, lng: loc.lng, positionAt: new Date() })
      .onConflictDoUpdate({
        target: driverShifts.userId,
        // Coming on shift starts at the restaurant; going off keeps the last position.
        set: on ? { onShift: true, locationId: loc.id, lat: loc.lat, lng: loc.lng, positionAt: new Date(), updatedAt: new Date() } : { onShift: false, updatedAt: new Date() },
      });
    await enqueue(tx, loc.tenantId, [
      { channel: channels.dispatch(loc.id), type: "driver.shift", payload: { driverId: driver.id, name: driver.name, onShift: on } },
    ]);
    return { onShift: on };
  });
}

async function lockDelivery(tx: Tx, loc: Location, orderId: string): Promise<Order> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.locationId, loc.id), eq(orders.type, "delivery")))
    .for("update");
  if (!order) throw new AppError(404, "order_not_found", "Delivery not found");
  return order;
}

/** FR-15: a dispatcher gives a delivery to a driver before it leaves the kitchen. */
export async function assignDelivery(db: Db, loc: Location, orderId: string, driverId: string, by: Driver): Promise<TicketView> {
  return db.transaction(async (tx) => {
    const order = await lockDelivery(tx, loc, orderId);
    if (!(NOT_OUT as readonly string[]).includes(order.status)) {
      throw new AppError(409, "stale_status", "This delivery has already left");
    }
    const [driver] = await tx
      .select({ id: users.id, name: users.name, onShift: driverShifts.onShift })
      .from(users)
      .leftJoin(driverShifts, eq(driverShifts.userId, users.id))
      .where(and(eq(users.id, driverId), eq(users.role, "driver"), eq(users.locationId, loc.id)));
    if (!driver) throw new AppError(404, "driver_not_found", "No such driver here");
    if (!driver.onShift) throw new AppError(409, "not_on_shift", `${driver.name} is not on shift`);
    await tx
      .update(orders)
      .set({ driverId, assignedAt: new Date(), version: order.version + 1, updatedAt: new Date() })
      .where(eq(orders.id, orderId));
    void by;
    const ticket = (await loadTicket(tx, orderId))!;
    await enqueue(tx, loc.tenantId, deliveryEvents(loc, ticket));
    return ticket;
  });
}

/** The driver collects the food and sets off (FR-16). */
export async function takeDelivery(
  db: Db,
  loc: Location,
  orderId: string,
  driver: Driver,
  routes: RoutesProvider = straightRoutes,
): Promise<TicketView> {
  const ticket = await db.transaction(async (tx) => {
    const order = await lockDelivery(tx, loc, orderId);
    if (order.status !== "ready") {
      throw new AppError(409, "stale_status", order.status === "out_for_delivery" ? "Someone else has taken this delivery" : "The kitchen has not finished it yet");
    }
    if (order.driverId && order.driverId !== driver.id) {
      throw new AppError(409, "assigned_elsewhere", "This delivery was given to another driver");
    }
    const now = new Date();
    await tx
      .update(orders)
      .set({
        status: "out_for_delivery",
        version: order.version + 1,
        updatedAt: now,
        driverId: driver.id,
        assignedAt: order.assignedAt ?? now,
        pickedUpAt: now,
        driverLat: loc.lat,
        driverLng: loc.lng,
        driverAt: now,
        arrivingAt: null,
      })
      .where(eq(orders.id, orderId));
    await tx.insert(orderTransitions).values({
      orderId,
      fromStatus: "ready",
      toStatus: "out_for_delivery",
      actor: `driver:${driver.name}`,
      device: "driver",
      actionId: randomUUID(),
    });
    const t = (await loadTicket(tx, orderId))!;
    await enqueue(tx, loc.tenantId, deliveryEvents(loc, t));
    return t;
  });
  // The route is asked for once, after the commit, so a slow map service never holds a lock.
  return (await planRoute(db, loc, orderId, routes)) ?? ticket;
}

/** Fetches the road route once and keeps it on the order (NFR-20). */
export async function planRoute(db: Db, loc: Location, orderId: string, routes: RoutesProvider): Promise<TicketView | null> {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!o || o.status !== "out_for_delivery" || o.deliveryLat === null || o.deliveryLng === null) return null;
  const plan = await routes.route({ lat: loc.lat, lng: loc.lng }, { lat: o.deliveryLat, lng: o.deliveryLng });
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(orders)
      .set({
        routeProvider: plan.provider,
        routePolyline: plan.polyline,
        routeDistanceM: plan.distanceM,
        routeDurationS: plan.durationS,
        etaAt: new Date(now.getTime() + plan.durationS * 1000),
        etaUpdatedAt: now,
      })
      .where(and(eq(orders.id, orderId), eq(orders.status, "out_for_delivery")))
      .returning({ id: orders.id });
    if (!row) return null;
    const t = (await loadTicket(tx, orderId))!;
    await enqueue(tx, loc.tenantId, deliveryEvents(loc, t));
    return t;
  });
}

/** Dropped off, with proof: how it was left and where the phone was (FR-16). */
export async function completeDelivery(
  db: Db,
  loc: Location,
  orderId: string,
  driver: Driver,
  proof: { proof: DeliveryProof; note?: string; lat?: number; lng?: number } = { proof: "handed_over" },
): Promise<TicketView> {
  return db.transaction(async (tx) => {
    const order = await lockDelivery(tx, loc, orderId);
    if (order.status !== "out_for_delivery") throw new AppError(409, "stale_status", "This delivery is not out with you");
    if (order.driverId !== driver.id) throw new AppError(403, "forbidden", "This delivery is with another driver");
    const now = new Date();
    const lat = proof.lat ?? order.driverLat;
    const lng = proof.lng ?? order.driverLng;
    await tx
      .update(orders)
      .set({
        status: "delivered",
        version: order.version + 1,
        updatedAt: now,
        deliveredAt: now,
        etaAt: null,
        proofKind: proof.proof,
        proofNote: proof.note?.trim() || null,
        proofLat: lat,
        proofLng: lng,
      })
      .where(eq(orders.id, orderId));
    await tx.insert(orderTransitions).values({
      orderId,
      fromStatus: "out_for_delivery",
      toStatus: "delivered",
      actor: `driver:${driver.name}`,
      device: "driver",
      actionId: randomUUID(),
    });
    // An idle driver's position is where the last drop-off was.
    if (lat !== null && lng !== null) {
      await tx.update(driverShifts).set({ lat, lng, positionAt: now, updatedAt: now }).where(eq(driverShifts.userId, driver.id));
    }
    await maybeEarnReward(tx, order.userId, orderId);
    const ticket = (await loadTicket(tx, orderId))!;
    await enqueue(tx, loc.tenantId, deliveryEvents(loc, ticket));
    return ticket;
  });
}

/**
 * A position from the driver's phone, passed on to the guest's map and the
 * dispatch map. Within 200 m of the door the guest is told the driver is
 * nearly there (FR-18). The ETA is worked out again at most every 30 s (NFR-20).
 */
export async function updateDriverLocation(
  db: Db,
  loc: Location,
  orderId: string,
  driverId: string,
  pos: { lat: number; lng: number },
): Promise<DriverLocation> {
  return db.transaction(async (tx) => {
    const at = new Date();
    const order = await lockDelivery(tx, loc, orderId);
    if (order.driverId !== driverId || order.status !== "out_for_delivery") {
      throw new AppError(409, "not_out", "This delivery is not out with you");
    }
    const home = { lat: order.deliveryLat!, lng: order.deliveryLng! };
    const left = distanceKm(pos, home);
    const arrivingNow = !order.arrivingAt && left * 1000 <= ARRIVING_METRES;
    const etaDue = !order.etaUpdatedAt || at.getTime() - order.etaUpdatedAt.getTime() >= ETA_EVERY_MS || arrivingNow;
    let etaAt = order.etaAt;
    if (etaDue) {
      const route =
        order.routeDistanceM && order.routeDurationS
          ? { distanceM: order.routeDistanceM, durationS: order.routeDurationS, straightKm: distanceKm(loc, home) }
          : null;
      etaAt = new Date(at.getTime() + etaMinutes(left, route) * 60_000);
    }
    await tx
      .update(orders)
      .set({
        driverLat: pos.lat,
        driverLng: pos.lng,
        driverAt: at,
        ...(etaDue ? { etaAt, etaUpdatedAt: at } : {}),
        ...(arrivingNow ? { arrivingAt: at, updatedAt: at } : {}),
      })
      .where(eq(orders.id, orderId));
    await tx.update(driverShifts).set({ lat: pos.lat, lng: pos.lng, positionAt: at }).where(eq(driverShifts.userId, driverId));
    const payload: DriverLocation = {
      orderId,
      driverId,
      lat: pos.lat,
      lng: pos.lng,
      at: at.toISOString(),
      etaAt: etaAt ? etaAt.toISOString() : null,
      arriving: Boolean(order.arrivingAt) || arrivingNow,
    };
    const events: OutboxEvent[] = [
      { channel: channels.order(orderId), type: "order.driver_location", payload },
      { channel: channels.dispatch(loc.id), type: "driver.location", payload },
    ];
    if (arrivingNow) {
      const ticket = (await loadTicket(tx, orderId))!;
      events.push(...deliveryEvents(loc, ticket));
    }
    await enqueue(tx, loc.tenantId, events);
    return payload;
  });
}

/**
 * FR-14: the dispatch map. Every delivery not yet out, every one on the road,
 * today's finished ones with their proof, and every driver with where they are.
 */
export async function dispatchBoard(db: Db, loc: Location, now = new Date()): Promise<DispatchView> {
  return db.transaction(
    async (tx) => {
      const seq = await currentSeq(tx);
      const dayStart = zonedTime(localDate(loc.timezone, now), "00:00", loc.timezone);
      const active = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.locationId, loc.id),
            eq(orders.type, "delivery"),
            inArray(orders.status, [...NOT_OUT, "out_for_delivery"]),
          ),
        )
        .orderBy(asc(orders.createdAt));
      const done = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.locationId, loc.id), eq(orders.type, "delivery"), gte(orders.deliveredAt, dayStart)))
        .orderBy(desc(orders.deliveredAt))
        .limit(60);
      const tickets = await loadTickets(tx, active.map((r) => r.id));
      const delivered = await loadTickets(tx, done.map((r) => r.id));

      const people = await tx
        .select({ id: users.id, name: users.name, shift: driverShifts })
        .from(users)
        .leftJoin(driverShifts, eq(driverShifts.userId, users.id))
        .where(and(eq(users.role, "driver"), eq(users.locationId, loc.id)))
        .orderBy(asc(users.name));

      const drivers: DispatchDriver[] = people.map((p) => {
        const carrying = tickets.filter((t) => t.status === "out_for_delivery" && t.delivery?.driverId === p.id);
        const assigned = tickets.filter((t) => t.status !== "out_for_delivery" && t.delivery?.driverId === p.id);
        const live = carrying[0]?.delivery?.driver;
        const position = live ?? (p.shift?.lat != null && p.shift.lng != null && p.shift.positionAt
          ? { lat: p.shift.lat, lng: p.shift.lng, at: p.shift.positionAt.toISOString() }
          : null);
        // Minutes until they could collect from the restaurant again.
        let back = 0;
        if (carrying.length > 0) {
          const last = carrying[carrying.length - 1]!.delivery!;
          const toDoor = last.etaAt ? Math.max(0, (Date.parse(last.etaAt) - now.getTime()) / 60_000) : etaMinutes(distanceKm(position ?? loc, last), null);
          back = Math.round(toDoor + etaMinutes(distanceKm(last, loc), null));
        } else if (position && distanceKm(position, loc) > 0.15) {
          back = etaMinutes(distanceKm(position, loc), null);
        }
        return {
          id: p.id,
          name: p.name,
          onShift: p.shift?.onShift ?? false,
          position,
          carrying: carrying.map((t) => t.id),
          assigned: assigned.map((t) => t.id),
          deliveredToday: delivered.filter((t) => t.delivery?.driverId === p.id).length,
          backInMinutes: back,
        };
      });
      // Best first: back soonest, fewest already waiting on them.
      const suggested = drivers
        .filter((d) => d.onShift)
        .sort((a, b) => a.backInMinutes + a.assigned.length * 12 - (b.backInMinutes + b.assigned.length * 12) || a.name.localeCompare(b.name))
        .map((d) => d.id);

      return {
        location: { id: loc.id, name: loc.name, lat: loc.lat, lng: loc.lng, currency: loc.currency, timezone: loc.timezone },
        waiting: tickets.filter((t) => t.status !== "out_for_delivery"),
        onTheRoad: tickets.filter((t) => t.status === "out_for_delivery"),
        delivered,
        drivers,
        suggested,
        seq,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
