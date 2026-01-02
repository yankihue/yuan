import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import type { Instruction, ApprovalResponse, OrchestratorUpdate, StatusResponse, AgentType } from './types.js';
import { ClaudeCodeSession } from './claude-code/session.js';
import { SubAgentManager } from './claude-code/sub-agent.js';
import { CodexSession } from './codex/session.js';
import { ApprovalGate } from './approval/gate.js';
import { SessionManager } from './state/session.js';

interface ServerConfig {
  port: number;
  secret: string;
  anthropicApiKey: string;
  codexCommand?: string;
  codexArgs?: string[];
  workingDirectory?: string;
}

export class OrchestratorServer {
  private config: ServerConfig;
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private claudeSession: ClaudeCodeSession;
  private codexSession: CodexSession;
  private subAgentManager: SubAgentManager;
  private approvalGate: ApprovalGate;
  private sessionManager: SessionManager;

  constructor(config: ServerConfig) {
    this.config = config;
    this.app = express();
    this.httpServer = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

    this.approvalGate = new ApprovalGate();
    this.sessionManager = new SessionManager();

    // Initialize Claude Code session
    this.claudeSession = new ClaudeCodeSession({
      anthropicApiKey: config.anthropicApiKey,
      workingDirectory: config.workingDirectory,
      sessionManager: this.sessionManager,
      approvalGate: this.approvalGate,
      agentType: 'claude',
    });

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

        console.log(`Received instruction from user ${instruction.userId}: ${instruction.instruction.substring(0, 50)}...`);

        // Acknowledge receipt immediately
        res.json({ status: 'accepted', timestamp: new Date().toISOString() });

        const detected = this.detectAgent(instruction.instruction);
        const targetAgent: AgentType = detected.agent;
        const session = targetAgent === 'codex' ? this.codexSession : this.claudeSession;

        if (this.isAnySessionProcessing()) {
          this.broadcastUpdate({
            type: 'ERROR',
            userId: instruction.userId,
            message: 'A task is already in progress. Please wait for it to complete.',
            agent: targetAgent,
          });
          return;
        }

        const agentLabel = targetAgent === 'codex' ? 'ChatGPT Codex' : 'Claude Code';
        this.broadcastUpdate({
          type: 'STATUS_UPDATE',
          userId: instruction.userId,
          message: `🤖 Routing to ${agentLabel} based on your request.`,
          agent: targetAgent,
        });

        // Process asynchronously
        await session.processInstruction(detected.cleanedInstruction, instruction.userId);
      } catch (error) {
        console.error('Error processing instruction:', error);
        res.status(500).json({ error: 'Failed to process instruction' });
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

    // Get status of all tasks
    this.app.get('/status', (_req: Request, res: Response) => {
      try {
        const currentTask = this.sessionManager.getCurrentTask();
        const subAgents = this.subAgentManager.getActiveAgents();

        const status: StatusResponse = {
          subAgents,
          currentTask: currentTask
            ? {
                description: currentTask.description,
                status: currentTask.status,
                startedAt: currentTask.startedAt,
                agent: currentTask.agent,
              }
            : undefined,
        };

        res.json(status);
      } catch (error) {
        console.error('Error getting status:', error);
        res.status(500).json({ error: 'Failed to get status' });
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
    // Forward updates from Claude session to WebSocket clients
    this.claudeSession.on('update', (update: OrchestratorUpdate) => {
      this.broadcastUpdate(update);
    });

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
      this.claudeSession.isCurrentlyProcessing() ||
      this.codexSession.isCurrentlyProcessing()
    );
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
