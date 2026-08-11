-- Adds MASTER to the platform role ladder.
--
-- Deliberately alone in its own migration: Postgres refuses to USE a newly added enum value inside
-- the same transaction that adds it ("unsafe use of new value of enum type"), and Prisma runs each
-- migration in one transaction. The row that actually becomes MASTER is set in the NEXT migration.
ALTER TYPE "PlatformRole" ADD VALUE 'MASTER';
