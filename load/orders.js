// k6 load tests for PassPlate (TEST-4). Each virtual guest reads the menu the
// way a phone does (with the ETag it already has), then orders: most order to
// collect and pay, one in ten sends a table's order to the kitchen. (One
// restaurant has 18 tables; at 50 orders a second a bigger table share would
// pile hundreds of unsettled bills on each table, which no real service does.)
//
// Scenarios (pick with -e SCENARIO=...):
//   smoke   5 guests a second for 30 s: does everything work at all
//   design  50 orders a second for 2 minutes: the design load in REQUIREMENTS.md
//   spike   40 a second, then 5x (200 a second) within 60 s, held 2 minutes
//   soak    the design load for 2 hours (DURATION overrides, such as 30m)
//   stress  climbs from 25 to 400 orders a second until it breaks
//   rate    a fixed RATE orders a second, to find the breaking point step by step
//
// Run through `bun scripts/load.ts <scenario>`, which starts k6 in Docker.
// The API must run with RATE_LIMIT=off: every virtual guest shares one
// address here, and would otherwise be limited like a single phone.

import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = __ENV.BASE || "http://host.docker.internal:4000";
const SCENARIO = __ENV.SCENARIO || "smoke";
const DURATION = __ENV.DURATION;

const orderTime = new Trend("order_ms", true);
const payTime = new Trend("payment_ms", true);
const menuTime = new Trend("menu_ms", true);
const soldOut = new Counter("sold_out");

const arrival = (stages, extra = {}) => ({
  executor: "ramping-arrival-rate",
  timeUnit: "1s",
  preAllocatedVUs: 200,
  maxVUs: 2000,
  stages,
  ...extra,
});

const SCENARIOS = {
  smoke: { executor: "constant-arrival-rate", rate: 5, timeUnit: "1s", duration: DURATION || "30s", preAllocatedVUs: 20, maxVUs: 100 },
  design: { executor: "constant-arrival-rate", rate: 50, timeUnit: "1s", duration: DURATION || "2m", preAllocatedVUs: 200, maxVUs: 1000 },
  // REQUIREMENTS.md section 4: 5x normal traffic within 60 s, and 200 orders
  // a second held for 2 minutes.
  spike: arrival(
    [
      { target: 40, duration: "30s" },
      { target: 200, duration: "60s" },
      { target: 200, duration: "2m" },
      { target: 40, duration: "30s" },
    ],
    { startRate: 40 },
  ),
  // One fixed rate (RATE orders a second), for stepping up to the breaking point.
  rate: { executor: "constant-arrival-rate", rate: Number(__ENV.RATE || 50), timeUnit: "1s", duration: DURATION || "1m", preAllocatedVUs: 300, maxVUs: 2000 },
  soak: { executor: "constant-arrival-rate", rate: 50, timeUnit: "1s", duration: DURATION || "2h", preAllocatedVUs: 200, maxVUs: 1000 },
  stress: arrival(
    [
      { target: 50, duration: "30s" },
      { target: 100, duration: "30s" },
      { target: 200, duration: "30s" },
      { target: 300, duration: "30s" },
      { target: 400, duration: "30s" },
    ],
    { startRate: 25 },
  ),
};

export const options = {
  scenarios: { guests: SCENARIOS[SCENARIO] },
  // The spec's bar: under 0.5% errors, and orders answered quickly at p95.
  thresholds: {
    http_req_failed: ["rate<0.005"],
    order_ms: ["p(95)<500"],
    payment_ms: ["p(95)<500"],
    menu_ms: ["p(95)<300"],
  },
  summaryTrendStats: ["avg", "p(50)", "p(95)", "p(99)", "max"],
};

export function setup() {
  const demo = http.get(`${BASE}/v1/dev/demo`).json();
  // A cookie makes the edge pass this one straight to the API: setup needs today's dish ids.
  const menu = http.get(`${BASE}/v1/locations/${demo.location.slug}/menu`, { headers: { Cookie: "fresh=1" } }).json();
  if (!menu.location.isOpen) throw new Error("The restaurant is closed: seed it open (bun run db:seed) before a load test.");
  // Only dishes with no portion count and no required choice, so the test
  // measures the system, not the kitchen running out of lamb.
  const items = menu.categories
    .flatMap((c) => c.items)
    .filter((i) => i.stock === null && !i.soldOut && i.modifierGroups.every((g) => g.minSelect === 0))
    .map((i) => i.id);
  return { slug: demo.location.slug, tables: demo.tables.map((t) => t.token), items };
}

const json = { "Content-Type": "application/json" };
let etag = null;

export default function (data) {
  // A phone opening the menu, with the copy it already has.
  const menu = http.get(`${BASE}/v1/locations/${data.slug}/menu`, {
    headers: etag ? { "If-None-Match": etag } : {},
    tags: { name: "menu" },
  });
  menuTime.add(menu.timings.duration);
  check(menu, { "menu 200 or 304": (r) => r.status === 200 || r.status === 304 });
  if (menu.status === 200) etag = menu.headers["Etag"] || menu.headers["ETag"] || null;

  const pick = () => data.items[Math.floor(Math.random() * data.items.length)];
  const items = [{ menuItemId: pick(), quantity: 1 + Math.floor(Math.random() * 2) }, { menuItemId: pick(), quantity: 1 }];
  const atTable = Math.random() < 0.1;
  const body = atTable
    ? { locationSlug: data.slug, type: "dine_in", tableToken: data.tables[Math.floor(Math.random() * data.tables.length)], customerName: "Load", items }
    : { locationSlug: data.slug, type: "pickup", customerName: "Load", items };

  const placed = http.post(`${BASE}/v1/orders`, JSON.stringify(body), {
    headers: { ...json, "Idempotency-Key": `k6-${__VU}-${__ITER}-${Date.now()}` },
    tags: { name: "order" },
    responseCallback: http.expectedStatuses(201, 409),
  });
  orderTime.add(placed.timings.duration);
  if (placed.status === 409) soldOut.add(1);
  if (!check(placed, { "order placed": (r) => r.status === 201 || r.status === 409 }) || placed.status !== 201 || atTable) return;

  const paid = http.post(`${BASE}/v1/orders/${placed.json("id")}/payment/test`, JSON.stringify({ outcome: "succeeded" }), {
    headers: json,
    tags: { name: "payment" },
  });
  payTime.add(paid.timings.duration);
  check(paid, { "paid, kitchen has it": (r) => r.status === 200 && r.json("status") === "received" });
}

export function handleSummary(data) {
  const out = `/load/results/${SCENARIO}${SCENARIO === "rate" ? `-${__ENV.RATE || 50}` : ""}.json`;
  return { [out]: JSON.stringify(data, null, 2), stdout: textSummary(data) };
}

function textSummary(data) {
  const m = data.metrics;
  const t = (name) => (m[name] ? `p50 ${m[name].values["p(50)"].toFixed(0)} ms, p95 ${m[name].values["p(95)"].toFixed(0)} ms, p99 ${m[name].values["p(99)"].toFixed(0)} ms` : "none");
  const reqs = m.http_reqs.values;
  const failed = m.http_req_failed.values.rate * 100;
  const lines = [
    `PassPlate load test: ${SCENARIO}${SCENARIO === "rate" ? ` at ${__ENV.RATE || 50} orders/s` : ""}`,
    `  requests      ${reqs.count} (${reqs.rate.toFixed(1)}/s), failed ${failed.toFixed(2)}%`,
    `  iterations    ${m.iterations.values.count}, dropped ${m.dropped_iterations ? m.dropped_iterations.values.count : 0}`,
    `  menu          ${t("menu_ms")}`,
    `  order         ${t("order_ms")}`,
    `  payment       ${t("payment_ms")}`,
    `  thresholds    ${Object.entries(data.metrics).filter(([, v]) => v.thresholds).every(([, v]) => Object.values(v.thresholds).every((x) => x.ok)) ? "all passed" : "SOME FAILED"}`,
    "",
  ];
  return lines.join("\n");
}
