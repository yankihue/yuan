import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type {
  Instruction,
  ApprovalResponse,
  OrchestratorUpdate,
  StatusResponse,
  InputResponse,
  UsageResponse,
} from '../types.js';

interface OrchestratorConfig {
  host: string;
  port: number;
  secret: string;
}

interface CancelResponse {
  cancelledTask: boolean;
  cancelledSubAgents: number;
  message: string;
}

export class OrchestratorClient extends EventEmitter {
  private config: OrchestratorConfig;
  private ws: WebSocket | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isConnecting = false;

  constructor(config: OrchestratorConfig) {
    super();
    this.config = config;
  }

  get baseUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  get wsUrl(): string {
    return `ws://${this.config.host}:${this.config.port}/ws`;
  }

  async connect(): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl, {
          headers: {
            'Authorization': `Bearer ${this.config.secret}`,
          },
        });

        this.ws.on('open', () => {
          console.log('Connected to orchestrator via WebSocket');
          this.reconnectAttempts = 0;
          this.isConnecting = false;
          if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
          }
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString()) as OrchestratorUpdate;
            this.emit('update', message);
          } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
          }
        });

        this.ws.on('close', () => {
          console.log('WebSocket connection closed');
          this.isConnecting = false;
          this.emit('disconnected');
          this.scheduleReconnect();
        });

        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error);
          this.isConnecting = false;
          if (this.ws?.readyState !== WebSocket.OPEN) {
            reject(error);
          }
        });
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    const baseDelay = Math.min(5000 * Math.pow(2, this.reconnectAttempts), 30000);
    const jitter = Math.random() * 1000;
    const delay = baseDelay + jitter;
    this.reconnectAttempts += 1;

    this.reconnectTimeout = setTimeout(() => {
      console.log('Attempting to reconnect to orchestrator...');
      this.connect().catch(error => {
        console.error('Reconnection failed:', error);
      });
    }, delay);
  }

  async sendInstruction(instruction: Instruction): Promise<void> {
    const response = await fetch(`${this.baseUrl}/instruction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.secret}`,
      },
      body: JSON.stringify(instruction),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to send instruction: ${response.status} ${text}`);
    }
  }

  async sendApprovalResponse(approval: ApprovalResponse): Promise<void> {
    const response = await fetch(`${this.baseUrl}/approval-response`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.secret}`,
      },
      body: JSON.stringify(approval),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to send approval response: ${response.status} ${text}`);
    }
  }

  async sendInputResponse(inputResponse: InputResponse): Promise<void> {
    const response = await fetch(`${this.baseUrl}/input-response`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.secret}`,
      },
      body: JSON.stringify(inputResponse),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to send input response: ${response.status} ${text}`);
    }
  }

  async cancelTask(taskId: string, userId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/cancel-task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.secret}`,
      },
      body: JSON.stringify({ taskId, userId }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to cancel task: ${response.status} ${text}`);
    }
  }

  async getStatus(): Promise<StatusResponse> {
    const response = await fetch(`${this.baseUrl}/status`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.config.secret}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get status: ${response.status} ${text}`);
    }

    return response.json() as Promise<StatusResponse>;
  }

  async getUsage(): Promise<UsageResponse> {
    const response = await fetch(`${this.baseUrl}/usage`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.config.secret}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get usage: ${response.status} ${text}`);
    }

    return response.json() as Promise<UsageResponse>;
  }

  async cancelTasks(userId: string): Promise<CancelResponse> {
    const response = await fetch(`${this.baseUrl}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.secret}`,
      },
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to cancel tasks: ${response.status} ${text}`);
    }

    return response.json() as Promise<CancelResponse>;
  }

  async resetConversation(userId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.secret}`,
      },
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to reset conversation: ${response.status} ${text}`);
    }
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
