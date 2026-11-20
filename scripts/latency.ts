/**
 * FR-10 acceptance check: a paid order reaches the kitchen screen's WebSocket
 * in under 1 second at p95, timed from the moment the payment is confirmed.
 * Orders are paid with the built-in test provider, the same path a Stripe
 * webhook takes.
 *
 * Also checks NFR-7: a client that reconnects with an old `since` receives
 * every ticket it missed, in order.
 *
 * Needs the API, gateway and worker running (bun run dev).
 * Usage: bun scripts/latency.ts [orders=200] [concurrency=10]
 */

const API = process.env.API_URL ?? "http://localhost:4000";
const WS = process.env.WS_URL ?? "ws://localhost:4100/ws";
const TOTAL = Number(process.argv[2] ?? 200);
const CONCURRENCY = Number(process.argv[3] ?? 10);

interface Item {
  id: string;
  stock: number | null;
  soldOut: boolean;
  modifierGroups: { minSelect: number }[];
}

const demo = await (await fetch(`${API}/v1/dev/demo`)).json();
const slug: string = demo.location.slug;
const locationId: string = demo.location.id;
const menu = await (await fetch(`${API}/v1/locations/${slug}/menu`)).json();
const items: Item[] = menu.categories
  .flatMap((c: { items: Item[] }) => c.items)
  .filter((i: Item) => i.stock === null && !i.soldOut && i.modifierGroups.every((g) => g.minSelect === 0));
if (items.length === 0) throw new Error("No unlimited items without required options to order");

// The kitchen screen signs in with its own staff account (FR-22).
const login = await fetch(`${API}/v1/account/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "kitchen@passplate.test", password: process.env.KITCHEN_PASSWORD ?? "passplate-kitchen" }),
});
if (!login.ok) throw new Error(`Kitchen sign-in failed (${login.status}). Run bun run db:seed.`);
const auth = { Cookie: login.headers.get("Set-Cookie")!.split(";")[0]! };
const snapshot = await (await fetch(`${API}/v1/kitchen/${locationId}/tickets`, { headers: auth })).json();
const startSeq: number = snapshot.seq;

const runTag = `lat-${Date.now().toString(36)}`;
const sentAt = new Map<string, number>();
const latencies: number[] = [];
let resolveAll: () => void;
const allSeen = new Promise<void>((r) => (resolveAll = r));

function connect(since: number, onTicket: (name: string, seq: number) => void): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Bun's WebSocket can send the session cookie, as a browser on the same site would.
    const ws = new WebSocket(WS, { headers: auth } as unknown as string[]);
    ws.onopen = () => ws.send(JSON.stringify({ op: "subscribe", channels: [`kitchen:${locationId}`], since }));
    ws.onerror = (e) => reject(e);
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.op === "subscribed") resolve(ws);
      if (msg.op === "event" && msg.type === "ticket.created") onTicket(msg.payload.customerName, msg.seq);
    };
  });
}

const live = await connect(startSeq, (name) => {
  const t0 = sentAt.get(name);
  if (t0 === undefined) return;
  latencies.push(performance.now() - t0);
  sentAt.delete(name);
  if (latencies.length === TOTAL) resolveAll();
});

let next = 0;
let failures = 0;
async function workerLoop() {
  while (next < TOTAL) {
    const i = next++;
    const name = `${runTag}-${i}`;
    const item = items[i % items.length]!;
    // Each order is a different guest with their own address (TEST-NET-2), so
    // the API's per-address rate limit treats them as people, not one script.
    // The dev API trusts X-Forwarded-For (TRUST_PROXY=1).
    const guest = { "X-Forwarded-For": `198.51.100.${(i % 250) + 1}` };
    const res = await fetch(`${API}/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), ...guest },
      body: JSON.stringify({
        locationSlug: slug,
        type: "pickup",
        customerName: name,
        items: [{ menuItemId: item.id, quantity: 1 }],
      }),
    });
    if (res.status !== 201) {
      failures++;
      console.error(`order ${i} failed: ${res.status} ${await res.text()}`);
      continue;
    }
    const { id } = (await res.json()) as { id: string };
    sentAt.set(name, performance.now());
    const paid = await fetch(`${API}/v1/orders/${id}/payment/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...guest },
      body: JSON.stringify({ outcome: "succeeded" }),
    });
    if (!paid.ok) {
      failures++;
      sentAt.delete(name);
      console.error(`payment ${i} failed: ${paid.status} ${await paid.text()}`);
    }
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, workerLoop));
const expected = TOTAL - failures;
if (latencies.length < expected) {
  await Promise.race([allSeen, Bun.sleep(10_000)]);
}
const wall = (performance.now() - started) / 1000;
live.close();

// Replay check: a fresh client asking for everything since the start.
const replayed: string[] = [];
let lastSeq = 0;
let ordered = true;
const replayWs = await connect(startSeq, (name, seq) => {
  if (seq <= lastSeq) ordered = false;
  lastSeq = seq;
  if (name.startsWith(runTag)) replayed.push(name);
});
replayWs.close();

latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!;
const fmt = (ms: number) => `${ms.toFixed(1)} ms`;

console.log("");
console.log(`Orders sent:        ${TOTAL} (${CONCURRENCY} at a time, ${(TOTAL / wall).toFixed(0)} orders/s)`);
console.log(`Order failures:     ${failures}`);
console.log(`Tickets received:   ${latencies.length} of ${expected}`);
console.log(`Paid to kitchen:    p50 ${fmt(pct(50))}, p95 ${fmt(pct(95))}, p99 ${fmt(pct(99))}, max ${fmt(latencies.at(-1)!)}`);
console.log(`Replay after drop:  ${replayed.length} of ${expected} tickets, in order: ${ordered ? "yes" : "no"}`);

const pass = failures === 0 && latencies.length === expected && pct(95) < 1000 && replayed.length === expected && ordered;
console.log(pass ? "\nPASS: p95 under 1 s, nothing lost, nothing out of order." : "\nFAIL");
process.exit(pass ? 0 : 1);
