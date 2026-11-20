import Redis from "ioredis";
import postgres from "postgres";

/**
 * Outbox relay (NFR-12).
 *
 * Only one relay is active at a time (a Postgres advisory lock elects it), so
 * it can hand out a global, gap-free `seq` in exactly the order events are
 * published. Extra instances wait as hot standbys and take over if it dies.
 *
 * It polls the partial index of unpublished rows every 20 ms, a query that
 * touches only the handful of rows waiting. (A pg_notify per transaction was
 * tried first: Postgres serializes the commit of every notifying transaction
 * on one lock, which capped the whole system under load.) Anyone may still
 * send NOTIFY outbox to wake it early.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://pass:pass@localhost:5433/pass";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";
const LOCK_KEY = 7_242_001;
const BATCH = 500;
const POLL_MS = Number(process.env.RELAY_POLL_MS ?? 20);

const sql = postgres(DATABASE_URL, {
  max: 3,
  onnotice: () => {},
  connection: { application_name: "pass-relay", statement_timeout: 5000 },
});
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false });
redis.on("error", () => {}); // Reconnects on its own; failures are logged where they matter.

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, service: "relay", ...extra }));

let stopping = false;
let wake: (() => void) | null = null;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });

interface Row {
  seq: string;
  channel: string;
  type: string;
  payload: unknown;
  created_at: Date;
}

/** Assigns seq to the next batch in id order and publishes it. Returns how many it sent. */
async function relayBatch(): Promise<number> {
  const rows = await sql.begin(async (tx) => {
    return tx<Row[]>`
      with picked as (
        select id from outbox where seq is null order by id limit ${BATCH} for update
      ),
      numbered as (
        select id, nextval('event_seq') as seq from (select id from picked order by id) p
      )
      update outbox o
      set seq = numbered.seq, published_at = now()
      from numbered
      where o.id = numbered.id
      returning o.seq, o.channel, o.type, o.payload, o.created_at
    `;
  });
  if (rows.length === 0) return 0;

  rows.sort((a, b) => Number(a.seq) - Number(b.seq));
  try {
    const pipe = redis.pipeline();
    // NFR-17: any menu event (stock, sold out, an edit) clears that restaurant's
    // cached menu, and records the seq a cached copy must have reached to be used.
    const menuSeq = new Map<string, number>();
    for (const r of rows) if (r.channel.startsWith("menu:")) menuSeq.set(r.channel.slice(5), Number(r.seq));
    for (const [locationId, seq] of menuSeq) {
      pipe.set(`menu-min-seq:${locationId}`, seq, "EX", 86_400);
      pipe.del(`menu:${locationId}`);
    }
    for (const r of rows) {
      pipe.publish(
        `ev:${r.channel}`,
        JSON.stringify({
          op: "event",
          seq: Number(r.seq),
          channel: r.channel,
          type: r.type,
          payload: r.payload,
          at: r.created_at.toISOString(),
        }),
      );
    }
    await pipe.exec();
  } catch (err) {
    // Events are committed with a seq, so clients still get them by replay
    // from the gateway when they reconnect or poll. Nothing is lost.
    log("warn", "redis publish failed, clients will catch up by replay", { error: String(err) });
  }
  return rows.length;
}

async function run() {
  const lockConn = await sql.reserve();
  log("info", "waiting for relay leadership");
  while (!stopping) {
    const [row] = await lockConn<{ ok: boolean }[]>`select pg_try_advisory_lock(${LOCK_KEY}) as ok`;
    if (row?.ok) break;
    await sleep(2000);
  }
  if (stopping) return;
  log("info", "relay is leader");

  // A notify that lands mid-batch sets `pending`, so the next round starts at once.
  let pending = true;
  await sql.listen("outbox", () => {
    pending = true;
    wake?.();
  });

  while (!stopping) {
    pending = false;
    try {
      let sent: number;
      do {
        sent = await relayBatch();
        if (sent) log("debug", "published", { count: sent });
      } while (sent === BATCH && !stopping);
    } catch (err) {
      log("error", "relay batch failed", { error: String(err) });
      await sleep(1000);
    }
    if (!pending) await sleep(POLL_MS);
  }
  lockConn.release();
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  wake?.();
  setTimeout(async () => {
    await sql.end({ timeout: 2 });
    redis.disconnect();
    process.exit(0);
  }, 300);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

run().catch((err) => {
  log("error", "relay crashed", { error: String(err) });
  process.exit(1);
});
