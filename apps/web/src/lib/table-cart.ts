import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { channels, type CartEvent, type CartView } from "@pass/shared";
import { api } from "./api";
import type { CartLine } from "./cart";
import { uuid } from "./ids";
import { RealtimeClient, type LinkStatus } from "./realtime";

/**
 * The shared table cart (FR-4) as a hook with the same shape as the phone's
 * own cart, so the menu and the basket work the same way at a table.
 *
 * Adds show at once and are confirmed by the server; every phone at the table
 * gets the whole cart again after any change, so they all agree. A line a
 * phone added but the server has not confirmed yet is never sent to the
 * kitchen: only confirmed lines go, by id.
 */

export interface TableCartLine extends CartLine {
  addedBy: string;
  /** Shown, not yet confirmed by the server. */
  pending: boolean;
}

export type Sent = NonNullable<CartEvent["sent"]>;

export function useTableCart(token: string, opts: { onSent?: (sent: Sent) => void } = {}) {
  const [cart, setCart] = useState<Omit<CartView, "seq"> | null>(null);
  const [pending, setPending] = useState<TableCartLine[]>([]);
  const [overrides, setOverrides] = useState<Map<string, number>>(new Map());
  const [link, setLink] = useState<LinkStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const onSent = useRef(opts.onSent);
  onSent.current = opts.onSent;
  const versionRef = useRef(-1);
  const cartIdRef = useRef<string | null>(null);

  /** Newer versions win; an older snapshot arriving late is ignored. */
  const apply = useCallback((next: Omit<CartView, "seq">) => {
    if (next.cartId === cartIdRef.current && next.version < versionRef.current) return;
    cartIdRef.current = next.cartId;
    versionRef.current = next.version;
    setCart(next);
  }, []);

  const load = useCallback(async () => {
    const fresh = await api<CartView>(`/v1/tables/${encodeURIComponent(token)}/cart`);
    apply(fresh);
    return fresh;
  }, [token, apply]);

  const cartId = cart?.cartId;
  useEffect(() => {
    let client: RealtimeClient | null = null;
    let stopped = false;
    void load()
      .then((fresh) => {
        if (stopped) return;
        client = new RealtimeClient({
          channels: [channels.cart(fresh.cartId)],
          since: fresh.seq,
          onEvent: (e) => {
            if (e.type !== "cart.updated") return;
            const p = e.payload as CartEvent;
            apply(p.cart);
            if (p.sent) onSent.current?.(p.sent);
          },
          onResync: async () => (await load()).seq,
          onStatus: setLink,
        });
        client.start();
      })
      .catch(() => setError("We could not load your table's order. Check the connection."));
    return () => {
      stopped = true;
      client?.stop();
    };
    // One subscription per cart id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, cartId]);

  // Fallback while live updates are paused.
  useEffect(() => {
    if (link === "live") return;
    const t = setInterval(() => void load().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [link, load]);

  const add = useCallback(
    async (line: Omit<CartLine, "key">, addedBy: string) => {
      const lineId = uuid();
      setPending((p) => [...p, { ...line, key: lineId, addedBy, pending: true }]);
      try {
        apply(
          await api<Omit<CartView, "seq">>(`/v1/tables/${encodeURIComponent(token)}/cart/lines`, {
            method: "POST",
            json: {
              lineId,
              menuItemId: line.menuItemId,
              quantity: line.quantity,
              modifierIds: line.modifierIds,
              ...(line.notes ? { notes: line.notes } : {}),
              addedBy,
            },
          }),
        );
      } finally {
        setPending((p) => p.filter((l) => l.key !== lineId));
      }
    },
    [token, apply],
  );

  const setQuantity = useCallback(
    async (lineId: string, quantity: number) => {
      setOverrides((o) => new Map(o).set(lineId, quantity));
      try {
        apply(
          await api<Omit<CartView, "seq">>(`/v1/tables/${encodeURIComponent(token)}/cart/lines/${lineId}`, {
            method: "PATCH",
            json: { quantity },
          }),
        );
      } finally {
        setOverrides((o) => {
          const next = new Map(o);
          next.delete(lineId);
          return next;
        });
      }
    },
    [token, apply],
  );

  const lines: TableCartLine[] = useMemo(() => {
    const confirmed = (cart?.lines ?? [])
      .map((l) => ({
        key: l.id,
        menuItemId: l.menuItemId,
        name: l.name,
        quantity: overrides.get(l.id) ?? l.quantity,
        modifierIds: l.modifierIds,
        modifierNames: l.modifierNames,
        unitPriceMinor: l.unitPriceMinor,
        notes: l.notes ?? undefined,
        addedBy: l.addedBy,
        pending: false,
      }))
      .filter((l) => l.quantity > 0);
    return [...confirmed, ...pending];
  }, [cart, pending, overrides]);

  const count = lines.reduce((n, l) => n + l.quantity, 0);
  const totalMinor = lines.reduce((n, l) => n + l.unitPriceMinor * l.quantity, 0);
  const quantityOf = (menuItemId: string) =>
    lines.filter((l) => l.menuItemId === menuItemId).reduce((n, l) => n + l.quantity, 0);
  const people = [...new Set(lines.map((l) => l.addedBy))];

  return {
    lines,
    add,
    setQuantity,
    count,
    totalMinor,
    quantityOf,
    people,
    loaded: cart !== null,
    link,
    error,
    /** Confirmed lines, the ones that go to the kitchen when someone sends. */
    sendableIds: lines.filter((l) => !l.pending).map((l) => l.key),
    reload: load,
  };
}
