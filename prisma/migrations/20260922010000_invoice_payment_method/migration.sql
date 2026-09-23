-- No backfill from mutable channel settings: preserve legacy invoice history.
ALTER TABLE "Invoice" ADD COLUMN "paymentMethod" "PaymentMethod";
