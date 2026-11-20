import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { locations, type Db } from "@pass/db";
import {
  AcceptInviteSchema,
  CategoryInputSchema,
  CreateInviteSchema,
  ItemInputSchema,
  ReorderSchema,
  AvailabilityQuerySchema,
  BookTableSchema,
  CreateStaffSchema,
  AssignSchema,
  DeliveredSchema,
  DriverLocationSchema,
  LoginSchema,
  ReceiptSearchSchema,
  ShiftSchema,
  ORDER_TYPES,
  PAYMENT_METHODS,
  RegisterSchema,
  ReservationActionSchema,
  SeatWalkInSchema,
  SettleSchema,
  WaitlistAddSchema,
  isStaffRole,
  localDate,
  zonedTime,
  type AccountView,
  type OrderType,
  type PaymentMethod,
} from "@pass/shared";
import {
  clearThrottle,
  dummyPasswordHash,
  endSession,
  requireRole,
  requireUser,
  startSession,
  throttleLogin,
  toUserView,
  type AuthEnv,
} from "./auth";
import { AppError, parse } from "./errors";
import {
  createStaff,
  findByEmail,
  listGuests,
  listStaff,
  myOrders,
  myReservations,
  register,
  removeStaff,
  rewardsFor,
} from "./services/accounts";
import { adminOverview } from "./services/admin";
import { availability, bookTable, changeReservation, maskPhone, reservationByCode } from "./services/booking";
import {
  assignDelivery,
  completeDelivery,
  dispatchBoard,
  driverBoard,
  setShift,
  takeDelivery,
  updateDriverLocation,
} from "./services/delivery";
import { straightRoutes, type RoutesProvider } from "./services/maps";
import { dayReport, markPrinted, searchReceipts, staffReceipt, staffReceiptForOrder } from "./services/receipts";
import { addToWaitlist, clearTable, floorSnapshot, leaveWaitlist, seatTable, settleTable } from "./services/floor";
import { adminRefund, listTransactions } from "./services/payments";
import type { PaymentsConfig } from "./services/checkout";
import { acceptInvite, createInvite, pendingInvites, previewInvite, revokeInvite } from "./services/invites";
import { saveUpload } from "./services/media";
import {
  adminMenu,
  archiveCategory,
  createCategory,
  createItem,
  reorderCategories,
  reorderItems,
  setItemArchived,
  updateCategory,
  updateItem,
} from "./services/menu-admin";
import { UUID_PATTERN } from "./util";

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError(400, "invalid_json", "The request body must be JSON");
  }
}

function uuidParam(c: Context, name: string): string {
  const v = c.req.param(name) ?? "";
  if (!UUID_PATTERN.test(v)) throw new AppError(404, "not_found", "Not found");
  return v;
}

/** Accounts: sign up, sign in, sign out, and what a signed-in guest sees. */
export function accountRoutes(db: Db) {
  const r = new Hono<AuthEnv>();

  r.post("/register", async (c) => {
    const body = parse(RegisterSchema, await readJson(c));
    const user = await register(db, body);
    await startSession(db, c, user.id);
    return c.json({ user, rewards: await rewardsFor(db, user.id) } satisfies AccountView, 201);
  });

  r.post("/login", async (c) => {
    const body = parse(LoginSchema, await readJson(c));
    const ip = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "local";
    const key = `${ip}:${body.email}`;
    throttleLogin(key);
    const row = await findByEmail(db, body.email);
    const ok = await Bun.password.verify(body.password, row?.passwordHash ?? (await dummyPasswordHash()));
    if (!row || !ok) throw new AppError(401, "bad_credentials", "That email and password do not match");
    clearThrottle(key);
    await startSession(db, c, row.id);
    const user = toUserView(row);
    return c.json({ user, rewards: user.role === "customer" ? await rewardsFor(db, user.id) : null } satisfies AccountView);
  });

  r.post("/logout", async (c) => {
    await endSession(db, c);
    return c.json({ ok: true });
  });

  r.get("/me", async (c) => {
    c.header("Cache-Control", "no-store");
    const user = c.get("user");
    if (!user) return c.json({ user: null, rewards: null });
    const { sessionId: _, ...view } = user;
    return c.json({ user: view, rewards: user.role === "customer" ? await rewardsFor(db, user.id) : null });
  });

  r.get("/orders", async (c) => {
    const user = requireUser(c);
    c.header("Cache-Control", "no-store");
    return c.json({ orders: await myOrders(db, user.id), rewards: await rewardsFor(db, user.id) });
  });

  r.get("/reservations", async (c) => {
    const user = requireUser(c);
    c.header("Cache-Control", "no-store");
    return c.json({ reservations: await myReservations(db, user.id) });
  });

  return r;
}

/** Public booking: live availability, book, look up and cancel by reference. */
export function bookingRoutes(db: Db) {
  const r = new Hono<AuthEnv>();

  r.get("/locations/:slug/availability", async (c) => {
    const q = parse(AvailabilityQuerySchema, { date: c.req.query("date"), party: c.req.query("party") });
    c.header("Cache-Control", "no-store");
    return c.json(await availability(db, c.req.param("slug"), q.date, q.party));
  });

  r.post("/reservations", async (c) => {
    const body = parse(BookTableSchema, await readJson(c));
    const user = c.get("user");
    const view = await bookTable(db, body, { userId: user?.role === "customer" ? user.id : null });
    return c.json(view, 201);
  });

  r.get("/reservations/:code", async (c) => {
    c.header("Cache-Control", "no-store");
    const view = await reservationByCode(db, c.req.param("code"));
    return c.json({ ...view, phone: maskPhone(view.phone), email: null });
  });

  r.post("/reservations/:code/cancel", async (c) => {
    const view = await changeReservation(db, { code: c.req.param("code") }, "cancelled");
    return c.json({ ...view, phone: maskPhone(view.phone), email: null });
  });

  return r;
}

/** Staff invite links (FR-22): look one up, then accept it with a name and password. */
export function inviteRoutes(db: Db) {
  const r = new Hono<AuthEnv>();
  r.get("/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await previewInvite(db, c.req.param("token")));
  });
  r.post("/:token/accept", async (c) => {
    const body = parse(AcceptInviteSchema, await readJson(c));
    const user = await acceptInvite(db, c.req.param("token"), body);
    await startSession(db, c, user.id);
    return c.json({ user, rewards: null } satisfies AccountView, 201);
  });
  return r;
}

/** Everything behind a staff sign-in: the floor, deliveries and the admin screens. */
export function staffRoutes(
  db: Db,
  opts: { payments: PaymentsConfig; publicOrigin: string; uploadDir?: string; routes?: RoutesProvider } = {
    payments: { provider: "test" },
    publicOrigin: "http://localhost:3000",
  },
) {
  const routes = opts.routes ?? straightRoutes;
  const r = new Hono<AuthEnv>();

  async function myLocation(c: Context<AuthEnv>, roles: ("staff" | "driver" | "admin")[]) {
    const user = requireRole(c, roles);
    if (!user.locationId) throw new AppError(403, "forbidden", "Your account is not linked to a restaurant");
    const [loc] = await db.select().from(locations).where(eq(locations.id, user.locationId));
    if (!loc) throw new AppError(404, "location_not_found", "Restaurant not found");
    return { user, loc };
  }

  // The floor plan and the waitlist.
  r.get("/floor", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    c.header("Cache-Control", "no-store");
    return c.json(await floorSnapshot(db, loc));
  });
  r.post("/floor/seat", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    return c.json(await seatTable(db, loc, parse(SeatWalkInSchema, await readJson(c))));
  });
  r.post("/floor/tables/:id/settle", async (c) => {
    const { loc, user } = await myLocation(c, ["staff", "admin"]);
    const body = parse(SettleSchema, await readJson(c));
    return c.json(await settleTable(db, loc, uuidParam(c, "id"), body.method, user.id));
  });
  r.post("/floor/tables/:id/clear", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    return c.json(await clearTable(db, loc, uuidParam(c, "id")));
  });
  r.post("/floor/waitlist", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    return c.json(await addToWaitlist(db, loc, parse(WaitlistAddSchema, await readJson(c))), 201);
  });
  r.delete("/floor/waitlist/:id", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    return c.json(await leaveWaitlist(db, loc, uuidParam(c, "id")));
  });
  r.post("/floor/reservations/:id", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    const body = parse(ReservationActionSchema, await readJson(c));
    return c.json(
      await changeReservation(db, { id: uuidParam(c, "id"), locationId: loc.id }, body.action === "cancel" ? "cancelled" : "no_show"),
    );
  });
  // Phone bookings taken by staff. No lead time: they can fit someone in tonight.
  r.post("/floor/reservations", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    const body = parse(BookTableSchema, { ...((await readJson(c)) as object), locationSlug: loc.slug });
    return c.json(await bookTable(db, body, { source: "phone", skipLead: true }), 201);
  });

  // Drivers.
  r.get("/driver", async (c) => {
    const { loc, user } = await myLocation(c, ["driver", "admin"]);
    c.header("Cache-Control", "no-store");
    return c.json(await driverBoard(db, loc, user.id));
  });
  r.post("/driver/shift", async (c) => {
    const { loc, user } = await myLocation(c, ["driver"]);
    return c.json(await setShift(db, loc, user, parse(ShiftSchema, await readJson(c)).on));
  });
  r.post("/driver/orders/:id/take", async (c) => {
    const { loc, user } = await myLocation(c, ["driver", "admin"]);
    return c.json(await takeDelivery(db, loc, uuidParam(c, "id"), user, routes));
  });
  r.post("/driver/orders/:id/delivered", async (c) => {
    const { loc, user } = await myLocation(c, ["driver", "admin"]);
    // An empty body is an old client: handed over in person.
    const text = await c.req.text();
    let raw: unknown = { proof: "handed_over" };
    if (text) {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new AppError(400, "invalid_json", "The request body must be JSON");
      }
    }
    const proof = parse(DeliveredSchema, raw);
    return c.json(await completeDelivery(db, loc, uuidParam(c, "id"), user, proof));
  });
  r.post("/driver/orders/:id/location", async (c) => {
    const { loc, user } = await myLocation(c, ["driver", "admin"]);
    const body = parse(DriverLocationSchema, await readJson(c));
    return c.json(await updateDriverLocation(db, loc, uuidParam(c, "id"), user.id, body));
  });

  // Dispatch (FR-14, FR-15): front of house and admins watch and assign deliveries.
  r.get("/dispatch", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    c.header("Cache-Control", "no-store");
    return c.json(await dispatchBoard(db, loc));
  });
  r.post("/dispatch/orders/:id/assign", async (c) => {
    const { loc, user } = await myLocation(c, ["staff", "admin"]);
    const body = parse(AssignSchema, await readJson(c));
    return c.json(await assignDelivery(db, loc, uuidParam(c, "id"), body.driverId, user));
  });

  // Receipts: reprint for a guest, find one, and the end-of-day report.
  r.get("/receipts", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    const raw = c.req.query("q")?.trim();
    const q = raw ? parse(ReceiptSearchSchema, { q: raw }).q : "";
    c.header("Cache-Control", "no-store");
    return c.json(await searchReceipts(db, loc, q));
  });
  r.get("/receipts/day", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    c.header("Cache-Control", "no-store");
    return c.json(await dayReport(db, loc, c.req.query("date") || undefined));
  });
  r.get("/receipts/order/:id", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    c.header("Cache-Control", "no-store");
    return c.json(await staffReceiptForOrder(db, loc, uuidParam(c, "id")));
  });
  r.get("/receipts/:id", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    c.header("Cache-Control", "no-store");
    return c.json(await staffReceipt(db, loc, uuidParam(c, "id")));
  });
  r.post("/receipts/:id/printed", async (c) => {
    const { loc } = await myLocation(c, ["staff", "admin"]);
    return c.json(await markPrinted(db, loc, uuidParam(c, "id")));
  });

  // Admin.
  r.get("/admin/overview", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    c.header("Cache-Control", "no-store");
    return c.json(await adminOverview(db, loc));
  });
  r.get("/admin/transactions", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    const date = (q: string | undefined) => (q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : undefined);
    const today = localDate(loc.timezone);
    const fromDate = date(c.req.query("from")) ?? today;
    const toDate = date(c.req.query("to")) ?? fromDate;
    const method = c.req.query("method") as PaymentMethod | undefined;
    const type = c.req.query("type") as OrderType | undefined;
    c.header("Cache-Control", "no-store");
    return c.json(
      await listTransactions(db, loc, {
        from: zonedTime(fromDate, "00:00", loc.timezone),
        to: new Date(zonedTime(toDate, "00:00", loc.timezone).getTime() + 86_400_000),
        method: method && PAYMENT_METHODS.includes(method) ? method : undefined,
        type: type && ORDER_TYPES.includes(type) ? type : undefined,
      }),
    );
  });
  r.post("/admin/orders/:id/refund", async (c) => {
    const { loc, user } = await myLocation(c, ["admin"]);
    return c.json(await adminRefund(db, loc, uuidParam(c, "id"), user.id, opts.payments));
  });
  r.get("/admin/staff", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json({ staff: await listStaff(db, loc.id) });
  });
  r.post("/admin/staff", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json(await createStaff(db, loc.id, parse(CreateStaffSchema, await readJson(c))), 201);
  });
  r.delete("/admin/staff/:id", async (c) => {
    const { loc, user } = await myLocation(c, ["admin"]);
    await removeStaff(db, loc.id, uuidParam(c, "id"), user.id);
    return c.json({ ok: true });
  });
  // Staff invites (FR-22).
  r.get("/admin/invites", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    c.header("Cache-Control", "no-store");
    return c.json({ invites: await pendingInvites(db, loc) });
  });
  r.post("/admin/invites", async (c) => {
    const { loc, user } = await myLocation(c, ["admin"]);
    return c.json(await createInvite(db, loc, parse(CreateInviteSchema, await readJson(c)), user.id, opts.publicOrigin), 201);
  });
  r.delete("/admin/invites/:id", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    await revokeInvite(db, loc, uuidParam(c, "id"));
    return c.json({ ok: true });
  });

  // The menu editor (FR-1).
  r.get("/admin/menu", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    c.header("Cache-Control", "no-store");
    return c.json(await adminMenu(db, loc));
  });
  r.post("/admin/menu/categories", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json(await createCategory(db, loc, parse(CategoryInputSchema, await readJson(c))), 201);
  });
  r.post("/admin/menu/categories/order", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json(await reorderCategories(db, loc, parse(ReorderSchema, await readJson(c)).ids));
  });
  r.patch("/admin/menu/categories/:id", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json(await updateCategory(db, loc, uuidParam(c, "id"), parse(CategoryInputSchema, await readJson(c))));
  });
  r.delete("/admin/menu/categories/:id", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json(await archiveCategory(db, loc, uuidParam(c, "id")));
  });
  r.post("/admin/menu/categories/:id/order", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json(await reorderItems(db, loc, uuidParam(c, "id"), parse(ReorderSchema, await readJson(c)).ids));
  });
  r.post("/admin/menu/items", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json(await createItem(db, loc, parse(ItemInputSchema, await readJson(c))), 201);
  });
  r.put("/admin/menu/items/:id", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json(await updateItem(db, loc, uuidParam(c, "id"), parse(ItemInputSchema, await readJson(c))));
  });
  r.delete("/admin/menu/items/:id", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json(await setItemArchived(db, loc, uuidParam(c, "id"), true));
  });
  r.post("/admin/menu/items/:id/restore", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json(await setItemArchived(db, loc, uuidParam(c, "id"), false));
  });
  r.post("/admin/menu/photos", async (c) => {
    await myLocation(c, ["admin"]);
    const form = await c.req.formData().catch(() => {
      throw new AppError(400, "invalid_form", "Send the photo as multipart form data");
    });
    const file = form.get("photo");
    if (!(file instanceof File)) throw new AppError(400, "no_file", "Choose a photo to upload");
    return c.json(await saveUpload(file, opts.uploadDir), 201);
  });

  r.get("/admin/guests", async (c) => {
    const { loc } = await myLocation(c, ["admin"]);
    return c.json({ guests: await listGuests(db, loc.id) });
  });

  r.get("/whoami", (c) => {
    const user = requireUser(c);
    if (!isStaffRole(user.role)) throw new AppError(403, "forbidden", "Staff only");
    return c.json({ user });
  });

  return r;
}
