#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from 'dotenv';

import { getWeChatClient } from './wechat-client.js';
import { toolDefinitions, handleToolCall } from './tools.js';

// Load environment variables
config();

const server = new Server(
  {
    name: 'mcp-wechat',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: toolDefinitions,
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleToolCall(name, args);
    return {
      content: [
        {
          type: 'text',
          text: result,
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: errorMessage,
          }),
        },
      ],
      isError: true,
    };
  }
});

// Initialize WeChat client and start server
async function main() {
  console.error('Starting MCP WeChat server...');

  // Initialize WeChat client
  const wechatClient = getWeChatClient();

  wechatClient.on('scan', ({ qrcodeUrl }) => {
    console.error(`Please scan QR code to login: ${qrcodeUrl}`);
  });

  wechatClient.on('login', ({ name }) => {
    console.error(`Logged in as: ${name}`);
  });

  wechatClient.on('logout', ({ name }) => {
    console.error(`Logged out: ${name}`);
  });

  wechatClient.on('error', (error) => {
    console.error('WeChat error:', error);
  });

  // Initialize WeChat in the background
  wechatClient.initialize().catch((error) => {
    console.error('Failed to initialize WeChat client:', error);
  });

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP WeChat server running on stdio');
}

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  console.error('Shutting down...');
  const client = getWeChatClient();
  await client.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('Shutting down...');
  const client = getWeChatClient();
  await client.stop();
  process.exit(0);
});

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
