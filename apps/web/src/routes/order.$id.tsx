import { useCallback, useEffect, useState } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import {
  channels,
  customerSteps,
  distanceKm,
  formatMoney,
  rideMinutes,
  type DriverLocation,
  type OrderStatus,
  type TicketView,
} from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { useAccount } from "../lib/account";
import { storage } from "../lib/ids";
import { PaymentPanel } from "../components/payment";
import { RealtimeClient, type LinkStatus } from "../lib/realtime";
import { SITE } from "../lib/site";
import { Logo } from "../components/brand";
import { MapView } from "../components/map";

/** Live order status for the diner (FR-9). */
export const Route = createFileRoute("/order/$id")({
  loader: async ({ params }) => {
    try {
      return await api<{ ticket: TicketView; seq: number }>(`/v1/orders/${encodeURIComponent(params.id)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound();
      throw err;
    }
  },
  head: ({ loaderData }) => ({ meta: [{ title: loaderData ? `Order #${loaderData.ticket.number} · PassPlate` : "Order" }] }),
  component: OrderStatusPage,
});

const STATUS_TEXT: Partial<Record<OrderStatus, string>> = {
  awaiting_payment: "Awaiting payment",
  received: "Received",
  cooking: "Cooking",
  ready: "Ready",
  completed: "Served",
  out_for_delivery: "On its way",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

const STATUS_HINT: Partial<Record<OrderStatus, string>> = {
  received: "The kitchen has your order. This page moves on by itself.",
  cooking: "On the stove now. We will let you know the moment it is ready.",
  completed: "Enjoy your meal.",
};

function OrderStatusPage() {
  const initial = Route.useLoaderData();
  const [ticket, setTicket] = useState(initial.ticket);
  const [link, setLink] = useState<LinkStatus>("connecting");

  const apply = useCallback((t: TicketView) => setTicket((cur) => (t.version >= cur.version ? t : cur)), []);
  const moveDriver = useCallback(
    (p: DriverLocation) =>
      setTicket((cur) =>
        cur.delivery ? { ...cur, delivery: { ...cur.delivery, driver: { lat: p.lat, lng: p.lng, at: p.at } } } : cur,
      ),
    [],
  );
  const { user, rewards, refresh } = useAccount();
  const reload = useCallback(async () => {
    const fresh = await api<{ ticket: TicketView; seq: number }>(`/v1/orders/${ticket.id}`);
    apply(fresh.ticket);
    return fresh.seq;
  }, [ticket.id, apply]);

  useEffect(() => {
    const client = new RealtimeClient({
      channels: [channels.order(initial.ticket.id)],
      since: initial.seq,
      onEvent: (e) => {
        if (e.type === "order.updated") apply(e.payload as TicketView);
        if (e.type === "order.driver_location") moveDriver(e.payload as DriverLocation);
      },
      onResync: reload,
      onStatus: setLink,
    });
    client.start();
    return () => client.stop();
  }, [initial.ticket.id, initial.seq, apply, reload, moveDriver]);

  // Paid: the basket that made this order can go. (Until then it is kept, in
  // case the guest goes back to change something.)
  useEffect(() => {
    if (!ticket.paid) return;
    const kept = storage.get<{ orderId: string; key: string } | null>("pass:basket-for-order", null);
    if (kept?.orderId === ticket.id) {
      storage.remove(kept.key);
      storage.remove("pass:basket-for-order");
    }
  }, [ticket.paid, ticket.id]);

  // A finished order adds a stamp: show the new count.
  useEffect(() => {
    if (["completed", "delivered"].includes(ticket.status)) void refresh();
  }, [ticket.status, refresh]);

  // Fallback while live updates are paused or the phone reconnects.
  useEffect(() => {
    if (link === "live") return;
    const t = setInterval(() => void reload().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [link, reload]);

  const steps = customerSteps(ticket.type);
  const current = steps.findIndex((s) => s.status === ticket.status);
  const cancelled = ticket.status === "cancelled";
  const awaiting = ticket.status === "awaiting_payment";
  const neverPaid = cancelled && !ticket.paid && ticket.type !== "dine_in";
  const money = (m: number) => formatMoney(m, ticket.currency);
  const ready = ticket.status === "ready";
  const d = ticket.delivery;
  const out = ticket.status === "out_for_delivery";
  const driverKm = d?.driver ? distanceKm(d.driver, d) : null;
  const whereLabel = ticket.tableLabel
    ? `${ticket.tableLabel} · ${ticket.customerName}`
    : ticket.type === "delivery"
      ? `Delivery · ${ticket.customerName}`
      : `Collect · ${ticket.customerName}`;

  return (
    <main className="mx-auto min-h-dvh max-w-md px-5 pt-6 pb-16">
      <div className="flex items-center justify-between">
        <Logo size="sm" />
        <span className={`chip ${link === "live" ? "text-olive" : "text-taupe"}`} aria-live="polite">
          <span className={`size-1.5 rounded-full ${link === "live" ? "pulse-dot bg-olive" : "bg-taupe"}`} aria-hidden="true" />
          {link === "live" ? "Live" : "Reconnecting"}
        </span>
      </div>

      <div className="mt-14">
        <p className="eyebrow fade-up text-taupe">
          {whereLabel}
        </p>
        <h1 key={ticket.status} className="display line-in mt-4 text-[3.6rem]">
          {cancelled ? (
            <span className="text-oxblood">Cancelled.</span>
          ) : awaiting ? (
            <>
              Almost there<span className="text-brass">.</span>
            </>
          ) : ready ? (
            <>
              It's ready.
            </>
          ) : (
            <>
              {STATUS_TEXT[ticket.status] ?? ticket.status}
              <span className="text-brass">.</span>
            </>
          )}
        </h1>
        <p className="fade-up mt-3 text-lg text-umber" style={{ ["--delay" as string]: "200ms" }}>
          {neverPaid
            ? "It was not paid in time, so nothing was charged and the dishes went back on the menu. Please order again."
            : cancelled
            ? "Please speak to a member of staff."
            : awaiting
            ? "Pay below and your order goes straight to the kitchen."
              : ready
              ? ticket.type === "pickup"
                ? "Come to the counter and give your name."
                : ticket.type === "delivery"
                  ? "Packed and waiting for a rider."
                  : "On its way to your table."
              : out && d
                ? `${d.driverName ?? "Your rider"} is on the way${driverKm !== null ? `, about ${rideMinutes(driverKm)} minutes out` : ""}.`
                : ticket.status === "delivered"
                  ? "Enjoy. Thank you for ordering."
                  : (STATUS_HINT[ticket.status] ?? "This page moves on by itself as the kitchen works.")}
        </p>
      </div>

      {awaiting && <PaymentPanel ticket={ticket} onPaid={apply} />}

      {!cancelled && !awaiting && (
        <div className="mt-10">
          <div className="flex gap-1" aria-hidden="true">
            {steps.map((s, i) => (
              <span key={s.status} className="relative h-0.5 flex-1 overflow-hidden bg-espresso/15">
                <span
                  className="absolute inset-0 origin-left bg-brass transition-transform duration-1000"
                  style={{ transform: `scaleX(${i <= current ? 1 : 0})` }}
                />
              </span>
            ))}
          </div>
          <ol className="mt-3 flex gap-1" aria-label="Order progress">
            {steps.map((s, i) => (
              <li
                key={s.status}
                aria-current={i === current ? "step" : undefined}
                className={`eyebrow flex-1 text-[0.58rem] ${i === current ? "text-espresso" : i < current ? "text-umber" : "text-taupe/70"}`}
              >
                {s.label}
              </li>
            ))}
          </ol>
        </div>
      )}

      {d && !cancelled && !awaiting && (
        <section className="mt-12">
          <MapView
            ariaLabel="Delivery map"
            className="aspect-[4/3] w-full border border-espresso/15"
            fit
            interactive
            pins={[
              { id: "restaurant", kind: "restaurant", lat: SITE.coords.lat, lng: SITE.coords.lng, label: "PassPlate" },
              { id: "home", kind: "home", lat: d.lat, lng: d.lng, label: "You" },
              ...(d.driver && out ? [{ id: "driver", kind: "driver" as const, lat: d.driver.lat, lng: d.driver.lng, label: d.driverName ?? "Rider" }] : []),
            ]}
          />
          <p className="mt-3 text-sm text-umber">
            {d.line1}, {d.postcode}
            {d.instructions ? ` · “${d.instructions}”` : ""}
          </p>
        </section>
      )}

      <article
        className="docket mt-14 px-5 pt-7 pb-6 shadow-[0_24px_50px_-24px_rgb(23_36_30/0.45)]"
        style={{ ["--edge" as string]: "#f2ece1" }}
        aria-label={`Order ${ticket.number}`}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="eyebrow text-ink/50">Your order</p>
            <p className="mt-1 font-serif text-6xl leading-none">#{ticket.number}</p>
          </div>
          <span
            key={ticket.status}
            className="stamp-in eyebrow border border-ink px-2 py-0.5"
            style={{ background: cancelled ? "#17241e" : ready ? "#c9a86f" : "transparent", color: cancelled ? "#f2ece1" : undefined }}
          >
            {STATUS_TEXT[ticket.status] ?? ticket.status}
          </span>
        </div>
        <ul className="mt-6 border-t border-dashed border-ink/40">
          {ticket.items.map((item, i) => (
            <li key={i} className="flex justify-between gap-3 border-b border-dashed border-ink/20 py-3">
              <div>
                <p className="font-medium">
                  <span className="tabular">{item.quantity}×</span> {item.name}
                </p>
                {item.modifiers.length > 0 && <p className="text-sm text-ink/60">{item.modifiers.join(", ")}</p>}
                {item.notes && <p className="text-sm italic text-ink/60">“{item.notes}”</p>}
              </div>
              <span className="tabular text-sm">{money(item.lineTotalMinor)}</span>
            </li>
          ))}
        </ul>
        {(ticket.discountMinor > 0 || ticket.deliveryFeeMinor > 0) && (
          <dl className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between">
              <dt>Food and drink</dt>
              <dd className="tabular">{money(ticket.subtotalMinor)}</dd>
            </div>
            {ticket.discountMinor > 0 && (
              <div className="flex justify-between">
                <dt>Reward</dt>
                <dd className="tabular">−{money(ticket.discountMinor)}</dd>
              </div>
            )}
            {ticket.deliveryFeeMinor > 0 && (
              <div className="flex justify-between">
                <dt>Delivery</dt>
                <dd className="tabular">{money(ticket.deliveryFeeMinor)}</dd>
              </div>
            )}
          </dl>
        )}
        <div className="mt-4 flex items-baseline justify-between">
          <span className="eyebrow">{ticket.paid ? "Paid" : "To pay"}</span>
          <span className="tabular font-serif text-2xl">{money(ticket.totalMinor)}</span>
        </div>
      </article>

      {user && rewards && user.role === "customer" && (
        <p className="mt-8 border border-brass/60 bg-brass/10 px-5 py-4 text-center text-umber">
          {rewards.available > 0
            ? `You have a reward waiting: ${rewards.percent}% off your next order.`
            : `${rewards.stamps} of ${rewards.every} stamps. ${rewards.every - rewards.stamps} more to ${rewards.percent}% off.`}{" "}
          <Link to="/account" className="draw text-espresso">
            Your account
          </Link>
        </p>
      )}

      <p className="mt-10 text-center text-sm text-taupe">
        {link === "live" ? "Keep this page open. It updates by itself." : "Reconnecting. Checking every few seconds."}
      </p>
    </main>
  );
}
