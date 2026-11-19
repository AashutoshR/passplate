import { sql } from "drizzle-orm";
import { outbox, type Tx } from "@pass/db";
import type { EventType } from "@pass/shared";

export interface OutboxEvent {
  channel: string;
  type: EventType;
  payload: unknown;
}

/**
 * Writes events in the caller's transaction (NFR-12) and wakes the relay.
 * pg_notify is only delivered if the transaction commits, so an event is
 * never announced for a change that rolled back.
 */
export async function enqueue(tx: Tx, tenantId: string, events: OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  await tx.insert(outbox).values(events.map((e) => ({ tenantId, ...e })));
  await tx.execute(sql`select pg_notify('outbox', '')`);
}
