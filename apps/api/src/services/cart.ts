import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  diningTables,
  locations,
  menuItems,
  modifiers,
  tableCartLines,
  tableCarts,
  type Db,
  type Executor,
  type Tx,
} from "@pass/db";
import {
  channels,
  type CartAddInput,
  type CartEvent,
  type CartLineView,
  type CartView,
} from "@pass/shared";
import { AppError } from "../errors";
import { enqueue } from "../outbox";
import { currentSeq } from "../views";
import { priceItems } from "./orders";

/**
 * The shared table cart (FR-4). Everyone who scans the same table's QR code
 * adds to one cart and sees every change live.
 *
 * Merging without losing anything comes from the shape of the data: each add
 * is its own row with an id chosen by the phone. Two phones adding at the same
 * moment write two rows, a retried add hits the same id and does nothing, and
 * changing a quantity only touches that one line. A version number on the
 * cart, bumped under a row lock, gives every change a clear order.
 */

type Table = { id: string; label: string; locationId: string; tenantId: string };

async function tableByToken(db: Executor, token: string): Promise<Table> {
  const [row] = await db
    .select({ id: diningTables.id, label: diningTables.label, locationId: diningTables.locationId, tenantId: locations.tenantId })
    .from(diningTables)
    .innerJoin(locations, eq(locations.id, diningTables.locationId))
    .where(eq(diningTables.qrToken, token));
  if (!row) throw new AppError(404, "table_not_found", "This table code is not valid");
  return row;
}

/** The table's cart, created on first use, locked for the rest of the transaction. */
export async function lockCart(tx: Tx, tableId: string) {
  await tx.insert(tableCarts).values({ tableId }).onConflictDoNothing({ target: tableCarts.tableId });
  const [cart] = await tx.select().from(tableCarts).where(eq(tableCarts.tableId, tableId)).for("update");
  return cart!;
}

async function lineViews(db: Executor, cartId: string): Promise<CartLineView[]> {
  const rows = await db
    .select({ line: tableCartLines, name: menuItems.name, priceMinor: menuItems.priceMinor })
    .from(tableCartLines)
    .innerJoin(menuItems, eq(menuItems.id, tableCartLines.menuItemId))
    .where(eq(tableCartLines.cartId, cartId))
    .orderBy(asc(tableCartLines.createdAt), asc(tableCartLines.id));
  const modIds = [...new Set(rows.flatMap((r) => r.line.modifierIds))];
  const mods = modIds.length
    ? await db.select({ id: modifiers.id, name: modifiers.name, delta: modifiers.priceDeltaMinor }).from(modifiers).where(inArray(modifiers.id, modIds))
    : [];
  const modById = new Map(mods.map((m) => [m.id, m]));
  return rows.map(({ line, name, priceMinor }) => {
    const chosen = line.modifierIds.map((id) => modById.get(id)).filter((m) => m !== undefined);
    return {
      id: line.id,
      menuItemId: line.menuItemId,
      name,
      quantity: line.quantity,
      modifierIds: line.modifierIds,
      modifierNames: chosen.map((m) => m.name),
      // Shown with today's prices; the order is priced again on the server when it is sent.
      unitPriceMinor: priceMinor + chosen.reduce((s, m) => s + m.delta, 0),
      notes: line.notes,
      addedBy: line.addedBy,
      createdAt: line.createdAt.toISOString(),
    };
  });
}

async function snapshot(db: Executor, cart: { id: string; version: number }, tableLabel: string): Promise<Omit<CartView, "seq">> {
  return { cartId: cart.id, tableLabel, version: cart.version, lines: await lineViews(db, cart.id) };
}

/** Bumps the version and tells every phone at the table. */
export async function publishCart(
  tx: Tx,
  table: Pick<Table, "label" | "tenantId">,
  cart: { id: string; version: number },
  sent: CartEvent["sent"] = null,
): Promise<Omit<CartView, "seq">> {
  const [bumped] = await tx
    .update(tableCarts)
    .set({ version: sql`${tableCarts.version} + 1`, updatedAt: new Date() })
    .where(eq(tableCarts.id, cart.id))
    .returning({ id: tableCarts.id, version: tableCarts.version });
  const view = await snapshot(tx, bumped!, table.label);
  await enqueue(tx, table.tenantId, [
    { channel: channels.cart(cart.id), type: "cart.updated", payload: { cart: view, sent } satisfies CartEvent },
  ]);
  return view;
}

export async function getCart(db: Db, token: string): Promise<CartView> {
  const table = await tableByToken(db, token);
  // Create the cart outside the read-only snapshot below.
  await db.insert(tableCarts).values({ tableId: table.id }).onConflictDoNothing({ target: tableCarts.tableId });
  return db.transaction(
    async (tx) => {
      const seq = await currentSeq(tx);
      const [cart] = await tx.select().from(tableCarts).where(eq(tableCarts.tableId, table.id));
      return { ...(await snapshot(tx, cart!, table.label)), seq };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function addToCart(db: Db, token: string, input: CartAddInput): Promise<Omit<CartView, "seq">> {
  const table = await tableByToken(db, token);
  return db.transaction(async (tx) => {
    const cart = await lockCart(tx, table.id);
    const [existing] = await tx.select({ cartId: tableCartLines.cartId }).from(tableCartLines).where(eq(tableCartLines.id, input.lineId));
    if (existing) {
      // A retry of an add that already landed.
      if (existing.cartId !== cart.id) throw new AppError(409, "line_exists", "That line belongs to another cart");
      return snapshot(tx, cart, table.label);
    }
    // Same checks as ordering, so the cart never holds something the kitchen would refuse.
    const [priced] = await priceItems(tx, table.locationId, [
      { menuItemId: input.menuItemId, quantity: input.quantity, modifierIds: input.modifierIds, notes: input.notes },
    ]);
    if (priced!.soldOut || (priced!.stock !== null && priced!.stock < input.quantity)) {
      throw new AppError(409, "sold_out", priced!.stock ? `Only ${priced!.stock} left of ${priced!.name}` : `${priced!.name} just sold out`, {
        itemId: input.menuItemId,
        available: priced!.soldOut ? 0 : (priced!.stock ?? 0),
      });
    }
    await tx.insert(tableCartLines).values({
      id: input.lineId,
      cartId: cart.id,
      menuItemId: input.menuItemId,
      quantity: input.quantity,
      modifierIds: input.modifierIds,
      notes: input.notes?.length ? input.notes : null,
      addedBy: input.addedBy,
    });
    return publishCart(tx, table, cart);
  });
}

export async function setCartQuantity(db: Db, token: string, lineId: string, quantity: number): Promise<Omit<CartView, "seq">> {
  const table = await tableByToken(db, token);
  return db.transaction(async (tx) => {
    const cart = await lockCart(tx, table.id);
    const where = and(eq(tableCartLines.id, lineId), eq(tableCartLines.cartId, cart.id));
    const changed =
      quantity === 0
        ? await tx.delete(tableCartLines).where(where).returning({ id: tableCartLines.id })
        : await tx.update(tableCartLines).set({ quantity }).where(where).returning({ id: tableCartLines.id });
    // Already removed or sent by someone else: nothing to do, show the cart as it is.
    if (changed.length === 0) return snapshot(tx, cart, table.label);
    return publishCart(tx, table, cart);
  });
}

/** A new party at the table starts with a new, empty cart on a new channel. */
export async function dropCart(tx: Tx, tableId: string): Promise<void> {
  await tx.delete(tableCarts).where(eq(tableCarts.tableId, tableId));
}
