import type { OrderStatus, OrderType } from "./schemas";

/**
 * The order state machine (FR-11). Every status change in the system goes
 * through canTransition, on the server and in the kitchen UI.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  // Only a confirmed payment (to received) or an expired one (to cancelled)
  // moves an order on from here, never a tap on a kitchen screen.
  awaiting_payment: [],
  received: ["cooking", "cancelled"],
  cooking: ["ready", "cancelled"],
  ready: ["completed", "out_for_delivery"],
  out_for_delivery: ["delivered"],
  completed: [],
  delivered: [],
  cancelled: [],
};

export const ACTIVE_STATUSES: readonly OrderStatus[] = ["received", "cooking", "ready"];
export const FINAL_STATUSES: readonly OrderStatus[] = ["completed", "delivered", "cancelled"];

export function canTransition(type: OrderType, from: OrderStatus, to: OrderStatus): boolean {
  if (!TRANSITIONS[from].includes(to)) return false;
  // Collected or served at the counter only makes sense without a driver,
  // and only delivery orders go out with a driver.
  if (to === "completed" && type === "delivery") return false;
  if (to === "out_for_delivery" && type !== "delivery") return false;
  return true;
}

/** The main button on a kitchen ticket, or null when the kitchen is done with it. */
export function nextKitchenStep(
  type: OrderType,
  status: OrderStatus,
): { to: OrderStatus; label: string } | null {
  switch (status) {
    case "received":
      return { to: "cooking", label: "Start" };
    case "cooking":
      return { to: "ready", label: "Ready" };
    case "ready":
      if (type === "dine_in") return { to: "completed", label: "Served" };
      if (type === "pickup") return { to: "completed", label: "Collected" };
      return null; // A driver takes delivery orders from here (Milestone 3).
    default:
      return null;
  }
}

/** Customer-facing progress steps (FR-9). */
export function customerSteps(type: OrderType): { status: OrderStatus; label: string }[] {
  const base: { status: OrderStatus; label: string }[] = [
    { status: "received", label: "Received" },
    { status: "cooking", label: "Cooking" },
    { status: "ready", label: type === "pickup" ? "Ready to collect" : "Ready" },
  ];
  if (type === "delivery") {
    return [
      ...base,
      { status: "out_for_delivery", label: "Out for delivery" },
      { status: "delivered", label: "Delivered" },
    ];
  }
  return [...base, { status: "completed", label: type === "pickup" ? "Collected" : "Served" }];
}
