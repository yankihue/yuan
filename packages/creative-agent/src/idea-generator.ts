import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import type { ContentAnalysis, ProjectIdea, IdeaGenerationResult, PersonalData, Config } from './types.js';

const IDEA_GENERATION_PROMPT = `You are a creative technologist helping generate project ideas based on someone's interests and current work.

Here's the analysis of their recent activity:

<analysis>
Topics of Interest: {{TOPICS}}
Problems They're Thinking About: {{PROBLEMS}}
Tools They're Exploring: {{TOOLS}}
Active Projects (repos they're working on): {{PROJECTS}}

Potential Improvements to Existing Repos:
{{IMPROVEMENTS}}

Integration Opportunities (ways to extend existing repos):
{{INTEGRATIONS}}

Overall Insights: {{INSIGHTS}}
</analysis>

Generate exactly 3 project ideas. You MUST include a MIX of:
- **New standalone projects**: Completely new tools or utilities inspired by their interests
- **Integration/extension ideas**: Adding new features or integrations to their EXISTING repos

This is important: don't just generate new projects. Look at their active repos and think about how their recent interests (bookmarks, likes) could be integrated INTO those repos as new features.

For each idea, provide:

[
  {
    "title": "Short, catchy project name",
    "problemStatement": "1-2 sentences describing the problem this solves",
    "proposedSolution": "2-3 sentences describing the solution",
    "implementationSteps": [
      "Step 1: ...",
      "Step 2: ...",
      "Step 3: ..."
    ],
    "complexity": "small|medium|large",
    "techStack": ["technology1", "technology2"],
    "isDerivative": true,
    "sourceRepo": "existing-repo-name to modify (or null if brand new project)",
    "relevanceScore": 0-100
  }
]

Guidelines:
- isDerivative = true means this modifies/extends an existing repo
- isDerivative = false means this is a brand new standalone project
- For derivative ideas, sourceRepo MUST be one of their active projects
- Higher relevanceScore = closer alignment to their current interests + activity
- Prefer actionable, buildable ideas over vague concepts

Return ONLY valid JSON array, no other text.`;

export class IdeaGenerator {
  private client: Anthropic;

  constructor(config: Config) {
    this.client = new Anthropic({
      apiKey: config.anthropic.apiKey,
    });
  }

  private formatAnalysis(analysis: ContentAnalysis): string {
    const improvements = analysis.potentialImprovements.length > 0
      ? analysis.potentialImprovements.map((i) => `- ${i.repo}: ${i.suggestion}`).join('\n')
      : 'None identified';

    const integrations = analysis.integrationOpportunities?.length > 0
      ? analysis.integrationOpportunities.map((i) => `- ${i.existingRepo}: ${i.newCapability} (${i.rationale})`).join('\n')
      : 'None identified';

    return IDEA_GENERATION_PROMPT
      .replace('{{TOPICS}}', analysis.topics.join(', ') || 'None identified')
      .replace('{{PROBLEMS}}', analysis.problems.join(', ') || 'None identified')
      .replace('{{TOOLS}}', analysis.toolsOfInterest.join(', ') || 'None identified')
      .replace('{{PROJECTS}}', analysis.activeProjects.join(', ') || 'None identified')
      .replace('{{IMPROVEMENTS}}', improvements)
      .replace('{{INTEGRATIONS}}', integrations)
      .replace('{{INSIGHTS}}', analysis.rawInsights);
  }

  async generate(analysis: ContentAnalysis, data: PersonalData): Promise<IdeaGenerationResult> {
    const prompt = this.formatAnalysis(analysis);

    try {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
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

      // Parse JSON array from response
      const jsonMatch = content.text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON array found in response');
      }

      const rawIdeas = JSON.parse(jsonMatch[0]) as Array<Omit<ProjectIdea, 'id' | 'sourceData'>>;

      // Add IDs and source data tracking
      const ideas: ProjectIdea[] = rawIdeas.map((idea) => ({
        ...idea,
        id: randomUUID(),
        sourceData: {
          tweetIds: [
            ...data.twitter.bookmarks.map((t) => t.id),
            ...data.twitter.likes.map((t) => t.id),
          ].slice(0, 10), // Track up to 10 source tweets
          githubRepos: [...new Set(data.github.activities.map((a) => a.repoFullName))].slice(0, 10),
        },
      }));

      // Sort by relevance score
      ideas.sort((a, b) => b.relevanceScore - a.relevanceScore);

      console.log(`Generated ${ideas.length} project ideas`);

      return {
        ideas,
        generatedAt: new Date(),
        dataUsed: {
          tweetCount: data.twitter.bookmarks.length + data.twitter.likes.length,
          githubActivityCount: data.github.activities.length,
        },
      };
    } catch (error) {
      console.error('Error generating ideas:', error);
      return {
        ideas: [],
        generatedAt: new Date(),
        dataUsed: {
          tweetCount: data.twitter.bookmarks.length + data.twitter.likes.length,
          githubActivityCount: data.github.activities.length,
        },
      };
    }
  }
}
