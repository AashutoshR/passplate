import { sql } from "drizzle-orm";
import type { Executor } from "./client";

/**
 * Order numbers come from a Postgres sequence per restaurant.
 *
 * They used to be a counter column on the restaurant's row. Every order
 * updated that one row, so under load every order queued for its lock and
 * for the disk flush of the order before it. nextval() takes no row lock and
 * never waits for a commit, so it stays fast however many orders arrive.
 * Like any sequence, a failed order attempt can skip a number.
 */
export function orderNumberSequence(locationId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(locationId)) throw new Error("Not a location id");
  return `order_number_${locationId.replaceAll("-", "")}`;
}

export async function createOrderNumberSequence(db: Executor, locationId: string, start = 1): Promise<void> {
  await db.execute(sql.raw(`create sequence if not exists "${orderNumberSequence(locationId)}" start ${Math.max(1, Math.floor(start))}`));
}

export async function nextOrderNumber(db: Executor, locationId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`select nextval(${orderNumberSequence(locationId)}::regclass)::int as n`);
  return rows[0]!.n;
}

/** Moves the sequence on, so the next order gets `next`. */
export async function setNextOrderNumber(db: Executor, locationId: string, next: number): Promise<void> {
  await db.execute(sql`select setval(${orderNumberSequence(locationId)}::regclass, ${Math.max(1, next)}, false)`);
}

/** Removes the sequences of every restaurant. Used when the demo data is wiped. */
export async function dropOrderNumberSequences(db: Executor): Promise<void> {
  await db.execute(sql`
    do $$ declare s record; begin
      for s in select sequencename from pg_sequences where schemaname = 'public' and sequencename like 'order_number_%' loop
        execute format('drop sequence %I', s.sequencename);
      end loop;
    end $$
  `);
}
