import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  ORDER_TYPES,
  PAYMENT_METHODS,
  channels,
  formatMoney,
  localDate,
  type AdminOverview,
  type GuestView,
  type InviteView,
  type OrderType,
  type PaymentMethod,
  type StaffMemberView,
  type TransactionView,
  type TransactionsView,
} from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { useAccount } from "../lib/account";
import { RealtimeClient } from "../lib/realtime";
import { ROLE_LABEL, StaffShell } from "../components/staff";
import { MenuEditor } from "../components/menu-editor";

const TABS = ["overview", "transactions", "menu", "team", "guests"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", transactions: "Transactions", menu: "Menu", team: "Team", guests: "Guests" };

export const Route = createFileRoute("/staff/admin")({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({
    tab: (TABS as readonly string[]).includes(s.tab as string) ? (s.tab as Tab) : undefined,
  }),
  head: () => ({ meta: [{ title: "Admin · PassPlate" }, { name: "robots", content: "noindex" }] }),
  component: () => (
    <StaffShell roles={["admin"]}>
      <Admin />
    </StaffShell>
  ),
});

const TYPE_LABEL: Record<OrderType, string> = { dine_in: "Table", pickup: "Collect", delivery: "Delivery" };
const METHOD_LABEL: Record<PaymentMethod, string> = { card: "Card", cash: "Cash", online: "Online" };
const TZ = "Europe/London";

function Admin() {
  const { tab = "overview" } = Route.useSearch();
  return (
    <main className="mx-auto max-w-[1440px] px-4 py-8 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-serif text-4xl">Admin</h1>
        <nav className="flex border border-espresso/20 bg-cream" aria-label="Admin sections">
          {TABS.map((t) => (
            <Link
              key={t}
              to="/staff/admin"
              search={{ tab: t }}
              className={`eyebrow px-4 py-2.5 text-[0.62rem] ${tab === t ? "bg-espresso text-cream" : "text-umber hover:text-espresso"}`}
            >
              {TAB_LABEL[t]}
            </Link>
          ))}
        </nav>
      </div>
      <div className="mt-8">
        {tab === "overview" && <Overview />}
        {tab === "transactions" && <Transactions />}
        {tab === "menu" && <MenuEditor />}
        {tab === "team" && <Team />}
        {tab === "guests" && <Guests />}
      </div>
    </main>
  );
}

function Overview() {
  const [o, setO] = useState<AdminOverview | null>(null);
  useEffect(() => {
    void api<AdminOverview>("/v1/staff/admin/overview").then(setO);
  }, []);
  if (!o) return <p className="text-taupe">Loading…</p>;
  const money = (m: number) => formatMoney(m, o.location.currency);
  return (
    <div className="space-y-6">
      <div className="grid gap-px border border-espresso/15 bg-espresso/15 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Takings today", money(o.today.revenueMinor)],
          ["Orders", String(o.today.orders)],
          ["Average order", money(o.today.averageMinor)],
          ["Bookings", String(o.today.bookings)],
          ["Covers booked", String(o.today.covers)],
          ["Deliveries", String(o.today.deliveries)],
        ].map(([k, v]) => (
          <div key={k} className="bg-cream p-5">
            <p className="text-sm text-taupe">{k}</p>
            <p className="tabular mt-2 font-serif text-3xl">{v}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <section className="border border-espresso/15 bg-cream p-6">
          <h2 className="font-serif text-2xl">Takings, last 14 days</h2>
          <p className="text-sm text-umber">Net of refunds, by the day the money came in.</p>
          <RevenueChart days={o.days} money={money} />
        </section>
        <section className="border border-espresso/15 bg-cream p-6">
          <h2 className="font-serif text-2xl">What sells</h2>
          <p className="text-sm text-umber">Last 14 days, by portions.</p>
          <table className="mt-4 w-full text-left">
            <thead>
              <tr className="text-sm text-taupe">
                <th className="py-2 font-normal">Dish</th>
                <th className="py-2 text-right font-normal">Sold</th>
                <th className="py-2 text-right font-normal">Takings</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-espresso/10">
              {o.topItems.map((t) => (
                <tr key={t.name}>
                  <td className="py-2.5">{t.name}</td>
                  <td className="tabular py-2.5 text-right">{t.quantity}</td>
                  <td className="tabular py-2.5 text-right">{money(t.revenueMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

/** One series, so no legend: the title names it. Bars start at zero; hover any day for its numbers. */
function RevenueChart({ days, money }: { days: AdminOverview["days"]; money: (m: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const W = 700;
  const H = 240;
  const pad = { l: 56, r: 8, t: 12, b: 28 };
  const max = Math.max(1, ...days.map((d) => d.revenueMinor));
  // A round top for the scale, so ticks land on plain numbers.
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const bw = (W - pad.l - pad.r) / days.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const label = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

  if (asTable) {
    return (
      <div className="mt-4">
        <button type="button" onClick={() => setAsTable(false)} className="eyebrow text-[0.6rem] text-brass">
          Show chart
        </button>
        <table className="mt-3 w-full text-left text-sm">
          <tbody className="divide-y divide-espresso/10">
            {days.map((d) => (
              <tr key={d.date}>
                <td className="py-1.5">{label(d.date)}</td>
                <td className="tabular py-1.5 text-right">{d.orders} orders</td>
                <td className="tabular py-1.5 text-right">{money(d.revenueMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="relative mt-4">
      <button type="button" onClick={() => setAsTable(true)} className="eyebrow absolute -top-10 right-0 text-[0.6rem] text-brass">
        Show as table
      </button>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Takings per day for the last 14 days">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="#17241e" strokeOpacity={t === 0 ? 0.35 : 0.08} />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#7d837b">
              {money(t).replace(/\.00$/, "")}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = pad.l + i * bw + 1;
          const w = Math.max(2, bw - 2);
          const h = H - pad.b - y(d.revenueMinor);
          const r = Math.min(4, w / 2, h);
          const on = hover === i;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {/* Hit area larger than the bar. */}
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {h > 0 && (
                <path
                  d={`M${x},${H - pad.b} V${y(d.revenueMinor) + r} Q${x},${y(d.revenueMinor)} ${x + r},${y(d.revenueMinor)} H${x + w - r} Q${x + w},${y(d.revenueMinor)} ${x + w},${y(d.revenueMinor) + r} V${H - pad.b} Z`}
                  fill={on ? "#a9844f" : "#17241e"}
                  fillOpacity={on ? 1 : 0.85}
                />
              )}
              {(i % 2 === 0 || days.length <= 7) && (
                <text x={pad.l + i * bw + bw / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="#7d837b">
                  {label(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && days[hover] && (
        <div
          className="pointer-events-none absolute z-10 border border-espresso/15 bg-cream px-3 py-2 text-sm shadow-md"
          style={{ left: `${((pad.l + hover * bw + bw / 2) / W) * 100}%`, top: 0, transform: "translateX(-50%)" }}
        >
          <p className="font-medium">{label(days[hover].date)}</p>
          <p className="tabular">{money(days[hover].revenueMinor)}</p>
          <p className="text-taupe">{days[hover].orders} orders</p>
        </div>
      )}
    </div>
  );
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function Transactions() {
  const today = localDate(TZ);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [type, setType] = useState<OrderType | "">("");
  const [data, setData] = useState<TransactionsView | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const { user } = useAccount();

  const query = useMemo(() => {
    const p = new URLSearchParams({ from, to });
    if (method) p.set("method", method);
    if (type) p.set("type", type);
    return p.toString();
  }, [from, to, method, type]);

  const load = useCallback(async () => {
    const d = await api<TransactionsView>(`/v1/staff/admin/transactions?${query}`);
    setData((old) => {
      if (old) {
        const known = new Set(old.transactions.map((t) => t.id));
        setFresh(new Set(d.transactions.filter((t) => !known.has(t.id)).map((t) => t.id)));
      }
      return d;
    });
    return d.seq;
  }, [query]);

  useEffect(() => {
    setData(null);
    load().catch((e) => setError(e instanceof ApiError ? e.message : "Could not load"));
  }, [load]);

  // New payments arrive live while this screen is open.
  useEffect(() => {
    if (!user?.locationId || !data) return;
    const client = new RealtimeClient({
      channels: [channels.admin(user.locationId)],
      since: data.seq,
      onEvent: (e) => e.type === "payment.recorded" && void load(),
      onResync: load,
    });
    client.start();
    return () => client.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.locationId, data === null, load]);

  const money = (m: number) => formatMoney(m, data?.currency ?? "GBP");

  function exportCsv() {
    if (!data) return;
    const rows = [
      ["Time", "Order", "Type", "Guest", "Table", "Kind", "Method", "Amount", "Discount", "Delivery fee", "Taken by"],
      ...data.transactions.map((t) => [
        new Date(t.createdAt).toLocaleString("en-GB", { timeZone: TZ }),
        `#${t.order.number}`,
        TYPE_LABEL[t.order.type],
        t.order.customerName,
        t.order.tableLabel ?? "",
        t.kind,
        METHOD_LABEL[t.method],
        ((t.kind === "refund" ? -1 : 1) * t.amountMinor / 100).toFixed(2),
        (t.order.discountMinor / 100).toFixed(2),
        (t.order.deliveryFeeMinor / 100).toFixed(2),
        t.takenBy ?? "",
      ]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `passplate-transactions-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function refund(t: TransactionView) {
    if (!window.confirm(`Refund ${money(t.amountMinor)} for order #${t.order.number}?`)) return;
    try {
      await api(`/v1/staff/admin/orders/${t.order.id}/refund`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Refund failed");
    }
  }

  const refunded = new Set(data?.transactions.filter((t) => t.kind === "refund").map((t) => t.order.id));
  const sel = "border border-espresso/25 bg-cream px-3 py-2.5 outline-none focus:border-espresso";

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-taupe">From</span>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={sel} />
        </label>
        <label className="text-sm">
          <span className="block text-taupe">To</span>
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={sel} />
        </label>
        <label className="text-sm">
          <span className="block text-taupe">Method</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod | "")} className={sel}>
            <option value="">All</option>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-taupe">Order type</span>
          <select value={type} onChange={(e) => setType(e.target.value as OrderType | "")} className={sel}>
            <option value="">All</option>
            {ORDER_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          {[
            ["Today", 0],
            ["7 days", 6],
            ["30 days", 29],
          ].map(([label, back]) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                setFrom(localDate(TZ, new Date(Date.now() - (back as number) * 86_400_000)));
                setTo(today);
              }}
              className="border border-espresso/20 bg-cream px-3 py-2.5 text-sm hover:border-espresso"
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={exportCsv} disabled={!data} className="cta cta-outline ml-auto px-5 py-2.5">
          <span>Download CSV</span>
        </button>
      </div>
      {error && <p className="mt-4 border border-brass px-4 py-3">{error}</p>}

      {!data ? (
        <p className="mt-8 text-taupe">Loading…</p>
      ) : (
        <>
          <div className="mt-6 grid gap-px border border-espresso/15 bg-espresso/15 sm:grid-cols-2 lg:grid-cols-5">
            {[
              ["Taken", money(data.totals.grossMinor), `${data.totals.count} payments`],
              ["Refunded", money(data.totals.refundsMinor), ""],
              ["Net", money(data.totals.netMinor), ""],
              ["Rewards given", money(data.totals.discountsMinor), "Already off the totals"],
              [
                "By method",
                PAYMENT_METHODS.map((m) => `${METHOD_LABEL[m]} ${money(data.byMethod[m])}`).join(" · "),
                ORDER_TYPES.map((t) => `${TYPE_LABEL[t]} ${money(data.byType[t])}`).join(" · "),
              ],
            ].map(([k, v, sub]) => (
              <div key={k} className="bg-cream p-5">
                <p className="text-sm text-taupe">{k}</p>
                <p className={`tabular mt-2 ${k === "By method" ? "text-sm leading-relaxed" : "font-serif text-3xl"}`}>{v}</p>
                {sub && <p className="mt-1 text-xs text-taupe">{sub}</p>}
              </div>
            ))}
          </div>

          <div className="mt-6 overflow-x-auto border border-espresso/15 bg-cream">
            <table className="w-full min-w-[880px] text-left">
              <thead className="border-b border-espresso/15 text-sm text-taupe">
                <tr>
                  {["Time", "Order", "Type", "Guest", "Method", "Taken by", "Amount", ""].map((h) => (
                    <th key={h} className={`px-4 py-3 font-normal ${h === "Amount" ? "text-right" : ""}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-espresso/10">
                {data.transactions.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-umber">
                      No transactions for these filters.
                    </td>
                  </tr>
                )}
                {data.transactions.map((t) => (
                  <tr key={t.id} className={fresh.has(t.id) ? "drop bg-brass/10" : ""}>
                    <td className="tabular px-4 py-3 text-sm">
                      {new Date(t.createdAt).toLocaleString("en-GB", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="tabular px-4 py-3">#{t.order.number}</td>
                    <td className="px-4 py-3">
                      {TYPE_LABEL[t.order.type]}
                      {t.order.tableLabel ? ` · ${t.order.tableLabel}` : ""}
                    </td>
                    <td className="px-4 py-3">
                      {t.order.customerName}
                      {t.order.discountMinor > 0 && <span className="ml-2 text-xs text-brass">reward −{money(t.order.discountMinor)}</span>}
                    </td>
                    <td className="px-4 py-3">{METHOD_LABEL[t.method]}</td>
                    <td className="px-4 py-3 text-sm text-umber">{t.takenBy ?? (t.method === "online" ? "Online" : "")}</td>
                    <td className={`tabular px-4 py-3 text-right ${t.kind === "refund" ? "text-[#8a2e1f]" : ""}`}>
                      {t.kind === "refund" ? `−${money(t.amountMinor)}` : money(t.amountMinor)}
                      {t.kind === "refund" && <span className="block text-xs">Refund</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {t.kind === "payment" && !refunded.has(t.order.id) && (
                        <button type="button" onClick={() => void refund(t)} className="eyebrow text-[0.58rem] text-umber hover:text-espresso">
                          Refund
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Team() {
  const [staff, setStaff] = useState<StaffMemberView[] | null>(null);
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [form, setForm] = useState({ name: "", email: "", role: "staff" as InviteView["role"] });
  const [made, setMade] = useState<InviteView | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [s, i] = await Promise.all([
      api<{ staff: StaffMemberView[] }>("/v1/staff/admin/staff"),
      api<{ invites: InviteView[] }>("/v1/staff/admin/invites"),
    ]);
    setStaff(s.staff);
    setInvites(i.invites);
  }, []);
  useEffect(() => void load(), [load]);
  const input = "w-full border border-espresso/25 bg-cream px-3 py-3 outline-none focus:border-espresso";
  const roleName = (r: InviteView["role"]) => ROLE_LABEL[r];

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCopied(false);
    try {
      const created = await api<InviteView>("/v1/staff/admin/invites", {
        method: "POST",
        json: { role: form.role, ...(form.name.trim() ? { name: form.name.trim() } : {}), ...(form.email.trim() ? { email: form.email.trim() } : {}) },
      });
      setMade(created);
      setForm({ name: "", email: "", role: "staff" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? ((err.details as { message: string }[] | undefined)?.[0]?.message ?? err.message) : "Try again");
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      <div className="grid content-start gap-6">
        <section className="border border-espresso/15 bg-cream">
          <table className="w-full text-left">
            <thead className="border-b border-espresso/15 text-sm text-taupe">
              <tr>
                <th className="px-4 py-3 font-normal">Name</th>
                <th className="px-4 py-3 font-normal">Role</th>
                <th className="px-4 py-3 font-normal">Last signed in</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-espresso/10">
              {staff?.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-3">
                    <span className="font-medium">{s.name}</span>
                    <span className="block text-sm text-umber">{s.email}</span>
                  </td>
                  <td className="px-4 py-3">{ROLE_LABEL[s.role]}</td>
                  <td className="px-4 py-3 text-sm text-umber">
                    {s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString("en-GB", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }) : "Never"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!window.confirm(`Remove ${s.name}'s staff access?`)) return;
                        try {
                          await api(`/v1/staff/admin/staff/${s.id}`, { method: "DELETE" });
                          await load();
                        } catch (err) {
                          setError(err instanceof ApiError ? err.message : "Try again");
                        }
                      }}
                      className="eyebrow text-[0.58rem] text-umber hover:text-espresso"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        {invites.length > 0 && (
          <section className="border border-espresso/15 bg-cream">
            <h2 className="border-b border-espresso/15 px-4 py-3 font-serif text-2xl">Waiting to join</h2>
            <ul className="divide-y divide-espresso/10">
              {invites.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <span>
                    <span className="font-medium">{i.name ?? i.email ?? "Invite"}</span>
                    <span className="block text-sm text-umber">
                      {roleName(i.role)} · link works until {new Date(i.expiresAt).toLocaleDateString("en-GB", { timeZone: TZ, day: "numeric", month: "short" })}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      await api(`/v1/staff/admin/invites/${i.id}`, { method: "DELETE" }).catch(() => {});
                      await load();
                    }}
                    className="eyebrow text-[0.58rem] text-umber hover:text-espresso"
                  >
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <form onSubmit={invite} className="grid content-start gap-3 border border-espresso/15 bg-cream p-6">
        <h2 className="font-serif text-2xl">Invite someone</h2>
        <p className="text-sm text-umber">They get a link, choose their own password, and can start straight away.</p>
        <select className={input} aria-label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as InviteView["role"] })}>
          <option value="staff">Front of house and kitchen</option>
          <option value="driver">Driver</option>
          <option value="admin">Admin</option>
        </select>
        <input className={input} placeholder="Their name (optional)" aria-label="Their name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className={input} placeholder="Work email (optional, locks the link to it)" aria-label="Work email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        {error && <p className="border border-brass px-3 py-2 text-sm">{error}</p>}
        <button type="submit" className="cta cta-dark px-5 py-3">
          <span>Make an invite link</span>
        </button>
        {made?.url && (
          <div role="status" className="mt-2 border border-olive/60 bg-olive/5 p-4">
            <p className="text-sm font-medium">Send this link to {made.name ?? "them"}. It works once, for 7 days.</p>
            <p className="mt-2 break-all font-mono text-sm text-umber" id="invite-url">
              {made.url}
            </p>
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(made.url!);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
              className="eyebrow mt-3 text-[0.6rem] text-brass"
            >
              {copied ? "Copied" : "Copy the link"}
            </button>
            <p className="mt-2 text-xs text-taupe">This is the only time the link is shown.</p>
          </div>
        )}
      </form>
    </div>
  );
}

function Guests() {
  const [guests, setGuests] = useState<GuestView[] | null>(null);
  useEffect(() => void api<{ guests: GuestView[] }>("/v1/staff/admin/guests").then((r) => setGuests(r.guests)), []);
  if (!guests) return <p className="text-taupe">Loading…</p>;
  return (
    <div className="overflow-x-auto border border-espresso/15 bg-cream">
      <table className="w-full min-w-[720px] text-left">
        <thead className="border-b border-espresso/15 text-sm text-taupe">
          <tr>
            <th className="px-4 py-3 font-normal">Guest</th>
            <th className="px-4 py-3 text-right font-normal">Orders</th>
            <th className="px-4 py-3 font-normal">Stamps</th>
            <th className="px-4 py-3 text-right font-normal">Spent</th>
            <th className="px-4 py-3 font-normal">Last order</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-espresso/10">
          {guests.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center text-umber">
                No guest accounts yet.
              </td>
            </tr>
          )}
          {guests.map((g) => (
            <tr key={g.id}>
              <td className="px-4 py-3">
                <span className="font-medium">{g.name}</span>
                <span className="block text-sm text-umber">{g.email}</span>
              </td>
              <td className="tabular px-4 py-3 text-right">{g.completedOrders}</td>
              <td className="px-4 py-3">
                <span className="tabular">{g.completedOrders % 8}/8</span>
                {g.rewardsAvailable > 0 && <span className="ml-2 text-sm text-brass">{g.rewardsAvailable} reward ready</span>}
              </td>
              <td className="tabular px-4 py-3 text-right">{formatMoney(g.spentMinor, "GBP")}</td>
              <td className="px-4 py-3 text-sm text-umber">
                {g.lastOrderAt ? new Date(g.lastOrderAt).toLocaleDateString("en-GB", { timeZone: TZ, dateStyle: "medium" }) : "None"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
