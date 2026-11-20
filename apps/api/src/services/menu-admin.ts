import { and, asc, eq, inArray, isNotNull, max, notInArray } from "drizzle-orm";
import {
  locations,
  menuCategories,
  menuItems,
  modifierGroups,
  modifiers,
  type Db,
  type Tx,
} from "@pass/db";
import { channels, type CategoryInput, type ItemInput, type MenuAdminView } from "@pass/shared";
import { AppError } from "../errors";
import { enqueue } from "../outbox";

/**
 * The menu editor (FR-1). Every change is one transaction that ends with a
 * menu.changed event: open menus reload, and the outbox relay clears the
 * cached menu (NFR-17), so guests see the edit within a second.
 */

type Location = typeof locations.$inferSelect;

async function changed(tx: Tx, loc: Location, reason: string) {
  await enqueue(tx, loc.tenantId, [{ channel: channels.menu(loc.id), type: "menu.changed", payload: { reason } }]);
}

export async function adminMenu(db: Db, loc: Location): Promise<MenuAdminView> {
  const cats = await db
    .select()
    .from(menuCategories)
    .where(and(eq(menuCategories.locationId, loc.id), eq(menuCategories.archived, false)))
    .orderBy(asc(menuCategories.position));
  const items = await db.select().from(menuItems).where(eq(menuItems.locationId, loc.id)).orderBy(asc(menuItems.position));
  const groups = items.length
    ? await db.select().from(modifierGroups).where(inArray(modifierGroups.itemId, items.map((i) => i.id))).orderBy(asc(modifierGroups.position))
    : [];
  const mods = groups.length
    ? await db.select().from(modifiers).where(inArray(modifiers.groupId, groups.map((g) => g.id))).orderBy(asc(modifiers.position))
    : [];
  const photos = await db
    .selectDistinct({ image: menuItems.image })
    .from(menuItems)
    .where(and(eq(menuItems.locationId, loc.id), isNotNull(menuItems.image)));

  return {
    currency: loc.currency,
    categories: cats.map((c) => ({
      id: c.id,
      name: c.name,
      blurb: c.blurb,
      items: items
        .filter((i) => i.categoryId === c.id)
        .map((i) => ({
          id: i.id,
          categoryId: i.categoryId,
          archived: i.archived,
          name: i.name,
          description: i.description,
          priceMinor: i.priceMinor,
          allergens: i.allergens,
          dietary: i.dietary,
          image: i.image,
          featured: i.featured,
          stock: i.stock,
          soldOut: i.soldOut,
          modifierGroups: groups
            .filter((g) => g.itemId === i.id)
            .map((g) => ({
              id: g.id,
              name: g.name,
              minSelect: g.minSelect,
              maxSelect: g.maxSelect,
              modifiers: mods.filter((m) => m.groupId === g.id).map((m) => ({ id: m.id, name: m.name, priceDeltaMinor: m.priceDeltaMinor })),
            })),
        })),
    })),
    photos: photos.map((p) => p.image!).sort(),
  };
}

async function categoryOf(tx: Tx, loc: Location, id: string) {
  const [c] = await tx
    .select()
    .from(menuCategories)
    .where(and(eq(menuCategories.id, id), eq(menuCategories.locationId, loc.id), eq(menuCategories.archived, false)));
  if (!c) throw new AppError(404, "category_not_found", "That menu section was not found");
  return c;
}

async function itemOf(tx: Tx, loc: Location, id: string) {
  const [i] = await tx.select().from(menuItems).where(and(eq(menuItems.id, id), eq(menuItems.locationId, loc.id))).for("update");
  if (!i) throw new AppError(404, "item_not_found", "That dish was not found");
  return i;
}

export async function createCategory(db: Db, loc: Location, input: CategoryInput) {
  return db.transaction(async (tx) => {
    const [last] = await tx.select({ p: max(menuCategories.position) }).from(menuCategories).where(eq(menuCategories.locationId, loc.id));
    const [row] = await tx
      .insert(menuCategories)
      .values({ locationId: loc.id, name: input.name, blurb: input.blurb ?? null, position: (last?.p ?? -1) + 1 })
      .returning({ id: menuCategories.id });
    await changed(tx, loc, "category");
    return row!;
  });
}

export async function updateCategory(db: Db, loc: Location, id: string, input: CategoryInput) {
  return db.transaction(async (tx) => {
    await categoryOf(tx, loc, id);
    await tx.update(menuCategories).set({ name: input.name, blurb: input.blurb ?? null }).where(eq(menuCategories.id, id));
    await changed(tx, loc, "category");
    return { id };
  });
}

/** A section can only go once it has no dishes left on the menu. */
export async function archiveCategory(db: Db, loc: Location, id: string) {
  return db.transaction(async (tx) => {
    await categoryOf(tx, loc, id);
    const [live] = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(and(eq(menuItems.categoryId, id), eq(menuItems.archived, false)))
      .limit(1);
    if (live) throw new AppError(409, "category_not_empty", "Move or take off its dishes first");
    await tx.update(menuCategories).set({ archived: true }).where(eq(menuCategories.id, id));
    await changed(tx, loc, "category");
    return { id };
  });
}

export async function reorderCategories(db: Db, loc: Location, ids: string[]) {
  return db.transaction(async (tx) => {
    const own = await tx
      .select({ id: menuCategories.id })
      .from(menuCategories)
      .where(and(eq(menuCategories.locationId, loc.id), inArray(menuCategories.id, ids)));
    if (own.length !== new Set(ids).size) throw new AppError(404, "category_not_found", "That menu section was not found");
    for (const [position, id] of ids.entries()) {
      await tx.update(menuCategories).set({ position }).where(eq(menuCategories.id, id));
    }
    await changed(tx, loc, "order");
    return { ids };
  });
}

/**
 * Options are saved in place: an option that keeps its id keeps working in
 * every cart that already holds it. Options and choices left out are removed.
 */
async function saveModifierGroups(tx: Tx, itemId: string, groups: ItemInput["modifierGroups"]) {
  const existing = await tx.select({ id: modifierGroups.id }).from(modifierGroups).where(eq(modifierGroups.itemId, itemId));
  const existingIds = new Set(existing.map((g) => g.id));
  const keepGroupIds: string[] = [];

  for (const [gPos, g] of groups.entries()) {
    let groupId = g.id && existingIds.has(g.id) ? g.id : null;
    if (groupId) {
      await tx
        .update(modifierGroups)
        .set({ name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, position: gPos })
        .where(eq(modifierGroups.id, groupId));
    } else {
      const [row] = await tx
        .insert(modifierGroups)
        .values({ itemId, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, position: gPos })
        .returning({ id: modifierGroups.id });
      groupId = row!.id;
    }
    keepGroupIds.push(groupId);

    const current = await tx.select({ id: modifiers.id }).from(modifiers).where(eq(modifiers.groupId, groupId));
    const currentIds = new Set(current.map((m) => m.id));
    const keepModIds: string[] = [];
    for (const [mPos, m] of g.modifiers.entries()) {
      if (m.id && currentIds.has(m.id)) {
        await tx.update(modifiers).set({ name: m.name, priceDeltaMinor: m.priceDeltaMinor, position: mPos }).where(eq(modifiers.id, m.id));
        keepModIds.push(m.id);
      } else {
        const [row] = await tx
          .insert(modifiers)
          .values({ groupId, name: m.name, priceDeltaMinor: m.priceDeltaMinor, position: mPos })
          .returning({ id: modifiers.id });
        keepModIds.push(row!.id);
      }
    }
    await tx.delete(modifiers).where(and(eq(modifiers.groupId, groupId), notInArray(modifiers.id, keepModIds)));
  }

  const drop = [...existingIds].filter((id) => !keepGroupIds.includes(id));
  if (drop.length) {
    await tx.delete(modifiers).where(inArray(modifiers.groupId, drop));
    await tx.delete(modifierGroups).where(inArray(modifierGroups.id, drop));
  }
}

function itemValues(input: ItemInput) {
  return {
    categoryId: input.categoryId,
    name: input.name,
    description: input.description ?? null,
    priceMinor: input.priceMinor,
    allergens: [...new Set(input.allergens)],
    dietary: [...new Set(input.dietary)],
    image: input.image ?? null,
    featured: input.featured,
    stock: input.stock,
    soldOut: input.soldOut,
    updatedAt: new Date(),
  };
}

export async function createItem(db: Db, loc: Location, input: ItemInput) {
  return db.transaction(async (tx) => {
    await categoryOf(tx, loc, input.categoryId);
    const [last] = await tx.select({ p: max(menuItems.position) }).from(menuItems).where(eq(menuItems.categoryId, input.categoryId));
    const [row] = await tx
      .insert(menuItems)
      .values({ locationId: loc.id, ...itemValues(input), position: (last?.p ?? -1) + 1 })
      .returning({ id: menuItems.id });
    await saveModifierGroups(tx, row!.id, input.modifierGroups);
    await changed(tx, loc, "item");
    return row!;
  });
}

export async function updateItem(db: Db, loc: Location, id: string, input: ItemInput) {
  return db.transaction(async (tx) => {
    const item = await itemOf(tx, loc, id);
    await categoryOf(tx, loc, input.categoryId);
    let position = item.position;
    if (item.categoryId !== input.categoryId) {
      const [last] = await tx.select({ p: max(menuItems.position) }).from(menuItems).where(eq(menuItems.categoryId, input.categoryId));
      position = (last?.p ?? -1) + 1;
    }
    await tx.update(menuItems).set({ ...itemValues(input), position }).where(eq(menuItems.id, id));
    await saveModifierGroups(tx, id, input.modifierGroups);
    await changed(tx, loc, "item");
    return { id };
  });
}

/** Off the menu, not deleted: past orders and receipts still name it. */
export async function setItemArchived(db: Db, loc: Location, id: string, archived: boolean) {
  return db.transaction(async (tx) => {
    const item = await itemOf(tx, loc, id);
    if (!archived) await categoryOf(tx, loc, item.categoryId);
    await tx.update(menuItems).set({ archived, updatedAt: new Date() }).where(eq(menuItems.id, id));
    await changed(tx, loc, archived ? "removed" : "restored");
    return { id };
  });
}

export async function reorderItems(db: Db, loc: Location, categoryId: string, ids: string[]) {
  return db.transaction(async (tx) => {
    await categoryOf(tx, loc, categoryId);
    const own = await tx
      .select({ id: menuItems.id })
      .from(menuItems)
      .where(and(eq(menuItems.categoryId, categoryId), inArray(menuItems.id, ids)));
    if (own.length !== new Set(ids).size) throw new AppError(404, "item_not_found", "That dish was not found");
    for (const [position, id] of ids.entries()) await tx.update(menuItems).set({ position }).where(eq(menuItems.id, id));
    await changed(tx, loc, "order");
    return { ids };
  });
}

