import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  channels,
  decodePolyline,
  distanceKm,
  formatMoney,
  PROOF_LABEL,
  receiptCode,
  type DispatchView,
  type DriverLocation,
  type TicketView,
} from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { RealtimeClient, type LinkStatus } from "../lib/realtime";
import { MapView, type Line, type Pin } from "../components/map";
import { StaffShell } from "../components/staff";

/**
 * FR-14 and FR-15: every delivery and every driver on one live map. Pick a
 * delivery to give it to a driver; the best one is suggested. Finished
 * deliveries stay listed for the day with their proof of drop-off.
 */
export const Route = createFileRoute("/staff/dispatch")({
  head: () => ({ meta: [{ title: "Dispatch · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <StaffShell roles={["staff", "admin"]} wide>
      <Dispatch />
    </StaffShell>
  ),
});

const clock = (iso: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const minsSince = (iso: string, now: number) => Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));

function Dispatch() {
  const [board, setBoard] = useState<DispatchView | null>(null);
  const [link, setLink] = useState<LinkStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const b = await api<DispatchView>("/v1/staff/dispatch");
    setBoard(b);
    return b.seq;
  }, []);
  // Bursts of events (a whole table of changes) cause one reload, not ten.
  const soon = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void load().catch(() => {});
    }, 150);
  }, [load]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiError ? e.message : "Could not load dispatch"));
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, []);

  const locationId = board?.location.id;
  useEffect(() => {
    if (!locationId || !board) return;
    const client = new RealtimeClient({
      channels: [channels.drivers(locationId), channels.dispatch(locationId)],
      since: board.seq,
      onEvent: (e) => {
        if (e.type === "driver.location") {
          const p = e.payload as DriverLocation;
          setBoard((b) => (b ? moveDriver(b, p) : b));
        } else if (e.type === "delivery.updated" || e.type === "driver.shift") soon();
      },
      onResync: load,
      onStatus: setLink,
    });
    client.start();
    return () => client.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  useEffect(() => {
    if (link === "live") return;
    const t = setInterval(() => void load().catch(() => {}), 8000);
    return () => clearInterval(t);
  }, [link, load]);

  const pins = useMemo<Pin[]>(() => {
    if (!board) return [];
    const out: Pin[] = [{ id: "restaurant", kind: "restaurant", lat: board.location.lat, lng: board.location.lng, label: board.location.name }];
    for (const t of board.waiting) {
      const d = t.delivery!;
      out.push({ id: `w-${t.id}`, kind: "waiting", lat: d.lat, lng: d.lng, label: `#${t.number}`, selected: selected === t.id, onClick: () => setSelected(t.id) });
    }
    for (const t of board.onTheRoad) {
      const d = t.delivery!;
      out.push({ id: `h-${t.id}`, kind: "home", lat: d.lat, lng: d.lng, label: `#${t.number}`, selected: selected === t.id, onClick: () => setSelected(t.id) });
    }
    for (const t of board.delivered.slice(0, 30)) {
      const d = t.delivery!;
      out.push({ id: `d-${t.id}`, kind: "done", lat: d.lat, lng: d.lng });
    }
    for (const dr of board.drivers) {
      if (!dr.onShift || !dr.position) continue;
      out.push({ id: `dr-${dr.id}`, kind: "driver", lat: dr.position.lat, lng: dr.position.lng, label: dr.name.split(" ")[0] });
    }
    return out;
  }, [board, selected]);

  const lines = useMemo<Line[]>(() => {
    if (!board) return [];
    return board.onTheRoad.map((t) => {
      const d = t.delivery!;
      if (d.route?.polyline) return { id: t.id, kind: "route" as const, points: decodePolyline(d.route.polyline) };
      return { id: t.id, kind: "planned" as const, points: [d.driver ?? board.location, d] };
    });
  }, [board]);

  if (!board) return <p className="p-10 text-center text-taupe">{error ?? "Loading dispatch…"}</p>;
  const money = (m: number) => formatMoney(m, board.location.currency);
  const byId = new Map(board.drivers.map((d) => [d.id, d]));
  const sel = [...board.waiting, ...board.onTheRoad].find((t) => t.id === selected) ?? null;
  const done = board.delivered.filter((t) => t.delivery?.deliveredAt);
  const avg = done.length
    ? Math.round(done.reduce((n, t) => n + (Date.parse(t.delivery!.deliveredAt!) - Date.parse(t.createdAt)) / 60_000, 0) / done.length)
    : null;

  async function assign(orderId: string, driverId: string) {
    setBusy(driverId);
    setError(null);
    try {
      await api(`/v1/staff/dispatch/orders/${orderId}/assign`, { method: "POST", json: { driverId } });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not assign it. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="grid min-h-[calc(100dvh-4rem)] lg:grid-cols-[1fr_440px]">
      <section className="relative min-h-[60vh] border-espresso/15 lg:border-r">
        <div className="absolute inset-0">
          <MapView ariaLabel="Dispatch map" className="h-full w-full" pins={pins} lines={lines} fit={false} />
        </div>
        <div className="pointer-events-none absolute top-4 left-4 flex flex-wrap gap-2">
          <Stat label="Waiting" value={board.waiting.length} />
          <Stat label="On the road" value={board.onTheRoad.length} />
          <Stat label="Delivered today" value={done.length} />
          {avg !== null && <Stat label="Avg order to door" value={`${avg} min`} />}
        </div>
        <span className="absolute bottom-4 left-4 flex items-center gap-2 bg-cream/95 px-3 py-2 eyebrow text-[0.6rem] text-umber">
          <span className={`size-2 rounded-full ${link === "live" ? "pulse-dot bg-[#2f7a55]" : "bg-taupe"}`} aria-hidden="true" />
          {link === "live" ? "Live" : "Reconnecting"}
        </span>
      </section>

      <aside className="max-h-none overflow-y-auto bg-[#f6f2ea] px-5 py-6 lg:max-h-[calc(100dvh-4rem)]">
        <h1 className="font-serif text-3xl">Dispatch</h1>
        {error && (
          <p role="alert" className="mt-3 border border-brass px-4 py-3">
            {error}
          </p>
        )}

        {sel && (
          <section className="mt-5 border-2 border-espresso bg-cream p-5" aria-label={`Order ${sel.number}`} id="dispatch-selected">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-serif text-3xl">#{sel.number}</p>
              <button type="button" onClick={() => setSelected(null)} className="draw text-sm text-umber">
                Close
              </button>
            </div>
            <p className="mt-1 font-medium">{sel.customerName}</p>
            <p className="text-umber">
              {sel.delivery!.line1}, {sel.delivery!.postcode}
            </p>
            <p className="mt-1 text-sm text-taupe">
              {distanceKm(board.location, sel.delivery!).toFixed(1)} km · {sel.items.reduce((n, i) => n + i.quantity, 0)} items ·{" "}
              {money(sel.totalMinor)} paid
            </p>
            {sel.status === "out_for_delivery" ? (
              <p className="mt-4 text-umber">
                With {sel.delivery!.driverName}. {sel.delivery!.etaAt ? `Due ${clock(sel.delivery!.etaAt)}.` : ""}
              </p>
            ) : (
              <>
                <p className="mt-4 eyebrow text-[0.62rem] text-taupe">Give it to</p>
                <ul className="mt-2 grid gap-2">
                  {board.suggested.map((id, i) => {
                    const dr = byId.get(id)!;
                    const mine = sel.delivery?.driverId === id;
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          disabled={busy !== null || mine}
                          onClick={() => void assign(sel.id, id)}
                          className={`flex w-full items-center justify-between gap-3 border px-4 py-3 text-left transition-colors ${
                            mine ? "border-espresso bg-espresso text-cream" : "border-espresso/20 bg-cream hover:border-espresso"
                          }`}
                        >
                          <span>
                            <span className="font-medium">{dr.name}</span>
                            {i === 0 && !mine && <span className="ml-2 eyebrow text-[0.56rem] text-[#1f5a3d]">Suggested</span>}
                            <span className={`block text-sm ${mine ? "text-cream/70" : "text-taupe"}`}>
                              {mine
                                ? "Assigned"
                                : dr.carrying.length
                                  ? `Out now, back in about ${dr.backInMinutes} min`
                                  : dr.backInMinutes
                                    ? `Free, ${dr.backInMinutes} min away`
                                    : "Free, at the restaurant"}
                              {dr.assigned.length > 0 && !mine ? ` · ${dr.assigned.length} waiting` : ""}
                            </span>
                          </span>
                          <span className="eyebrow text-[0.6rem]">{busy === id ? "…" : mine ? "✓" : "Assign"}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {board.suggested.length === 0 && <p className="mt-2 text-umber">No drivers on shift. Drivers start a shift from their phone.</p>}
              </>
            )}
          </section>
        )}

        <Panel title="Waiting for a driver" count={board.waiting.length}>
          {board.waiting.length === 0 ? (
            <Empty>Nothing waiting. New delivery orders appear here once paid.</Empty>
          ) : (
            board.waiting.map((t) => (
              <OrderRow key={t.id} t={t} now={now} selected={selected === t.id} onSelect={() => setSelected(t.id)}>
                <span className={t.status === "ready" ? "text-[#1f5a3d]" : "text-taupe"}>
                  {t.status === "ready" ? "Ready" : t.status === "cooking" ? "Cooking" : "Just in"} · {minsSince(t.createdAt, now)} min
                </span>
                <span className="text-umber">{t.delivery?.driverName ? `→ ${t.delivery.driverName}` : "Not assigned"}</span>
              </OrderRow>
            ))
          )}
        </Panel>

        <Panel title="On the road" count={board.onTheRoad.length}>
          {board.onTheRoad.length === 0 ? (
            <Empty>No one is out.</Empty>
          ) : (
            board.onTheRoad.map((t) => {
              const d = t.delivery!;
              const late = d.etaAt && Date.parse(d.etaAt) < now;
              return (
                <OrderRow key={t.id} t={t} now={now} selected={selected === t.id} onSelect={() => setSelected(t.id)}>
                  <span className="text-umber">
                    {d.driverName} · left {d.pickedUpAt ? clock(d.pickedUpAt) : "now"}
                  </span>
                  <span className={d.arrivingAt ? "text-[#1f5a3d]" : late ? "text-brass" : "text-taupe"}>
                    {d.arrivingAt ? "Arriving" : d.etaAt ? `${late ? "Due" : "ETA"} ${clock(d.etaAt)}` : ""}
                  </span>
                </OrderRow>
              );
            })
          )}
        </Panel>

        <Panel title="Drivers" count={board.drivers.filter((d) => d.onShift).length}>
          <ul className="divide-y divide-espresso/10 border border-espresso/15 bg-cream">
            {board.drivers.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="flex items-center gap-2.5">
                  <span className={`size-2 rounded-full ${d.onShift ? "bg-[#2f7a55]" : "bg-oat"}`} aria-hidden="true" />
                  <span className={d.onShift ? "" : "text-taupe"}>{d.name}</span>
                </span>
                <span className="text-right text-sm text-taupe">
                  {!d.onShift
                    ? "Off shift"
                    : d.carrying.length
                      ? `Out with ${d.carrying.length}`
                      : d.assigned.length
                        ? `${d.assigned.length} to collect`
                        : "Free"}
                  {" · "}
                  {d.deliveredToday} today
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Delivered today" count={done.length}>
          {done.length === 0 ? (
            <Empty>None yet today.</Empty>
          ) : (
            <ul className="divide-y divide-espresso/10 border border-espresso/15 bg-cream" id="delivered-list">
              {done.map((t) => {
                const d = t.delivery!;
                const took = Math.round((Date.parse(d.deliveredAt!) - Date.parse(t.createdAt)) / 60_000);
                const far = d.proof?.distanceM != null && d.proof.distanceM > 150;
                return (
                  <li key={t.id} className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span>
                        <span className="font-medium tabular">#{t.number}</span> {t.customerName}
                      </span>
                      <span className="tabular text-sm">{clock(d.deliveredAt!)}</span>
                    </div>
                    <p className="text-sm text-umber">
                      {d.driverName} · {took} min order to door
                    </p>
                    <p className="text-sm text-taupe">
                      {d.proof ? PROOF_LABEL[d.proof.kind] : "Delivered"}
                      {d.proof?.note ? `: “${d.proof.note}”` : ""}
                      {d.proof?.distanceM != null && (
                        <span className={far ? "text-brass" : ""}>
                          {" "}
                          · {far ? `${d.proof.distanceM} m from the address` : "at the address"}
                        </span>
                      )}
                    </p>
                    {t.receipt && (
                      <Link to="/staff/receipts/$id" params={{ id: t.receipt.id }} search={{ order: undefined }} className="draw text-sm text-espresso">
                        Receipt {receiptCode(t.receipt.number)}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </aside>
    </main>
  );
}

/** A driver moved: update the pin and the order's ETA without reloading the board. */
function moveDriver(b: DispatchView, p: DriverLocation): DispatchView {
  return {
    ...b,
    drivers: b.drivers.map((d) => (d.id === p.driverId ? { ...d, position: { lat: p.lat, lng: p.lng, at: p.at } } : d)),
    onTheRoad: b.onTheRoad.map((t) =>
      t.id === p.orderId && t.delivery
        ? {
            ...t,
            delivery: {
              ...t.delivery,
              driver: { lat: p.lat, lng: p.lng, at: p.at },
              etaAt: p.etaAt ?? t.delivery.etaAt,
              arrivingAt: t.delivery.arrivingAt ?? (p.arriving ? p.at : null),
            },
          }
        : t,
    ),
  };
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="bg-cream/95 px-3 py-2 shadow-[0_4px_14px_rgb(23_36_30/0.12)]">
      <span className="block eyebrow text-[0.56rem] text-taupe">{label}</span>
      <span className="font-serif text-2xl tabular">{value}</span>
    </span>
  );
}

function Panel({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="eyebrow flex items-baseline justify-between text-brass">
        {title}
        <span className="tabular text-umber">{count}</span>
      </h2>
      <div className="mt-3 grid gap-2">{children}</div>
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="border border-espresso/15 bg-cream px-4 py-5 text-umber">{children}</p>
);

function OrderRow({
  t,
  selected,
  onSelect,
  children,
}: {
  t: TicketView;
  now: number;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`grid w-full gap-0.5 border px-4 py-3 text-left transition-colors ${
        selected ? "border-espresso bg-cream" : "border-espresso/15 bg-cream hover:border-espresso/50"
      }`}
    >
      <span className="flex items-baseline justify-between gap-3">
        <span>
          <span className="font-medium tabular">#{t.number}</span> {t.customerName}
        </span>
        <span className="truncate text-sm text-taupe">{t.delivery?.postcode}</span>
      </span>
      <span className="flex items-baseline justify-between gap-3 text-sm">{children}</span>
    </button>
  );
}
