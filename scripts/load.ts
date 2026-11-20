/**
 * Runs a k6 load test (load/orders.js) in Docker.
 *
 *   (default)   against the dev API on :4000
 *   --edge      through the local CDN edge on :8080
 *   --cluster   against the API containers (docker compose --profile cluster),
 *               from inside Docker's network: the production shape, and the
 *               one the README's numbers come from
 *
 * Usage: bun scripts/load.ts <smoke|design|spike|soak|stress|rate> [--edge|--cluster] [--duration 10m] [--rate 80] [--no-seed]
 *
 * Reseeds the database first (bun run db:seed --empty) unless --no-seed.
 *
 * Start the API with RATE_LIMIT=off first. Results land in load/results/.
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scenario = process.argv[2] ?? "smoke";
if (!["smoke", "design", "spike", "soak", "stress", "rate"].includes(scenario)) {
  console.error("Pick a scenario: smoke, design, spike, soak, stress or rate (with --rate N)");
  process.exit(1);
}
const edge = process.argv.includes("--edge");
const cluster = process.argv.includes("--cluster");
const di = process.argv.indexOf("--duration");
const duration = di > 0 ? process.argv[di + 1] : undefined;
const ri = process.argv.indexOf("--rate");
const rate = ri > 0 ? process.argv[ri + 1] : undefined;
const dir = fileURLToPath(new URL("../load/", import.meta.url));
mkdirSync(`${dir}results`, { recursive: true });

const args = [
  "run",
  "--rm",
  "-i",
  ...(cluster ? ["--network", "pass_default"] : ["--add-host", "host.docker.internal:host-gateway"]),
  "-v",
  `${dir}:/load`,
  "grafana/k6:2.3.0",
  "run",
  "--quiet",
  "-e",
  `SCENARIO=${scenario}`,
  "-e",
  // Through the edge, API paths live under /api, as they do for browsers.
  `BASE=${cluster ? "http://edge-cluster/api" : edge ? "http://host.docker.internal:8080/api" : "http://host.docker.internal:4000"}`,
  ...(duration ? ["-e", `DURATION=${duration}`] : []),
  ...(rate ? ["-e", `RATE=${rate}`] : []),
  "/load/orders.js",
];
// Every run starts from a freshly seeded restaurant, so runs compare fairly.
if (!process.argv.includes("--no-seed")) {
  const seed = Bun.spawn(["bun", "run", "db:seed", "--", "--empty"], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdout: "ignore", stderr: "inherit" });
  if ((await seed.exited) !== 0) process.exit(1);
  // A reseed gives every dish a new id but is not a menu edit, so nothing
  // clears the cached menus. Do it here.
  await Bun.spawn(["docker", "exec", "pass-redis-1", "sh", "-c", "redis-cli --scan --pattern 'menu*' | xargs -r redis-cli del"], { stdout: "ignore" }).exited;
}
const proc = Bun.spawn(["docker", ...args], { stdout: "inherit", stderr: "inherit" });
process.exit(await proc.exited);
