BEGIN;
-- xpath(...)[1]::text serializes XML entities; XMLTABLE extracts decoded text.
-- The preceding migration is already applied on the guarded local database,
-- so correct it forward without changing its recorded checksum.
DROP TRIGGER "OnecSaleCustomerIdentity_guard" ON "OnecSaleCustomerIdentity";
UPDATE "OnecSaleCustomerIdentity" identity
SET "xmlId" = legacy."xmlId"
FROM (
  SELECT DISTINCT d."connectionId", o."customerId", buyer."xmlId"
  FROM "OnecSaleDelivery" d
  JOIN "OrderExport" e ON e.id = d."exportId"
  JOIN "Order" o ON o.id = e."orderId"
  CROSS JOIN XMLTABLE('/Документ/Контрагенты/Контрагент[Роль="Покупатель"]'
    PASSING XMLPARSE(DOCUMENT d.xml) COLUMNS "xmlId" TEXT PATH 'Ид') buyer
) legacy
WHERE identity.origin = 'LEGACY_XML'
  AND identity."connectionId" = legacy."connectionId" AND identity."customerId" = legacy."customerId";
CREATE TRIGGER "OnecSaleCustomerIdentity_guard" BEFORE INSERT OR UPDATE ON "OnecSaleCustomerIdentity"
FOR EACH ROW EXECUTE FUNCTION guard_onec_sale_customer_identity();
COMMIT;
