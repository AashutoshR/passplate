import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ORDER_STATUSES,
  ORDER_TYPES,
  PAYMENT_METHODS,
  RESERVATION_STATUSES,
  TABLE_SHAPES,
  USER_ROLES,
  type OpeningHours,
} from "@pass/shared";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const orderType = pgEnum("order_type", ORDER_TYPES);
export const orderStatus = pgEnum("order_status", ORDER_STATUSES);
export const userRole = pgEnum("user_role", USER_ROLES);
export const paymentMethod = pgEnum("payment_method", PAYMENT_METHODS);
export const paymentKind = pgEnum("payment_kind", ["payment", "refund"]);
export const reservationStatus = pgEnum("reservation_status", RESERVATION_STATUSES);
export const reservationSource = pgEnum("reservation_source", ["online", "phone", "walk_in"]);
export const tableState = pgEnum("table_state", ["free", "seated", "clearing"]);
export const tableShape = pgEnum("table_shape", TABLE_SHAPES);
export const waitlistStatus = pgEnum("waitlist_status", ["waiting", "seated", "left"]);

/** Global, gap-free event order, assigned by the single outbox relay. */
export const eventSeq = pgSequence("event_seq", { startWith: 1, increment: 1 });

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Europe/London"),
  currency: text("currency").notNull().default("GBP"),
  openingHours: jsonb("opening_hours").$type<OpeningHours>().notNull(),
  /** When tables can be booked. Ordering follows openingHours. */
  bookingHours: jsonb("booking_hours").$type<OpeningHours>().notNull().default({}),
  lat: doublePrecision("lat").notNull().default(51.4495),
  lng: doublePrecision("lng").notNull().default(-2.5967),
  targetPrepSeconds: integer("target_prep_seconds").notNull().default(900),
  nextOrderNumber: integer("next_order_number").notNull().default(1),
  /** SHA-256 of the kitchen device code. Replaced by staff accounts in Milestone 4. */
  kitchenTokenHash: text("kitchen_token_hash").notNull(),
  createdAt: createdAt(),
});

export const diningTables = pgTable(
  "dining_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    label: text("label").notNull(),
    qrToken: text("qr_token").notNull().unique(),
    seats: integer("seats").notNull().default(2),
    area: text("area").notNull().default("Main room"),
    shape: tableShape("shape").notNull().default("square"),
    /** Position on the floor plan, in a 1000 x 640 grid. */
    x: integer("x").notNull().default(0),
    y: integer("y").notNull().default(0),
    w: integer("w").notNull().default(80),
    h: integer("h").notNull().default(80),
    /** What staff set by hand. Reserved, ordered and eating are worked out from bookings and orders. */
    state: tableState("state").notNull().default("free"),
    seatedAt: timestamp("seated_at", { withTimezone: true }),
    seatedParty: integer("seated_party"),
    seatedName: text("seated_name"),
    reservationId: uuid("reservation_id"),
  },
  (t) => [index("dining_tables_location_idx").on(t.locationId)],
);

export const menuCategories = pgTable(
  "menu_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    name: text("name").notNull(),
    /** One line under the section heading on the menu. */
    blurb: text("blurb"),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("menu_categories_location_idx").on(t.locationId, t.position)],
);

export const menuItems = pgTable(
  "menu_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => menuCategories.id),
    name: text("name").notNull(),
    description: text("description"),
    priceMinor: integer("price_minor").notNull(),
    allergens: text("allergens").array().notNull().default(sql`'{}'::text[]`),
    /** v, vg, gf, spicy. */
    dietary: text("dietary").array().notNull().default(sql`'{}'::text[]`),
    /** Public path of the dish photograph, if there is one. */
    image: text("image"),
    /** Shown among the signature plates on the home page. */
    featured: boolean("featured").notNull().default(false),
    /** null means unlimited. */
    stock: integer("stock"),
    soldOut: boolean("sold_out").notNull().default(false),
    position: integer("position").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [index("menu_items_location_idx").on(t.locationId, t.position)],
);

export const modifierGroups = pgTable(
  "modifier_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => menuItems.id),
    name: text("name").notNull(),
    minSelect: integer("min_select").notNull().default(0),
    maxSelect: integer("max_select").notNull().default(1),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("modifier_groups_item_idx").on(t.itemId)],
);

export const modifiers = pgTable(
  "modifiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => modifierGroups.id),
    name: text("name").notNull(),
    priceDeltaMinor: integer("price_delta_minor").notNull().default(0),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("modifiers_group_idx").on(t.groupId)],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    number: integer("number").notNull(),
    type: orderType("type").notNull(),
    tableId: uuid("table_id").references(() => diningTables.id),
    customerName: text("customer_name").notNull(),
    userId: uuid("user_id").references(() => users.id),
    phone: text("phone"),
    status: orderStatus("status").notNull().default("received"),
    version: integer("version").notNull().default(1),
    subtotalMinor: integer("subtotal_minor").notNull(),
    discountMinor: integer("discount_minor").notNull().default(0),
    deliveryFeeMinor: integer("delivery_fee_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull().default(0),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    deliveryLine1: text("delivery_line1"),
    deliveryPostcode: text("delivery_postcode"),
    deliveryLat: doublePrecision("delivery_lat"),
    deliveryLng: doublePrecision("delivery_lng"),
    deliveryInstructions: text("delivery_instructions"),
    driverId: uuid("driver_id").references(() => users.id),
    driverLat: doublePrecision("driver_lat"),
    driverLng: doublePrecision("driver_lng"),
    driverAt: timestamp("driver_at", { withTimezone: true }),
    currency: text("currency").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("orders_location_idempotency_uq").on(t.locationId, t.idempotencyKey),
    index("orders_location_status_idx").on(t.locationId, t.status),
    index("orders_location_created_idx").on(t.locationId, t.createdAt),
    index("orders_user_idx").on(t.userId),
    index("orders_table_idx").on(t.tableId),
  ],
);

export interface OrderItemModifier {
  id: string;
  name: string;
  priceDeltaMinor: number;
}

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItems.id),
    /** Name and price are copied so later menu edits never change past orders. */
    name: text("name").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    modifiers: jsonb("modifiers").$type<OrderItemModifier[]>().notNull().default([]),
    notes: text("notes"),
    lineTotalMinor: integer("line_total_minor").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

/** Audit trail of every status change: who, when, from which device (FR-11). */
export const orderTransitions = pgTable(
  "order_transitions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    fromStatus: orderStatus("from_status").notNull(),
    toStatus: orderStatus("to_status").notNull(),
    actor: text("actor").notNull(),
    device: text("device"),
    /** Client generated. Makes offline replays idempotent (FR-13). */
    actionId: uuid("action_id").notNull().unique(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("order_transitions_order_idx").on(t.orderId)],
);

/**
 * Transactional outbox (NFR-12). Rows are written in the same transaction as
 * the change they describe. The relay assigns `seq` and publishes to Redis.
 * Published rows are kept for replay to reconnecting clients (NFR-7).
 */
export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    seq: bigint("seq", { mode: "number" }).unique(),
    tenantId: uuid("tenant_id").notNull(),
    channel: text("channel").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    index("outbox_unpublished_idx").on(t.id).where(sql`${t.seq} is null`),
    index("outbox_channel_seq_idx").on(t.channel, t.seq),
  ],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  phone: text("phone"),
  /** Argon2id hash from Bun.password. */
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("customer"),
  locationId: uuid("location_id").references(() => locations.id),
  createdAt: createdAt(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

/** Server-side sessions. The cookie holds a random token; only its SHA-256 is stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** One row per reward earned. Spending it links the order it was used on. */
export const rewards = pgTable(
  "rewards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    earnedOrderId: uuid("earned_order_id")
      .notNull()
      .unique()
      .references(() => orders.id),
    redeemedOrderId: uuid("redeemed_order_id")
      .unique()
      .references(() => orders.id),
    createdAt: createdAt(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  },
  (t) => [index("rewards_user_idx").on(t.userId)],
);

/** Money in and out. A refund is its own row of kind refund, never an edit. */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    kind: paymentKind("kind").notNull().default("payment"),
    method: paymentMethod("method").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    takenBy: uuid("taken_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("payments_location_created_idx").on(t.locationId, t.createdAt),
    index("payments_order_idx").on(t.orderId),
  ],
);

export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    tableId: uuid("table_id").references(() => diningTables.id),
    userId: uuid("user_id").references(() => users.id),
    /** Short reference the guest can quote on the phone. */
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    partySize: integer("party_size").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: reservationStatus("status").notNull().default("booked"),
    source: reservationSource("source").notNull().default("online"),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("reservations_location_starts_idx").on(t.locationId, t.startsAt),
    index("reservations_user_idx").on(t.userId),
  ],
);

export const waitlist = pgTable(
  "waitlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id),
    name: text("name").notNull(),
    partySize: integer("party_size").notNull(),
    phone: text("phone"),
    quotedMinutes: integer("quoted_minutes").notNull().default(20),
    status: waitlistStatus("status").notNull().default("waiting"),
    tableId: uuid("table_id").references(() => diningTables.id),
    createdAt: createdAt(),
    seatedAt: timestamp("seated_at", { withTimezone: true }),
  },
  (t) => [index("waitlist_location_status_idx").on(t.locationId, t.status)],
);
