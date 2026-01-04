/**
 * Type definitions for the scheduler service
 */

/**
 * Task types that can be scheduled
 */
export type TaskType = 'orchestrator' | 'telegram' | 'webhook';

/**
 * Schedule type - either cron-based (recurring) or one-time
 */
export type ScheduleType = 'cron' | 'once';

/**
 * Task status
 */
export type TaskStatus = 'active' | 'paused' | 'completed' | 'failed';

/**
 * Base configuration for task actions
 */
export interface OrchestratorAction {
  type: 'orchestrator';
  /** Instruction to send to the orchestrator */
  instruction: string;
  /** Optional repository context */
  repo?: string;
}

export interface TelegramAction {
  type: 'telegram';
  /** Chat ID to send message to */
  chatId: string;
  /** Message to send */
  message: string;
}

export interface WebhookAction {
  type: 'webhook';
  /** URL to call */
  url: string;
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Optional headers */
  headers?: Record<string, string>;
  /** Optional request body (for POST/PUT) */
  body?: unknown;
}

export type TaskAction = OrchestratorAction | TelegramAction | WebhookAction;

/**
 * Scheduled task definition
 */
export interface ScheduledTask {
  /** Unique task identifier */
  id: string;
  /** Human-readable task name */
  name: string;
  /** Task description */
  description?: string;
  /** Schedule type */
  scheduleType: ScheduleType;
  /** Cron expression (for recurring tasks) */
  cronExpression?: string;
  /** Original natural language input (for reference) */
  naturalLanguageInput?: string;
  /** Scheduled execution time (for one-time tasks) */
  scheduledAt?: string;
  /** Action to execute */
  action: TaskAction;
  /** Current task status */
  status: TaskStatus;
  /** Creation timestamp */
  createdAt: string;
  /** Last updated timestamp */
  updatedAt: string;
  /** Last execution timestamp */
  lastExecutedAt?: string;
  /** Next scheduled execution timestamp */
  nextExecutionAt?: string;
  /** Number of times the task has been executed */
  executionCount: number;
  /** Last execution result */
  lastResult?: TaskExecutionResult;
}

/**
 * Result of a task execution
 */
export interface TaskExecutionResult {
  /** Whether the execution was successful */
  success: boolean;
  /** Execution timestamp */
  executedAt: string;
  /** Response data (if any) */
  response?: unknown;
  /** Error message (if failed) */
  error?: string;
  /** HTTP status code (for webhook/API calls) */
  statusCode?: number;
}

/**
 * Input for creating a new scheduled task
 */
export interface CreateTaskInput {
  /** Human-readable task name */
  name: string;
  /** Task description */
  description?: string;
  /**
   * Schedule specification - can be:
   * - Cron expression: "0 14 * * *"
   * - Natural language: "every day at 2pm", "every monday at 9am"
   * - One-time: "in 30 minutes", "tomorrow at 3pm"
   */
  schedule: string;
  /** Action to execute */
  action: TaskAction;
}

/**
 * Input for updating a scheduled task
 */
export interface UpdateTaskInput {
  /** Task ID to update */
  id: string;
  /** New task name */
  name?: string;
  /** New task description */
  description?: string;
  /** New schedule specification */
  schedule?: string;
  /** New action */
  action?: TaskAction;
}

/**
 * Storage interface for task persistence
 */
export interface TaskStorage {
  /** Get all tasks */
  getAllTasks(): Promise<ScheduledTask[]>;
  /** Get a single task by ID */
  getTask(id: string): Promise<ScheduledTask | null>;
  /** Save a task (create or update) */
  saveTask(task: ScheduledTask): Promise<void>;
  /** Delete a task */
  deleteTask(id: string): Promise<boolean>;
  /** Update task status */
  updateTaskStatus(id: string, status: TaskStatus): Promise<void>;
  /** Update task after execution */
  updateTaskExecution(id: string, result: TaskExecutionResult): Promise<void>;
}

/**
 * Scheduler configuration
 */
export interface SchedulerConfig {
  /** Path to storage file */
  storagePath: string;
  /** Orchestrator API URL */
  orchestratorUrl: string;
  /** Telegram bot token (optional) */
  telegramBotToken?: string;
  /** Default timezone for scheduling */
  timezone: string;
}

/**
 * Parsed schedule result from natural language or cron expression
 */
export interface ParsedSchedule {
  /** Schedule type */
  type: ScheduleType;
  /** Cron expression (if recurring) */
  cronExpression?: string;
  /** Scheduled date (if one-time) */
  scheduledDate?: Date;
  /** Next execution date */
  nextExecution: Date;
}
