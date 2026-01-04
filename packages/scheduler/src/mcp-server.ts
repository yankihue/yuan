/**
 * MCP (Model Context Protocol) server interface for the scheduler
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { createStorage, type JsonTaskStorage } from './storage.js';
import { createExecutor, type TaskExecutor } from './executor.js';
import { createScheduler, type Scheduler } from './scheduler.js';
import type { CreateTaskInput, TaskAction, SchedulerConfig } from './types.js';

/**
 * MCP Server for the scheduler service
 */
export class SchedulerMCPServer {
  private server: Server;
  private scheduler: Scheduler;
  private storage: JsonTaskStorage;
  private executor: TaskExecutor;

  constructor(config: SchedulerConfig) {
    this.storage = createStorage(config.storagePath);
    this.executor = createExecutor(config);
    this.scheduler = createScheduler(this.storage, this.executor, config);

    this.server = new Server(
      {
        name: 'yuan-scheduler',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: this.getToolDefinitions(),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        const result = await this.handleToolCall(name, args as Record<string, unknown>);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: errorMessage }, null, 2),
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Get tool definitions for MCP
   */
  private getToolDefinitions(): Tool[] {
    return [
      {
        name: 'scheduler_create_task',
        description:
          'Create a new scheduled task. Supports cron expressions, natural language schedules, and one-time schedules.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Human-readable name for the task',
            },
            description: {
              type: 'string',
              description: 'Optional description of what the task does',
            },
            schedule: {
              type: 'string',
              description:
                'Schedule specification. Can be a cron expression (e.g., "0 14 * * *"), natural language (e.g., "every day at 2pm", "every monday at 9am"), or one-time (e.g., "in 30 minutes", "tomorrow at 3pm")',
            },
            action_type: {
              type: 'string',
              enum: ['orchestrator', 'telegram', 'webhook'],
              description: 'Type of action to perform',
            },
            // Orchestrator action fields
            instruction: {
              type: 'string',
              description: 'Instruction to send to orchestrator (for orchestrator action)',
            },
            repo: {
              type: 'string',
              description: 'Optional repository context (for orchestrator action)',
            },
            // Telegram action fields
            chat_id: {
              type: 'string',
              description: 'Telegram chat ID (for telegram action)',
            },
            message: {
              type: 'string',
              description: 'Message to send (for telegram action)',
            },
            // Webhook action fields
            url: {
              type: 'string',
              description: 'Webhook URL (for webhook action)',
            },
            method: {
              type: 'string',
              enum: ['GET', 'POST', 'PUT', 'DELETE'],
              description: 'HTTP method (for webhook action)',
            },
            headers: {
              type: 'object',
              description: 'Optional HTTP headers (for webhook action)',
            },
            body: {
              type: 'object',
              description: 'Optional request body (for webhook action)',
            },
          },
          required: ['name', 'schedule', 'action_type'],
        },
      },
      {
        name: 'scheduler_list_tasks',
        description: 'List all scheduled tasks with their current status and next execution time',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['active', 'paused', 'completed', 'failed'],
              description: 'Optional filter by task status',
            },
          },
        },
      },
      {
        name: 'scheduler_delete_task',
        description: 'Delete a scheduled task by ID',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The ID of the task to delete',
            },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'scheduler_pause_task',
        description: 'Pause a recurring task. The task will not execute until resumed.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The ID of the task to pause',
            },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'scheduler_resume_task',
        description: 'Resume a paused task. The task will continue executing on its schedule.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'The ID of the task to resume',
            },
          },
          required: ['task_id'],
        },
      },
    ];
  }

  /**
   * Handle a tool call
   */
  private async handleToolCall(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    switch (name) {
      case 'scheduler_create_task':
        return this.handleCreateTask(args);
      case 'scheduler_list_tasks':
        return this.handleListTasks(args);
      case 'scheduler_delete_task':
        return this.handleDeleteTask(args);
      case 'scheduler_pause_task':
        return this.handlePauseTask(args);
      case 'scheduler_resume_task':
        return this.handleResumeTask(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Handle create task
   */
  private async handleCreateTask(args: Record<string, unknown>): Promise<unknown> {
    const { name, description, schedule, action_type } = args;

    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a string');
    }
    if (!schedule || typeof schedule !== 'string') {
      throw new Error('schedule is required and must be a string');
    }
    if (!action_type || typeof action_type !== 'string') {
      throw new Error('action_type is required');
    }

    let action: TaskAction;

    switch (action_type) {
      case 'orchestrator': {
        const instruction = args.instruction;
        if (!instruction || typeof instruction !== 'string') {
          throw new Error('instruction is required for orchestrator action');
        }
        action = {
          type: 'orchestrator',
          instruction,
          repo: typeof args.repo === 'string' ? args.repo : undefined,
        };
        break;
      }
      case 'telegram': {
        const chatId = args.chat_id;
        const message = args.message;
        if (!chatId || typeof chatId !== 'string') {
          throw new Error('chat_id is required for telegram action');
        }
        if (!message || typeof message !== 'string') {
          throw new Error('message is required for telegram action');
        }
        action = {
          type: 'telegram',
          chatId,
          message,
        };
        break;
      }
      case 'webhook': {
        const url = args.url;
        const method = args.method;
        if (!url || typeof url !== 'string') {
          throw new Error('url is required for webhook action');
        }
        if (!method || !['GET', 'POST', 'PUT', 'DELETE'].includes(method as string)) {
          throw new Error('method must be GET, POST, PUT, or DELETE for webhook action');
        }
        action = {
          type: 'webhook',
          url,
          method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
          headers: args.headers as Record<string, string> | undefined,
          body: args.body,
        };
        break;
      }
      default:
        throw new Error(`Unknown action type: ${action_type}`);
    }

    const input: CreateTaskInput = {
      name,
      description: typeof description === 'string' ? description : undefined,
      schedule,
      action,
    };

    const task = await this.scheduler.createTask(input);

    return {
      success: true,
      message: `Task "${task.name}" created successfully`,
      task: {
        id: task.id,
        name: task.name,
        scheduleType: task.scheduleType,
        cronExpression: task.cronExpression,
        scheduledAt: task.scheduledAt,
        nextExecutionAt: task.nextExecutionAt,
        status: task.status,
      },
    };
  }

  /**
   * Handle list tasks
   */
  private async handleListTasks(args: Record<string, unknown>): Promise<unknown> {
    const tasks = await this.scheduler.listTasks();
    const statusFilter = args.status as string | undefined;

    const filteredTasks = statusFilter
      ? tasks.filter((t) => t.status === statusFilter)
      : tasks;

    return {
      count: filteredTasks.length,
      tasks: filteredTasks.map((task) => ({
        id: task.id,
        name: task.name,
        description: task.description,
        scheduleType: task.scheduleType,
        cronExpression: task.cronExpression,
        scheduledAt: task.scheduledAt,
        nextExecutionAt: task.nextExecutionAt,
        status: task.status,
        executionCount: task.executionCount,
        lastExecutedAt: task.lastExecutedAt,
        lastResult: task.lastResult
          ? {
              success: task.lastResult.success,
              executedAt: task.lastResult.executedAt,
              error: task.lastResult.error,
            }
          : undefined,
      })),
    };
  }

  /**
   * Handle delete task
   */
  private async handleDeleteTask(args: Record<string, unknown>): Promise<unknown> {
    const taskId = args.task_id;
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('task_id is required');
    }

    const deleted = await this.scheduler.deleteTask(taskId);

    if (!deleted) {
      throw new Error(`Task not found: ${taskId}`);
    }

    return {
      success: true,
      message: `Task ${taskId} deleted successfully`,
    };
  }

  /**
   * Handle pause task
   */
  private async handlePauseTask(args: Record<string, unknown>): Promise<unknown> {
    const taskId = args.task_id;
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('task_id is required');
    }

    const task = await this.scheduler.pauseTask(taskId);

    return {
      success: true,
      message: `Task "${task.name}" paused successfully`,
      task: {
        id: task.id,
        name: task.name,
        status: task.status,
      },
    };
  }

  /**
   * Handle resume task
   */
  private async handleResumeTask(args: Record<string, unknown>): Promise<unknown> {
    const taskId = args.task_id;
    if (!taskId || typeof taskId !== 'string') {
      throw new Error('task_id is required');
    }

    const task = await this.scheduler.resumeTask(taskId);

    return {
      success: true,
      message: `Task "${task.name}" resumed successfully`,
      task: {
        id: task.id,
        name: task.name,
        status: task.status,
        nextExecutionAt: task.nextExecutionAt,
      },
    };
  }

  /**
   * Initialize and start the MCP server
   */
  async start(): Promise<void> {
    // Initialize the scheduler
    await this.scheduler.initialize();

    // Connect to stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('[MCP] Scheduler MCP server started');
  }

  /**
   * Shutdown the server
   */
  async shutdown(): Promise<void> {
    await this.scheduler.shutdown();
    await this.server.close();
    console.error('[MCP] Scheduler MCP server stopped');
  }
}

/**
 * Get configuration from environment variables
 */
function getConfigFromEnv(): SchedulerConfig {
  return {
    storagePath: process.env.SCHEDULER_STORAGE_PATH || './data/tasks.json',
    orchestratorUrl: process.env.ORCHESTRATOR_URL || 'http://localhost:3000',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    timezone: process.env.TZ || 'UTC',
  };
}

/**
 * Main entry point for MCP server
 */
async function main(): Promise<void> {
  const config = getConfigFromEnv();
  const server = new SchedulerMCPServer(config);

  // Handle shutdown signals
  process.on('SIGINT', async () => {
    await server.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.shutdown();
    process.exit(0);
  });

  await server.start();
}

// Run if executed directly
main().catch((error) => {
  console.error('[MCP] Fatal error:', error);
  process.exit(1);
});
