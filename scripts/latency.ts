/**
 * Milestone 1 acceptance check: an order placed through the API reaches the
 * kitchen screen's WebSocket in under 1 second at p95 (FR-10).
 *
 * Also checks NFR-7: a client that reconnects with an old `since` receives
 * every ticket it missed, in order.
 *
 * Needs the API, gateway and worker running (bun run dev).
 * Usage: bun scripts/latency.ts [orders=200] [concurrency=10]
 */

const API = process.env.API_URL ?? "http://localhost:4000";
const WS = process.env.WS_URL ?? "ws://localhost:4100/ws";
const CODE = process.env.KITCHEN_CODE ?? "demo-kitchen";
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

const auth = { Authorization: `Bearer ${CODE}` };
const snapshot = await (await fetch(`${API}/v1/kitchen/${locationId}/tickets`, { headers: auth })).json();
const startSeq: number = snapshot.seq;

const runTag = `lat-${Date.now().toString(36)}`;
const sentAt = new Map<string, number>();
const latencies: number[] = [];
let resolveAll: () => void;
const allSeen = new Promise<void>((r) => (resolveAll = r));

function connect(since: number, onTicket: (name: string, seq: number) => void): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.onopen = () =>
      ws.send(JSON.stringify({ op: "subscribe", channels: [`kitchen:${locationId}`], since, token: CODE }));
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
    sentAt.set(name, performance.now());
    const res = await fetch(`${API}/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        locationSlug: slug,
        type: "pickup",
        customerName: name,
        items: [{ menuItemId: item.id, quantity: 1 }],
      }),
    });
    if (res.status !== 201) {
      failures++;
      sentAt.delete(name);
      console.error(`order ${i} failed: ${res.status} ${await res.text()}`);
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
console.log(`Order to kitchen:   p50 ${fmt(pct(50))}, p95 ${fmt(pct(95))}, p99 ${fmt(pct(99))}, max ${fmt(latencies.at(-1)!)}`);
console.log(`Replay after drop:  ${replayed.length} of ${expected} tickets, in order: ${ordered ? "yes" : "no"}`);

const pass = failures === 0 && latencies.length === expected && pct(95) < 1000 && replayed.length === expected && ordered;
console.log(pass ? "\nPASS: p95 under 1 s, nothing lost, nothing out of order." : "\nFAIL");
process.exit(pass ? 0 : 1);
