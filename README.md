# Yuan - Voice-to-Code Orchestrator

Yuan is a personal AI orchestration system that connects voice commands via Telegram to Claude Code, enabling hands-free software development. It also includes a Creative Agent that automatically generates project ideas based on your digital activity.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Interfaces                          │
├─────────────────────────────────────────────────────────────────┤
│  Telegram Bot          │  Creative Agent (automated)            │
│  - Voice commands      │  - Runs every 8 hours                  │
│  - Text instructions   │  - Analyzes Twitter + GitHub           │
│  - Approval buttons    │  - Generates project ideas             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Orchestrator                             │
├─────────────────────────────────────────────────────────────────┤
│  - Claude Code session management                               │
│  - Parallel task queue (multiple repos)                         │
│  - Approval gates for sensitive operations                      │
│  - Permission guards (blocks destructive operations)            │
│  - WebSocket real-time updates                                  │
│  - Usage tracking (/usage endpoint)                             │
└─────────────────────────────────────────────────────────────────┘
```

## Services

### 1. Orchestrator (`packages/orchestrator`)
The central nervous system. Manages Claude Code sessions, queues tasks, handles approvals, and enforces permissions.

**Endpoints:**
- `POST /instruction` - Submit a task
- `POST /approval-response` - Approve/reject sensitive operations
- `POST /input-response` - Provide input when Claude asks questions
- `GET /status` - Get queue and session status
- `GET /usage` - Get Claude API usage information
- `POST /reset` - Reset conversation history
- `POST /cancel` - Cancel running tasks

### 2. Telegram Bot (`packages/telegram-bot`)
Voice and text interface for interacting with the orchestrator.

**Features:**
- Voice message transcription (Whisper)
- Real-time task progress updates
- Inline approval buttons
- Conversation history per user

### 3. Creative Agent (`packages/creative-agent`)
Autonomous agent that analyzes your digital activity and generates project ideas.

**How it works:**
1. Runs every 8 hours via cron (`0 */8 * * *`)
2. Checks Claude API usage - skips if less than 50% remaining
3. Fetches recent data:
   - Twitter bookmarks and likes (last 8 hours)
   - GitHub activity: stars, pushes, issues, PRs (excluding ignored repos)
4. Analyzes patterns using Claude to identify:
   - Topics you're interested in
   - Problems you're thinking about
   - Tools you're exploring
   - Integration opportunities with existing projects
5. Generates 3 project ideas (mix of new projects + extensions to existing repos)
6. Sends ideas to Telegram with Approve/Skip buttons
7. On approval, queues the task to the orchestrator for execution

**Idea Types:**
- **New standalone projects** - Completely new tools inspired by your interests
- **Derivative/integration ideas** - Enhancements to your existing repositories based on what you're bookmarking/liking

## Prerequisites

- Docker and Docker Compose
- API keys:
  - Anthropic API key (for Claude)
  - Telegram Bot token
  - Twitter API v2 Bearer token (for Creative Agent)
  - GitHub personal access token

## Configuration

1. Copy `.env.example` to `.env` and configure:

```env
# Core
ORCHESTRATOR_SECRET=your_shared_secret
ORCHESTRATOR_PORT=3000

# GitHub
GITHUB_TOKEN=your_github_token
GITHUB_ORG=your_github_org
GITHUB_USERNAME=your_github_username

# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
ALLOWED_USER_IDS=123456789  # Comma-separated Telegram user IDs

# Creative Agent
TWITTER_BEARER_TOKEN=your_twitter_bearer_token
TELEGRAM_CHAT_ID=your_telegram_chat_id  # Where to send idea notifications
ANTHROPIC_API_KEY=your_anthropic_api_key
GITHUB_IGNORE_REPOS=repo1,repo2  # Repos to exclude from analysis (e.g., automated repos)

# Creative Agent Schedule (optional)
CREATIVE_AGENT_CRON=0 */8 * * *  # Default: every 8 hours
CREATIVE_AGENT_USAGE_THRESHOLD=50  # Default: run if >50% usage remaining
```

## Running with Docker Compose

Build and start all services:

```bash
docker compose up --build -d
```

View logs:

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f orchestrator
docker compose logs -f telegram-bot
docker compose logs -f creative-agent
```

Stop all services:

```bash
docker compose down
```

### First-time Claude Authentication

After starting the orchestrator, authenticate with Claude:

```bash
docker compose exec orchestrator claude login
```

## Manual Trigger (Creative Agent)

You can manually trigger the Creative Agent to run immediately:

```bash
curl -X POST http://localhost:3003/trigger \
  -H "Authorization: Bearer $ORCHESTRATOR_SECRET"
```

Check Creative Agent status:

```bash
curl http://localhost:3003/status
```

## Permission System

The orchestrator blocks destructive operations by default:

- `git push --force`
- `git reset --hard`
- Repository deletion
- Branch deletion on remote
- Sensitive file modifications

These operations are completely blocked and cannot be overridden.

## GitHub Ignore List

The Creative Agent ignores certain repositories when analyzing your GitHub activity. This is useful for:
- Repositories with automated daily commits
- Personal websites with frequent updates
- Any repos that would add noise to the analysis

Configure via `GITHUB_IGNORE_REPOS` environment variable:

```env
GITHUB_IGNORE_REPOS=yanki.dev,agentic-art,my-website
```

## Project Structure

```
yuan/
├── packages/
│   ├── orchestrator/       # Core orchestration service
│   │   └── src/
│   │       ├── server.ts           # HTTP/WebSocket server
│   │       ├── claude-code/        # Claude session management
│   │       ├── queue/              # Parallel task queue
│   │       ├── approval/           # Approval gates
│   │       └── permissions/        # Permission guards
│   ├── telegram-bot/       # Telegram interface
│   │   └── src/
│   │       ├── bot.ts              # Bot setup
│   │       ├── handlers/           # Message handlers
│   │       └── services/           # Orchestrator client
│   └── creative-agent/     # Autonomous idea generator
│       └── src/
│           ├── index.ts            # Entry point
│           ├── scheduler.ts        # Cron scheduling
│           ├── analyzer.ts         # Content analysis
│           ├── idea-generator.ts   # Idea generation
│           ├── telegram.ts         # Notification sending
│           ├── usage-checker.ts    # Usage monitoring
│           ├── config.ts           # Configuration
│           └── data-sources/       # Twitter & GitHub clients
├── docker-compose.yml
├── Dockerfile
└── .env
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ORCHESTRATOR_SECRET` | Yes | - | Shared authentication secret |
| `ORCHESTRATOR_PORT` | No | 3000 | Orchestrator HTTP port |
| `GITHUB_TOKEN` | Yes | - | GitHub personal access token |
| `GITHUB_ORG` | No | yankihue | Default GitHub organization |
| `GITHUB_USERNAME` | Yes* | - | GitHub username (for Creative Agent) |
| `TELEGRAM_BOT_TOKEN` | Yes | - | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Yes* | - | Chat ID for Creative Agent notifications |
| `ALLOWED_USER_IDS` | No | - | Restrict bot to specific users |
| `TWITTER_BEARER_TOKEN` | Yes* | - | Twitter API v2 bearer token |
| `ANTHROPIC_API_KEY` | Yes* | - | Anthropic API key |
| `GITHUB_IGNORE_REPOS` | No | yanki.dev,agentic-art | Repos to ignore in analysis |
| `CREATIVE_AGENT_CRON` | No | 0 */8 * * * | Cron schedule |
| `CREATIVE_AGENT_USAGE_THRESHOLD` | No | 50 | Min % remaining to run |
| `CREATIVE_AGENT_PORT` | No | 3003 | Creative Agent HTTP port |

*Required for Creative Agent functionality

## API Endpoints

### Orchestrator (port 3000)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/instruction` | POST | Submit task |
| `/approval-response` | POST | Respond to approval request |
| `/input-response` | POST | Provide input to Claude |
| `/status` | GET | Queue and session status |
| `/usage` | GET | Claude API usage |
| `/reset` | POST | Reset conversation |
| `/cancel` | POST | Cancel tasks |
| `/cancel-task` | POST | Cancel specific task |

### Creative Agent (port 3003)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check + next run time |
| `/status` | GET | Running state + schedule info |
| `/trigger` | POST | Manual trigger (requires auth) |

## Troubleshooting

### Claude authentication fails
```bash
docker compose exec orchestrator claude login
```

### Creative Agent not running
Check if usage threshold is met:
```bash
curl http://localhost:3000/usage -H "Authorization: Bearer $ORCHESTRATOR_SECRET"
```

### Twitter API errors
Ensure your bearer token has access to:
- `tweet.read`
- `users.read`
- `bookmark.read`
- `like.read`

### GitHub rate limiting
The Creative Agent makes several API calls per run. If rate limited, it will skip that run and try again next cycle.

## Security

**Important:** The `.env` file contains sensitive credentials and should never be committed to version control.

Ensure `.env` is in your `.gitignore`:
```
.env
.env.local
.env.*.local
```

### Twitter OAuth Setup

Twitter's bookmarks and likes endpoints require OAuth 2.0 User Context authentication (not App-Only bearer tokens). To set up:

1. Go to [Twitter Developer Portal](https://developer.twitter.com/) → Your App → User authentication settings
2. Enable OAuth 2.0
3. Set Type of App to "Web App"
4. Add callback URL: `http://localhost:3333/callback`
5. Save your Client ID and Client Secret to `.env`
6. Run the OAuth flow once to get your access token (see package docs)

### Token Refresh

Twitter access tokens expire after 2 hours. The refresh token can be used to get a new access token. Consider implementing automatic token refresh for production use.

## License

Private project - all rights reserved.
