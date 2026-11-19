import { z } from "zod";

/**
 * One account system for everyone. A role decides what a person can open:
 * customers order, book and collect rewards; staff run the floor and the
 * kitchen; drivers deliver; admins see everything, including transactions.
 */
export const USER_ROLES = ["customer", "staff", "driver", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const STAFF_ROLES: readonly UserRole[] = ["staff", "driver", "admin"];
export const isStaffRole = (role: UserRole) => STAFF_ROLES.includes(role);

const email = z.string().trim().toLowerCase().email("Enter a valid email address").max(200);
const password = z.string().min(8, "Use at least 8 characters").max(200);

export const RegisterSchema = z.object({
  name: z.string().trim().min(1, "Tell us your name").max(80),
  email,
  phone: z.string().trim().max(30).optional(),
  password,
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({ email, password: z.string().min(1).max(200) });
export type LoginInput = z.infer<typeof LoginSchema>;

export const CreateStaffSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email,
  password,
  role: z.enum(["staff", "driver", "admin"]),
});
export type CreateStaffInput = z.infer<typeof CreateStaffSchema>;

export interface UserView {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: UserRole;
  /** The restaurant a member of staff works at. Null for customers. */
  locationId: string | null;
}

/** Every eighth completed order earns 20% off the next one, up to £15. */
export const REWARD_EVERY = 8;
export const REWARD_PERCENT = 20;
export const REWARD_CAP_MINOR = 1500;

export function rewardDiscount(subtotalMinor: number): number {
  return Math.min(REWARD_CAP_MINOR, Math.round((subtotalMinor * REWARD_PERCENT) / 100));
}

export interface RewardsView {
  /** Completed orders so far. */
  completedOrders: number;
  /** Stamps on the current card, 0 to 7. */
  stamps: number;
  /** Rewards earned and not yet used. */
  available: number;
  every: number;
  percent: number;
  capMinor: number;
}

export interface AccountView {
  user: UserView;
  rewards: RewardsView | null;
}
