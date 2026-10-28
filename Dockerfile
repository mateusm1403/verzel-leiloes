FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/apps/api/src ./apps/api/src
COPY --from=build /app/scripts ./scripts
EXPOSE 4000
CMD ["sh", "-c", "./node_modules/.bin/tsx scripts/migrate.ts && ./node_modules/.bin/tsx scripts/seed.ts && node dist/api/server.js"]
