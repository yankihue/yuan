# @yuan/mcp-whatsapp

MCP (Model Context Protocol) server for WhatsApp integration. This package enables AI assistants to interact with WhatsApp through a set of tools for sending messages, managing contacts, and retrieving chat history.

## Features

- Send text messages to contacts or groups by name
- Send images and documents with optional captions
- List and search contacts
- Retrieve recent chats with unread counts
- Fetch message history from specific chats
- Automatic session persistence (no need to re-scan QR code)
- Graceful reconnection handling

## Prerequisites

- Node.js 18 or higher
- A WhatsApp account
- Chrome/Chromium browser (installed automatically by Puppeteer)

## Installation

From the monorepo root:

```bash
npm install
npm run build --workspace=@yuan/mcp-whatsapp
```

## Authentication (QR Code Flow)

When you first run the MCP server, you will need to authenticate with WhatsApp:

1. Start the server (or trigger a tool call that initializes it)
2. A QR code will be displayed in the terminal (via stderr)
3. Open WhatsApp on your phone
4. Go to **Settings > Linked Devices > Link a Device**
5. Scan the QR code displayed in the terminal
6. Wait for authentication to complete

The session is automatically saved, so you won't need to scan again unless:
- You log out
- The session expires (typically after ~20 days of inactivity)
- You delete the `.wwebjs_auth` directory

## Configuration

The server can be configured via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `WHATSAPP_SESSION_DIR` | Directory for session persistence | `./.wwebjs_auth` |
| `WHATSAPP_CLIENT_ID` | Client identifier for multi-account support | `mcp-whatsapp` |
| `WHATSAPP_HEADLESS` | Run browser in headless mode | `true` |

## Usage with Claude Desktop

Add this configuration to your Claude Desktop config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/yuan/packages/mcp-whatsapp/dist/index.js"],
      "env": {
        "WHATSAPP_SESSION_DIR": "/path/to/persistent/session/dir"
      }
    }
  }
}
```

Or if using `npx` from the monorepo:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "npm",
      "args": ["run", "start", "--workspace=@yuan/mcp-whatsapp"],
      "cwd": "/path/to/yuan"
    }
  }
}
```

## Available Tools

### whatsapp_send_message

Send a text message to a contact or group.

**Parameters:**
- `recipient` (required): Name of the contact or group
- `message` (required): Text message to send

**Example:**
```json
{
  "recipient": "John Doe",
  "message": "Hello! This is a test message."
}
```

### whatsapp_get_contacts

List all WhatsApp contacts.

**Parameters:**
- `includeGroups` (optional): Include groups in results (default: true)
- `onlyMyContacts` (optional): Only return saved contacts (default: false)

### whatsapp_search_contacts

Search contacts by name (case-insensitive partial match).

**Parameters:**
- `query` (required): Search term to match against contact names

### whatsapp_get_chats

Get recent chats with last message preview.

**Parameters:**
- `limit` (optional): Maximum chats to return (default: 20, max: 100)

### whatsapp_get_messages

Retrieve messages from a specific chat.

**Parameters:**
- `chatName` (required): Name of the contact or group
- `limit` (optional): Maximum messages to return (default: 50, max: 500)

### whatsapp_send_media

Send an image or document to a contact or group.

**Parameters:**
- `recipient` (required): Name of the contact or group
- `filePath` (required): Absolute path to the file
- `caption` (optional): Caption for the media
- `asDocument` (optional): Send as document instead of image (default: false)

## Development

```bash
# Run in development mode (with hot reload)
npm run dev --workspace=@yuan/mcp-whatsapp

# Type checking
npm run typecheck --workspace=@yuan/mcp-whatsapp

# Build for production
npm run build --workspace=@yuan/mcp-whatsapp
```

## Troubleshooting

### QR code not displaying
- Ensure your terminal supports Unicode characters
- Check stderr output (QR codes are sent to stderr, not stdout)

### Authentication keeps failing
- Delete the `.wwebjs_auth` directory and try again
- Ensure WhatsApp is not logged into too many devices (max 4 linked devices)

### Browser fails to launch
- Try setting `WHATSAPP_HEADLESS=false` to see the browser window
- Ensure you have sufficient system resources
- On Linux, you may need to install additional dependencies for Chromium

### Session expired
- Delete the `.wwebjs_auth` directory
- Restart the server and scan the QR code again

## Security Considerations

- The session data in `.wwebjs_auth` contains sensitive authentication tokens
- Never share or commit this directory
- Consider using encrypted storage for the session directory in production
- The MCP server should only be accessible by trusted clients

## License

MIT
