/**
 * Detects repository context from natural language instructions.
 * Returns a normalized repo key for task grouping.
 */

const DEFAULT_REPO_KEY = '__default__';

export interface RepoDetectionResult {
  repoKey: string;
  org?: string;
  repo?: string;
  isNewRepo: boolean;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Detect repo from instruction text
 */
export function detectRepo(instruction: string): RepoDetectionResult {
  const lower = instruction.toLowerCase();

  // Pattern: "create a new repo called X" or "create new repository X"
  const createRepoMatch = lower.match(
    /create\s+(?:a\s+)?(?:new\s+)?repo(?:sitory)?\s+(?:called\s+|named\s+)?["']?([a-z0-9_-]+(?:\/[a-z0-9_-]+)?)["']?/i
  );
  if (createRepoMatch) {
    const repoName = createRepoMatch[1];
    const parts = repoName.split('/');
    return {
      repoKey: repoName.toLowerCase(),
      org: parts.length > 1 ? parts[0] : undefined,
      repo: parts.length > 1 ? parts[1] : parts[0],
      isNewRepo: true,
      confidence: 'high',
    };
  }

  // Pattern: GitHub URL - github.com/org/repo or https://github.com/org/repo
  const githubUrlMatch = instruction.match(
    /(?:https?:\/\/)?github\.com\/([a-z0-9_-]+)\/([a-z0-9_-]+)/i
  );
  if (githubUrlMatch) {
    const org = githubUrlMatch[1].toLowerCase();
    const repo = githubUrlMatch[2].toLowerCase();
    return {
      repoKey: `${org}/${repo}`,
      org,
      repo,
      isNewRepo: false,
      confidence: 'high',
    };
  }

  // Pattern: "in org/repo" or "in the org/repo repo"
  const orgRepoSlashMatch = lower.match(
    /(?:in|for|on|to)\s+(?:the\s+)?["']?([a-z0-9_-]+\/[a-z0-9_-]+)["']?(?:\s+repo(?:sitory)?)?/
  );
  if (orgRepoSlashMatch) {
    const [org, repo] = orgRepoSlashMatch[1].split('/');
    return {
      repoKey: orgRepoSlashMatch[1],
      org,
      repo,
      isNewRepo: false,
      confidence: 'high',
    };
  }

  // Pattern: "go to org X, repo Y" or "switch to org X repo Y"
  const orgRepoMatch = lower.match(
    /(?:go\s+to|switch\s+to|use)\s+(?:the\s+)?org(?:anization)?\s+["']?([a-z0-9_-]+)["']?\s*[,\s]+\s*repo(?:sitory)?\s+["']?([a-z0-9_-]+)["']?/
  );
  if (orgRepoMatch) {
    const org = orgRepoMatch[1];
    const repo = orgRepoMatch[2];
    return {
      repoKey: `${org}/${repo}`,
      org,
      repo,
      isNewRepo: false,
      confidence: 'high',
    };
  }

  // Pattern: "switch to repo X" or "go to repo X" or "in repo X"
  const switchRepoMatch = lower.match(
    /(?:go\s+to|switch\s+to|use|in)\s+(?:the\s+)?repo(?:sitory)?\s+["']?([a-z0-9_-]+(?:\/[a-z0-9_-]+)?)["']?/
  );
  if (switchRepoMatch) {
    const repoName = switchRepoMatch[1];
    if (repoName.includes('/')) {
      const [org, repo] = repoName.split('/');
      return {
        repoKey: repoName,
        org,
        repo,
        isNewRepo: false,
        confidence: 'high',
      };
    }
    return {
      repoKey: repoName,
      repo: repoName,
      isNewRepo: false,
      confidence: 'medium',
    };
  }

  // Pattern: "the X repo" or "X repository"
  const simpleRepoMatch = lower.match(
    /(?:the|in)\s+["']?([a-z0-9_-]+)["']?\s+repo(?:sitory)?/
  );
  if (simpleRepoMatch) {
    return {
      repoKey: simpleRepoMatch[1],
      repo: simpleRepoMatch[1],
      isNewRepo: false,
      confidence: 'medium',
    };
  }

  // Pattern: clone command - git clone or gh repo clone
  const cloneMatch = instruction.match(
    /(?:git\s+clone|gh\s+repo\s+clone)\s+(?:https?:\/\/github\.com\/)?["']?([a-z0-9_-]+(?:\/[a-z0-9_-]+)?)["']?/i
  );
  if (cloneMatch) {
    const repoName = cloneMatch[1].toLowerCase();
    if (repoName.includes('/')) {
      const [org, repo] = repoName.split('/');
      return {
        repoKey: repoName,
        org,
        repo,
        isNewRepo: true,
        confidence: 'high',
      };
    }
    return {
      repoKey: repoName,
      repo: repoName,
      isNewRepo: true,
      confidence: 'medium',
    };
  }

  // Pattern: "in the same repo" or "same repository" - use default (caller should use current context)
  if (lower.includes('in the same repo') || lower.includes('same repository')) {
    return {
      repoKey: DEFAULT_REPO_KEY,
      isNewRepo: false,
      confidence: 'low',
    };
  }

  // No repo detected - use default
  return {
    repoKey: DEFAULT_REPO_KEY,
    isNewRepo: false,
    confidence: 'low',
  };
}

/**
 * Get the default repo key constant
 */
export function getDefaultRepoKey(): string {
  return DEFAULT_REPO_KEY;
}

/**
 * Check if a repo key is the default
 */
export function isDefaultRepoKey(repoKey: string): boolean {
  return repoKey === DEFAULT_REPO_KEY;
}

/**
 * Format repo key for display
 */
export function formatRepoKeyForDisplay(repoKey: string): string {
  if (repoKey === DEFAULT_REPO_KEY) {
    return 'default workspace';
  }
  return repoKey;
}
