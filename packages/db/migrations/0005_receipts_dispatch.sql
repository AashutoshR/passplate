CREATE TABLE "driver_shifts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"location_id" uuid NOT NULL,
	"on_shift" boolean DEFAULT false NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"position_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"order_ids" uuid[] NOT NULL,
	"total_minor" integer NOT NULL,
	"body" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"printed_count" integer DEFAULT 0 NOT NULL,
	"last_printed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "address" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "vat_number" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "vat_rate_bp" integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "picked_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "arriving_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "eta_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "eta_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "route_provider" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "route_polyline" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "route_distance_m" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "route_duration_s" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "proof_kind" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "proof_note" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "proof_lat" double precision;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "proof_lng" double precision;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_location_number_uq" ON "receipts" USING btree ("location_id","number");--> statement-breakpoint
CREATE INDEX "receipts_location_issued_idx" ON "receipts" USING btree ("location_id","issued_at");--> statement-breakpoint
CREATE INDEX "receipts_orders_idx" ON "receipts" USING gin ("order_ids");--> statement-breakpoint
CREATE INDEX "orders_delivered_idx" ON "orders" USING btree ("location_id","delivered_at") WHERE "orders"."delivered_at" is not null;--> statement-breakpoint
CREATE INDEX "payments_unreceipted_idx" ON "payments" USING btree ("created_at") WHERE "payments"."receipt_id" is null;--> statement-breakpoint
UPDATE "orders" o SET "delivered_at" = t."at" FROM "order_transitions" t WHERE t."order_id" = o."id" AND t."to_status" = 'delivered' AND o."delivered_at" IS NULL;--> statement-breakpoint
UPDATE "orders" o SET "picked_up_at" = t."at" FROM "order_transitions" t WHERE t."order_id" = o."id" AND t."to_status" = 'out_for_delivery' AND o."picked_up_at" IS NULL;
