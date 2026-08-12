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

## 2. Announce before ANY rebuild, and before leaving the area you claimed

Two halves, and the second was learned the hard way after the first was already written down.

### Announce rebuilds, not just full deploys

`docker compose up -d backend` rebuilds and restarts the backend image. It is not a full
`./deploy.sh`, so it is easy to treat as a small local action — but it snapshots and republishes the
same source tree, and it takes the API down for a few seconds. Announce it.

### Say when you leave your own scope

One session claimed "index.css and chat surfaces only", then edited `apps/backend/src/lib/mail.ts`
and `.env` and rebuilt, because the user had redirected it at mail work mid-task. That is a
perfectly good reason to change scope — the mistake was not saying so. The other session was editing
verify scripts and docs at the time; neither is in the backend image, so the collision was missed by
luck rather than by protocol.

A claimed scope is a promise other sessions plan around. When the user moves you, announce the move
before the first edit, not after the rebuild.

## 2b. Announce before `./deploy.sh`, and do not edit during someone else's

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

## 6. Run `docker compose` from the project root — ALWAYS

Compose finds `compose.yml` by walking **up** the directory tree, but resolves `${VAR}`
interpolation from the `.env` in the **current working directory**. Those are two different
directories the moment you are not at the root.

`apps/backend/.env` exists and is a local-development file. So this:

```bash
cd apps/backend && npx tsc --noEmit && docker compose up -d --build backend
```

finds the right compose file and the wrong environment. On 2026-08-12 it put the live backend up
with dev JWT secrets, `NODE_ENV=development`, and `CORS_ORIGIN=http://localhost:5173`.

**Nothing failed.** The container reported healthy and served traffic. The only visible symptom was
a verification email whose link pointed at `localhost:5173`; the real damage — session tokens signed
with a development secret — was silent, and was found only because a user tried the link.

Two guards now exist, and neither replaces the habit:

- `config/env.ts` refuses to boot when `NODE_ENV=production` and the config looks like dev
  (no public https origin, localhost-only CORS, placeholder-shaped JWT secrets). It exits, so the
  deploy fails visibly instead of succeeding wrongly.
- After any container recreate, the cheap check is:

  ```bash
  [ "$(docker exec lumina-backend printenv JWT_ACCESS_SECRET)" \
    = "$(grep '^JWT_ACCESS_SECRET=' .env | cut -d= -f2-)" ] && echo ok || echo MISMATCH
  ```

The same trap applies to `prisma`, `npm`, and anything else reading `.env` by convention. Combine
the typecheck and the deploy in one command line only if that line starts at the project root.
