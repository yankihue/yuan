# syntax=docker/dockerfile:1

FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies using workspace metadata only to leverage Docker layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/orchestrator/package.json packages/orchestrator/package.json
COPY packages/telegram-bot/package.json packages/telegram-bot/package.json
COPY packages/creative-agent/package.json packages/creative-agent/package.json
RUN npm ci

# Copy source and build the workspace packages
COPY packages ./packages
RUN npm run build --workspaces

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install bash, git and GitHub CLI for Claude Code operations
RUN apk update && apk add --no-cache bash git github-cli

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
RUN npm prune --omit=dev

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

FROM runtime AS orchestrator
WORKDIR /app/packages/orchestrator

# Create non-root user (Claude Code refuses --dangerously-skip-permissions as root)
RUN addgroup -g 1001 claude && adduser -u 1001 -G claude -s /bin/sh -D claude

# Create workdir and set ownership
RUN mkdir -p /app/workdir /home/claude/.claude && chown -R claude:claude /app /home/claude

# Configure git to use gh CLI for credential authentication
RUN git config --system credential.helper '!gh auth git-credential'

# Copy Claude Code settings for permission allow-list
COPY --chown=claude:claude .claude /home/claude/.claude

# Switch to non-root user
USER claude

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

FROM runtime AS creative-agent
WORKDIR /app/packages/creative-agent
EXPOSE 3003
CMD ["node", "dist/index.js"]
