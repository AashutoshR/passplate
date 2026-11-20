import { useEffect, useRef, useState } from "react";
import { formatMoney, type PaymentStartView, type TicketView } from "@pass/shared";
import { ApiError, api } from "../lib/api";
import { useNow } from "../lib/realtime";

/**
 * Paying for a collect or delivery order (FR-8). The kitchen sees the order
 * the moment the payment is confirmed.
 *
 * With Stripe keys set, the card form is Stripe's own Payment Element: card
 * details go from the browser to Stripe and never touch PassPlate. Without
 * keys, a built-in test provider stands in, so the flow can be tried end to
 * end with no account.
 */
export function PaymentPanel({ ticket, onPaid }: { ticket: TicketView; onPaid: (t: TicketView) => void }) {
  const [start, setStart] = useState<PaymentStartView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const money = (m: number) => formatMoney(m, ticket.currency);

  useEffect(() => {
    let cancelled = false;
    api<PaymentStartView>(`/v1/orders/${ticket.id}/payment`, { method: "POST" })
      .then((s) => !cancelled && setStart(s))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "We could not reach the payment service. Please try again."));
    return () => {
      cancelled = true;
    };
  }, [ticket.id]);

  return (
    <section aria-labelledby="pay-title" className="mt-10 border border-espresso/20 bg-[#fbf8f2] px-5 pt-6 pb-5 shadow-[0_24px_50px_-28px_rgb(23_36_30/0.45)]">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="pay-title" className="font-serif text-3xl leading-none">
          Pay
        </h2>
        <span className="tabular font-serif text-3xl leading-none">{money(ticket.totalMinor)}</span>
      </div>
      {ticket.payment && <Countdown until={ticket.payment.expiresAt} />}
      {error && (
        <p role="alert" className="drop mt-5 border border-brass px-4 py-3">
          {error}
        </p>
      )}
      {!start && !error && <div className="mt-6 h-36 animate-pulse bg-linen" aria-label="Loading the payment form" />}
      {start?.provider === "test" && <TestPayment ticket={ticket} amount={money(start.amountMinor)} onPaid={onPaid} />}
      {start?.provider === "stripe" && start.clientSecret && start.publishableKey && (
        <StripePayment clientSecret={start.clientSecret} publishableKey={start.publishableKey} amount={money(start.amountMinor)} />
      )}
    </section>
  );
}

function Countdown({ until }: { until: string }) {
  const now = useNow(1000);
  const left = Math.max(0, new Date(until).getTime() - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return (
    <p className="mt-2 text-sm text-umber">
      {left > 0 ? (
        <>
          We are holding your dishes for <span className="tabular">{m}:{String(s).padStart(2, "0")}</span>.
        </>
      ) : (
        "The hold has ended. If the payment does not go through, please order again."
      )}
    </p>
  );
}

/** The built-in stand-in for a card form. No card details are asked for or sent anywhere. */
function TestPayment({ ticket, amount, onPaid }: { ticket: TicketView; amount: string; onPaid: (t: TicketView) => void }) {
  const [busy, setBusy] = useState<"succeeded" | "declined" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function pay(outcome: "succeeded" | "declined") {
    setBusy(outcome);
    setMessage(null);
    try {
      const paid = await api<TicketView>(`/v1/orders/${ticket.id}/payment/test`, { method: "POST", json: { outcome }, timeoutMs: 15_000 });
      onPaid(paid);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "No connection. Nothing was taken. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-6">
      <div className="relative overflow-hidden bg-espresso px-5 py-5 text-cream" aria-hidden="true">
        <p className="eyebrow text-[0.6rem] text-cream/60">Test card</p>
        <p className="tabular mt-6 font-mono text-[clamp(0.95rem,4.4vw,1.125rem)] tracking-[0.16em] whitespace-nowrap">•••• •••• •••• 4242</p>
        <div className="mt-3 flex justify-between text-sm text-cream/70">
          <span>{ticket.customerName}</span>
          <span className="tabular">12 / 34</span>
        </div>
        <span className="absolute top-5 right-5 h-6 w-9 rounded-sm bg-brass/70" />
      </div>
      <p className="mt-3 text-sm text-taupe">Test mode: this page is a stand-in for a real card form, and no money moves.</p>
      {message && (
        <p role="alert" className="drop mt-4 border border-brass px-4 py-3">
          {message}
        </p>
      )}
      <button
        type="button"
        id="pay-now"
        onClick={() => void pay("succeeded")}
        disabled={busy !== null}
        className="cta cta-dark mt-5 w-full justify-between px-5 py-4"
      >
        <span>{busy === "succeeded" ? "Paying…" : "Pay now"}</span>
        <span className="tabular tracking-normal">{amount}</span>
      </button>
      <button
        type="button"
        onClick={() => void pay("declined")}
        disabled={busy !== null}
        className="mt-3 w-full py-2 text-center text-sm text-umber underline decoration-espresso/30 underline-offset-4 hover:text-espresso"
      >
        {busy === "declined" ? "Trying…" : "Try a declined card"}
      </button>
    </div>
  );
}

interface StripeJs {
  elements(opts: { clientSecret: string; appearance?: unknown }): { create(type: "payment"): { mount(el: HTMLElement): void; destroy(): void } };
  confirmPayment(opts: {
    elements: unknown;
    redirect: "if_required";
    confirmParams: { return_url: string };
  }): Promise<{ error?: { message?: string } }>;
}

let stripeScript: Promise<(key: string) => StripeJs> | null = null;
/** Stripe.js must load from Stripe itself, which keeps card data off our servers. */
function loadStripe(): Promise<(key: string) => StripeJs> {
  stripeScript ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://js.stripe.com/v3/";
    s.async = true;
    s.onload = () => resolve((window as unknown as { Stripe: (key: string) => StripeJs }).Stripe);
    s.onerror = () => {
      stripeScript = null;
      reject(new Error("Stripe.js did not load"));
    };
    document.head.appendChild(s);
  });
  return stripeScript;
}

function StripePayment({ clientSecret, publishableKey, amount }: { clientSecret: string; publishableKey: string; amount: string }) {
  const box = useRef<HTMLDivElement>(null);
  const ctx = useRef<{ stripe: StripeJs; elements: unknown } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "paying" | "confirming">("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let element: { destroy(): void } | null = null;
    loadStripe()
      .then((Stripe) => {
        if (!box.current) return;
        const stripe = Stripe(publishableKey);
        const elements = stripe.elements({
          clientSecret,
          appearance: {
            theme: "flat",
            variables: { colorPrimary: "#17241e", colorBackground: "#ffffff", colorText: "#17241e", borderRadius: "0px", fontFamily: "Jost, system-ui, sans-serif" },
          },
        });
        const el = elements.create("payment");
        el.mount(box.current);
        element = el;
        ctx.current = { stripe, elements };
        setState("ready");
      })
      .catch(() => setMessage("The card form could not load. Check the connection and refresh."));
    return () => element?.destroy();
  }, [clientSecret, publishableKey]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ctx.current) return;
    setState("paying");
    setMessage(null);
    const { error } = await ctx.current.stripe.confirmPayment({
      elements: ctx.current.elements,
      redirect: "if_required",
      confirmParams: { return_url: window.location.href },
    });
    if (error) {
      setMessage(error.message ?? "The payment did not go through. Nothing was taken.");
      setState("ready");
      return;
    }
    // Stripe tells our server by webhook; this page updates by itself when it does.
    setState("confirming");
  }

  return (
    <form onSubmit={submit} className="mt-6">
      <div ref={box} className="min-h-36" />
      {message && (
        <p role="alert" className="drop mt-4 border border-brass px-4 py-3">
          {message}
        </p>
      )}
      <button type="submit" disabled={state !== "ready"} className="cta cta-dark mt-5 w-full justify-between px-5 py-4">
        <span>{state === "paying" ? "Paying…" : state === "confirming" ? "Confirming with your bank…" : "Pay now"}</span>
        <span className="tabular tracking-normal">{amount}</span>
      </button>
      <p className="mt-3 text-center text-sm text-taupe">Stripe test mode. Use card 4242 4242 4242 4242, any future date and any CVC.</p>
    </form>
  );
}
