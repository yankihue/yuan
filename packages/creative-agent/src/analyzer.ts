import Anthropic from '@anthropic-ai/sdk';
import type { PersonalData, ContentAnalysis, Config } from './types.js';

const ANALYSIS_PROMPT = `You are an AI assistant analyzing a user's recent digital activity to understand their interests, problems they're thinking about, and potential project ideas.

Analyze the following data from their Twitter (bookmarks and likes) and GitHub activity:

<twitter_bookmarks>
{{BOOKMARKS}}
</twitter_bookmarks>

<twitter_likes>
{{LIKES}}
</twitter_likes>

<github_activity>
{{GITHUB}}
</github_activity>

Based on this data, provide a structured analysis in JSON format:

{
  "topics": ["list of main topics/themes they're interested in"],
  "problems": ["specific problems or pain points they seem to be experiencing or thinking about"],
  "toolsOfInterest": ["tools, libraries, or products they're exploring"],
  "activeProjects": ["projects they seem to be actively working on based on GitHub - include repo names"],
  "potentialImprovements": [
    {
      "repo": "repo-name",
      "suggestion": "specific improvement or feature suggestion"
    }
  ],
  "integrationOpportunities": [
    {
      "existingRepo": "repo-name that could be extended",
      "newCapability": "what could be added based on their interests",
      "rationale": "why this makes sense based on their activity"
    }
  ],
  "rawInsights": "A 2-3 sentence summary of overall patterns and what seems most actionable"
}

IMPORTANT: Look for TWO types of opportunities:
1. **Brand new projects** - completely new tools or utilities inspired by their interests
2. **Integration/extension ideas** - ways to enhance their EXISTING repos with new features, integrations, or capabilities based on what they're bookmarking/liking

For integration opportunities, think about:
- Could a tool they bookmarked be integrated into one of their projects?
- Could a technique or pattern they liked improve an existing codebase?
- Are there synergies between their interests and their active projects?

Focus on actionable insights - things that could become projects, improvements, or automations.
Return ONLY valid JSON, no other text.`;

export class ContentAnalyzer {
  private client: Anthropic;

  constructor(config: Config) {
    this.client = new Anthropic({
      apiKey: config.anthropic.apiKey,
    });
  }

  private formatTwitterData(data: PersonalData['twitter']): { bookmarks: string; likes: string } {
    const formatTweets = (tweets: PersonalData['twitter']['bookmarks']) => {
      if (tweets.length === 0) return 'No tweets';

      return tweets
        .map((t) => {
          const urls = t.urls.length > 0 ? `\n  URLs: ${t.urls.join(', ')}` : '';
          return `- @${t.authorUsername}: ${t.text}${urls}`;
        })
        .join('\n');
    };

    return {
      bookmarks: formatTweets(data.bookmarks),
      likes: formatTweets(data.likes),
    };
  }

  private formatGitHubData(data: PersonalData['github']): string {
    if (data.activities.length === 0) return 'No recent activity';

    return data.activities
      .map((a) => {
        const details = a.details ? `\n  Details: ${a.details}` : '';
        return `- [${a.type}] ${a.repoFullName}: ${a.description}${details}`;
      })
      .join('\n');
  }

  async analyze(data: PersonalData): Promise<ContentAnalysis> {
    const twitterFormatted = this.formatTwitterData(data.twitter);
    const githubFormatted = this.formatGitHubData(data.github);

    const prompt = ANALYSIS_PROMPT
      .replace('{{BOOKMARKS}}', twitterFormatted.bookmarks)
      .replace('{{LIKES}}', twitterFormatted.likes)
      .replace('{{GITHUB}}', githubFormatted);

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type');
      }

      // Parse JSON from response
      const jsonMatch = content.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const analysis = JSON.parse(jsonMatch[0]) as ContentAnalysis;
      console.log(`Analysis complete: ${analysis.topics.length} topics, ${analysis.problems.length} problems identified`);

      return analysis;
    } catch (error) {
      console.error('Error analyzing content:', error);
      // Return empty analysis on error
      return {
        topics: [],
        problems: [],
        toolsOfInterest: [],
        activeProjects: [],
        potentialImprovements: [],
        integrationOpportunities: [],
        rawInsights: 'Analysis failed',
      };
    }
  }
}
