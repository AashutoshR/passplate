import { z } from "zod";

/**
 * The menu editor (FR-1). Managers add and change sections, dishes, options,
 * prices, photos and allergen tags. Dishes are taken off the menu, never
 * deleted, because past orders still point at them.
 */

export const DIETARY_TAGS = ["v", "vg", "gf", "spicy"] as const;

/** The fourteen allergens UK food law asks restaurants to declare. */
export const ALLERGENS = [
  "celery",
  "gluten",
  "crustaceans",
  "egg",
  "fish",
  "lupin",
  "milk",
  "molluscs",
  "mustard",
  "nuts",
  "peanuts",
  "sesame",
  "soya",
  "sulphites",
] as const;

export const CategoryInputSchema = z.object({
  name: z.string().trim().min(1, "Give the section a name").max(60),
  blurb: z.string().trim().max(160).nullable().optional(),
});
export type CategoryInput = z.infer<typeof CategoryInputSchema>;

export const ReorderSchema = z.object({ ids: z.array(z.uuid()).min(1).max(200) });

const ModifierInputSchema = z.object({
  /** Present when editing an existing option, so carts holding it stay valid. */
  id: z.uuid().optional(),
  name: z.string().trim().min(1, "Name every option").max(60),
  priceDeltaMinor: z.number().int().min(0).max(100_000),
});

const ModifierGroupInputSchema = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1, "Name every choice").max(60),
    minSelect: z.number().int().min(0).max(20),
    maxSelect: z.number().int().min(1).max(20),
    modifiers: z.array(ModifierInputSchema).min(1, "A choice needs at least one option").max(30),
  })
  .refine((g) => g.minSelect <= g.maxSelect, { message: "At least cannot be more than at most", path: ["minSelect"] })
  .refine((g) => g.maxSelect <= g.modifiers.length, {
    message: "At most cannot be more than the number of options",
    path: ["maxSelect"],
  });

export const ItemInputSchema = z.object({
  categoryId: z.uuid(),
  name: z.string().trim().min(1, "Give the dish a name").max(80),
  description: z.string().trim().max(400).nullable().optional(),
  priceMinor: z.number().int().min(0, "Price cannot be negative").max(1_000_000),
  allergens: z.array(z.enum(ALLERGENS)).max(14).default([]),
  dietary: z.array(z.enum(DIETARY_TAGS)).max(4).default([]),
  /** A path under /media or /api/v1/media, never a third-party URL. */
  image: z
    .string()
    .regex(/^\/(api\/v1\/)?media\/[A-Za-z0-9/_.-]+\.(jpe?g|png|webp)$/, "Pick a photo from the library or upload one")
    .nullable()
    .optional(),
  featured: z.boolean().default(false),
  stock: z.number().int().min(0).max(100_000).nullable().default(null),
  soldOut: z.boolean().default(false),
  modifierGroups: z.array(ModifierGroupInputSchema).max(10).default([]),
});
export type ItemInput = z.infer<typeof ItemInputSchema>;

/** Staff invite links (FR-22). The link carries a one-time token; only its hash is stored. */
export const CreateInviteSchema = z.object({
  role: z.enum(["staff", "driver", "admin"]),
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(200).optional(),
});
export type CreateInviteInput = z.infer<typeof CreateInviteSchema>;

export const AcceptInviteSchema = z.object({
  name: z.string().trim().min(1, "Tell us your name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(200),
  password: z.string().min(8, "Use at least 8 characters").max(200),
});
export type AcceptInviteInput = z.infer<typeof AcceptInviteSchema>;
