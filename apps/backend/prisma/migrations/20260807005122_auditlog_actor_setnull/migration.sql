-- Generated via `prisma migrate diff` against a throwaway shadow database (same non-interactive
-- workaround as the previous migration), with the same recurring false-positive
-- `DROP INDEX "message_search_idx"` stripped out — that GIN index lives on
-- Message.searchVector (Unsupported("tsvector")), which `migrate diff` can't see is still
-- wanted from schema.prisma alone. Do not re-add a DROP for it here.
--
-- Makes AuditLogEntry.actorId nullable + ON DELETE SET NULL instead of the implicit RESTRICT a
-- bare relation defaults to: discovered when deleting a bot's Application (which cascades to
-- delete its User row — the first case where a User row is ever actually deleted, since humans
-- leaving a server only removes their Membership) hard-failed with a foreign key violation on
-- any audit log entry where that bot was the actor (e.g. joining via invite).

-- DropForeignKey
ALTER TABLE "AuditLogEntry" DROP CONSTRAINT "AuditLogEntry_actorId_fkey";

-- AlterTable
ALTER TABLE "AuditLogEntry" ALTER COLUMN "actorId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
