import type { Context } from 'grammy';
import type { OrchestratorClient } from '../services/orchestrator.js';
import type { VoiceHandler } from './voice.js';

export class TextHandler {
  private orchestratorClient: OrchestratorClient;
  private voiceHandler: VoiceHandler;

  constructor(
    orchestratorClient: OrchestratorClient,
    voiceHandler: VoiceHandler
  ) {
    this.orchestratorClient = orchestratorClient;
    this.voiceHandler = voiceHandler;
  }

  async handleText(ctx: Context): Promise<void> {
    const text = ctx.message?.text;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!text || !userId || !chatId) {
      return;
    }

    console.log(`Received text message from user ${userId}: "${text.substring(0, 50)}..."`);

    // Check for special commands
    const lowerText = text.toLowerCase().trim();

    if (lowerText === 'status') {
      await this.handleStatusCommand(ctx, userId);
      return;
    }

    if (lowerText === 'cancel') {
      await this.handleCancelCommand(ctx);
      return;
    }

    // Flush any pending voice messages first
    const voiceTranscription = await this.voiceHandler.flushBuffer(userId, ctx);

    // Combine voice transcription with text if present
    let instruction = text;
    if (voiceTranscription) {
      instruction = `${voiceTranscription} ${text}`;
    }

    // Send instruction to orchestrator
    try {
      await ctx.api.sendChatAction(chatId, 'typing');

      await this.orchestratorClient.sendInstruction({
        userId: userId.toString(),
        messageId: ctx.message!.message_id.toString(),
        instruction,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('Failed to send instruction to orchestrator:', error);
      await ctx.reply('❌ Sorry, I couldn\'t connect to the processing server. Please try again later.')
        .catch(console.error);
    }
  }

  private async handleStatusCommand(ctx: Context, userId: number): Promise<void> {
    try {
      const status = await this.orchestratorClient.getStatus();

      if (status.subAgents.length === 0 && !status.currentTask) {
        await ctx.reply('📊 No active tasks at the moment.');
        return;
      }

      let message = '📊 *Active Tasks:*\n\n';

      if (status.currentTask) {
        message += `*Current Task:*\n`;
        message += `📝 ${status.currentTask.description}\n`;
        message += `Status: ${status.currentTask.status}\n`;
        message += `Started: ${this.formatTime(status.currentTask.startedAt)}\n\n`;
        if (status.currentTask.agent) {
          message += `Agent: ${this.formatAgent(status.currentTask.agent)}\n\n`;
        }
      }

      if (status.subAgents.length > 0) {
        message += '*Sub-Agents:*\n';
        for (let i = 0; i < status.subAgents.length; i++) {
          const agent = status.subAgents[i];
          const statusEmoji = this.getStatusEmoji(agent.status);
          message += `\n${i + 1}. *${agent.task}* (${agent.repo})\n`;
          message += `   ${statusEmoji} ${agent.status}\n`;
          message += `   Started: ${this.formatTime(agent.startedAt)}\n`;
          message += `   Last update: ${agent.lastUpdate}\n`;
        }
      }

      await ctx.reply(message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Failed to get status:', error);
      await ctx.reply('❌ Couldn\'t retrieve status. The processing server might be unavailable.');
    }
  }

  private async handleCancelCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || !chatId) {
      return;
    }

    try {
      await ctx.api.sendChatAction(chatId, 'typing');
      const result = await this.orchestratorClient.cancelTasks(userId.toString());

      const totalStopped = (result.cancelledTask ? 1 : 0) + result.cancelledSubAgents;
      const responseMessage = totalStopped > 0
        ? `🛑 Stopped ${totalStopped} task${totalStopped === 1 ? '' : 's'} (${result.cancelledSubAgents} sub-agent${result.cancelledSubAgents === 1 ? '' : 's'}).`
        : 'ℹ️ No active tasks to cancel.';

      await ctx.reply(responseMessage);
    } catch (error) {
      console.error('Failed to cancel tasks:', error);
      await ctx.reply('❌ Failed to cancel current tasks. Please try again.');
    }
  }

  private formatTime(date: Date): string {
    const now = new Date();
    const diffMs = now.getTime() - new Date(date).getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;

    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  }

  private getStatusEmoji(status: string): string {
    const emojis: Record<string, string> = {
      running: '🔄',
      waiting_input: '❓',
      waiting_approval: '⏳',
      completed: '✅',
      failed: '❌',
    };
    return emojis[status] || '⏹️';
  }

  private formatAgent(agent?: string): string {
    if (agent === 'codex') return 'ChatGPT Codex';
    if (agent === 'claude') return 'Claude Code';
    return 'Unknown';
  }
}
