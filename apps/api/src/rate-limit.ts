import type { Context, MiddlewareHandler } from "hono";
import type Redis from "ioredis";
import type { AuthEnv } from "./auth";

/**
 * NFR-4: token bucket rate limits per address, per signed-in person and per
 * restaurant, kept in Redis so every API instance shares them. Over the limit
 * answers 429 with Retry-After.
 *
 * NFR-5: tiers are sized by priority. Placing orders and kitchen taps get the
 * most room; admin screens get the least, so under pressure they slow first.
 *
 * If Redis is unreachable the limiter falls back to buckets in this process
 * rather than failing requests: a dinner rush must not stop because a cache did.
 */

export interface Bucket {
  /** Tokens when full: the burst a client may send at once. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export interface Store {
  /** Takes one token. Returns 0 if allowed, or the seconds to wait. */
  take(key: string, bucket: Bucket, now: number): Promise<number>;
}

/** One Lua call per check: read, refill, take and write happen atomically in Redis. */
const TAKE_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local data = redis.call('HMGET', key, 't', 'at')
local tokens = tonumber(data[1])
local at = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  at = now
end
tokens = math.min(capacity, tokens + (now - at) / 1000 * rate)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', key, 't', tokens, 'at', now)
redis.call('PEXPIRE', key, math.ceil(capacity / rate * 1000) + 1000)
return wait
`;

export class MemoryStore implements Store {
  private buckets = new Map<string, { tokens: number; at: number }>();

  async take(key: string, bucket: Bucket, now: number): Promise<number> {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: bucket.capacity, at: now };
      this.buckets.set(key, b);
      if (this.buckets.size > 50_000) this.sweep(now);
    }
    b.tokens = Math.min(bucket.capacity, b.tokens + ((now - b.at) / 1000) * bucket.refillPerSec);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / bucket.refillPerSec);
  }

  private sweep(now: number) {
    for (const [k, v] of this.buckets) if (now - v.at > 10 * 60_000) this.buckets.delete(k);
  }
}

export class RedisStore implements Store {
  private fallback = new MemoryStore();
  constructor(private redis: Redis) {}

  async take(key: string, bucket: Bucket, now: number): Promise<number> {
    if (this.redis.status !== "ready") return this.fallback.take(key, bucket, now);
    try {
      const wait = await this.redis.eval(TAKE_SCRIPT, 1, `rl:${key}`, bucket.capacity, bucket.refillPerSec, now);
      return Number(wait);
    } catch {
      return this.fallback.take(key, bucket, now);
    }
  }
}

export type Tier = "order" | "kitchen" | "write" | "read" | "admin" | "auth" | "webhook";

/** Per address, per signed-in person, and per restaurant, for each tier. */
export interface Limits {
  ip: Record<Tier, Bucket>;
  user: Record<Tier, Bucket>;
  /**
   * Ceiling on orders across all clients, sized well above the 50 orders a
   * second design load. There is one restaurant today; with more tenants
   * (Milestone 4 of the spec) this key gains the tenant id.
   */
  tenantOrders: Bucket;
}

export const DEFAULT_LIMITS: Limits = {
  ip: {
    order: { capacity: 20, refillPerSec: 1 },
    kitchen: { capacity: 120, refillPerSec: 10 },
    write: { capacity: 60, refillPerSec: 2 },
    read: { capacity: 300, refillPerSec: 20 },
    admin: { capacity: 60, refillPerSec: 2 },
    auth: { capacity: 10, refillPerSec: 0.2 },
    webhook: { capacity: 600, refillPerSec: 100 },
  },
  user: {
    order: { capacity: 30, refillPerSec: 1 },
    kitchen: { capacity: 240, refillPerSec: 20 },
    write: { capacity: 120, refillPerSec: 4 },
    read: { capacity: 600, refillPerSec: 40 },
    admin: { capacity: 120, refillPerSec: 4 },
    auth: { capacity: 10, refillPerSec: 0.2 },
    webhook: { capacity: 600, refillPerSec: 100 },
  },
  tenantOrders: { capacity: 1000, refillPerSec: 250 },
};

/** Which tier a request belongs to. */
export function tierOf(method: string, path: string): Tier {
  if (path.startsWith("/v1/webhooks/")) return "webhook";
  if (path.startsWith("/v1/kitchen/")) return "kitchen";
  if (path.startsWith("/v1/staff/admin")) return "admin";
  if (path === "/v1/account/login" || path === "/v1/account/register" || /^\/v1\/invites\/[^/]+\/accept$/.test(path)) {
    return "auth";
  }
  if (method === "GET" || method === "HEAD") return "read";
  if (path === "/v1/orders" || /^\/v1\/orders\/[^/]+\/payment/.test(path) || /^\/v1\/tables\/[^/]+\/cart/.test(path)) {
    return "order";
  }
  return "write";
}

/**
 * The client address. Behind a load balancer set TRUST_PROXY=1 so the first
 * X-Forwarded-For entry counts; otherwise that header is ignored, because
 * anyone can send it.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();
    if (fwd) return fwd;
  }
  const server = (c.env as { server?: { requestIP?: (r: Request) => { address: string } | null } } | undefined)?.server;
  return server?.requestIP?.(c.req.raw)?.address ?? "unknown";
}

export function rateLimit(opts: {
  store: Store;
  limits?: Limits;
  trustProxy?: boolean;
  now?: () => number;
}): MiddlewareHandler<AuthEnv> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const now = opts.now ?? Date.now;
  return async (c, next) => {
    if (c.req.path.startsWith("/health/")) return next();
    const tier = tierOf(c.req.method, c.req.path);
    const t = now();
    const user = c.get("user");
    const checks: Promise<number>[] = [
      opts.store.take(`ip:${tier}:${clientIp(c, opts.trustProxy ?? false)}`, limits.ip[tier], t),
    ];
    if (user) checks.push(opts.store.take(`user:${tier}:${user.id}`, limits.user[tier], t));
    if (tier === "order") checks.push(opts.store.take("tenant:orders", limits.tenantOrders, t));
    const wait = Math.max(...(await Promise.all(checks)));
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json(
        { error: { code: "rate_limited", message: "Too many requests. Please wait a moment and try again." } },
        429,
      );
    }
    return next();
  };
}
