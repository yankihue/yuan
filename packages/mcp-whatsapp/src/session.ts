import { promises as fs } from "fs";
import path from "path";

/**
 * Session manager for WhatsApp authentication state persistence.
 * Handles saving and loading session data to avoid re-scanning QR codes.
 */

export interface SessionData {
  authenticated: boolean;
  clientId: string;
  lastAuthenticated?: string;
}

export class SessionManager {
  private sessionPath: string;
  private sessionDataPath: string;

  constructor(sessionDir?: string) {
    this.sessionPath = sessionDir || path.join(process.cwd(), ".wwebjs_auth");
    this.sessionDataPath = path.join(this.sessionPath, "session_data.json");
  }

  /**
   * Get the session directory path for whatsapp-web.js LocalAuth
   */
  getSessionPath(): string {
    return this.sessionPath;
  }

  /**
   * Check if a session exists
   */
  async hasSession(): Promise<boolean> {
    try {
      await fs.access(this.sessionDataPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save session metadata
   */
  async saveSession(clientId: string): Promise<void> {
    const sessionData: SessionData = {
      authenticated: true,
      clientId,
      lastAuthenticated: new Date().toISOString(),
    };

    await fs.mkdir(this.sessionPath, { recursive: true });
    await fs.writeFile(
      this.sessionDataPath,
      JSON.stringify(sessionData, null, 2)
    );
  }

  /**
   * Load session metadata
   */
  async loadSession(): Promise<SessionData | null> {
    try {
      const data = await fs.readFile(this.sessionDataPath, "utf-8");
      return JSON.parse(data) as SessionData;
    } catch {
      return null;
    }
  }

  /**
   * Clear session data (for logout)
   */
  async clearSession(): Promise<void> {
    try {
      await fs.rm(this.sessionPath, { recursive: true, force: true });
    } catch {
      // Session directory might not exist
    }
  }

  /**
   * Get session info for status reporting
   */
  async getSessionInfo(): Promise<{
    exists: boolean;
    lastAuthenticated?: string;
    clientId?: string;
  }> {
    const session = await this.loadSession();
    if (session) {
      return {
        exists: true,
        lastAuthenticated: session.lastAuthenticated,
        clientId: session.clientId,
      };
    }
    return { exists: false };
  }
}
