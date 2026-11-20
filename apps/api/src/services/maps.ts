import { distanceKm, etaMinutes } from "@pass/shared";

/**
 * Road routes for deliveries (FR-14, FR-20). Google's Routes API when a server
 * key is set, otherwise a straight line at bike speed.
 *
 * NFR-19: each call has a timeout, retries with jitter, and a circuit breaker.
 * NFR-20: a route is asked for once per delivery, when the driver sets off,
 * and kept on the order; the ETA after that is worked out locally from it.
 * NFR-21: any failure (no key, quota, outage, a breaker that is open) falls
 * back to the straight line. A delivery never waits on Google.
 */

export interface RoutePlan {
  provider: "google" | "straight";
  polyline: string | null;
  distanceM: number;
  durationS: number;
}

type Point = { lat: number; lng: number };

export interface RoutesProvider {
  readonly name: "google" | "straight";
  route(from: Point, to: Point): Promise<RoutePlan>;
}

export function straightRoute(from: Point, to: Point): RoutePlan {
  const km = distanceKm(from, to);
  return { provider: "straight", polyline: null, distanceM: Math.round(km * 1000), durationS: etaMinutes(km, null) * 60 };
}

export const straightRoutes: RoutesProvider = {
  name: "straight",
  route: async (from, to) => straightRoute(from, to),
};

export interface GoogleRoutesConfig {
  apiKey: string;
  /** DRIVE by default. TWO_WHEELER or BICYCLE where Google offers them. */
  travelMode?: string;
  apiBase?: string;
  timeoutMs?: number;
  /** Replaced in tests. */
  fetch?: typeof fetch;
  log?: (msg: string, extra: Record<string, unknown>) => void;
}

class Breaker {
  private failures = 0;
  private openUntil = 0;
  constructor(
    private readonly threshold = 5,
    private readonly coolDownMs = 60_000,
  ) {}
  get open() {
    return Date.now() < this.openUntil;
  }
  ok() {
    this.failures = 0;
  }
  fail() {
    if (++this.failures >= this.threshold) {
      this.openUntil = Date.now() + this.coolDownMs;
      this.failures = 0;
    }
  }
}

export function googleRoutes(cfg: GoogleRoutesConfig): RoutesProvider & { breakerOpen(): boolean } {
  const breaker = new Breaker();
  const doFetch = cfg.fetch ?? fetch;
  const url = `${cfg.apiBase ?? "https://routes.googleapis.com"}/directions/v2:computeRoutes`;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function ask(from: Point, to: Point): Promise<RoutePlan> {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(Math.random() * 200 * 2 ** attempt);
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": cfg.apiKey,
            // Only what is used: Google bills by the fields asked for.
            "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline",
          },
          body: JSON.stringify({
            origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
            destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
            travelMode: cfg.travelMode ?? "DRIVE",
            polylineEncoding: "ENCODED_POLYLINE",
          }),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 5000),
        });
        if (res.status === 429 || res.status >= 500) {
          last = new Error(`Routes API ${res.status}`);
          continue;
        }
        if (!res.ok) throw Object.assign(new Error(`Routes API ${res.status}: ${(await res.text()).slice(0, 200)}`), { final: true });
        const body = (await res.json()) as {
          routes?: { distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }[];
        };
        const r = body.routes?.[0];
        if (!r?.distanceMeters || !r.duration) throw Object.assign(new Error("Routes API returned no route"), { final: true });
        return {
          provider: "google",
          polyline: r.polyline?.encodedPolyline ?? null,
          distanceM: r.distanceMeters,
          durationS: Math.max(60, parseInt(r.duration, 10) || 0),
        };
      } catch (err) {
        last = err;
        if ((err as { final?: boolean }).final) break;
      }
    }
    throw last;
  }

  return {
    name: "google",
    breakerOpen: () => breaker.open,
    async route(from, to) {
      if (breaker.open) return straightRoute(from, to);
      try {
        const plan = await ask(from, to);
        breaker.ok();
        return plan;
      } catch (err) {
        breaker.fail();
        cfg.log?.("google routes failed, using a straight line", { error: String(err) });
        return straightRoute(from, to);
      }
    },
  };
}
