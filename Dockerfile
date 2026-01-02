# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies using workspace metadata only to leverage Docker layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/telegram-bot/package.json packages/telegram-bot/package.json
RUN npm ci

# Copy source and build the workspace packages
COPY packages ./packages
RUN npm run build --workspaces

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
RUN npm prune --omit=dev

FROM runtime AS orchestrator
WORKDIR /app/packages/orchestrator
EXPOSE 3000
CMD ["node", "dist/index.js"]

FROM runtime AS telegram-bot
WORKDIR /app/packages/telegram-bot
CMD ["node", "dist/index.js"]
