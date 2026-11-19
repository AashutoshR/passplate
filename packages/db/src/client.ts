import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export const DEFAULT_DATABASE_URL = "postgres://pass:pass@localhost:5433/pass";

export interface DbOptions {
  url?: string;
  /** Pool size per process. Keep it small: PgBouncer arrives in Milestone 5 (NFR-14). */
  max?: number;
  appName?: string;
}

export function createDb(opts: DbOptions = {}) {
  const sql = postgres(opts.url ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 5,
    onnotice: () => {},
    connection: {
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
