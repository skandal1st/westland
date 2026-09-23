-- Category visibility: hide provider groups (e.g. "!!!удаленные", manufacturer
-- containers) from the storefront without deleting them.
ALTER TABLE "Category" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
