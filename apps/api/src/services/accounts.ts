import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { orders, reservations, rewards, users, diningTables, type Db, type Executor } from "@pass/db";
import {
  REWARD_CAP_MINOR,
  REWARD_EVERY,
  REWARD_PERCENT,
  type CreateStaffInput,
  type GuestView,
  type RegisterInput,
  type ReservationView,
  type RewardsView,
  type StaffMemberView,
  type UserView,
} from "@pass/shared";
import { toUserView } from "../auth";
import { AppError, isUniqueViolation } from "../errors";
import { reservationView } from "./booking";

export async function register(db: Db, input: RegisterInput): Promise<UserView> {
  try {
    const [row] = await db
      .insert(users)
      .values({
        name: input.name,
        email: input.email,
        phone: input.phone || null,
        passwordHash: await Bun.password.hash(input.password),
        role: "customer",
      })
      .returning();
    return toUserView(row!);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "email_taken", "There is already an account with that email. Try signing in.");
    }
    throw err;
  }
}

export async function findByEmail(db: Db, email: string) {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row;
}

export const COUNTED_STATUSES = ["completed", "delivered"] as const;

export async function rewardsFor(db: Executor, userId: string): Promise<RewardsView> {
  const [done] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.userId, userId), inArray(orders.status, [...COUNTED_STATUSES])));
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(rewards)
    .where(and(eq(rewards.userId, userId), isNull(rewards.redeemedOrderId)));
  const completed = done?.n ?? 0;
  return {
    completedOrders: completed,
    stamps: completed % REWARD_EVERY,
    available: open?.n ?? 0,
    every: REWARD_EVERY,
    percent: REWARD_PERCENT,
    capMinor: REWARD_CAP_MINOR,
  };
}

/**
 * Called in the transaction that finishes an order. Every eighth finished
 * order earns a reward; the unique earned_order_id makes it happen once.
 */
export async function maybeEarnReward(tx: Executor, userId: string | null, orderId: string): Promise<boolean> {
  if (!userId) return false;
  const [done] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.userId, userId), inArray(orders.status, [...COUNTED_STATUSES])));
  if (!done || done.n === 0 || done.n % REWARD_EVERY !== 0) return false;
  const inserted = await tx
    .insert(rewards)
    .values({ userId, earnedOrderId: orderId })
    .onConflictDoNothing()
    .returning({ id: rewards.id });
  return inserted.length > 0;
}

export interface MyOrder {
  id: string;
  number: number;
  type: string;
  status: string;
  totalMinor: number;
  discountMinor: number;
  currency: string;
  createdAt: string;
  items: number;
}

export async function myOrders(db: Db, userId: string): Promise<MyOrder[]> {
  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      type: orders.type,
      status: orders.status,
      totalMinor: orders.totalMinor,
      discountMinor: orders.discountMinor,
      currency: orders.currency,
      createdAt: orders.createdAt,
      items: sql<number>`(select coalesce(sum(oi.quantity), 0)::int from order_items oi where oi.order_id = "orders"."id")`,
    })
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt))
    .limit(50);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function myReservations(db: Db, userId: string): Promise<ReservationView[]> {
  const rows = await db
    .select({ r: reservations, tableLabel: diningTables.label })
    .from(reservations)
    .leftJoin(diningTables, eq(diningTables.id, reservations.tableId))
    .where(eq(reservations.userId, userId))
    .orderBy(desc(reservations.startsAt))
    .limit(30);
  return rows.map(({ r, tableLabel }) => reservationView(r, tableLabel));
}

export async function listStaff(db: Db, locationId: string): Promise<StaffMemberView[]> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.locationId, locationId), inArray(users.role, ["staff", "driver", "admin"])))
    .orderBy(users.name);
  return rows.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role as StaffMemberView["role"],
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  }));
}

export async function createStaff(db: Db, locationId: string, input: CreateStaffInput): Promise<StaffMemberView> {
  try {
    const [u] = await db
      .insert(users)
      .values({
        name: input.name,
        email: input.email,
        passwordHash: await Bun.password.hash(input.password),
        role: input.role,
        locationId,
      })
      .returning();
    return {
      id: u!.id,
      name: u!.name,
      email: u!.email,
      role: input.role,
      createdAt: u!.createdAt.toISOString(),
      lastLoginAt: null,
    };
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, "email_taken", "Someone already uses that email");
    throw err;
  }
}

export async function removeStaff(db: Db, locationId: string, userId: string, actingId: string): Promise<void> {
  if (userId === actingId) throw new AppError(422, "self", "You cannot remove your own account");
  // Keep the row for the audit trail; turn it into a customer with no access.
  const [row] = await db
    .update(users)
    .set({ role: "customer", locationId: null })
    .where(and(eq(users.id, userId), eq(users.locationId, locationId)))
    .returning({ id: users.id });
  if (!row) throw new AppError(404, "not_found", "No such member of staff");
}

export async function listGuests(db: Db, locationId: string): Promise<GuestView[]> {
  const rows = await db.execute<{
    id: string;
    name: string;
    email: string;
    completed: number;
    spent: number;
    last_order_at: Date | null;
    open_rewards: number;
  }>(sql`
    select u.id, u.name, u.email,
      count(o.id) filter (where o.status in ('completed', 'delivered'))::int as completed,
      coalesce(sum(o.total_minor) filter (where o.status in ('completed', 'delivered')), 0)::int as spent,
      max(o.created_at) as last_order_at,
      (select count(*)::int from rewards r where r.user_id = u.id and r.redeemed_order_id is null) as open_rewards
    from users u
    left join orders o on o.user_id = u.id and o.location_id = ${locationId}
    where u.role = 'customer'
    group by u.id
    order by max(o.created_at) desc nulls last, u.created_at desc
    limit 200
  `);
  return [...rows].map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    completedOrders: r.completed,
    rewardsAvailable: r.open_rewards,
    spentMinor: r.spent,
    lastOrderAt: r.last_order_at ? new Date(r.last_order_at).toISOString() : null,
  }));
}
