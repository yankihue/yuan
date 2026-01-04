# Yuan - Personal AI Second Brain

Yuan is a voice-to-code orchestrator that connects various services to create a powerful personal AI assistant. Send voice messages via Telegram, and Yuan will transcribe, process, and execute tasks across multiple platforms.

## Features

- **Voice-to-Code**: Send voice messages via Telegram to deploy code
- **Messaging Integrations**: WeChat and WhatsApp support
- **Calendar Management**: Google Calendar and Apple Calendar integration
- **Task Scheduling**: Cron-like scheduling with natural language support
- **Extensible**: Built with MCP (Model Context Protocol) for easy integration

## Architecture

```
yuan/
├── packages/
│   ├── orchestrator/     # Core orchestration service
│   ├── telegram-bot/     # Telegram bot client
│   ├── mcp-wechat/       # WeChat MCP server
│   ├── mcp-whatsapp/     # WhatsApp MCP server
│   ├── mcp-calendar/     # Calendar MCP server (Google + Apple)
│   └── scheduler/        # Task scheduling service
├── docker-compose.yml
└── README.md
```

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose (for production)
- API keys (see Configuration section)

### Installation

```bash
# Clone the repository
git clone https://github.com/yankihue/yuan.git
cd yuan

# Install dependencies
npm install

# Build all packages
npm run build --workspaces
```

### Configuration

Copy `.env.example` to `.env` and configure the required values:

```bash
cp .env.example .env
```

#### Core Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `ORCHESTRATOR_SECRET` | Shared secret between services | Yes |
| `ANTHROPIC_API_KEY` | API key for Claude | Yes |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | Yes |
| `OPENAI_API_KEY` | For transcription (if using OpenAI) | Optional |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs | Optional |

#### Integration Configuration

See individual package READMEs for detailed setup:
- [WeChat MCP Setup](./packages/mcp-wechat/README.md)
- [WhatsApp MCP Setup](./packages/mcp-whatsapp/README.md)
- [Calendar MCP Setup](./packages/mcp-calendar/README.md)
- [Scheduler Setup](./packages/scheduler/README.md)

---

## Integrations

### WeChat (`@yuan/mcp-wechat`)

Send and receive WeChat messages through the MCP interface.

**Setup:**
1. No API keys required - uses QR code authentication
2. On first run, scan QR code with WeChat mobile app
3. Session persists across restarts

**Tools:**
- `wechat_send_message` - Send message to contact/group
- `wechat_get_contacts` - List all contacts
- `wechat_search_contacts` - Search by name
- `wechat_get_recent_messages` - Get message history

**Claude Desktop Config:**
```json
{
  "mcpServers": {
    "wechat": {
      "command": "node",
      "args": ["./packages/mcp-wechat/dist/index.js"]
    }
  }
}
```

---

### WhatsApp (`@yuan/mcp-whatsapp`)

Send and receive WhatsApp messages through the MCP interface.

**Setup:**
1. No API keys required - uses QR code authentication
2. On first run, scan QR code with WhatsApp mobile app
3. Session persists in `.wwebjs_auth` directory

**Environment Variables:**
| Variable | Description | Default |
|----------|-------------|---------|
| `WHATSAPP_SESSION_DIR` | Session storage path | `./.wwebjs_auth` |
| `WHATSAPP_CLIENT_ID` | Client identifier | `mcp-whatsapp` |
| `WHATSAPP_HEADLESS` | Run browser headless | `true` |

**Tools:**
- `whatsapp_send_message` - Send message to contact/group
- `whatsapp_send_media` - Send images/documents
- `whatsapp_get_contacts` - List contacts
- `whatsapp_search_contacts` - Search by name
- `whatsapp_get_chats` - Get recent chats
- `whatsapp_get_messages` - Get message history

**Claude Desktop Config:**
```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["./packages/mcp-whatsapp/dist/index.js"],
      "env": {
        "WHATSAPP_SESSION_DIR": "/path/to/session"
      }
    }
  }
}
```

---

### Calendar (`@yuan/mcp-calendar`)

Manage Google Calendar and Apple Calendar events.

**Google Calendar Setup:**

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Google Calendar API
3. Create OAuth2 credentials (Desktop app type)
4. Run the OAuth flow to get a refresh token (see package README)

**Environment Variables:**
| Variable | Description | Required |
|----------|-------------|----------|
| `GOOGLE_CLIENT_ID` | OAuth2 client ID | Yes (for Google) |
| `GOOGLE_CLIENT_SECRET` | OAuth2 client secret | Yes (for Google) |
| `GOOGLE_REFRESH_TOKEN` | OAuth2 refresh token | Yes (for Google) |
| `APPLE_CALENDARS` | JSON array of iCal URLs | Yes (for Apple) |

**Apple Calendar Format:**
```bash
APPLE_CALENDARS='[{"id": "personal", "name": "Personal", "icalUrl": "webcal://..."}]'
```

**Tools:**
- `calendar_list_calendars` - List all calendars
- `calendar_list_events` - Query events by date range
- `calendar_create_event` - Create event (Google only)
- `calendar_update_event` - Update event (Google only)
- `calendar_delete_event` - Delete event (Google only)
- `calendar_check_availability` - Check if time slot is free
- `calendar_find_free_slots` - Find available meeting times

**Claude Desktop Config:**
```json
{
  "mcpServers": {
    "calendar": {
      "command": "node",
      "args": ["./packages/mcp-calendar/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret",
        "GOOGLE_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

---

### Scheduler (`@yuan/scheduler`)

Schedule recurring and one-time tasks with cron expressions or natural language.

**Environment Variables:**
| Variable | Description | Default |
|----------|-------------|---------|
| `SCHEDULER_STORAGE_PATH` | Task persistence file | `./data/tasks.json` |
| `ORCHESTRATOR_URL` | Orchestrator API URL | `http://localhost:3000` |
| `TELEGRAM_BOT_TOKEN` | For Telegram actions | - |
| `TZ` | Timezone | `UTC` |
| `SCHEDULER_PORT` | HTTP API port | `3002` |

**Schedule Formats:**
```
# Cron expressions
0 14 * * *        # Every day at 2:00 PM
0 9 * * 1         # Every Monday at 9:00 AM

# Natural language (recurring)
every day at 2pm
every monday at 9am
every hour

# Natural language (one-time)
in 30 minutes
tomorrow at 3pm
next friday at noon
```

**Action Types:**
- `orchestrator` - Send instruction to Yuan orchestrator
- `telegram` - Send Telegram message
- `webhook` - Call HTTP endpoint

**Tools:**
- `scheduler_create_task` - Create scheduled task
- `scheduler_list_tasks` - List all tasks
- `scheduler_delete_task` - Delete task
- `scheduler_pause_task` - Pause recurring task
- `scheduler_resume_task` - Resume paused task

**Claude Desktop Config:**
```json
{
  "mcpServers": {
    "scheduler": {
      "command": "node",
      "args": ["./packages/scheduler/dist/mcp-server.js"],
      "env": {
        "ORCHESTRATOR_URL": "http://localhost:3000",
        "TELEGRAM_BOT_TOKEN": "your-bot-token"
      }
    }
  }
}
```

**HTTP API (Alternative):**
```bash
# Start the scheduler with HTTP API
npm run start --workspace=@yuan/scheduler

# Create a task via REST
curl -X POST http://localhost:3002/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily Summary",
    "schedule": "every day at 9am",
    "action": {
      "type": "orchestrator",
      "instruction": "Summarize my tasks for today"
    }
  }'
```

---

## Running with Docker Compose

Build and start all services:

```bash
docker compose up --build -d
```

Services:
- **orchestrator**: `http://localhost:${ORCHESTRATOR_PORT:-3000}`
- **telegram-bot**: Connects to orchestrator via shared secret

View logs:
```bash
docker compose logs -f orchestrator
docker compose logs -f telegram-bot
```

Stop the stack:
```bash
docker compose down
```

---

## Development

```bash
# Install dependencies
npm install

# Run a specific package in dev mode
npm run dev --workspace=@yuan/orchestrator
npm run dev --workspace=@yuan/telegram-bot
npm run dev --workspace=@yuan/mcp-wechat
npm run dev --workspace=@yuan/mcp-whatsapp
npm run dev --workspace=@yuan/mcp-calendar
npm run dev --workspace=@yuan/scheduler

# Type check all packages
npm run typecheck --workspaces

# Build all packages
npm run build --workspaces
```

---

## Complete Claude Desktop Configuration

Here's a full configuration with all MCP servers enabled:

```json
{
  "mcpServers": {
    "wechat": {
      "command": "node",
      "args": ["/path/to/yuan/packages/mcp-wechat/dist/index.js"]
    },
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/yuan/packages/mcp-whatsapp/dist/index.js"],
      "env": {
        "WHATSAPP_SESSION_DIR": "/path/to/yuan/.wwebjs_auth"
      }
    },
    "calendar": {
      "command": "node",
      "args": ["/path/to/yuan/packages/mcp-calendar/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret",
        "GOOGLE_REFRESH_TOKEN": "your-refresh-token"
      }
    },
    "scheduler": {
      "command": "node",
      "args": ["/path/to/yuan/packages/scheduler/dist/mcp-server.js"],
      "env": {
        "ORCHESTRATOR_URL": "http://localhost:3000",
        "SCHEDULER_STORAGE_PATH": "/path/to/yuan/data/tasks.json"
      }
    }
  }
}
```

---

## Example Use Cases

### "Send a message to John on WhatsApp"
```
Use the whatsapp_send_message tool:
- recipient: "John"
- message: "Hey, are you free for lunch tomorrow?"
```

### "Create a reminder to review PRs every day at 2pm"
```
Use the scheduler_create_task tool:
- name: "PR Review Reminder"
- schedule: "every day at 2pm"
- action_type: "telegram"
- chat_id: "your-chat-id"
- message: "Time to review pending pull requests!"
```

### "Find a 1-hour free slot this week for a meeting"
```
Use the calendar_find_free_slots tool:
- startDate: "2024-01-15T00:00:00Z"
- endDate: "2024-01-19T23:59:59Z"
- duration: 60
- workingHoursStart: 9
- workingHoursEnd: 17
```

### "Check my calendar and send a summary to my WeChat"
```
1. Use calendar_list_events to get today's events
2. Format the summary
3. Use wechat_send_message to send to yourself
```

---

## License

MIT
