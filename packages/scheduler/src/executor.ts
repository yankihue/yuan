/**
 * Task executor - handles executing scheduled tasks
 */

import type {
  ScheduledTask,
  TaskAction,
  TaskExecutionResult,
  OrchestratorAction,
  TelegramAction,
  WebhookAction,
  SchedulerConfig,
} from './types.js';

/**
 * Task executor that handles different action types
 */
export class TaskExecutor {
  private config: SchedulerConfig;

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  /**
   * Execute a scheduled task
   */
  async execute(task: ScheduledTask): Promise<TaskExecutionResult> {
    const startTime = new Date();
    console.log(`[Executor] Executing task: ${task.id} (${task.name})`);

    try {
      const result = await this.executeAction(task.action);

      return {
        success: true,
        executedAt: startTime.toISOString(),
        response: result.response,
        statusCode: result.statusCode,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Executor] Task failed: ${task.id}`, error);

      return {
        success: false,
        executedAt: startTime.toISOString(),
        error: errorMessage,
      };
    }
  }

  /**
   * Execute an action based on its type
   */
  private async executeAction(
    action: TaskAction
  ): Promise<{ response?: unknown; statusCode?: number }> {
    switch (action.type) {
      case 'orchestrator':
        return this.executeOrchestratorAction(action);
      case 'telegram':
        return this.executeTelegramAction(action);
      case 'webhook':
        return this.executeWebhookAction(action);
      default:
        throw new Error(`Unknown action type: ${(action as TaskAction).type}`);
    }
  }

  /**
   * Send instruction to orchestrator
   */
  private async executeOrchestratorAction(
    action: OrchestratorAction
  ): Promise<{ response?: unknown; statusCode?: number }> {
    const url = `${this.config.orchestratorUrl}/api/tasks`;

    console.log(`[Executor] Sending instruction to orchestrator: ${action.instruction}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instruction: action.instruction,
        repo: action.repo,
        source: 'scheduler',
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(`Orchestrator error: ${response.status} - ${JSON.stringify(data)}`);
    }

    return {
      response: data,
      statusCode: response.status,
    };
  }

  /**
   * Send message via Telegram bot
   */
  private async executeTelegramAction(
    action: TelegramAction
  ): Promise<{ response?: unknown; statusCode?: number }> {
    if (!this.config.telegramBotToken) {
      throw new Error('Telegram bot token not configured');
    }

    const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`;

    console.log(`[Executor] Sending Telegram message to chat: ${action.chatId}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: action.chatId,
        text: action.message,
        parse_mode: 'Markdown',
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(`Telegram API error: ${response.status} - ${JSON.stringify(data)}`);
    }

    return {
      response: data,
      statusCode: response.status,
    };
  }

  /**
   * Execute a webhook call
   */
  private async executeWebhookAction(
    action: WebhookAction
  ): Promise<{ response?: unknown; statusCode?: number }> {
    console.log(`[Executor] Calling webhook: ${action.method} ${action.url}`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...action.headers,
    };

    const options: RequestInit = {
      method: action.method,
      headers,
    };

    if (action.body && ['POST', 'PUT'].includes(action.method)) {
      options.body = JSON.stringify(action.body);
    }

    const response = await fetch(action.url, options);

    let data: unknown;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    if (!response.ok) {
      throw new Error(`Webhook error: ${response.status} - ${JSON.stringify(data)}`);
    }

    return {
      response: data,
      statusCode: response.status,
    };
  }
}

/**
 * Create an executor instance
 */
export function createExecutor(config: SchedulerConfig): TaskExecutor {
  return new TaskExecutor(config);
}
