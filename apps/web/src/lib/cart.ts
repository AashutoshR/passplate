import { useCallback, useEffect, useState } from "react";
import { storage } from "./ids";

export interface CartLine {
  key: string;
  menuItemId: string;
  name: string;
  quantity: number;
  modifierIds: string[];
  modifierNames: string[];
  unitPriceMinor: number;
  notes?: string;
}

/** Same item with the same options and note stacks into one line. */
function lineKey(l: Omit<CartLine, "key" | "quantity" | "name" | "modifierNames" | "unitPriceMinor">) {
  return `${l.menuItemId}|${[...l.modifierIds].sort().join(",")}|${l.notes ?? ""}`;
}

/** A cart kept in this browser, per restaurant and table, so a refresh never loses it. */
export function useCart(storageKey: string) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setLines(storage.get<CartLine[]>(storageKey, []));
    setLoaded(true);
  }, [storageKey]);

  useEffect(() => {
    if (loaded) storage.set(storageKey, lines);
  }, [lines, loaded, storageKey]);

  const add = useCallback((line: Omit<CartLine, "key">) => {
    const key = lineKey(line);
    setLines((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) return prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + line.quantity } : l));
      return [...prev, { ...line, key }];
    });
  }, []);

  const setQuantity = useCallback((key: string, quantity: number) => {
    setLines((prev) =>
      quantity <= 0 ? prev.filter((l) => l.key !== key) : prev.map((l) => (l.key === key ? { ...l, quantity } : l)),
    );
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const count = lines.reduce((n, l) => n + l.quantity, 0);
  const totalMinor = lines.reduce((n, l) => n + l.unitPriceMinor * l.quantity, 0);
  const quantityOf = (menuItemId: string) =>
    lines.filter((l) => l.menuItemId === menuItemId).reduce((n, l) => n + l.quantity, 0);

  return { lines, add, setQuantity, clear, count, totalMinor, quantityOf, loaded };
}
