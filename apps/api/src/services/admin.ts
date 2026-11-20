import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { locations, orderItems, orders, reservations, type Db } from "@pass/db";
import { localDate, zonedTime, type AdminOverview } from "@pass/shared";
import { takings } from "./payments";

type Location = typeof locations.$inferSelect;

/** The admin's first screen: today at a glance, two weeks of takings, what sells. */
export async function adminOverview(db: Db, loc: Location, now = new Date()): Promise<AdminOverview> {
  const today = localDate(loc.timezone, now);
  const dayStart = zonedTime(today, "00:00", loc.timezone);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const revenue = await takings(db, loc.id, dayStart, dayEnd);
  const [counts] = await db
    .select({
      orders: sql<number>`count(*) filter (where ${orders.status} not in ('cancelled', 'awaiting_payment'))::int`,
      deliveries: sql<number>`count(*) filter (where ${orders.type} = 'delivery' and ${orders.status} not in ('cancelled', 'awaiting_payment'))::int`,
      paidTotal: sql<number>`coalesce(sum(${orders.totalMinor}) filter (where ${orders.status} not in ('cancelled', 'awaiting_payment')), 0)::int`,
    })
    .from(orders)
    .where(and(eq(orders.locationId, loc.id), gte(orders.createdAt, dayStart), lt(orders.createdAt, dayEnd)));
  const [booked] = await db
    .select({
      bookings: sql<number>`count(*)::int`,
      covers: sql<number>`coalesce(sum(${reservations.partySize}), 0)::int`,
    })
    .from(reservations)
    .where(
      and(
        eq(reservations.locationId, loc.id),
        gte(reservations.startsAt, dayStart),
        lt(reservations.startsAt, dayEnd),
        inArray(reservations.status, ["booked", "seated", "completed"]),
      ),
    );

  const from = new Date(dayStart.getTime() - 13 * 86_400_000);
  const daily = await db.execute<{ day: string; revenue: number; orders: number }>(sql`
    select to_char(p.created_at at time zone ${loc.timezone}, 'YYYY-MM-DD') as day,
      sum(case when p.kind = 'refund' then -p.amount_minor else p.amount_minor end)::int as revenue,
      count(distinct p.order_id) filter (where p.kind = 'payment')::int as orders
    from payments p
    where p.location_id = ${loc.id} and p.created_at >= ${from.toISOString()}::timestamptz and p.created_at < ${dayEnd.toISOString()}::timestamptz
    group by 1
  `);
  const byDay = new Map([...daily].map((d) => [d.day, d]));
  const days = Array.from({ length: 14 }, (_, i) => {
    const date = localDate(loc.timezone, new Date(from.getTime() + i * 86_400_000 + 12 * 3_600_000));
    const d = byDay.get(date);
    return { date, revenueMinor: d?.revenue ?? 0, orders: d?.orders ?? 0 };
  });

  const top = await db
    .select({
      name: orderItems.name,
      quantity: sql<number>`sum(${orderItems.quantity})::int`,
      revenue: sql<number>`sum(${orderItems.lineTotalMinor})::int`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(eq(orders.locationId, loc.id), gte(orders.createdAt, from), sql`${orders.status} not in ('cancelled', 'awaiting_payment')`))
    .groupBy(orderItems.name)
    .orderBy(sql`sum(${orderItems.quantity}) desc`)
    .limit(8);

  const orderCount = counts?.orders ?? 0;
  return {
    location: { id: loc.id, slug: loc.slug, name: loc.name, currency: loc.currency, timezone: loc.timezone },
    today: {
      revenueMinor: revenue,
      orders: orderCount,
      averageMinor: orderCount ? Math.round((counts?.paidTotal ?? 0) / orderCount) : 0,
      covers: booked?.covers ?? 0,
      bookings: booked?.bookings ?? 0,
      deliveries: counts?.deliveries ?? 0,
    },
    days,
    topItems: top.map((t) => ({ name: t.name, quantity: t.quantity, revenueMinor: t.revenue })),
  };
}
