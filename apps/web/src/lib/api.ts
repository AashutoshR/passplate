export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Server-side rendering talks to the API directly; browsers go through the same-origin proxy. */
export function apiBase(): string {
  if (typeof window === "undefined") return process.env.API_INTERNAL_URL ?? "http://localhost:4000";
  return "/api";
}

export async function api<T>(
  path: string,
  init: Omit<RequestInit, "body"> & { json?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const { json, headers, timeoutMs = 10_000, ...rest } = init;
  const res = await fetch(apiBase() + path, {
    ...rest,
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy error page, not our API. Treat it as a server problem.
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "http_error", e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

/** Network failures and 5xx are worth retrying; 4xx answers are final. */
export function isRetryable(err: unknown): boolean {
  return !(err instanceof ApiError) || err.status >= 500 || err.status === 429;
}
