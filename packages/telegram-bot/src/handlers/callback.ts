import type { Context } from 'grammy';
import type { OrchestratorClient } from '../services/orchestrator.js';

export class CallbackHandler {
  private orchestratorClient: OrchestratorClient;
  private taskThreadMap: Map<string, { chatId: number; rootMessageId: number }>;
  private creativeAgentUrl?: string;
  private authSecret: string;

  constructor(
    orchestratorClient: OrchestratorClient,
    taskThreadMap: Map<string, { chatId: number; rootMessageId: number }>,
    creativeAgentUrl?: string,
    authSecret?: string
  ) {
    this.orchestratorClient = orchestratorClient;
    this.taskThreadMap = taskThreadMap;
    this.creativeAgentUrl = creativeAgentUrl;
    this.authSecret = authSecret || '';
  }

  private async handleQuickAction(action: string, taskId: string | undefined, ctx: Context): Promise<void> {
    const taskLabel = taskId && taskId !== 'unknown' ? ` for task ${taskId}` : '';

    try {
      switch (action) {
        case 'input':
          await ctx.answerCallbackQuery({ text: 'Share more details' });
          await ctx.reply(
            `📝 Please provide additional input${taskLabel}. We'll forward your next message.`,
            {
              reply_markup: { force_reply: true },
            }
          );
          return;
        case 'retry':
          await ctx.answerCallbackQuery({ text: 'Retry requested' });
          await ctx.reply(
            `🔁 Retry selected${taskLabel}. Re-send your last instruction or clarification and I'll forward it.`,
            {
              reply_markup: { force_reply: true },
            }
          );
          return;
        case 'cancel':
          await ctx.answerCallbackQuery({ text: 'Cancel acknowledged' });
          await ctx.reply(
            `✖️ Cancel requested${taskLabel}. Send \"cancel\" to stop the current task.`,
            {
              reply_markup: { force_reply: true },
            }
          );
          return;
        default:
          await ctx.answerCallbackQuery({ text: 'Unknown action', show_alert: true });
      }
    } catch (error) {
      console.error('Failed to process quick action:', error);
      await ctx.answerCallbackQuery({
        text: '❌ Failed to process quick action. Please try again.',
        show_alert: true,
      });
    }
  }

  private async handleCreativeCallback(action: string, ideaId: string, ctx: Context): Promise<void> {
    if (!this.creativeAgentUrl) {
      await ctx.answerCallbackQuery({
        text: '❌ Creative agent not configured',
        show_alert: true,
      });
      return;
    }

    try {
      const response = await fetch(`${this.creativeAgentUrl}/callback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authSecret}`,
        },
        body: JSON.stringify({ action, ideaId }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Creative agent callback failed:', error);
        await ctx.answerCallbackQuery({
          text: '❌ Failed to process. Please try again.',
          show_alert: true,
        });
        return;
      }

      // Update the message to show the decision
      const originalMessage = ctx.callbackQuery?.message;
      let statusText = '';
      let answerText = '';

      switch (action) {
        case 'approve':
          statusText = '✅ Approved - Building...';
          answerText = 'Building this idea!';
          break;
        case 'skip':
          statusText = '⏭️ Skipped';
          answerText = 'Idea skipped';
          break;
        case 'modify':
          statusText = '✍️ Awaiting feedback';
          answerText = 'Send your feedback to modify this idea';
          break;
      }

      if (originalMessage && 'text' in originalMessage && action !== 'modify') {
        try {
          const updatedText = originalMessage.text + `\n\n*Decision: ${statusText}*`;
          await ctx.editMessageText(updatedText, { parse_mode: 'Markdown' });
        } catch (editError) {
          // Message might not be editable, that's ok
          console.warn('Could not edit message:', editError);
        }
      }

      await ctx.answerCallbackQuery({ text: answerText });
    } catch (error) {
      console.error('Failed to send creative callback:', error);
      await ctx.answerCallbackQuery({
        text: '❌ Failed to connect to creative agent',
        show_alert: true,
      });
    }
  }

  async handleCallback(ctx: Context): Promise<void> {
    const callbackData = ctx.callbackQuery?.data;
    const userId = ctx.from?.id;

    if (!callbackData || !userId) {
      await ctx.answerCallbackQuery({ text: 'Invalid callback' });
      return;
    }

    console.log(`Received callback from user ${userId}: ${callbackData}`);

    // Parse callback data: "approve:approvalId" or "reject:approvalId" or "quick:action:taskId" or "jump:taskId" or "cancel:taskId"
    const parts = callbackData.split(':');
    const action = parts[0];
    const identifier = parts[1];
    const taskId = parts[2]; // for quick actions

    if (!action || !identifier) {
      await ctx.answerCallbackQuery({ text: 'Invalid callback format' });
      return;
    }

    if (action === 'quick') {
      await this.handleQuickAction(identifier, taskId, ctx); // identifier holds quick action
      return;
    }

    // Handle creative agent callbacks (creative_approve, creative_modify, creative_skip)
    if (action.startsWith('creative_')) {
      await this.handleCreativeCallback(action.replace('creative_', ''), identifier, ctx);
      return;
    }

    if (action === 'approve' || action === 'reject') {
      const approved = action === 'approve';

      try {
        await this.orchestratorClient.sendApprovalResponse({
          approvalId: identifier,
          approved,
          userId: userId.toString(),
        });

        // Update the message to show the decision
        const statusText = approved ? '✅ Approved' : '❌ Rejected';
        const originalMessage = ctx.callbackQuery?.message;

        if (originalMessage && 'text' in originalMessage) {
          const updatedText = originalMessage.text + `\n\n*Decision: ${statusText}*`;
          await ctx.editMessageText(updatedText, {
            parse_mode: 'Markdown',
          });
        }

        await ctx.answerCallbackQuery({
          text: `${statusText}! Processing...`,
        });
      } catch (error) {
        console.error('Failed to send approval response:', error);
        await ctx.answerCallbackQuery({
          text: '❌ Failed to process approval. Please try again.',
          show_alert: true,
        });
      }
      return;
    }

    if (action === 'jump') {
      const thread = this.taskThreadMap.get(identifier);
      if (thread) {
        await ctx.api.sendMessage(thread.chatId, `🔎 Jumping to updates for task ${identifier}`, {
          reply_to_message_id: thread.rootMessageId,
        });
        await ctx.answerCallbackQuery({ text: 'Opening task updates' });
      } else {
        await ctx.answerCallbackQuery({
          text: 'No update thread found for this task yet.',
          show_alert: true,
        });
      }
      return;
    }

    if (action === 'cancel') {
      try {
        await this.orchestratorClient.cancelTask(identifier, userId.toString());
        const thread = this.taskThreadMap.get(identifier);
        const chatId = ctx.chat?.id || thread?.chatId;

        if (chatId) {
          await ctx.api.sendMessage(chatId, `🛑 Cancellation requested for task ${identifier}`, {
            reply_to_message_id: thread?.rootMessageId,
          });
        }

        await ctx.answerCallbackQuery({ text: 'Cancellation requested' });
      } catch (error) {
        console.error('Failed to cancel task:', error);
        await ctx.answerCallbackQuery({
          text: '❌ Failed to cancel task. Please try again.',
          show_alert: true,
        });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Unknown action' });
  }
}
