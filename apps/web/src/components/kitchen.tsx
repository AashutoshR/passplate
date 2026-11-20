import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACTIVE_STATUSES,
  FINAL_STATUSES,
  channels,
  nextKitchenStep,
  type KitchenSnapshot,
  type MenuItemView,
  type MenuView,
  type OrderStatus,
  type StockChange,
  type TicketView,
} from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { storage, uuid } from "../lib/ids";
import { RealtimeClient, useLatest, useNow, type LinkStatus } from "../lib/realtime";
import { Logo } from "./brand";

/** The restaurant a signed-in member of staff works at. The session cookie does the rest. */
export interface KitchenSession {
  locationId: string;
  locationName: string;
}

/** A tap waiting to reach the server. Kept on the device so Wi-Fi drops lose nothing (FR-13). */
interface QueuedAction {
  orderId: string;
  number: number;
  from: OrderStatus;
  to: OrderStatus;
  actionId: string;
}

const queueKey = (locationId: string) => `pass:kitchen-queue:${locationId}`;

function deviceName(): string {
  let name = storage.get<string | null>("pass:device", null);
  if (!name) {
    name = `Kitchen screen ${uuid().slice(0, 4).toUpperCase()}`;
    storage.set("pass:device", name);
  }
  return name;
}

function beep() {
  try {
    const ctx = new AudioContext();
    [0, 0.22].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.2);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    // Audio not available: the visual highlight still shows.
  }
}

export function KitchenBoard({
  slug,
  session,
  onLogout,
}: {
  slug: string;
  session: KitchenSession;
  onLogout: () => void;
}) {
  const id = session.locationId;
  // Same-origin requests carry the staff session cookie; nothing else to send.
  const auth = useMemo(() => ({}), []);
  const [tickets, setTickets] = useState<Map<string, TicketView>>(new Map());
  const [loc, setLoc] = useState<KitchenSnapshot["location"] | null>(null);
  const [link, setLink] = useState<LinkStatus>("connecting");
  const [queue, setQueue] = useState<QueuedAction[]>(() => storage.get(queueKey(id), []));
  const [menuItems, setMenuItems] = useState<MenuItemView[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [sound, setSound] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stockOpen, setStockOpen] = useState(false);
  const soundRef = useLatest(sound);
  const logoutRef = useLatest(onLogout);
  const clientRef = useRef<RealtimeClient | null>(null);
  const now = useNow(1000);

  const applyTicket = useCallback((t: TicketView) => {
    setTickets((prev) => {
      const cur = prev.get(t.id);
      if (cur && cur.version > t.version) return prev;
      const next = new Map(prev);
      if (ACTIVE_STATUSES.includes(t.status)) next.set(t.id, t);
      else next.delete(t.id);
      return next;
    });
  }, []);

  const loadSnapshot = useCallback(async () => {
    const snap = await api<KitchenSnapshot>(`/v1/kitchen/${id}/tickets`, { headers: auth });
    setLoc(snap.location);
    setTickets((prev) => {
      const next = new Map<string, TicketView>();
      for (const t of snap.tickets) {
        const cur = prev.get(t.id);
        next.set(t.id, cur && cur.version > t.version ? cur : t);
      }
      return next;
    });
    clientRef.current?.advanceTo(snap.seq);
    setLoadError(null);
    return snap.seq;
  }, [id, auth]);

  const handleAuthError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        logoutRef.current();
        return true;
      }
      return false;
    },
    [logoutRef],
  );

  // Start: snapshot + menu, then one resumable subscription for tickets and stock.
  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    async function start() {
      try {
        const [seq, menu] = await Promise.all([
          loadSnapshot(),
          api<MenuView>(`/v1/locations/${encodeURIComponent(slug)}/menu`, { cache: "no-cache" }),
        ]);
        if (stopped) return;
        setMenuItems(menu.categories.flatMap((c) => c.items));
        const client = new RealtimeClient({
          channels: [channels.kitchen(id), channels.menu(id)],
          since: Math.min(seq, menu.seq),
          onEvent: (e) => {
            if (e.type === "ticket.created" || e.type === "ticket.updated") {
              const t = e.payload as TicketView;
              applyTicket(t);
              if (e.type === "ticket.created") {
                setFresh((s) => new Set(s).add(t.id));
                setTimeout(() => setFresh((s) => (s.delete(t.id), new Set(s))), 4000);
                if (soundRef.current) beep();
              }
            } else if (e.type === "menu.item_updated") {
              const s = e.payload as StockChange;
              setMenuItems((items) => items.map((i) => (i.id === s.id ? { ...i, stock: s.stock, soldOut: s.soldOut } : i)));
            }
          },
          onResync: loadSnapshot,
          onStatus: setLink,
          onForbidden: () => logoutRef.current(),
        });
        clientRef.current = client;
        client.start();
      } catch (err) {
        if (stopped || handleAuthError(err)) return;
        setLoadError("Cannot reach the server. Retrying…");
        retry = setTimeout(start, Math.min(15_000, 1000 * 2 ** attempt++));
      }
    }
    void start();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clientRef.current?.stop();
      clientRef.current = null;
    };
  }, [id, slug, loadSnapshot, applyTicket, handleAuthError, soundRef, logoutRef]);

  // Send queued taps in order. Network trouble keeps them; a final answer removes them.
  const flushing = useRef(false);
  const flush = useCallback(async () => {
    if (flushing.current) return;
    flushing.current = true;
    try {
      for (;;) {
        const head = storage.get<QueuedAction[]>(queueKey(id), [])[0];
        if (!head) break;
        try {
          const t = await api<TicketView>(`/v1/kitchen/${id}/tickets/${head.orderId}/transition`, {
            method: "POST",
            headers: auth,
            json: { from: head.from, to: head.to, actionId: head.actionId, device: deviceName() },
          });
          applyTicket(t);
        } catch (err) {
          if (handleAuthError(err)) return;
          if (!(err instanceof ApiError) || err.status >= 500 || err.status === 429) break; // retry later
          const current = (err.details as { current?: TicketView } | undefined)?.current;
          if (current) applyTicket(current);
          setNotice(`#${head.number}: ${err.message}`);
        }
        const rest = storage.get<QueuedAction[]>(queueKey(id), []).filter((a) => a.actionId !== head.actionId);
        storage.set(queueKey(id), rest);
        setQueue(rest);
      }
    } finally {
      flushing.current = false;
    }
  }, [id, auth, applyTicket, handleAuthError]);

  useEffect(() => {
    void flush();
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    const t = setInterval(() => void flush(), 5000);
    return () => {
      window.removeEventListener("online", onOnline);
      clearInterval(t);
    };
  }, [flush]);

  useEffect(() => {
    if (link === "live") void flush();
  }, [link, flush]);

  // Redis or the socket is down: keep the board fresh by polling every 5 s.
  useEffect(() => {
    if (link === "live") return;
    const t = setInterval(() => void loadSnapshot().catch((err) => handleAuthError(err)), 5000);
    return () => clearInterval(t);
  }, [link, loadSnapshot, handleAuthError]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  /** Status after taps that have not reached the server yet. */
  const shownStatus = (t: TicketView): OrderStatus => {
    const pending = queue.filter((a) => a.orderId === t.id);
    return pending.length ? pending[pending.length - 1]!.to : t.status;
  };

  function act(t: TicketView, to: OrderStatus) {
    const action: QueuedAction = { orderId: t.id, number: t.number, from: shownStatus(t), to, actionId: uuid() };
    const next = [...storage.get<QueuedAction[]>(queueKey(id), []), action];
    storage.set(queueKey(id), next);
    setQueue(next);
    void flush();
  }

  const board = [...tickets.values()]
    .map((t) => ({ ticket: t, status: shownStatus(t) }))
    .filter((x) => !FINAL_STATUSES.includes(x.status))
    .sort((a, b) => a.ticket.createdAt.localeCompare(b.ticket.createdAt));
  const columns: { status: OrderStatus; title: string; color: string }[] = [
    { status: "received", title: "New", color: "#a9bccd" },
    { status: "cooking", title: "On the stove", color: "#e6cf7a" },
    { status: "ready", title: "At the pass", color: "#d2f34c" },
  ];
  const target = loc?.targetPrepSeconds ?? 900;

  return (
    <div className="theme-dark flex min-h-dvh flex-col bg-ink text-bone">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b-2 border-rule px-5 py-4">
        <div className="mr-auto flex min-w-0 items-center gap-5">
          <Logo size="sm" tone="light" />
          <span className="hidden h-6 w-0.5 bg-rule sm:block" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="truncate font-serif text-2xl leading-none">{loc?.name ?? session.locationName}</h1>
            <p className="label mt-1 text-[0.62rem]">Kitchen · {deviceNameSafe()}</p>
          </div>
        </div>
        <LinkPill link={link} />
        {queue.length > 0 && (
          <span className="tag drop text-straw" role="status">
            {queue.length} tap{queue.length === 1 ? "" : "s"} waiting to send
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            if (!sound) beep();
            setSound((s) => !s);
          }}
          aria-pressed={sound}
          className={`btn px-3 py-1.5 text-sm ${sound ? "btn-ghost border-volt text-volt" : "btn-ghost border-rule"}`}
        >
          Sound {sound ? "on" : "off"}
        </button>
        <button type="button" onClick={() => setStockOpen(true)} className="btn btn-ghost border-rule px-3 py-1.5 text-sm">
          Stock
        </button>
        <span className="tabular font-mono text-2xl text-bone" aria-label="Time">
          {new Date(now).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
        </span>
        <button type="button" onClick={onLogout} className="label rule-link hover:text-bone">
          Sign out
        </button>
      </header>

      {loadError && (
        <p role="alert" className="border-b-2 border-ember bg-ember/10 px-5 py-2.5 text-ember">
          {loadError}
        </p>
      )}
      {link !== "live" && !loadError && (
        <p role="status" className="border-b-2 border-straw/50 bg-straw/10 px-5 py-2.5 text-straw">
          {link === "offline"
            ? "Offline. Taps are saved on this screen and sent when the connection is back."
            : link === "degraded"
              ? "Live updates paused. Refreshing every 5 seconds."
              : "Connecting…"}
        </p>
      )}

      <div className="grid flex-1 lg:grid-cols-3">
        {columns.map((col, ci) => {
          const list = board.filter((x) => x.status === col.status);
          return (
            <section
              key={col.status}
              aria-label={col.title}
              className={`flex min-h-0 flex-col ${ci > 0 ? "border-t-2 border-rule lg:border-t-0 lg:border-l-2" : ""}`}
            >
              <h2 className="flex items-center justify-between border-b-2 border-rule px-5 py-3.5">
                <span className="flex items-center gap-3">
                  <span className="size-2.5" style={{ background: col.color }} aria-hidden="true" />
                  <span className="label text-bone">{col.title}</span>
                </span>
                <span key={list.length} className="tick font-mono text-lg text-stone">
                  {String(list.length).padStart(2, "0")}
                </span>
              </h2>
              <div className="flex flex-col gap-6 overflow-y-auto p-5 pt-7">
                {list.length === 0 && <p className="py-14 text-center font-serif text-2xl text-ash italic">All clear</p>}
                {list.map(({ ticket, status }) => (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    status={status}
                    color={col.color}
                    pending={queue.some((a) => a.orderId === ticket.id)}
                    isNew={fresh.has(ticket.id)}
                    now={now}
                    targetSeconds={target}
                    onAct={(to) => act(ticket, to)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {notice && (
        <div role="alert" className="drop fixed bottom-6 left-1/2 z-50 -translate-x-1/2 border-2 border-straw bg-coal px-5 py-3 text-straw">
          {notice}
        </div>
      )}

      {stockOpen && (
        <StockPanel
          items={menuItems}
          locationId={id}
          auth={auth}
          onClose={() => setStockOpen(false)}
          onChange={(s) =>
            setMenuItems((items) => items.map((i) => (i.id === s.id ? { ...i, stock: s.stock, soldOut: s.soldOut } : i)))
          }
          onError={(m) => setNotice(m)}
        />
      )}
    </div>
  );
}

function deviceNameSafe(): string {
  return typeof window === "undefined" ? "" : deviceName();
}

function LinkPill({ link }: { link: LinkStatus }) {
  const map: Record<LinkStatus, [string, string]> = {
    live: ["Live", "text-volt"],
    connecting: ["Reconnecting", "text-straw"],
    degraded: ["Polling", "text-straw"],
    offline: ["Offline", "text-ember"],
  };
  const [label, color] = map[link];
  return (
    <span className={`tag ${color}`} role="status">
      <span className={`size-1.5 bg-current ${link === "live" ? "pulse-dot" : ""}`} aria-hidden="true" />
      {label}
    </span>
  );
}

const ACTION_COLOR: Partial<Record<OrderStatus, string>> = {
  cooking: "#e6cf7a",
  ready: "#d2f34c",
  completed: "#ece6d9",
};

function TicketCard({
  ticket,
  status,
  color,
  pending,
  isNew,
  now,
  targetSeconds,
  onAct,
}: {
  ticket: TicketView;
  status: OrderStatus;
  color: string;
  pending: boolean;
  isNew: boolean;
  now: number;
  targetSeconds: number;
  onAct: (to: OrderStatus) => void;
}) {
  const ageSec = Math.max(0, Math.floor((now - Date.parse(ticket.createdAt)) / 1000));
  const late = ageSec > targetSeconds;
  const warn = !late && ageSec > targetSeconds * 0.6;
  const step = nextKitchenStep(ticket.type, status);
  const mm = String(Math.floor(ageSec / 60)).padStart(2, "0");
  const ss = String(ageSec % 60).padStart(2, "0");

  return (
    <article
      className={`docket px-5 pt-6 pb-5 ${isNew ? "flash" : "drop"}`}
      style={{
        ["--edge" as string]: "#0b0b0a",
        boxShadow: `6px 6px 0 0 ${late ? "#ff5a4f" : color}`,
      }}
      aria-label={`Order ${ticket.number}${late ? ", late" : ""}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-4xl leading-none font-semibold">#{ticket.number}</p>
          <p className="mt-2 font-mono text-[0.68rem] font-semibold tracking-[0.14em] uppercase text-ink/60">
            {ticket.tableLabel ?? "Pickup"} · {ticket.customerName}
          </p>
        </div>
        <div className="text-right">
          <span
            className={`tabular inline-block border-2 border-ink px-2 py-0.5 font-mono text-lg font-semibold ${
              late ? "bg-ember text-ink" : warn ? "bg-straw" : ""
            }`}
          >
            {mm}:{ss}
          </span>
          {late && (
            <p className="stamp-in mt-2 font-mono text-[0.68rem] font-bold tracking-[0.18em] text-ember uppercase">Late</p>
          )}
        </div>
      </header>

      <ul className="mt-4 space-y-2.5 border-t border-dashed border-ink/40 pt-4">
        {ticket.items.map((item, i) => (
          <li key={i} className="text-lg leading-snug">
            <span className="font-mono font-semibold">{item.quantity}×</span> <span className="font-semibold">{item.name}</span>
            {item.modifiers.length > 0 && <p className="pl-8 text-base text-ink/60">{item.modifiers.join(", ")}</p>}
            {item.notes && (
              <p className="mt-1 ml-8 inline-block border-l-4 border-ink bg-ink/5 px-2 py-0.5 text-base font-medium italic">
                “{item.notes}”
              </p>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-5 flex items-stretch gap-2">
        {step && (
          <button
            type="button"
            onClick={() => onAct(step.to)}
            className="btn flex-1 border-ink px-4 py-3 text-lg text-ink hover:brightness-95 active:translate-x-0.5 active:translate-y-0.5"
            style={{ background: ACTION_COLOR[step.to] ?? "#d2f34c" }}
          >
            {step.label} <span aria-hidden="true">→</span>
          </button>
        )}
        {(status === "received" || status === "cooking") && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Cancel order #${ticket.number}?`)) onAct("cancelled");
            }}
            className="btn border-ink/30 bg-transparent px-3 py-3 text-sm text-ink/70 hover:border-ink hover:text-ink"
          >
            Cancel
          </button>
        )}
      </div>
      {pending && <p className="pulse-dot mt-3 font-mono text-[0.65rem] font-semibold tracking-[0.18em] uppercase">Saving…</p>}
    </article>
  );
}

function StockPanel({
  items,
  locationId,
  auth,
  onClose,
  onChange,
  onError,
}: {
  items: MenuItemView[];
  locationId: string;
  auth: Record<string, string>;
  onClose: () => void;
  onChange: (s: StockChange) => void;
  onError: (message: string) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function update(item: MenuItemView, body: { soldOut?: boolean; stock?: number | null }) {
    try {
      onChange(await api<StockChange>(`/v1/kitchen/${locationId}/items/${item.id}`, { method: "PATCH", headers: auth, json: body }));
    } catch (err) {
      onError(err instanceof ApiError ? err.message : `Could not update ${item.name}. Check the connection.`);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Close stock" className="fade-in absolute inset-0 bg-ink/70" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label="Stock" className="sheet-up relative flex h-full w-full max-w-md flex-col border-l-2 border-rule bg-coal">
        <div className="flex items-center justify-between border-b-2 border-rule px-6 py-5">
          <div>
            <p className="label">[ 86 board ]</p>
            <h2 className="mt-1 font-serif text-3xl">Stock</h2>
          </div>
          <button type="button" onClick={onClose} className="btn btn-ghost border-rule px-3 py-1.5 text-sm">
            Close
          </button>
        </div>
        <p className="px-6 pt-4 text-sm text-stone">Changes reach every guest's menu within a second or two.</p>
        <ul className="overflow-y-auto px-6 py-4">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 border-b border-rule py-3.5">
              <span className={`flex-1 ${item.soldOut ? "text-ash line-through" : ""}`}>{item.name}</span>
              {item.stock !== null && (
                <span className="flex items-center border-2 border-rule font-mono">
                  <button
                    type="button"
                    aria-label={`One fewer ${item.name}`}
                    onClick={() => update(item, { stock: Math.max(0, item.stock! - 1) })}
                    className="px-2.5 py-1 hover:bg-char"
                  >
                    −
                  </button>
                  <span key={item.stock} className="tabular tick w-7 text-center">
                    {item.stock}
                  </span>
                  <button
                    type="button"
                    aria-label={`One more ${item.name}`}
                    onClick={() => update(item, { stock: item.stock! + 1 })}
                    className="px-2.5 py-1 hover:bg-char"
                  >
                    +
                  </button>
                </span>
              )}
              <button
                type="button"
                onClick={() => update(item, { soldOut: !item.soldOut })}
                aria-pressed={item.soldOut}
                className={`btn w-24 px-2 py-1.5 text-xs uppercase tracking-wider ${
                  item.soldOut ? "border-ember bg-ember text-ink" : "btn-ghost border-rule text-volt"
                }`}
              >
                {item.soldOut ? "86'd" : "On"}
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
