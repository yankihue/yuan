import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ClaudeCodeSession } from '../claude-code/session.js';
import { SessionManager } from '../state/session.js';
import { ApprovalGate } from '../approval/gate.js';
import type { OrchestratorUpdate } from '../types.js';

export interface SessionPoolConfig {
  maxConcurrentSessions?: number;
  anthropicApiKey?: string;
  workingDirectory?: string;
  tokenLimit?: number;
  tokenWarningRatio?: number;
  githubOrg?: string; // Default org for repos without explicit org
}

interface PooledSession {
  session: ClaudeCodeSession;
  repoKey: string;
  repoDir: string; // Actual working directory for this repo
  isProcessing: boolean;
  lastUsed: Date;
  sessionManager: SessionManager;
}

const DEFAULT_REPO_KEY = '__default__';

export class SessionPool extends EventEmitter {
  private sessions: Map<string, PooledSession> = new Map();
  private config: Required<SessionPoolConfig>;
  private approvalGate: ApprovalGate;

  constructor(config: SessionPoolConfig, approvalGate: ApprovalGate) {
    super();
    this.config = {
      maxConcurrentSessions: config.maxConcurrentSessions ?? 5,
      anthropicApiKey: config.anthropicApiKey ?? '',
      workingDirectory: config.workingDirectory ?? process.cwd(),
      tokenLimit: config.tokenLimit ?? 200000,
      tokenWarningRatio: config.tokenWarningRatio ?? 0.9,
      githubOrg: config.githubOrg ?? '',
    };
    this.approvalGate = approvalGate;
  }

  /**
   * Setup repo directory - clone if exists on GitHub, otherwise create empty dir
   */
  private setupRepoDirectory(repoKey: string): string {
    const baseDir = this.config.workingDirectory;

    // For default repo key, use base directory
    if (repoKey === DEFAULT_REPO_KEY) {
      return baseDir;
    }

    // Create repo-specific subdirectory
    const repoDir = join(baseDir, repoKey.replace('/', '_'));

    if (!existsSync(repoDir)) {
      mkdirSync(repoDir, { recursive: true });

      // Try to clone if it exists on GitHub
      const fullRepoName = repoKey.includes('/')
        ? repoKey
        : this.config.githubOrg
          ? `${this.config.githubOrg}/${repoKey}`
          : repoKey;

      try {
        // Check if repo exists on GitHub
        execSync(`gh repo view ${fullRepoName} --json name`, {
          cwd: baseDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });

        // Repo exists, clone it
        console.log(`Cloning existing repo: ${fullRepoName}`);
        execSync(`gh repo clone ${fullRepoName} ${repoDir}`, {
          cwd: baseDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 60000,
        });
        console.log(`Cloned ${fullRepoName} to ${repoDir}`);
      } catch (error) {
        // Repo doesn't exist or clone failed - Claude will need to create it
        console.log(`Repo ${fullRepoName} not found on GitHub, starting fresh in ${repoDir}`);
        // Initialize empty git repo so Claude can work with it
        try {
          execSync('git init', { cwd: repoDir, stdio: 'pipe' });
        } catch {
          // Ignore init errors
        }
      }
    }

    return repoDir;
  }

  /**
   * Get or create a session for a specific repo
   */
  getOrCreateSession(repoKey: string): PooledSession {
    const normalizedKey = this.normalizeRepoKey(repoKey);

    // Return existing session if available
    if (this.sessions.has(normalizedKey)) {
      const pooled = this.sessions.get(normalizedKey)!;
      pooled.lastUsed = new Date();
      return pooled;
    }

    // Check if we've hit max sessions
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      // Try to evict an idle session
      const evicted = this.evictIdleSession();
      if (!evicted) {
        // All sessions are busy, use the default session
        console.log(`Max sessions reached (${this.config.maxConcurrentSessions}), using default session`);
        return this.getOrCreateSession(DEFAULT_REPO_KEY);
      }
    }

    // Setup repo directory (clone if exists, or create empty)
    const repoDir = this.setupRepoDirectory(normalizedKey);
    console.log(`Using working directory for ${normalizedKey}: ${repoDir}`);

    // Create new session for this repo
    const sessionManager = new SessionManager();
    const session = new ClaudeCodeSession({
      anthropicApiKey: this.config.anthropicApiKey || undefined,
      workingDirectory: repoDir, // Use repo-specific directory
      sessionManager,
      approvalGate: this.approvalGate,
      agentType: 'claude',
      tokenLimit: this.config.tokenLimit,
      tokenWarningRatio: this.config.tokenWarningRatio,
    });

    // Forward updates from this session
    session.on('update', (update: OrchestratorUpdate) => {
      this.emit('update', update);
    });

    const pooled: PooledSession = {
      session,
      repoKey: normalizedKey,
      repoDir, // Store the repo directory
      isProcessing: false,
      lastUsed: new Date(),
      sessionManager,
    };

    this.sessions.set(normalizedKey, pooled);
    console.log(`Created new session for repo: ${normalizedKey} (total: ${this.sessions.size})`);

    return pooled;
  }

  /**
   * Check if a repo's session is currently processing
   */
  isRepoProcessing(repoKey: string): boolean {
    const normalizedKey = this.normalizeRepoKey(repoKey);
    const pooled = this.sessions.get(normalizedKey);
    return pooled?.isProcessing ?? false;
  }

  /**
   * Mark a repo session as processing
   */
  setRepoProcessing(repoKey: string, processing: boolean): void {
    const normalizedKey = this.normalizeRepoKey(repoKey);
    const pooled = this.sessions.get(normalizedKey);
    if (pooled) {
      pooled.isProcessing = processing;
      pooled.lastUsed = new Date();
    }
  }

  /**
   * Get session for a repo (returns null if doesn't exist)
   */
  getSession(repoKey: string): PooledSession | null {
    const normalizedKey = this.normalizeRepoKey(repoKey);
    return this.sessions.get(normalizedKey) ?? null;
  }

  /**
   * Get count of currently processing sessions
   */
  getActiveCount(): number {
    let count = 0;
    for (const pooled of this.sessions.values()) {
      if (pooled.isProcessing) count++;
    }
    return count;
  }

  /**
   * Get all session stats
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    maxSessions: number;
    repos: string[];
  } {
    const repos: string[] = [];
    let active = 0;

    for (const [key, pooled] of this.sessions.entries()) {
      repos.push(key);
      if (pooled.isProcessing) active++;
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions: active,
      maxSessions: this.config.maxConcurrentSessions,
      repos,
    };
  }

  /**
   * Cancel task for a specific repo
   */
  cancelRepoTask(repoKey: string): boolean {
    const normalizedKey = this.normalizeRepoKey(repoKey);
    const pooled = this.sessions.get(normalizedKey);
    if (pooled && pooled.isProcessing) {
      pooled.session.cancelCurrentTask();
      pooled.isProcessing = false;
      return true;
    }
    return false;
  }

  /**
   * Cancel all active tasks
   */
  cancelAll(): number {
    let cancelled = 0;
    for (const pooled of this.sessions.values()) {
      if (pooled.isProcessing) {
        pooled.session.cancelCurrentTask();
        pooled.isProcessing = false;
        cancelled++;
      }
    }
    return cancelled;
  }

  /**
   * Clear history for a user across all sessions
   */
  clearUserHistory(userId: string): void {
    for (const pooled of this.sessions.values()) {
      pooled.session.clearUserHistory(userId);
    }
  }

  /**
   * Normalize repo key for consistent lookup
   */
  private normalizeRepoKey(repoKey: string): string {
    if (!repoKey || repoKey === DEFAULT_REPO_KEY) {
      return DEFAULT_REPO_KEY;
    }
    // Normalize: lowercase, trim, remove trailing slashes
    return repoKey.toLowerCase().trim().replace(/\/+$/, '');
  }

  /**
   * Evict the least recently used idle session
   */
  private evictIdleSession(): boolean {
    let oldestKey: string | null = null;
    let oldestTime: Date | null = null;

    for (const [key, pooled] of this.sessions.entries()) {
      // Skip default session and active sessions
      if (key === DEFAULT_REPO_KEY || pooled.isProcessing) {
        continue;
      }

      if (!oldestTime || pooled.lastUsed < oldestTime) {
        oldestTime = pooled.lastUsed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      console.log(`Evicting idle session for repo: ${oldestKey}`);
      this.sessions.delete(oldestKey);
      return true;
    }

    return false;
  }

  /**
   * Get the default repo key
   */
  static getDefaultRepoKey(): string {
    return DEFAULT_REPO_KEY;
  }
}
