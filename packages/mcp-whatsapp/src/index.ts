#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WhatsAppClient } from "./whatsapp-client.js";
import { toolDefinitions, ToolHandler } from "./tools.js";

/**
 * WhatsApp MCP Server
 *
 * Provides MCP tools for interacting with WhatsApp via whatsapp-web.js.
 * Handles QR code authentication and session persistence automatically.
 */

class WhatsAppMCPServer {
  private server: Server;
  private whatsappClient: WhatsAppClient;
  private toolHandler: ToolHandler;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.server = new Server(
      {
        name: "whatsapp-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.whatsappClient = new WhatsAppClient({
      sessionDir: process.env.WHATSAPP_SESSION_DIR,
      clientId: process.env.WHATSAPP_CLIENT_ID || "mcp-whatsapp",
      headless: process.env.WHATSAPP_HEADLESS !== "false",
    });

    this.toolHandler = new ToolHandler(this.whatsappClient);

    this.setupHandlers();
    this.setupWhatsAppEvents();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: toolDefinitions,
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      // Ensure WhatsApp client is initialized before handling any tool call
      await this.ensureInitialized();

      // Check if client is ready
      if (this.whatsappClient.state !== "ready") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `WhatsApp client is not ready. Current state: ${this.whatsappClient.state}. Please wait for QR code scan if authentication is pending.`,
              }),
            },
          ],
          isError: true,
        };
      }

      return await this.toolHandler.handleToolCall(name, (args || {}) as Record<string, unknown>);
    });
  }

  private setupWhatsAppEvents(): void {
    this.whatsappClient.on("state_change", (state) => {
      console.error(`[MCP-WhatsApp] Client state changed: ${state}`);
    });

    this.whatsappClient.on("qr", () => {
      console.error("[MCP-WhatsApp] QR code displayed. Please scan with WhatsApp mobile app.");
    });

    this.whatsappClient.on("authenticated", () => {
      console.error("[MCP-WhatsApp] Successfully authenticated!");
    });

    this.whatsappClient.on("ready", () => {
      console.error("[MCP-WhatsApp] WhatsApp client is ready to receive commands.");
    });

    this.whatsappClient.on("disconnected", (reason) => {
      console.error(`[MCP-WhatsApp] Disconnected: ${reason}. Will attempt to reconnect...`);
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.whatsappClient.state === "ready") {
      return;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    if (this.isInitializing) {
      // Wait for initialization to complete
      return new Promise((resolve) => {
        const checkState = () => {
          if (this.whatsappClient.state === "ready" || !this.isInitializing) {
            resolve();
          } else {
            setTimeout(checkState, 100);
          }
        };
        checkState();
      });
    }

    this.isInitializing = true;
    this.initPromise = this.whatsappClient.initialize().finally(() => {
      this.isInitializing = false;
      this.initPromise = null;
    });

    return this.initPromise;
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();

    console.error("[MCP-WhatsApp] Starting WhatsApp MCP Server...");
    console.error("[MCP-WhatsApp] Initializing WhatsApp client (this may take a moment)...");

    // Start initializing WhatsApp client in the background
    this.ensureInitialized().catch((error) => {
      console.error("[MCP-WhatsApp] Failed to initialize WhatsApp client:", error);
    });

    await this.server.connect(transport);
    console.error("[MCP-WhatsApp] MCP Server connected and ready to accept requests.");

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.error("[MCP-WhatsApp] Shutting down...");
      await this.whatsappClient.destroy();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.error("[MCP-WhatsApp] Shutting down...");
      await this.whatsappClient.destroy();
      process.exit(0);
    });
  }
}

// Main entry point
const server = new WhatsAppMCPServer();
server.run().catch((error) => {
  console.error("[MCP-WhatsApp] Fatal error:", error);
  process.exit(1);
});
