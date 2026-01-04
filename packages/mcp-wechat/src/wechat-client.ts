import { WechatyBuilder, type Wechaty, type Contact, type Message } from 'wechaty';
import { EventEmitter } from 'events';

export interface WeChatContact {
  id: string;
  name: string;
  alias: string | null;
  type: 'individual' | 'official' | 'corporation' | 'unknown';
  isFriend: boolean;
}

export interface WeChatMessage {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  text: string;
  timestamp: number;
  type: string;
}

export class WeChatClient extends EventEmitter {
  private wechaty: Wechaty | null = null;
  private isLoggedIn = false;
  private contacts: Map<string, Contact> = new Map();
  private recentMessages: Map<string, WeChatMessage[]> = new Map();
  private maxMessagesPerContact = 100;

  constructor() {
    super();
  }

  async initialize(): Promise<void> {
    this.wechaty = WechatyBuilder.build({
      name: 'mcp-wechat-bot',
      puppet: 'wechaty-puppet-wechat4u',
    });

    this.setupEventHandlers();
    await this.wechaty.start();
  }

  private setupEventHandlers(): void {
    if (!this.wechaty) return;

    this.wechaty.on('scan', (qrcode, status) => {
      const qrcodeUrl = `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`;
      this.emit('scan', { qrcode, qrcodeUrl, status });
      console.log(`Scan QR Code to login: ${qrcodeUrl}`);
    });

    this.wechaty.on('login', async (user) => {
      this.isLoggedIn = true;
      this.emit('login', { id: user.id, name: user.name() });
      console.log(`User ${user.name()} logged in`);
      await this.loadContacts();
    });

    this.wechaty.on('logout', (user) => {
      this.isLoggedIn = false;
      this.contacts.clear();
      this.emit('logout', { id: user.id, name: user.name() });
      console.log(`User ${user.name()} logged out`);
    });

    this.wechaty.on('message', async (message) => {
      const wechatMessage = await this.convertMessage(message);
      if (wechatMessage) {
        this.storeMessage(wechatMessage);
        this.emit('message', wechatMessage);
      }
    });

    this.wechaty.on('error', (error) => {
      console.error('Wechaty error:', error);
      this.emit('error', error);
    });
  }

  private async loadContacts(): Promise<void> {
    if (!this.wechaty || !this.isLoggedIn) return;

    try {
      const contactList = await this.wechaty.Contact.findAll();
      this.contacts.clear();
      for (const contact of contactList) {
        this.contacts.set(contact.id, contact);
      }
      console.log(`Loaded ${this.contacts.size} contacts`);
    } catch (error) {
      console.error('Failed to load contacts:', error);
    }
  }

  private async convertMessage(message: Message): Promise<WeChatMessage | null> {
    try {
      const from = message.talker();
      const to = message.listener();

      return {
        id: message.id,
        fromId: from.id,
        fromName: from.name(),
        toId: to?.id ?? '',
        toName: to?.name() ?? '',
        text: message.text(),
        timestamp: message.date().getTime(),
        type: message.type().toString(),
      };
    } catch (error) {
      console.error('Failed to convert message:', error);
      return null;
    }
  }

  private storeMessage(message: WeChatMessage): void {
    const contactId = message.fromId;
    const messages = this.recentMessages.get(contactId) ?? [];
    messages.push(message);

    // Keep only the most recent messages
    if (messages.length > this.maxMessagesPerContact) {
      messages.shift();
    }

    this.recentMessages.set(contactId, messages);
  }

  async sendMessage(contactName: string, text: string): Promise<{ success: boolean; error?: string }> {
    if (!this.wechaty || !this.isLoggedIn) {
      return { success: false, error: 'Not logged in' };
    }

    try {
      const contact = await this.findContactByName(contactName);
      if (!contact) {
        return { success: false, error: `Contact "${contactName}" not found` };
      }

      await contact.say(text);
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  async getContacts(): Promise<WeChatContact[]> {
    if (!this.wechaty || !this.isLoggedIn) {
      return [];
    }

    const result: WeChatContact[] = [];
    for (const contact of this.contacts.values()) {
      try {
        const contactType = contact.type();
        let type: WeChatContact['type'] = 'unknown';

        if (contactType === this.wechaty.Contact.Type.Individual) {
          type = 'individual';
        } else if (contactType === this.wechaty.Contact.Type.Official) {
          type = 'official';
        } else if (contactType === this.wechaty.Contact.Type.Corporation) {
          type = 'corporation';
        }

        result.push({
          id: contact.id,
          name: contact.name(),
          alias: await contact.alias() ?? null,
          type,
          isFriend: contact.friend() ?? false,
        });
      } catch (error) {
        // Skip contacts that can't be converted
        continue;
      }
    }

    return result;
  }

  async searchContacts(query: string): Promise<WeChatContact[]> {
    const allContacts = await this.getContacts();
    const lowerQuery = query.toLowerCase();

    return allContacts.filter(contact =>
      contact.name.toLowerCase().includes(lowerQuery) ||
      (contact.alias && contact.alias.toLowerCase().includes(lowerQuery))
    );
  }

  async getRecentMessages(contactName: string, limit = 20): Promise<WeChatMessage[]> {
    if (!this.wechaty || !this.isLoggedIn) {
      return [];
    }

    const contact = await this.findContactByName(contactName);
    if (!contact) {
      return [];
    }

    const messages = this.recentMessages.get(contact.id) ?? [];
    return messages.slice(-limit);
  }

  private async findContactByName(name: string): Promise<Contact | null> {
    if (!this.wechaty) return null;

    // First try exact match
    for (const contact of this.contacts.values()) {
      if (contact.name() === name) {
        return contact;
      }
      const alias = await contact.alias();
      if (alias && alias === name) {
        return contact;
      }
    }

    // Try case-insensitive match
    const lowerName = name.toLowerCase();
    for (const contact of this.contacts.values()) {
      if (contact.name().toLowerCase() === lowerName) {
        return contact;
      }
      const alias = await contact.alias();
      if (alias && alias.toLowerCase() === lowerName) {
        return contact;
      }
    }

    // Try partial match
    for (const contact of this.contacts.values()) {
      if (contact.name().toLowerCase().includes(lowerName)) {
        return contact;
      }
    }

    return null;
  }

  isReady(): boolean {
    return this.isLoggedIn;
  }

  async stop(): Promise<void> {
    if (this.wechaty) {
      await this.wechaty.stop();
      this.wechaty = null;
      this.isLoggedIn = false;
      this.contacts.clear();
      this.recentMessages.clear();
    }
  }
}

// Singleton instance
let clientInstance: WeChatClient | null = null;

export function getWeChatClient(): WeChatClient {
  if (!clientInstance) {
    clientInstance = new WeChatClient();
  }
  return clientInstance;
}
