import { z } from 'zod';
import { getWeChatClient } from './wechat-client.js';

// Tool schemas
export const sendMessageSchema = z.object({
  contact_name: z.string().describe('The name or alias of the contact to send the message to'),
  message: z.string().describe('The message text to send'),
});

export const getContactsSchema = z.object({
  type: z.enum(['all', 'individual', 'official', 'corporation'])
    .optional()
    .default('all')
    .describe('Filter contacts by type'),
  limit: z.number()
    .optional()
    .default(50)
    .describe('Maximum number of contacts to return'),
});

export const searchContactsSchema = z.object({
  query: z.string().describe('Search query to match against contact names and aliases'),
  limit: z.number()
    .optional()
    .default(20)
    .describe('Maximum number of contacts to return'),
});

export const getRecentMessagesSchema = z.object({
  contact_name: z.string().describe('The name or alias of the contact to get messages from'),
  limit: z.number()
    .optional()
    .default(20)
    .describe('Maximum number of messages to return'),
});

// Tool definitions for MCP
export const toolDefinitions = [
  {
    name: 'wechat_send_message',
    description: 'Send a text message to a WeChat contact by their name or alias',
    inputSchema: {
      type: 'object' as const,
      properties: {
        contact_name: {
          type: 'string',
          description: 'The name or alias of the contact to send the message to',
        },
        message: {
          type: 'string',
          description: 'The message text to send',
        },
      },
      required: ['contact_name', 'message'],
    },
  },
  {
    name: 'wechat_get_contacts',
    description: 'Get a list of all WeChat contacts. Can filter by contact type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['all', 'individual', 'official', 'corporation'],
          description: 'Filter contacts by type (default: all)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of contacts to return (default: 50)',
        },
      },
      required: [],
    },
  },
  {
    name: 'wechat_search_contacts',
    description: 'Search for WeChat contacts by name or alias',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against contact names and aliases',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of contacts to return (default: 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'wechat_get_recent_messages',
    description: 'Get recent messages from a specific WeChat contact',
    inputSchema: {
      type: 'object' as const,
      properties: {
        contact_name: {
          type: 'string',
          description: 'The name or alias of the contact to get messages from',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return (default: 20)',
        },
      },
      required: ['contact_name'],
    },
  },
];

// Tool handlers
export async function handleSendMessage(args: unknown): Promise<string> {
  const parsed = sendMessageSchema.parse(args);
  const client = getWeChatClient();

  if (!client.isReady()) {
    return JSON.stringify({
      success: false,
      error: 'WeChat client is not logged in. Please scan the QR code to login first.',
    });
  }

  const result = await client.sendMessage(parsed.contact_name, parsed.message);
  return JSON.stringify(result);
}

export async function handleGetContacts(args: unknown): Promise<string> {
  const parsed = getContactsSchema.parse(args);
  const client = getWeChatClient();

  if (!client.isReady()) {
    return JSON.stringify({
      success: false,
      error: 'WeChat client is not logged in. Please scan the QR code to login first.',
      contacts: [],
    });
  }

  let contacts = await client.getContacts();

  // Filter by type if specified
  if (parsed.type !== 'all') {
    contacts = contacts.filter(c => c.type === parsed.type);
  }

  // Apply limit
  contacts = contacts.slice(0, parsed.limit);

  return JSON.stringify({
    success: true,
    count: contacts.length,
    contacts,
  });
}

export async function handleSearchContacts(args: unknown): Promise<string> {
  const parsed = searchContactsSchema.parse(args);
  const client = getWeChatClient();

  if (!client.isReady()) {
    return JSON.stringify({
      success: false,
      error: 'WeChat client is not logged in. Please scan the QR code to login first.',
      contacts: [],
    });
  }

  let contacts = await client.searchContacts(parsed.query);
  contacts = contacts.slice(0, parsed.limit);

  return JSON.stringify({
    success: true,
    query: parsed.query,
    count: contacts.length,
    contacts,
  });
}

export async function handleGetRecentMessages(args: unknown): Promise<string> {
  const parsed = getRecentMessagesSchema.parse(args);
  const client = getWeChatClient();

  if (!client.isReady()) {
    return JSON.stringify({
      success: false,
      error: 'WeChat client is not logged in. Please scan the QR code to login first.',
      messages: [],
    });
  }

  const messages = await client.getRecentMessages(parsed.contact_name, parsed.limit);

  return JSON.stringify({
    success: true,
    contact: parsed.contact_name,
    count: messages.length,
    messages,
  });
}

// Router for tool calls
export async function handleToolCall(name: string, args: unknown): Promise<string> {
  switch (name) {
    case 'wechat_send_message':
      return handleSendMessage(args);
    case 'wechat_get_contacts':
      return handleGetContacts(args);
    case 'wechat_search_contacts':
      return handleSearchContacts(args);
    case 'wechat_get_recent_messages':
      return handleGetRecentMessages(args);
    default:
      return JSON.stringify({
        success: false,
        error: `Unknown tool: ${name}`,
      });
  }
}
