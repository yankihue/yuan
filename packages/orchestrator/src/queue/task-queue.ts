import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type { AgentType, OrchestratorUpdate } from '../types.js';

export interface QueuedTask {
  id: string;
  userId: string;
  instruction: string;
  agent: AgentType;
  queuedAt: Date;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  position: number;
}

export interface TaskQueueConfig {
  maxQueueSize?: number;
  maxTasksPerUser?: number;
}

export class TaskQueue extends EventEmitter {
  private queue: QueuedTask[] = [];
  private isProcessing = false;
  private currentTask: QueuedTask | null = null;
  private config: Required<TaskQueueConfig>;
  private processorCallback: ((task: QueuedTask) => Promise<void>) | null = null;

  constructor(config: TaskQueueConfig = {}) {
    super();
    this.config = {
      maxQueueSize: config.maxQueueSize ?? 50,
      maxTasksPerUser: config.maxTasksPerUser ?? 10,
    };
  }

  /**
   * Set the processor callback that will be called for each task
   */
  setProcessor(callback: (task: QueuedTask) => Promise<void>): void {
    this.processorCallback = callback;
  }

  /**
   * Enqueue a new task
   * Returns the queued task with its position, or null if queue is full
   */
  enqueue(
    userId: string,
    instruction: string,
    agent: AgentType
  ): QueuedTask | null {
    // Check queue limits
    if (this.queue.length >= this.config.maxQueueSize) {
      this.emit('update', {
        type: 'ERROR',
        userId,
        message: `Queue is full (max ${this.config.maxQueueSize} tasks). Please wait for some tasks to complete.`,
        agent,
      } as OrchestratorUpdate);
      return null;
    }

    // Check per-user limits
    const userTasks = this.queue.filter(t => t.userId === userId && t.status === 'queued');
    if (userTasks.length >= this.config.maxTasksPerUser) {
      this.emit('update', {
        type: 'ERROR',
        userId,
        message: `You have too many tasks queued (max ${this.config.maxTasksPerUser}). Please wait for some to complete.`,
        agent,
      } as OrchestratorUpdate);
      return null;
    }

    const task: QueuedTask = {
      id: uuidv4(),
      userId,
      instruction,
      agent,
      queuedAt: new Date(),
      status: 'queued',
      position: this.queue.length + 1,
    };

    this.queue.push(task);

    // Emit queue status
    if (this.queue.length > 1 || this.isProcessing) {
      const position = this.isProcessing ? this.queue.length : this.queue.length;
      this.emit('update', {
        type: 'STATUS_UPDATE',
        userId,
        message: `📋 Task queued (position ${position}). Will start when current task completes.`,
        agent,
        taskId: task.id,
      } as OrchestratorUpdate);
    }

    // Start processing if not already processing
    this.processNext();

    return task;
  }

  /**
   * Process the next task in the queue
   */
  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0 || !this.processorCallback) {
      return;
    }

    const task = this.queue.find(t => t.status === 'queued');
    if (!task) {
      return;
    }

    this.isProcessing = true;
    this.currentTask = task;
    task.status = 'processing';

    // Update positions for remaining queued tasks
    this.updatePositions();

    try {
      await this.processorCallback(task);
      task.status = 'completed';
    } catch (error) {
      task.status = 'failed';
      console.error('Task failed:', error);
    } finally {
      this.isProcessing = false;
      this.currentTask = null;

      // Remove completed/failed task from queue
      this.queue = this.queue.filter(t => t.status === 'queued');

      // Notify users about position updates
      this.notifyPositionUpdates();

      // Process next task
      setImmediate(() => this.processNext());
    }
  }

  /**
   * Update positions for queued tasks
   */
  private updatePositions(): void {
    let position = 1;
    for (const task of this.queue) {
      if (task.status === 'queued') {
        task.position = position++;
      }
    }
  }

  /**
   * Notify users about their updated queue positions
   */
  private notifyPositionUpdates(): void {
    for (const task of this.queue) {
      if (task.status === 'queued' && task.position <= 3) {
        this.emit('update', {
          type: 'STATUS_UPDATE',
          userId: task.userId,
          message: `⏳ Your task is now position ${task.position} in queue.`,
          agent: task.agent,
          taskId: task.id,
        } as OrchestratorUpdate);
      }
    }
  }

  /**
   * Cancel a specific task
   */
  cancelTask(taskId: string, userId: string): boolean {
    const task = this.queue.find(t => t.id === taskId && t.userId === userId);
    if (!task) {
      return false;
    }

    if (task.status === 'processing') {
      // Let the caller handle canceling the actual process
      task.status = 'cancelled';
      return true;
    }

    if (task.status === 'queued') {
      task.status = 'cancelled';
      this.queue = this.queue.filter(t => t.id !== taskId);
      this.updatePositions();
      return true;
    }

    return false;
  }

  /**
   * Cancel all tasks for a user
   */
  cancelAllForUser(userId: string): number {
    let cancelled = 0;
    for (const task of this.queue) {
      if (task.userId === userId && task.status === 'queued') {
        task.status = 'cancelled';
        cancelled++;
      }
    }
    this.queue = this.queue.filter(t => t.status === 'queued');
    this.updatePositions();
    return cancelled;
  }

  /**
   * Get queue status
   */
  getQueueStatus(): {
    totalQueued: number;
    isProcessing: boolean;
    currentTask: QueuedTask | null;
    queuedTasks: QueuedTask[];
  } {
    return {
      totalQueued: this.queue.filter(t => t.status === 'queued').length,
      isProcessing: this.isProcessing,
      currentTask: this.currentTask,
      queuedTasks: this.queue.filter(t => t.status === 'queued'),
    };
  }

  /**
   * Get tasks for a specific user
   */
  getTasksForUser(userId: string): QueuedTask[] {
    return this.queue.filter(t => t.userId === userId);
  }

  /**
   * Check if currently processing
   */
  isCurrentlyProcessing(): boolean {
    return this.isProcessing;
  }

  /**
   * Get current task
   */
  getCurrentTask(): QueuedTask | null {
    return this.currentTask;
  }

  /**
   * Clear all queued tasks
   */
  clear(): void {
    this.queue = [];
    this.updatePositions();
  }
}
