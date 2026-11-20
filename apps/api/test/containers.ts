import { runMigrations } from "@pass/db";

/**
 * TEST-2: integration tests run against real Postgres and Redis started by
 * Testcontainers, one pair per `bun test` run, thrown away afterwards (the
 * Testcontainers reaper removes them even if the run is killed).
 *
 * Set TEST_DATABASE_URL (and TEST_REDIS_URL) to use servers you already have
 * instead, for example the pass_test database in docker compose.
 */

type Shared = { db?: Promise<string>; redis?: Promise<string> };
const shared = ((globalThis as { __passContainers?: Shared }).__passContainers ??= {});

export function testDatabaseUrl(): Promise<string> {
  shared.db ??= (async () => {
    let url = process.env.TEST_DATABASE_URL;
    if (!url) {
      const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
      const started = Date.now();
      const pg = await new PostgreSqlContainer("postgres:17-alpine")
        .withDatabase("pass")
        .withUsername("pass")
        .withPassword("pass")
        .withCommand(["postgres", "-c", "max_connections=200", "-c", "fsync=off"])
        .start();
      url = pg.getConnectionUri();
      console.log(`Testcontainers: Postgres ready in ${Date.now() - started} ms`);
    }
    await runMigrations(url);
    return url;
  })();
  return shared.db;
}

export function testRedisUrl(): Promise<string> {
  shared.redis ??= (async () => {
    if (process.env.TEST_REDIS_URL) return process.env.TEST_REDIS_URL;
    const { RedisContainer } = await import("@testcontainers/redis");
    const redis = await new RedisContainer("redis:7-alpine").start();
    return redis.getConnectionUrl();
  })();
  return shared.redis;
}
