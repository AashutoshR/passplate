import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export const DEFAULT_DATABASE_URL = "postgres://pass:pass@localhost:5433/pass";

/** PgBouncer in front of Postgres (NFR-14), as started by docker compose. */
export const DEFAULT_POOLED_URL = "postgres://pass:pass@localhost:6433/pass";

export interface DbOptions {
  url?: string;
  /** Connections this process keeps open. */
  max?: number;
  appName?: string;
  /**
   * True when `url` points at PgBouncer in transaction mode. Prepared
   * statements and per-connection settings do not survive there, so both are
   * off; the 5 s statement timeout is set on the database itself instead.
   */
  pooled?: boolean;
}

export function createDb(opts: DbOptions = {}) {
  const sql = postgres(opts.url ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 5,
    prepare: !opts.pooled,
    onnotice: () => {},
    connection: opts.pooled
      ? { application_name: opts.appName ?? "pass" }
      : {
          application_name: opts.appName ?? "pass",
          // No query may hold a connection for long during a rush (NFR-14).
          statement_timeout: 5000,
        },
  });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export type Db = ReturnType<typeof createDb>["db"];
export type Sql = ReturnType<typeof createDb>["sql"];
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run a query: the pool or an open transaction. */
export type Executor = Db | Tx;
