CREATE TABLE "OnecSaleCustomerIdentity" (
    "connectionId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "xmlId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "inn" TEXT NOT NULL,
    "kpp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnecSaleCustomerIdentity_pkey" PRIMARY KEY ("connectionId", "customerId"),
    CONSTRAINT "OnecSaleCustomerIdentity_origin_check" CHECK ("origin" IN ('WEBSITE', 'ERP_MAPPING', 'LEGACY_XML')),
    CONSTRAINT "OnecSaleCustomerIdentity_xmlId_check" CHECK (length("xmlId") BETWEEN 1 AND 40)
);
CREATE UNIQUE INDEX "OnecSaleCustomerIdentity_connectionId_xmlId_key" ON "OnecSaleCustomerIdentity"("connectionId", "xmlId");
CREATE INDEX "OnecSaleCustomerIdentity_customerId_idx" ON "OnecSaleCustomerIdentity"("customerId");
ALTER TABLE "OnecSaleCustomerIdentity" ADD CONSTRAINT "OnecSaleCustomerIdentity_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OnecSaleCustomerIdentity" ADD CONSTRAINT "OnecSaleCustomerIdentity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION guard_onec_sale_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'onec_sale_customer_identity_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "IntegrationConnection" s JOIN "Customer" c ON c."storeId" = s."storeId"
    WHERE s.id = NEW."connectionId" AND c.id = NEW."customerId" AND s.provider = 'ONE_C'
  ) THEN
    RAISE EXCEPTION 'onec_sale_customer_identity_source_mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "OnecSaleCustomerIdentity_guard" BEFORE INSERT OR UPDATE ON "OnecSaleCustomerIdentity"
FOR EACH ROW EXECUTE FUNCTION guard_onec_sale_customer_identity();

-- Retain the identity that was already sent, even if a mutable mapping changed.
-- Multiple historical identities/requisites for one source+buyer deliberately fail
-- the unique key: an operator must reconcile them instead of silently choosing one.
INSERT INTO "OnecSaleCustomerIdentity" ("connectionId", "customerId", "xmlId", "origin", "inn", "kpp")
SELECT DISTINCT d."connectionId", o."customerId",
  (xpath('/Документ/Контрагенты/Контрагент[Роль="Покупатель"]/Ид/text()', XMLPARSE(DOCUMENT d.xml)))[1]::text,
  'LEGACY_XML', o."commercialSnapshot"->'buyer'->>'inn', o."commercialSnapshot"->'buyer'->>'kpp'
FROM "OnecSaleDelivery" d
JOIN "OrderExport" e ON e.id = d."exportId"
JOIN "Order" o ON o.id = e."orderId";
