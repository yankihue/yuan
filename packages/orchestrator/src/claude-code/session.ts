import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type {
  AgentType,
  ConversationMessage,
  ConversationOptions,
  OrchestratorUpdate,
  TaskInfo,
} from '../types.js';
import { SessionManager } from '../state/session.js';
import { IntentParser } from './parser.js';
import { ApprovalDetector, type DetectedApproval } from '../approval/detector.js';
import { ApprovalGate } from '../approval/gate.js';

interface ClaudeSessionConfig {
  anthropicApiKey: string;
  workingDirectory?: string;
  sessionManager?: SessionManager;
  approvalGate: ApprovalGate;
  agentType?: AgentType;
}

interface StreamMessage {
  type: string;
  content?: string;
  tool?: string;
  tool_input?: unknown;
  result?: string;
}

export class ClaudeCodeSession extends EventEmitter {
  private config: ClaudeSessionConfig;
  private sessionManager: SessionManager;
  private intentParser: IntentParser;
  private approvalDetector: ApprovalDetector;
  private approvalGate: ApprovalGate;
  private conversationHistory: ConversationMessage[] = [];
  private conversationOptions: ConversationOptions = {
    includeHistory: true,
    maxTurns: 20,
    maxTokens: 2000,
  };
  private isProcessing = false;
  private currentProcess: ChildProcess | null = null;
  private agentType: AgentType;

  constructor(config: ClaudeSessionConfig) {
    super();
    this.config = config;
    this.sessionManager = config.sessionManager ?? new SessionManager();
    this.intentParser = new IntentParser(this.sessionManager);
    this.approvalDetector = new ApprovalDetector();
    this.approvalGate = config.approvalGate;
    this.agentType = config.agentType ?? 'claude';
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getApprovalGate(): ApprovalGate {
    return this.approvalGate;
  }

  isCurrentlyProcessing(): boolean {
    return this.isProcessing;
  }

  async processInstruction(instruction: string, userId: string): Promise<void> {
    if (this.isProcessing) {
      this.emit('update', {
        type: 'ERROR',
        userId,
        message: 'A task is already in progress. Please wait for it to complete.',
        agent: this.agentType,
      } as OrchestratorUpdate);
      return;
    }

    this.isProcessing = true;

    try {
      // Parse for repo context changes
      const context = this.intentParser.parseRepoContext(instruction);
      if (context) {
        this.intentParser.applyContext(context);

        // Notify user of context switch
        if (context.action === 'switch' || context.action === 'create') {
          const repoName = this.sessionManager.getFullRepoName() || context.repo;
          this.emit('update', {
            type: 'STATUS_UPDATE',
            userId,
            message: `📁 Working in repository: ${repoName}${context.branch ? ` (branch: ${context.branch})` : ''}`,
            agent: this.agentType,
          } as OrchestratorUpdate);
        }
      }

      // Start task tracking
      const taskDescription = this.extractTaskDescription(instruction);
      const task = this.sessionManager.startTask(taskDescription, userId, this.agentType);

      this.emit('update', {
        type: 'STATUS_UPDATE',
        userId,
        message: `🚀 Starting with Claude: ${taskDescription}`,
        agent: this.agentType,
      } as OrchestratorUpdate);

      const fullPrompt = this.buildPromptWithHistory(instruction, userId);

      // Execute with Claude Code CLI
      await this.executeWithClaudeCodeCLI(fullPrompt, userId, task);

    } catch (error) {
      console.error('Error processing instruction:', error);
      this.sessionManager.failTask();

      this.emit('update', {
        type: 'ERROR',
        userId,
        message: `Failed to process instruction: ${error instanceof Error ? error.message : String(error)}`,
        agent: this.agentType,
      } as OrchestratorUpdate);
    } finally {
      this.isProcessing = false;
      this.currentProcess = null;
    }
  }

  private async executeWithClaudeCodeCLI(
    prompt: string,
    userId: string,
    _task: TaskInfo
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const workingDir = this.config.workingDirectory || process.cwd();

      // Spawn Claude Code CLI in non-interactive mode
      const args = [
        '--print',           // Non-interactive print mode
        '--output-format', 'stream-json',  // JSON streaming output
        prompt
      ];

      this.currentProcess = spawn('claude', args, {
        cwd: workingDir,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: this.config.anthropicApiKey,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let fullResponse = '';
      let buffer = '';

      this.currentProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();

        // Process complete JSON lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const message: StreamMessage = JSON.parse(line);
            this.handleStreamMessage(message, userId);

            if (message.type === 'assistant' && message.content) {
              fullResponse += message.content;
            } else if (message.type === 'result' && message.result) {
              fullResponse += message.result;
            }
          } catch {
            // Not JSON, treat as plain text output
            fullResponse += line + '\n';
          }
        }
      });

      this.currentProcess.stderr?.on('data', (data: Buffer) => {
        console.error('Claude Code stderr:', data.toString());
      });

      this.currentProcess.on('error', (error) => {
        console.error('Failed to spawn Claude Code:', error);
        this.sessionManager.failTask();
        reject(new Error(`Failed to start Claude Code: ${error.message}`));
      });

      this.currentProcess.on('close', async (code) => {
        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const message: StreamMessage = JSON.parse(buffer);
            if (message.type === 'assistant' && message.content) {
              fullResponse += message.content;
            }
          } catch {
            fullResponse += buffer;
          }
        }

        if (code !== 0 && code !== null) {
          console.error(`Claude Code exited with code ${code}`);
          this.sessionManager.failTask();

          this.emit('update', {
            type: 'ERROR',
            userId,
            message: `Claude Code process exited with code ${code}`,
            agent: this.agentType,
          } as OrchestratorUpdate);

          reject(new Error(`Claude Code exited with code ${code}`));
          return;
        }

        // Check for approval-required commands in the response
        const detections = this.approvalDetector.detectInResponse(fullResponse);

        for (const detection of detections) {
          const repoContext = this.sessionManager.getFullRepoName() || 'current directory';
          const approved = await this.approvalGate.requestApproval(
            userId,
            detection,
            repoContext,
            this.agentType
          );

          if (!approved) {
            this.emit('update', {
              type: 'STATUS_UPDATE',
              userId,
              message: `⛔ Action rejected: ${detection.action}`,
              agent: this.agentType,
            } as OrchestratorUpdate);
          } else {
            this.emit('update', {
              type: 'STATUS_UPDATE',
              userId,
              message: `✅ Action approved: ${detection.action}`,
              agent: this.agentType,
            } as OrchestratorUpdate);
          }
        }

        this.appendAssistantResponse(fullResponse, userId);

        // Mark task as complete
        this.sessionManager.completeTask();

        // Summarize the response for the user
        const summary = this.summarizeResponse(fullResponse);
        this.emit('update', {
          type: 'TASK_COMPLETE',
          userId,
          message: summary,
          agent: this.agentType,
        } as OrchestratorUpdate);

        resolve();
      });
    });
  }

  private handleStreamMessage(
    message: StreamMessage,
    userId: string
  ): void {
    // Handle different message types from the stream
    if (message.type === 'tool_use' && message.tool) {
      // Check if this tool use requires approval
      const toolInput = JSON.stringify(message.tool_input || {});
      const detection = this.approvalDetector.detect(toolInput);

      if (detection) {
        this.emit('update', {
          type: 'STATUS_UPDATE',
          userId,
          message: `🔧 Executing: ${message.tool}`,
          agent: this.agentType,
        } as OrchestratorUpdate);
      }
    } else if (message.type === 'text' && message.content) {
      // Periodic status update for long content
      const preview = message.content.substring(0, 100);
      if (preview.length > 50) {
        this.emit('update', {
          type: 'STATUS_UPDATE',
          userId,
          message: `📝 Working: ${preview}...`,
          agent: this.agentType,
        } as OrchestratorUpdate);
      }
    }
  }

  private extractTaskDescription(instruction: string): string {
    // Extract a short description from the instruction
    const task = this.intentParser.extractTask(instruction);

    // Truncate to first sentence or 100 chars
    const firstSentence = task.split(/[.!?]/)[0];
    if (firstSentence.length <= 100) {
      return firstSentence.trim();
    }
    return task.substring(0, 97).trim() + '...';
  }

  private summarizeResponse(response: string): string {
    // Extract key information from the response
    const lines = response.split('\n').filter((l) => l.trim());

    // Look for success indicators
    const successIndicators = [
      'created', 'added', 'updated', 'committed', 'pushed',
      'installed', 'completed', 'done', 'success', 'finished'
    ];

    const relevantLines: string[] = [];

    for (const line of lines) {
      const lower = line.toLowerCase();
      if (successIndicators.some((ind) => lower.includes(ind))) {
        relevantLines.push(line);
      }
    }

    if (relevantLines.length > 0) {
      // Return the most relevant lines (up to 3)
      return relevantLines.slice(0, 3).join('\n');
    }

    // Default: return last few lines
    if (lines.length > 0) {
      return lines.slice(-3).join('\n');
    }

    return 'Task completed successfully.';
  }

  cancelCurrentTask(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
      this.isProcessing = false;
      this.sessionManager.failTask();
    }
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }

  clearUserHistory(userId: string): void {
    this.sessionManager.clearConversation(userId);
    this.conversationHistory = [];
  }

  getConversationHistory(): ConversationMessage[] {
    return [...this.conversationHistory];
  }

  private buildPromptWithHistory(instruction: string, userId: string): string {
    const contextPrompt = this.intentParser.buildContextPrompt();
    const newUserMessage = `${contextPrompt}${instruction}`;

    this.sessionManager.appendConversationMessage(
      userId,
      { role: 'user', content: newUserMessage },
      this.conversationOptions
    );

    if (!this.conversationOptions.includeHistory) {
      this.conversationHistory = [{ role: 'user', content: newUserMessage }];
      return newUserMessage;
    }

    const history = this.sessionManager.getConversationWithLimits(userId, this.conversationOptions);
    this.conversationHistory = history;

    return history.map((msg) => msg.content).join('\n');
  }

  private appendAssistantResponse(response: string, userId: string): void {
    if (!response) return;

    this.sessionManager.appendConversationMessage(
      userId,
      { role: 'assistant', content: response },
      this.conversationOptions
    );

    this.conversationHistory = this.sessionManager.getConversationWithLimits(userId, this.conversationOptions);
  }
}
