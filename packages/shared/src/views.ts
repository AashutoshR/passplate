import type { OpeningHours } from "./hours";
import type { OrderStatus, OrderType } from "./schemas";

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
    driverName: string | null;
    driver: { lat: number; lng: number; at: string } | null;
  } | null;
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

export interface GuestView {
  id: string;
  name: string;
  email: string;
  completedOrders: number;
  rewardsAvailable: number;
  spentMinor: number;
  lastOrderAt: string | null;
}
