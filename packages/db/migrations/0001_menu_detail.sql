ALTER TABLE "menu_categories" ADD COLUMN "blurb" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "dietary" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "featured" boolean DEFAULT false NOT NULL;