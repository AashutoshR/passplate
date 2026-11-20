import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { invites, locations, users, type Db } from "@pass/db";
import type { AcceptInviteInput, CreateInviteInput, InvitePreview, InviteView, UserView } from "@pass/shared";
import { toUserView } from "../auth";
import { AppError, isUniqueViolation } from "../errors";
import { sha256 } from "../util";

/**
 * Staff invite links (FR-22). An admin picks a role and gets a link to send.
 * The link holds a random token; only its SHA-256 is stored, it works once,
 * and it expires after seven days.
 */

export const INVITE_DAYS = 7;
type Location = typeof locations.$inferSelect;
type StaffRole = InviteView["role"];

function view(row: typeof invites.$inferSelect, url: string | null): InviteView {
  return {
    id: row.id,
    role: row.role as StaffRole,
    name: row.name,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    url,
  };
}

export async function createInvite(
  db: Db,
  loc: Location,
  input: CreateInviteInput,
  createdBy: string,
  origin: string,
): Promise<InviteView> {
  const token = randomBytes(24).toString("base64url");
  const [row] = await db
    .insert(invites)
    .values({
      locationId: loc.id,
      role: input.role,
      name: input.name || null,
      email: input.email || null,
      tokenHash: sha256(token),
      createdBy,
      expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
    })
    .returning();
  // Shown once. Losing it means making a new invite.
  return view(row!, `${origin}/join/${token}`);
}

export async function pendingInvites(db: Db, loc: Location): Promise<InviteView[]> {
  const rows = await db
    .select()
    .from(invites)
    .where(and(eq(invites.locationId, loc.id), isNull(invites.usedAt), gt(invites.expiresAt, new Date())))
    .orderBy(desc(invites.createdAt));
  return rows.map((r) => view(r, null));
}

export async function revokeInvite(db: Db, loc: Location, id: string): Promise<void> {
  const gone = await db
    .delete(invites)
    .where(and(eq(invites.id, id), eq(invites.locationId, loc.id), isNull(invites.usedAt)))
    .returning({ id: invites.id });
  if (gone.length === 0) throw new AppError(404, "not_found", "That invite was not found");
}

async function liveInvite(db: Db, token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new AppError(404, "invite_not_found", "This invite link is not valid");
  const [row] = await db
    .select({ invite: invites, restaurant: locations.name })
    .from(invites)
    .innerJoin(locations, eq(locations.id, invites.locationId))
    .where(eq(invites.tokenHash, sha256(token)));
  if (!row) throw new AppError(404, "invite_not_found", "This invite link is not valid");
  if (row.invite.usedAt) throw new AppError(410, "invite_used", "This invite has already been used. Ask for a new one.");
  if (row.invite.expiresAt < new Date()) throw new AppError(410, "invite_expired", "This invite has expired. Ask for a new one.");
  return row;
}

export async function previewInvite(db: Db, token: string): Promise<InvitePreview> {
  const { invite, restaurant } = await liveInvite(db, token);
  return { role: invite.role as StaffRole, restaurant, name: invite.name, email: invite.email };
}

/** Creates the account and uses up the invite, in one transaction. */
export async function acceptInvite(db: Db, token: string, input: AcceptInviteInput): Promise<UserView> {
  const { invite } = await liveInvite(db, token);
  if (invite.email && invite.email !== input.email) {
    throw new AppError(422, "email_mismatch", `This invite is for ${invite.email}`);
  }
  const passwordHash = await Bun.password.hash(input.password);
  try {
    return await db.transaction(async (tx) => {
      // Claim the invite first: two people racing on one link cannot both win.
      const claimed = await tx
        .update(invites)
        .set({ usedAt: new Date() })
        .where(and(eq(invites.id, invite.id), isNull(invites.usedAt)))
        .returning({ id: invites.id });
      if (claimed.length === 0) throw new AppError(410, "invite_used", "This invite has already been used. Ask for a new one.");
      const [user] = await tx
        .insert(users)
        .values({ name: input.name, email: input.email, passwordHash, role: invite.role, locationId: invite.locationId })
        .returning();
      await tx.update(invites).set({ usedBy: user!.id }).where(eq(invites.id, invite.id));
      return toUserView(user!);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(409, "email_taken", "Someone already uses that email. Sign in instead.");
    throw err;
  }
}
