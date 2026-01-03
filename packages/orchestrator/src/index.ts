import 'dotenv/config';
import { OrchestratorServer } from './server.js';

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

function getOptionalNumberEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for environment variable ${name}: ${value}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  console.log('Starting Claude Code Orchestrator...');

  const codexCommand = process.env.CODEX_CLI_COMMAND || 'codex';
  const codexArgs = process.env.CODEX_CLI_ARGS?.split(' ').filter(Boolean) ?? [];
  console.log(`Codex CLI command: ${codexCommand}${codexArgs.length ? ` ${codexArgs.join(' ')}` : ''}`);

  const server = new OrchestratorServer({
    port: parseInt(getOptionalEnv('ORCHESTRATOR_PORT', '3000'), 10),
    secret: getRequiredEnv('ORCHESTRATOR_SECRET'),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY, // Optional: if not set, uses manual login
    codexCommand,
    codexArgs,
    workingDirectory: process.env.WORKING_DIRECTORY || process.cwd(),
    claudeTokenLimit: getOptionalNumberEnv('CLAUDE_TOKEN_LIMIT', 200000),
    claudeTokenWarningRatio: getOptionalNumberEnv('CLAUDE_TOKEN_WARNING_RATIO', 0.9),
    githubOrg: process.env.GITHUB_ORG, // Default GitHub org for repos without explicit org
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.start();
  console.log('Orchestrator is running and ready to receive instructions.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
