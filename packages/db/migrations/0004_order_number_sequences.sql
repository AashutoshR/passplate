-- Order numbers move from a counter column to one sequence per restaurant
-- (see src/order-numbers.ts): the counter row was the hottest lock under load.
-- Each sequence carries on from where its counter was.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT id, next_order_number FROM locations LOOP
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I START %s', 'order_number_' || replace(r.id::text, '-', ''), r.next_order_number);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "locations" DROP COLUMN "next_order_number";
