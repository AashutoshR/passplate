/**
 * FR-19: a driver simulator. Places paid delivery orders, cooks them on the
 * kitchen account, has the dispatcher give each to the suggested driver, and
 * drives the demo drivers along each route (the Google road route when the
 * API has a key, otherwise a bent line), sending a position every step and
 * finishing with proof of delivery. Everything goes through the public API,
 * the same calls the real screens make.
 *
 * Needs the API, gateway and worker running (bun run dev).
 *
 * Usage:
 *   bun scripts/drivers.ts [--deliver 4] [--road 2] [--assigned 1] [--waiting 1] [--step 3000]
 *
 *   --deliver   deliveries driven all the way and signed off
 *   --road      deliveries left part way along the route (for a live map)
 *   --assigned  cooked, given to a driver, not collected yet
 *   --waiting   cooked, not given to anyone
 *   --step      milliseconds between position updates (FR-16 says 3000)
 */

const API = process.env.API_URL ?? "http://localhost:4000";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}
const DELIVER = arg("deliver", 4);
const ROAD = arg("road", 2);
const ASSIGNED = arg("assigned", 1);
const WAITING = arg("waiting", 1);
const STEP_MS = arg("step", 3000);
const STEPS = 12;

// Real Bristol streets inside the 5 km delivery radius. Phone numbers are from
// Ofcom's range kept for drama, so they can never reach a real person.
const HOMES = [
  { name: "Ravi Shah", line1: "27 Cheltenham Road", postcode: "BS6 5RH", lat: 51.4682, lng: -2.5899 },
  { name: "Ellie Turner", line1: "40 North Street", postcode: "BS3 1HW", lat: 51.4423, lng: -2.6086 },
  { name: "Kwame Mensah", line1: "12 Whiteladies Road", postcode: "BS8 2LG", lat: 51.4628, lng: -2.611 },
  { name: "Hannah Lloyd", line1: "61 St Marks Road", postcode: "BS5 6HX", lat: 51.4669, lng: -2.5689 },
  { name: "Joe Fraser", line1: "9 Coronation Road", postcode: "BS3 1AS", lat: 51.444, lng: -2.6015 },
  { name: "Mei Lin", line1: "3 Kingsdown Parade", postcode: "BS6 5UD", lat: 51.4646, lng: -2.5946 },
  { name: "Owen Price", line1: "14 Princess Victoria Street", postcode: "BS8 4BX", lat: 51.4561, lng: -2.6214 },
  { name: "Aisha Khan", line1: "18 Stapleton Road", postcode: "BS5 0QY", lat: 51.4655, lng: -2.5683 },
  { name: "Tom Reid", line1: "22 Gloucester Road", postcode: "BS7 8AE", lat: 51.472, lng: -2.5905 },
];
const PROOFS = ["handed_over", "handed_over", "left_at_door", "neighbour", "safe_place"] as const;
const NOTES: Record<string, string | undefined> = {
  left_at_door: "Rang twice, no answer",
  neighbour: "Number 29, Pat",
  safe_place: "Behind the blue gate",
};

type Cookie = { Cookie: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}, who?: Cookie, xff?: string): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(who ?? {}),
      ...(xff ? { "X-Forwarded-For": xff } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function signIn(email: string, password: string): Promise<Cookie> {
  const res = await fetch(`${API}/v1/account/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Sign-in failed for ${email}: ${res.status}. Run bun run db:seed.`);
  return { Cookie: res.headers.get("Set-Cookie")!.split(";")[0]! };
}

/** Google's encoded polyline, decoded (the same as @pass/shared). */
function decode(encoded: string) {
  const out: { lat: number; lng: number }[] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    for (const axis of [0, 1]) {
      let shift = 0, result = 0, b: number;
      do {
        b = encoded.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i < encoded.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += d;
      else lng += d;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

interface Ticket {
  id: string;
  number: number;
  status: string;
  customerName: string;
  delivery: { lat: number; lng: number; driverId: string | null; route: { polyline: string | null } | null } | null;
}

const demo = await call<{ location: { id: string; slug: string } }>("/v1/dev/demo");
const menu = await call<{ categories: { items: { id: string; priceMinor: number; stock: number | null; soldOut: boolean; modifierGroups: { minSelect: number }[] }[] }[] }>(
  `/v1/locations/${demo.location.slug}/menu`,
);
const dishes = menu.categories
  .flatMap((c) => c.items)
  .filter((i) => i.stock === null && !i.soldOut && i.modifierGroups.every((g) => g.minSelect === 0) && i.priceMinor >= 900);
if (dishes.length < 2) throw new Error("Not enough dishes to order");

const kitchen = await signIn("kitchen@passplate.test", "passplate-kitchen");
const floor = await signIn("floor@passplate.test", "passplate-floor");
// Where the restaurant is, from the dispatch board.
const loc = { ...demo.location, ...(await call<{ location: { lat: number; lng: number } }>("/v1/staff/dispatch", {}, floor)).location };
const drivers = await Promise.all(
  ["driver@passplate.test", "tom@passplate.test", "ines@passplate.test"].map(async (email) => ({
    email,
    cookie: await signIn(email, "passplate-driver"),
  })),
);
const me = await Promise.all(drivers.map((d) => call<{ user: { id: string; name: string } }>("/v1/account/me", {}, d.cookie)));
const driverById = new Map(me.map((m, i) => [m.user.id, { ...drivers[i]!, name: m.user.name }]));
for (const d of drivers) await call("/v1/staff/driver/shift", { method: "POST", json: { on: true } }, d.cookie);
console.log(`On shift: ${me.map((m) => m.user.name).join(", ")}`);

const total = DELIVER + ROAD + ASSIGNED + WAITING;
const placed: Ticket[] = [];
for (let i = 0; i < total; i++) {
  const home = HOMES[i % HOMES.length]!;
  const xff = `203.0.113.${200 + (i % 50)}`;
  const a = dishes[(i * 7) % dishes.length]!;
  const b = dishes[(i * 11 + 3) % dishes.length]!;
  const t = await call<Ticket>(
    "/v1/orders",
    {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      json: {
        locationSlug: loc.slug,
        type: "delivery",
        customerName: home.name,
        phone: `07700 900${String(100 + i).padStart(3, "0")}`,
        delivery: { line1: home.line1, postcode: home.postcode, lat: home.lat, lng: home.lng },
        items: [
          { menuItemId: a.id, quantity: 1 },
          { menuItemId: b.id, quantity: 1 },
        ],
      },
    },
    undefined,
    xff,
  );
  await call(`/v1/orders/${t.id}/payment/test`, { method: "POST", json: { outcome: "succeeded" } }, undefined, xff);
  placed.push(t);
}
console.log(`Placed and paid ${placed.length} delivery orders: ${placed.map((t) => `#${t.number}`).join(" ")}`);

// The kitchen cooks them all.
for (const t of placed) {
  for (const [from, to] of [
    ["received", "cooking"],
    ["cooking", "ready"],
  ]) {
    await call(`/v1/kitchen/${loc.id}/tickets/${t.id}/transition`, { method: "POST", json: { from, to, actionId: crypto.randomUUID() } }, kitchen);
  }
}

// The dispatcher gives all but the last WAITING to the suggested driver, one at a time.
const toAssign = placed.slice(0, total - WAITING);
const owner = new Map<string, string>();
for (const t of toAssign) {
  const board = await call<{ suggested: string[] }>("/v1/staff/dispatch", {}, floor);
  const driverId = board.suggested[0]!;
  await call(`/v1/staff/dispatch/orders/${t.id}/assign`, { method: "POST", json: { driverId } }, floor);
  owner.set(t.id, driverId);
}
console.log(`Assigned ${toAssign.length}; ${WAITING} left for the dispatcher`);

/** One driver's run: collect, ride the route, sign off (or stop part way). */
async function ride(t: Ticket, finish: boolean) {
  const d = driverById.get(owner.get(t.id)!)!;
  const taken = await call<Ticket>(`/v1/staff/driver/orders/${t.id}/take`, { method: "POST" }, d.cookie);
  const home = taken.delivery!;
  const road = home.route?.polyline ? decode(home.route.polyline) : null;
  const stop = finish ? STEPS : Math.ceil(STEPS * (0.35 + Math.random() * 0.35));
  for (let s = 1; s <= stop; s++) {
    const f = s / STEPS;
    const p = road
      ? road[Math.min(road.length - 1, Math.round(f * (road.length - 1)))]!
      : {
          lat: loc.lat + (home.lat - loc.lat) * f + Math.sin(f * Math.PI) * 0.0012,
          lng: loc.lng + (home.lng - loc.lng) * f - Math.sin(f * Math.PI) * 0.0012,
        };
    await call(`/v1/staff/driver/orders/${t.id}/location`, { method: "POST", json: p }, d.cookie);
    await sleep(STEP_MS);
  }
  if (!finish) return console.log(`#${t.number}: ${d.name} is on the road`);
  const proof = PROOFS[t.number % PROOFS.length]!;
  await call(`/v1/staff/driver/orders/${t.id}/delivered`, { method: "POST", json: { proof, note: NOTES[proof], lat: home.lat + 0.0001, lng: home.lng } }, d.cookie);
  console.log(`#${t.number}: delivered by ${d.name} (${proof})`);
}

// Each driver works through their own deliveries in order; drivers ride at the same time.
const finishIds = new Set(placed.slice(0, DELIVER).map((t) => t.id));
const roadIds = new Set(placed.slice(DELIVER, DELIVER + ROAD).map((t) => t.id));
const perDriver = new Map<string, Ticket[]>();
for (const t of placed) {
  if (!finishIds.has(t.id) && !roadIds.has(t.id)) continue;
  const id = owner.get(t.id)!;
  perDriver.set(id, [...(perDriver.get(id) ?? []), t]);
}
await Promise.all(
  [...perDriver.values()].map(async (list) => {
    // Finished ones first, so a driver left on the road is on their last job.
    list.sort((a, b) => Number(roadIds.has(a.id)) - Number(roadIds.has(b.id)));
    for (const t of list) await ride(t, finishIds.has(t.id));
  }),
);
console.log("Done. Open /staff/dispatch to see the board.");
