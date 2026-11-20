import { outbox, type Tx } from "@pass/db";
import type { EventType } from "@pass/shared";

export interface OutboxEvent {
  channel: string;
  type: EventType;
  payload: unknown;
}

/**
 * Writes events in the caller's transaction (NFR-12). The relay finds them by
 * polling the small index of unpublished rows every few milliseconds.
 *
 * This used to call pg_notify to wake the relay. Under the design load that
 * was the bottleneck: Postgres takes one global lock to commit any
 * transaction that sent a NOTIFY, so every order in the building queued at
 * COMMIT behind every other (16 waiting at once in the load test, orders
 * taking 10 s). Polling costs one indexed query every 20 ms instead.
 */
export async function enqueue(tx: Tx, tenantId: string, events: OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.insert(outbox).values(events.map((e) => ({ tenantId, ...e })));
}
