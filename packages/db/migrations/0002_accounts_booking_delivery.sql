CREATE TYPE "public"."payment_kind" AS ENUM('payment', 'refund');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('card', 'cash', 'online');--> statement-breakpoint
CREATE TYPE "public"."reservation_source" AS ENUM('online', 'phone', 'walk_in');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('booked', 'seated', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."table_shape" AS ENUM('round', 'square', 'rect', 'booth', 'stool');--> statement-breakpoint
CREATE TYPE "public"."table_state" AS ENUM('free', 'seated', 'clearing');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'staff', 'driver', 'admin');--> statement-breakpoint
CREATE TYPE "public"."waitlist_status" AS ENUM('waiting', 'seated', 'left');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" "payment_kind" DEFAULT 'payment' NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount_minor" integer NOT NULL,
	"taken_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"table_id" uuid,
	"user_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"party_size" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "reservation_status" DEFAULT 'booked' NOT NULL,
	"source" "reservation_source" DEFAULT 'online' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"earned_order_id" uuid NOT NULL,
	"redeemed_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone,
	CONSTRAINT "rewards_earned_order_id_unique" UNIQUE("earned_order_id"),
	CONSTRAINT "rewards_redeemed_order_id_unique" UNIQUE("redeemed_order_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'customer' NOT NULL,
	"location_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"party_size" integer NOT NULL,
	"phone" text,
	"quoted_minutes" integer DEFAULT 20 NOT NULL,
	"status" "waitlist_status" DEFAULT 'waiting' NOT NULL,
	"table_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "seats" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "area" text DEFAULT 'Main room' NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "shape" "table_shape" DEFAULT 'square' NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "x" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "y" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "w" integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "h" integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "state" "table_state" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "seated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "seated_party" integer;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "seated_name" text;--> statement-breakpoint
ALTER TABLE "dining_tables" ADD COLUMN "reservation_id" uuid;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "booking_hours" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "lat" double precision DEFAULT 51.4495 NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "lng" double precision DEFAULT -2.5967 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_fee_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "total_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_line1" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_postcode" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_lat" double precision;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_lng" double precision;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_instructions" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "driver_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "driver_lat" double precision;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "driver_lng" double precision;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "driver_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_taken_by_users_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_table_id_dining_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."dining_tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_earned_order_id_orders_id_fk" FOREIGN KEY ("earned_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rewards" ADD CONSTRAINT "rewards_redeemed_order_id_orders_id_fk" FOREIGN KEY ("redeemed_order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_table_id_dining_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."dining_tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_location_created_idx" ON "payments" USING btree ("location_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "reservations_location_starts_idx" ON "reservations" USING btree ("location_id","starts_at");--> statement-breakpoint
CREATE INDEX "reservations_user_idx" ON "reservations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rewards_user_idx" ON "rewards" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "waitlist_location_status_idx" ON "waitlist" USING btree ("location_id","status");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_driver_id_users_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orders_table_idx" ON "orders" USING btree ("table_id");--> statement-breakpoint
UPDATE "orders" SET "total_minor" = "subtotal_minor" WHERE "total_minor" = 0;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_no_overlap" EXCLUDE USING gist ("table_id" WITH =, tstzrange("starts_at", "ends_at") WITH &&) WHERE ("status" IN ('booked', 'seated') AND "table_id" IS NOT NULL);
