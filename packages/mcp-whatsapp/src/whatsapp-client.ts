import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import type { Client as ClientType, Message, Contact, Chat } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import { EventEmitter } from "events";
import { SessionManager } from "./session.js";

export interface WhatsAppClientOptions {
  sessionDir?: string;
  clientId?: string;
  headless?: boolean;
}

export interface ContactInfo {
  id: string;
  name: string;
  pushname?: string;
  shortName?: string;
  isGroup: boolean;
  isMyContact: boolean;
}

export interface ChatInfo {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  lastMessage?: {
    body: string;
    timestamp: number;
    fromMe: boolean;
  };
}

export interface MessageInfo {
  id: string;
  body: string;
  timestamp: number;
  fromMe: boolean;
  from: string;
  to: string;
  hasMedia: boolean;
  type: string;
}

export type ClientState = "disconnected" | "connecting" | "qr_pending" | "authenticated" | "ready";

export class WhatsAppClient extends EventEmitter {
  private client: ClientType | null = null;
  private sessionManager: SessionManager;
  private _state: ClientState = "disconnected";
  private clientId: string;
  private headless: boolean;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 5000;

  constructor(options: WhatsAppClientOptions = {}) {
    super();
    this.sessionManager = new SessionManager(options.sessionDir);
    this.clientId = options.clientId || "default";
    this.headless = options.headless ?? true;
  }

  get state(): ClientState {
    return this._state;
  }

  private setState(state: ClientState): void {
    this._state = state;
    this.emit("state_change", state);
  }

  /**
   * Initialize and connect the WhatsApp client
   */
  async initialize(): Promise<void> {
    if (this.client) {
      console.error("[WhatsApp] Client already initialized");
      return;
    }

    this.setState("connecting");

    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.clientId,
        dataPath: this.sessionManager.getSessionPath(),
      }),
      puppeteer: {
        headless: this.headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
        ],
      },
    });

    this.setupEventHandlers();

    try {
      await this.client.initialize();
    } catch (error) {
      console.error("[WhatsApp] Failed to initialize client:", error);
      this.setState("disconnected");
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.client) return;

    this.client.on("qr", (qr: string) => {
      this.setState("qr_pending");
      console.error("\n[WhatsApp] Scan the QR code below to authenticate:");
      qrcode.generate(qr, { small: true });
      this.emit("qr", qr);
    });

    this.client.on("authenticated", () => {
      this.setState("authenticated");
      console.error("[WhatsApp] Authentication successful");
      this.sessionManager.saveSession(this.clientId).catch(console.error);
      this.emit("authenticated");
    });

    this.client.on("auth_failure", (message: string) => {
      console.error("[WhatsApp] Authentication failed:", message);
      this.setState("disconnected");
      this.emit("auth_failure", message);
    });

    this.client.on("ready", () => {
      this.setState("ready");
      this.reconnectAttempts = 0;
      console.error("[WhatsApp] Client is ready");
      this.emit("ready");
    });

    this.client.on("disconnected", (reason: string) => {
      console.error("[WhatsApp] Client disconnected:", reason);
      this.setState("disconnected");
      this.emit("disconnected", reason);
      this.handleDisconnect();
    });

    this.client.on("message", (message: Message) => {
      this.emit("message", message);
    });
  }

  private async handleDisconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[WhatsApp] Max reconnection attempts reached");
      return;
    }

    this.reconnectAttempts++;
    console.error(
      `[WhatsApp] Attempting reconnection (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay / 1000}s...`
    );

    await new Promise((resolve) => setTimeout(resolve, this.reconnectDelay));

    try {
      this.client = null;
      await this.initialize();
    } catch (error) {
      console.error("[WhatsApp] Reconnection failed:", error);
    }
  }

  /**
   * Ensure client is ready before performing operations
   */
  private ensureReady(): void {
    if (!this.client || this._state !== "ready") {
      throw new Error("WhatsApp client is not ready. Current state: " + this._state);
    }
  }

  /**
   * Send a text message to a contact or group by name
   */
  async sendMessage(recipientName: string, message: string): Promise<{ success: boolean; messageId?: string; chatId?: string }> {
    this.ensureReady();

    const chat = await this.findChatByName(recipientName);
    if (!chat) {
      throw new Error(`Could not find contact or group with name: ${recipientName}`);
    }

    const sentMessage = await chat.sendMessage(message);
    return {
      success: true,
      messageId: sentMessage.id.id,
      chatId: chat.id._serialized,
    };
  }

  /**
   * Send media (image/document) to a contact or group
   */
  async sendMedia(
    recipientName: string,
    mediaPath: string,
    caption?: string,
    isDocument?: boolean
  ): Promise<{ success: boolean; messageId?: string; chatId?: string }> {
    this.ensureReady();

    const chat = await this.findChatByName(recipientName);
    if (!chat) {
      throw new Error(`Could not find contact or group with name: ${recipientName}`);
    }

    const media = MessageMedia.fromFilePath(mediaPath);
    const sentMessage = await chat.sendMessage(media, {
      caption,
      sendMediaAsDocument: isDocument,
    });

    return {
      success: true,
      messageId: sentMessage.id.id,
      chatId: chat.id._serialized,
    };
  }

  /**
   * Get all contacts
   */
  async getContacts(): Promise<ContactInfo[]> {
    this.ensureReady();

    const contacts = await this.client!.getContacts();
    return contacts.map((contact: Contact) => ({
      id: contact.id._serialized,
      name: contact.name || contact.pushname || contact.number || "Unknown",
      pushname: contact.pushname,
      shortName: contact.shortName,
      isGroup: contact.isGroup,
      isMyContact: contact.isMyContact,
    }));
  }

  /**
   * Search contacts by name (case-insensitive partial match)
   */
  async searchContacts(query: string): Promise<ContactInfo[]> {
    const contacts = await this.getContacts();
    const lowerQuery = query.toLowerCase();

    return contacts.filter((contact) => {
      const name = contact.name?.toLowerCase() || "";
      const pushname = contact.pushname?.toLowerCase() || "";
      const shortName = contact.shortName?.toLowerCase() || "";
      return name.includes(lowerQuery) || pushname.includes(lowerQuery) || shortName.includes(lowerQuery);
    });
  }

  /**
   * Get recent chats
   */
  async getChats(limit = 20): Promise<ChatInfo[]> {
    this.ensureReady();

    const chats = await this.client!.getChats();
    const sortedChats = chats
      .sort((a: Chat, b: Chat) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, limit);

    return Promise.all(
      sortedChats.map(async (chat: Chat) => {
        const lastMessage = chat.lastMessage;
        return {
          id: chat.id._serialized,
          name: chat.name,
          isGroup: chat.isGroup,
          unreadCount: chat.unreadCount,
          lastMessage: lastMessage
            ? {
                body: lastMessage.body || "[Media]",
                timestamp: lastMessage.timestamp,
                fromMe: lastMessage.fromMe,
              }
            : undefined,
        };
      })
    );
  }

  /**
   * Get messages from a specific chat by name
   */
  async getMessages(chatName: string, limit = 50): Promise<MessageInfo[]> {
    this.ensureReady();

    const chat = await this.findChatByName(chatName);
    if (!chat) {
      throw new Error(`Could not find chat with name: ${chatName}`);
    }

    const messages = await chat.fetchMessages({ limit });
    return messages.map((msg: Message) => ({
      id: msg.id.id,
      body: msg.body || "[Media/System Message]",
      timestamp: msg.timestamp,
      fromMe: msg.fromMe,
      from: msg.from,
      to: msg.to,
      hasMedia: msg.hasMedia,
      type: msg.type,
    }));
  }

  /**
   * Find a chat by name (contact or group)
   */
  private async findChatByName(name: string): Promise<Chat | null> {
    this.ensureReady();

    const chats = await this.client!.getChats();
    const lowerName = name.toLowerCase();

    // First try exact match
    let chat = chats.find((c: Chat) => c.name?.toLowerCase() === lowerName);

    // Then try partial match
    if (!chat) {
      chat = chats.find((c: Chat) => c.name?.toLowerCase().includes(lowerName));
    }

    return chat || null;
  }

  /**
   * Get current session info
   */
  async getSessionInfo(): Promise<{
    state: ClientState;
    sessionExists: boolean;
    lastAuthenticated?: string;
  }> {
    const sessionInfo = await this.sessionManager.getSessionInfo();
    return {
      state: this._state,
      sessionExists: sessionInfo.exists,
      lastAuthenticated: sessionInfo.lastAuthenticated,
    };
  }

  /**
   * Logout and clear session
   */
  async logout(): Promise<void> {
    if (this.client) {
      await this.client.logout();
      await this.client.destroy();
      this.client = null;
    }
    await this.sessionManager.clearSession();
    this.setState("disconnected");
  }

  /**
   * Destroy the client (cleanup)
   */
  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
    this.setState("disconnected");
  }
}
