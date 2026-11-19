import { z } from "zod";

/**
 * Realtime protocol between browsers and the gateway.
 *
 * Every event carries a global, gap-free `seq` assigned by the outbox relay.
 * A client remembers the last seq it applied and sends it as `since` when it
 * reconnects, so the gateway can replay anything it missed (NFR-7).
 */

export const CHANNEL_PATTERN = /^(kitchen|menu|order|floor|admin|availability|drivers):[0-9a-f-]{36}$/;

/**
 * kitchen, floor and drivers need staff; admin needs an admin. menu, order and
 * availability are public: order ids are unguessable and availability carries
 * no personal data.
 */
export const channels = {
  kitchen: (locationId: string) => `kitchen:${locationId}`,
  menu: (locationId: string) => `menu:${locationId}`,
  order: (orderId: string) => `order:${orderId}`,
  floor: (locationId: string) => `floor:${locationId}`,
  admin: (locationId: string) => `admin:${locationId}`,
  availability: (locationId: string) => `availability:${locationId}`,
  drivers: (locationId: string) => `drivers:${locationId}`,
};

export const EVENT_TYPES = [
  "ticket.created",
  "ticket.updated",
  "order.updated",
  "menu.item_updated",
  "floor.table",
  "floor.waitlist",
  "floor.reservation",
  "availability.changed",
  "payment.recorded",
  "order.driver_location",
  "delivery.updated",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventEnvelope<P = unknown> {
  op: "event";
  seq: number;
  channel: string;
  type: EventType;
  payload: P;
  at: string;
}

export const ClientMessageSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("subscribe"),
    channels: z.array(z.string().regex(CHANNEL_PATTERN)).min(1).max(20),
    since: z.number().int().min(0).optional(),
    token: z.string().max(200).optional(),
  }),
  z.object({ op: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerMessage =
  | EventEnvelope
  | { op: "subscribed"; channels: string[]; seq: number; live: boolean }
  | { op: "pong"; at: string }
  /** Too much was missed to replay. Fetch a fresh snapshot, then subscribe again. */
  | { op: "resync"; reason: string }
  /** Live delivery is paused (Redis down). Fall back to polling until "live". */
  | { op: "degraded" }
  | { op: "live" }
  /** This instance is shutting down. Reconnect after the given delay. */
  | { op: "draining"; reconnectInMs: number }
  | { op: "error"; code: string; message: string };

/** Full jitter backoff (NFR-8): spreads reconnects so clients do not stampede. */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 15_000): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 10));
  return Math.floor(Math.random() * cap);
}
