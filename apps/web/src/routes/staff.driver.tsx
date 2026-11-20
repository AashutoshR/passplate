import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  ARRIVING_METRES,
  channels,
  decodePolyline,
  DELIVERY_PROOFS,
  distanceKm,
  formatMoney,
  PROOF_LABEL,
  rideMinutes,
  type DeliveryProof,
  type TicketView,
} from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { useAccount } from "../lib/account";
import { RealtimeClient, type LinkStatus } from "../lib/realtime";
import { MapView, type Line } from "../components/map";
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
  onShift: boolean;
  waiting: TicketView[];
  mine: TicketView[];
  seq: number;
}

function Driver() {
  const [board, setBoard] = useState<Board | null>(null);
  const [link, setLink] = useState<LinkStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const { user } = useAccount();

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

  async function shift(on: boolean) {
    setError(null);
    try {
      await api("/v1/staff/driver/shift", { method: "POST", json: { on } });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Try again");
    }
  }

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
      {user?.role === "driver" && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border border-espresso/15 bg-cream px-5 py-4">
          <p className="text-umber">
            {board.onShift
              ? "On shift. The dispatcher can give you deliveries."
              : "Off shift. Start your shift so the dispatcher can give you deliveries."}
          </p>
          <button
            type="button"
            id="shift-toggle"
            onClick={() => void shift(!board.onShift)}
            className={`cta px-5 py-2.5 ${board.onShift ? "cta-outline" : "cta-dark"}`}
          >
            <span>{board.onShift ? "End shift" : "Start shift"}</span>
          </button>
        </div>
      )}
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
              const forMe = d.driverId !== null && d.driverId === user?.id;
              return (
                <li key={t.id} className={`border bg-cream p-5 ${ready || forMe ? "border-espresso" : "border-espresso/15"}`}>
                  {forMe && <p className="mb-2 eyebrow text-[0.6rem] text-[#1f5a3d]">Given to you by the dispatcher</p>}
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
                    <span>{ready ? "Picked up, set off" : "Wait for the kitchen"}</span>
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
  const [eta, setEta] = useState<string | null>(d.etaAt);
  const [arriving, setArriving] = useState(Boolean(d.arrivingAt));
  const [proofOpen, setProofOpen] = useState(false);
  const lastSent = useRef(0);

  const send = useCallback(
    async (p: { lat: number; lng: number }, force = false) => {
      setPos(p);
      if (!force && Date.now() - lastSent.current < 3000) return;
      lastSent.current = Date.now();
      try {
        const out = await api<{ etaAt: string | null; arriving: boolean }>(`/v1/staff/driver/orders/${t.id}/location`, {
          method: "POST",
          json: p,
        });
        setEta(out.etaAt);
        setArriving(out.arriving);
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
    const road = d.route?.polyline ? decodePolyline(d.route.polyline) : null;
    const steps = 20;
    let i = 0;
    const timer = setInterval(() => {
      i++;
      const f = i / steps;
      if (road && road.length > 1) {
        // Along the road route, a step at a time.
        void send(road[Math.min(road.length - 1, Math.round(f * (road.length - 1)))]!, true);
      } else {
        // A gentle bend, so it looks like streets rather than a ruler.
        const bend = Math.sin(f * Math.PI) * 0.0012;
        void send({ lat: start.lat + (d.lat - start.lat) * f + bend, lng: start.lng + (d.lng - start.lng) * f - bend }, true);
      }
      if (i >= steps) {
        clearInterval(timer);
        setSharing("off");
      }
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharing]);

  const km = distanceKm(pos, d);
  const maps = `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}`;
  const near = arriving || km * 1000 <= ARRIVING_METRES;
  const etaMin = eta ? Math.max(1, Math.round((Date.parse(eta) - Date.now()) / 60_000)) : rideMinutes(km);
  const lines: Line[] = d.route?.polyline
    ? [{ id: "route", kind: "route", points: decodePolyline(d.route.polyline) }]
    : [{ id: "guide", kind: "planned", points: [pos, d] }];

  return (
    <section className="mt-8 border-2 border-espresso bg-cream">
      <div className="grid md:grid-cols-[1fr_360px]">
        <MapView
          ariaLabel={`Route to ${t.customerName}`}
          className="aspect-[4/3] md:aspect-auto md:min-h-[420px]"
          lines={lines}
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
            {km.toFixed(1)} km to go · about {etaMin} min · {money(t.totalMinor)} already paid
          </p>
          {near && <p className="mt-2 eyebrow text-[0.62rem] text-[#1f5a3d]">Nearly there: the guest has been told</p>}
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
            {!proofOpen && (
              <button type="button" id="delivered" onClick={() => setProofOpen(true)} className="cta cta-dark mt-2 px-5 py-4">
                <span>Delivered</span>
              </button>
            )}
          </div>
          {proofOpen && <Proof orderId={t.id} pos={pos} onCancel={() => setProofOpen(false)} onDone={onDone} />}
          {note && <p className="mt-3 text-sm text-umber">{note}</p>}
        </div>
      </div>
    </section>
  );
}

/** Proof of delivery: how the food was left, a note, and where the phone was. */
function Proof({
  orderId,
  pos,
  onCancel,
  onDone,
}: {
  orderId: string;
  pos: { lat: number; lng: number };
  onCancel: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [kind, setKind] = useState<DeliveryProof>("handed_over");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <fieldset className="mt-5 border-2 border-espresso p-4" id="proof">
      <legend className="eyebrow px-1 text-[0.62rem]">How did you leave it?</legend>
      <div className="grid gap-2">
        {DELIVERY_PROOFS.map((p) => (
          <label key={p} className={`flex cursor-pointer items-center gap-3 border px-3 py-2.5 ${kind === p ? "border-espresso bg-linen" : "border-espresso/20"}`}>
            <input type="radio" className="size-4 accent-[#17241e]" name="proof" value={p} checked={kind === p} onChange={() => setKind(p)} />
            {PROOF_LABEL[p]}
          </label>
        ))}
      </div>
      <label className="mt-3 grid gap-1">
        <span className="text-sm text-umber">Note for the restaurant (optional)</span>
        <input className="field" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} placeholder="Behind the blue gate" id="proof-note" />
      </label>
      {problem && (
        <p role="alert" className="mt-2 text-sm text-brass">
          {problem}
        </p>
      )}
      <div className="mt-4 grid grid-cols-[1fr_auto] gap-2">
        <button
          type="button"
          id="confirm-delivered"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setProblem(null);
            try {
              await api(`/v1/staff/driver/orders/${orderId}/delivered`, {
                method: "POST",
                json: { proof: kind, note: text.trim() || undefined, lat: pos.lat, lng: pos.lng },
              });
              await onDone();
            } catch (e) {
              setProblem(e instanceof ApiError ? e.message : "Not saved. Try again.");
              setBusy(false);
            }
          }}
          className="cta cta-dark px-5 py-3.5"
        >
          <span>{busy ? "Saving…" : "Confirm delivered"}</span>
        </button>
        <button type="button" onClick={onCancel} className="cta cta-outline px-4 py-3.5">
          <span>Back</span>
        </button>
      </div>
    </fieldset>
  );
}
