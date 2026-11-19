import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  TABLE_STATUSES,
  TABLE_STATUS_HINTS,
  TABLE_STATUS_LABELS,
  channels,
  formatMoney,
  localDate,
  localTime,
  type FloorView,
  type ReservationView,
  type TableStatus,
  type TableView,
  type WaitlistEntryView,
} from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { RealtimeClient, type LinkStatus } from "../lib/realtime";
import { STATUS_STYLE, StaffShell } from "../components/staff";

export const Route = createFileRoute("/staff/floor")({
  head: () => ({ meta: [{ title: "Floor · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <StaffShell roles={["staff", "admin"]} wide>
      <Floor />
    </StaffShell>
  ),
});

const RESERVED_WINDOW = 60 * 60_000;

/** The server works statuses out; the clock moves "free" to "reserved" between events. */
function liveStatus(t: TableView, now: number): TableStatus {
  if (t.status === "free" && t.next && new Date(t.next.startsAt).getTime() - now <= RESERVED_WINDOW) return "reserved";
  if (t.status === "reserved" && (!t.next || new Date(t.next.startsAt).getTime() - now > RESERVED_WINDOW)) return "free";
  return t.status;
}

function minutesSince(iso: string | null, now: number) {
  return iso ? Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000)) : 0;
}

function Floor() {
  const [floor, setFloor] = useState<FloorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkStatus>("connecting");
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [toast, alertBar] = useToast();

  const load = useCallback(async () => {
    const f = await api<FloorView>("/v1/staff/floor");
    setFloor(f);
    return f.seq;
  }, []);

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiError ? e.message : "Could not load the floor"));
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const locationId = floor?.location.id;
  const seq = floor?.seq;
  useEffect(() => {
    if (!locationId || seq === undefined) return;
    const client = new RealtimeClient({
      channels: [channels.floor(locationId)],
      since: seq,
      onEvent: (e) => {
        setFloor((f) => {
          if (!f) return f;
          if (e.type === "floor.table") {
            const t = e.payload as TableView;
            return { ...f, tables: f.tables.map((x) => (x.id === t.id ? t : x)) };
          }
          if (e.type === "floor.waitlist") return { ...f, waitlist: e.payload as WaitlistEntryView[] };
          if (e.type === "floor.reservation") {
            const r = e.payload as ReservationView;
            const today = localDate(f.location.timezone);
            if (localDate(f.location.timezone, new Date(r.startsAt)) !== today) return f;
            const others = f.reservations.filter((x) => x.id !== r.id);
            const list = r.status === "cancelled" ? others : [...others, r];
            return { ...f, reservations: list.sort((a, b) => a.startsAt.localeCompare(b.startsAt)) };
          }
          return f;
        });
      },
      onResync: load,
      onStatus: setLink,
    });
    client.start();
    return () => client.stop();
    // Subscribe once per location; later snapshots do not need a new socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  useEffect(() => {
    if (link === "live" || !floor) return;
    const t = setInterval(() => void load().catch(() => {}), 8000);
    return () => clearInterval(t);
  }, [link, load, floor]);

  const tables = useMemo(() => floor?.tables.map((t) => ({ ...t, status: liveStatus(t, now) })) ?? [], [floor, now]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(TABLE_STATUSES.map((s) => [s, 0])) as Record<TableStatus, number>;
    for (const t of tables) c[t.status]++;
    return c;
  }, [tables]);
  const covers = tables.reduce((n, t) => n + (t.status !== "free" && t.status !== "reserved" && t.status !== "clearing" ? (t.party ?? 0) : 0), 0);

  if (error) return <p className="p-10 text-center text-umber">{error}</p>;
  if (!floor) return <p className="p-10 text-center text-taupe">Loading the floor…</p>;

  const sel = tables.find((t) => t.id === selected) ?? null;
  const tz = floor.location.timezone;
  const money = (m: number) => formatMoney(m, floor.location.currency);

  async function act<T>(fn: () => Promise<T>) {
    setError(null);
    try {
      return await fn();
    } catch (e) {
      alertBar(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
      void load();
    }
  }
  return (
    <div className="grid min-h-[calc(100dvh-4rem)] xl:grid-cols-[1fr_420px]">
      <section className="p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-serif text-4xl">Tonight's floor</h1>
            <p className="mt-1 text-umber">
              {new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz })} · {covers} guests seated ·{" "}
              {floor.reservations.filter((r) => r.status === "booked").length} bookings to come · {floor.waitlist.length} waiting
            </p>
          </div>
          <span className="eyebrow flex items-center gap-2 text-[0.62rem] text-umber" aria-live="polite">
            <span className={`size-2 rounded-full ${link === "live" ? "pulse-dot bg-[#2f7a55]" : "bg-taupe"}`} aria-hidden="true" />
            {link === "live" ? "Live" : "Reconnecting"}
          </span>
        </div>

        <ul className="mt-5 flex flex-wrap gap-2" aria-label="Table status key">
          {TABLE_STATUSES.slice()
            .reverse()
            .map((s) => (
              <li
                key={s}
                title={TABLE_STATUS_HINTS[s]}
                className="flex items-center gap-2 border px-3 py-1.5 text-sm"
                style={{ background: STATUS_STYLE[s].fill, borderColor: STATUS_STYLE[s].edge, color: STATUS_STYLE[s].ink }}
              >
                <span className="font-medium">{TABLE_STATUS_LABELS[s]}</span>
                <span className="tabular font-semibold">{counts[s]}</span>
              </li>
            ))}
        </ul>

        <FloorPlan tables={tables} selected={selected} onSelect={setSelected} now={now} tz={tz} />
      </section>

      <aside className="border-t border-espresso/15 bg-cream xl:border-t-0 xl:border-l">
        {sel ? (
          <TablePanel
            key={sel.id}
            table={sel}
            floor={floor}
            now={now}
            money={money}
            onClose={() => setSelected(null)}
            act={act}
          />
        ) : (
          <Overview floor={floor} tables={tables} now={now} act={act} onPick={setSelected} />
        )}
      </aside>
      {toast}
    </div>
  );
}

function useToast(): [React.ReactNode, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);
  const node = msg ? (
    <div role="alert" className="drop fixed bottom-6 left-1/2 z-50 -translate-x-1/2 bg-espresso px-5 py-3 text-cream shadow-lg">
      {msg}
    </div>
  ) : null;
  return [node, setMsg];
}

/** The room on a 1000 x 640 grid, scaled to the screen. */
function FloorPlan({
  tables,
  selected,
  onSelect,
  now,
  tz,
}: {
  tables: TableView[];
  selected: string | null;
  onSelect: (id: string) => void;
  now: number;
  tz: string;
}) {
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <div className="mt-6 overflow-x-auto">
      <div
        className="relative min-w-[720px] border border-espresso/20 bg-cream"
        style={{ aspectRatio: "1000 / 640", backgroundImage: "radial-gradient(rgb(23 36 30 / 0.07) 1px, transparent 1px)", backgroundSize: "20px 20px" }}
      >
        {/* The room's fixed parts, so staff recognise it at a glance. */}
        <Zone x={20} y={30} w={170} h={560} label="Window" />
        <Zone x={720} y={30} w={130} h={390} label="Counter" />
        <div
          className="absolute grid place-items-center border border-espresso/30 text-espresso/50"
          style={{
            left: pct(870, 1000),
            top: pct(30, 640),
            width: pct(110, 1000),
            height: pct(390, 640),
            backgroundImage: "repeating-linear-gradient(45deg, rgb(23 36 30 / 0.07) 0 6px, transparent 6px 12px)",
          }}
        >
          <span className="eyebrow rotate-90 text-[0.6rem]">Kitchen and pass</span>
        </div>
        <Zone x={740} y={440} w={250} h={180} label="Terrace" dashed />
        <div className="absolute flex items-center gap-2" style={{ left: pct(300, 1000), bottom: "0.4%" }}>
          <span className="h-1 w-24 bg-brass" />
          <span className="eyebrow text-[0.58rem] text-umber">Entrance</span>
        </div>

        {tables.map((t) => {
          const st = STATUS_STYLE[t.status];
          const on = selected === t.id;
          const mins = minutesSince(t.seatedAt, now);
          const occupied = t.status === "seated" || t.status === "ordered" || t.status === "eating";
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t.id)}
              aria-pressed={on}
              aria-label={`${t.label}, ${t.seats} seats, ${TABLE_STATUS_LABELS[t.status]}`}
              className={`absolute flex flex-col items-center justify-center border-2 text-center transition-[transform,box-shadow] duration-200 hover:z-10 hover:scale-[1.04] focus-visible:z-10 ${
                t.shape === "round" ? "rounded-full" : t.shape === "booth" ? "rounded-xl" : t.shape === "stool" ? "rounded-md" : "rounded-sm"
              } ${on ? "z-10 shadow-[0_0_0_4px_#17241e]" : "shadow-sm"}`}
              style={{
                left: pct(t.x, 1000),
                top: pct(t.y, 640),
                width: pct(t.w, 1000),
                height: pct(t.h, 640),
                background: st.fill,
                borderColor: st.edge,
                color: st.ink,
              }}
            >
              <span className="font-serif text-[clamp(0.95rem,1.6vw,1.5rem)] leading-none">{t.label.replace("Table ", "").replace("Counter ", "C")}</span>
              <span className="mt-0.5 text-[clamp(0.55rem,0.8vw,0.72rem)] font-medium leading-tight">
                {occupied ? `${t.party ?? "?"} · ${mins}m` : t.status === "reserved" && t.next ? localTime(t.next.startsAt, tz) : `${t.seats} seats`}
              </span>
              {t.shape !== "stool" && (
                <span className="hidden text-[clamp(0.5rem,0.7vw,0.64rem)] leading-tight opacity-80 md:block">{TABLE_STATUS_LABELS[t.status]}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Zone({ x, y, w, h, label, dashed }: { x: number; y: number; w: number; h: number; label: string; dashed?: boolean }) {
  return (
    <div
      className={`absolute border ${dashed ? "border-dashed" : ""} border-espresso/15 bg-espresso/[0.025]`}
      style={{ left: `${x / 10}%`, top: `${(y / 640) * 100}%`, width: `${w / 10}%`, height: `${(h / 640) * 100}%` }}
    >
      <span className="eyebrow absolute top-1.5 left-2 text-[0.56rem] text-espresso/45">{label}</span>
    </div>
  );
}

type Act = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

function TablePanel({
  table: t,
  floor,
  now,
  money,
  onClose,
  act,
}: {
  table: TableView;
  floor: FloorView;
  now: number;
  money: (m: number) => string;
  onClose: () => void;
  act: Act;
}) {
  const [party, setParty] = useState(Math.min(2, t.seats));
  const [name, setName] = useState("");
  const st = STATUS_STYLE[t.status];
  const tz = floor.location.timezone;
  const mins = minutesSince(t.seatedAt, now);
  const fits = floor.waitlist.filter((w) => w.party <= t.seats);
  const post = (path: string, json?: unknown) => act(() => api(path, { method: "POST", json: json ?? {} }));

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow text-taupe">
            {t.area} · {t.seats} seats
          </p>
          <h2 className="mt-1 font-serif text-4xl">{t.label}</h2>
        </div>
        <button type="button" onClick={onClose} className="eyebrow border border-espresso/20 px-3 py-2 text-[0.62rem] hover:border-espresso">
          All tables
        </button>
      </div>
      <p className="mt-4 inline-flex items-center gap-2 border-2 px-3 py-1.5 font-medium" style={{ background: st.fill, borderColor: st.edge, color: st.ink }}>
        {TABLE_STATUS_LABELS[t.status]}
      </p>
      <p className="mt-2 text-umber">{TABLE_STATUS_HINTS[t.status]}</p>

      {(t.status === "seated" || t.status === "ordered" || t.status === "eating") && (
        <dl className="mt-6 grid grid-cols-2 gap-4 border-y border-espresso/12 py-4">
          <Stat term="Guests" value={`${t.party ?? "?"}${t.guestName ? ` · ${t.guestName}` : ""}`} />
          <Stat term="Seated" value={`${mins} min ago`} />
          <Stat term="In the kitchen" value={`${t.activeOrders} ${t.activeOrders === 1 ? "order" : "orders"}`} />
          <Stat term="Bill so far" value={money(t.openMinor)} />
        </dl>
      )}

      {t.next && t.status !== "seated" && t.status !== "ordered" && t.status !== "eating" && (
        <div className="mt-6 border border-[#b0863f] bg-[#f5e8cf] p-4">
          <p className="eyebrow text-[0.62rem] text-[#7a5a22]">Next booking</p>
          <p className="mt-1 font-serif text-2xl">
            {localTime(t.next.startsAt, tz)} · {t.next.name} ({t.next.party})
          </p>
          <p className="text-sm text-umber">Ref {t.next.code}</p>
          {(t.status === "free" || t.status === "reserved") && (
            <button
              type="button"
              onClick={() => void post("/v1/staff/floor/seat", { tableId: t.id, party: t.next!.party, reservationId: t.next!.id })}
              className="cta cta-dark mt-4 w-full px-5 py-3"
            >
              <span>They're here: seat {t.next.name}</span>
            </button>
          )}
        </div>
      )}

      {(t.status === "free" || t.status === "reserved") && (
        <div className="mt-6 space-y-6">
          <div>
            <p className="font-serif text-2xl">Seat a walk-in</p>
            {t.status === "reserved" && <p className="mt-1 text-sm text-[#7a5a22]">Careful: this table is booked within the hour.</p>}
            <div className="mt-3 flex items-center gap-3">
              <div className="flex border border-espresso/25">
                <button type="button" aria-label="Fewer guests" onClick={() => setParty((p) => Math.max(1, p - 1))} className="px-4 py-3 hover:bg-linen">
                  −
                </button>
                <span className="tabular grid w-10 place-items-center text-lg">{party}</span>
                <button type="button" aria-label="More guests" onClick={() => setParty((p) => Math.min(12, p + 1))} className="px-4 py-3 hover:bg-linen">
                  +
                </button>
              </div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name (optional)"
                className="min-w-0 flex-1 border border-espresso/25 bg-cream px-3 py-3 outline-none focus:border-espresso"
              />
            </div>
            {party > t.seats && <p className="mt-2 text-sm text-[#8a2e1f]">That is more than the {t.seats} seats here.</p>}
            <button
              type="button"
              onClick={() => void post("/v1/staff/floor/seat", { tableId: t.id, party, name: name || undefined })}
              className="cta cta-dark mt-3 w-full px-5 py-3"
            >
              <span>Seat {party} here</span>
            </button>
          </div>
          {fits.length > 0 && (
            <div>
              <p className="font-serif text-2xl">From the waitlist</p>
              <ul className="mt-2 divide-y divide-espresso/12 border-y border-espresso/12">
                {fits.map((w) => (
                  <li key={w.id} className="flex items-center justify-between gap-3 py-3">
                    <span>
                      <span className="font-medium">{w.name}</span> <span className="text-umber">· {w.party} · waiting {minutesSince(w.createdAt, now)}m</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void post("/v1/staff/floor/seat", { tableId: t.id, party: w.party, waitlistId: w.id })}
                      className="cta cta-outline px-4 py-2"
                    >
                      <span>Seat</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {(t.status === "seated" || t.status === "ordered" || t.status === "eating") && (
        <div className="mt-6">
          <p className="font-serif text-2xl">{t.openMinor > 0 ? `Settle ${money(t.openMinor)}` : "Guests leaving?"}</p>
          {t.activeOrders > 0 && <p className="mt-1 text-sm text-umber">Food is still being cooked for this table.</p>}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => void post(`/v1/staff/floor/tables/${t.id}/settle`, { method: "card" })} className="cta cta-dark px-5 py-3">
              <span>{t.openMinor > 0 ? "Paid by card" : "Nothing to pay"}</span>
            </button>
            {t.openMinor > 0 && (
              <button type="button" onClick={() => void post(`/v1/staff/floor/tables/${t.id}/settle`, { method: "cash" })} className="cta cta-outline px-5 py-3">
                <span>Paid in cash</span>
              </button>
            )}
          </div>
        </div>
      )}

      {t.status === "clearing" && (
        <button type="button" onClick={() => void post(`/v1/staff/floor/tables/${t.id}/clear`)} className="cta cta-dark mt-6 w-full px-5 py-4">
          <span>Table is reset and ready</span>
        </button>
      )}
    </div>
  );
}

function Stat({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-taupe">{term}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

function Overview({
  floor,
  tables,
  now,
  act,
  onPick,
}: {
  floor: FloorView;
  tables: TableView[];
  now: number;
  act: Act;
  onPick: (id: string) => void;
}) {
  const [tab, setTab] = useState<"bookings" | "waitlist" | "phone">("bookings");
  const tz = floor.location.timezone;
  return (
    <div className="p-6">
      <div role="tablist" className="flex border-b border-espresso/15">
        {(
          [
            ["bookings", `Bookings (${floor.reservations.filter((r) => r.status === "booked").length})`],
            ["waitlist", `Waitlist (${floor.waitlist.length})`],
            ["phone", "Phone booking"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`eyebrow -mb-px border-b-2 px-3 py-3 text-[0.62rem] ${tab === k ? "border-espresso text-espresso" : "border-transparent text-taupe"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "bookings" && <Bookings floor={floor} tables={tables} tz={tz} act={act} onPick={onPick} />}
      {tab === "waitlist" && <Waitlist floor={floor} tables={tables} now={now} act={act} onPick={onPick} />}
      {tab === "phone" && <PhoneBooking tz={tz} act={act} onDone={() => setTab("bookings")} />}
    </div>
  );
}

function Bookings({
  floor,
  tables,
  tz,
  act,
  onPick,
}: {
  floor: FloorView;
  tables: TableView[];
  tz: string;
  act: Act;
  onPick: (id: string) => void;
}) {
  if (floor.reservations.length === 0) return <p className="py-8 text-umber">No bookings today yet.</p>;
  return (
    <ul className="divide-y divide-espresso/12">
      {floor.reservations.map((r) => {
        const table = tables.find((t) => t.id === r.tableId);
        const live = r.status === "booked";
        return (
          <li key={r.id} className={`py-4 ${live ? "" : "opacity-55"}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="tabular font-serif text-2xl">{localTime(r.startsAt, tz)}</span>
              <span className="eyebrow text-[0.6rem] text-taupe">{r.status.replace("_", " ")}</span>
            </div>
            <p className="mt-1">
              <span className="font-medium">{r.name}</span> · {r.party} · {r.tableLabel ?? "No table"} · <span className="text-taupe">{r.code}</span>
            </p>
            {r.notes && <p className="mt-1 text-sm text-umber">“{r.notes}”</p>}
            {live && (
              <div className="mt-3 flex flex-wrap gap-2">
                {table && (table.status === "free" || table.status === "reserved") && (
                  <button
                    type="button"
                    onClick={() => void act(() => api("/v1/staff/floor/seat", { method: "POST", json: { tableId: table.id, party: r.party, reservationId: r.id } }))}
                    className="cta cta-dark px-4 py-2"
                  >
                    <span>Seat at {table.label}</span>
                  </button>
                )}
                {table && <button type="button" onClick={() => onPick(table.id)} className="cta cta-outline px-4 py-2"><span>Show table</span></button>}
                <button
                  type="button"
                  onClick={() => void act(() => api(`/v1/staff/floor/reservations/${r.id}`, { method: "POST", json: { action: "no_show" } }))}
                  className="eyebrow px-2 text-[0.6rem] text-umber hover:text-espresso"
                >
                  No-show
                </button>
                <button
                  type="button"
                  onClick={() => void act(() => api(`/v1/staff/floor/reservations/${r.id}`, { method: "POST", json: { action: "cancel" } }))}
                  className="eyebrow px-2 text-[0.6rem] text-umber hover:text-espresso"
                >
                  Cancel
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Waitlist({
  floor,
  tables,
  now,
  act,
  onPick,
}: {
  floor: FloorView;
  tables: TableView[];
  now: number;
  act: Act;
  onPick: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [party, setParty] = useState(2);
  const [quote, setQuote] = useState(20);
  const free = tables.filter((t) => t.status === "free");
  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void act(() => api("/v1/staff/floor/waitlist", { method: "POST", json: { name, party, quotedMinutes: quote } })).then(() => setName(""));
        }}
        className="mt-5 grid grid-cols-[1fr_4.5rem_4.5rem] gap-2"
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" className="min-w-0 border border-espresso/25 bg-cream px-3 py-3 outline-none focus:border-espresso" />
        <input type="number" min={1} max={12} value={party} onChange={(e) => setParty(Number(e.target.value))} aria-label="Guests" className="border border-espresso/25 bg-cream px-3 py-3 outline-none focus:border-espresso" />
        <input type="number" min={0} max={240} step={5} value={quote} onChange={(e) => setQuote(Number(e.target.value))} aria-label="Quoted wait in minutes" className="border border-espresso/25 bg-cream px-3 py-3 outline-none focus:border-espresso" />
        <button type="submit" className="cta cta-dark col-span-3 px-4 py-3">
          <span>Add to waitlist</span>
        </button>
      </form>
      {floor.waitlist.length === 0 ? (
        <p className="py-8 text-umber">Nobody waiting.</p>
      ) : (
        <ul className="mt-4 divide-y divide-espresso/12">
          {floor.waitlist.map((w) => {
            const waited = minutesSince(w.createdAt, now);
            const late = waited > w.quotedMinutes;
            const match = free.filter((t) => t.seats >= w.party).sort((a, b) => a.seats - b.seats)[0];
            return (
              <li key={w.id} className="py-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">
                    {w.name} · {w.party}
                  </span>
                  <span className={`tabular text-sm ${late ? "font-semibold text-[#8a2e1f]" : "text-umber"}`}>
                    {waited}m of {w.quotedMinutes}m
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {match ? (
                    <button
                      type="button"
                      onClick={() => void act(() => api("/v1/staff/floor/seat", { method: "POST", json: { tableId: match.id, party: w.party, waitlistId: w.id } }))}
                      className="cta cta-dark px-4 py-2"
                    >
                      <span>Seat at {match.label}</span>
                    </button>
                  ) : (
                    <span className="text-sm text-taupe">No free table for {w.party} yet</span>
                  )}
                  {match && <button type="button" onClick={() => onPick(match.id)} className="cta cta-outline px-4 py-2"><span>Other table</span></button>}
                  <button
                    type="button"
                    onClick={() => void act(() => api(`/v1/staff/floor/waitlist/${w.id}`, { method: "DELETE" }))}
                    className="eyebrow px-2 text-[0.6rem] text-umber hover:text-espresso"
                  >
                    Left
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PhoneBooking({ tz, act, onDone }: { tz: string; act: Act; onDone: () => void }) {
  const [date, setDate] = useState(() => localDate(tz));
  const [time, setTime] = useState("19:00");
  const [party, setParty] = useState(2);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const input = "w-full border border-espresso/25 bg-cream px-3 py-3 outline-none focus:border-espresso";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void act(() => api<ReservationView>("/v1/staff/floor/reservations", { method: "POST", json: { date, time, party, name, phone, notes } })).then(
          (r) => r && onDone(),
        );
      }}
      className="mt-5 grid grid-cols-2 gap-3"
    >
      <label className="text-sm">
        Day
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} required />
      </label>
      <label className="text-sm">
        Time
        <input type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} className={input} required />
      </label>
      <label className="text-sm">
        Guests
        <input type="number" min={1} max={12} value={party} onChange={(e) => setParty(Number(e.target.value))} className={input} required />
      </label>
      <label className="text-sm">
        Phone
        <input value={phone} onChange={(e) => setPhone(e.target.value)} className={input} required minLength={6} />
      </label>
      <label className="col-span-2 text-sm">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} className={input} required />
      </label>
      <label className="col-span-2 text-sm">
        Notes
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className={input} />
      </label>
      <button type="submit" className="cta cta-dark col-span-2 px-4 py-3">
        <span>Book it</span>
      </button>
      <p className="col-span-2 text-sm text-taupe">Times are on the quarter hour. The best free table is chosen for you.</p>
    </form>
  );
}
