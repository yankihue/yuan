import cron from 'node-cron';
import type { Config, PersonalData, ProjectIdea, PendingIdea } from './types.js';
import { UsageChecker } from './usage-checker.js';
import { TwitterDataSource } from './data-sources/twitter.js';
import { GitHubDataSource } from './data-sources/github.js';
import { ContentAnalyzer } from './analyzer.js';
import { IdeaGenerator } from './idea-generator.js';
import { TelegramNotifier } from './telegram.js';

export class CreativeAgentScheduler {
  private config: Config;
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning = false;
  private lastRunTime: Date | null = null;
  private nextRunTime: Date | null = null;

  // Components
  private usageChecker: UsageChecker;
  private twitterSource: TwitterDataSource;
  private githubSource: GitHubDataSource;
  private analyzer: ContentAnalyzer;
  private ideaGenerator: IdeaGenerator;
  private telegram: TelegramNotifier;

  // State
  private pendingIdeas: Map<string, PendingIdea> = new Map();

  constructor(config: Config) {
    this.config = config;

    // Initialize components
    this.usageChecker = new UsageChecker(config);
    this.twitterSource = new TwitterDataSource(
      config.twitter.accessToken,
      config.twitter.refreshToken,
      config.twitter.clientId,
      config.twitter.clientSecret
    );
    this.githubSource = new GitHubDataSource(
      config.github.token,
      config.github.username,
      config.github.ignoreRepos
    );
    this.analyzer = new ContentAnalyzer(config);
    this.ideaGenerator = new IdeaGenerator(config);
    this.telegram = new TelegramNotifier(config);
  }

  start(): void {
    console.log(`Starting Creative Agent scheduler: ${this.config.schedule.cronExpression}`);

    this.cronJob = cron.schedule(this.config.schedule.cronExpression, async () => {
      await this.run();
    });

    // Calculate next run time
    this.updateNextRunTime();

    console.log(`Creative Agent scheduled. Next run: ${this.nextRunTime?.toISOString()}`);
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    console.log('Creative Agent scheduler stopped');
  }

  private updateNextRunTime(): void {
    // Simple calculation based on cron - every 8 hours
    const now = new Date();
    const hours = now.getHours();
    const nextHour = Math.ceil(hours / 8) * 8;
    const next = new Date(now);
    next.setHours(nextHour, 0, 0, 0);
    if (next <= now) {
      next.setHours(next.getHours() + 8);
    }
    this.nextRunTime = next;
  }

  async run(): Promise<{ success: boolean; reason: string; ideasGenerated?: number }> {
    if (this.isRunning) {
      return { success: false, reason: 'Already running' };
    }

    this.isRunning = true;
    console.log('Creative Agent run started');

    try {
      // Step 1: Check usage
      const usageCheck = await this.usageChecker.check();
      if (!usageCheck.canRun) {
        console.log(`Skipping run: ${usageCheck.reason}`);
        await this.telegram.sendSkipped(usageCheck.reason);
        return { success: false, reason: usageCheck.reason };
      }

      console.log(`Usage check passed: ${usageCheck.percentRemaining.toFixed(1)}% remaining`);

      // Step 2: Fetch data from sources
      const since = new Date();
      since.setHours(since.getHours() - this.config.schedule.lookbackHours);

      const [twitterData, githubData] = await Promise.all([
        this.twitterSource.fetch(since),
        this.githubSource.fetch(since),
      ]);

      const personalData: PersonalData = {
        twitter: twitterData,
        github: githubData,
        fetchedAt: new Date(),
      };

      const totalItems =
        twitterData.bookmarks.length +
        twitterData.likes.length +
        githubData.activities.length;

      if (totalItems === 0) {
        console.log('No recent activity found');
        await this.telegram.sendNoIdeas();
        return { success: true, reason: 'No recent activity', ideasGenerated: 0 };
      }

      console.log(`Fetched ${totalItems} items from data sources`);

      // Step 3: Analyze content
      const analysis = await this.analyzer.analyze(personalData);

      if (analysis.topics.length === 0 && analysis.problems.length === 0) {
        console.log('No actionable insights from analysis');
        await this.telegram.sendNoIdeas();
        return { success: true, reason: 'No actionable insights', ideasGenerated: 0 };
      }

      // Step 4: Generate ideas
      const result = await this.ideaGenerator.generate(analysis, personalData);

      if (result.ideas.length === 0) {
        console.log('No project ideas generated');
        await this.telegram.sendNoIdeas();
        return { success: true, reason: 'No ideas generated', ideasGenerated: 0 };
      }

      // Step 5: Send top 3 ideas to Telegram for approval
      const topIdeas = result.ideas.slice(0, 3);

      for (const idea of topIdeas) {
        await this.telegram.sendIdea(idea);

        // Track pending idea
        this.pendingIdeas.set(idea.id, {
          id: idea.id,
          idea,
          sentAt: new Date(),
          status: 'pending',
        });

        // Small delay between messages to avoid rate limiting
        if (topIdeas.indexOf(idea) < topIdeas.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      console.log(`Sent ${topIdeas.length} ideas for approval`);

      this.lastRunTime = new Date();
      this.updateNextRunTime();

      return {
        success: true,
        reason: 'Ideas generated and sent for approval',
        ideasGenerated: result.ideas.length,
      };
    } catch (error) {
      console.error('Creative Agent run failed:', error);
      await this.telegram.sendError(error instanceof Error ? error.message : String(error));
      return {
        success: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.isRunning = false;
    }
  }

  async runNow(): Promise<{ success: boolean; reason: string; ideasGenerated?: number }> {
    return this.run();
  }

  async handleApproval(ideaId: string, approved: boolean): Promise<boolean> {
    const pending = this.pendingIdeas.get(ideaId);
    if (!pending) {
      console.log(`No pending idea found: ${ideaId}`);
      return false;
    }

    pending.status = approved ? 'approved' : 'skipped';
    this.pendingIdeas.delete(ideaId);

    if (approved) {
      console.log(`Idea approved: ${pending.idea.title}`);
      return this.telegram.executeIdea(pending.idea);
    } else {
      console.log(`Idea skipped: ${pending.idea.title}`);
      return true;
    }
  }

  async handleModify(ideaId: string): Promise<boolean> {
    const pending = this.pendingIdeas.get(ideaId);
    if (!pending) {
      console.log(`No pending idea found for modification: ${ideaId}`);
      return false;
    }

    // Mark as awaiting feedback
    pending.status = 'awaiting_feedback';
    pending.feedback = pending.feedback || [];

    console.log(`Idea marked for modification: ${pending.idea.title}`);
    return this.telegram.sendFeedbackPrompt(pending.idea);
  }

  async handleFeedback(feedbackText: string): Promise<boolean> {
    // Find the idea that's awaiting feedback
    const pendingEntry = Array.from(this.pendingIdeas.entries())
      .find(([, p]) => p.status === 'awaiting_feedback');

    if (!pendingEntry) {
      console.log('No idea awaiting feedback');
      return false;
    }

    const [ideaId, pending] = pendingEntry;

    // Add feedback to the list
    pending.feedback = pending.feedback || [];
    pending.feedback.push(feedbackText);

    // Send acknowledgment
    await this.telegram.sendFeedbackReceived(pending.idea.title);

    // Store original in previous versions if not already
    if (!pending.previousVersions) {
      pending.previousVersions = [];
    }
    pending.previousVersions.push(pending.idea);

    // Refine the idea using Claude
    const refinedIdea = await this.ideaGenerator.refineIdea(pending.idea, pending.feedback);

    if (!refinedIdea) {
      await this.telegram.sendError('Failed to refine idea. Please try again or skip this one.');
      pending.status = 'pending';  // Reset to pending
      return false;
    }

    // Update the pending idea with refined version
    const oldId = pending.id;
    pending.id = refinedIdea.id;
    pending.idea = refinedIdea;
    pending.status = 'pending';  // Reset to pending, awaiting new decision

    // Update the map with new ID
    this.pendingIdeas.delete(oldId);
    this.pendingIdeas.set(refinedIdea.id, pending);

    // Send the refined idea
    await this.telegram.sendIdea(refinedIdea, true);

    console.log(`Idea refined: ${refinedIdea.title}`);
    return true;
  }

  getIdeaAwaitingFeedback(): PendingIdea | null {
    for (const pending of this.pendingIdeas.values()) {
      if (pending.status === 'awaiting_feedback') {
        return pending;
      }
    }
    return null;
  }

  isCurrentlyRunning(): boolean {
    return this.isRunning;
  }

  getLastRunTime(): Date | null {
    return this.lastRunTime;
  }

  getNextRunTime(): Date | null {
    return this.nextRunTime;
  }

  getPendingIdeas(): PendingIdea[] {
    return Array.from(this.pendingIdeas.values());
  }
}
