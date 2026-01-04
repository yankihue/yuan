import type { ProjectIdea, Config } from './types.js';

export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  private orchestratorUrl: string;
  private orchestratorSecret: string;

  constructor(config: Config) {
    this.botToken = config.telegram.botToken;
    this.chatId = config.telegram.chatId;
    this.orchestratorUrl = config.orchestrator.url;
    this.orchestratorSecret = config.orchestrator.secret;
  }

  private async sendMessage(text: string, replyMarkup?: object): Promise<boolean> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Telegram API error:', error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Error sending Telegram message:', error);
      return false;
    }
  }

  private formatIdea(idea: ProjectIdea): string {
    const complexityEmoji = {
      small: '🟢',
      medium: '🟡',
      large: '🔴',
    };

    const derivativeTag = idea.isDerivative ? `\n📦 *Based on:* ${idea.sourceRepo}` : '';

    return `🚀 *${idea.title}*

*Problem:* ${idea.problemStatement}

*Solution:* ${idea.proposedSolution}

*Complexity:* ${complexityEmoji[idea.complexity]} ${idea.complexity}
*Tech Stack:* ${idea.techStack.join(', ')}
*Relevance:* ${idea.relevanceScore}%${derivativeTag}

*Steps:*
${idea.implementationSteps.map((step, i) => `${i + 1}. ${step}`).join('\n')}`;
  }

  async sendIdea(idea: ProjectIdea): Promise<boolean> {
    const text = this.formatIdea(idea);

    // Create inline keyboard with approve/skip buttons
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Build this', callback_data: `creative_approve:${idea.id}` },
          { text: '⏭️ Skip', callback_data: `creative_skip:${idea.id}` },
        ],
      ],
    };

    return this.sendMessage(text, replyMarkup);
  }

  async sendNoIdeas(): Promise<boolean> {
    return this.sendMessage('🤔 *Creative Agent*\n\nNo interesting project ideas found in your recent activity. Will check again in 8 hours.');
  }

  async sendError(error: string): Promise<boolean> {
    return this.sendMessage(`⚠️ *Creative Agent Error*\n\n${error}`);
  }

  async sendSkipped(reason: string): Promise<boolean> {
    return this.sendMessage(`⏸️ *Creative Agent Skipped*\n\n${reason}`);
  }

  async executeIdea(idea: ProjectIdea): Promise<boolean> {
    // Send instruction to orchestrator to build the project
    const instruction = this.buildInstruction(idea);

    try {
      const response = await fetch(`${this.orchestratorUrl}/instruction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.orchestratorSecret}`,
        },
        body: JSON.stringify({
          userId: this.chatId,
          messageId: `creative-agent-${idea.id}`,
          instruction,
          timestamp: new Date(),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Orchestrator error:', error);
        await this.sendMessage(`❌ Failed to start building: ${error}`);
        return false;
      }

      await this.sendMessage(`🛠️ *Started building:* ${idea.title}\n\nI'll update you on progress via the orchestrator.`);
      return true;
    } catch (error) {
      console.error('Error sending to orchestrator:', error);
      await this.sendError(`Failed to connect to orchestrator: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private buildInstruction(idea: ProjectIdea): string {
    const repoContext = idea.isDerivative && idea.sourceRepo
      ? `This is an improvement to the existing ${idea.sourceRepo} repository.`
      : 'Create a new repository for this project.';

    return `Build the following project:

**${idea.title}**

Problem: ${idea.problemStatement}

Solution: ${idea.proposedSolution}

${repoContext}

Implementation steps:
${idea.implementationSteps.map((step, i) => `${i + 1}. ${step}`).join('\n')}

Tech stack: ${idea.techStack.join(', ')}

Please implement this project step by step, creating all necessary files and configurations.`;
  }
}
