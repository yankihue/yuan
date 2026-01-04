# @yuan/scheduler

Cron-like scheduler service for the Yuan second brain project. Supports recurring tasks via cron expressions, natural language schedules, and one-time tasks.

## Features

- **Recurring Tasks**: Use cron expressions or natural language ("every day at 2pm", "every monday at 9am")
- **One-time Tasks**: Schedule tasks for a specific time ("in 30 minutes", "tomorrow at 3pm")
- **Multiple Action Types**:
  - `orchestrator` - Send instructions to the Yuan orchestrator
  - `telegram` - Send messages via Telegram bot
  - `webhook` - Call external HTTP endpoints
- **Persistence**: Tasks are saved to JSON file and survive restarts
- **Dual Interface**: HTTP REST API and MCP server for AI assistant integration
- **Natural Language Parsing**: Uses chrono-node for flexible time expressions

## Installation

```bash
npm install
npm run build --workspace=@yuan/scheduler
```

## Configuration

Set the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `SCHEDULER_STORAGE_PATH` | Path to JSON file for task persistence | `./data/tasks.json` |
| `ORCHESTRATOR_URL` | URL of the Yuan orchestrator service | `http://localhost:3000` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (for telegram actions) | - |
| `TZ` | Timezone for scheduling | `UTC` |
| `SCHEDULER_PORT` | HTTP API port | `3002` |

## Usage

### Running the HTTP API + Scheduler

```bash
npm run start --workspace=@yuan/scheduler
```

This starts:
- HTTP REST API on port 3002
- Background scheduler that executes tasks

### Running as MCP Server

```bash
npm run mcp --workspace=@yuan/scheduler
```

This starts the scheduler as an MCP server (stdio transport) for integration with AI assistants.

### Claude Desktop Configuration

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "scheduler": {
      "command": "node",
      "args": ["/path/to/yuan/packages/scheduler/dist/mcp-server.js"],
      "env": {
        "ORCHESTRATOR_URL": "http://localhost:3000",
        "TELEGRAM_BOT_TOKEN": "your-bot-token",
        "SCHEDULER_STORAGE_PATH": "/path/to/tasks.json"
      }
    }
  }
}
```

## MCP Tools

### scheduler_create_task

Create a new scheduled task.

**Parameters:**
- `name` (required): Human-readable task name
- `description` (optional): Task description
- `schedule` (required): Schedule specification (cron, natural language, or one-time)
- `action_type` (required): `orchestrator`, `telegram`, or `webhook`
- Additional parameters based on action type:
  - **orchestrator**: `instruction`, `repo`
  - **telegram**: `chat_id`, `message`
  - **webhook**: `url`, `method`, `headers`, `body`

**Examples:**

```json
// Recurring orchestrator task
{
  "name": "Daily TODO Summary",
  "schedule": "every day at 2pm",
  "action_type": "orchestrator",
  "instruction": "Look at my TODO items and summarize them"
}

// One-time telegram message
{
  "name": "Reminder",
  "schedule": "in 30 minutes",
  "action_type": "telegram",
  "chat_id": "123456789",
  "message": "Time to take a break!"
}

// Recurring webhook call
{
  "name": "Health Check",
  "schedule": "*/5 * * * *",
  "action_type": "webhook",
  "url": "https://api.example.com/health",
  "method": "GET"
}
```

### scheduler_list_tasks

List all scheduled tasks.

**Parameters:**
- `status` (optional): Filter by status (`active`, `paused`, `completed`, `failed`)

### scheduler_delete_task

Delete a task by ID.

**Parameters:**
- `task_id` (required): Task ID to delete

### scheduler_pause_task

Pause a recurring task.

**Parameters:**
- `task_id` (required): Task ID to pause

### scheduler_resume_task

Resume a paused task.

**Parameters:**
- `task_id` (required): Task ID to resume

## HTTP REST API

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/tasks` | List all tasks |
| GET | `/api/tasks/:id` | Get a specific task |
| POST | `/api/tasks` | Create a new task |
| DELETE | `/api/tasks/:id` | Delete a task |
| POST | `/api/tasks/:id/pause` | Pause a task |
| POST | `/api/tasks/:id/resume` | Resume a task |

### Example: Create Task via HTTP

```bash
curl -X POST http://localhost:3002/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily Summary",
    "schedule": "every day at 9am",
    "action": {
      "type": "orchestrator",
      "instruction": "Generate a summary of my tasks for today"
    }
  }'
```

## Schedule Formats

### Cron Expressions

Standard 5-field cron format: `minute hour day-of-month month day-of-week`

```
0 14 * * *      # Every day at 2:00 PM
0 9 * * 1       # Every Monday at 9:00 AM
*/15 * * * *    # Every 15 minutes
0 0 1 * *       # First day of every month at midnight
```

### Natural Language (Recurring)

```
every minute
every hour
every day at 2pm
every monday at 9am
every friday at 5:30pm
daily at 10am
weekly on saturday at noon
```

### Natural Language (One-time)

```
in 30 minutes
in 2 hours
tomorrow at 3pm
next monday at 10am
january 15 at 2pm
```

## Architecture

```
packages/scheduler/
├── src/
│   ├── index.ts        # HTTP API + scheduler service entry point
│   ├── mcp-server.ts   # MCP server entry point
│   ├── scheduler.ts    # Core scheduling logic with node-cron
│   ├── executor.ts     # Task execution for different action types
│   ├── storage.ts      # JSON file-based task persistence
│   └── types.ts        # TypeScript interfaces
├── package.json
├── tsconfig.json
└── README.md
```

## Development

```bash
# Watch mode
npm run dev --workspace=@yuan/scheduler

# Type checking
npm run typecheck --workspace=@yuan/scheduler

# Build
npm run build --workspace=@yuan/scheduler
```

## License

MIT
