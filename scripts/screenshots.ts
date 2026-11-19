/**
 * Captures screenshots of the running site with headless Edge or Chrome over
 * the DevTools protocol, with true phone emulation (plain headless mode will
 * not lay out narrower than about 500 px).
 *
 * Each page is captured screen by screen as a visitor would scroll it, so
 * scroll-in animations and lazy images have played.
 *
 * Needs `bun run dev`. Usage: bun run screenshots [page-name ...]
 */
import { spawn } from "node:child_process";
import { DEMO_ACCOUNTS } from "../packages/db/src/seed";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const API = process.env.API_URL ?? "http://localhost:4000";
const OUT = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
const PORT = 9333;
const only = process.argv.slice(2);

const browsers = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];
const exe = process.env.BROWSER ?? browsers.find((b) => existsSync(b));
if (!exe) throw new Error("No Edge or Chrome found. Set BROWSER to its path.");

// A fresh profile per run: Edge can keep the previous one locked for a while after exit.
const profile = join(tmpdir(), `passplate-shots-${Date.now()}`);
process.on("exit", () => {
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
});
const proc = spawn(exe, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--hide-scrollbars",
  "--mute-audio",
  "--autoplay-policy=no-user-gesture-required",
  "--enable-unsafe-swiftshader",
  "about:blank",
]);

async function waitForBrowser() {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error("Browser did not start");
}

const target = (await waitForBrowser()) as { webSocketDebuggerUrl: string };
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let nextId = 1;
const pending = new Map<number, (v: any) => void>();
const listeners: ((m: any) => void)[] = [];
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.result ?? msg.error);
    pending.delete(msg.id);
  } else listeners.forEach((l) => l(msg));
};
function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
}
function loaded(): Promise<void> {
  return new Promise((r) => {
    const l = (m: any) => {
      if (m.method === "Page.loadEventFired") {
        listeners.splice(listeners.indexOf(l), 1);
        r();
      }
    };
    listeners.push(l);
  });
}
async function evaluate<T>(expression: string): Promise<T> {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return res?.result?.value as T;
}

await send("Page.enable");
mkdirSync(OUT, { recursive: true });

type View = { w: number; h: number; mobile?: boolean };
const desktop: View = { w: 1440, h: 900 };
const phone: View = { w: 390, h: 844, mobile: true };

async function open(url: string, view: View, settleMs: number) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: view.w,
    height: view.h,
    deviceScaleFactor: view.mobile ? 2 : 1.5,
    mobile: Boolean(view.mobile),
  });
  const done = loaded();
  // A unique query string forces a full load even when only the hash differs.
  await send("Page.navigate", { url: url + (url.includes("?") ? "&" : "?") + `shot=${Date.now()}` });
  await Promise.race([done, Bun.sleep(20_000)]);
  await Bun.sleep(settleMs);
}

async function save(name: string) {
  const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 88 });
  await Bun.write(join(OUT, name), Buffer.from(data, "base64"));
  console.log(`saved ${name}`);
}

/** One screenshot per screenful, scrolling like a visitor. */
async function scroll(name: string, url: string, view: View, maxScreens = 8, settleMs = 3500) {
  if (only.length && !only.some((o) => name.startsWith(o))) return;
  await open(url, view, settleMs);
  const height = await evaluate<number>("document.documentElement.scrollHeight");
  const screens = Math.min(maxScreens, Math.ceil(height / view.h));
  for (let i = 0; i < screens; i++) {
    const y = Math.min(i * (view.h - 80), height - view.h);
    await evaluate(`window.scrollTo({ top: ${y}, behavior: "instant" })`);
    await Bun.sleep(1700);
    await save(`${name}-${String(i + 1).padStart(2, "0")}.jpg`);
  }
}

async function single(name: string, url: string, view: View, settleMs = 3500, before?: string) {
  if (only.length && !only.some((o) => name.startsWith(o))) return;
  await open(url, view, settleMs);
  if (before) {
    await evaluate(before);
    await Bun.sleep(3500);
  }
  await save(`${name}.jpg`);
}

const demo = await (await fetch(`${API}/v1/dev/demo`)).json();
const table = demo.tables[3];

await scroll("home-desktop", `${WEB}/`, desktop, 9, 5000);
await scroll("home-phone", `${WEB}/`, phone, 12, 5000);
await scroll("menu-desktop", `${WEB}/menu`, desktop, 6);
await scroll("menu-phone", `${WEB}/menu`, phone, 4);
await scroll("story-desktop", `${WEB}/story`, desktop, 6);
await scroll("visit-desktop", `${WEB}/visit`, desktop, 4);
await single("order-table-phone", `${WEB}/t/${table.token}`, phone);
await single(
  "order-dish-phone",
  `${WEB}/t/${table.token}`,
  phone,
  3500,
  `[...document.querySelectorAll("main button")].find(b => b.textContent.includes("Seared scallops"))?.click()`,
);

// A delivery on its way, when one is given: TRACK_ORDER=<order id>.
if (process.env.TRACK_ORDER) await single("tracking-phone", `${WEB}/order/${process.env.TRACK_ORDER}`, phone, 9000, `document.querySelector("[aria-label=\\"Delivery map\\"]")?.scrollIntoView({ block: "center" })`);

// Booking and accounts.
await scroll("book-desktop", `${WEB}/book`, desktop, 3);
await single("book-phone", `${WEB}/book`, phone, 3500, `window.scrollTo(0, 900)`);
await single("account-desktop", `${WEB}/account`, desktop);

/** Signs the headless browser in with a development test account. */
async function signIn(role: keyof typeof DEMO_ACCOUNTS) {
  const a = DEMO_ACCOUNTS[role];
  await evaluate(`fetch("/api/v1/account/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(${JSON.stringify({ email: a.email, password: a.password })}) }).then(r => r.status)`);
}
const wide: View = { w: 1600, h: 1000 };
if (!only.length || only.some((o) => ["account-signed", "delivery", "checkout", "floor", "driver", "admin"].some((p) => p.startsWith(o) || o.startsWith(p)))) {
  await open(`${WEB}/visit`, desktop, 1500);
  await signIn("customer");
  await single("account-signed-desktop", `${WEB}/account`, desktop);
  await single("delivery-phone", `${WEB}/r/passplate?delivery=1`, phone);
  await single(
    "checkout-delivery-phone",
    `${WEB}/r/passplate?delivery=1`,
    phone,
    3500,
    `(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      [...document.querySelectorAll("main button")].find((b) => b.textContent.includes("Flat iron steak"))?.click();
      await wait(900);
      [...document.querySelectorAll("[role=dialog] button")].find((b) => /^Add/.test(b.textContent.trim()))?.click();
      await wait(900);
      [...document.querySelectorAll("button")].find((b) => b.textContent.includes("View your order"))?.click();
      await wait(2500);
    })()`,
  );
  await signIn("staff");
  await single("floor-desktop", `${WEB}/staff/floor`, wide, 4500);
  await signIn("driver");
  await single("driver-desktop", `${WEB}/staff/driver`, desktop, 4500);
  await signIn("admin");
  await single("admin-overview-desktop", `${WEB}/staff/admin`, desktop, 4000);
  await single("admin-transactions-desktop", `${WEB}/staff/admin?tab=transactions`, desktop, 4000, `[...document.querySelectorAll("button")].find(b => b.textContent === "7 days")?.click()`);
  await evaluate(`fetch("/api/v1/account/logout", { method: "POST" })`);
}

// Newest order for the status page, if there is one.
const snap = await (
  await fetch(`${API}/v1/kitchen/${demo.location.id}/tickets`, { headers: { Authorization: `Bearer ${demo.kitchenCode}` } })
).json();
const latest = snap.tickets.at(-1);
if (latest) await single("order-status-phone", `${WEB}/order/${latest.id}`, phone);

// Sign the kitchen screen in through localStorage, then capture the board.
await send("Runtime.evaluate", {
  expression: `localStorage.setItem("pass:kitchen:${demo.location.slug}", ${JSON.stringify(
    JSON.stringify({ locationId: demo.location.id, locationName: demo.location.name, token: demo.kitchenCode }),
  )})`,
});
await single("kitchen-desktop", `${WEB}/kitchen/${demo.location.slug}`, desktop);

ws.close();
proc.kill();
process.exit(0);
