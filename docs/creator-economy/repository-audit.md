# Repository Audit (pre-implementation)

Stack: Fastify + Prisma/Postgres 16 + Redis + Socket.IO backend (apps/backend, worker in same
image); React/Vite/TanStack Query/zustand frontend (apps/frontend); Capacitor Android + Electron
desktop wrapping the same bundle; Swift iOS kit in progress. Deploy: docker compose via deploy.sh.
Tests: vitest (backend unit/property) + live verify-*.mjs suites against production.

Already present and REUSED (not rebuilt): Stripe billing (subscriptions, ad-campaign checkout,
signature-verified webhook), closed-loop coin ledger (append-only CoinLedgerEntry, idempotent
top-ups), self-serve ads (prepaid budgets, impressions/clicks), adult-gated video feed with
server-side qualified views (Redis-deduped), roles/permissions incl. per-channel overwrites,
minor-safety regime (16+, parental pairing, visibility separation), automod, platform bans,
audit log, notifications (push), Prometheus metrics.

Absent before this work: any ledger, revenue events, split policy, creator program, payouts,
tips, gifts, creator studio, unified inbox, XP.
