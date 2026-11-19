import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  DELIVERY_MIN_ORDER_MINOR,
  DELIVERY_RADIUS_KM,
  channels,
  deliveryFee,
  distanceKm,
  formatMoney,
  isAvailable,
  rewardDiscount,
  type DeliveryAddress,
  type MenuItemView,
  type MenuView,
  type StockChange,
  type TicketView,
} from "@pass/shared";
import { useAccount } from "../lib/account";
import { AddressPicker } from "./address";
import { ApiError, api } from "../lib/api";
import { useCart, type CartLine } from "../lib/cart";
import { storage, uuid } from "../lib/ids";
import { useBumpKey } from "../lib/motion";
import { RealtimeClient, type LinkStatus } from "../lib/realtime";
import { Logo } from "./brand";
import { DietaryMarks, DishPhoto } from "./dishes";
import { Sheet } from "./sheet";

export type OrderMode = { type: "pickup"; delivery?: boolean } | { type: "dine_in"; tableToken: string; tableLabel: string };
export type Fulfil = "dine_in" | "pickup" | "delivery";

export function OrderingPage({ initialMenu, mode }: { initialMenu: MenuView; mode: OrderMode }) {
  const [menu, setMenu] = useState(initialMenu);
  const [link, setLink] = useState<LinkStatus>("connecting");
  const [selected, setSelected] = useState<MenuItemView | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const loc = menu.location;
  const cart = useCart(`pass:cart:${loc.id}:${mode.type === "dine_in" ? mode.tableToken : "pickup"}`);
  const money = (minor: number) => formatMoney(minor, loc.currency);
  const bump = useBumpKey(cart.count);
  // Pickup and delivery share one basket; switching keeps what is in it.
  const [fulfil, setFulfil] = useState<Fulfil>(mode.type === "dine_in" ? "dine_in" : mode.delivery ? "delivery" : "pickup");

  const items = useMemo(() => new Map(menu.categories.flatMap((c) => c.items.map((i) => [i.id, i]))), [menu]);

  const applyStock = useCallback((change: StockChange) => {
    setMenu((m) => ({
      ...m,
      categories: m.categories.map((c) => ({
        ...c,
        items: c.items.map((i) => (i.id === change.id ? { ...i, stock: change.stock, soldOut: change.soldOut } : i)),
      })),
    }));
  }, []);

  const reloadMenu = useCallback(async () => {
    const fresh = await api<MenuView>(`/v1/locations/${loc.slug}/menu`);
    setMenu(fresh);
    return fresh.seq;
  }, [loc.slug]);

  // FR-2: stock and sold-out changes reach this screen live.
  useEffect(() => {
    const client = new RealtimeClient({
      channels: [channels.menu(loc.id)],
      since: initialMenu.seq,
      onEvent: (e) => e.type === "menu.item_updated" && applyStock(e.payload as StockChange),
      onResync: reloadMenu,
      onStatus: setLink,
    });
    client.start();
    return () => client.stop();
  }, [loc.id, initialMenu.seq, applyStock, reloadMenu]);

  // Fallback when live updates are paused.
  useEffect(() => {
    if (link === "live") return;
    const t = setInterval(() => void reloadMenu().catch(() => {}), 10_000);
    return () => clearInterval(t);
  }, [link, reloadMenu]);

  const [activeCategory, setActiveCategory] = useState(menu.categories[0]?.id);

  return (
    <div className="min-h-dvh pb-36">
      <header className="sticky top-0 z-30 border-b border-espresso/15 bg-cream/92 backdrop-blur-md">
        <div className="mx-auto max-w-5xl px-5">
          <div className="flex h-16 items-center justify-between gap-3">
            <Logo size="sm" />
            <div className="flex items-center gap-2">
              {mode.type === "dine_in" ? (
                <span className="chip text-espresso">{mode.tableLabel}</span>
              ) : (
                <FulfilSwitch value={fulfil} onChange={setFulfil} />
              )}
              <span className={`chip ${loc.isOpen ? "text-olive" : "text-oxblood"} ${mode.type === "dine_in" ? "" : "hidden sm:inline-flex"}`}>
                <span className={`size-1.5 rounded-full ${loc.isOpen ? "pulse-dot bg-olive" : "bg-oxblood"}`} aria-hidden="true" />
                {loc.isOpen ? "Kitchen open" : "Closed"}
              </span>
            </div>
          </div>
          <nav aria-label="Menu sections" className="no-scrollbar -mx-5 flex gap-6 overflow-x-auto px-5">
            {menu.categories.map((c) => {
              const active = activeCategory === c.id;
              return (
                <a
                  key={c.id}
                  href={`#cat-${c.id}`}
                  onClick={() => setActiveCategory(c.id)}
                  className={`eyebrow relative shrink-0 pt-1 pb-3.5 transition-colors ${active ? "text-espresso" : "text-taupe hover:text-espresso"}`}
                >
                  {c.name}
                  <span
                    className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-brass transition-transform duration-500"
                    style={{ transform: `scaleX(${active ? 1 : 0})` }}
                  />
                </a>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5">
        <div className="pt-12 pb-10">
          <p className="eyebrow fade-up text-taupe">
            {mode.type === "dine_in"
              ? `${mode.tableLabel} · We'll bring it to you`
              : fulfil === "delivery"
                ? `Delivery within ${DELIVERY_RADIUS_KM} km · From ${money(DELIVERY_MIN_ORDER_MINOR)}`
                : "Collect from Wharf Street · We'll tell you when it's ready"}
          </p>
          <h1 className="display mt-4 text-[clamp(3rem,10vw,5.6rem)]">
            <span className="line-in" style={{ ["--delay" as string]: "80ms" }}>
              {mode.type === "dine_in" ? "What would you like?" : fulfil === "delivery" ? "Dinner, delivered." : "Take us home."}
            </span>
          </h1>
        </div>

        {!loc.isOpen && (
          <p role="status" className="border border-oxblood px-4 py-3 text-oxblood">
            The kitchen is not taking orders right now. You can still read the menu.
          </p>
        )}

        {menu.categories.map((c) => (
          <section key={c.id} id={`cat-${c.id}`} className="scroll-mt-32 pt-12">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-espresso/25 pb-3">
              <h2 className="font-serif text-[2.2rem] leading-tight">{c.name}</h2>
              {c.blurb && <p className="text-umber">{c.blurb}</p>}
            </div>
            <ul className="grid md:grid-cols-2 md:gap-x-10">
              {c.items.map((item) => (
                <MenuRow
                  key={item.id}
                  item={item}
                  inCart={cart.quantityOf(item.id)}
                  money={money}
                  disabled={!loc.isOpen}
                  onSelect={() => setSelected(item)}
                />
              ))}
            </ul>
          </section>
        ))}
        <p className="eyebrow mt-20 text-center text-taupe">
          Allergies? Add a note to any dish, or <Link to="/visit" className="draw">ask us</Link>.
        </p>
      </main>

      {cart.count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-espresso/15 bg-cream/92 px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-md">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="cta cta-dark mx-auto flex w-full max-w-5xl justify-between px-5 py-4"
          >
            <span className="flex items-center gap-3">
              <span key={bump} className="tick grid size-7 place-items-center bg-cream text-[0.8rem] text-espresso">
                {cart.count}
              </span>
              View your order
            </span>
            <span className="tabular tracking-normal">{money(cart.totalMinor)}</span>
          </button>
        </div>
      )}

      {selected && (
        <ItemSheet
          item={items.get(selected.id) ?? selected}
          alreadyInCart={cart.quantityOf(selected.id)}
          money={money}
          onClose={() => setSelected(null)}
          onAdd={(line) => {
            cart.add(line);
            setSelected(null);
          }}
        />
      )}

      <CartSheet
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        cart={cart}
        items={items}
        money={money}
        mode={mode}
        fulfil={fulfil}
        setFulfil={setFulfil}
        restaurant={{ lat: loc.lat, lng: loc.lng }}
        locationSlug={loc.slug}
        isOpen={loc.isOpen}
        onSoldOut={(change) => applyStock(change)}
      />
    </div>
  );
}

function MenuRow({
  item,
  inCart,
  money,
  disabled,
  onSelect,
}: {
  item: MenuItemView;
  inCart: number;
  money: (m: number) => string;
  disabled: boolean;
  onSelect: () => void;
}) {
  const available = isAvailable(item);
  const low = item.stock !== null && item.stock > 0 && item.stock <= 5;
  const canOrder = available && !disabled;
  return (
    <li className="border-b border-espresso/15">
      <button
        type="button"
        onClick={onSelect}
        disabled={!canOrder}
        className="group -mx-3 flex w-[calc(100%+1.5rem)] items-start gap-5 px-3 py-6 text-left transition-colors duration-300 enabled:hover:bg-linen/70 disabled:cursor-not-allowed"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className={`font-serif text-[1.55rem] leading-tight ${available ? "" : "text-taupe line-through decoration-1"}`}>
              {item.name}
            </span>
            {inCart > 0 && (
              <span key={inCart} className="chip drop border-espresso bg-espresso text-cream">
                × {inCart}
              </span>
            )}
          </div>
          {item.description && <p className={`mt-1.5 leading-relaxed ${available ? "text-umber" : "text-taupe"}`}>{item.description}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className={`tabular mr-2 ${available ? "text-espresso" : "text-taupe"}`}>{money(item.priceMinor)}</span>
            <DietaryMarks dietary={item.dietary} />
            {!available && <span className="chip text-oxblood">Sold out</span>}
            {available && low && <span className="chip text-brass">{item.stock} left</span>}
          </div>
        </div>
        <div className="relative shrink-0">
          {item.image ? (
            <DishPhoto src={item.image} alt="" className={`size-24 ${available ? "" : "opacity-50 grayscale"}`} />
          ) : null}
          {canOrder && (
            <span
              aria-hidden="true"
              className={`grid size-8 place-items-center rounded-full bg-cream text-lg text-espresso shadow-[0_2px_10px_rgb(23_36_30/0.18)] transition-colors duration-300 group-hover:bg-espresso group-hover:text-cream ${
                item.image ? "absolute right-1.5 bottom-1.5" : "border border-espresso/40"
              }`}
            >
              +
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

function ItemSheet({
  item,
  alreadyInCart,
  money,
  onClose,
  onAdd,
}: {
  item: MenuItemView;
  alreadyInCart: number;
  money: (m: number) => string;
  onClose: () => void;
  onAdd: (line: Omit<CartLine, "key">) => void;
}) {
  // Required single choices start on their first option.
  const [chosen, setChosen] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      item.modifierGroups.map((g) => [
        g.id,
        g.minSelect === 1 && g.maxSelect === 1 && g.modifiers[0] ? [g.modifiers[0].id] : [],
      ]),
    ),
  );
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");

  const maxQty = item.stock === null ? 20 : Math.max(0, item.stock - alreadyInCart);
  const allMods = item.modifierGroups.flatMap((g) => g.modifiers);
  const selectedIds = Object.values(chosen).flat();
  const unit = item.priceMinor + selectedIds.reduce((s, id) => s + (allMods.find((m) => m.id === id)?.priceDeltaMinor ?? 0), 0);
  const missing = item.modifierGroups.find((g) => (chosen[g.id]?.length ?? 0) < g.minSelect);
  const soldOut = !isAvailable(item) || maxQty === 0;

  const toggle = (groupId: string, modId: string, single: boolean, max: number) =>
    setChosen((c) => {
      const cur = c[groupId] ?? [];
      if (single) return { ...c, [groupId]: [modId] };
      if (cur.includes(modId)) return { ...c, [groupId]: cur.filter((x) => x !== modId) };
      if (cur.length >= max) return max === 1 ? { ...c, [groupId]: [modId] } : c;
      return { ...c, [groupId]: [...cur, modId] };
    });

  return (
    <Sheet
      open
      onClose={onClose}
      title={item.name}
      kicker={money(item.priceMinor)}
      media={item.image ? <DishPhoto src={item.image} alt={item.name} className="aspect-[16/10] w-full" eager /> : undefined}
      footer={
        <div className="flex items-center gap-3">
          <Stepper value={qty} min={1} max={maxQty} onChange={setQty} label={item.name} />
          <button
            type="button"
            disabled={Boolean(missing) || soldOut}
            onClick={() =>
              onAdd({
                menuItemId: item.id,
                name: item.name,
                quantity: qty,
                modifierIds: selectedIds,
                modifierNames: selectedIds.map((id) => allMods.find((m) => m.id === id)?.name ?? ""),
                unitPriceMinor: unit,
                notes: notes.trim() || undefined,
              })
            }
            className="cta cta-dark min-w-0 flex-1 justify-between gap-3 px-5 py-4"
          >
            <span className="truncate">
              {soldOut ? (
                "Sold out"
              ) : missing ? (
                `Choose ${missing.name.toLowerCase()}`
              ) : (
                <>
                  Add<span className="hidden sm:inline"> to order</span>
                </>
              )}
            </span>
            <span className="tabular tracking-normal">{money(unit * qty)}</span>
          </button>
        </div>
      }
    >
      {item.description && <p className="text-lg leading-relaxed text-umber">{item.description}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <DietaryMarks dietary={item.dietary} />
        {item.stock !== null && item.stock <= 5 && item.stock > 0 && <span className="chip text-brass">Only {item.stock} left tonight</span>}
      </div>
      {item.allergens.length > 0 && <p className="mt-3 text-sm text-taupe">Contains {item.allergens.join(", ")}.</p>}

      {item.modifierGroups.map((g) => {
        // Radios only for "pick exactly one"; optional choices stay as un-tickable checkboxes.
        const single = g.minSelect === 1 && g.maxSelect === 1;
        const count = chosen[g.id]?.length ?? 0;
        return (
          <fieldset key={g.id} className="mt-8">
            <legend className="mb-3 flex w-full items-baseline justify-between border-b border-espresso/20 pb-2">
              <span className="font-serif text-2xl">{g.name}</span>
              <span className={`eyebrow ${g.minSelect > 0 ? "text-brass" : "text-taupe"}`}>
                {g.minSelect > 0 ? "Required" : "Optional"}
                {g.maxSelect > 1 && ` · up to ${g.maxSelect}`}
              </span>
            </legend>
            <div className="grid gap-2">
              {g.modifiers.map((m) => {
                const checked = chosen[g.id]?.includes(m.id) ?? false;
                const blocked = !single && !checked && g.maxSelect > 1 && count >= g.maxSelect;
                return (
                  <label
                    key={m.id}
                    className={`flex cursor-pointer items-center gap-4 border px-4 py-3.5 transition-colors duration-300 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brass ${
                      checked ? "border-espresso bg-linen" : "border-espresso/20 hover:border-espresso/50"
                    } ${blocked ? "opacity-40" : ""}`}
                  >
                    <input
                      type={single ? "radio" : "checkbox"}
                      name={g.id}
                      checked={checked}
                      disabled={blocked}
                      onChange={() => toggle(g.id, m.id, single, g.maxSelect)}
                      className="sr-only"
                    />
                    <span
                      aria-hidden="true"
                      className={`grid size-5 shrink-0 place-items-center border ${single ? "rounded-full" : ""} ${
                        checked ? "border-espresso bg-espresso" : "border-taupe"
                      }`}
                    >
                      {checked && <span className={`size-2 bg-cream ${single ? "rounded-full" : ""}`} />}
                    </span>
                    <span className="flex-1 font-medium">{m.name}</span>
                    {m.priceDeltaMinor > 0 && <span className="tabular text-sm text-umber">+{money(m.priceDeltaMinor)}</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      <label className="mt-8 block">
        <span className="mb-3 block border-b border-espresso/20 pb-2 font-serif text-2xl">Note for the kitchen</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value.slice(0, 200))}
          rows={2}
          placeholder="Allergies or requests"
          className="w-full border border-espresso/25 bg-cream px-4 py-3 text-espresso outline-none placeholder:text-taupe focus:border-espresso"
        />
      </label>
    </Sheet>
  );
}

function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  small = false,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  label: string;
  small?: boolean;
}) {
  const pad = small ? "px-2.5 py-1.5" : "px-3.5 py-3.5";
  return (
    <div className="flex items-center border border-espresso/30">
      <button
        type="button"
        aria-label={`One fewer ${label}`}
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
        className={`${pad} hover:bg-linen disabled:opacity-30`}
      >
        −
      </button>
      <span key={value} className="tabular tick w-6 text-center" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        aria-label={`One more ${label}`}
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        className={`${pad} hover:bg-linen disabled:opacity-30`}
      >
        +
      </button>
    </div>
  );
}

/** Collect or delivery, for orders that are not at a table. */
function FulfilSwitch({ value, onChange }: { value: Fulfil; onChange: (f: Fulfil) => void }) {
  return (
    <div role="radiogroup" aria-label="Collect or delivery" className="flex border border-espresso/30 p-0.5">
      {(["pickup", "delivery"] as const).map((f) => (
        <button
          key={f}
          type="button"
          role="radio"
          aria-checked={value === f}
          onClick={() => onChange(f)}
          className={`eyebrow min-h-9 px-2.5 py-2 text-[0.6rem] tracking-[0.16em] transition-colors ${value === f ? "bg-espresso text-cream" : "text-umber hover:text-espresso"}`}
        >
          {f === "pickup" ? "Collect" : "Delivery"}
        </button>
      ))}
    </div>
  );
}

function CartSheet({
  open,
  onClose,
  cart,
  items,
  money,
  mode,
  fulfil,
  setFulfil,
  restaurant,
  locationSlug,
  isOpen,
  onSoldOut,
}: {
  open: boolean;
  onClose: () => void;
  cart: ReturnType<typeof useCart>;
  items: Map<string, MenuItemView>;
  money: (m: number) => string;
  mode: OrderMode;
  fulfil: Fulfil;
  setFulfil: (f: Fulfil) => void;
  restaurant: { lat: number; lng: number };
  locationSlug: string;
  isOpen: boolean;
  onSoldOut: (change: StockChange) => void;
}) {
  const navigate = useNavigate();
  const { user, rewards, refresh } = useAccount();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState<Partial<DeliveryAddress>>({});
  const [useReward, setUseReward] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One idempotency key per distinct order attempt (FR-7): retries reuse it.
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    setName(storage.get("pass:name", ""));
    setPhone(storage.get("pass:phone", ""));
    setAddress(storage.get("pass:address", {}));
  }, []);
  useEffect(() => {
    if (!user) return;
    setName((n) => n || user.name.split(" ")[0]!);
    setPhone((p) => p || user.phone || "");
  }, [user]);

  const unavailable = cart.lines.filter((l) => {
    const item = items.get(l.menuItemId);
    return !item || !isAvailable(item) || (item.stock !== null && cart.quantityOf(l.menuItemId) > item.stock);
  });

  const delivery = fulfil === "delivery";
  const subtotal = cart.totalMinor;
  const hasPin = typeof address.lat === "number" && typeof address.lng === "number";
  const km = hasPin ? distanceKm(restaurant, { lat: address.lat!, lng: address.lng! }) : null;
  const fee = delivery && km !== null ? deliveryFee(km) : 0;
  const canReward = Boolean(user && rewards && rewards.available > 0);
  const discount = canReward && useReward ? rewardDiscount(subtotal) : 0;
  const total = subtotal - discount + fee;
  const paysNow = fulfil !== "dine_in";

  const blocker = !isOpen
    ? "Kitchen closed"
    : delivery && subtotal < DELIVERY_MIN_ORDER_MINOR
      ? `Delivery starts at ${money(DELIVERY_MIN_ORDER_MINOR)}`
      : delivery && (!hasPin || !address.line1 || (address.line1?.length ?? 0) < 3)
        ? "Add your address"
        : delivery && km !== null && km > DELIVERY_RADIUS_KM
          ? "Too far to deliver"
          : null;

  async function place() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Add a name so we can call your order.");
      return;
    }
    if (delivery && phone.trim().length < 6) {
      setError("Add a phone number so the driver can reach you.");
      return;
    }
    storage.set("pass:name", trimmed);
    if (phone.trim()) storage.set("pass:phone", phone.trim());
    if (delivery) storage.set("pass:address", address);
    const body = {
      locationSlug,
      type: fulfil,
      ...(mode.type === "dine_in" ? { tableToken: mode.tableToken } : {}),
      customerName: trimmed,
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      ...(delivery
        ? {
            delivery: {
              line1: address.line1!.trim(),
              postcode: (address.postcode ?? "").trim() || "Pinned",
              lat: address.lat!,
              lng: address.lng!,
              ...(address.instructions?.trim() ? { instructions: address.instructions.trim() } : {}),
            },
          }
        : {}),
      ...(discount > 0 ? { useReward: true } : {}),
      items: cart.lines.map((l) => ({
        menuItemId: l.menuItemId,
        quantity: l.quantity,
        modifierIds: l.modifierIds,
        ...(l.notes ? { notes: l.notes } : {}),
      })),
    };
    const fingerprint = JSON.stringify(body);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: uuid() };

    setPlacing(true);
    setError(null);
    try {
      const ticket = await api<TicketView>("/v1/orders", {
        method: "POST",
        headers: { "Idempotency-Key": attempt.current.key },
        json: body,
        timeoutMs: 15_000,
      });
      attempt.current = null;
      cart.clear();
      onClose();
      void refresh();
      await navigate({ to: "/order/$id", params: { id: ticket.id } });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "sold_out") {
          const d = err.details as { itemId: string; available: number } | undefined;
          if (d) onSoldOut({ id: d.itemId, stock: d.available, soldOut: d.available === 0 });
        }
        const detail = (err.details as { message: string }[] | undefined)?.[0]?.message;
        setError(err.code === "invalid_request" && detail ? detail : err.message);
      } else {
        // Same key on retry, so trying again can never create a second order.
        setError("No connection. Your order has not been sent yet. Please try again.");
      }
    } finally {
      setPlacing(false);
    }
  }

  const input = "w-full border border-espresso/25 bg-cream px-4 py-3.5 text-lg text-espresso outline-none placeholder:text-taupe focus:border-espresso";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Your order"
      kicker={mode.type === "dine_in" ? mode.tableLabel : delivery ? "Delivery" : "Collect"}
      footer={
        <div className="space-y-3">
          {error && (
            <p role="alert" className="drop border border-brass px-4 py-2.5 text-espresso">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={place}
            disabled={placing || cart.count === 0 || unavailable.length > 0 || Boolean(blocker)}
            className="cta cta-dark w-full justify-between px-5 py-4"
          >
            <span>
              {placing ? (paysNow ? "Paying…" : "Sending to the kitchen…") : (blocker ?? (paysNow ? "Pay and order" : "Send to the kitchen"))}
            </span>
            <span className="tabular tracking-normal">{money(total)}</span>
          </button>
          <p className="text-center text-sm text-taupe">
            {mode.type === "dine_in" ? "Pay at the end of your meal." : "Test mode: no card is charged."}
          </p>
        </div>
      }
    >
      {cart.count === 0 ? (
        <p className="py-10 text-center font-serif text-2xl text-umber">Nothing here yet.</p>
      ) : (
        <>
          <ul className="border-t border-espresso/20">
            {cart.lines.map((l) => {
              const bad = unavailable.includes(l);
              const photo = items.get(l.menuItemId)?.image ?? null;
              return (
                <li key={l.key} className="flex items-start gap-4 border-b border-espresso/15 py-4">
                  {photo && <DishPhoto src={photo} alt="" className="size-14 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="font-serif text-xl leading-tight">{l.name}</p>
                    {l.modifierNames.length > 0 && <p className="text-sm text-umber">{l.modifierNames.join(", ")}</p>}
                    {l.notes && <p className="text-sm text-umber">“{l.notes}”</p>}
                    {bad && <p className="mt-1 text-sm text-brass">No longer available in this amount</p>}
                    <p className="tabular mt-2 text-sm">{money(l.unitPriceMinor * l.quantity)}</p>
                  </div>
                  <Stepper small value={l.quantity} min={0} max={50} onChange={(n) => cart.setQuantity(l.key, n)} label={l.name} />
                </li>
              );
            })}
          </ul>

          {mode.type !== "dine_in" && (
            <div className="mt-6 flex items-center justify-between gap-4">
              <span className="eyebrow text-taupe">How you get it</span>
              <FulfilSwitch value={fulfil} onChange={setFulfil} />
            </div>
          )}

          <div className="mt-6 grid gap-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">Name for the order</span>
              <input value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} autoComplete="given-name" placeholder="So we can call it out" className={input} />
            </label>
            {delivery && (
              <>
                <label className="block">
                  <span className="mb-2 block text-sm font-medium">Phone</span>
                  <input value={phone} onChange={(e) => setPhone(e.target.value.slice(0, 30))} type="tel" autoComplete="tel" placeholder="For the driver" className={input} />
                </label>
                <AddressPicker restaurant={restaurant} value={address} onChange={setAddress} money={money} />
              </>
            )}
          </div>

          {canReward && (
            <label className="mt-6 flex cursor-pointer items-center gap-4 border border-brass bg-brass/10 px-4 py-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brass">
              <input type="checkbox" checked={useReward} onChange={(e) => setUseReward(e.target.checked)} className="sr-only" />
              <span aria-hidden="true" className={`grid size-5 shrink-0 place-items-center border ${useReward ? "border-espresso bg-espresso" : "border-espresso/50"}`}>
                {useReward && <span className="size-2 bg-cream" />}
              </span>
              <span className="flex-1">
                <span className="block font-medium">Use your reward</span>
                <span className="text-sm text-umber">{rewards!.percent}% off this order, up to {money(rewards!.capMinor)}</span>
              </span>
              {useReward && <span className="tabular text-brass">−{money(discount)}</span>}
            </label>
          )}
          {!user && (
            <p className="mt-6 text-sm text-umber">
              <Link to="/account" className="draw text-espresso">Sign in</Link> to collect a stamp for this order. Eight stamps earn 20% off.
            </p>
          )}

          <dl className="mt-6 space-y-2 border-t border-espresso/15 pt-5">
            <div className="flex justify-between text-umber">
              <dt>Food and drink</dt>
              <dd className="tabular">{money(subtotal)}</dd>
            </div>
            {discount > 0 && (
              <div className="flex justify-between text-brass">
                <dt>Reward</dt>
                <dd className="tabular">−{money(discount)}</dd>
              </div>
            )}
            {delivery && (
              <div className="flex justify-between text-umber">
                <dt>Delivery</dt>
                <dd className="tabular">{km === null ? "Add your address" : money(fee)}</dd>
              </div>
            )}
            <div className="flex justify-between pt-1 text-lg">
              <dt className="font-medium">Total</dt>
              <dd className="tabular font-medium">{money(total)}</dd>
            </div>
          </dl>
        </>
      )}
    </Sheet>
  );
}
