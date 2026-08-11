# Multi-stage build: build the static SPA, then serve it with nginx.
# Built from the monorepo root so npm workspaces resolve @lumina/shared, e.g.:
#   docker build -f apps/frontend/Dockerfile -t lumina-frontend .

FROM node:22-slim AS build
WORKDIR /repo

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN npm ci

COPY packages/shared packages/shared
COPY apps/frontend apps/frontend
RUN npm run build --workspace=apps/frontend
# Second bundle: the standalone owner console (see vite.config.ts APP_VARIANT). Served at
# /owner-app/ below so the exact bundle the Android owner APK wraps is also reachable in a browser
# — it makes the APK's UI testable without an emulator, and gives the owner a desktop version of the
# same console. Identical bundle in both places, so they cannot drift.
RUN npm run build:owner --workspace=apps/frontend

FROM nginx:1.27-alpine AS runtime
COPY apps/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/frontend/dist /usr/share/nginx/html
COPY --from=build /repo/apps/frontend/dist-owner /usr/share/nginx/html/owner-app
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
