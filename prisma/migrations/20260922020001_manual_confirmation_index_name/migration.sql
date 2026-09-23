-- PostgreSQL truncates identifiers at 63 bytes; use Prisma's expected generated name.
ALTER INDEX "OrderManualConfirmation_connectionId_documentNumber_documentDat"
RENAME TO "OrderManualConfirmation_connectionId_documentNumber_documen_key";
