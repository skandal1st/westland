-- Add enum values in their own migration so they are committed before use.
ALTER TYPE "OrderStatus" ADD VALUE 'DRAFT';
ALTER TYPE "OrderStatus" ADD VALUE 'SUBMITTED';
