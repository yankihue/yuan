// Legacy sequential queue (kept for reference)
export { TaskQueue, type QueuedTask, type TaskQueueConfig } from './task-queue.js';

// New parallel queue system
export {
  ParallelTaskQueue,
  type QueuedTask as ParallelQueuedTask,
  type ParallelQueueConfig,
  type TaskProcessor,
} from './parallel-task-queue.js';

export { SessionPool, type SessionPoolConfig } from './session-pool.js';

export {
  detectRepo,
  getDefaultRepoKey,
  isDefaultRepoKey,
  formatRepoKeyForDisplay,
  type RepoDetectionResult,
} from './repo-detector.js';
