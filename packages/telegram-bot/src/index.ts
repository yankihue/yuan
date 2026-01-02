import 'dotenv/config';
import { TelegramBot } from './bot.js';
import type { TranscriptionProvider } from './services/transcription.js';

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalEnv(name: string, defaultValue: string): string {
  return process.env[name] || defaultValue;
}

function parseUserIds(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !isNaN(id));
}

async function main(): Promise<void> {
  console.log('Starting Voice-to-Code Telegram Bot...');

  // Determine transcription provider
  const transcriptionProvider = getOptionalEnv('TRANSCRIPTION_PROVIDER', 'openai') as TranscriptionProvider;

  // Validate provider config
  if (transcriptionProvider === 'openai' && !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when using openai transcription provider');
  }

  if (transcriptionProvider === 'local') {
    console.log('Using local Whisper transcription');
    console.log('Make sure whisper.cpp or faster-whisper is installed');
  }

  const bot = new TelegramBot({
    telegramBotToken: getRequiredEnv('TELEGRAM_BOT_TOKEN'),
    transcriptionProvider,
    openaiApiKey: process.env.OPENAI_API_KEY,
    whisperModelPath: process.env.WHISPER_MODEL_PATH,
    whisperBinaryPath: process.env.WHISPER_BINARY_PATH,
    orchestratorHost: getOptionalEnv('ORCHESTRATOR_HOST', 'localhost'),
    orchestratorPort: parseInt(getOptionalEnv('ORCHESTRATOR_PORT', '3000'), 10),
    orchestratorSecret: getRequiredEnv('ORCHESTRATOR_SECRET'),
    allowedUserIds: parseUserIds(process.env.ALLOWED_USER_IDS),
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
