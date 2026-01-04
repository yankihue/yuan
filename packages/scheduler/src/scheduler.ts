/**
 * Core scheduler using node-cron for recurring tasks and chrono-node for natural language parsing
 */

import cron, { type ScheduledTask as CronTask } from 'node-cron';
import * as chrono from 'chrono-node';
import { v4 as uuidv4 } from 'uuid';
import type {
  ScheduledTask,
  CreateTaskInput,
  ParsedSchedule,
  SchedulerConfig,
  TaskStatus,
} from './types.js';
import type { JsonTaskStorage } from './storage.js';
import type { TaskExecutor } from './executor.js';

/**
 * Cron expression patterns for common natural language phrases
 */
const NATURAL_LANGUAGE_CRON_PATTERNS: Record<string, string> = {
  'every minute': '* * * * *',
  'every hour': '0 * * * *',
  'every day': '0 0 * * *',
  'daily': '0 0 * * *',
  'every week': '0 0 * * 0',
  'weekly': '0 0 * * 0',
  'every month': '0 0 1 * *',
  'monthly': '0 0 1 * *',
  'every monday': '0 0 * * 1',
  'every tuesday': '0 0 * * 2',
  'every wednesday': '0 0 * * 3',
  'every thursday': '0 0 * * 4',
  'every friday': '0 0 * * 5',
  'every saturday': '0 0 * * 6',
  'every sunday': '0 0 * * 0',
};

/**
 * Day name to cron day number mapping
 */
const DAY_TO_CRON: Record<string, string> = {
  sunday: '0',
  monday: '1',
  tuesday: '2',
  wednesday: '3',
  thursday: '4',
  friday: '5',
  saturday: '6',
};

/**
 * Main scheduler class
 */
export class Scheduler {
  private storage: JsonTaskStorage;
  private executor: TaskExecutor;
  private config: SchedulerConfig;
  private cronJobs: Map<string, CronTask> = new Map();
  private oneTimeTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    storage: JsonTaskStorage,
    executor: TaskExecutor,
    config: SchedulerConfig
  ) {
    this.storage = storage;
    this.executor = executor;
    this.config = config;
  }

  /**
   * Initialize the scheduler - load and schedule existing tasks
   */
  async initialize(): Promise<void> {
    console.log('[Scheduler] Initializing...');

    const tasks = await this.storage.getAllTasks();

    for (const task of tasks) {
      if (task.status === 'active') {
        await this.scheduleTask(task);
      }
    }

    console.log(`[Scheduler] Initialized with ${tasks.length} tasks`);
  }

  /**
   * Parse a schedule string (cron, natural language, or one-time)
   */
  parseSchedule(scheduleInput: string): ParsedSchedule {
    const input = scheduleInput.trim().toLowerCase();

    // Check if it's a valid cron expression
    if (cron.validate(scheduleInput)) {
      const nextExecution = this.getNextCronExecution(scheduleInput);
      return {
        type: 'cron',
        cronExpression: scheduleInput,
        nextExecution,
      };
    }

    // Check for "every X at Y" pattern
    const everyAtMatch = input.match(
      /every\s+(day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(.+)/i
    );
    if (everyAtMatch) {
      const dayOrDaily = everyAtMatch[1].toLowerCase();
      const timeStr = everyAtMatch[2];
      const cronExpr = this.buildCronFromDayAndTime(dayOrDaily, timeStr);

      if (cronExpr) {
        const nextExecution = this.getNextCronExecution(cronExpr);
        return {
          type: 'cron',
          cronExpression: cronExpr,
          nextExecution,
        };
      }
    }

    // Check for simple recurring patterns
    for (const [pattern, cronExpr] of Object.entries(NATURAL_LANGUAGE_CRON_PATTERNS)) {
      if (input.startsWith(pattern)) {
        // Check if there's a time component
        const timeMatch = input.match(/at\s+(.+)/i);
        let finalCron = cronExpr;

        if (timeMatch) {
          const timeStr = timeMatch[1];
          const timeCron = this.parseTimeToMinuteHour(timeStr);
          if (timeCron) {
            // Replace minute and hour in cron expression
            const parts = cronExpr.split(' ');
            parts[0] = timeCron.minute;
            parts[1] = timeCron.hour;
            finalCron = parts.join(' ');
          }
        }

        const nextExecution = this.getNextCronExecution(finalCron);
        return {
          type: 'cron',
          cronExpression: finalCron,
          nextExecution,
        };
      }
    }

    // Try to parse as a one-time schedule using chrono-node
    const parsedDate = chrono.parseDate(scheduleInput, new Date(), {
      forwardDate: true,
    });

    if (parsedDate && parsedDate > new Date()) {
      return {
        type: 'once',
        scheduledDate: parsedDate,
        nextExecution: parsedDate,
      };
    }

    throw new Error(
      `Unable to parse schedule: "${scheduleInput}". ` +
        'Use a cron expression (e.g., "0 14 * * *"), ' +
        'natural language (e.g., "every day at 2pm"), ' +
        'or a one-time schedule (e.g., "in 30 minutes", "tomorrow at 3pm").'
    );
  }

  /**
   * Build cron expression from day and time
   */
  private buildCronFromDayAndTime(day: string, timeStr: string): string | null {
    const timeParts = this.parseTimeToMinuteHour(timeStr);
    if (!timeParts) return null;

    if (day === 'day') {
      // Every day
      return `${timeParts.minute} ${timeParts.hour} * * *`;
    }

    const cronDay = DAY_TO_CRON[day];
    if (cronDay !== undefined) {
      return `${timeParts.minute} ${timeParts.hour} * * ${cronDay}`;
    }

    return null;
  }

  /**
   * Parse time string to minute and hour
   */
  private parseTimeToMinuteHour(
    timeStr: string
  ): { minute: string; hour: string } | null {
    // Try parsing with chrono
    const parsed = chrono.parseDate(`today at ${timeStr}`);
    if (parsed) {
      return {
        minute: parsed.getMinutes().toString(),
        hour: parsed.getHours().toString(),
      };
    }

    // Try simple patterns like "14:00", "2pm", "2:30pm"
    const time24Match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (time24Match) {
      return {
        hour: time24Match[1],
        minute: time24Match[2],
      };
    }

    const time12Match = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (time12Match) {
      let hour = parseInt(time12Match[1], 10);
      const minute = time12Match[2] || '0';
      const ampm = time12Match[3].toLowerCase();

      if (ampm === 'pm' && hour !== 12) {
        hour += 12;
      } else if (ampm === 'am' && hour === 12) {
        hour = 0;
      }

      return {
        hour: hour.toString(),
        minute: minute,
      };
    }

    return null;
  }

  /**
   * Get next execution time for a cron expression
   */
  private getNextCronExecution(cronExpression: string): Date {
    // Simple approximation - for accurate calculation, would need a cron parser library
    // node-cron doesn't expose next execution time, so we estimate
    const now = new Date();
    const parts = cronExpression.split(' ');

    if (parts.length !== 5) {
      return new Date(now.getTime() + 60000); // Default to 1 minute from now
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Create a simple estimate
    const next = new Date(now);

    if (minute !== '*') {
      next.setMinutes(parseInt(minute, 10));
    }
    if (hour !== '*') {
      next.setHours(parseInt(hour, 10));
    }

    next.setSeconds(0);
    next.setMilliseconds(0);

    // If the time has passed today, move to tomorrow
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }

    return next;
  }

  /**
   * Create a new scheduled task
   */
  async createTask(input: CreateTaskInput): Promise<ScheduledTask> {
    const parsedSchedule = this.parseSchedule(input.schedule);

    const task: ScheduledTask = {
      id: uuidv4(),
      name: input.name,
      description: input.description,
      scheduleType: parsedSchedule.type,
      cronExpression: parsedSchedule.cronExpression,
      naturalLanguageInput: input.schedule,
      scheduledAt: parsedSchedule.scheduledDate?.toISOString(),
      action: input.action,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nextExecutionAt: parsedSchedule.nextExecution.toISOString(),
      executionCount: 0,
    };

    await this.storage.saveTask(task);
    await this.scheduleTask(task);

    console.log(`[Scheduler] Created task: ${task.id} (${task.name})`);
    return task;
  }

  /**
   * Schedule a task for execution
   */
  private async scheduleTask(task: ScheduledTask): Promise<void> {
    if (task.scheduleType === 'cron' && task.cronExpression) {
      // Recurring task using node-cron
      const job = cron.schedule(
        task.cronExpression,
        async () => {
          await this.executeTask(task.id);
        },
        {
          timezone: this.config.timezone,
        }
      );

      this.cronJobs.set(task.id, job);
      console.log(
        `[Scheduler] Scheduled cron task: ${task.id} (${task.cronExpression})`
      );
    } else if (task.scheduleType === 'once' && task.scheduledAt) {
      // One-time task using setTimeout
      const scheduledTime = new Date(task.scheduledAt).getTime();
      const now = Date.now();
      const delay = Math.max(0, scheduledTime - now);

      if (delay > 0) {
        const timeout = setTimeout(async () => {
          await this.executeTask(task.id);
          this.oneTimeTimeouts.delete(task.id);
        }, delay);

        this.oneTimeTimeouts.set(task.id, timeout);
        console.log(
          `[Scheduler] Scheduled one-time task: ${task.id} (in ${Math.round(delay / 1000)}s)`
        );
      } else {
        console.log(`[Scheduler] One-time task ${task.id} is in the past, marking as failed`);
        await this.storage.updateTaskStatus(task.id, 'failed');
      }
    }
  }

  /**
   * Execute a task by ID
   */
  private async executeTask(taskId: string): Promise<void> {
    const task = await this.storage.getTask(taskId);
    if (!task) {
      console.error(`[Scheduler] Task not found: ${taskId}`);
      return;
    }

    if (task.status !== 'active') {
      console.log(`[Scheduler] Task ${taskId} is not active, skipping execution`);
      return;
    }

    console.log(`[Scheduler] Executing task: ${taskId} (${task.name})`);

    const result = await this.executor.execute(task);
    await this.storage.updateTaskExecution(taskId, result);

    // Update next execution time for cron tasks
    if (task.scheduleType === 'cron' && task.cronExpression) {
      const nextExecution = this.getNextCronExecution(task.cronExpression);
      const updatedTask = await this.storage.getTask(taskId);
      if (updatedTask) {
        updatedTask.nextExecutionAt = nextExecution.toISOString();
        await this.storage.saveTask(updatedTask);
      }
    }

    console.log(
      `[Scheduler] Task ${taskId} executed: ${result.success ? 'success' : 'failed'}`
    );
  }

  /**
   * List all tasks
   */
  async listTasks(): Promise<ScheduledTask[]> {
    return this.storage.getAllTasks();
  }

  /**
   * Get a task by ID
   */
  async getTask(id: string): Promise<ScheduledTask | null> {
    return this.storage.getTask(id);
  }

  /**
   * Delete a task
   */
  async deleteTask(id: string): Promise<boolean> {
    // Stop the scheduled job
    this.stopTask(id);

    return this.storage.deleteTask(id);
  }

  /**
   * Pause a recurring task
   */
  async pauseTask(id: string): Promise<ScheduledTask> {
    const task = await this.storage.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    if (task.scheduleType !== 'cron') {
      throw new Error('Only recurring tasks can be paused');
    }

    if (task.status !== 'active') {
      throw new Error(`Task is not active: ${task.status}`);
    }

    this.stopTask(id);
    await this.storage.updateTaskStatus(id, 'paused');

    const updatedTask = await this.storage.getTask(id);
    console.log(`[Scheduler] Paused task: ${id}`);
    return updatedTask!;
  }

  /**
   * Resume a paused task
   */
  async resumeTask(id: string): Promise<ScheduledTask> {
    const task = await this.storage.getTask(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    if (task.status !== 'paused') {
      throw new Error(`Task is not paused: ${task.status}`);
    }

    await this.storage.updateTaskStatus(id, 'active');
    await this.scheduleTask(task);

    const updatedTask = await this.storage.getTask(id);
    console.log(`[Scheduler] Resumed task: ${id}`);
    return updatedTask!;
  }

  /**
   * Stop a scheduled task
   */
  private stopTask(id: string): void {
    const cronJob = this.cronJobs.get(id);
    if (cronJob) {
      cronJob.stop();
      this.cronJobs.delete(id);
    }

    const timeout = this.oneTimeTimeouts.get(id);
    if (timeout) {
      clearTimeout(timeout);
      this.oneTimeTimeouts.delete(id);
    }
  }

  /**
   * Shutdown the scheduler
   */
  async shutdown(): Promise<void> {
    console.log('[Scheduler] Shutting down...');

    // Stop all cron jobs
    for (const [id, job] of this.cronJobs) {
      job.stop();
      console.log(`[Scheduler] Stopped cron job: ${id}`);
    }
    this.cronJobs.clear();

    // Clear all timeouts
    for (const [id, timeout] of this.oneTimeTimeouts) {
      clearTimeout(timeout);
      console.log(`[Scheduler] Cleared timeout: ${id}`);
    }
    this.oneTimeTimeouts.clear();

    console.log('[Scheduler] Shutdown complete');
  }
}

/**
 * Create a scheduler instance
 */
export function createScheduler(
  storage: JsonTaskStorage,
  executor: TaskExecutor,
  config: SchedulerConfig
): Scheduler {
  return new Scheduler(storage, executor, config);
}
