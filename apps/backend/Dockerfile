# syntax=docker/dockerfile:1

########################
# deps: install full workspace deps at the repo root. npm workspaces hoists
# everything into the root node_modules (no apps/backend/node_modules is
# created unless something can't be hoisted), so every later stage works off
# /repo/node_modules rather than a per-package one.
########################
FROM node:22-alpine AS deps
WORKDIR /repo
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/backend/package.json apps/backend/package.json
RUN npm install --workspace=apps/backend --include-workspace-root --no-audit --no-fund

########################
# build: generate prisma client + bundle backend. @lumina/shared is bundled
# straight into dist/index.js by tsup (noExternal), so the runtime image
# never needs packages/shared or its node_modules symlink at all.
########################
FROM node:22-alpine AS build
WORKDIR /repo
RUN apk add --no-cache openssl
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json ./
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN npm run db:generate --workspace=apps/backend
RUN npm run build --workspace=apps/backend

########################
# runtime: slim image, non-root, migrate then start
########################
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# ffmpeg is used ONLY by the transcode worker entrypoint (dist/worker.js — see the `worker` service
# in compose.yml). It ships in this shared image rather than a separate one so both entrypoints are
# built from identical code and Prisma clients; the API process never invokes it.
RUN apk add --no-cache openssl ffmpeg && \
    addgroup -S lumina && adduser -S lumina -G lumina

COPY --from=build /repo/apps/backend/dist ./dist
COPY --from=build /repo/apps/backend/prisma ./prisma
# Brand artwork the API itself needs — the official-account generator sets the Lumina logo as
# the avatar, so the file has to exist inside this container rather than in the frontend build.
COPY --from=build /repo/apps/backend/assets ./assets
COPY --from=build /repo/apps/backend/package.json ./package.json
COPY --from=build /repo/node_modules ./node_modules

# /data/uploads is where the named `lumina-uploads` volume mounts in compose.yml (UPLOADS_DIR
# env var). Docker initializes a fresh named volume from whatever already exists at that path
# in the image, ownership included — so pre-creating it here as `lumina` avoids an EACCES on
# first boot instead of relying on a runtime chown (which wouldn't have permission to run as
# the non-root user anyway).
RUN mkdir -p /app/uploads /data/uploads/avatars /data/uploads/attachments \
      /data/uploads/videos/source /data/uploads/videos/playback /data/uploads/videos/thumbs && \
    chown -R lumina:lumina /app /data
USER lumina

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>{if(r.ok)process.exit(0);process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["sh", "-c", "npx prisma migrate deploy --schema=./prisma/schema.prisma && node dist/index.js"]
