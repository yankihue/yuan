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

# Install git and GitHub CLI for code operations
RUN apk add --no-cache git github-cli

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
RUN npm prune --omit=dev

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

FROM runtime AS orchestrator
WORKDIR /app/packages/orchestrator
EXPOSE 3000
CMD ["node", "dist/index.js"]

FROM runtime AS telegram-bot
# Install ffmpeg and whisper.cpp for local transcription
RUN set -eux; \
    apk add --no-cache ffmpeg libstdc++; \
    apk add --no-cache --virtual .whisper-build git build-base cmake wget; \
    git clone --depth 1 https://github.com/ggerganov/whisper.cpp /opt/whisper.cpp; \
    cmake -B /opt/whisper.cpp/build -S /opt/whisper.cpp; \
    cmake --build /opt/whisper.cpp/build -j --config Release; \
    mkdir -p /opt/whisper.cpp/models; \
    wget -O /opt/whisper.cpp/models/ggml-base.en.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin; \
    ln -s /opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper; \
    apk del .whisper-build
WORKDIR /app/packages/telegram-bot
CMD ["node", "dist/index.js"]
