import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type { AgentType, OrchestratorUpdate } from '../types.js';

export interface QueuedTask {
  id: string;
  userId: string;
  instruction: string;
  agent: AgentType;
  repoKey: string;
  queuedAt: Date;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  position: number; // Position within its repo queue
}

export interface ParallelQueueConfig {
  maxQueueSize?: number;
  maxTasksPerUser?: number;
  maxConcurrentRepos?: number;
}

export type TaskProcessor = (task: QueuedTask) => Promise<void>;

/**
 * Parallel task queue that processes tasks grouped by repository.
 * - Tasks for the same repo are processed sequentially
 * - Tasks for different repos can run in parallel
 */
export class ParallelTaskQueue extends EventEmitter {
  private queues: Map<string, QueuedTask[]> = new Map(); // repoKey -> tasks
  private processingRepos: Set<string> = new Set(); // repos currently processing
  private config: Required<ParallelQueueConfig>;
  private processorCallback: TaskProcessor | null = null;

  constructor(config: ParallelQueueConfig = {}) {
    super();
    this.config = {
      maxQueueSize: config.maxQueueSize ?? 50,
      maxTasksPerUser: config.maxTasksPerUser ?? 10,
      maxConcurrentRepos: config.maxConcurrentRepos ?? 5,
    };
  }

  /**
   * Set the processor callback that will be called for each task
   */
  setProcessor(callback: TaskProcessor): void {
    this.processorCallback = callback;
  }

  /**
   * Enqueue a new task for a specific repo
   */
  enqueue(
    userId: string,
    instruction: string,
    agent: AgentType,
    repoKey: string
  ): QueuedTask | null {
    // Check total queue size across all repos
    const totalQueued = this.getTotalQueuedCount();
    if (totalQueued >= this.config.maxQueueSize) {
      this.emit('update', {
        type: 'ERROR',
        userId,
        message: `Queue is full (max ${this.config.maxQueueSize} tasks). Please wait for some tasks to complete.`,
        agent,
      } as OrchestratorUpdate);
      return null;
    }

    // Check per-user limits across all repos
    const userTaskCount = this.getUserTaskCount(userId);
    if (userTaskCount >= this.config.maxTasksPerUser) {
      this.emit('update', {
        type: 'ERROR',
        userId,
        message: `You have too many tasks queued (max ${this.config.maxTasksPerUser}). Please wait for some to complete.`,
        agent,
      } as OrchestratorUpdate);
      return null;
    }

    // Get or create queue for this repo
    if (!this.queues.has(repoKey)) {
      this.queues.set(repoKey, []);
    }
    const repoQueue = this.queues.get(repoKey)!;

    // Calculate position within repo queue
    const queuedInRepo = repoQueue.filter(t => t.status === 'queued').length;
    const isRepoProcessing = this.processingRepos.has(repoKey);

    const task: QueuedTask = {
      id: uuidv4(),
      userId,
      instruction,
      agent,
      repoKey,
      queuedAt: new Date(),
      status: 'queued',
      position: queuedInRepo + 1,
    };

    repoQueue.push(task);

    // Emit queue status
    if (queuedInRepo > 0 || isRepoProcessing) {
      this.emit('update', {
        type: 'STATUS_UPDATE',
        userId,
        message: `📋 Task queued for ${repoKey === '__default__' ? 'default workspace' : repoKey} (position ${task.position}). Will start when current task completes.`,
        agent,
        taskId: task.id,
      } as OrchestratorUpdate);
    } else if (this.processingRepos.size > 0) {
      this.emit('update', {
        type: 'STATUS_UPDATE',
        userId,
        message: `🚀 Starting task for ${repoKey === '__default__' ? 'default workspace' : repoKey} (running in parallel with ${this.processingRepos.size} other repo(s)).`,
        agent,
        taskId: task.id,
      } as OrchestratorUpdate);
    }

    // Try to start processing
    this.tryProcessNext();

    return task;
  }

  /**
   * Try to process next tasks for idle repos
   */
  private async tryProcessNext(): Promise<void> {
    if (!this.processorCallback) return;

    // Check each repo queue for tasks that can be started
    for (const [repoKey, repoQueue] of this.queues.entries()) {
      // Skip if this repo is already processing
      if (this.processingRepos.has(repoKey)) continue;

      // Skip if we've hit max concurrent repos
      if (this.processingRepos.size >= this.config.maxConcurrentRepos) break;

      // Find next queued task for this repo
      const task = repoQueue.find(t => t.status === 'queued');
      if (!task) continue;

      // Start processing this repo
      this.processingRepos.add(repoKey);
      task.status = 'processing';

      // Update positions for remaining tasks in this repo
      this.updateRepoPositions(repoKey);

      // Process asynchronously (don't await - allow parallel processing)
      this.processTask(task).catch(err => {
        console.error(`Error processing task ${task.id}:`, err);
      });
    }
  }

  /**
   * Process a single task
   */
  private async processTask(task: QueuedTask): Promise<void> {
    try {
      await this.processorCallback!(task);
      task.status = 'completed';
    } catch (error) {
      task.status = 'failed';
      console.error('Task failed:', error);
    } finally {
      // Remove from processing set
      this.processingRepos.delete(task.repoKey);

      // Clean up completed/failed tasks from repo queue
      const repoQueue = this.queues.get(task.repoKey);
      if (repoQueue) {
        const filtered = repoQueue.filter(t => t.status === 'queued');
        if (filtered.length === 0) {
          this.queues.delete(task.repoKey);
        } else {
          this.queues.set(task.repoKey, filtered);
        }
      }

      // Notify position updates
      this.notifyPositionUpdates(task.repoKey);

      // Try to start next task(s)
      setImmediate(() => this.tryProcessNext());
    }
  }

  /**
   * Update positions for queued tasks in a repo
   */
  private updateRepoPositions(repoKey: string): void {
    const repoQueue = this.queues.get(repoKey);
    if (!repoQueue) return;

    let position = 1;
    for (const task of repoQueue) {
      if (task.status === 'queued') {
        task.position = position++;
      }
    }
  }

  /**
   * Notify users about their updated queue positions in a repo
   */
  private notifyPositionUpdates(repoKey: string): void {
    const repoQueue = this.queues.get(repoKey);
    if (!repoQueue) return;

    for (const task of repoQueue) {
      if (task.status === 'queued' && task.position <= 3) {
        this.emit('update', {
          type: 'STATUS_UPDATE',
          userId: task.userId,
          message: `⏳ Your task for ${repoKey === '__default__' ? 'default workspace' : repoKey} is now position ${task.position}.`,
          agent: task.agent,
          taskId: task.id,
        } as OrchestratorUpdate);
      }
    }
  }

  /**
   * Cancel a specific task
   */
  cancelTask(taskId: string, userId: string): { cancelled: boolean; wasProcessing: boolean; repoKey?: string } {
    for (const [repoKey, repoQueue] of this.queues.entries()) {
      const task = repoQueue.find(t => t.id === taskId && t.userId === userId);
      if (!task) continue;

      const wasProcessing = task.status === 'processing';

      if (task.status === 'processing') {
        task.status = 'cancelled';
        this.processingRepos.delete(repoKey);
        return { cancelled: true, wasProcessing: true, repoKey };
      }

      if (task.status === 'queued') {
        task.status = 'cancelled';
        const filtered = repoQueue.filter(t => t.id !== taskId);
        if (filtered.length === 0) {
          this.queues.delete(repoKey);
        } else {
          this.queues.set(repoKey, filtered);
          this.updateRepoPositions(repoKey);
        }
        return { cancelled: true, wasProcessing: false, repoKey };
      }
    }

    return { cancelled: false, wasProcessing: false };
  }

  /**
   * Cancel all tasks for a user
   */
  cancelAllForUser(userId: string): { cancelled: number; processingRepos: string[] } {
    let cancelled = 0;
    const processingRepos: string[] = [];

    for (const [repoKey, repoQueue] of this.queues.entries()) {
      for (const task of repoQueue) {
        if (task.userId === userId) {
          if (task.status === 'processing') {
            task.status = 'cancelled';
            this.processingRepos.delete(repoKey);
            processingRepos.push(repoKey);
            cancelled++;
          } else if (task.status === 'queued') {
            task.status = 'cancelled';
            cancelled++;
          }
        }
      }

      // Clean up queue
      const filtered = repoQueue.filter(t => t.status === 'queued');
      if (filtered.length === 0) {
        this.queues.delete(repoKey);
      } else {
        this.queues.set(repoKey, filtered);
        this.updateRepoPositions(repoKey);
      }
    }

    return { cancelled, processingRepos };
  }

  /**
   * Get total queued count across all repos
   */
  getTotalQueuedCount(): number {
    let count = 0;
    for (const repoQueue of this.queues.values()) {
      count += repoQueue.filter(t => t.status === 'queued').length;
    }
    return count;
  }

  /**
   * Get task count for a specific user
   */
  getUserTaskCount(userId: string): number {
    let count = 0;
    for (const repoQueue of this.queues.values()) {
      count += repoQueue.filter(t => t.userId === userId && t.status === 'queued').length;
    }
    return count;
  }

  /**
   * Get queue status
   */
  getQueueStatus(): {
    totalQueued: number;
    activeRepos: number;
    maxConcurrentRepos: number;
    processingRepos: string[];
    queuesByRepo: Map<string, { queued: number; processing: boolean }>;
  } {
    const queuesByRepo = new Map<string, { queued: number; processing: boolean }>();

    for (const [repoKey, repoQueue] of this.queues.entries()) {
      const queued = repoQueue.filter(t => t.status === 'queued').length;
      const processing = this.processingRepos.has(repoKey);
      if (queued > 0 || processing) {
        queuesByRepo.set(repoKey, { queued, processing });
      }
    }

    return {
      totalQueued: this.getTotalQueuedCount(),
      activeRepos: this.processingRepos.size,
      maxConcurrentRepos: this.config.maxConcurrentRepos,
      processingRepos: Array.from(this.processingRepos),
      queuesByRepo,
    };
  }

  /**
   * Get all tasks for a user
   */
  getTasksForUser(userId: string): QueuedTask[] {
    const tasks: QueuedTask[] = [];
    for (const repoQueue of this.queues.values()) {
      tasks.push(...repoQueue.filter(t => t.userId === userId));
    }
    return tasks;
  }

  /**
   * Check if any repo is currently processing
   */
  isAnyProcessing(): boolean {
    return this.processingRepos.size > 0;
  }

  /**
   * Get processing task for a repo
   */
  getProcessingTask(repoKey: string): QueuedTask | null {
    const repoQueue = this.queues.get(repoKey);
    if (!repoQueue) return null;
    return repoQueue.find(t => t.status === 'processing') ?? null;
  }

  /**
   * Clear all queues
   */
  clear(): void {
    this.queues.clear();
    this.processingRepos.clear();
  }
}
