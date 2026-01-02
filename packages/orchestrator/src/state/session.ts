import type {
  ConversationMessage,
  ConversationOptions,
  SessionState,
  SubAgent,
  TaskInfo,
} from '../types.js';
import { v4 as uuidv4 } from 'uuid';

export class SessionManager {
  private state: SessionState;

  constructor() {
    this.state = {
      activeSubAgents: [],
      conversations: {},
    };
  }

  getState(): SessionState {
    return { ...this.state };
  }

  getConversation(userId: string): ConversationMessage[] {
    const history = this.state.conversations[userId] ?? [];
    return [...history];
  }

  appendConversationMessage(
    userId: string,
    message: ConversationMessage,
    options?: ConversationOptions
  ): ConversationMessage[] {
    const history = this.state.conversations[userId] ? [...this.state.conversations[userId]] : [];
    history.push(message);
    this.state.conversations[userId] = this.applyConversationLimits(history, options);
    return this.getConversation(userId);
  }

  clearConversation(userId: string): void {
    delete this.state.conversations[userId];
  }

  getConversationWithLimits(userId: string, options?: ConversationOptions): ConversationMessage[] {
    const history = this.state.conversations[userId] ? [...this.state.conversations[userId]] : [];
    const limited = this.applyConversationLimits(history, options);
    this.state.conversations[userId] = limited;
    return [...limited];
  }

  setRepoContext(org: string | undefined, repo: string | undefined, branch?: string): void {
    this.state.currentOrg = org;
    this.state.currentRepo = repo;
    if (branch) {
      this.state.currentBranch = branch;
    }
  }

  getRepoContext(): { org?: string; repo?: string; branch?: string } {
    return {
      org: this.state.currentOrg,
      repo: this.state.currentRepo,
      branch: this.state.currentBranch,
    };
  }

  getFullRepoName(): string | undefined {
    if (this.state.currentOrg && this.state.currentRepo) {
      return `${this.state.currentOrg}/${this.state.currentRepo}`;
    }
    return this.state.currentRepo;
  }

  setBranch(branch: string): void {
    this.state.currentBranch = branch;
  }

  startTask(description: string, userId: string, agent: TaskInfo['agent']): TaskInfo {
    const task: TaskInfo = {
      id: uuidv4(),
      description,
      status: 'running',
      startedAt: new Date(),
      userId,
      agent,
    };
    this.state.currentTask = task;
    return task;
  }

  updateTaskStatus(status: TaskInfo['status']): void {
    if (this.state.currentTask) {
      this.state.currentTask.status = status;
    }
  }

  completeTask(): void {
    if (this.state.currentTask) {
      this.state.currentTask.status = 'completed';
    }
  }

  failTask(): void {
    if (this.state.currentTask) {
      this.state.currentTask.status = 'failed';
    }
  }

  clearTask(): void {
    this.state.currentTask = undefined;
  }

  getCurrentTask(): TaskInfo | undefined {
    return this.state.currentTask;
  }

  addSubAgent(task: string, repo: string): SubAgent {
    const agent: SubAgent = {
      id: uuidv4(),
      task,
      repo,
      status: 'running',
      startedAt: new Date(),
      lastUpdate: 'Starting...',
    };
    this.state.activeSubAgents.push(agent);
    return agent;
  }

  updateSubAgent(id: string, update: Partial<SubAgent>): void {
    const agent = this.state.activeSubAgents.find((a) => a.id === id);
    if (agent) {
      Object.assign(agent, update);
    }
  }

  removeSubAgent(id: string): void {
    this.state.activeSubAgents = this.state.activeSubAgents.filter((a) => a.id !== id);
  }

  getActiveSubAgents(): SubAgent[] {
    return [...this.state.activeSubAgents];
  }

  getSubAgent(id: string): SubAgent | undefined {
    return this.state.activeSubAgents.find((a) => a.id === id);
  }

  private applyConversationLimits(
    history: ConversationMessage[],
    options?: ConversationOptions
  ): ConversationMessage[] {
    const maxTurns = options?.maxTurns;
    const maxTokens = options?.maxTokens;

    while (maxTurns && history.length > maxTurns) {
      history.shift();
    }

    if (maxTokens) {
      let totalTokens = this.estimateTokens(history);
      while (history.length > 0 && totalTokens > maxTokens) {
        history.shift();
        totalTokens = this.estimateTokens(history);
      }
    }

    return history;
  }

  private estimateTokens(history: ConversationMessage[]): number {
    return history.reduce((sum, message) => {
      // Rough estimation: split by whitespace and punctuation
      const tokenLikePieces = message.content.split(/\s+/).filter(Boolean);
      return sum + tokenLikePieces.length;
    }, 0);
  }
}
