import { randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { and, eq, gt } from "drizzle-orm";
import { sessions, users, type Db } from "@pass/db";
import type { UserRole, UserView } from "@pass/shared";
import { AppError } from "./errors";
import { sha256 } from "./util";

export const SESSION_COOKIE = "pp_session";
const SESSION_DAYS = 30;

export interface SessionUser extends UserView {
  sessionId: string;
}

export type AuthEnv = { Variables: { requestId: string; user: SessionUser | null } };

export function toUserView(u: typeof users.$inferSelect): UserView {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, locationId: u.locationId };
}

/** Creates a session and sets the cookie. The token never touches the database in the clear. */
export async function startSession(db: Db, c: Context, userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({
    userId,
    tokenHash: sha256(token),
    userAgent: c.req.header("User-Agent")?.slice(0, 200) ?? null,
    expiresAt,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
  });
}

export async function endSession(db: Db, c: Context): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function userForToken(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  const [row] = await db
    .select({ user: users, sessionId: sessions.id })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
  return row ? { ...toUserView(row.user), sessionId: row.sessionId } : null;
}

/** Reads the session cookie on every request. Never rejects: routes decide what they need. */
export function loadUser(db: Db): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    c.set("user", await userForToken(db, getCookie(c, SESSION_COOKIE)));
    await next();
  };
}

export function requireUser(c: Context<AuthEnv>): SessionUser {
  const user = c.get("user");
  if (!user) throw new AppError(401, "signed_out", "Please sign in");
  return user;
}

/** Staff of a given location, or an admin. Drivers only where `roles` allows them. */
export function requireRole(c: Context<AuthEnv>, roles: UserRole[], locationId?: string): SessionUser {
  const user = requireUser(c);
  if (!roles.includes(user.role)) throw new AppError(403, "forbidden", "You do not have access to this");
  if (locationId && user.locationId !== locationId) throw new AppError(403, "forbidden", "You work at another location");
  return user;
}

/**
 * Login throttle: ten tries per address and email in fifteen minutes. In
 * memory, which is enough for one API process; Redis takes over with more.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
export function throttleLogin(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return;
  }
  entry.count++;
  if (entry.count > 10) {
    throw new AppError(429, "too_many_attempts", "Too many sign-in attempts. Try again in a few minutes.");
  }
}
export function clearThrottle(key: string): void {
  attempts.delete(key);
}

/** Verified against when the email is unknown, so both cases take the same time. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= Bun.password.hash("not-a-real-password-" + randomBytes(8).toString("hex"));
  return dummyHash;
}
