-- New report ticket statuses, alone in their own migration.
--
-- Postgres will not let a newly added enum value be USED in the transaction that adds it, and
-- Prisma wraps each migration in one — so anything referencing these must land in a later file.
ALTER TYPE "ReportStatus" ADD VALUE 'IN_PROGRESS';
ALTER TYPE "ReportStatus" ADD VALUE 'INVESTIGATING';
ALTER TYPE "ReportStatus" ADD VALUE 'COMPLETED';
