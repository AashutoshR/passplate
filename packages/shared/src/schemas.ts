import { z } from "zod";
import { DeliveryAddressSchema } from "./delivery";

export const ORDER_TYPES = ["dine_in", "pickup", "delivery"] as const;
export const ORDER_STATUSES = [
  "received",
  "cooking",
  "ready",
  "completed",
  "out_for_delivery",
  "delivered",
  "cancelled",
] as const;

export const OrderTypeSchema = z.enum(ORDER_TYPES);
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderType = z.infer<typeof OrderTypeSchema>;
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const PlaceOrderItemSchema = z.object({
  menuItemId: z.uuid(),
  quantity: z.number().int().min(1).max(50),
  modifierIds: z.array(z.uuid()).max(20).default([]),
  notes: z.string().trim().max(200).optional(),
});

/** Body of POST /v1/orders. */
export const PlaceOrderSchema = z
  .object({
    locationSlug: z.string().min(1).max(64),
    type: OrderTypeSchema,
    tableToken: z.string().min(1).max(64).optional(),
    customerName: z.string().trim().min(1).max(60),
    phone: z.string().trim().max(30).optional(),
    items: z.array(PlaceOrderItemSchema).min(1).max(50),
    delivery: DeliveryAddressSchema.optional(),
    /** Spend one earned reward on this order. Needs a signed-in customer. */
    useReward: z.boolean().optional(),
  })
  .refine((b) => b.type !== "dine_in" || Boolean(b.tableToken), {
    message: "tableToken is required for dine-in orders",
    path: ["tableToken"],
  })
  .refine((b) => b.type !== "delivery" || Boolean(b.delivery), {
    message: "A delivery address is required",
    path: ["delivery"],
  })
  .refine((b) => b.type !== "delivery" || Boolean(b.phone && b.phone.length >= 6), {
    message: "A phone number is required so the driver can reach you",
    path: ["phone"],
  });
export type PlaceOrderInput = z.infer<typeof PlaceOrderSchema>;

/**
 * Body of a kitchen ticket transition. `from` makes the change conditional,
 * and `actionId` makes replays from an offline queue safe (FR-11, FR-13).
 */
export const TransitionSchema = z.object({
  from: OrderStatusSchema,
  to: OrderStatusSchema,
  actionId: z.uuid(),
  device: z.string().trim().max(64).optional(),
});
export type TransitionInput = z.infer<typeof TransitionSchema>;

export const StockUpdateSchema = z
  .object({
    soldOut: z.boolean().optional(),
    stock: z.number().int().min(0).max(100_000).nullable().optional(),
  })
  .refine((b) => b.soldOut !== undefined || b.stock !== undefined, {
    message: "Send soldOut, stock or both",
  });
export type StockUpdateInput = z.infer<typeof StockUpdateSchema>;

export const KitchenLoginSchema = z.object({
  slug: z.string().min(1).max(64),
  code: z.string().min(1).max(200),
});

/** Idempotency keys are client generated, usually a UUID. */
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, - or _");
