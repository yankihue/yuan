/**
 * Task storage implementation using JSON file persistence
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';
import type {
  ScheduledTask,
  TaskStorage,
  TaskStatus,
  TaskExecutionResult,
} from './types.js';

/**
 * JSON file-based storage for scheduled tasks
 * Provides persistence across service restarts
 */
export class JsonTaskStorage implements TaskStorage {
  private tasks: Map<string, ScheduledTask> = new Map();
  private storagePath: string;
  private initialized = false;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  /**
   * Initialize storage - load existing tasks from file
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Ensure directory exists
      const dir = dirname(this.storagePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      // Load existing tasks if file exists
      if (existsSync(this.storagePath)) {
        const data = await readFile(this.storagePath, 'utf-8');
        const parsed = JSON.parse(data) as { tasks: ScheduledTask[] };

        for (const task of parsed.tasks) {
          this.tasks.set(task.id, task);
        }

        console.log(`[Storage] Loaded ${this.tasks.size} tasks from ${this.storagePath}`);
      } else {
        console.log(`[Storage] No existing storage file found, starting fresh`);
      }
    } catch (error) {
      console.error('[Storage] Error loading tasks:', error);
      // Start with empty storage on error
      this.tasks.clear();
    }

    this.initialized = true;
  }

  /**
   * Persist tasks to file
   */
  private async persist(): Promise<void> {
    try {
      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        tasks: Array.from(this.tasks.values()),
      };

      await writeFile(this.storagePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error('[Storage] Error persisting tasks:', error);
      throw error;
    }
  }

  /**
   * Get all tasks
   */
  async getAllTasks(): Promise<ScheduledTask[]> {
    await this.initialize();
    return Array.from(this.tasks.values());
  }

  /**
   * Get a single task by ID
   */
  async getTask(id: string): Promise<ScheduledTask | null> {
    await this.initialize();
    return this.tasks.get(id) ?? null;
  }

  /**
   * Save a task (create or update)
   */
  async saveTask(task: ScheduledTask): Promise<void> {
    await this.initialize();

    task.updatedAt = new Date().toISOString();
    this.tasks.set(task.id, task);

    await this.persist();
    console.log(`[Storage] Saved task: ${task.id} (${task.name})`);
  }

  /**
   * Delete a task
   */
  async deleteTask(id: string): Promise<boolean> {
    await this.initialize();

    const existed = this.tasks.has(id);
    if (existed) {
      this.tasks.delete(id);
      await this.persist();
      console.log(`[Storage] Deleted task: ${id}`);
    }

    return existed;
  }

  /**
   * Update task status
   */
  async updateTaskStatus(id: string, status: TaskStatus): Promise<void> {
    await this.initialize();

    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    task.status = status;
    task.updatedAt = new Date().toISOString();

    await this.persist();
    console.log(`[Storage] Updated task status: ${id} -> ${status}`);
  }

  /**
   * Update task after execution
   */
  async updateTaskExecution(id: string, result: TaskExecutionResult): Promise<void> {
    await this.initialize();

    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }

    task.lastExecutedAt = result.executedAt;
    task.lastResult = result;
    task.executionCount += 1;
    task.updatedAt = new Date().toISOString();

    // Mark one-time tasks as completed after execution
    if (task.scheduleType === 'once') {
      task.status = result.success ? 'completed' : 'failed';
    }

    await this.persist();
    console.log(`[Storage] Updated task execution: ${id} (count: ${task.executionCount})`);
  }

  /**
   * Get tasks by status
   */
  async getTasksByStatus(status: TaskStatus): Promise<ScheduledTask[]> {
    await this.initialize();
    return Array.from(this.tasks.values()).filter(task => task.status === status);
  }

  /**
   * Get active recurring tasks
   */
  async getActiveRecurringTasks(): Promise<ScheduledTask[]> {
    await this.initialize();
    return Array.from(this.tasks.values()).filter(
      task => task.scheduleType === 'cron' && task.status === 'active'
    );
  }

  /**
   * Get pending one-time tasks
   */
  async getPendingOneTimeTasks(): Promise<ScheduledTask[]> {
    await this.initialize();
    return Array.from(this.tasks.values()).filter(
      task => task.scheduleType === 'once' && task.status === 'active'
    );
  }
}

/**
 * Create a storage instance
 */
export function createStorage(storagePath: string): JsonTaskStorage {
  return new JsonTaskStorage(storagePath);
}
