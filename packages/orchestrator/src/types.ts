// Message types for bot communication
export type MessageType =
  | 'STATUS_UPDATE'
  | 'INPUT_NEEDED'
  | 'APPROVAL_REQUIRED'
  | 'TASK_COMPLETE'
  | 'ERROR';

export type AgentType = 'claude' | 'codex';

// Update sent to bot
export interface OrchestratorUpdate {
  type: MessageType;
  userId: string;
  agentId?: string;
  taskId?: string;
  message: string;
  agent?: AgentType;
  inputId?: string;
  expectedInputFormat?: 'text' | 'json' | string;
  taskTitle?: string;
  approvalId?: string;
  approvalDetails?: {
    action: string;
    repo: string;
    details: string;
  };
}

// Instruction received from bot
export interface Instruction {
  userId: string;
  messageId: string;
  instruction: string;
  timestamp: Date;
}

// Approval response from bot
export interface ApprovalResponse {
  approvalId: string;
  approved: boolean;
  userId: string;
}

// Input response from bot
export interface InputResponse {
  inputId: string;
  userId: string;
  response: string;
}

// Session state
export interface SessionState {
  currentOrg?: string;
  currentRepo?: string;
  currentBranch?: string;
  activeSubAgents: SubAgent[];
  currentTask?: TaskInfo;
  conversations: Record<string, ConversationMessage[]>;
}

export interface TaskInfo {
  id: string;
  description: string;
  status: 'running' | 'waiting_input' | 'waiting_approval' | 'completed' | 'failed';
  startedAt: Date;
  userId: string;
  agent: AgentType;
}

export interface SubAgent {
  id: string;
  task: string;
  repo: string;
  status: 'running' | 'waiting_input' | 'waiting_approval' | 'completed' | 'failed';
  startedAt: Date;
  lastUpdate: string;
}

// Pending approval
export interface PendingApproval {
  id: string;
  userId: string;
  action: string;
  repo: string;
  details: string;
  command: string;
  createdAt: Date;
  resolve: (approved: boolean) => void;
  timeoutId: NodeJS.Timeout;
  agent?: AgentType;
  taskId?: string;
}

// Claude Code conversation message
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConversationOptions {
  includeHistory?: boolean;
  maxTurns?: number;
  maxTokens?: number;
}

// Approval pattern categories
export interface ApprovalPatterns {
  git: RegExp[];
  github: RegExp[];
  npm: RegExp[];
  deploy: RegExp[];
}

// Queue status info
export interface QueuedTaskInfo {
  id: string;
  userId: string;
  position: number;
  queuedAt: Date;
  repoKey?: string;
}

// Repo queue info for parallel processing
export interface RepoQueueInfo {
  repoKey: string;
  queued: number;
  processing: boolean;
  currentTaskId?: string;
}

// Usage response from Claude API
export interface UsageResponse {
  dailyLimit: string;
  used: string;
  remaining: string;
  percentUsed: number;
  resetTime?: string;
  raw?: string; // Raw output from claude command
}

// Status response
export interface StatusResponse {
  subAgents: SubAgent[];
  currentTask?: {
    id: string;
    description: string;
    status: string;
    startedAt: Date;
    agent?: AgentType;
  };
  queue?: {
    totalQueued: number;
    isProcessing: boolean;
    queuedTasks: QueuedTaskInfo[];
  };
  parallelQueue?: {
    totalQueued: number;
    activeRepos: number;
    maxConcurrentRepos: number;
    processingRepos: string[];
    repoQueues: RepoQueueInfo[];
  };
}
