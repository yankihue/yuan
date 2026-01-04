/**
 * Yuan Scheduler Service
 *
 * Main entry point for the scheduler service that provides
 * cron-like scheduled task execution for the Yuan second brain project.
 */

import 'dotenv/config';
import express, { type Request, type Response } from 'express';

import { createStorage, type JsonTaskStorage } from './storage.js';
import { createExecutor, type TaskExecutor } from './executor.js';
import { createScheduler, type Scheduler } from './scheduler.js';
import type { SchedulerConfig, CreateTaskInput, TaskAction } from './types.js';

// Re-export types and classes for external use
export * from './types.js';
export { createStorage, JsonTaskStorage } from './storage.js';
export { createExecutor, TaskExecutor } from './executor.js';
export { createScheduler, Scheduler } from './scheduler.js';

/**
 * Scheduler service with HTTP API
 */
export class SchedulerService {
  private app: express.Application;
  private scheduler: Scheduler;
  private storage: JsonTaskStorage;
  private executor: TaskExecutor;
  private config: SchedulerConfig;

  constructor(config: SchedulerConfig) {
    this.config = config;
    this.storage = createStorage(config.storagePath);
    this.executor = createExecutor(config);
    this.scheduler = createScheduler(this.storage, this.executor, config);
    this.app = express();

    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupMiddleware(): void {
    this.app.use(express.json());

    // Request logging
    this.app.use((req, _res, next) => {
      console.log(`[HTTP] ${req.method} ${req.path}`);
      next();
    });
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', service: 'scheduler' });
    });

    // List all tasks
    this.app.get('/api/tasks', async (_req: Request, res: Response) => {
      try {
        const tasks = await this.scheduler.listTasks();
        res.json({ tasks });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      }
    });

    // Get a single task
    this.app.get('/api/tasks/:id', async (req: Request, res: Response) => {
      try {
        const task = await this.scheduler.getTask(req.params.id);
        if (!task) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }
        res.json({ task });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      }
    });

    // Create a new task
    this.app.post('/api/tasks', async (req: Request, res: Response) => {
      try {
        const { name, description, schedule, action } = req.body as {
          name?: string;
          description?: string;
          schedule?: string;
          action?: TaskAction;
        };

        if (!name || !schedule || !action) {
          res.status(400).json({
            error: 'Missing required fields: name, schedule, action',
          });
          return;
        }

        const input: CreateTaskInput = {
          name,
          description,
          schedule,
          action,
        };

        const task = await this.scheduler.createTask(input);
        res.status(201).json({ task });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: message });
      }
    });

    // Delete a task
    this.app.delete('/api/tasks/:id', async (req: Request, res: Response) => {
      try {
        const deleted = await this.scheduler.deleteTask(req.params.id);
        if (!deleted) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }
        res.json({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      }
    });

    // Pause a task
    this.app.post('/api/tasks/:id/pause', async (req: Request, res: Response) => {
      try {
        const task = await this.scheduler.pauseTask(req.params.id);
        res.json({ task });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: message });
      }
    });

    // Resume a task
    this.app.post('/api/tasks/:id/resume', async (req: Request, res: Response) => {
      try {
        const task = await this.scheduler.resumeTask(req.params.id);
        res.json({ task });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: message });
      }
    });
  }

  /**
   * Start the scheduler service
   */
  async start(port: number = 3002): Promise<void> {
    // Initialize scheduler (load existing tasks)
    await this.scheduler.initialize();

    // Start HTTP server
    this.app.listen(port, () => {
      console.log(`[Scheduler] HTTP API listening on port ${port}`);
      console.log(`[Scheduler] Health check: http://localhost:${port}/health`);
    });
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    await this.scheduler.shutdown();
  }

  /**
   * Get the Express app (for testing)
   */
  getApp(): express.Application {
    return this.app;
  }

  /**
   * Get the scheduler instance
   */
  getScheduler(): Scheduler {
    return this.scheduler;
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
 * Main entry point
 */
async function main(): Promise<void> {
  const config = getConfigFromEnv();
  const port = parseInt(process.env.SCHEDULER_PORT || '3002', 10);

  console.log('[Scheduler] Starting scheduler service...');
  console.log(`[Scheduler] Storage path: ${config.storagePath}`);
  console.log(`[Scheduler] Orchestrator URL: ${config.orchestratorUrl}`);
  console.log(`[Scheduler] Timezone: ${config.timezone}`);

  const service = new SchedulerService(config);

  // Handle shutdown signals
  process.on('SIGINT', async () => {
    console.log('\n[Scheduler] Received SIGINT, shutting down...');
    await service.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('[Scheduler] Received SIGTERM, shutting down...');
    await service.shutdown();
    process.exit(0);
  });

  await service.start(port);
}

// Run if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error) => {
    console.error('[Scheduler] Fatal error:', error);
    process.exit(1);
  });
}
