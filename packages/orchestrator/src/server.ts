import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import type {
  Instruction,
  ApprovalResponse,
  OrchestratorUpdate,
  StatusResponse,
  AgentType,
  InputResponse,
  RepoQueueInfo,
} from './types.js';
import { ClaudeCodeSession } from './claude-code/session.js';
import { SubAgentManager } from './claude-code/sub-agent.js';
import { CodexSession } from './codex/session.js';
import { ApprovalGate } from './approval/gate.js';
import { SessionManager } from './state/session.js';
import {
  ParallelTaskQueue,
  SessionPool,
  detectRepo,
  formatRepoKeyForDisplay,
  type ParallelQueuedTask,
} from './queue/index.js';
import { PermissionGuard } from './permissions/index.js';

interface ServerConfig {
  port: number;
  secret: string;
  anthropicApiKey?: string; // Optional: if not set, uses manual login
  codexCommand?: string;
  codexArgs?: string[];
  workingDirectory?: string;
  claudeTokenLimit?: number;
  claudeTokenWarningRatio?: number;
  maxConcurrentRepos?: number; // Max repos to process in parallel
}

export class OrchestratorServer {
  private config: ServerConfig;
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private sessionPool: SessionPool;
  private codexSession: CodexSession;
  private subAgentManager: SubAgentManager;
  private approvalGate: ApprovalGate;
  private sessionManager: SessionManager;
  private pendingInputs: Map<string, { userId: string; agent: AgentType; repoKey: string }>;
  private taskQueue: ParallelTaskQueue;
  private permissionGuard: PermissionGuard;

  constructor(config: ServerConfig) {
    this.config = config;
    this.app = express();
    this.httpServer = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

    this.approvalGate = new ApprovalGate();
    this.sessionManager = new SessionManager();
    this.pendingInputs = new Map();
    this.permissionGuard = new PermissionGuard();

    // Initialize parallel task queue
    this.taskQueue = new ParallelTaskQueue({
      maxQueueSize: 50,
      maxTasksPerUser: 10,
      maxConcurrentRepos: config.maxConcurrentRepos ?? 5,
    });

    // Initialize session pool for parallel repo processing
    this.sessionPool = new SessionPool(
      {
        maxConcurrentSessions: config.maxConcurrentRepos ?? 5,
        anthropicApiKey: config.anthropicApiKey,
        workingDirectory: config.workingDirectory,
        tokenLimit: config.claudeTokenLimit,
        tokenWarningRatio: config.claudeTokenWarningRatio,
      },
      this.approvalGate
    );

    this.codexSession = new CodexSession({
      command: config.codexCommand,
      args: config.codexArgs,
      workingDirectory: config.workingDirectory,
      sessionManager: this.sessionManager,
      approvalGate: this.approvalGate,
      agentType: 'codex',
    });

    // Initialize sub-agent manager
    this.subAgentManager = new SubAgentManager(config.anthropicApiKey);

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupEventForwarding();
    this.setupTaskQueue();
  }

  private setupTaskQueue(): void {
    // Forward queue updates to WebSocket clients
    this.taskQueue.on('update', (update: OrchestratorUpdate) => {
      this.broadcastUpdate(update);
    });

    // Forward session pool updates to WebSocket clients
    this.sessionPool.on('update', (update: OrchestratorUpdate) => {
      this.broadcastUpdate(update);
    });

    // Set up the processor callback for the parallel queue
    this.taskQueue.setProcessor(async (task: ParallelQueuedTask) => {
      // Only process Claude tasks (ignoring Codex as per user request)
      if (task.agent !== 'claude') {
        this.broadcastUpdate({
          type: 'ERROR',
          userId: task.userId,
          message: 'Only Claude is supported. Codex tasks are currently disabled.',
          agent: task.agent,
          taskId: task.id,
        });
        return;
      }

      // Check for blocked operations before processing
      const permCheck = this.permissionGuard.check(task.instruction);
      if (!permCheck.allowed && permCheck.blocked) {
        this.broadcastUpdate({
          type: 'ERROR',
          userId: task.userId,
          message: `🚫 BLOCKED: ${permCheck.blocked.reason}. This operation is not allowed.`,
          agent: task.agent,
          taskId: task.id,
        });
        return;
      }

      // Get or create session for this repo
      const pooledSession = this.sessionPool.getOrCreateSession(task.repoKey);
      this.sessionPool.setRepoProcessing(task.repoKey, true);

      try {
        // Notify which repo is being worked on
        const repoDisplay = formatRepoKeyForDisplay(task.repoKey);
        this.broadcastUpdate({
          type: 'STATUS_UPDATE',
          userId: task.userId,
          message: `🔄 Processing task for ${repoDisplay}...`,
          agent: task.agent,
          taskId: task.id,
        });

        // Process with the repo-specific Claude session
        await pooledSession.session.processInstruction(task.instruction, task.userId);
      } finally {
        this.sessionPool.setRepoProcessing(task.repoKey, false);
      }
    });
  }

  private setupMiddleware(): void {
    this.app.use(express.json());

    // Authentication middleware
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid authorization header' });
        return;
      }

      const token = authHeader.substring(7);
      if (token !== this.config.secret) {
        res.status(403).json({ error: 'Invalid token' });
        return;
      }

      next();
    });

    // Error handling middleware
    this.app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
      console.error('Server error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  private setupRoutes(): void {
    // Health check (no auth required)
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // Receive instruction from bot
    this.app.post('/instruction', async (req: Request, res: Response) => {
      try {
        const instruction: Instruction = req.body;
        this.clearPendingInputsForUser(instruction.userId);

        console.log(`Received instruction from user ${instruction.userId}: ${instruction.instruction.substring(0, 50)}...`);

        const detected = this.detectAgent(instruction.instruction);

        // Force Claude for all tasks (ignoring Codex as per user request)
        const effectiveAgent: AgentType = 'claude';

        // Detect which repo this instruction is for
        const repoDetection = detectRepo(detected.cleanedInstruction);
        const repoKey = repoDetection.repoKey;

        console.log(`Detected repo: ${repoKey} (confidence: ${repoDetection.confidence}, isNew: ${repoDetection.isNewRepo})`);

        // Pre-check for blocked destructive operations
        const permCheck = this.permissionGuard.check(detected.cleanedInstruction);
        if (!permCheck.allowed && permCheck.blocked) {
          res.json({
            status: 'rejected',
            reason: 'blocked_operation',
            message: permCheck.blocked.reason,
            timestamp: new Date().toISOString(),
          });

          this.broadcastUpdate({
            type: 'ERROR',
            userId: instruction.userId,
            message: `🚫 BLOCKED: ${permCheck.blocked.reason}. This operation is not allowed.`,
            agent: effectiveAgent,
          });
          return;
        }

        // Enqueue the task with repo context - parallel queue handles concurrent processing
        const queuedTask = this.taskQueue.enqueue(
          instruction.userId,
          detected.cleanedInstruction,
          effectiveAgent,
          repoKey
        );

        if (!queuedTask) {
          res.json({
            status: 'rejected',
            reason: 'queue_full',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        // Acknowledge receipt with queue info
        const queueStatus = this.taskQueue.getQueueStatus();
        res.json({
          status: 'accepted',
          taskId: queuedTask.id,
          repoKey: repoKey,
          queuePosition: queuedTask.position,
          totalQueued: queueStatus.totalQueued,
          activeRepos: queueStatus.activeRepos,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error('Error processing instruction:', error);
        res.status(500).json({ error: 'Failed to process instruction' });
      }
    });

    // Receive input responses from bot
    this.app.post('/input-response', async (req: Request, res: Response) => {
      try {
        const inputResponse: InputResponse = req.body;
        const pending = this.pendingInputs.get(inputResponse.inputId);

        if (!pending || pending.userId !== inputResponse.userId) {
          res.status(404).json({ error: 'Input request not found or already resolved' });
          return;
        }

        if (pending.agent === 'codex') {
          res.status(400).json({ error: 'Input responses for Codex sessions are not supported yet' });
          return;
        }

        // Get the session for this repo
        const pooledSession = this.sessionPool.getSession(pending.repoKey);
        if (!pooledSession) {
          res.status(404).json({ error: 'Session not found for this input' });
          return;
        }

        const success = await pooledSession.session.submitInputResponse(
          inputResponse.userId,
          inputResponse.inputId,
          inputResponse.response
        );

        if (!success) {
          res.status(400).json({ error: 'Failed to process input response' });
          return;
        }

        this.pendingInputs.delete(inputResponse.inputId);
        res.json({ status: 'accepted' });
      } catch (error) {
        console.error('Error processing input response:', error);
        res.status(500).json({ error: 'Failed to process input response' });
      }
    });

    // Receive approval response from bot
    this.app.post('/approval-response', (req: Request, res: Response) => {
      try {
        const response: ApprovalResponse = req.body;

        console.log(`Received approval response: ${response.approvalId} = ${response.approved}`);

        const handled = this.approvalGate.handleResponse(
          response.approvalId,
          response.approved,
          response.userId
        );

        if (handled) {
          res.json({ status: 'processed' });
        } else {
          res.status(404).json({ error: 'Approval not found or already processed' });
        }
      } catch (error) {
        console.error('Error processing approval response:', error);
        res.status(500).json({ error: 'Failed to process approval response' });
      }
    });

    // Reset conversation history for a user
    this.app.post('/reset', (req: Request, res: Response) => {
      try {
        const { userId } = req.body as { userId?: string };

        if (!userId) {
          res.status(400).json({ error: 'userId is required' });
          return;
        }

        this.sessionManager.clearConversation(userId);
        this.sessionPool.clearUserHistory(userId);
        this.codexSession.clearUserHistory(userId);

        res.json({ status: 'reset', userId });
      } catch (error) {
        console.error('Error resetting conversation:', error);
        res.status(500).json({ error: 'Failed to reset conversation' });
      }
    });

    // Cancel a specific task by taskId
    this.app.post('/cancel-task', (req: Request, res: Response) => {
      try {
        const { taskId, userId } = req.body as { taskId?: string; userId?: string };

        if (!taskId || !userId) {
          res.status(400).json({ error: 'Missing taskId or userId' });
          return;
        }

        // Try to cancel from the parallel queue
        const result = this.taskQueue.cancelTask(taskId, userId);

        if (!result.cancelled) {
          res.status(404).json({ error: 'Task not found or already finished' });
          return;
        }

        // If it was processing, cancel the session too
        if (result.wasProcessing && result.repoKey) {
          this.sessionPool.cancelRepoTask(result.repoKey);
        }

        this.approvalGate.cancelAllForUser(userId);

        this.broadcastUpdate({
          type: 'STATUS_UPDATE',
          userId,
          message: `🛑 Task ${taskId} cancelled by user.`,
          agent: 'claude',
          taskId,
        });

        res.json({ status: 'cancelled', repoKey: result.repoKey });
      } catch (error) {
        console.error('Error cancelling task:', error);
        res.status(500).json({ error: 'Failed to cancel task' });
      }
    });

    // Get status of all tasks
    this.app.get('/status', (_req: Request, res: Response) => {
      try {
        const subAgents = this.subAgentManager.getActiveAgents();
        const queueStatus = this.taskQueue.getQueueStatus();
        const sessionStats = this.sessionPool.getStats();

        // Build repo queue info
        const repoQueues: RepoQueueInfo[] = [];
        for (const [repoKey, info] of queueStatus.queuesByRepo.entries()) {
          const processingTask = this.taskQueue.getProcessingTask(repoKey);
          repoQueues.push({
            repoKey,
            queued: info.queued,
            processing: info.processing,
            currentTaskId: processingTask?.id,
          });
        }

        const status: StatusResponse = {
          subAgents,
          parallelQueue: {
            totalQueued: queueStatus.totalQueued,
            activeRepos: queueStatus.activeRepos,
            maxConcurrentRepos: queueStatus.maxConcurrentRepos,
            processingRepos: queueStatus.processingRepos,
            repoQueues,
          },
        };

        res.json(status);
      } catch (error) {
        console.error('Error getting status:', error);
        res.status(500).json({ error: 'Failed to get status' });
      }
    });

    this.app.post('/cancel', (req: Request, res: Response) => {
      try {
        const { userId } = req.body as { userId?: string };

        if (!userId) {
          res.status(400).json({ error: 'userId is required' });
          return;
        }

        // Cancel all tasks for this user from the parallel queue
        const { cancelled: cancelledFromQueue, processingRepos } = this.taskQueue.cancelAllForUser(userId);

        // Cancel sessions for repos that were processing
        for (const repoKey of processingRepos) {
          this.sessionPool.cancelRepoTask(repoKey);
        }

        const cancelledSubAgents = this.subAgentManager.cancelAllForUser(userId);
        this.approvalGate.cancelAllForUser(userId);

        const totalStopped = cancelledFromQueue + cancelledSubAgents;
        const message = totalStopped > 0
          ? `⏹️ Cancelled ${totalStopped} task(s): ${processingRepos.length} running, ${cancelledFromQueue - processingRepos.length} queued, ${cancelledSubAgents} sub-agent(s).`
          : 'ℹ️ No active tasks to cancel.';

        if (totalStopped > 0) {
          this.broadcastUpdate({
            type: 'STATUS_UPDATE',
            userId,
            message,
            agent: 'claude',
          });
        }

        res.json({
          cancelledTasks: cancelledFromQueue,
          cancelledRunning: processingRepos.length,
          cancelledQueued: cancelledFromQueue - processingRepos.length,
          cancelledSubAgents,
          processingRepos,
          message,
        });
      } catch (error) {
        console.error('Error cancelling tasks:', error);
        res.status(500).json({ error: 'Failed to cancel tasks' });
      }
    });
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      // Verify authentication for WebSocket
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') ||
          authHeader.substring(7) !== this.config.secret) {
        console.log('WebSocket connection rejected: invalid auth');
        ws.close(4001, 'Unauthorized');
        return;
      }

      console.log('WebSocket client connected');
      this.clients.add(ws);

      ws.on('close', () => {
        console.log('WebSocket client disconnected');
        this.clients.delete(ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.clients.delete(ws);
      });

      // Send initial connection confirmation
      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
    });
  }

  private setupEventForwarding(): void {
    // Note: SessionPool updates are forwarded in setupTaskQueue()

    this.codexSession.on('update', (update: OrchestratorUpdate) => {
      this.broadcastUpdate(update);
    });

    this.approvalGate.on('update', (update: OrchestratorUpdate) => {
      this.broadcastUpdate(update);
    });

    // Forward updates from sub-agent manager
    this.subAgentManager.on('update', (update: OrchestratorUpdate) => {
      this.broadcastUpdate(update);
    });
  }

  private broadcastUpdate(update: OrchestratorUpdate): void {
    this.updatePendingInputState(update);
    const message = JSON.stringify(update);

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }

    console.log(`Broadcast update [${update.type}] to ${this.clients.size} client(s): ${update.message.substring(0, 50)}...`);
  }

  private detectAgent(instruction: string): { agent: AgentType; cleanedInstruction: string } {
    const trimmed = instruction.trim();
    const codexPrefix = /^\s*(?:codex|chatgpt|gpt|openai)[\s,:-]*/i;
    const claudePrefix = /^\s*claude[\s,:-]*/i;

    if (codexPrefix.test(trimmed)) {
      return {
        agent: 'codex',
        cleanedInstruction: trimmed.replace(codexPrefix, '').trim() || instruction,
      };
    }

    if (claudePrefix.test(trimmed)) {
      return {
        agent: 'claude',
        cleanedInstruction: trimmed.replace(claudePrefix, '').trim() || instruction,
      };
    }

    if (/\bcodex\b|\bchatgpt\b|\bgpt\b/i.test(trimmed)) {
      return { agent: 'codex', cleanedInstruction: instruction };
    }

    return { agent: 'claude', cleanedInstruction: instruction };
  }

  private isAnySessionProcessing(): boolean {
    return (
      this.taskQueue.isAnyProcessing() ||
      this.codexSession.isCurrentlyProcessing()
    );
  }

  private updatePendingInputState(update: OrchestratorUpdate & { repoKey?: string }): void {
    if (update.type === 'INPUT_NEEDED' && update.inputId) {
      // Try to find the repoKey from the task
      let repoKey = update.repoKey ?? '__default__';

      // If no repoKey in update, try to find it from processing repos
      if (!update.repoKey) {
        const queueStatus = this.taskQueue.getQueueStatus();
        if (queueStatus.processingRepos.length === 1) {
          repoKey = queueStatus.processingRepos[0];
        }
      }

      this.pendingInputs.set(update.inputId, {
        userId: update.userId,
        agent: update.agent ?? 'claude',
        repoKey,
      });
      return;
    }

    if (update.type === 'TASK_COMPLETE' || update.type === 'ERROR') {
      this.clearPendingInputsForUser(update.userId);
    }
  }

  private clearPendingInputsForUser(userId: string): void {
    for (const [inputId, pending] of this.pendingInputs.entries()) {
      if (pending.userId === userId) {
        this.pendingInputs.delete(inputId);
      }
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, () => {
        console.log(`Orchestrator server listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Cleanup
    this.subAgentManager.cleanup();
    this.approvalGate.clearAll();

    // Close WebSocket connections
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();

    // Close servers
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.httpServer.close(() => {
          console.log('Orchestrator server stopped');
          resolve();
        });
      });
    });
  }
}
