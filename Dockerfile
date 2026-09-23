# syntax=docker/dockerfile:1

# --- deps: install node_modules (incl. dev) for build ---
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# --- builder: generate prisma client and build Next standalone ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# --- runner: minimal runtime image ---
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/* \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Next standalone output + static assets + public.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Standalone integration worker, bundled at build time; same release as HTTP.
COPY --from=builder --chown=nextjs:nodejs /app/dist ./dist
# Prisma schema + migrations + engine for `migrate deploy` at deploy time.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# Recreate the prisma CLI symlink (docker COPY dereferences it into a plain file,
# which breaks the CLI's __dirname-relative lookup of prisma_schema_build_bg.wasm).
RUN mkdir -p ./node_modules/.bin && ln -sf ../prisma/build/index.js ./node_modules/.bin/prisma
# Bootstrap script + its runtime dep (bcryptjs) so the installer can run
# `node scripts/bootstrap.mjs` inside the image.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/packages/license-core ./packages/license-core
COPY --from=builder /app/node_modules/bcryptjs ./node_modules/bcryptjs
# Writable staging for inbound 1C "Обмен с сайтом" files (mounted as a volume in
# compose). Created owned by the runtime user so an empty named volume inherits
# nextjs ownership and the app can write received catalog/offers files.
RUN mkdir -p /app/exchange /app/.media \
  && chown nextjs:nodejs /app/exchange /app/.media \
  && chmod 0700 /app/.media
# Private PDF cache: outside public/static; an empty named volume inherits ownership.
ENV MEDIA_ROOT=/app/.media

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
