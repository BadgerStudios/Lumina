# Working on this repo with more than one agent (or person) at once

Two Claude Code sessions worked on this box simultaneously on 2026-08-12 and destroyed each other's
test data before either knew the other existed. These are the rules that came out of that. They are
short because rules nobody remembers are not rules.

## 1. Never delete shared state by pattern

The specific thing that went wrong:

```sql
-- BOTH sessions were running this to clean up after verification runs
DELETE FROM "User" WHERE email LIKE '%@example.com';
```

Every verification script in this repo creates throwaway accounts on `@example.com`. A blanket
delete therefore destroys **the other session's accounts mid-run**, which surfaces as a test failing
for reasons that have nothing to do with the code under test — the worst kind of failure to debug,
because the evidence is already gone.

Rules:

- **Delete by exact identifier**, from a list you just created. Every committed `verify-*.mjs`
  already does this (`WHERE username = '${username}'`) — the offending deletes were ad-hoc shell
  commands typed during a session, which is worse, because nothing reviews them.
- If you must clean up in bulk, **scope it to a prefix you own**.

Current prefix assignments:

| Prefix | Owned by | Cleanup scope |
|---|---|---|
| `qq_` | The session that authored this file — reachable as `discord-parity-closure-plan` | `username LIKE 'qq\_%'` |
| `zz_` | The session that reviewed it — the one that wired SMTP and shipped AutoMod | `username LIKE 'zz\_%'` |
| — | Any other session: pick an unused prefix and add a row | its own prefix only |

**Keyed by prefix, not by session name, on purpose.** The first version of this table was keyed by
name and had the two rows swapped: it listed `discord-parity-closure-plan` against `zz_`, when that
session had just agreed to take `qq_`. Each session knows the *other* by the name the messaging
layer reports and itself by something else, so a name-keyed table is ambiguous exactly where it
needs to be precise — and a third session reading it would have cleaned up under a prefix it did
not own, causing the failure this document exists to prevent.

The prefix is the identifier that matters. If you cannot tell which row is yours, you do not own
either; take a new one.

## 2. Announce before `./deploy.sh`, and do not edit during someone else's

A full deploy **snapshots the source tree at step 1** (`docker compose build`). An edit made while a
deploy is running lands in the build *after* next.

This is nasty because nothing fails: the typecheck passes, the deploy succeeds, and the artifact is
simply missing the change. It cost two builds in one day (`useRoleSync`, then the owner detail
panel), each time discovered only by extracting the APK and grepping it.

So: say "deploying" before you start, and don't edit while someone else has said it.

## 3. Verify against the built artifact, not the source tree

Related, and the reason the above was caught at all. `npx tsc --noEmit` cannot see that a component
is imported and never rendered — an unused import and unused state are both legal TypeScript. A
scripted string-replace that silently fails to match produces exactly that shape.

```bash
unzip -q -o downloads/lumina.apk 'assets/public/*' -d /tmp/apk
grep -rl 'a string only this feature emits' /tmp/apk   # 0 means it did not ship
```

Prefer a string that is **not** inside a template literal — minification splits
`` `Ban history (${n})` `` so the literal may not appear contiguously.

## 4. Never apply generated migration SQL verbatim

`prisma migrate diff` always leads with:

```sql
DROP INDEX "message_search_idx";
```

That GIN index over `Message."searchVector"` was created by raw SQL in an earlier migration and so
does not appear in `schema.prisma`. Prisma sees an index the schema does not describe and helpfully
removes it. Applying the generated file **deletes message search** — and not loudly: search keeps
returning results via sequential scan until the table is large enough to time out.

Hand-write every migration. There are worked examples in `apps/backend/prisma/migrations/` from
2026-08-11 (`_totp_mfa`, `_passkeys`, `_email_verification`, `_automod`), each with the omission
noted in a comment.

## 5. Say what is true about your own work

One session told the other it was "mid-way through" an edit to `index.css` that it had not started —
it had read the design tokens and seeded demo data, nothing more. The other session caught it by
checking the file's mtime.

Overstating progress to a teammate is how two agents end up building on a base neither of them has.
Claim what is on disk, and check before you claim it.
