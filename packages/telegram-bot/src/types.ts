// Message types from orchestrator
export type MessageType =
  | 'STATUS_UPDATE'
  | 'INPUT_NEEDED'
  | 'APPROVAL_REQUIRED'
  | 'TASK_COMPLETE'
  | 'ERROR';

export type AgentType = 'claude' | 'codex';

// Orchestrator update message
export interface OrchestratorUpdate {
  type: MessageType;
  userId: string;
  agentId?: string;
  message: string;
  agent?: AgentType;
  inputId?: string;
  expectedInputFormat?: 'text' | 'json' | string;
  taskId?: string;
  taskTitle?: string;
  repoKey?: string; // Which repo this update is for
  approvalId?: string;
  approvalDetails?: {
    action: string;
    repo: string;
    details: string;
  };
}

// Instruction sent to orchestrator
export interface Instruction {
  userId: string;
  messageId: string;
  instruction: string;
  timestamp: Date;
}

// Approval response
export interface ApprovalResponse {
  approvalId: string;
  approved: boolean;
  userId: string;
}

export interface InputResponse {
  inputId: string;
  userId: string;
  response: string;
}

// Repo queue info for parallel processing
export interface RepoQueueInfo {
  repoKey: string;
  queued: number;
  processing: boolean;
  currentTaskId?: string;
}

// Status response from orchestrator
export interface StatusResponse {
  subAgents: SubAgentStatus[];
  currentTask?: {
    id: string;
    description: string;
    status: string;
    startedAt: Date;
    agent?: AgentType;
  };
  parallelQueue?: {
    totalQueued: number;
    activeRepos: number;
    maxConcurrentRepos: number;
    processingRepos: string[];
    repoQueues: RepoQueueInfo[];
  };
}

export interface SubAgentStatus {
  id: string;
  task: string;
  repo: string;
  status: 'running' | 'waiting_input' | 'waiting_approval' | 'completed' | 'failed';
  startedAt: Date;
  lastUpdate: string;
}

// Voice buffer entry
export interface VoiceBufferEntry {
  fileId: string;
  chatId: number;
  messageId: number;
  timestamp: Date;
}

// User voice buffer state
export interface UserVoiceBuffer {
  entries: VoiceBufferEntry[];
  timer: NodeJS.Timeout | null;
}
