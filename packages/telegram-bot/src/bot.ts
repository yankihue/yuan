import { Bot, InlineKeyboard } from 'grammy';
import { createTranscriptionService, type TranscriptionService, type TranscriptionProvider } from './services/transcription.js';
import { OrchestratorClient } from './services/orchestrator.js';
import { VoiceHandler } from './handlers/voice.js';
import { TextHandler } from './handlers/text.js';
import { CallbackHandler } from './handlers/callback.js';
import type { OrchestratorUpdate } from './types.js';

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

export class TelegramBot {
  private bot: Bot;
  private config: BotConfig;
  private transcriptionService: TranscriptionService;
  private orchestratorClient: OrchestratorClient;
  private voiceHandler: VoiceHandler;
  private textHandler: TextHandler;
  private callbackHandler: CallbackHandler;
  private userChatMap: Map<string, number> = new Map();

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
    this.callbackHandler = new CallbackHandler(this.orchestratorClient);

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
        '• status - Show active tasks\n' +
        '• cancel - Cancel current task\n\n' +
        '*Approval Actions:*\n' +
        'When sensitive operations (push, merge, publish) are detected, ' +
        'you\'ll receive approval requests with buttons.\n\n' +
        '*Voice Messages:*\n' +
        'Send multiple voice messages in quick succession (within 10 seconds) ' +
        'and they\'ll be combined into a single instruction.',
        { parse_mode: 'Markdown' }
      );
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
    });

    this.orchestratorClient.on('disconnected', () => {
      console.log('Bot disconnected from orchestrator');
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
          await this.bot.api.sendMessage(chatId, `📊 ${update.message}`);
          break;

        case 'INPUT_NEEDED':
          await this.bot.api.sendMessage(
            chatId,
            `❓ *Input Needed*\n\n${update.message}`,
            { parse_mode: 'Markdown' }
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
          await this.bot.api.sendMessage(chatId, `✅ ${update.message}`);
          break;

        case 'ERROR':
          this.textHandler.clearPendingInput(update.userId);
          await this.bot.api.sendMessage(chatId, `❌ *Error*\n\n${update.message}`, {
            parse_mode: 'Markdown',
          });
          break;
      }
    } catch (error) {
      console.error('Failed to send update to user:', error);
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
      `*Action:* ${update.approvalDetails.action}\n` +
      `*Repo:* ${update.approvalDetails.repo}\n` +
      `*Details:* ${update.approvalDetails.details}`;

    await this.bot.api.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  async start(): Promise<void> {
    // Connect to orchestrator
    try {
      await this.orchestratorClient.connect();
      console.log('Connected to orchestrator');
    } catch (error) {
      console.warn('Could not connect to orchestrator, will retry:', error);
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
