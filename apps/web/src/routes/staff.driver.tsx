import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { channels, distanceKm, formatMoney, rideMinutes, type TicketView } from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { RealtimeClient, type LinkStatus } from "../lib/realtime";
import { MapView } from "../components/map";
import { StaffShell } from "../components/staff";

export const Route = createFileRoute("/staff/driver")({
  head: () => ({ meta: [{ title: "Deliveries · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <StaffShell roles={["driver", "admin"]}>
      <Driver />
    </StaffShell>
  ),
});

interface Board {
  location: { id: string; name: string; lat: number; lng: number; currency: string };
  waiting: TicketView[];
  mine: TicketView[];
  seq: number;
}

function Driver() {
  const [board, setBoard] = useState<Board | null>(null);
  const [link, setLink] = useState<LinkStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const b = await api<Board>("/v1/staff/driver");
    setBoard(b);
    return b.seq;
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiError ? e.message : "Could not load deliveries"));
  }, [load]);

  const locationId = board?.location.id;
  useEffect(() => {
    if (!locationId || !board) return;
    const client = new RealtimeClient({
      channels: [channels.drivers(locationId)],
      since: board.seq,
      // Any delivery changed: the board is small, so read it again.
      onEvent: (e) => e.type === "delivery.updated" && void load(),
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

  if (!board) return <p className="p-10 text-center text-taupe">{error ?? "Loading deliveries…"}</p>;
  const money = (m: number) => formatMoney(m, board.location.currency);

  async function take(id: string) {
    setError(null);
    try {
      await api(`/v1/staff/driver/orders/${id}/take`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Try again");
      await load();
    }
  }

  return (
    <main className="mx-auto max-w-[1100px] px-4 py-8 md:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-4xl">Deliveries</h1>
        <span className="eyebrow flex items-center gap-2 text-[0.62rem] text-umber">
          <span className={`size-2 rounded-full ${link === "live" ? "pulse-dot bg-[#2f7a55]" : "bg-taupe"}`} aria-hidden="true" />
          {link === "live" ? "Live" : "Reconnecting"}
        </span>
      </div>
      {error && (
        <p role="alert" className="mt-4 border border-brass px-4 py-3">
          {error}
        </p>
      )}

      {board.mine.map((t) => (
        <OnTheRoad key={t.id} ticket={t} restaurant={board.location} money={money} onDone={load} />
      ))}

      <section className="mt-10">
        <h2 className="eyebrow text-brass">From the kitchen</h2>
        {board.waiting.length === 0 ? (
          <p className="mt-4 border border-espresso/15 bg-cream px-5 py-8 text-umber">No deliveries waiting. New ones appear here as they are ordered.</p>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2">
            {board.waiting.map((t) => {
              const d = t.delivery!;
              const km = distanceKm(board.location, d);
              const ready = t.status === "ready";
              return (
                <li key={t.id} className={`border bg-cream p-5 ${ready ? "border-espresso" : "border-espresso/15"}`}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-serif text-3xl">#{t.number}</span>
                    <span className={`eyebrow text-[0.62rem] ${ready ? "text-[#1f5a3d]" : "text-taupe"}`}>
                      {ready ? "Ready to collect" : t.status === "cooking" ? "Cooking" : "Just in"}
                    </span>
                  </div>
                  <p className="mt-2 font-medium">{t.customerName}</p>
                  <p className="text-umber">
                    {d.line1}, {d.postcode}
                  </p>
                  <p className="mt-1 text-sm text-taupe">
                    {km.toFixed(1)} km · about {rideMinutes(km)} min · {t.items.reduce((n, i) => n + i.quantity, 0)} items · {money(t.totalMinor)} paid
                  </p>
                  <button type="button" disabled={!ready} onClick={() => void take(t.id)} className="cta cta-dark mt-4 w-full px-5 py-3">
                    <span>{ready ? "Take this delivery" : "Wait for the kitchen"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

/**
 * One delivery in progress. The phone's position goes to the guest's map;
 * "Practise the route" drives a pin along the way for testing indoors.
 */
function OnTheRoad({
  ticket: t,
  restaurant,
  money,
  onDone,
}: {
  ticket: TicketView;
  restaurant: { lat: number; lng: number };
  money: (m: number) => string;
  onDone: () => Promise<unknown>;
}) {
  const d = t.delivery!;
  const [pos, setPos] = useState(d.driver ?? { lat: restaurant.lat, lng: restaurant.lng });
  const [sharing, setSharing] = useState<"off" | "gps" | "practice">("off");
  const [note, setNote] = useState<string | null>(null);
  const lastSent = useRef(0);

  const send = useCallback(
    async (p: { lat: number; lng: number }, force = false) => {
      setPos(p);
      if (!force && Date.now() - lastSent.current < 4000) return;
      lastSent.current = Date.now();
      try {
        await api(`/v1/staff/driver/orders/${t.id}/location`, { method: "POST", json: p });
      } catch {
        setNote("Location not sent. Still trying.");
      }
    },
    [t.id],
  );

  useEffect(() => {
    if (sharing !== "gps") return;
    if (!("geolocation" in navigator)) {
      setNote("This device cannot share its location.");
      setSharing("off");
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (g) => void send({ lat: g.coords.latitude, lng: g.coords.longitude }),
      () => {
        setNote("Location is blocked. Allow it in the browser, or practise the route.");
        setSharing("off");
      },
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [sharing, send]);

  useEffect(() => {
    if (sharing !== "practice") return;
    const start = { ...pos };
    const steps = 20;
    let i = 0;
    const timer = setInterval(() => {
      i++;
      const f = i / steps;
      // A gentle bend, so it looks like streets rather than a ruler.
      const bend = Math.sin(f * Math.PI) * 0.0012;
      void send({ lat: start.lat + (d.lat - start.lat) * f + bend, lng: start.lng + (d.lng - start.lng) * f - bend }, true);
      if (i >= steps) {
        clearInterval(timer);
        setSharing("off");
      }
    }, 2500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharing]);

  const km = distanceKm(pos, d);
  const maps = `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}`;

  return (
    <section className="mt-8 border-2 border-espresso bg-cream">
      <div className="grid md:grid-cols-[1fr_360px]">
        <MapView
          ariaLabel={`Route to ${t.customerName}`}
          className="aspect-[4/3] md:aspect-auto md:min-h-[420px]"
          pins={[
            { id: "restaurant", kind: "restaurant", lat: restaurant.lat, lng: restaurant.lng, label: "PassPlate" },
            { id: "home", kind: "home", lat: d.lat, lng: d.lng, label: t.customerName },
            { id: "me", kind: "driver", lat: pos.lat, lng: pos.lng },
          ]}
        />
        <div className="p-6">
          <p className="eyebrow text-[#1f5a3d]">On the road · #{t.number}</p>
          <p className="mt-2 font-serif text-3xl">{t.customerName}</p>
          <p className="text-umber">
            {d.line1}, {d.postcode}
          </p>
          {d.instructions && <p className="mt-2 border-l-2 border-brass pl-3">“{d.instructions}”</p>}
          <p className="mt-3 text-sm text-taupe">
            {km.toFixed(1)} km to go · about {rideMinutes(km)} min · {money(t.totalMinor)} already paid
          </p>
          {d.phone && <p className="mt-1 text-sm">Phone: {d.phone}</p>}

          <div className="mt-5 grid gap-2">
            <button
              type="button"
              onClick={() => setSharing(sharing === "gps" ? "off" : "gps")}
              className={`cta px-5 py-3 ${sharing === "gps" ? "cta-dark" : "cta-outline"}`}
            >
              <span>{sharing === "gps" ? "Sharing my location" : "Share my location"}</span>
            </button>
            <button type="button" onClick={() => setSharing("practice")} disabled={sharing === "practice"} className="cta cta-outline px-5 py-3">
              <span>{sharing === "practice" ? "Driving the route…" : "Practise the route"}</span>
            </button>
            <a href={maps} target="_blank" rel="noreferrer" className="cta cta-outline px-5 py-3">
              <span>Directions</span>
            </a>
            <button
              type="button"
              onClick={async () => {
                await api(`/v1/staff/driver/orders/${t.id}/delivered`, { method: "POST" });
                await onDone();
              }}
              className="cta cta-dark mt-2 px-5 py-4"
            >
              <span>Delivered</span>
            </button>
          </div>
          {note && <p className="mt-3 text-sm text-umber">{note}</p>}
        </div>
      </div>
    </section>
  );
}
