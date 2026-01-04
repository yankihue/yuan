import { InlineKeyboard, type Context } from 'grammy';
import type { OrchestratorClient } from '../services/orchestrator.js';
import type { VoiceHandler } from './voice.js';

export class TextHandler {
  private orchestratorClient: OrchestratorClient;
  private voiceHandler: VoiceHandler;
  private pendingInputs: Map<string, { inputId: string; expectedInputFormat?: string }> = new Map();
  private creativeAgentUrl?: string;
  private authSecret: string;

  constructor(
    orchestratorClient: OrchestratorClient,
    voiceHandler: VoiceHandler,
    creativeAgentUrl?: string,
    authSecret?: string
  ) {
    this.orchestratorClient = orchestratorClient;
    this.voiceHandler = voiceHandler;
    this.creativeAgentUrl = creativeAgentUrl;
    this.authSecret = authSecret || '';
  }

  async handleText(ctx: Context): Promise<void> {
    const text = ctx.message?.text;
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!text || !userId || !chatId) {
      return;
    }

    console.log(`Received text message from user ${userId}: "${text.substring(0, 50)}..."`);

    // Flush any pending voice messages first
    const voiceTranscription = await this.voiceHandler.flushBuffer(userId, ctx);

    // Combine voice transcription with text if present
    let instruction = text;
    if (voiceTranscription) {
      instruction = `${voiceTranscription} ${text}`;
    }

    const userIdStr = userId.toString();
    const pendingInput = this.pendingInputs.get(userIdStr);

    if (pendingInput) {
      await ctx.api.sendChatAction(chatId, 'typing');
      try {
        await this.orchestratorClient.sendInputResponse({
          userId: userIdStr,
          inputId: pendingInput.inputId,
          response: instruction,
        });
        this.pendingInputs.delete(userIdStr);
        await ctx.reply('✅ Got it! Passing your response back to the task.');
      } catch (error) {
        console.error('Failed to send input response to orchestrator:', error);
        await ctx.reply('❌ Sorry, I couldn\'t deliver your response. Please try again.');
      }
      return;
    }

    // Check if creative-agent is awaiting feedback
    if (this.creativeAgentUrl) {
      const feedbackSent = await this.tryRouteToCreativeAgent(instruction, chatId);
      if (feedbackSent) {
        return;
      }
    }

    // Check for special commands
    const lowerText = instruction.toLowerCase().trim();

    if (lowerText === 'status') {
      await this.handleStatusCommand(ctx, userId);
      return;
    }

    if (lowerText === 'cancel') {
      await this.handleCancelCommand(ctx, userId);
      return;
    }

    if (lowerText === '/reset' || lowerText === 'reset') {
      await this.handleResetCommand(ctx, userId);
      return;
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

  setPendingInput(userId: string, inputId: string, expectedInputFormat?: string): void {
    this.pendingInputs.set(userId, { inputId, expectedInputFormat });
  }

  clearPendingInput(userId: string): void {
    this.pendingInputs.delete(userId);
  }

  private async tryRouteToCreativeAgent(text: string, chatId: number): Promise<boolean> {
    if (!this.creativeAgentUrl) {
      return false;
    }

    try {
      // Check if creative-agent is awaiting feedback
      const checkResponse = await fetch(`${this.creativeAgentUrl}/awaiting-feedback`, {
        headers: {
          Authorization: `Bearer ${this.authSecret}`,
        },
      });

      if (!checkResponse.ok) {
        return false;
      }

      const status = await checkResponse.json() as { awaitingFeedback: boolean; ideaTitle?: string };

      if (!status.awaitingFeedback) {
        return false;
      }

      // Route the text as feedback to creative-agent
      const feedbackResponse = await fetch(`${this.creativeAgentUrl}/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authSecret}`,
        },
        body: JSON.stringify({ text }),
      });

      if (!feedbackResponse.ok) {
        console.error('Failed to send feedback to creative-agent:', await feedbackResponse.text());
        return false;
      }

      console.log(`Routed feedback to creative-agent for idea: ${status.ideaTitle}`);
      return true;
    } catch (error) {
      console.error('Error checking/routing to creative-agent:', error);
      return false;
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
      let replyMarkup: InlineKeyboard | undefined;

      if (status.currentTask) {
        message += `*Current Task:*\n`;
        message += `ID: \`${status.currentTask.id}\`\n`;
        message += `📝 ${status.currentTask.description}\n`;
        message += `Status: ${status.currentTask.status}\n`;
        message += `Started: ${this.formatTime(status.currentTask.startedAt)}\n\n`;
        if (status.currentTask.agent) {
          message += `Agent: ${this.formatAgent(status.currentTask.agent)}\n\n`;
        }

        replyMarkup = new InlineKeyboard()
          .text('🔎 Jump to updates', `jump:${status.currentTask.id}`)
          .text('🛑 Cancel', `cancel:${status.currentTask.id}`);
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

      await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: replyMarkup });
    } catch (error) {
      console.error('Failed to get status:', error);
      await ctx.reply('❌ Couldn\'t retrieve status. The processing server might be unavailable.');
    }
  }

  private async handleCancelCommand(ctx: Context, userId: number): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
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

  private async handleResetCommand(ctx: Context, userId: number): Promise<void> {
    try {
      await this.orchestratorClient.resetConversation(userId.toString());
      await ctx.reply('🧹 Conversation history has been reset for this chat.');
    } catch (error) {
      console.error('Failed to reset conversation:', error);
      await ctx.reply('❌ Could not reset conversation history. Please try again.');
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
