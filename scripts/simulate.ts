/**
 * Simulated user testing. Artificial guests, staff and an admin use the real
 * site in a headless browser: each in their own browser profile, clicking at
 * real screen positions and typing with the keyboard, the way people do.
 *
 *   Maya    books a table on her phone from the home page, then cancels it.
 *   Sam     (the demo regular, seven stamps) orders, pays, earns a reward, spends it.
 *   Priya   signs up, orders delivery and pays (one declined card first); Dee,
 *           a driver, takes it across town while Priya watches the rider move.
 *   Marco   runs the floor: seats two walk-ins, Lena and Theo, who each scan
 *           the table's QR code and build one shared order on two phones;
 *           Theo sends it, Lena is told, Marco sees it arrive, settles the bill
 *           and resets the table, while Asha (admin) watches the payment land.
 *   Asha    changes a price in the menu editor; Lena's open menu updates.
 *   Jo      joins from an invite link Asha made and opens the kitchen screen.
 *   A crowd of 30 guests try to book the same Saturday at the same time.
 *   A sweep checks every public page on a phone and a desktop.
 *
 * Writes docs/user-testing/report.md and screenshots of the key moments.
 * Needs `bun run dev`, and changes data: run `bun run db:seed` afterwards.
 *
 * Usage: bun scripts/simulate.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_ACCOUNTS } from "../packages/db/src/seed";

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const API = process.env.API_URL ?? "http://localhost:4000";
const OUT = fileURLToPath(new URL("../docs/user-testing/", import.meta.url));
const PORT = 9334;
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- browser

const exe =
  process.env.BROWSER ??
  [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ].find((b) => existsSync(b));
if (!exe) throw new Error("No Edge or Chrome found. Set BROWSER to its path.");
const profile = join(tmpdir(), `passplate-sim-${Date.now()}`);
// A run that was killed outright cannot clean up after itself, so the next run
// closes any browser such a run left behind, before starting its own.
killBrowsersUsing(join(tmpdir(), "passplate-sim-"));
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
/**
 * Closes the whole browser. On Windows the process Edge is started as hands
 * over to another and exits at once, so its id is no use: every process using
 * this run's own profile folder is ended instead.
 */
function closeBrowser() {
  if (process.platform !== "win32") return void proc.kill();
  killBrowsersUsing(profile);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(130));
// A crash must still close the browser: without these, Bun skips the exit event.
process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(err);
  process.exit(1);
});
process.on("exit", () => {
  closeBrowser();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
});

let version: { webSocketDebuggerUrl: string } | null = null;
for (let i = 0; i < 50 && !version; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch {
    await Bun.sleep(200);
  }
}
if (!version) throw new Error("Browser did not start");
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 1;
const pending = new Map<number, (v: any) => void>();
const handlers = new Map<string, ((m: any) => void)[]>();
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.error ? { __error: msg.error } : msg.result);
    pending.delete(msg.id);
  } else if (msg.sessionId) handlers.get(msg.sessionId)?.forEach((h) => h(msg));
};
function cdp(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((r) => pending.set(id, r));
}

// ---------------------------------------------------------------- report

interface Step {
  persona: string;
  step: string;
  ok: boolean;
  ms: number;
  note?: string;
}
const steps: Step[] = [];
const findings: { severity: "high" | "medium" | "low"; where: string; what: string }[] = [];
const shots: { persona: string; file: string; caption: string }[] = [];
const slowLoads: string[] = [];
function finding(severity: "high" | "medium" | "low", where: string, what: string) {
  if (!findings.some((f) => f.where === where && f.what === what)) findings.push({ severity, where, what });
}

type View = { w: number; h: number; mobile?: boolean };
const PHONE: View = { w: 390, h: 844, mobile: true };
const DESKTOP: View = { w: 1440, h: 900 };
const WIDE: View = { w: 1600, h: 1000 };

/** One simulated person: their own browser context, so their own cookies. */
class Persona {
  sessionId = "";
  consoleErrors: string[] = [];
  constructor(
    readonly name: string,
    readonly view: View,
  ) {}

  async start() {
    const { browserContextId } = await cdp("Target.createBrowserContext", { disposeOnDetach: true });
    const { targetId } = await cdp("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = sessionId;
    handlers.set(sessionId, [
      (m) => {
        if (m.method === "Runtime.exceptionThrown") this.consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
        if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
          const text = m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ");
          // Vite's dev reload socket is not part of the product.
          if (!/WebSocket connection to 'ws:\/\/localhost:3000\/'|\[vite\]/.test(text)) this.consoleErrors.push(text.slice(0, 300));
        }
      },
    ]);
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: this.view.w,
      height: this.view.h,
      deviceScaleFactor: this.view.mobile ? 2 : 1,
      mobile: Boolean(this.view.mobile),
    });
    if (this.view.mobile) await this.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    return this;
  }

  send(method: string, params: Record<string, unknown> = {}) {
    return cdp(method, params, this.sessionId);
  }

  async eval<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "script error");
    return r?.result?.value as T;
  }

  async goto(path: string) {
    const loaded = new Promise<void>((resolve) => {
      const list = handlers.get(this.sessionId)!;
      const h = (m: any) => {
        if (m.method === "Page.loadEventFired") {
          list.splice(list.indexOf(h), 1);
          resolve();
        }
      };
      list.push(h);
    });
    await this.send("Page.navigate", { url: path.startsWith("http") ? path : WEB + path });
    await Promise.race([loaded, Bun.sleep(20_000)]);
    // People wait for a page to come alive; so do these scripts. The dev server
    // can take several seconds to send a fresh browser all of its code.
    const t = performance.now();
    await this.waitFor(`document.documentElement.dataset.hydrated === "true" && document.documentElement.dataset.account === "ready"`, "the page to become interactive", 30_000);
    const ms = performance.now() - t;
    if (ms > 4000) slowLoads.push(`${path} took ${(ms / 1000).toFixed(1)} s to become interactive for ${this.name}`);
    await Bun.sleep(400);
  }

  /** Waits until a condition holds in the page. */
  async waitFor(js: string, what: string, timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await this.eval<boolean>(`Boolean(${js})`)) return;
      } catch {}
      await Bun.sleep(250);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  /**
   * Clicks an element the way a finger would: scrolls to it, checks nothing is
   * on top of it, then presses at its centre.
   */
  async click(finder: string, what: string) {
    const box = await this.eval<{ x: number; y: number; covered: string | null; disabled: boolean } | null>(`(() => {
      const el = ${finder};
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      const covered = top && !el.contains(top) && !top.contains(el) ? (top.outerHTML || "").slice(0, 120) : null;
      return { x, y, covered, disabled: Boolean(el.disabled) };
    })()`);
    if (!box) throw new Error(`Could not find ${what}`);
    if (box.disabled) throw new Error(`${what} is disabled`);
    if (box.covered) finding("medium", this.name, `"${what}" was covered by another element when tapped: ${box.covered}`);
    await Bun.sleep(150);
    if (this.view.mobile) {
      // A finger: touch start and end at the same point is a tap.
      await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
      await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
      for (const type of ["mousePressed", "mouseReleased"]) {
        await this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
    }
    await Bun.sleep(350);
  }

  /** Focuses a field, clears it and types like a keyboard. */
  async type(finder: string, text: string, what: string) {
    const ok = await this.eval<boolean>(`(() => { const el = ${finder}; if (!el) return false; el.scrollIntoView({ block: "center", behavior: "instant" }); el.focus(); el.select?.(); return true; })()`);
    if (!ok) throw new Error(`Could not find ${what}`);
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await this.send("Input.insertText", { text });
    await Bun.sleep(120);
  }

  /** Picks an option in a native select. */
  async choose(finder: string, value: string) {
    await this.eval(`(() => { const el = ${finder}; const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await Bun.sleep(200);
  }

  async shot(file: string, caption: string) {
    const { data } = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 82 });
    await Bun.write(join(OUT, file), Buffer.from(data, "base64"));
    shots.push({ persona: this.name, file, caption });
  }

  async step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
    const t = performance.now();
    try {
      const v = await fn();
      steps.push({ persona: this.name, step: name, ok: true, ms: Math.round(performance.now() - t) });
      console.log(`  ok   ${this.name}: ${name}`);
      return v;
    } catch (err) {
      const note = (err as Error).message;
      steps.push({ persona: this.name, step: name, ok: false, ms: Math.round(performance.now() - t), note });
      console.log(`  FAIL ${this.name}: ${name} (${note})`);
      const file = `fail-${this.name.toLowerCase()}-${steps.length}.jpg`;
      await this.shot(file, `Failed: ${name}`).catch(() => {});
      return undefined;
    }
  }

  async signIn(role: keyof typeof DEMO_ACCOUNTS, path = "/account") {
    const a = DEMO_ACCOUNTS[role];
    await this.goto(path);
    const staffForm = path.startsWith("/staff") || path.startsWith("/kitchen");
    const email = staffForm ? "#staff-email" : "#account-email";
    const pass = staffForm ? "#staff-password" : "#account-password";
    await this.type(`document.querySelector("${email}")`, a.email, "email");
    await this.type(`document.querySelector("${pass}")`, a.password, "password");
    await this.click(`[...document.querySelectorAll("button[type=submit]")].at(-1)`, "Sign in");
  }
}

// Page-side finders.
const byText = (sel: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().replace(/\\s+/g, " ").includes(${JSON.stringify(text)}))`;
const fieldByLabel = (label: string) =>
  `[...document.querySelectorAll("label")].find((l) => l.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector("input, textarea, select")`;
// textContent, not innerText: small capitals are uppercased by CSS, not in the text.
const textHas = (text: string) => `document.body.textContent.includes(${JSON.stringify(text)})`;

// ---------------------------------------------------------------- helpers

const demo = (await (await fetch(`${API}/v1/dev/demo`)).json()) as {
  location: { id: string; slug: string };
  tables: { label: string; token: string }[];
};

/** The kitchen, signed in with its own staff account, moves a ticket along. */
let kitchenCookie = "";
async function kitchenMove(orderId: string, path: [string, string][]) {
  if (!kitchenCookie) {
    const res = await fetch(`${API}/v1/account/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: DEMO_ACCOUNTS.kitchen.email, password: DEMO_ACCOUNTS.kitchen.password }),
    });
    kitchenCookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
  }
  for (const [from, to] of path) {
    const res = await fetch(`${API}/v1/kitchen/${demo.location.id}/tickets/${orderId}/transition`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: kitchenCookie },
      body: JSON.stringify({ from, to, actionId: crypto.randomUUID(), device: "simulated-kitchen" }),
    });
    if (!res.ok) throw new Error(`the kitchen could not move the ticket to ${to} (${res.status})`);
    await Bun.sleep(500);
  }
}

/** From the basket to a paid order: continue, then pay on the order page (FR-8). */
async function checkout(p: Persona, opts: { declineFirst?: boolean } = {}) {
  await p.click(byText("[role=dialog] button", "Continue to payment"), "Continue to payment");
  await p.waitFor(`location.pathname.startsWith("/order/")`, "the payment page", 15_000);
  await p.waitFor(`document.querySelector("#pay-now")`, "the payment form", 10_000);
  await Bun.sleep(600); // a person reads the screen before tapping
  if (opts.declineFirst) {
    await p.click(byText("button", "Try a declined card"), "Try a declined card");
    await p.waitFor(textHas("Your card was declined"), "the declined message");
  }
  await p.click(`document.querySelector("#pay-now")`, "Pay now");
  await p.waitFor(textHas("The kitchen has your order."), "the kitchen to have the order", 10_000);
}
const orderIdFromUrl = async (p: Persona) => (await p.eval<string>("location.pathname")).split("/").pop()!;

/** A guest's order: open the dish, take the first options, add it. */
async function addDish(p: Persona, dish: string) {
  await p.click(byText("main button", dish), `the ${dish}`);
  await p.waitFor(`document.querySelector("[role=dialog]")`, "the dish sheet");
  await p.click(`[...document.querySelectorAll("[role=dialog] button")].find((b) => /^Add/.test(b.textContent.trim()))`, "Add to order");
  await p.waitFor(`!document.querySelector("[role=dialog]")`, "the sheet to close");
}

// ---------------------------------------------------------------- personas

async function maya() {
  const p = await new Persona("Maya", PHONE).start();
  await p.step("opens the home page on her phone", () => p.goto("/"));
  await p.step("picks 4 guests in the booking bar and taps Find a table", async () => {
    await p.choose(`document.querySelector("form[aria-label='Find a table'] select")`, "4");
    await p.click(byText("form[aria-label='Find a table'] button", "Find a table"), "Find a table");
    await p.waitFor(`location.pathname === "/book"`, "the booking page");
  });
  const firstFree = `[...document.querySelectorAll("fieldset button")].find((b) => /^\\d\\d:\\d\\d$/.test(b.textContent.trim()) && !b.disabled)`;
  await p.step("finds a free time", async () => {
    await p.waitFor(`${firstFree} || document.body.innerText.includes("Fully booked") || document.body.innerText.includes("closed on")`, "times", 12_000);
    if (!(await p.eval<boolean>(`Boolean(${firstFree})`))) {
      finding(
        "medium",
        "Booking bar",
        "The booking bar defaults to Today. Late in the evening that opens a fully booked page, and the guest has to pick another day by hand.",
      );
      await p.click(`[...document.querySelectorAll("fieldset button[aria-pressed]")].find((b) => !b.disabled && b.getAttribute("aria-pressed") === "false" && /\\d/.test(b.textContent))`, "the next day");
      await p.waitFor(firstFree, "times on the next day", 12_000);
    }
    await p.click(firstFree, "the first free time");
  });
  await p.step("fills in her details", async () => {
    await p.type(fieldByLabel("Name"), "Maya Ellis", "name");
    await p.type(fieldByLabel("Phone"), "07700 900555", "phone");
    await p.type(fieldByLabel("Email"), "maya@example.test", "email");
    await p.type(fieldByLabel("Anything we should know"), "One of us is vegetarian", "notes");
  });
  await p.step("confirms the booking", async () => {
    await p.click(byText("aside button", "Book for 4"), "Book for 4");
    await p.waitFor(`location.pathname.startsWith("/booking/")`, "the confirmation", 12_000);
    await p.waitFor(textHas("You're booked."), "the confirmation headline");
  });
  await p.shot("maya-booked.jpg", "Maya's confirmation, with her reference");
  await p.step("cancels the booking", async () => {
    await p.click(byText("button", "Cancel this booking"), "Cancel this booking");
    await p.click(byText("button", "Yes, cancel it"), "Yes, cancel it");
    await p.waitFor(textHas("Booking cancelled."), "the cancelled state");
  });
  return p;
}

async function sam() {
  const p = await new Persona("Sam", DESKTOP).start();
  await p.step("signs in", async () => {
    await p.signIn("customer");
    await p.waitFor(textHas("Hello, Sam."), "the account page");
  });
  await p.step("sees 7 of 8 stamps", () => p.waitFor(textHas("1 more order to 20% off."), "the stamp count"));
  await p.step("orders a Margherita to collect and pays", async () => {
    await p.goto("/r/passplate");
    await addDish(p, "Margherita");
    await p.click(byText("button", "View your order"), "View your order");
    await checkout(p);
  });
  const first = await orderIdFromUrl(p);
  await p.step("the kitchen cooks it and he collects it", async () => {
    await kitchenMove(first, [["received", "cooking"], ["cooking", "ready"]]);
    await p.waitFor(textHas("It's ready."), "the ready message (live, without reloading)", 10_000);
    await kitchenMove(first, [["ready", "completed"]]);
  });
  await p.step("the eighth stamp turns into a reward", () => p.waitFor(textHas("You have a reward waiting"), "the reward note", 10_000));
  await p.shot("sam-reward.jpg", "Sam's eighth order: the reward appears on the order page");
  await p.step("spends the reward on the next order", async () => {
    await p.goto("/r/passplate");
    await addDish(p, "Tagliatelle carbonara");
    await addDish(p, "Tiramisu");
    await p.click(byText("button", "View your order"), "View your order");
    await p.click(byText("[role=dialog] label", "Use your reward"), "Use your reward");
    await p.waitFor(`[...document.querySelectorAll("[role=dialog] dt")].some((d) => d.textContent === "Reward")`, "the discount line");
    await p.shot("sam-checkout-reward.jpg", "Sam's basket with 20% off");
    await p.click(byText("[role=dialog] button", "Continue to payment"), "Continue to payment");
    await p.waitFor(`document.querySelector("#pay-now")`, "the payment form", 15_000);
    await p.shot("sam-payment.jpg", "Sam's payment step: the kitchen gets the order once it is paid");
    await p.click(`document.querySelector("#pay-now")`, "Pay now");
    await p.waitFor(textHas("The kitchen has your order.") + " && " + textHas("Reward"), "the paid order with the discount", 12_000);
  });
  return p;
}

async function priyaAndDee() {
  const priya = await new Persona("Priya", PHONE).start();
  const dee = await new Persona("Dee", DESKTOP).start();
  const email = `priya.${Date.now()}@example.test`;
  await priya.step("creates an account", async () => {
    await priya.goto("/account");
    await priya.click(byText("button", "Create an account"), "Create an account");
    await priya.type("document.querySelector('#account-name')", "Priya Shah", "name");
    await priya.type("document.querySelector('#account-email')", email, "email");
    await priya.type("document.querySelector('#account-password')", "a-good-long-password", "password");
    await priya.click(byText("button[type=submit]", "Create account"), "Create account");
    await priya.waitFor(textHas("Hello, Priya."), "her new account");
  });
  await priya.step("switches to delivery and fills a basket", async () => {
    await priya.goto("/r/passplate?delivery=1");
    await priya.waitFor(textHas("Dinner, delivered."), "the delivery menu");
    await addDish(priya, "Lasagne al forno");
    await addDish(priya, "Sticky toffee pudding");
    await priya.click(byText("button", "View your order"), "View your order");
  });
  await priya.step("finds her address by postcode", async () => {
    await priya.type(fieldByLabel("Phone"), "07700 900777", "phone");
    await priya.type(fieldByLabel("Postcode"), "BS1 4LH", "postcode");
    await priya.click(byText("[role=dialog] button", "Find"), "Find");
    try {
      await priya.waitFor(textHas("km away"), "the distance", 10_000);
    } catch {
      finding("low", "Delivery address", "Postcode lookup did not answer; tapping the map was needed instead.");
      await priya.click(`document.querySelector("[role=dialog] [aria-label^='Delivery address'] canvas")`, "the map");
      await priya.waitFor(textHas("km away"), "the distance after tapping the map");
    }
    await priya.type(fieldByLabel("House number and street"), "18 Queen Square", "street");
  });
  await priya.shot("priya-checkout.jpg", "Priya's delivery checkout: address, fee and total");
  await priya.step("pays: her first card is declined, the second goes through", () => checkout(priya, { declineFirst: true }));
  const orderId = await orderIdFromUrl(priya);

  await dee.step("signs in on the driver screen and starts her shift", async () => {
    await dee.signIn("driver", "/staff/driver");
    await dee.waitFor(textHas("From the kitchen"), "the driver board");
    await dee.click(`document.querySelector("#shift-toggle")`, "Start shift");
    await dee.waitFor(textHas("On shift."), "being on shift");
  });
  const marco = await new Persona("Marco (dispatch)", WIDE).start();
  extra.push(marco);
  await marco.step("opens the dispatch map and gives Priya's order to Dee", async () => {
    await marco.signIn("staff", "/staff/dispatch");
    await marco.waitFor(textHas("Waiting for a driver"), "the dispatch board");
    await marco.waitFor(`document.querySelector("[data-map='loaded'], [data-map='style']")`, "the map", 20_000);
    await marco.click(byText("aside button[aria-pressed]", "Priya"), "Priya's order");
    await marco.waitFor(textHas("Give it to"), "the driver choices");
    await marco.click(byText("#dispatch-selected button", "Dee Okafor"), "Dee Okafor");
    await marco.waitFor(textHas("→ Dee Okafor"), "the order marked as Dee's", 10_000);
  });
  await marco.waitFor(`document.querySelector("[data-map='loaded']")`, "the map tiles", 20_000).catch(() => {});
  await marco.shot("marco-dispatch.jpg", "Marco's dispatch map: Priya's order given to Dee");
  await dee.step("sees it given to her, live", () => dee.waitFor(textHas("Given to you by the dispatcher"), "the assigned delivery", 10_000));
  await priya.step("the kitchen cooks it", () => kitchenMove(orderId, [["received", "cooking"], ["cooking", "ready"]]));
  await dee.step("sees it ready and sets off", async () => {
    await dee.waitFor(byText("button", "Picked up, set off"), "the ready delivery", 10_000);
    await dee.click(byText("button", "Picked up, set off"), "Picked up, set off");
    await dee.waitFor(textHas("On the road"), "the route card");
  });
  await dee.step("drives the route", () => dee.click(byText("button", "Practise the route"), "Practise the route"));
  await priya.step("watches the rider move on her map, with an arrival time", async () => {
    await priya.waitFor(`document.querySelector(".map-pin-driver")`, "the rider on the map", 15_000);
    const box = await priya.eval<number>(`document.querySelector("[data-map]")?.getBoundingClientRect().height ?? 0`);
    if (box < 100) throw new Error(`the map is not visible (${box}px tall)`);
    const pos = () => priya.eval<string>(`(() => { const r = document.querySelector(".map-pin-driver").getBoundingClientRect(); return Math.round(r.left) + "," + Math.round(r.top); })()`);
    const a = await pos();
    await Bun.sleep(8000);
    const b = await pos();
    if (a === b) throw new Error("the rider pin did not move");
    // She lives round the corner, so "nearly there" may come before any arrival time.
    await priya.waitFor(`${textHas("arriving in about")} || ${textHas("nearly there")}`, "an arrival time");
  });
  await priya.shot("priya-tracking.jpg", "Priya's order page: the rider moving towards her");
  await marco.step("sees Dee moving on the dispatch map", () => marco.waitFor(textHas("On the road"), "the road list"));
  await dee.shot("dee-route.jpg", "Dee's driver screen during the delivery");
  await priya.step("is told the rider is nearly there (within 200 m)", () =>
    priya.waitFor(textHas("Your driver is less than 200 m away."), "the nearly-there alert", 75_000),
  );
  await priya.shot("priya-arriving.jpg", "Priya's order page: the driver is nearly there");
  await dee.step("leaves it at the door and says so", async () => {
    await dee.click(`document.querySelector("#delivered")`, "Delivered");
    await dee.waitFor(`document.querySelector("#proof")`, "the proof choices");
    await dee.click(byText("#proof label", "Left at the door"), "Left at the door");
    await dee.type(`document.querySelector("#proof-note")`, "Rang twice, left on the step", "note");
    await dee.click(`document.querySelector("#confirm-delivered")`, "Confirm delivered");
    await dee.waitFor(textHas("No deliveries waiting"), "the empty board", 10_000);
  });
  await priya.step("sees it delivered, with how it was left", () => priya.waitFor(textHas("Left at the door"), "the delivered message", 10_000));
  await priya.step("opens her receipt", async () => {
    await priya.waitFor(`document.querySelector("#receipt-link")`, "the receipt link", 15_000);
    await priya.click(`document.querySelector("#receipt-link")`, "View or print receipt");
    await priya.waitFor(`document.querySelector("[data-receipt]")`, "the receipt", 15_000);
    const text = await priya.eval<string>(`document.querySelector("[data-receipt]").innerText`);
    if (!/VAT 20% included/.test(text) || !/R-\d{6}/.test(text)) throw new Error("the receipt is missing its number or VAT line");
  });
  await priya.shot("priya-receipt.jpg", "Priya's receipt, ready to print or save as a PDF");
  await marco.step("sees it under Delivered today, with the proof", () =>
    marco.waitFor(`document.querySelector("#delivered-list")?.innerText.includes("Rang twice")`, "the delivered list", 10_000),
  );
  return [priya, dee];
}

/** People started inside a journey, so their console errors are checked too. */
const extra: Persona[] = [];

async function marcoAndAsha() {
  const marco = await new Persona("Marco", WIDE).start();
  const asha = await new Persona("Asha", DESKTOP).start();
  await marco.step("signs in and opens the floor", async () => {
    await marco.signIn("staff", "/staff/floor");
    await marco.waitFor(textHas("Tonight's floor"), "the floor plan");
  });
  await asha.step("signs in and opens transactions", async () => {
    await asha.signIn("admin", "/staff/admin?tab=transactions");
    await asha.waitFor(textHas("Taken"), "the transactions");
  });
  const free = await marco.eval<string | null>(
    `[...document.querySelectorAll("button[aria-label*=', Free']")].map((b) => b.getAttribute("aria-label").split(",")[0]).find((l) => l.startsWith("Table"))`,
  );
  if (!free) {
    marco.step("finds a free table", async () => {
      throw new Error("no free table");
    });
    return [marco, asha];
  }
  const tableBtn = `[...document.querySelectorAll("button[aria-label^='${free},']")][0]`;
  await marco.step(`seats two walk-ins at ${free}`, async () => {
    await marco.click(tableBtn, free);
    await marco.click(byText("aside button", "Seat 2 here"), "Seat 2 here");
    await marco.waitFor(`${tableBtn}?.getAttribute("aria-label").includes("Seated")`, "the table to show Seated");
  });
  const token = demo.tables.find((t) => t.label === free)!.token;
  // Lena and Theo each scan the table's QR code and build one order (FR-4).
  const lena = await new Persona("Lena", PHONE).start();
  const theo = await new Persona("Theo", PHONE).start();
  extra.push(lena, theo);
  for (const [guest, name] of [[lena, "Lena"], [theo, "Theo"]] as const) {
    await guest.step(`scans the QR code at ${free} and gives her name`.replace("her", name === "Theo" ? "his" : "her"), async () => {
      await guest.goto(`/t/${token}`);
      await guest.waitFor(textHas("Everyone at this table adds to one order"), "the shared order note");
      await guest.type(`document.querySelector("#table-name")`, name, "name");
    });
  }
  await lena.step("adds Cacio e pepe", () => addDish(lena, "Cacio e pepe"));
  await theo.step("adds an Aperol spritz", () => addDish(theo, "Aperol spritz"));
  await theo.step("sees Lena's dish in the table's order, live", async () => {
    await theo.waitFor(textHas("So far: Lena, Theo") + " || " + textHas("So far: Theo, Lena"), "both names at the table", 8000);
    await theo.click(byText("button", "View the table's order"), "View the table's order");
    await theo.waitFor(`${textHas("Added by Lena")} && ${textHas("Added by Theo")}`, "both dishes, with who added them", 8000);
  });
  await theo.shot("theo-table-cart.jpg", "Theo's phone: one order for the table, with who added what");
  await theo.step("sends the whole table's order to the kitchen", async () => {
    await theo.click(byText("[role=dialog] button", "Send to the kitchen"), "Send to the kitchen");
    await theo.waitFor(`location.pathname.startsWith("/order/")`, "his order page", 12_000);
  });
  await lena.step("is told Theo sent it, without reloading", () => lena.waitFor(textHas("Theo sent 2 dishes to the kitchen"), "the sent note", 10_000));
  await lena.shot("lena-sent.jpg", "Lena's phone: Theo sent the table's order");
  const ticket = { id: await orderIdFromUrl(theo) };
  await marco.step("sees the guests' QR order arrive without reloading", () =>
    marco.waitFor(`${tableBtn}?.getAttribute("aria-label").includes("Food on the way")`, "Food on the way", 8000),
  );
  await marco.shot("marco-floor.jpg", "Marco's floor: the walk-in's order shows live");
  await marco.step("the kitchen serves it; the table shows Eating", async () => {
    await kitchenMove(ticket.id, [["received", "cooking"], ["cooking", "ready"], ["ready", "completed"]]);
    await marco.waitFor(`${tableBtn}?.getAttribute("aria-label").includes("Eating")`, "Eating", 8000);
  });
  await marco.step("settles the bill by card", async () => {
    await marco.click(tableBtn, free);
    await marco.click(byText("aside button", "Paid by card"), "Paid by card");
    await marco.waitFor(`${tableBtn}?.getAttribute("aria-label").includes("Needs clearing")`, "Needs clearing");
  });
  await asha.step("sees Marco's card payment appear live", () =>
    asha.waitFor(`[...document.querySelectorAll("tbody tr")].some((r) => r.innerText.includes("Marco Rossi") && r.innerText.includes(${JSON.stringify(free)}))`, "the new row", 10_000),
  );
  await asha.shot("asha-transactions.jpg", "Asha's transactions: the card payment arrives on its own");
  await asha.step("opens the overview: takings, two weeks of trade, best sellers", async () => {
    await asha.goto("/staff/admin");
    await asha.waitFor(`${textHas("Takings, last 14 days")} && document.querySelectorAll("svg[role=img] path").length > 0`, "the overview chart", 10_000);
  });
  await asha.shot("asha-overview.jpg", "Asha's overview");
  await asha.step("raises the Tiramisu price in the menu editor", async () => {
    await asha.goto("/staff/admin?tab=menu");
    await asha.waitFor(textHas("Sections"), "the menu editor");
    const menu = await (await fetch(`${API}/v1/locations/passplate/menu`)).json();
    const section = menu.categories.find((c: any) => c.items.some((i: any) => i.name === "Tiramisu")).name;
    await asha.click(byText("aside li button", section), section);
    await asha.click(`[...document.querySelectorAll("section li button")].find((b) => b.textContent.includes("Tiramisu"))`, "Tiramisu");
    await asha.waitFor(`document.querySelector("[role=dialog]")`, "the dish editor");
    await asha.type(fieldByLabel("Price (£)"), "7.75", "price");
    await asha.shot("asha-menu-editor.jpg", "Asha's menu editor: a dish with its photo, price, allergens and choices");
    await asha.click(`[...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Save")`, "Save");
    await asha.waitFor(textHas("Tiramisu saved."), "the saved note");
  });
  await lena.step("sees the new price on her open menu, without reloading", () =>
    lena.waitFor(`[...document.querySelectorAll("main li")].some((li) => li.textContent.includes("Tiramisu") && li.textContent.includes("£7.75"))`, "£7.75 for Tiramisu", 10_000),
  );
  let inviteUrl = "";
  await asha.step("makes an invite link for a new kitchen hand", async () => {
    await asha.goto("/staff/admin?tab=team");
    await asha.type(`document.querySelector("input[aria-label='Their name']")`, "Jo", "name");
    await asha.click(byText("button", "Make an invite link"), "Make an invite link");
    await asha.waitFor(`document.querySelector("#invite-url")`, "the link");
    inviteUrl = await asha.eval<string>(`document.querySelector("#invite-url").textContent.trim()`);
  });
  const jo = await new Persona("Jo", PHONE).start();
  extra.push(jo);
  await jo.step("opens the invite, chooses a password and is signed in", async () => {
    await jo.goto(new URL(inviteUrl).pathname);
    await jo.waitFor(textHas("Welcome to the team."), "the invite page");
    await jo.type(`document.querySelector("#join-email")`, `jo.${Date.now()}@passplate.test`, "email");
    await jo.type(`document.querySelector("#join-password")`, "a-long-kitchen-password", "password");
    await jo.click(byText("button[type=submit]", "Join"), "Join");
    await jo.waitFor(`location.pathname === "/staff"`, "the staff home", 12_000);
  });
  await jo.step("opens the kitchen screen with that account", async () => {
    await jo.goto("/kitchen/passplate");
    await jo.waitFor(textHas("Stock"), "the kitchen board", 12_000);
  });
  await marco.step("the guests ask for a receipt: it is ready to print", async () => {
    await marco.waitFor(`document.querySelector("#print-table-receipt")`, "the Print receipt button");
    const href = await marco.eval<string>(`document.querySelector("#print-table-receipt").getAttribute("href")`);
    const orderId = href.split("?")[0]!.split("/").pop()!;
    // The worker writes it a moment after the payment.
    let receipt: { number?: number; orderIds?: string[] } | null = null;
    for (let i = 0; i < 20 && !receipt?.number; i++) {
      receipt = await marco.eval(`fetch("/api/v1/staff/receipts/order/${orderId}").then((r) => r.json())`);
      if (!receipt?.number) await Bun.sleep(500);
    }
    if (!receipt?.number) throw new Error("no receipt was written for the table");
  });
  await marco.step("resets the table", async () => {
    await marco.click(byText("aside button", "Table is reset and ready"), "Table is reset and ready");
    await marco.waitFor(`${tableBtn}?.getAttribute("aria-label").includes("Free")`, "Free again");
  });
  return [marco, asha];
}

/** Thirty guests press "book" for the same Saturday at 20:00 within the same instant. */
async function crowd() {
  const t = performance.now();
  const d = new Date(Date.now() + 3 * 86_400_000);
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
  const date = d.toISOString().slice(0, 10);
  const floor = await (await fetch(`${API}/v1/dev/demo`)).json();
  void floor;
  // Thirty different people, so thirty different addresses (TEST-NET-3, never routed).
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      fetch(`${API}/v1/reservations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${i + 1}` },
        body: JSON.stringify({ locationSlug: "passplate", date, time: "20:00", party: 4, name: `Crowd ${i + 1}`, phone: "07700 900999" }),
      }).then(async (r) => ({ status: r.status, body: await r.json() })),
    ),
  );
  const ok = results.filter((r) => r.status === 201);
  const limited = results.filter((r) => r.status === 429).length;
  const tables = new Set(ok.map((r) => r.body.tableLabel));
  const ms = Math.round(performance.now() - t);
  const avail = await (await fetch(`${API}/v1/locations/passplate/availability?date=${date}&party=4`)).json();
  const stillFree = avail.slots.find((s: any) => s.time === "20:00")?.available;
  const pass = ok.length === tables.size && !stillFree && limited === 0;
  steps.push({
    persona: "Crowd",
    step: `30 guests book Saturday ${date} at 20:00 for four at the same moment`,
    ok: pass,
    ms,
    note: `${ok.length} booked, each on a different table (${[...tables].join(", ")}); ${results.length - ok.length - limited} were told it had just been taken${limited ? `; ${limited} were rate limited` : ""}; 20:00 now shows as ${stillFree ? "free (wrong)" : "full"}.`,
  });
  console.log(`  ${pass ? "ok  " : "FAIL"} Crowd: ${ok.length} of 30 booked on ${tables.size} tables`);
}

/** Every public page on a phone and a desktop: overflow, broken pictures, errors, unnamed controls. */
async function sweep() {
  const pages = ["/", "/menu", "/book", "/story", "/visit", "/account", "/r/passplate", "/r/passplate?delivery=1"];
  const rows: string[] = [];
  for (const view of [PHONE, DESKTOP]) {
    const p = await new Persona(view.mobile ? "Sweep (phone)" : "Sweep (desktop)", view).start();
    for (const path of pages) {
      p.consoleErrors = [];
      await p.goto(path);
      // Scroll the whole page so lazy pictures load, as a reader would.
      await p.eval(`(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * 0.8) { scrollTo(0, y); await new Promise(r => setTimeout(r, 180)); } scrollTo(0, 0); await new Promise(r => setTimeout(r, 1500)); })()`);
      const r = await p.eval<{ overflow: number; broken: string[]; noAlt: number; unnamed: string[]; small: number }>(`(() => {
        const overflow = document.documentElement.scrollWidth - innerWidth;
        const imgs = [...document.images];
        const broken = imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.src).map((i) => i.src.split("/").pop());
        const noAlt = imgs.filter((i) => !i.hasAttribute("alt")).length;
        const controls = [...document.querySelectorAll("a[href], button, input, select")].filter((e) => e.offsetParent !== null);
        const unnamed = controls.filter((e) => {
          const name = (e.getAttribute("aria-label") || e.textContent || e.getAttribute("placeholder") || e.getAttribute("title") || "").trim();
          const labelled = e.id && document.querySelector('label[for="' + e.id + '"]') || e.closest("label");
          return !name && !labelled;
        }).map((e) => e.outerHTML.slice(0, 80));
        const small = ${view.mobile ? `controls.filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.height < 32 || b.width < 32) && e.tagName !== "A"; }).length` : "0"};
        return { overflow, broken, noAlt, unnamed, small };
      })()`);
      const where = `${path} (${view.mobile ? "phone" : "desktop"})`;
      if (r.overflow > 2) finding("medium", where, `The page scrolls sideways by ${r.overflow}px.`);
      if (r.broken.length) finding("high", where, `Pictures failed to load: ${r.broken.join(", ")}`);
      if (r.noAlt) finding("low", where, `${r.noAlt} pictures have no alt text.`);
      if (r.unnamed.length) finding("medium", where, `Controls with no accessible name: ${r.unnamed.slice(0, 3).join(" | ")}`);
      if (r.small > 0) finding("low", where, `${r.small} buttons are smaller than 32px to tap.`);
      if (p.consoleErrors.length) finding("high", where, `Console errors: ${p.consoleErrors.slice(0, 2).join(" | ")}`);
      rows.push(`| ${path} | ${view.mobile ? "Phone" : "Desktop"} | ${r.overflow > 2 ? `${r.overflow}px` : "None"} | ${r.broken.length} | ${p.consoleErrors.length} | ${r.unnamed.length} | ${view.mobile ? r.small : "n/a"} |`);
      console.log(`  swept ${where}`);
    }
  }
  return rows;
}

// ---------------------------------------------------------------- run

console.log("Simulated users, starting.");
const started = Date.now();
const people: Persona[] = [];
for (const run of [maya, sam]) {
  const p = await run().catch((e) => (console.log(e), null));
  if (p) people.push(p);
}
const pair1 = await priyaAndDee().catch((e) => (console.log(e), []));
const pair2 = await marcoAndAsha().catch((e) => (console.log(e), []));
people.push(...pair1, ...pair2, ...extra);
await crowd();
const sweepRows = await sweep();
for (const p of people) {
  if (p.consoleErrors.length) finding("high", p.name, `Console errors during the journey: ${p.consoleErrors.slice(0, 2).join(" | ")}`);
}

// ---------------------------------------------------------------- write up

const passed = steps.filter((s) => s.ok).length;
const order = { high: 0, medium: 1, low: 2 };
const md = `# Simulated user testing

Run on ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC against ${WEB}, in ${Math.round((Date.now() - started) / 1000)} seconds.
Every person below is simulated: a script in a real (headless) browser, with their own cookies, tapping the screen and typing.

**${passed} of ${steps.length} steps passed. ${findings.length} findings.**

## Journeys

| Who | Step | Result | Time |
|---|---|---|---|
${steps.map((s) => `| ${s.persona} | ${s.step} | ${s.ok ? "Passed" : `**Failed**: ${s.note}`} | ${(s.ms / 1000).toFixed(1)} s |`).join("\n")}

${steps.filter((s) => s.note && s.ok).map((s) => `- ${s.persona}: ${s.note}`).join("\n")}

## Findings

${findings.length === 0 ? "None." : findings.sort((a, b) => order[a.severity] - order[b.severity]).map((f) => `- **${f.severity}** · ${f.where}: ${f.what}`).join("\n")}

## Slow first loads

${slowLoads.length ? slowLoads.map((s) => `- ${s}`).join("\n") + "\n\nThese are measured against the development server, which compiles code on first request. A production build loads in one go." : "None over 4 seconds."}

## Page sweep

| Page | Device | Sideways scroll | Broken pictures | Console errors | Unnamed controls | Small tap targets |
|---|---|---|---|---|---|---|
${sweepRows.join("\n")}

## Screens

${shots.map((s) => `![${s.caption}](${s.file})\n*${s.persona}: ${s.caption}*`).join("\n\n")}
`;
await Bun.write(join(OUT, "report.md"), md);
await Bun.write(join(OUT, "report.json"), JSON.stringify({ steps, findings, shots }, null, 2));
console.log(`\n${passed}/${steps.length} steps passed, ${findings.length} findings. Report: docs/user-testing/report.md`);
ws.close();
process.exit(0);

/** Ends every Edge or Chrome process whose command line names a profile folder starting with `dir` (Windows). */
function killBrowsersUsing(dir: string) {
  if (process.platform !== "win32") return;
  const needle = dir.replaceAll("'", "''");
  spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null }`,
    ],
    { stdio: "ignore" },
  );
}
