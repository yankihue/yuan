/**
 * PermissionGuard - Blocks destructive operations completely
 *
 * This guard ensures that only create/modify operations are allowed,
 * while destructive operations are blocked outright (not just approved).
 *
 * Philosophy:
 * - Create operations: allowed (with approval for sensitive ones)
 * - Modify operations: allowed (with approval for sensitive ones)
 * - Delete/Destructive operations: BLOCKED completely
 */

export interface BlockedOperation {
  category: 'git' | 'github' | 'system' | 'npm';
  pattern: RegExp;
  reason: string;
  severity: 'critical' | 'high';
}

export interface PermissionCheckResult {
  allowed: boolean;
  blocked?: BlockedOperation;
  warning?: string;
}

// Operations that are COMPLETELY BLOCKED - no approval possible
const BLOCKED_OPERATIONS: BlockedOperation[] = [
  // Git destructive operations
  {
    category: 'git',
    pattern: /git\s+push\s+.*--force/i,
    reason: 'Force push is destructive and can lose commit history',
    severity: 'critical',
  },
  {
    category: 'git',
    pattern: /git\s+push\s+.*-f\b/i,
    reason: 'Force push (-f) is destructive and can lose commit history',
    severity: 'critical',
  },
  {
    category: 'git',
    pattern: /git\s+reset\s+--hard/i,
    reason: 'Hard reset can lose uncommitted changes',
    severity: 'high',
  },
  {
    category: 'git',
    pattern: /git\s+clean\s+-fd/i,
    reason: 'Git clean with force can delete untracked files permanently',
    severity: 'high',
  },
  {
    category: 'git',
    pattern: /git\s+branch\s+-[dD]\s+(?:-r\s+)?origin/i,
    reason: 'Deleting remote branches is destructive',
    severity: 'high',
  },
  {
    category: 'git',
    pattern: /git\s+push\s+origin\s+--delete/i,
    reason: 'Deleting remote branches is destructive',
    severity: 'high',
  },

  // GitHub destructive operations
  {
    category: 'github',
    pattern: /gh\s+repo\s+delete/i,
    reason: 'Repository deletion is irreversible',
    severity: 'critical',
  },
  {
    category: 'github',
    pattern: /gh\s+pr\s+close/i,
    reason: 'Closing PRs is a destructive operation',
    severity: 'high',
  },
  {
    category: 'github',
    pattern: /gh\s+issue\s+close/i,
    reason: 'Closing issues should be done manually',
    severity: 'high',
  },
  {
    category: 'github',
    pattern: /gh\s+issue\s+delete/i,
    reason: 'Deleting issues is irreversible',
    severity: 'critical',
  },
  {
    category: 'github',
    pattern: /gh\s+release\s+delete/i,
    reason: 'Deleting releases is destructive',
    severity: 'critical',
  },
  {
    category: 'github',
    pattern: /gh\s+gist\s+delete/i,
    reason: 'Deleting gists is irreversible',
    severity: 'high',
  },
  {
    category: 'github',
    pattern: /gh\s+secret\s+delete/i,
    reason: 'Deleting secrets could break workflows',
    severity: 'high',
  },
  {
    category: 'github',
    pattern: /gh\s+variable\s+delete/i,
    reason: 'Deleting variables could break workflows',
    severity: 'high',
  },
  {
    category: 'github',
    pattern: /gh\s+workflow\s+disable/i,
    reason: 'Disabling workflows should be done manually',
    severity: 'high',
  },

  // NPM destructive operations
  {
    category: 'npm',
    pattern: /npm\s+unpublish/i,
    reason: 'Unpublishing packages is destructive',
    severity: 'critical',
  },
  {
    category: 'npm',
    pattern: /npm\s+deprecate/i,
    reason: 'Deprecating packages should be done manually',
    severity: 'high',
  },

  // System destructive operations
  {
    category: 'system',
    pattern: /rm\s+-rf?\s+[\/~]/i,
    reason: 'Recursive deletion of system paths is dangerous',
    severity: 'critical',
  },
  {
    category: 'system',
    pattern: /sudo\s+rm/i,
    reason: 'Sudo removal operations are dangerous',
    severity: 'critical',
  },
  {
    category: 'system',
    pattern: /:\s*>\s*[\/~]/i,
    reason: 'Truncating system files is dangerous',
    severity: 'critical',
  },
];

// Operations that are allowed but should trigger a warning
const WARNING_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  {
    pattern: /git\s+push\s+.*(?:main|master)/i,
    warning: 'Pushing directly to main/master branch - ensure this is intentional',
  },
  {
    pattern: /npm\s+publish/i,
    warning: 'Publishing to npm registry - this action is public and permanent',
  },
];

export class PermissionGuard {
  /**
   * Check if a command is allowed
   */
  check(command: string): PermissionCheckResult {
    // Check blocked operations first
    for (const blocked of BLOCKED_OPERATIONS) {
      if (blocked.pattern.test(command)) {
        return {
          allowed: false,
          blocked,
        };
      }
    }

    // Check for warnings
    for (const warn of WARNING_PATTERNS) {
      if (warn.pattern.test(command)) {
        return {
          allowed: true,
          warning: warn.warning,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check multiple commands/lines
   */
  checkMultiple(content: string): PermissionCheckResult[] {
    const results: PermissionCheckResult[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
        continue;
      }

      const result = this.check(trimmed);
      if (!result.allowed || result.warning) {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Get all blocked operation patterns (for system prompt injection)
   */
  getBlockedOperationsDescription(): string {
    const categories = new Map<string, string[]>();

    for (const op of BLOCKED_OPERATIONS) {
      if (!categories.has(op.category)) {
        categories.set(op.category, []);
      }
      categories.get(op.category)!.push(op.reason);
    }

    let description = 'The following operations are BLOCKED and will not be executed:\n\n';

    for (const [category, reasons] of categories) {
      description += `**${category.toUpperCase()}:**\n`;
      for (const reason of [...new Set(reasons)]) {
        description += `- ${reason}\n`;
      }
      description += '\n';
    }

    return description;
  }
}
