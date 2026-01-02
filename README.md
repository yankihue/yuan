# Yuan Voice-to-Code Orchestrator

This project connects a Telegram bot to Claude Code/Codex so you can deploy code-ready outputs straight to a VPS.

## Prerequisites
- Docker and Docker Compose plugin installed
- API keys and tokens (Anthropic, Telegram, OpenAI if using OpenAI transcription)

## Configuration
1. Copy `.env.example` to `.env` and fill in the required values:
   - `ORCHESTRATOR_SECRET`: shared secret between services
   - `ANTHROPIC_API_KEY`: key for Claude Code
   - `TELEGRAM_BOT_TOKEN`: token for your Telegram bot
   - `OPENAI_API_KEY`: required when `TRANSCRIPTION_PROVIDER=openai`
   - Optional: `CODEX_CLI_COMMAND`/`CODEX_CLI_ARGS` if you have a Codex-like CLI available inside the container
2. Adjust `ORCHESTRATOR_PORT` if you need a different exposed port.

## Running with Docker Compose

Build and start both services:

```bash
docker compose up --build -d
```

- **orchestrator**: available on `http://localhost:${ORCHESTRATOR_PORT:-3000}`.
- **telegram-bot**: connects to the orchestrator via the shared secret.

To view logs:

```bash
docker compose logs -f orchestrator
# or
# docker compose logs -f telegram-bot
```

To stop the stack:

```bash
docker compose down
```

## Notes
- Ensure the `CODEX_CLI_COMMAND` is available inside the orchestrator container if you want to route requests to a Codex-like CLI.
- `ALLOWED_USER_IDS` can restrict access to specific Telegram user IDs (comma-separated).
