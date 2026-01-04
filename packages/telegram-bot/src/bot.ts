import { Bot, InlineKeyboard } from 'grammy';
import { createTranscriptionService, type TranscriptionService, type TranscriptionProvider } from './services/transcription.js';
import { OrchestratorClient } from './services/orchestrator.js';
import { VoiceHandler } from './handlers/voice.js';
import { TextHandler } from './handlers/text.js';
import { CallbackHandler } from './handlers/callback.js';
import type { AgentType, OrchestratorUpdate, StatusResponse, RepoQueueInfo, UsageResponse } from './types.js';

interface BotConfig {
  telegramBotToken: string;
  transcriptionProvider: TranscriptionProvider;
  openaiApiKey?: string;
  whisperModelPath?: string;
  whisperBinaryPath?: string;
  orchestratorHost: string;
  orchestratorPort: number;
  orchestratorSecret: string;
  allowedUserIds?: number[];
}

// Live dashboard that shows all active repos
interface DashboardState {
  messageId: number;
  chatId: number;
  lastUpdate: Date;
}

export class TelegramBot {
  private bot: Bot;
  private config: BotConfig;
  private transcriptionService: TranscriptionService;
  private orchestratorClient: OrchestratorClient;
  private voiceHandler: VoiceHandler;
  private textHandler: TextHandler;
  private callbackHandler: CallbackHandler;
  private userChatMap: Map<string, number> = new Map();
  private statusPollInterval: NodeJS.Timeout | null = null;
  private hasNotifiedDisconnect = false;
  private lastStatusSummary: string | null = null;
  private lastStatusMessages: Map<string, { messageId: number; chatId: number }> = new Map();
  private taskThreadMap: Map<string, { chatId: number; rootMessageId: number }> = new Map();
  // Live dashboard per user - shows all active repos in real-time
  private userDashboards: Map<string, DashboardState> = new Map();
  private dashboardUpdateInterval: NodeJS.Timeout | null = null;

  constructor(config: BotConfig) {
    this.config = config;
    this.bot = new Bot(config.telegramBotToken);

    // Initialize services
    this.transcriptionService = createTranscriptionService({
      provider: config.transcriptionProvider,
      openaiApiKey: config.openaiApiKey,
      whisperModelPath: config.whisperModelPath,
      whisperBinaryPath: config.whisperBinaryPath,
    });

    this.orchestratorClient = new OrchestratorClient({
      host: config.orchestratorHost,
      port: config.orchestratorPort,
      secret: config.orchestratorSecret,
    });

    // Initialize handlers
    this.voiceHandler = new VoiceHandler(
      this.transcriptionService,
      this.orchestratorClient,
      config.telegramBotToken
    );
    this.textHandler = new TextHandler(this.orchestratorClient, this.voiceHandler);
    this.callbackHandler = new CallbackHandler(this.orchestratorClient, this.taskThreadMap);

    this.setupMiddleware();
    this.setupHandlers();
    this.setupOrchestratorListener();
  }

  private setupMiddleware(): void {
    // User allowlist middleware
    if (this.config.allowedUserIds && this.config.allowedUserIds.length > 0) {
      this.bot.use(async (ctx, next) => {
        const userId = ctx.from?.id;
        if (!userId || !this.config.allowedUserIds!.includes(userId)) {
          console.log(`Unauthorized access attempt from user ${userId}`);
          await ctx.reply('❌ You are not authorized to use this bot.');
          return;
        }
        await next();
      });
    }

    // Track user chat IDs for sending updates
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (userId && chatId) {
        this.userChatMap.set(userId.toString(), chatId);
      }
      await next();
    });
  }

  private setupHandlers(): void {
    // Start command
    this.bot.command('start', async (ctx) => {
      const provider = this.config.transcriptionProvider === 'local' ? 'local Whisper' : 'OpenAI Whisper';
      await ctx.reply(
        '👋 *Welcome to the Voice-to-Code Orchestrator!*\n\n' +
        'I can help you control Claude Code using voice or text commands.\n\n' +
        '*How to use:*\n' +
        '🎤 Send voice messages with your instructions\n' +
        '✍️ Or type your instructions directly\n' +
        '📊 Type "status" to check active tasks\n' +
        '❌ Type "cancel" to stop the current task\n\n' +
        'Multiple voice messages sent within 10 seconds will be combined into one instruction.\n\n' +
        `_Using ${provider} for transcription_`,
        { parse_mode: 'Markdown' }
      );
    });

    // Help command
    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        '*Commands:*\n' +
        '• /start - Welcome message\n' +
        '• /help - Show this help\n' +
        '• /status - Show all active repos and tasks\n' +
        '• /dashboard - Start live dashboard (auto-updates)\n' +
        '• /usage - Show Claude plan usage\n' +
        '• cancel - Cancel current task\n\n' +
        '*Parallel Processing:*\n' +
        'Tasks for different repos run in parallel. ' +
        'Tasks for the same repo queue behind each other.\n\n' +
        '*Approval Actions:*\n' +
        'When sensitive operations (push, merge, publish) are detected, ' +
        'you\'ll receive approval requests with buttons.\n\n' +
        '*Voice Messages:*\n' +
        'Send multiple voice messages in quick succession (within 10 seconds) ' +
        'and they\'ll be combined into a single instruction.',
        { parse_mode: 'Markdown' }
      );
    });

    // Status command - show all active repos and tasks
    this.bot.command('status', async (ctx) => {
      try {
        const status = await this.orchestratorClient.getStatus();
        const statusText = this.formatFullStatus(status);
        await ctx.reply(statusText, { parse_mode: 'Markdown' });
      } catch (error) {
        console.error('Failed to get status:', error);
        await ctx.reply('❌ Failed to fetch status from orchestrator.');
      }
    });

    // Dashboard command - start a live-updating status message
    this.bot.command('dashboard', async (ctx) => {
      const userId = ctx.from?.id?.toString();
      const chatId = ctx.chat?.id;
      if (!userId || !chatId) return;

      try {
        const status = await this.orchestratorClient.getStatus();
        const statusText = this.formatFullStatus(status, true);

        const keyboard = new InlineKeyboard()
          .text('🔄 Refresh', 'dashboard:refresh')
          .text('✖️ Close', 'dashboard:close');

        const sent = await ctx.reply(statusText, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });

        // Store dashboard state
        this.userDashboards.set(userId, {
          messageId: sent.message_id,
          chatId,
          lastUpdate: new Date(),
        });

        // Start auto-refresh if not already running
        this.startDashboardUpdates();
      } catch (error) {
        console.error('Failed to create dashboard:', error);
        await ctx.reply('❌ Failed to create dashboard.');
      }
    });

    // Usage command - show Claude plan usage
    this.bot.command('usage', async (ctx) => {
      try {
        const usage = await this.orchestratorClient.getUsage();
        const usageText = this.formatUsage(usage);
        await ctx.reply(usageText, { parse_mode: 'Markdown' });
      } catch (error) {
        console.error('Failed to get usage:', error);
        await ctx.reply('❌ Failed to fetch usage information from Claude.');
      }
    });

    // Voice message handler
    this.bot.on('message:voice', async (ctx) => {
      await this.voiceHandler.handleVoice(ctx);
    });

    // Text message handler
    this.bot.on('message:text', async (ctx) => {
      await this.textHandler.handleText(ctx);
    });

    // Callback query handler (for inline buttons)
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery?.data;
      const userId = ctx.from?.id?.toString();

      // Handle dashboard callbacks
      if (data?.startsWith('dashboard:') && userId) {
        const action = data.split(':')[1];
        if (action === 'refresh') {
          await ctx.answerCallbackQuery({ text: 'Refreshing...' });
          await this.refreshDashboard(userId);
        } else if (action === 'close') {
          await ctx.answerCallbackQuery({ text: 'Dashboard closed' });
          await this.closeDashboard(userId);
        }
        return;
      }

      // Delegate other callbacks to the handler
      await this.callbackHandler.handleCallback(ctx);
    });

    // Error handler
    this.bot.catch((err) => {
      console.error('Bot error:', err);
    });
  }

  private setupOrchestratorListener(): void {
    this.orchestratorClient.on('update', async (update: OrchestratorUpdate) => {
      await this.handleOrchestratorUpdate(update);
    });

    this.orchestratorClient.on('connected', () => {
      console.log('Bot connected to orchestrator');
      this.hasNotifiedDisconnect = false;
      this.stopStatusPolling();
      this.lastStatusSummary = null;
      this.notifyUsers('✅ Reconnected to orchestrator. Resuming real-time updates.');
    });

    this.orchestratorClient.on('disconnected', () => {
      console.log('Bot disconnected from orchestrator');
      if (!this.hasNotifiedDisconnect) {
        this.notifyUsers('⚠️ Lost connection to orchestrator. I will retry and keep you updated with periodic status checks.');
        this.hasNotifiedDisconnect = true;
      }
      this.startStatusPolling();
    });
  }

  private async handleOrchestratorUpdate(update: OrchestratorUpdate): Promise<void> {
    const chatId = this.userChatMap.get(update.userId);

    if (!chatId) {
      console.warn(`No chat ID found for user ${update.userId}`);
      return;
    }

    try {
      switch (update.type) {
        case 'STATUS_UPDATE':
          await this.sendOrEditStatusMessage(chatId, update, '📊');
          break;

        case 'INPUT_NEEDED':
          await this.bot.api.sendMessage(
            chatId,
            `❓ *Input Needed*\n\n${update.message}`,
            {
              parse_mode: 'Markdown',
              reply_to_message_id: this.getThreadMessageId(update),
            }
          );
          if (update.inputId) {
            this.textHandler.setPendingInput(update.userId, update.inputId, update.expectedInputFormat);
          } else {
            console.warn('Received INPUT_NEEDED update without inputId');
          }
          break;

        case 'APPROVAL_REQUIRED':
          await this.sendApprovalRequest(chatId, update);
          break;

        case 'TASK_COMPLETE':
          this.textHandler.clearPendingInput(update.userId);
          await this.sendOrEditStatusMessage(chatId, update, '✅', true);
          break;

        case 'ERROR':
          this.textHandler.clearPendingInput(update.userId);
          await this.bot.api.sendMessage(chatId, `❌ *Error*\n\n${update.message}`, {
            parse_mode: 'Markdown',
            reply_to_message_id: this.getThreadMessageId(update),
          });
          break;
      }
    } catch (error) {
      console.error('Failed to send update to user:', error);
    }
  }

  private getStatusKey(update: OrchestratorUpdate): string {
    const taskKey = update.taskId ?? 'default';
    return `${update.userId}:${taskKey}`;
  }

  private formatAgent(agent?: AgentType): string {
    if (agent === 'codex') return 'ChatGPT Codex';
    if (agent === 'claude') return 'Claude Code';
    return 'Agent';
  }

  private formatRepoKey(repoKey?: string): string {
    if (!repoKey || repoKey === '__default__') return 'default';
    return repoKey;
  }

  private formatStatusText(update: OrchestratorUpdate, prefix: string): string {
    const agentLabel = this.formatAgent(update.agent);
    const title = update.taskTitle ? ` • ${update.taskTitle}` : '';
    const repo = update.repoKey ? ` 📂 ${this.formatRepoKey(update.repoKey)}` : '';
    return `${prefix} [${agentLabel}${title}]${repo}\n${update.message}`;
  }

  private formatUsage(usage: UsageResponse): string {
    const lines: string[] = [];
    lines.push('💰 *Claude Plan Usage*\n');

    // Create a visual progress bar
    const barLength = 20;
    const filledLength = Math.round((usage.percentUsed / 100) * barLength);
    const emptyLength = barLength - filledLength;
    const progressBar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);

    lines.push(`\`${progressBar}\` ${usage.percentUsed.toFixed(1)}%\n`);

    lines.push(`📊 *Daily Limit:* ${usage.dailyLimit}`);
    lines.push(`📈 *Used:* ${usage.used}`);
    lines.push(`📉 *Remaining:* ${usage.remaining}`);

    if (usage.resetTime) {
      lines.push(`\n🔄 *Resets:* ${usage.resetTime}`);
    }

    return lines.join('\n');
  }

  private formatFullStatus(status: StatusResponse, isDashboard = false): string {
    const lines: string[] = [];
    const now = new Date();

    if (isDashboard) {
      lines.push('📊 *Live Dashboard*');
      lines.push(`_Last updated: ${now.toLocaleTimeString()}_\n`);
    } else {
      lines.push('📊 *Orchestrator Status*\n');
    }

    // Parallel queue info
    if (status.parallelQueue) {
      const pq = status.parallelQueue;

      if (pq.processingRepos.length === 0 && pq.totalQueued === 0) {
        lines.push('💤 *No active tasks*');
        lines.push('_Send a message to start a task_');
      } else {
        lines.push(`🔄 *Active Repos:* ${pq.activeRepos}/${pq.maxConcurrentRepos}`);
        lines.push(`📋 *Queued Tasks:* ${pq.totalQueued}\n`);

        // Show each repo's status
        if (pq.repoQueues && pq.repoQueues.length > 0) {
          for (const repo of pq.repoQueues) {
            const repoName = this.formatRepoKey(repo.repoKey);
            const statusIcon = repo.processing ? '🟢' : '🟡';
            const statusText = repo.processing ? 'Processing' : 'Queued';
            lines.push(`${statusIcon} *${repoName}*: ${statusText}`);
            if (repo.queued > 0) {
              lines.push(`   └ ${repo.queued} task(s) waiting`);
            }
          }
        } else if (pq.processingRepos.length > 0) {
          lines.push('*Processing:*');
          for (const repo of pq.processingRepos) {
            lines.push(`🟢 ${this.formatRepoKey(repo)}`);
          }
        }
      }
    } else if (status.currentTask) {
      // Legacy single-task view
      const { description, status: taskStatus, agent } = status.currentTask;
      lines.push(`🔄 *Current Task* (${agent ?? 'unknown'}):`);
      lines.push(`   ${description}`);
      lines.push(`   Status: ${taskStatus}`);
    } else {
      lines.push('💤 *No active tasks*');
    }

    // Sub-agents
    if (status.subAgents?.length) {
      lines.push('\n*Sub-agents:*');
      for (const subAgent of status.subAgents) {
        const icon = subAgent.status === 'running' ? '🟢' :
                    subAgent.status === 'completed' ? '✅' :
                    subAgent.status === 'failed' ? '❌' : '🟡';
        lines.push(`${icon} ${subAgent.task} (${subAgent.repo})`);
      }
    }

    return lines.join('\n');
  }

  private startDashboardUpdates(): void {
    if (this.dashboardUpdateInterval) return;

    // Update dashboards every 5 seconds
    this.dashboardUpdateInterval = setInterval(async () => {
      if (this.userDashboards.size === 0) {
        this.stopDashboardUpdates();
        return;
      }

      try {
        const status = await this.orchestratorClient.getStatus();
        await this.updateAllDashboards(status);
      } catch (error) {
        console.error('Failed to update dashboards:', error);
      }
    }, 5000);
  }

  private stopDashboardUpdates(): void {
    if (this.dashboardUpdateInterval) {
      clearInterval(this.dashboardUpdateInterval);
      this.dashboardUpdateInterval = null;
    }
  }

  private async updateAllDashboards(status: StatusResponse): Promise<void> {
    const statusText = this.formatFullStatus(status, true);
    const keyboard = new InlineKeyboard()
      .text('🔄 Refresh', 'dashboard:refresh')
      .text('✖️ Close', 'dashboard:close');

    for (const [userId, dashboard] of this.userDashboards.entries()) {
      try {
        await this.bot.api.editMessageText(
          dashboard.chatId,
          dashboard.messageId,
          statusText,
          {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          }
        );
        dashboard.lastUpdate = new Date();
      } catch (error) {
        // Message might have been deleted - remove from tracking
        console.warn(`Failed to update dashboard for user ${userId}:`, error);
        this.userDashboards.delete(userId);
      }
    }
  }

  async closeDashboard(userId: string): Promise<void> {
    const dashboard = this.userDashboards.get(userId);
    if (dashboard) {
      try {
        await this.bot.api.editMessageText(
          dashboard.chatId,
          dashboard.messageId,
          '📊 *Dashboard closed*\n_Use /dashboard to open again_',
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.warn('Failed to close dashboard:', error);
      }
      this.userDashboards.delete(userId);
    }

    if (this.userDashboards.size === 0) {
      this.stopDashboardUpdates();
    }
  }

  async refreshDashboard(userId: string): Promise<void> {
    const dashboard = this.userDashboards.get(userId);
    if (!dashboard) return;

    try {
      const status = await this.orchestratorClient.getStatus();
      const statusText = this.formatFullStatus(status, true);
      const keyboard = new InlineKeyboard()
        .text('🔄 Refresh', 'dashboard:refresh')
        .text('✖️ Close', 'dashboard:close');

      await this.bot.api.editMessageText(
        dashboard.chatId,
        dashboard.messageId,
        statusText,
        {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        }
      );
      dashboard.lastUpdate = new Date();
    } catch (error) {
      console.error('Failed to refresh dashboard:', error);
    }
  }

  private buildQuickReplyKeyboard(taskId?: string): InlineKeyboard {
    return new InlineKeyboard()
      .text('📝 Provide input', `quick:input:${taskId ?? 'unknown'}`)
      .text('🔁 Retry', `quick:retry:${taskId ?? 'unknown'}`)
      .text('✖️ Cancel', `quick:cancel:${taskId ?? 'unknown'}`);
  }

  private getThreadMessageId(update: OrchestratorUpdate): number | undefined {
    if (!update.taskId) {
      return undefined;
    }
    const thread = this.taskThreadMap.get(update.taskId);
    return thread?.rootMessageId;
  }

  private recordThread(update: OrchestratorUpdate, chatId: number, messageId: number): void {
    if (update.taskId && !this.taskThreadMap.has(update.taskId)) {
      this.taskThreadMap.set(update.taskId, { chatId, rootMessageId: messageId });
    }
  }

  private async sendOrEditStatusMessage(
    chatId: number,
    update: OrchestratorUpdate,
    prefix: string,
    clearAfterSend = false
  ): Promise<void> {
    const key = this.getStatusKey(update);
    const statusText = this.formatStatusText(update, prefix);
    const keyboard = this.buildQuickReplyKeyboard(update.taskId);
    const existing = this.lastStatusMessages.get(key);

    if (existing) {
      try {
        await this.bot.api.editMessageText(existing.chatId, existing.messageId, statusText, {
          reply_markup: keyboard,
        });
        if (clearAfterSend) {
          this.lastStatusMessages.delete(key);
        }
        return;
      } catch (error) {
        console.warn('Failed to edit status message, sending new one instead:', error);
      }
    }

    const sent = await this.bot.api.sendMessage(chatId, statusText, {
      reply_markup: keyboard,
      reply_to_message_id: this.getThreadMessageId(update),
    });

    this.recordThread(update, chatId, sent.message_id);

    if (!clearAfterSend) {
      this.lastStatusMessages.set(key, { chatId, messageId: sent.message_id });
    } else {
      this.lastStatusMessages.delete(key);
    }
  }

  private async sendApprovalRequest(chatId: number, update: OrchestratorUpdate): Promise<void> {
    if (!update.approvalId || !update.approvalDetails) {
      console.error('Invalid approval request - missing approvalId or details');
      return;
    }

    const keyboard = new InlineKeyboard()
      .text('✅ Approve', `approve:${update.approvalId}`)
      .text('❌ Reject', `reject:${update.approvalId}`);

    const message =
      `🔐 *Approval Required*\n\n` +
      `*Agent:* ${this.formatAgent(update.agent)}\n` +
      (update.taskTitle ? `*Task:* ${update.taskTitle}\n` : '') +
      `*Action:* ${update.approvalDetails.action}\n` +
      `*Repo:* ${update.approvalDetails.repo}\n` +
      `*Details:* ${update.approvalDetails.details}`;

    const sentMessage = await this.bot.api.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_to_message_id: this.getThreadMessageId(update),
      reply_markup: keyboard,
    });

    this.recordThread(update, chatId, sentMessage.message_id);
  }

  private notifyUsers(message: string): void {
    for (const chatId of this.userChatMap.values()) {
      this.bot.api.sendMessage(chatId, message).catch((error) => {
        console.error(`Failed to notify chat ${chatId} about orchestrator status:`, error);
      });
    }
  }

  private startStatusPolling(): void {
    if (this.statusPollInterval) {
      return;
    }

    this.statusPollInterval = setInterval(async () => {
      try {
        const status = await this.orchestratorClient.getStatus();
        await this.handleStatusUpdate(status);
      } catch (error) {
        console.error('Failed to poll orchestrator status:', error);
      }
    }, 15000);
  }

  private stopStatusPolling(): void {
    if (this.statusPollInterval) {
      clearInterval(this.statusPollInterval);
      this.statusPollInterval = null;
    }
  }

  private async handleStatusUpdate(status: StatusResponse): Promise<void> {
    const summary = this.formatStatusSummary(status);

    if (!summary || summary === this.lastStatusSummary) {
      return;
    }

    this.lastStatusSummary = summary;
    await Promise.all(
      Array.from(this.userChatMap.values()).map((chatId) =>
        this.bot.api.sendMessage(chatId, summary).catch((error) => {
          console.error(`Failed to send status summary to chat ${chatId}:`, error);
        })
      )
    );
  }

  private formatStatusSummary(status: StatusResponse): string {
    const hasParallelTasks = status.parallelQueue &&
      (status.parallelQueue.processingRepos.length > 0 || status.parallelQueue.totalQueued > 0);

    if (!status.subAgents?.length && !status.currentTask && !hasParallelTasks) {
      return '📡 Orchestrator status: idle while WebSocket is offline.';
    }

    const lines: string[] = ['📡 Orchestrator status while WebSocket is offline:'];

    // Parallel queue info
    if (status.parallelQueue && hasParallelTasks) {
      const pq = status.parallelQueue;
      lines.push(`• Active repos: ${pq.activeRepos}/${pq.maxConcurrentRepos}`);

      if (pq.repoQueues && pq.repoQueues.length > 0) {
        for (const repo of pq.repoQueues) {
          const repoName = this.formatRepoKey(repo.repoKey);
          const status = repo.processing ? '🟢 processing' : '🟡 queued';
          lines.push(`   - ${repoName}: ${status}${repo.queued > 0 ? ` (+${repo.queued} waiting)` : ''}`);
        }
      } else if (pq.processingRepos.length > 0) {
        for (const repo of pq.processingRepos) {
          lines.push(`   - ${this.formatRepoKey(repo)}: 🟢 processing`);
        }
      }
    } else if (status.currentTask) {
      const { description, status: taskStatus, agent } = status.currentTask;
      lines.push(`• Current task (${agent ?? 'unknown'}): ${description} [${taskStatus}]`);
    }

    if (status.subAgents?.length) {
      lines.push('• Sub-agents:');
      for (const subAgent of status.subAgents) {
        lines.push(
          `   - ${subAgent.id}: ${subAgent.task} (${subAgent.repo}) [${subAgent.status}]`
        );
      }
    }

    return lines.join('\n');
  }

  async start(): Promise<void> {
    // Connect to orchestrator
    try {
      await this.orchestratorClient.connect();
      console.log('Connected to orchestrator');
    } catch (error) {
      console.warn('Could not connect to orchestrator, will retry:', error);
      this.startStatusPolling();
    }

    // Start the bot
    console.log('Starting Telegram bot...');
    console.log(`Transcription provider: ${this.config.transcriptionProvider}`);
    await this.bot.start({
      onStart: (botInfo) => {
        console.log(`Bot @${botInfo.username} is running!`);
      },
    });
  }

  async stop(): Promise<void> {
    this.orchestratorClient.disconnect();
    await this.bot.stop();
  }
}
