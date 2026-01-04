import type { UsageResponse, Config } from './types.js';

export interface UsageCheckResult {
  canRun: boolean;
  percentRemaining: number;
  reason: string;
  raw?: UsageResponse;
}

export class UsageChecker {
  private orchestratorUrl: string;
  private orchestratorSecret: string;
  private threshold: number;

  constructor(config: Config) {
    this.orchestratorUrl = config.orchestrator.url;
    this.orchestratorSecret = config.orchestrator.secret;
    this.threshold = config.schedule.usageThreshold;
  }

  async check(): Promise<UsageCheckResult> {
    try {
      const response = await fetch(`${this.orchestratorUrl}/usage`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.orchestratorSecret}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        // If usage check fails, allow running anyway (orchestrator may not have usage endpoint)
        console.warn(`Usage check failed (${response.status}), proceeding anyway`);
        return {
          canRun: true,
          percentRemaining: 100,
          reason: `Usage check unavailable (${response.status}), proceeding anyway`,
        };
      }

      const usage = (await response.json()) as UsageResponse;
      const percentRemaining = 100 - usage.percentUsed;

      if (percentRemaining < this.threshold) {
        return {
          canRun: false,
          percentRemaining,
          reason: `Usage too high: ${usage.percentUsed.toFixed(1)}% used, need at least ${100 - this.threshold}% remaining`,
          raw: usage,
        };
      }

      return {
        canRun: true,
        percentRemaining,
        reason: `Sufficient usage available: ${percentRemaining.toFixed(1)}% remaining`,
        raw: usage,
      };
    } catch (error) {
      console.error('Error checking usage:', error);
      return {
        canRun: false,
        percentRemaining: 0,
        reason: `Error checking usage: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
