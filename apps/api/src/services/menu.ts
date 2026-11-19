import { and, asc, eq, inArray } from "drizzle-orm";
import {
  locations,
  menuCategories,
  menuItems,
  modifierGroups,
  modifiers,
  type Db,
} from "@pass/db";
import { channels, isOpen, type MenuView, type StockChange, type StockUpdateInput } from "@pass/shared";
import { AppError } from "../errors";
import { enqueue } from "../outbox";
import { currentSeq } from "../views";

/** Public menu with a consistent realtime sequence (FR-1, FR-2). */
export async function getMenu(db: Db, slug: string, now = new Date()): Promise<MenuView> {
  return db.transaction(
    async (tx) => {
      const seq = await currentSeq(tx);
      const [loc] = await tx.select().from(locations).where(eq(locations.slug, slug));
      if (!loc) throw new AppError(404, "location_not_found", "Restaurant not found");

      const cats = await tx
        .select()
        .from(menuCategories)
        .where(eq(menuCategories.locationId, loc.id))
        .orderBy(asc(menuCategories.position));
      const items = await tx
        .select()
        .from(menuItems)
        .where(eq(menuItems.locationId, loc.id))
        .orderBy(asc(menuItems.position));
      const itemIds = items.map((i) => i.id);
      const groups = itemIds.length
        ? await tx
            .select()
            .from(modifierGroups)
            .where(inArray(modifierGroups.itemId, itemIds))
            .orderBy(asc(modifierGroups.position))
        : [];
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
            .orderBy(asc(modifiers.position))
        : [];

      return {
        location: {
          id: loc.id,
          slug: loc.slug,
          name: loc.name,
          currency: loc.currency,
          timezone: loc.timezone,
          openingHours: loc.openingHours,
          isOpen: isOpen(loc.openingHours, loc.timezone, now),
          lat: loc.lat,
          lng: loc.lng,
        },
        categories: cats.map((c) => ({
          id: c.id,
          name: c.name,
          blurb: c.blurb,
          // The section's cover: its signature dish if it has one, else its first photo.
          image:
            items.find((i) => i.categoryId === c.id && i.featured && i.image)?.image ??
            items.find((i) => i.categoryId === c.id && i.image)?.image ??
            null,
          items: items
            .filter((i) => i.categoryId === c.id)
            .map((i) => ({
              id: i.id,
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
                  modifiers: mods
                    .filter((m) => m.groupId === g.id)
                    .map((m) => ({ id: m.id, name: m.name, priceDeltaMinor: m.priceDeltaMinor })),
                })),
            })),
        })),
        seq,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Kitchen marks an item sold out or sets its count; every open menu updates live (FR-2). */
export async function updateStock(
  db: Db,
  locationId: string,
  tenantId: string,
  itemId: string,
  input: StockUpdateInput,
): Promise<StockChange> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(menuItems)
      .set({
        ...(input.soldOut !== undefined ? { soldOut: input.soldOut } : {}),
        ...(input.stock !== undefined ? { stock: input.stock } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(menuItems.id, itemId), eq(menuItems.locationId, locationId)))
      .returning({ id: menuItems.id, stock: menuItems.stock, soldOut: menuItems.soldOut });
    if (!row) throw new AppError(404, "item_not_found", "Menu item not found");
    await enqueue(tx, tenantId, [
      { channel: channels.menu(locationId), type: "menu.item_updated", payload: row },
    ]);
    return row;
  });
}
