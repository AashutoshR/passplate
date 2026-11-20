/**
 * Starts extra API instances on ports 4001, 4002, ... for load tests, the way
 * production runs several stateless copies behind a load balancer (NFR-1).
 * The local edge (docker compose --profile edge) balances across 4000 to 4004
 * and skips any that are not running.
 *
 * Usage: bun scripts/api-cluster.ts [instances=4]
 * Stop with Ctrl-C. Logs go to var/logs/api-<port>.log.
 */
import { mkdirSync, openSync } from "node:fs";
import { fileURLToPath } from "node:url";

const n = Math.min(4, Math.max(1, Number(process.argv[2] ?? 4)));
const root = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(`${root}var/logs`, { recursive: true });

const procs = Array.from({ length: n }, (_, i) => {
  const port = 4001 + i;
  const log = openSync(`${root}var/logs/api-${port}.log`, "w");
  const p = Bun.spawn(["bun", "apps/api/src/index.ts"], {
    cwd: root,
    env: { ...process.env, API_PORT: String(port) },
    stdout: log,
    stderr: log,
  });
  console.log(`api instance on :${port} (pid ${p.pid})`);
  return p;
});

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.all(procs.map((p) => p.exited));
