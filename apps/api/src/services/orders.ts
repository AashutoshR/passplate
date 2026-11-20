import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  diningTables,
  nextOrderNumber,
  tableCartLines,
  locations,
  menuItems,
  modifierGroups,
  modifiers,
  orderItems,
  orders,
  rewards,
  type Db,
  type OrderItemModifier,
  type Tx,
} from "@pass/db";
import {
  DELIVERY_MIN_ORDER_MINOR,
  DELIVERY_RADIUS_KM,
  channels,
  deliveryFee,
  distanceKm,
  formatMoney,
  isOpen,
  lineTotal,
  rewardDiscount,
  type PlaceOrderInput,
  type StockChange,
  type CartEvent,
  type TicketView,
} from "@pass/shared";
import { lockCart, publishCart } from "./cart";
import { PAYMENT_WINDOW_MS, type PaymentsConfig } from "./checkout";
import { tableEvents } from "./floor";
import { AppError, isUniqueViolation } from "../errors";
import { enqueue, type OutboxEvent } from "../outbox";
import { sha256, stableStringify } from "../util";
import { currentSeq, loadTicket } from "../views";

export interface PlaceOrderResult {
  ticket: TicketView;
  /** True when the idempotency key matched an earlier order (FR-7). */
  replayed: boolean;
}

class DuplicateKey extends Error {}

type PlaceItem = PlaceOrderInput["items"][number];

/**
 * FR-4 to FR-8. One transaction: validate prices server side, take stock with
 * conditional updates, number the order, insert it and its outbox events.
 *
 * Dine-in goes straight to the kitchen and is settled at the table. Collect
 * and delivery wait in awaiting_payment, stock held, until the payment is
 * confirmed (see checkout.ts); only then does the kitchen see a ticket.
 */
export async function placeOrder(
  db: Db,
  input: PlaceOrderInput,
  idempotencyKey: string,
  now = new Date(),
  userId: string | null = null,
  payments: PaymentsConfig = { provider: "test" },
): Promise<PlaceOrderResult> {
  const requestHash = sha256(stableStringify(input));
  const [loc] = await db.select().from(locations).where(eq(locations.slug, input.locationSlug));
  if (!loc) throw new AppError(404, "location_not_found", "Restaurant not found");

  const earlier = await findByKey(db, loc.id, idempotencyKey);
  if (earlier) return replay(db, earlier, requestHash);

  if (!isOpen(loc.openingHours, loc.timezone, now)) {
    throw new AppError(409, "closed", "The restaurant is not taking orders right now");
  }

  let tableId: string | null = null;
  let tableLabel = "";
  if (input.type === "dine_in") {
    const [table] = await db
      .select({ id: diningTables.id, label: diningTables.label })
      .from(diningTables)
      .where(and(eq(diningTables.qrToken, input.tableToken!), eq(diningTables.locationId, loc.id)));
    if (!table) throw new AppError(404, "table_not_found", "This table code is not valid");
    tableId = table.id;
    tableLabel = table.label;
  }

  let fee = 0;
  if (input.type === "delivery") {
    const d = input.delivery!;
    const km = distanceKm({ lat: loc.lat, lng: loc.lng }, d);
    if (km > DELIVERY_RADIUS_KM) {
      throw new AppError(422, "out_of_range", `Sorry, we only deliver within ${DELIVERY_RADIUS_KM} km of the restaurant`);
    }
    fee = deliveryFee(km);
  }
  if (input.useReward && !userId) throw new AppError(401, "signed_out", "Sign in to use a reward");

  // The order number comes from the restaurant's own sequence, outside the
  // order's transaction. It used to be a counter row updated inside it, and
  // the first load test at 50 orders a second queued every order behind that
  // one row lock. A failed attempt can skip a number, which is harmless for a
  // number the kitchen calls out.
  const orderNumber = await nextOrderNumber(db, loc.id);

  try {
    return await db.transaction(async (tx) => {
      // FR-4: from the shared cart, order exactly the lines this phone saw and
      // take them out of the cart in the same transaction.
      let items: PlaceItem[] = input.items;
      let cart: { id: string; version: number } | null = null;
      if (input.tableCartLineIds && tableId) {
        cart = await lockCart(tx, tableId);
        const rows = await tx
          .delete(tableCartLines)
          .where(and(eq(tableCartLines.cartId, cart.id), inArray(tableCartLines.id, input.tableCartLineIds)))
          .returning();
        if (rows.length === 0) {
          throw new AppError(409, "cart_already_sent", "Someone at your table has already sent these to the kitchen");
        }
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
        items = rows.map((r) => ({
          menuItemId: r.menuItemId,
          quantity: r.quantity,
          modifierIds: r.modifierIds,
          ...(r.notes ? { notes: r.notes } : {}),
        }));
      }
      const lines = await priceItems(tx, loc.id, items);
      const stockChanges = await takeStock(tx, loc.id, lines);

      const subtotal = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
      if (input.type === "delivery" && subtotal < DELIVERY_MIN_ORDER_MINOR) {
        throw new AppError(
          422,
          "below_minimum",
          `Delivery orders start at ${formatMoney(DELIVERY_MIN_ORDER_MINOR, loc.currency)}`,
        );
      }
      let rewardId: string | null = null;
      let discount = 0;
      if (input.useReward && userId) {
        const [reward] = await tx
          .select({ id: rewards.id })
          .from(rewards)
          .where(and(eq(rewards.userId, userId), isNull(rewards.redeemedOrderId)))
          .orderBy(asc(rewards.createdAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!reward) throw new AppError(409, "no_reward", "You have no reward to use yet");
        rewardId = reward.id;
        discount = rewardDiscount(subtotal);
      }

      const paysOnline = input.type !== "dine_in";

      const inserted = await tx
        .insert(orders)
        .values({
          tenantId: loc.tenantId,
          locationId: loc.id,
          number: orderNumber,
          type: input.type,
          status: paysOnline ? "awaiting_payment" : "received",
          paymentProvider: paysOnline ? payments.provider : null,
          paymentExpiresAt: paysOnline ? new Date(now.getTime() + PAYMENT_WINDOW_MS) : null,
          tableId,
          customerName: input.customerName,
          userId,
          phone: input.phone || null,
          subtotalMinor: subtotal,
          discountMinor: discount,
          deliveryFeeMinor: fee,
          totalMinor: subtotal - discount + fee,
          deliveryLine1: input.delivery?.line1 ?? null,
          deliveryPostcode: input.delivery?.postcode?.toUpperCase() ?? null,
          deliveryLat: input.delivery?.lat ?? null,
          deliveryLng: input.delivery?.lng ?? null,
          deliveryInstructions: input.delivery?.instructions || null,
          currency: loc.currency,
          idempotencyKey,
          requestHash,
        })
        .onConflictDoNothing({ target: [orders.locationId, orders.idempotencyKey] })
        .returning({ id: orders.id });
      // A concurrent request with the same key won. Roll back and return its order.
      if (inserted.length === 0) throw new DuplicateKey();
      const orderId = inserted[0]!.id;

      await tx.insert(orderItems).values(
        lines.map((l, position) => ({
          orderId,
          menuItemId: l.menuItemId,
          name: l.name,
          quantity: l.quantity,
          unitPriceMinor: l.unitPriceMinor,
          modifiers: l.modifiers,
          notes: l.notes,
          lineTotalMinor: l.lineTotalMinor,
          position,
        })),
      );

      if (rewardId) {
        await tx.update(rewards).set({ redeemedOrderId: orderId, redeemedAt: new Date() }).where(eq(rewards.id, rewardId));
      }

      const extra: OutboxEvent[] = [];
      if (tableId) {
        // Guests who sat down and scanned without being seated by staff are seated now.
        await tx
          .update(diningTables)
          .set({ state: "seated", seatedAt: new Date(), seatedName: input.customerName })
          .where(and(eq(diningTables.id, tableId), eq(diningTables.state, "free")));
        extra.push(...(await tableEvents(tx, loc, [tableId])));
      }

      if (cart) {
        const sent: CartEvent["sent"] = {
          orderId,
          number: orderNumber,
          by: input.customerName,
          count: lines.reduce((n, l) => n + l.quantity, 0),
        };
        await publishCart(tx, { label: tableLabel, tenantId: loc.tenantId }, cart, sent);
      }

      const ticket = (await loadTicket(tx, orderId))!;
      const events: OutboxEvent[] = [
        ...extra.filter((e) => e.type !== "order.updated"),
        // Unpaid orders stay off the kitchen screen until the payment lands.
        ...(paysOnline ? [] : [{ channel: channels.kitchen(loc.id), type: "ticket.created" as const, payload: ticket }]),
        { channel: channels.order(orderId), type: "order.updated", payload: ticket },
        ...stockChanges.map((change) => ({
          channel: channels.menu(loc.id),
          type: "menu.item_updated" as const,
          payload: change,
        })),
      ];
      await enqueue(tx, loc.tenantId, events);
      return { ticket, replayed: false };
    });
  } catch (err) {
    // Whatever went wrong, a same-key order that committed meanwhile is the answer.
    if (err instanceof DuplicateKey || err instanceof AppError || isUniqueViolation(err)) {
      const winner = await findByKey(db, loc.id, idempotencyKey);
      if (winner) return replay(db, winner, requestHash);
    }
    throw err;
  }
}

async function findByKey(db: Db, locationId: string, key: string) {
  const [row] = await db
    .select({ id: orders.id, requestHash: orders.requestHash })
    .from(orders)
    .where(and(eq(orders.locationId, locationId), eq(orders.idempotencyKey, key)));
  return row;
}

async function replay(
  db: Db,
  earlier: { id: string; requestHash: string },
  requestHash: string,
): Promise<PlaceOrderResult> {
  if (earlier.requestHash !== requestHash) {
    throw new AppError(
      422,
      "idempotency_key_reused",
      "This idempotency key was already used for a different order",
    );
  }
  return { ticket: (await loadTicket(db, earlier.id))!, replayed: true };
}

export interface PricedLine {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
  modifiers: OrderItemModifier[];
  notes: string | null;
  lineTotalMinor: number;
  stock: number | null;
  soldOut: boolean;
}

/** Prices always come from the database, never from the client. */
export async function priceItems(tx: Tx, locationId: string, wanted: PlaceItem[]): Promise<PricedLine[]> {
  const itemIds = [...new Set(wanted.map((i) => i.menuItemId))];
  const items = await tx
    .select()
    .from(menuItems)
    .where(and(inArray(menuItems.id, itemIds), eq(menuItems.locationId, locationId), eq(menuItems.archived, false)));
  if (items.length !== itemIds.length) {
    throw new AppError(422, "unknown_item", "An item in your order is no longer on the menu");
  }
  const groups = await tx.select().from(modifierGroups).where(inArray(modifierGroups.itemId, itemIds));
  const mods = groups.length
    ? await tx
        .select()
        .from(modifiers)
        .where(
          inArray(
            modifiers.groupId,
            groups.map((g) => g.id),
          ),
        )
    : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  return wanted.map((line) => {
    const item = itemById.get(line.menuItemId)!;
    const itemGroups = groups.filter((g) => g.itemId === item.id);
    if (new Set(line.modifierIds).size !== line.modifierIds.length) {
      throw new AppError(422, "invalid_modifier", `Each option can only be chosen once for ${item.name}`);
    }
    const chosen = line.modifierIds.map((id) => {
      const mod = mods.find((m) => m.id === id && itemGroups.some((g) => g.id === m.groupId));
      if (!mod) throw new AppError(422, "invalid_modifier", `An option is not valid for ${item.name}`);
      return mod;
    });
    for (const group of itemGroups) {
      const count = chosen.filter((m) => m.groupId === group.id).length;
      if (count < group.minSelect || count > group.maxSelect) {
        const rule =
          group.minSelect === group.maxSelect
            ? `exactly ${group.minSelect}`
            : `between ${group.minSelect} and ${group.maxSelect}`;
        throw new AppError(422, "modifier_rules", `${item.name}: choose ${rule} for "${group.name}"`, {
          itemId: item.id,
          groupId: group.id,
        });
      }
    }
    const deltas = chosen.map((m) => m.priceDeltaMinor);
    return {
      menuItemId: item.id,
      name: item.name,
      quantity: line.quantity,
      unitPriceMinor: item.priceMinor + deltas.reduce((a, b) => a + b, 0),
      modifiers: chosen.map((m) => ({ id: m.id, name: m.name, priceDeltaMinor: m.priceDeltaMinor })),
      notes: line.notes?.length ? line.notes : null,
      lineTotalMinor: lineTotal(item.priceMinor, deltas, line.quantity),
      stock: item.stock,
      soldOut: item.soldOut,
    };
  });
}

/**
 * FR-6 / NFR-11. Counted items are decremented with a conditional update that
 * only succeeds when enough stock is left, so the last portion is sold once.
 * Items are locked in id order to avoid deadlocks between concurrent orders.
 * Unlimited items are not written, so popular dishes never become hot rows.
 */
async function takeStock(tx: Tx, locationId: string, lines: PricedLine[]): Promise<StockChange[]> {
  const wanted = new Map<string, { qty: number; line: PricedLine }>();
  for (const line of lines) {
    const entry = wanted.get(line.menuItemId);
    if (entry) entry.qty += line.quantity;
    else wanted.set(line.menuItemId, { qty: line.quantity, line });
  }

  const changes: StockChange[] = [];
  for (const id of [...wanted.keys()].sort()) {
    const { qty, line } = wanted.get(id)!;
    if (line.soldOut) throw soldOut(line, 0);
    if (line.stock === null) continue;

    const [row] = await tx
      .update(menuItems)
      .set({ stock: sql`${menuItems.stock} - ${qty}`, updatedAt: new Date() })
      .where(
        and(
          eq(menuItems.id, id),
          eq(menuItems.locationId, locationId),
          eq(menuItems.soldOut, false),
          gte(menuItems.stock, qty),
        ),
      )
      .returning({ id: menuItems.id, stock: menuItems.stock, soldOut: menuItems.soldOut });
    if (row) {
      changes.push(row);
      continue;
    }
    // Not enough left. Re-read in case the item became unlimited meanwhile.
    const [now] = await tx
      .select({ stock: menuItems.stock, soldOut: menuItems.soldOut })
      .from(menuItems)
      .where(eq(menuItems.id, id));
    if (now && now.stock === null && !now.soldOut) continue;
    throw soldOut(line, now?.stock ?? 0);
  }
  return changes;
}

function soldOut(line: PricedLine, available: number): AppError {
  return new AppError(
    409,
    "sold_out",
    available > 0 ? `Only ${available} left of ${line.name}` : `${line.name} just sold out`,
    { itemId: line.menuItemId, name: line.name, available },
  );
}

export async function getOrder(db: Db, id: string) {
  return db.transaction(
    async (tx) => {
      const seq = await currentSeq(tx);
      const ticket = await loadTicket(tx, id);
      if (!ticket) throw new AppError(404, "order_not_found", "Order not found");
      return { ticket, seq };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
