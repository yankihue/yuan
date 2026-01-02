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
import { IntentParser } from '../claude-code/parser.js';
import { ApprovalDetector } from '../approval/detector.js';
import type { ApprovalGate } from '../approval/gate.js';

interface CodexSessionConfig {
  command?: string;
  args?: string[];
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

export class CodexSession extends EventEmitter {
  private command: string;
  private args: string[];
  private config: CodexSessionConfig;
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

  constructor(config: CodexSessionConfig) {
    super();
    this.config = config;
    this.command = config.command || 'codex';
    this.args = config.args || [];
    this.sessionManager = config.sessionManager ?? new SessionManager();
    this.intentParser = new IntentParser(this.sessionManager);
    this.approvalDetector = new ApprovalDetector();
    this.approvalGate = config.approvalGate;
    this.agentType = config.agentType ?? 'codex';
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
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
        taskId: this.sessionManager.getCurrentTaskId(),
      } as OrchestratorUpdate);
      return;
    }

    this.isProcessing = true;

    try {
      const context = this.intentParser.parseRepoContext(instruction);

      const taskDescription = this.extractTaskDescription(instruction);
      const task = this.sessionManager.startTask(taskDescription, userId, this.agentType);

      if (context) {
        this.intentParser.applyContext(context);

        if (context.action === 'switch' || context.action === 'create') {
          const repoName = this.sessionManager.getFullRepoName() || context.repo;
          this.emit('update', {
            type: 'STATUS_UPDATE',
            userId,
            message: `📁 Working in repository: ${repoName}${context.branch ? ` (branch: ${context.branch})` : ''}`,
            agent: this.agentType,
            taskId: task.id,
          } as OrchestratorUpdate);
        }
      }

      this.emit('update', {
        type: 'STATUS_UPDATE',
        userId,
        message: `🚀 Starting with Codex CLI: ${taskDescription}`,
        agent: this.agentType,
        taskId: task.id,
        taskTitle: task.description,
      } as OrchestratorUpdate);

      const fullPrompt = this.buildPromptWithHistory(instruction, userId);

      await this.executeWithCodexCLI(fullPrompt, userId, task.id);
    } catch (error) {
      console.error('Error processing instruction with Codex:', error);
      this.sessionManager.failTask();

      this.emit('update', {
        type: 'ERROR',
        userId,
        message: `Failed to process instruction: ${error instanceof Error ? error.message : String(error)}`,
        agent: this.agentType,
        taskId: this.sessionManager.getCurrentTaskId(),
      } as OrchestratorUpdate);
    } finally {
      this.isProcessing = false;
      this.currentProcess = null;
    }
  }

  private async executeWithCodexCLI(prompt: string, userId: string, taskId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const workingDir = this.config.workingDirectory || process.cwd();
      const args = [...this.args, prompt];

      this.currentProcess = spawn(this.command, args, {
        cwd: workingDir,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let fullResponse = '';
      let buffer = '';

      this.currentProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const message: StreamMessage = JSON.parse(line);
            this.handleStreamMessage(message, userId, taskId);

            if (message.type === 'assistant' && message.content) {
              fullResponse += message.content;
            } else if (message.type === 'result' && message.result) {
              fullResponse += message.result;
            }
          } catch {
            fullResponse += line + '\n';
          }
        }
      });

      this.currentProcess.stderr?.on('data', (data: Buffer) => {
        console.error('Codex CLI stderr:', data.toString());
      });

      this.currentProcess.on('error', (error) => {
        console.error('Failed to spawn Codex CLI:', error);
        this.sessionManager.failTask();
        reject(new Error(`Failed to start Codex CLI (${this.command}): ${error.message}`));
      });

      this.currentProcess.on('close', async (code) => {
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
          console.error(`Codex CLI exited with code ${code}`);
          this.sessionManager.failTask();

          this.emit('update', {
            type: 'ERROR',
            userId,
            message: `Codex CLI process exited with code ${code}`,
            agent: this.agentType,
            taskId,
          } as OrchestratorUpdate);

          reject(new Error(`Codex CLI exited with code ${code}`));
          return;
        }

        const detections = this.approvalDetector.detectInResponse(fullResponse);

        for (const detection of detections) {
          const repoContext = this.sessionManager.getFullRepoName() || 'current directory';
          const approved = await this.approvalGate.requestApproval(
            userId,
            detection,
            repoContext,
            this.agentType,
            taskId
          );

          if (!approved) {
            const currentTask = this.sessionManager.getCurrentTask();
            this.emit('update', {
              type: 'STATUS_UPDATE',
              userId,
              message: `⛔ Action rejected: ${detection.action}`,
              agent: this.agentType,
              taskId,
              taskTitle: currentTask?.description,
            } as OrchestratorUpdate);
          } else {
            const currentTask = this.sessionManager.getCurrentTask();
            this.emit('update', {
              type: 'STATUS_UPDATE',
              userId,
              message: `✅ Action approved: ${detection.action}`,
              agent: this.agentType,
              taskId,
              taskTitle: currentTask?.description,
            } as OrchestratorUpdate);
          }
        }

        this.appendAssistantResponse(fullResponse, userId);

        this.sessionManager.completeTask();

        const summary = this.summarizeResponse(fullResponse);
        const currentTask = this.sessionManager.getCurrentTask();
        this.emit('update', {
          type: 'TASK_COMPLETE',
          userId,
          message: summary,
          agent: this.agentType,
          taskId,
          taskTitle: currentTask?.description,
        } as OrchestratorUpdate);

        resolve();
      });
    });
  }

  private handleStreamMessage(message: StreamMessage, userId: string, taskId: string): void {
    const currentTask = this.sessionManager.getCurrentTask();

    if (message.type === 'tool_use' && message.tool) {
      const toolInput = JSON.stringify(message.tool_input || {});
      const detection = this.approvalDetector.detect(toolInput);

      if (detection) {
        this.emit('update', {
          type: 'STATUS_UPDATE',
          userId,
          message: `🔧 Executing: ${message.tool}`,
          agent: this.agentType,
          taskId,
          taskTitle: currentTask?.description,
        } as OrchestratorUpdate);
      }
    } else if (message.type === 'text' && message.content) {
      const preview = message.content.substring(0, 100);
      if (preview.length > 50) {
        this.emit('update', {
          type: 'STATUS_UPDATE',
          userId,
          message: `📝 Working: ${preview}...`,
          agent: this.agentType,
          taskId,
          taskTitle: currentTask?.description,
        } as OrchestratorUpdate);
      }
    }
  }

  private extractTaskDescription(instruction: string): string {
    const task = this.intentParser.extractTask(instruction);

    const firstSentence = task.split(/[.!?]/)[0];
    if (firstSentence.length <= 100) {
      return firstSentence.trim();
    }
    return task.substring(0, 97).trim() + '...';
  }

  private summarizeResponse(response: string): string {
    const lines = response.split('\n').filter((l) => l.trim());

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
      return relevantLines.slice(0, 3).join('\n');
    }

    if (lines.length > 0) {
      return lines.slice(-3).join('\n');
    }

    return 'Task completed successfully.';
  }

  cancelCurrentTask(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
    this.isProcessing = false;
    this.sessionManager.failTask();
  }

  clearUserHistory(userId: string): void {
    this.sessionManager.clearConversation(userId);
    this.conversationHistory = [];
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
