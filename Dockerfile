# syntax=docker/dockerfile:1
# ManaWG app image for self-hosting (compose.yaml). Built for linux/amd64 and linux/arm64.
#
# NEXT_PUBLIC_* values are inlined at build time. The instance values (app URL, Supabase URL and
# key, legal URL, support address) are built as placeholders and replaced on container start
# (apps/web/scripts/selfhost/public-env.mjs). Optional browser features are baked in only when
# their build arguments are set: build your own image to enable Web Push, Sentry or PostHog.

FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base

FROM base AS deps
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
	pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY=""
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG NEXT_PUBLIC_POSTHOG_KEY=""
ARG NEXT_PUBLIC_POSTHOG_HOST=""
ENV NEXT_TELEMETRY_DISABLED=1 \
	NEXT_OUTPUT_STANDALONE=true \
	NEXT_DEPLOYMENT_ID=manawg-selfhost-config \
	NEXT_PUBLIC_APP_URL=https://app.manawg-selfhost.invalid \
	NEXT_PUBLIC_SUPABASE_URL=https://supabase.manawg-selfhost.invalid \
	NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=manawg-selfhost-publishable-key \
	NEXT_PUBLIC_LEGAL_URL=https://legal.manawg-selfhost.invalid \
	NEXT_PUBLIC_SUPPORT_EMAIL=support@manawg-selfhost.invalid \
	NEXT_PUBLIC_VAPID_PUBLIC_KEY=${NEXT_PUBLIC_VAPID_PUBLIC_KEY} \
	NEXT_PUBLIC_SENTRY_DSN=${NEXT_PUBLIC_SENTRY_DSN} \
	NEXT_PUBLIC_POSTHOG_KEY=${NEXT_PUBLIC_POSTHOG_KEY} \
	NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST}
RUN pnpm --filter @manawg/web build
# The setup step (migrations, bucket, mail templates) ships as one file with its dependencies.
WORKDIR /repo/apps/web
RUN "$(node -p "require.resolve('esbuild/bin/esbuild', { paths: [require('node:path').dirname(require.resolve('drizzle-kit'))] })")" \
	scripts/selfhost/setup.mjs --bundle --platform=node --format=esm --target=node22 \
	--external:pg-native --outfile=/out/setup.mjs \
	--banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

FROM base AS runner
LABEL org.opencontainers.image.title="ManaWG" \
	org.opencontainers.image.description="The app for shared flats: expenses, cleaning schedule, shopping list" \
	org.opencontainers.image.source="https://github.com/Abuarchiv/manawg" \
	org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	PORT=3000 \
	HOSTNAME=0.0.0.0
WORKDIR /app
# public-env.mjs rewrites the build output on start, so the app user owns it.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
COPY --from=build /repo/apps/web/drizzle ./apps/web/drizzle
COPY --from=build /repo/apps/web/vercel.json ./apps/web/vercel.json
COPY --from=build /repo/apps/web/scripts/selfhost/cron.mjs /repo/apps/web/scripts/selfhost/public-env.mjs ./apps/web/scripts/selfhost/
COPY --from=build /out/setup.mjs ./apps/web/scripts/selfhost/setup.mjs
COPY --from=build /repo/supabase/templates ./supabase/templates
# The setup service renders the mail templates into this volume mount point.
# The runtime only needs node, so the bundled package managers go.
RUN mkdir -p /app/mail-templates && chown node:node /app/mail-templates \
	&& rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
		/opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["sh", "-c", "node scripts/selfhost/public-env.mjs && exec node server.js"]
