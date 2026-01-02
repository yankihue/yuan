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

async function main(): Promise<void> {
  console.log('Starting Claude Code Orchestrator...');

  const codexCommand = process.env.CODEX_CLI_COMMAND || 'codex';
  const codexArgs = process.env.CODEX_CLI_ARGS?.split(' ').filter(Boolean) ?? [];
  console.log(`Codex CLI command: ${codexCommand}${codexArgs.length ? ` ${codexArgs.join(' ')}` : ''}`);

  const server = new OrchestratorServer({
    port: parseInt(getOptionalEnv('ORCHESTRATOR_PORT', '3000'), 10),
    secret: getRequiredEnv('ORCHESTRATOR_SECRET'),
    anthropicApiKey: getRequiredEnv('ANTHROPIC_API_KEY'),
    codexCommand,
    codexArgs,
    workingDirectory: process.env.WORKING_DIRECTORY || process.cwd(),
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
