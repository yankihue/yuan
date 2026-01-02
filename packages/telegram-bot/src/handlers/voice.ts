import type { Context } from 'grammy';
import type { TranscriptionService } from '../services/transcription.js';
import type { OrchestratorClient } from '../services/orchestrator.js';
import type { UserVoiceBuffer, VoiceBufferEntry } from '../types.js';

const VOICE_BUFFER_TIMEOUT_MS = 10000; // 10 seconds

export class VoiceHandler {
  private transcriptionService: TranscriptionService;
  private orchestratorClient: OrchestratorClient;
  private voiceBuffers: Map<number, UserVoiceBuffer> = new Map();
  private botToken: string;

  constructor(
    transcriptionService: TranscriptionService,
    orchestratorClient: OrchestratorClient,
    botToken: string
  ) {
    this.transcriptionService = transcriptionService;
    this.orchestratorClient = orchestratorClient;
    this.botToken = botToken;
  }

  async handleVoice(ctx: Context): Promise<void> {
    const voice = ctx.message?.voice;
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;

    if (!voice || !chatId || !userId) {
      return;
    }

    console.log(`Received voice message from user ${userId}, duration: ${voice.duration}s`);

    // Add to buffer
    const entry: VoiceBufferEntry = {
      fileId: voice.file_id,
      chatId,
      messageId: ctx.message!.message_id,
      timestamp: new Date(),
    };

    let buffer = this.voiceBuffers.get(userId);

    if (!buffer) {
      buffer = { entries: [], timer: null };
      this.voiceBuffers.set(userId, buffer);
    }

    // Clear existing timer
    if (buffer.timer) {
      clearTimeout(buffer.timer);
    }

    buffer.entries.push(entry);

    // Set new timer
    buffer.timer = setTimeout(() => {
      this.processVoiceBuffer(userId, ctx).catch(error => {
        console.error('Error processing voice buffer:', error);
        ctx.reply('❌ Sorry, I had trouble processing your voice messages. Please try again.')
          .catch(console.error);
      });
    }, VOICE_BUFFER_TIMEOUT_MS);

    // Send typing indicator
    await ctx.api.sendChatAction(chatId, 'typing').catch(console.error);
  }

  async flushBuffer(userId: number, ctx: Context): Promise<string | null> {
    const buffer = this.voiceBuffers.get(userId);

    if (!buffer || buffer.entries.length === 0) {
      return null;
    }

    // Clear timer
    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    // Process the buffer
    const transcription = await this.processVoiceBufferInternal(userId, ctx, buffer);
    return transcription;
  }

  private async processVoiceBuffer(userId: number, ctx: Context): Promise<void> {
    const buffer = this.voiceBuffers.get(userId);

    if (!buffer || buffer.entries.length === 0) {
      return;
    }

    buffer.timer = null;
    const transcription = await this.processVoiceBufferInternal(userId, ctx, buffer);

    if (transcription) {
      // Send instruction to orchestrator
      try {
        await this.orchestratorClient.sendInstruction({
          userId: userId.toString(),
          messageId: buffer.entries[0].messageId.toString(),
          instruction: transcription,
          timestamp: new Date(),
        });
      } catch (error) {
        console.error('Failed to send instruction to orchestrator:', error);
        await ctx.reply('❌ Sorry, I couldn\'t connect to the processing server. Please try again later.')
          .catch(console.error);
      }
    }
  }

  private async processVoiceBufferInternal(
    userId: number,
    ctx: Context,
    buffer: UserVoiceBuffer
  ): Promise<string | null> {
    const entries = [...buffer.entries];
    buffer.entries = [];

    console.log(`Processing ${entries.length} voice message(s) for user ${userId}`);

    const transcriptions: string[] = [];

    for (const entry of entries) {
      try {
        // Get file from Telegram
        const file = await ctx.api.getFile(entry.fileId);
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        // Download the file
        const response = await fetch(fileUrl);
        if (!response.ok) {
          throw new Error(`Failed to download file: ${response.status}`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());

        // Transcribe
        const text = await this.transcriptionService.transcribe(audioBuffer, 'ogg');
        transcriptions.push(text);

        console.log(`Transcribed: "${text.substring(0, 50)}..."`);
      } catch (error) {
        console.error('Failed to transcribe voice message:', error);
        const message = this.buildTranscriptionErrorMessage(error);
        await ctx.reply(message)
          .catch(console.error);
      }
    }

    if (transcriptions.length === 0) {
      return null;
    }

    const combinedTranscription = transcriptions.join(' ');

    // Echo back the transcription to the user
    await ctx.reply(`🎤 *Heard:* ${combinedTranscription}`, {
      parse_mode: 'Markdown',
    }).catch(console.error);

    return combinedTranscription;
  }

  private buildTranscriptionErrorMessage(error: unknown): string {
    const details = error instanceof Error ? error.message : String(error);

    if (details.includes('Python/faster-whisper not found')) {
      return [
        '❌ Local transcription is missing python3/faster-whisper.',
        'Install them in the telegram-bot container or set TRANSCRIPTION_PROVIDER=openai with OPENAI_API_KEY.',
      ].join('\n');
    }

    if (details.includes('whisper.cpp not found')) {
      return [
        '❌ Local transcription could not find whisper.cpp.',
        'Install whisper.cpp and set WHISPER_BINARY_PATH and WHISPER_MODEL_PATH, or use TRANSCRIPTION_PROVIDER=openai.',
      ].join('\n');
    }

    if (details.includes('ffmpeg not found')) {
      return [
        '❌ ffmpeg is missing in the telegram-bot container.',
        'Install ffmpeg or switch to TRANSCRIPTION_PROVIDER=openai.',
      ].join('\n');
    }

    return '❌ I could not transcribe that voice message. Please try again.';
  }
}
