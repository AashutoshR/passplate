ALTER TYPE "public"."order_status" ADD VALUE 'awaiting_payment' BEFORE 'received';--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"role" "user_role" NOT NULL,
	"name" text,
	"email" text,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_cart_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cart_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"modifier_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"notes" text,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_id" uuid NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "table_carts_table_id_unique" UNIQUE("table_id")
);
--> statement-breakpoint
ALTER TABLE "menu_categories" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_provider" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_ref" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_cart_lines" ADD CONSTRAINT "table_cart_lines_cart_id_table_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."table_carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_cart_lines" ADD CONSTRAINT "table_cart_lines_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_carts" ADD CONSTRAINT "table_carts_table_id_dining_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."dining_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invites_location_idx" ON "invites" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "table_cart_lines_cart_idx" ON "table_cart_lines" USING btree ("cart_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_unpaid_idx" ON "orders" USING btree ("payment_expires_at") WHERE "orders"."payment_expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_payment_ref_uq" ON "orders" USING btree ("payment_ref");--> statement-breakpoint
ALTER TABLE "locations" DROP COLUMN "kitchen_token_hash";;--> statement-breakpoint
-- NFR-14: the statement timeout lives on the database, so it also applies to
-- connections that arrive through PgBouncer, which drops per-client settings.
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET statement_timeout = %L', current_database(), '5s'); END $$;