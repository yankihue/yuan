import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { WhatsAppClient } from "./whatsapp-client.js";

/**
 * Tool definitions and handlers for the WhatsApp MCP server
 */

export const toolDefinitions: Tool[] = [
  {
    name: "whatsapp_send_message",
    description:
      "Send a text message to a WhatsApp contact or group by name. The recipient can be a contact name or group name.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: {
          type: "string",
          description: "The name of the contact or group to send the message to",
        },
        message: {
          type: "string",
          description: "The text message to send",
        },
      },
      required: ["recipient", "message"],
    },
  },
  {
    name: "whatsapp_get_contacts",
    description:
      "Get a list of all WhatsApp contacts. Returns contact names, IDs, and whether they are groups or individual contacts.",
    inputSchema: {
      type: "object",
      properties: {
        includeGroups: {
          type: "boolean",
          description: "Whether to include groups in the results (default: true)",
        },
        onlyMyContacts: {
          type: "boolean",
          description: "Only return contacts that are saved in your phone (default: false)",
        },
      },
    },
  },
  {
    name: "whatsapp_search_contacts",
    description:
      "Search for WhatsApp contacts by name. Performs a case-insensitive partial match on contact names.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to match against contact names",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "whatsapp_get_chats",
    description:
      "Get a list of recent WhatsApp chats, including the last message and unread count for each chat.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of chats to return (default: 20, max: 100)",
        },
      },
    },
  },
  {
    name: "whatsapp_get_messages",
    description:
      "Get messages from a specific WhatsApp chat by contact or group name.",
    inputSchema: {
      type: "object",
      properties: {
        chatName: {
          type: "string",
          description: "The name of the contact or group to get messages from",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return (default: 50, max: 500)",
        },
      },
      required: ["chatName"],
    },
  },
  {
    name: "whatsapp_send_media",
    description:
      "Send an image or document file to a WhatsApp contact or group by name.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: {
          type: "string",
          description: "The name of the contact or group to send the media to",
        },
        filePath: {
          type: "string",
          description: "The absolute path to the file to send",
        },
        caption: {
          type: "string",
          description: "Optional caption to include with the media",
        },
        asDocument: {
          type: "boolean",
          description: "Send as document instead of image (preserves original quality/format)",
        },
      },
      required: ["recipient", "filePath"],
    },
  },
];

export class ToolHandler {
  private client: WhatsAppClient;

  constructor(client: WhatsAppClient) {
    this.client = client;
  }

  async handleToolCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      switch (name) {
        case "whatsapp_send_message":
          return await this.handleSendMessage(args);
        case "whatsapp_get_contacts":
          return await this.handleGetContacts(args);
        case "whatsapp_search_contacts":
          return await this.handleSearchContacts(args);
        case "whatsapp_get_chats":
          return await this.handleGetChats(args);
        case "whatsapp_get_messages":
          return await this.handleGetMessages(args);
        case "whatsapp_send_media":
          return await this.handleSendMedia(args);
        default:
          return this.errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.errorResult(`Error executing ${name}: ${message}`);
    }
  }

  private async handleSendMessage(args: Record<string, unknown>): Promise<CallToolResult> {
    const recipient = args.recipient as string;
    const message = args.message as string;

    if (!recipient || !message) {
      return this.errorResult("Missing required parameters: recipient and message");
    }

    const result = await this.client.sendMessage(recipient, message);
    return this.successResult({
      success: true,
      messageId: result.messageId,
      chatId: result.chatId,
      message: `Message sent successfully to ${recipient}`,
    });
  }

  private async handleGetContacts(args: Record<string, unknown>): Promise<CallToolResult> {
    const includeGroups = args.includeGroups !== false;
    const onlyMyContacts = args.onlyMyContacts === true;

    let contacts = await this.client.getContacts();

    if (!includeGroups) {
      contacts = contacts.filter((c) => !c.isGroup);
    }

    if (onlyMyContacts) {
      contacts = contacts.filter((c) => c.isMyContact);
    }

    return this.successResult({
      count: contacts.length,
      contacts: contacts.slice(0, 100).map((c) => ({
        name: c.name,
        id: c.id,
        isGroup: c.isGroup,
        isMyContact: c.isMyContact,
      })),
    });
  }

  private async handleSearchContacts(args: Record<string, unknown>): Promise<CallToolResult> {
    const query = args.query as string;

    if (!query) {
      return this.errorResult("Missing required parameter: query");
    }

    const contacts = await this.client.searchContacts(query);

    return this.successResult({
      query,
      count: contacts.length,
      contacts: contacts.slice(0, 50).map((c) => ({
        name: c.name,
        id: c.id,
        isGroup: c.isGroup,
        isMyContact: c.isMyContact,
      })),
    });
  }

  private async handleGetChats(args: Record<string, unknown>): Promise<CallToolResult> {
    const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100);

    const chats = await this.client.getChats(limit);

    return this.successResult({
      count: chats.length,
      chats: chats.map((c) => ({
        name: c.name,
        id: c.id,
        isGroup: c.isGroup,
        unreadCount: c.unreadCount,
        lastMessage: c.lastMessage
          ? {
              preview: c.lastMessage.body.substring(0, 100),
              fromMe: c.lastMessage.fromMe,
              timestamp: new Date(c.lastMessage.timestamp * 1000).toISOString(),
            }
          : null,
      })),
    });
  }

  private async handleGetMessages(args: Record<string, unknown>): Promise<CallToolResult> {
    const chatName = args.chatName as string;
    const limit = Math.min(Math.max(1, Number(args.limit) || 50), 500);

    if (!chatName) {
      return this.errorResult("Missing required parameter: chatName");
    }

    const messages = await this.client.getMessages(chatName, limit);

    return this.successResult({
      chatName,
      count: messages.length,
      messages: messages.map((m) => ({
        id: m.id,
        body: m.body.substring(0, 500),
        fromMe: m.fromMe,
        timestamp: new Date(m.timestamp * 1000).toISOString(),
        type: m.type,
        hasMedia: m.hasMedia,
      })),
    });
  }

  private async handleSendMedia(args: Record<string, unknown>): Promise<CallToolResult> {
    const recipient = args.recipient as string;
    const filePath = args.filePath as string;
    const caption = args.caption as string | undefined;
    const asDocument = args.asDocument === true;

    if (!recipient || !filePath) {
      return this.errorResult("Missing required parameters: recipient and filePath");
    }

    const result = await this.client.sendMedia(recipient, filePath, caption, asDocument);

    return this.successResult({
      success: true,
      messageId: result.messageId,
      chatId: result.chatId,
      message: `Media sent successfully to ${recipient}`,
    });
  }

  private successResult(data: unknown): CallToolResult {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2),
        },
      ],
    };
  }

  private errorResult(message: string): CallToolResult {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message }, null, 2),
        },
      ],
      isError: true,
    };
  }
}
