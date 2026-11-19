import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/** An error that is safe to show to the caller. Anything else becomes a 500. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      400,
      "invalid_request",
      "The request is not valid",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

/** Postgres unique violation. */
export function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  // Drizzle wraps driver errors; walk the cause chain.
  for (let i = 0; i < 4 && e; i++) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
