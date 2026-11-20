import type Redis from "ioredis";
import type { MenuView } from "@pass/shared";

/**
 * NFR-17: the public menu is cached in Redis, shared by every API instance.
 *
 * Invalidation is driven by events, not guesses: the outbox relay deletes the
 * entry whenever it publishes anything on that restaurant's menu channel (a
 * stock change, a sold-out toggle, an edit). Those events are only published
 * after their transaction commits, so a cached menu is never older than the
 * last change anyone could have seen. The TTL is a safety net, and keeps the
 * "kitchen open" flag fresh around opening and closing time.
 */
export interface MenuCache {
  get(slug: string): Promise<MenuView | null>;
  set(menu: MenuView): Promise<void>;
  invalidate(locationId: string): Promise<void>;
}

export const MENU_TTL_SECONDS = 30;
export const menuKey = (locationId: string) => `menu:${locationId}`;
export const menuMinSeqKey = (locationId: string) => `menu-min-seq:${locationId}`;
const slugKey = (slug: string) => `menu-slug:${slug}`;

export const noCache: MenuCache = {
  get: async () => null,
  set: async () => {},
  invalidate: async () => {},
};

export function redisMenuCache(redis: Redis): MenuCache {
  const up = () => redis.status === "ready";
  return {
    async get(slug) {
      if (!up()) return null;
      try {
        const id = await redis.get(slugKey(slug));
        if (!id) return null;
        const [raw, minSeq] = await redis.mget(menuKey(id), menuMinSeqKey(id));
        if (!raw) return null;
        const menu = JSON.parse(raw) as MenuView;
        // A request that read the database just before a change committed can
        // write its older copy after the relay cleared the key. The relay also
        // records the seq of the latest menu event; anything older is a miss.
        return menu.seq >= Number(minSeq ?? 0) ? menu : null;
      } catch {
        return null;
      }
    },
    async set(menu) {
      if (!up()) return;
      try {
        await redis
          .multi()
          .set(slugKey(menu.location.slug), menu.location.id, "EX", 3600)
          .set(menuKey(menu.location.id), JSON.stringify(menu), "EX", MENU_TTL_SECONDS)
          .exec();
      } catch {
        // A cache that cannot be written is just a slower menu.
      }
    },
    async invalidate(locationId) {
      if (!up()) return;
      await redis.del(menuKey(locationId)).catch(() => {});
    },
  };
}
