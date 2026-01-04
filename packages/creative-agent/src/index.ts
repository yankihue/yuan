import express from 'express';
import dotenv from 'dotenv';
import { CreativeAgentScheduler } from './scheduler.js';
import { loadConfig } from './config.js';

dotenv.config();

const PORT = process.env.CREATIVE_AGENT_PORT || 3003;

async function main() {
  const app = express();
  app.use(express.json());

  // Load configuration
  const config = loadConfig();

  // Initialize scheduler
  const scheduler = new CreativeAgentScheduler(config);

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      nextRun: scheduler.getNextRunTime(),
    });
  });

  // Manual trigger endpoint (for testing)
  app.post('/trigger', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${config.orchestrator.secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const result = await scheduler.runNow();
      res.json({ status: 'triggered', result });
    } catch (error) {
      console.error('Manual trigger failed:', error);
      res.status(500).json({
        error: 'Trigger failed',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Status endpoint
  app.get('/status', (_req, res) => {
    res.json({
      isRunning: scheduler.isCurrentlyRunning(),
      lastRun: scheduler.getLastRunTime(),
      nextRun: scheduler.getNextRunTime(),
      pendingIdeas: scheduler.getPendingIdeas().length,
      awaitingFeedback: scheduler.getIdeaAwaitingFeedback() !== null,
      config: {
        cronExpression: config.schedule.cronExpression,
        usageThreshold: config.schedule.usageThreshold,
        lookbackHours: config.schedule.lookbackHours,
      },
    });
  });

  // Callback endpoint for telegram-bot to route button presses
  app.post('/callback', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${config.orchestrator.secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { action, ideaId } = req.body;

    if (!action || !ideaId) {
      res.status(400).json({ error: 'Missing action or ideaId' });
      return;
    }

    try {
      let success = false;

      switch (action) {
        case 'approve':
          success = await scheduler.handleApproval(ideaId, true);
          break;
        case 'skip':
          success = await scheduler.handleApproval(ideaId, false);
          break;
        case 'modify':
          success = await scheduler.handleModify(ideaId);
          break;
        default:
          res.status(400).json({ error: `Unknown action: ${action}` });
          return;
      }

      res.json({ success, action, ideaId });
    } catch (error) {
      console.error('Callback handling failed:', error);
      res.status(500).json({
        error: 'Callback handling failed',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Feedback endpoint for telegram-bot to send user feedback messages
  app.post('/feedback', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${config.orchestrator.secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { text } = req.body;

    if (!text) {
      res.status(400).json({ error: 'Missing feedback text' });
      return;
    }

    try {
      const success = await scheduler.handleFeedback(text);
      res.json({ success });
    } catch (error) {
      console.error('Feedback handling failed:', error);
      res.status(500).json({
        error: 'Feedback handling failed',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Check if awaiting feedback (for telegram-bot to know when to route messages)
  app.get('/awaiting-feedback', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${config.orchestrator.secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const pending = scheduler.getIdeaAwaitingFeedback();
    res.json({
      awaitingFeedback: pending !== null,
      ideaTitle: pending?.idea.title || null,
      ideaId: pending?.id || null,
    });
  });

  // Start the scheduler
  scheduler.start();

  // Start the server
  app.listen(PORT, () => {
    console.log(`Creative Agent server listening on port ${PORT}`);
    console.log(`Schedule: ${config.schedule.cronExpression}`);
    console.log(`Usage threshold: ${config.schedule.usageThreshold}% remaining required`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    scheduler.stop();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    scheduler.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start Creative Agent:', error);
  process.exit(1);
});
