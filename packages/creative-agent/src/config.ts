import type { Config } from './types.js';

const DEFAULT_CRON = '0 */8 * * *'; // Every 8 hours
const DEFAULT_USAGE_THRESHOLD = 50; // Run if >50% remaining
const DEFAULT_LOOKBACK_HOURS = 8;
const DEFAULT_IGNORE_REPOS = ['yanki.dev', 'agentic-art'];

export function loadConfig(): Config {
  const requiredEnvVars = [
    'TWITTER_ACCESS_TOKEN',
    'TWITTER_REFRESH_TOKEN',
    'TWITTER_CLIENT_ID',
    'TWITTER_CLIENT_SECRET',
    'GITHUB_TOKEN',
    'GITHUB_USERNAME',
    'ORCHESTRATOR_URL',
    'ORCHESTRATOR_SECRET',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'ANTHROPIC_API_KEY',
  ];

  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Parse ignore repos from comma-separated string
  const ignoreReposEnv = process.env.GITHUB_IGNORE_REPOS;
  const ignoreRepos = ignoreReposEnv
    ? ignoreReposEnv.split(',').map((r) => r.trim()).filter(Boolean)
    : DEFAULT_IGNORE_REPOS;

  return {
    twitter: {
      accessToken: process.env.TWITTER_ACCESS_TOKEN!,
      refreshToken: process.env.TWITTER_REFRESH_TOKEN!,
      clientId: process.env.TWITTER_CLIENT_ID!,
      clientSecret: process.env.TWITTER_CLIENT_SECRET!,
    },
    github: {
      token: process.env.GITHUB_TOKEN!,
      username: process.env.GITHUB_USERNAME!,
      ignoreRepos,
    },
    orchestrator: {
      url: process.env.ORCHESTRATOR_URL!,
      secret: process.env.ORCHESTRATOR_SECRET!,
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN!,
      chatId: process.env.TELEGRAM_CHAT_ID!,
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY!,
    },
    schedule: {
      cronExpression: process.env.CREATIVE_AGENT_CRON || DEFAULT_CRON,
      usageThreshold: parseInt(process.env.CREATIVE_AGENT_USAGE_THRESHOLD || String(DEFAULT_USAGE_THRESHOLD), 10),
      lookbackHours: parseInt(process.env.CREATIVE_AGENT_LOOKBACK_HOURS || String(DEFAULT_LOOKBACK_HOURS), 10),
    },
  };
}
