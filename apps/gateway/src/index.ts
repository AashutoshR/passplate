import { createHash } from "node:crypto";
import type { ServerWebSocket } from "bun";
import Redis from "ioredis";
import postgres from "postgres";
import { ClientMessageSchema, type EventEnvelope, type ServerMessage } from "@pass/shared";

/**
 * Realtime gateway. Stateless: any instance can serve any client, because
 * events fan out through Redis (NFR-2) and missed events replay from the
 * Postgres outbox by sequence number (NFR-7).
 */

const PORT = Number(process.env.GATEWAY_PORT ?? 4100);
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://pass:pass@localhost:5433/pass";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS ?? 10_000);
const BACKLOG_LIMIT = 1000;
const MSG_BUDGET = { tokens: 30, perMs: 10_000 };

const sql = postgres(DATABASE_URL, {
  max: 5,
  onnotice: () => {},
  connection: { application_name: "pass-gateway", statement_timeout: 3000 },
});
const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, service: "gateway", ...extra }));

interface Client {
  id: string;
  /** The signed-in person, read from the session cookie when the socket opened. */
  user: { id: string; role: string; locationId: string | null } | null;
  channels: Set<string>;
  /** Highest seq delivered. Events at or below it are never sent twice. */
  lastSeq: number;
  /** False while a subscribe replays the backlog; live events wait in `buffer`. */
  ready: boolean;
  buffer: EventEnvelope[];
  tokens: number;
  refillAt: number;
}
type Socket = ServerWebSocket<Client>;

const members = new Map<string, Set<Socket>>();
let connections = 0;
let draining = false;
let redisLive = false;

function send(ws: Socket, msg: ServerMessage | string) {
  ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
}
function broadcast(msg: ServerMessage) {
  const raw = JSON.stringify(msg);
  const seen = new Set<Socket>();
  for (const set of members.values()) for (const ws of set) if (!seen.has(ws)) (seen.add(ws), send(ws, raw));
}

function deliver(ws: Socket, env: EventEnvelope, raw?: string) {
  const c = ws.data;
  if (!c.ready) {
    c.buffer.push(env);
    return;
  }
  if (env.seq <= c.lastSeq) return;
  c.lastSeq = env.seq;
  send(ws, raw ?? JSON.stringify(env));
}

sub.on("message", (redisChannel: string, raw: string) => {
  const set = members.get(redisChannel.slice(3));
  if (!set) return;
  let env: EventEnvelope;
  try {
    env = JSON.parse(raw);
  } catch {
    return;
  }
  for (const ws of set) deliver(ws, env, raw);
});

sub.on("ready", () => {
  const wasDown = !redisLive;
  redisLive = true;
  if (wasDown) {
    log("info", "redis live");
    broadcast({ op: "live" });
    // Anything published while Redis was away is in the outbox: replay it.
    for (const set of members.values()) for (const ws of set) void catchUp(ws);
  }
});
for (const event of ["close", "end"] as const) {
  sub.on(event, () => {
    if (!redisLive) return;
    redisLive = false;
    log("warn", "redis down, clients fall back to polling");
    broadcast({ op: "degraded" });
  });
}
sub.on("error", () => {});

async function join(ws: Socket, channel: string) {
  let set = members.get(channel);
  if (!set) {
    set = new Set();
    members.set(channel, set);
    // Subscribing while Redis is down must not block the replay below.
    await Promise.race([sub.subscribe(`ev:${channel}`), Bun.sleep(1500)]).catch(() => {});
  }
  set.add(ws);
  ws.data.channels.add(channel);
}

function leave(ws: Socket, channel: string) {
  const set = members.get(channel);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    members.delete(channel);
    sub.unsubscribe(`ev:${channel}`).catch(() => {});
  }
}

/** Sends everything after lastSeq on this client's channels. False means too much: resync. */
async function replay(ws: Socket): Promise<boolean> {
  const chans = [...ws.data.channels];
  if (chans.length === 0) return true;
  const rows = await sql<{ seq: string; channel: string; type: string; payload: unknown; created_at: Date }[]>`
    select seq, channel, type, payload, created_at from outbox
    where seq > ${ws.data.lastSeq} and channel in ${sql(chans)}
    order by seq
    limit ${BACKLOG_LIMIT + 1}
  `;
  if (rows.length > BACKLOG_LIMIT) {
    send(ws, { op: "resync", reason: "too_far_behind" });
    return false;
  }
  for (const r of rows) {
    const seq = Number(r.seq);
    if (seq <= ws.data.lastSeq) continue;
    ws.data.lastSeq = seq;
    send(ws, {
      op: "event",
      seq,
      channel: r.channel,
      type: r.type as EventEnvelope["type"],
      payload: r.payload,
      at: r.created_at.toISOString(),
    });
  }
  return true;
}

async function catchUp(ws: Socket) {
  ws.data.ready = false;
  try {
    await replay(ws);
  } catch (err) {
    log("warn", "catch-up failed", { error: String(err) });
  } finally {
    flush(ws);
  }
}

function flush(ws: Socket) {
  const buffered = ws.data.buffer.sort((a, b) => a.seq - b.seq);
  ws.data.buffer = [];
  ws.data.ready = true;
  for (const env of buffered) deliver(ws, env);
}

/** Session cookie to user, the same lookup the API does. */
async function userFromCookie(cookie: string | null): Promise<Client["user"]> {
  const token = cookie
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("pp_session="))
    ?.slice("pp_session=".length);
  if (!token || token.length > 100) return null;
  const hash = createHash("sha256").update(decodeURIComponent(token)).digest("hex");
  const [row] = await sql<{ id: string; role: string; location_id: string | null }[]>`
    select u.id, u.role, u.location_id from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${hash} and s.expires_at > now()
  `;
  return row ? { id: row.id, role: row.role, locationId: row.location_id } : null;
}

/** Staff channels belong to one restaurant; admins of that restaurant may watch them all. */
function staffAllowed(user: Client["user"], locationId: string, roles: string[]): boolean {
  return Boolean(user && user.locationId === locationId && (roles.includes(user.role) || user.role === "admin"));
}

async function handleSubscribe(ws: Socket, channelsWanted: string[], since: number | undefined) {
  for (const ch of channelsWanted) {
    const [kind, id] = ch.split(":") as [string, string];
    // SEC-2: kitchen, floor, driver and admin channels need a signed-in member
    // of staff at that restaurant. Menu, order, cart and availability are
    // public by design (order and cart ids are unguessable).
    const allowed =
      kind === "kitchen"
        ? staffAllowed(ws.data.user, id, ["staff"])
        : kind === "floor"
          ? staffAllowed(ws.data.user, id, ["staff"])
          : kind === "drivers"
            ? staffAllowed(ws.data.user, id, ["driver"])
            : kind === "admin"
              ? staffAllowed(ws.data.user, id, ["admin"])
              : true;
    if (!allowed) {
      send(ws, { op: "error", code: "forbidden", message: "Sign in as staff to see this" });
      ws.close(4401, "forbidden");
      return;
    }
  }
  ws.data.ready = false;
  for (const ch of [...ws.data.channels]) if (!channelsWanted.includes(ch)) (leave(ws, ch), ws.data.channels.delete(ch));
  for (const ch of channelsWanted) await join(ws, ch);

  if (since !== undefined) {
    ws.data.lastSeq = since;
    try {
      if (!(await replay(ws))) {
        ws.data.buffer = [];
        ws.data.ready = true;
        return;
      }
    } catch (err) {
      log("error", "replay failed", { error: String(err) });
      send(ws, { op: "resync", reason: "replay_failed" });
    }
  }
  flush(ws);
  send(ws, { op: "subscribed", channels: channelsWanted, seq: ws.data.lastSeq, live: redisLive });
}

function allowMessage(c: Client): boolean {
  const now = Date.now();
  if (now >= c.refillAt) {
    c.tokens = MSG_BUDGET.tokens;
    c.refillAt = now + MSG_BUDGET.perMs;
  }
  return c.tokens-- > 0;
}

const server = Bun.serve<Client>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/health/live") return Response.json({ ok: true });
    if (url.pathname === "/health/ready") {
      try {
        await sql`select 1`;
      } catch {
        return Response.json({ ok: false, db: false }, { status: 503 });
      }
      return Response.json({ ok: !draining, redis: redisLive, connections }, { status: draining ? 503 : 200 });
    }
    if (url.pathname === "/ws") {
      if (draining) return new Response("draining", { status: 503, headers: { "Retry-After": "1" } });
      // NFR-3: a hard cap per instance; the load balancer sends the client elsewhere.
      if (connections >= MAX_CONNECTIONS) {
        return new Response("busy", { status: 503, headers: { "Retry-After": "2" } });
      }
      let user: Client["user"] = null;
      try {
        user = await userFromCookie(req.headers.get("cookie"));
      } catch (err) {
        log("warn", "session lookup failed", { error: String(err) });
      }
      const ok = srv.upgrade(req, {
        data: {
          id: crypto.randomUUID(),
          user,
          channels: new Set<string>(),
          lastSeq: 0,
          ready: true,
          buffer: [],
          tokens: MSG_BUDGET.tokens,
          refillAt: Date.now() + MSG_BUDGET.perMs,
        },
      });
      return ok ? undefined : new Response("WebSocket upgrade required", { status: 426 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    maxPayloadLength: 16 * 1024,
    // NFR-9: a client that cannot keep up is dropped and resumes by replay.
    backpressureLimit: 1024 * 1024,
    closeOnBackpressureLimit: true,
    idleTimeout: 60,
    sendPings: true,
    open() {
      connections++;
    },
    async message(ws, raw) {
      if (!allowMessage(ws.data)) {
        ws.close(4429, "too many messages");
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        send(ws, { op: "error", code: "bad_message", message: "Messages must be JSON" });
        return;
      }
      const parsed = ClientMessageSchema.safeParse(data);
      if (!parsed.success) {
        send(ws, { op: "error", code: "bad_message", message: "Unknown or invalid message" });
        return;
      }
      const msg = parsed.data;
      if (msg.op === "ping") return send(ws, { op: "pong", at: new Date().toISOString() });
      await handleSubscribe(ws, msg.channels, msg.since);
    },
    close(ws) {
      connections--;
      for (const ch of ws.data.channels) leave(ws, ch);
    },
  },
});
log("info", "gateway listening", { port: server.port, maxConnections: MAX_CONNECTIONS });

/** NFR-10: stop taking connections, spread reconnects out, then exit. */
async function drain(signal: string) {
  if (draining) return;
  draining = true;
  log("info", "draining", { signal, connections });
  const seen = new Set<Socket>();
  for (const set of members.values()) {
    for (const ws of set) {
      if (seen.has(ws)) continue;
      seen.add(ws);
      send(ws, { op: "draining", reconnectInMs: Math.floor(Math.random() * 3000) });
    }
  }
  await Bun.sleep(3500);
  server.stop(true);
  await sql.end({ timeout: 2 });
  sub.disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void drain("SIGINT"));
process.on("SIGTERM", () => void drain("SIGTERM"));
