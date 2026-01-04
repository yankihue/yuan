# @yuan/mcp-wechat

MCP (Model Context Protocol) server for WeChat integration. This package enables Claude and other MCP-compatible AI assistants to interact with WeChat through a standardized interface.

## Features

- Send messages to WeChat contacts
- List all contacts with filtering options
- Search contacts by name or alias
- Retrieve recent messages from specific contacts

## Prerequisites

- Node.js 18 or higher
- A WeChat account (personal account, not WeChat Work)
- The ability to scan QR codes for authentication

## Installation

From the project root:

```bash
npm install
```

Or install dependencies for this package only:

```bash
npm install --workspace=@yuan/mcp-wechat
```

## Building

```bash
npm run build --workspace=@yuan/mcp-wechat
```

## Usage

### Running the MCP Server

```bash
npm run start --workspace=@yuan/mcp-wechat
```

Or for development with hot-reload:

```bash
npm run dev --workspace=@yuan/mcp-wechat
```

### Configuring with Claude Desktop

Add the following to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "wechat": {
      "command": "node",
      "args": ["/path/to/yuan/packages/mcp-wechat/dist/index.js"]
    }
  }
}
```

### First-Time Login

When the server starts for the first time:

1. Watch the server logs for a QR code URL
2. Open the URL in a browser to see the QR code
3. Scan the QR code with your WeChat mobile app
4. The server will confirm successful login

The session is cached, so you won't need to scan again unless you log out or the session expires.

## Available Tools

### wechat_send_message

Send a text message to a WeChat contact.

**Parameters:**
- `contact_name` (required): The name or alias of the contact
- `message` (required): The message text to send

**Example:**
```json
{
  "contact_name": "John Doe",
  "message": "Hello from MCP!"
}
```

### wechat_get_contacts

Get a list of all WeChat contacts.

**Parameters:**
- `type` (optional): Filter by contact type - `all`, `individual`, `official`, or `corporation` (default: `all`)
- `limit` (optional): Maximum number of contacts to return (default: 50)

**Example:**
```json
{
  "type": "individual",
  "limit": 20
}
```

### wechat_search_contacts

Search for contacts by name or alias.

**Parameters:**
- `query` (required): Search query to match against contact names and aliases
- `limit` (optional): Maximum number of contacts to return (default: 20)

**Example:**
```json
{
  "query": "John",
  "limit": 10
}
```

### wechat_get_recent_messages

Get recent messages from a specific contact.

**Parameters:**
- `contact_name` (required): The name or alias of the contact
- `limit` (optional): Maximum number of messages to return (default: 20)

**Example:**
```json
{
  "contact_name": "John Doe",
  "limit": 10
}
```

## Architecture

```
packages/mcp-wechat/
├── src/
│   ├── index.ts         # MCP server entry point
│   ├── wechat-client.ts # Wechaty-based WeChat client
│   └── tools.ts         # MCP tool definitions and handlers
├── package.json
├── tsconfig.json
└── README.md
```

## Troubleshooting

### QR Code Not Showing

If you don't see the QR code URL in the logs, check that the server is running and watch stderr for output.

### Login Session Expired

If your session expires, restart the server and scan a new QR code.

### Contact Not Found

- Ensure the contact name is spelled correctly
- Try using the contact's alias if set
- Use `wechat_search_contacts` to find the exact name

### Messages Not Appearing

The server only stores messages received while it's running. Historical messages are not retrieved.

## Limitations

- Only text messages are supported (no images, files, etc.)
- Group chats are not fully supported yet
- Message history is limited to messages received while the server is running
- WeChat Web protocol limitations apply (some features may not work)

## Security Notes

- The WeChat session is stored locally on your machine
- Never share your session files or QR codes
- The server only exposes WeChat functionality through the MCP protocol
- All communication happens locally via stdio

## License

Private - All rights reserved
