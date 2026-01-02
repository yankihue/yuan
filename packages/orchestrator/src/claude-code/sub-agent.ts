import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type { SubAgent, OrchestratorUpdate } from '../types.js';

interface SubAgentSpawnRequest {
  task: string;
  repo: string;
  branch?: string;
  workingDirectory: string;
  userId: string;
  taskId?: string;
}

interface RunningSubAgent extends SubAgent {
  process: ChildProcess | null;
  userId: string;
}

export class SubAgentManager extends EventEmitter {
  private runningAgents: Map<string, RunningSubAgent> = new Map();
  private anthropicApiKey?: string;

  constructor(anthropicApiKey?: string) {
    super();
    this.anthropicApiKey = anthropicApiKey;
  }

  async spawn(request: SubAgentSpawnRequest): Promise<SubAgent> {
    const agentId = uuidv4();

    const agent: RunningSubAgent = {
      id: agentId,
      task: request.task,
      repo: request.repo,
      status: 'running',
      startedAt: new Date(),
      lastUpdate: 'Initializing...',
      process: null,
      userId: request.userId,
    };

    this.runningAgents.set(agentId, agent);

    // Start the agent asynchronously
    this.runAgent(agent, request).catch((error) => {
      console.error(`Sub-agent ${agentId} failed:`, error);
      this.updateAgentStatus(agentId, 'failed', `Error: ${error.message}`);
    });

    // Notify about spawn
    this.emit('update', {
      type: 'STATUS_UPDATE',
      userId: request.userId,
      agentId,
      message: `🚀 Started sub-agent for: ${request.task}`,
      taskId: request.taskId,
    } as OrchestratorUpdate);

    return {
      id: agent.id,
      task: agent.task,
      repo: agent.repo,
      status: agent.status,
      startedAt: agent.startedAt,
      lastUpdate: agent.lastUpdate,
    };
  }

  private async runAgent(agent: RunningSubAgent, request: SubAgentSpawnRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      const prompt = `
You are working on a sub-task in a larger project.

Repository: ${request.repo}
${request.branch ? `Branch: ${request.branch}` : ''}
Task: ${request.task}

Please complete this task thoroughly. Provide status updates at key milestones.
If you encounter any issues that require user input, stop and describe what you need.
`;

      const args = [
        '--print',
        '--output-format', 'stream-json',
        prompt
      ];

      // Build environment - only include API key if provided (otherwise uses manual login)
      const spawnEnv = { ...process.env };
      if (this.anthropicApiKey) {
        spawnEnv.ANTHROPIC_API_KEY = this.anthropicApiKey;
      }

      const proc = spawn('claude', args, {
        cwd: request.workingDirectory,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      agent.process = proc;

      let lastMessage = '';
      let buffer = '';

      proc.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (message.type === 'assistant' && message.content) {
              lastMessage = message.content;
              this.updateAgentStatus(agent.id, 'running', message.content.substring(0, 100));
            }
          } catch {
            lastMessage = line;
          }
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        console.error(`Sub-agent ${agent.id} stderr:`, data.toString());
      });

      proc.on('error', (error) => {
        this.updateAgentStatus(agent.id, 'failed', `Process error: ${error.message}`);
        reject(error);
      });

      proc.on('close', (code) => {
        agent.process = null;

        if (code === null) {
          // Process was killed (cancelled)
          this.updateAgentStatus(agent.id, 'failed', 'Cancelled by user');
          resolve();
          return;
        }

        if (code !== 0) {
          this.updateAgentStatus(agent.id, 'failed', `Process exited with code ${code}`);
          reject(new Error(`Process exited with code ${code}`));
          return;
        }

        this.updateAgentStatus(agent.id, 'completed', lastMessage.substring(0, 200));

        this.emit('update', {
          type: 'TASK_COMPLETE',
          userId: agent.userId,
          agentId: agent.id,
          message: `✅ Sub-agent completed: ${request.task}`,
          taskId: request.taskId,
        } as OrchestratorUpdate);

        resolve();
      });
    });
  }

  private updateAgentStatus(
    agentId: string,
    status: SubAgent['status'],
    lastUpdate: string
  ): void {
    const agent = this.runningAgents.get(agentId);
    if (agent) {
      agent.status = status;
      agent.lastUpdate = lastUpdate;
    }
  }

  getAgent(agentId: string): SubAgent | undefined {
    const agent = this.runningAgents.get(agentId);
    if (!agent) return undefined;

    return {
      id: agent.id,
      task: agent.task,
      repo: agent.repo,
      status: agent.status,
      startedAt: agent.startedAt,
      lastUpdate: agent.lastUpdate,
    };
  }

  getAllAgents(): SubAgent[] {
    return Array.from(this.runningAgents.values()).map((agent) => ({
      id: agent.id,
      task: agent.task,
      repo: agent.repo,
      status: agent.status,
      startedAt: agent.startedAt,
      lastUpdate: agent.lastUpdate,
    }));
  }

  getActiveAgents(): SubAgent[] {
    return this.getAllAgents().filter(
      (a) => a.status === 'running' || a.status === 'waiting_input' || a.status === 'waiting_approval'
    );
  }

  cancelAgent(agentId: string): boolean {
    const agent = this.runningAgents.get(agentId);
    if (!agent) return false;

    if (agent.process) {
      agent.process.kill('SIGTERM');
    }
    this.updateAgentStatus(agentId, 'failed', 'Cancelled by user');
    return true;
  }

  cancelAllForUser(userId: string): number {
    let count = 0;
    for (const agent of this.runningAgents.values()) {
      if (agent.userId === userId && agent.status === 'running') {
        if (agent.process) {
          agent.process.kill('SIGTERM');
        }
        this.updateAgentStatus(agent.id, 'failed', 'Cancelled by user');
        count++;
      }
    }
    return count;
  }

  cleanup(): void {
    // Cancel all running agents
    for (const agent of this.runningAgents.values()) {
      if (agent.status === 'running' && agent.process) {
        agent.process.kill('SIGTERM');
      }
    }

    // Remove completed/failed agents older than 1 hour
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [id, agent] of this.runningAgents.entries()) {
      if (
        (agent.status === 'completed' || agent.status === 'failed') &&
        agent.startedAt.getTime() < oneHourAgo
      ) {
        this.runningAgents.delete(id);
      }
    }
  }
}
