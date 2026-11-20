import type { OpeningHours } from "./hours";
import type { OrderStatus, OrderType } from "./schemas";
import type { DeliveryProof } from "./delivery";

/** One order as the kitchen and the diner see it. */
export interface TicketView {
  id: string;
  number: number;
  type: OrderType;
  status: OrderStatus;
  version: number;
  customerName: string;
  tableLabel: string | null;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  paid: boolean;
  /** Set while a collect or delivery order waits for its payment. */
  payment: { provider: PaymentProvider; expiresAt: string } | null;
  createdAt: string;
  updatedAt: string;
  items: TicketItemView[];
  delivery: {
    line1: string;
    postcode: string;
    lat: number;
    lng: number;
    instructions: string | null;
    phone: string | null;
    driverId: string | null;
    driverName: string | null;
    driver: { lat: number; lng: number; at: string } | null;
    /** A dispatcher gave it to a driver, before it left the kitchen. */
    assignedAt: string | null;
    pickedUpAt: string | null;
    deliveredAt: string | null;
    /** The driver came within 200 m (FR-18). */
    arrivingAt: string | null;
    etaAt: string | null;
    /** The road route, fetched once when the driver set off (NFR-20). */
    route: { provider: "google" | "straight"; polyline: string | null; distanceM: number; durationS: number } | null;
    proof: { kind: DeliveryProof; note: string | null; lat: number | null; lng: number | null; distanceM: number | null } | null;
  } | null;
  /** The receipt for this order, once the worker has written it. */
  receipt: { id: string; number: number } | null;
}

export interface TicketItemView {
  name: string;
  quantity: number;
  modifiers: string[];
  notes: string | null;
  lineTotalMinor: number;
}

export interface ModifierView {
  id: string;
  name: string;
  priceDeltaMinor: number;
}

export interface ModifierGroupView {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  modifiers: ModifierView[];
}

export interface MenuItemView {
  id: string;
  name: string;
  description: string | null;
  priceMinor: number;
  allergens: string[];
  /** v (vegetarian), vg (vegan), gf (gluten free), spicy. */
  dietary: string[];
  /** Public path of the dish photograph, or null. */
  image: string | null;
  /** A signature plate, shown on the home page. */
  featured: boolean;
  /** null means unlimited. */
  stock: number | null;
  soldOut: boolean;
  modifierGroups: ModifierGroupView[];
}

export const DIETARY_LABELS: Record<string, string> = {
  v: "Vegetarian",
  vg: "Vegan",
  gf: "Gluten free",
  spicy: "Spicy",
};

export interface MenuView {
  location: {
    id: string;
    slug: string;
    name: string;
    currency: string;
    timezone: string;
    openingHours: OpeningHours;
    isOpen: boolean;
    lat: number;
    lng: number;
  };
  categories: { id: string; name: string; blurb: string | null; image: string | null; items: MenuItemView[] }[];
  /** Realtime sequence the snapshot is consistent with. Subscribe with since = seq. */
  seq: number;
}

export interface StockChange {
  id: string;
  stock: number | null;
  soldOut: boolean;
}

export interface KitchenSnapshot {
  location: { id: string; slug: string; name: string; targetPrepSeconds: number; currency: string };
  tickets: TicketView[];
  seq: number;
}

export function isAvailable(item: Pick<MenuItemView, "stock" | "soldOut">): boolean {
  return !item.soldOut && (item.stock === null || item.stock > 0);
}

/**
 * Who takes online payments. "stripe" uses Stripe test mode when keys are set;
 * "test" is a built-in stand-in so the whole flow runs with no account.
 */
export const PAYMENT_PROVIDERS = ["test", "stripe"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

/** What the payment screen needs. Card details go straight to Stripe, never to us. */
export interface PaymentStartView {
  provider: PaymentProvider;
  amountMinor: number;
  currency: string;
  expiresAt: string;
  /** Stripe only. */
  clientSecret: string | null;
  publishableKey: string | null;
}

/** One dish in the shared table cart (FR-4), with who added it. */
export interface CartLineView {
  id: string;
  menuItemId: string;
  name: string;
  quantity: number;
  modifierIds: string[];
  modifierNames: string[];
  unitPriceMinor: number;
  notes: string | null;
  addedBy: string;
  createdAt: string;
}

export interface CartView {
  cartId: string;
  tableLabel: string;
  version: number;
  lines: CartLineView[];
  /** Realtime sequence the snapshot is consistent with. */
  seq: number;
}

/** Payload of cart.updated. `sent` is set when someone at the table sent dishes to the kitchen. */
export interface CartEvent {
  cart: Omit<CartView, "seq">;
  sent: { orderId: string; number: number; by: string; count: number } | null;
}

export const PAYMENT_METHODS = ["card", "cash", "online"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** One line in the admin's transaction list: a payment or a refund. */
export interface TransactionView {
  id: string;
  kind: "payment" | "refund";
  method: PaymentMethod;
  amountMinor: number;
  createdAt: string;
  order: {
    id: string;
    number: number;
    type: OrderType;
    status: OrderStatus;
    customerName: string;
    tableLabel: string | null;
    subtotalMinor: number;
    discountMinor: number;
    deliveryFeeMinor: number;
  };
  takenBy: string | null;
  receipt: { id: string; number: number } | null;
}

export interface TransactionsView {
  currency: string;
  transactions: TransactionView[];
  totals: { grossMinor: number; refundsMinor: number; discountsMinor: number; netMinor: number; count: number };
  byMethod: Record<PaymentMethod, number>;
  byType: Record<OrderType, number>;
  seq: number;
}

export interface AdminOverview {
  location: { id: string; slug: string; name: string; currency: string; timezone: string };
  today: {
    revenueMinor: number;
    orders: number;
    averageMinor: number;
    covers: number;
    bookings: number;
    deliveries: number;
  };
  /** Revenue per day for the last 14 days, oldest first. */
  days: { date: string; revenueMinor: number; orders: number }[];
  topItems: { name: string; quantity: number; revenueMinor: number }[];
}

export interface StaffMemberView {
  id: string;
  name: string;
  email: string;
  role: "staff" | "driver" | "admin";
  createdAt: string;
  lastLoginAt: string | null;
}

/** The admin's view of the menu, including dishes taken off it. */
export interface MenuAdminView {
  currency: string;
  categories: {
    id: string;
    name: string;
    blurb: string | null;
    items: (MenuItemView & { categoryId: string; archived: boolean })[];
  }[];
  /** Photos already in use or uploaded, to pick from. */
  photos: string[];
}

export interface InviteView {
  id: string;
  role: "staff" | "driver" | "admin";
  name: string | null;
  email: string | null;
  createdAt: string;
  expiresAt: string;
  /** Only returned once, when the invite is created. */
  url: string | null;
}

/** What someone opening an invite link sees before choosing a password. */
export interface InvitePreview {
  role: "staff" | "driver" | "admin";
  restaurant: string;
  name: string | null;
  email: string | null;
}

export interface GuestView {
  id: string;
  name: string;
  email: string;
  completedOrders: number;
  rewardsAvailable: number;
  spentMinor: number;
  lastOrderAt: string | null;
}
