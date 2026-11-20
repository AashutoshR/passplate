import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors";

/**
 * A small Stripe client: PaymentIntents, refunds and webhook signatures. Test
 * mode only (FR-8). Card details are typed into Stripe's own form in the
 * browser and never reach PassPlate.
 *
 * NFR-19: every call has a timeout, retries with jittered backoff, and sits
 * behind a circuit breaker, so a Stripe outage fails fast instead of piling up
 * requests that each wait the full timeout.
 */

export interface StripeConfig {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  apiBase?: string;
  /** Replaced in tests. */
  fetch?: typeof fetch;
}

export function assertTestMode(cfg: StripeConfig): void {
  if (!cfg.secretKey.startsWith("sk_test_") || !cfg.publishableKey.startsWith("pk_test_")) {
    throw new Error("PassPlate only runs Stripe in test mode: use sk_test_ and pk_test_ keys.");
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly threshold = 5,
    private readonly coolDownMs = 30_000,
  ) {}

  async run<T>(fn: () => Promise<T>, now = Date.now()): Promise<T> {
    if (now < this.openUntil) {
      throw new AppError(503, "payments_unavailable", "Card payments are briefly unavailable. Please try again in a minute.");
    }
    try {
      const out = await fn();
      this.failures = 0;
      return out;
    } catch (err) {
      // Only outages trip the breaker; a declined card is not Stripe being down.
      if (!(err instanceof StripeError) || err.retryable) {
        this.failures++;
        if (this.failures >= this.threshold) {
          this.openUntil = Date.now() + this.coolDownMs;
          this.failures = 0;
        }
      }
      throw err;
    }
  }
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const breaker = new CircuitBreaker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(
  cfg: StripeConfig,
  method: "GET" | "POST",
  path: string,
  form?: Record<string, string>,
  idempotencyKey?: string,
): Promise<T> {
  const doFetch = cfg.fetch ?? fetch;
  const url = `${cfg.apiBase ?? "https://api.stripe.com"}${path}`;
  return breaker.run(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(Math.random() * 250 * 2 ** attempt);
      try {
        const res = await doFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${cfg.secretKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Stripe-Version": "2024-06-20",
            // The same key on every retry, so a retry can never charge twice.
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          },
          body: form ? new URLSearchParams(form).toString() : undefined,
          signal: AbortSignal.timeout(8000),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
        if (res.ok) return data as T;
        const retryable = res.status >= 500 || res.status === 429;
        lastError = new StripeError(res.status, data.error?.code ?? "stripe_error", data.error?.message ?? "Stripe error", retryable);
        if (!retryable) break;
      } catch (err) {
        lastError = err instanceof StripeError ? err : new StripeError(0, "network", String(err), true);
      }
    }
    throw lastError;
  });
}

export interface PaymentIntent {
  id: string;
  client_secret: string;
  status: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
}

export function createPaymentIntent(
  cfg: StripeConfig,
  input: { orderId: string; amountMinor: number; currency: string; description: string },
): Promise<PaymentIntent> {
  return call<PaymentIntent>(
    cfg,
    "POST",
    "/v1/payment_intents",
    {
      amount: String(input.amountMinor),
      currency: input.currency.toLowerCase(),
      "automatic_payment_methods[enabled]": "true",
      description: input.description,
      "metadata[order_id]": input.orderId,
    },
    `pi-${input.orderId}`,
  );
}

export function retrievePaymentIntent(cfg: StripeConfig, id: string): Promise<PaymentIntent> {
  return call<PaymentIntent>(cfg, "GET", `/v1/payment_intents/${encodeURIComponent(id)}`);
}

export function cancelPaymentIntent(cfg: StripeConfig, id: string): Promise<PaymentIntent> {
  return call<PaymentIntent>(cfg, "POST", `/v1/payment_intents/${encodeURIComponent(id)}/cancel`, {}, `cancel-${id}`);
}

export function refundPaymentIntent(cfg: StripeConfig, id: string, amountMinor?: number): Promise<{ id: string }> {
  return call(
    cfg,
    "POST",
    "/v1/refunds",
    { payment_intent: id, ...(amountMinor ? { amount: String(amountMinor) } : {}) },
    `refund-${id}-${amountMinor ?? "all"}`,
  );
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: { id: string; metadata?: Record<string, string>; amount?: number; amount_received?: number } };
}

/**
 * NFR-13: checks the Stripe-Signature header (HMAC-SHA256 of "t.body" with the
 * endpoint secret) and refuses anything older than five minutes, so a captured
 * webhook cannot be replayed later.
 */
export function verifyWebhook(
  rawBody: string,
  header: string | undefined,
  secret: string,
  now = Date.now(),
  toleranceSec = 300,
): StripeEvent {
  const parts = new Map<string, string[]>();
  for (const piece of (header ?? "").split(",")) {
    const [k, v] = piece.split("=", 2);
    if (!k || !v) continue;
    parts.set(k.trim(), [...(parts.get(k.trim()) ?? []), v.trim()]);
  }
  const t = Number(parts.get("t")?.[0]);
  const signatures = parts.get("v1") ?? [];
  if (!Number.isFinite(t) || signatures.length === 0) {
    throw new AppError(400, "bad_signature", "Missing Stripe signature");
  }
  if (Math.abs(now / 1000 - t) > toleranceSec) {
    throw new AppError(400, "bad_signature", "Stripe signature is too old");
  }
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const ok = signatures.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new AppError(400, "bad_signature", "Stripe signature does not match");
  try {
    return JSON.parse(rawBody) as StripeEvent;
  } catch {
    throw new AppError(400, "invalid_json", "Webhook body is not JSON");
  }
}

/** Builds a valid signature header. Used by tests and the local webhook simulator. */
export function signWebhook(rawBody: string, secret: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}
