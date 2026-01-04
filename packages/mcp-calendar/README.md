# @yuan/mcp-calendar

MCP (Model Context Protocol) server for calendar integration. Supports Google Calendar and Apple Calendar (via iCal export URLs).

## Features

- **calendar_list_calendars** - List all available calendars
- **calendar_list_events** - List upcoming events with date range filter
- **calendar_create_event** - Create a new calendar event (Google only)
- **calendar_update_event** - Update an existing event (Google only)
- **calendar_delete_event** - Delete an event (Google only)
- **calendar_check_availability** - Check if a time slot is free
- **calendar_find_free_slots** - Find available time slots

## Installation

```bash
npm install
npm run build
```

## Configuration

### Environment Variables

Create a `.env` file or set the following environment variables:

#### Google Calendar

```bash
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REFRESH_TOKEN=your-refresh-token
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback  # Optional
```

#### Apple Calendar (via iCal)

```bash
APPLE_CALENDARS='[{"id": "personal", "name": "Personal", "icalUrl": "https://p00-caldav.icloud.com/..."}]'
```

## Google Calendar OAuth2 Setup

### Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the **Google Calendar API**:
   - Go to **APIs & Services** > **Library**
   - Search for "Google Calendar API"
   - Click **Enable**

### Step 2: Create OAuth2 Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth client ID**
3. Select **Desktop app** as the application type
4. Give it a name (e.g., "MCP Calendar")
5. Click **Create**
6. Download the credentials JSON or note the **Client ID** and **Client Secret**

### Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services** > **OAuth consent screen**
2. Select **External** user type (or Internal if using Google Workspace)
3. Fill in the required fields:
   - App name
   - User support email
   - Developer contact email
4. Add scopes:
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/calendar.events`
5. Add your email as a test user (if External)

### Step 4: Get Refresh Token

You can use this simple script to get a refresh token:

```typescript
// oauth-helper.ts
import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';

const CLIENT_ID = 'your-client-id';
const CLIENT_SECRET = 'your-client-secret';
const REDIRECT_URI = 'http://localhost:3000/oauth/callback';

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
  ],
  prompt: 'consent',
});

console.log('Open this URL in your browser:', authUrl);

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/oauth/callback')) {
    const url = new URL(req.url, 'http://localhost:3000');
    const code = url.searchParams.get('code');

    if (code) {
      const { tokens } = await oauth2Client.getToken(code);
      console.log('\n=== TOKENS ===');
      console.log('Access Token:', tokens.access_token);
      console.log('Refresh Token:', tokens.refresh_token);
      console.log('\nAdd this to your .env:');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Success!</h1><p>You can close this window.</p>');
      server.close();
    }
  }
});

server.listen(3000, () => {
  console.log('Waiting for OAuth callback on http://localhost:3000');
});
```

Run with:

```bash
npx tsx oauth-helper.ts
```

## Apple Calendar Setup

Apple Calendar doesn't provide a direct API, but you can access calendars via their iCal export URLs.

### Getting iCal URLs from iCloud

1. Go to [icloud.com/calendar](https://www.icloud.com/calendar)
2. Click the share icon next to the calendar you want to export
3. Check "Public Calendar"
4. Copy the URL

### Getting iCal URLs from Calendar.app (macOS)

1. Open Calendar.app
2. Right-click on a calendar in the sidebar
3. Select "Share Calendar..."
4. Check "Public Calendar"
5. Copy the URL

### Configuration Format

```json
[
  {
    "id": "personal",
    "name": "Personal",
    "icalUrl": "webcal://p00-caldav.icloud.com/published/2/...",
    "color": "#ff0000"
  },
  {
    "id": "work",
    "name": "Work",
    "icalUrl": "https://calendar.google.com/calendar/ical/.../basic.ics"
  }
]
```

**Note:** Apple Calendar via iCal is **read-only**. To create, update, or delete events, use Google Calendar or the native Calendar.app.

## Usage with Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "calendar": {
      "command": "node",
      "args": ["/path/to/yuan/packages/mcp-calendar/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret",
        "GOOGLE_REFRESH_TOKEN": "your-refresh-token",
        "APPLE_CALENDARS": "[{\"id\": \"personal\", \"name\": \"Personal\", \"icalUrl\": \"https://...\"}]"
      }
    }
  }
}
```

## Usage with MCP CLI

```bash
# Run the server directly
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... node dist/index.js
```

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build

# Type check
npm run typecheck
```

## Tool Examples

### List Events

```json
{
  "tool": "calendar_list_events",
  "arguments": {
    "startDate": "2024-01-15T00:00:00Z",
    "endDate": "2024-01-22T00:00:00Z",
    "provider": "all"
  }
}
```

### Create Event

```json
{
  "tool": "calendar_create_event",
  "arguments": {
    "title": "Team Meeting",
    "description": "Weekly sync",
    "start": "2024-01-16T10:00:00Z",
    "end": "2024-01-16T11:00:00Z",
    "attendees": ["alice@example.com", "bob@example.com"]
  }
}
```

### Find Free Slots

```json
{
  "tool": "calendar_find_free_slots",
  "arguments": {
    "startDate": "2024-01-15T00:00:00Z",
    "endDate": "2024-01-19T00:00:00Z",
    "duration": 60,
    "workingHoursStart": 9,
    "workingHoursEnd": 17
  }
}
```

### Check Availability

```json
{
  "tool": "calendar_check_availability",
  "arguments": {
    "start": "2024-01-16T14:00:00Z",
    "end": "2024-01-16T15:00:00Z"
  }
}
```

## License

MIT
