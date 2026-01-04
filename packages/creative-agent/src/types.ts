// Configuration types
export interface Config {
  twitter: {
    accessToken: string;
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  };
  github: {
    token: string;
    username: string;
    ignoreRepos: string[];
  };
  orchestrator: {
    url: string;
    secret: string;
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  anthropic: {
    apiKey: string;
  };
  schedule: {
    cronExpression: string;
    usageThreshold: number; // Minimum remaining percentage to run
    lookbackHours: number;
  };
}

// Usage response from orchestrator
export interface UsageResponse {
  dailyLimit: string;
  used: string;
  remaining: string;
  percentUsed: number;
  resetTime?: string;
  raw?: string;
}

// Data source types
export interface Tweet {
  id: string;
  text: string;
  authorUsername: string;
  createdAt: Date;
  urls: string[];
  quotedTweet?: {
    text: string;
    authorUsername: string;
  };
}

export interface GitHubActivity {
  type: 'star' | 'push' | 'issue' | 'pr';
  repoName: string;
  repoFullName: string;
  description: string;
  url: string;
  createdAt: Date;
  details?: string; // Commit messages, issue titles, etc.
}

export interface PersonalData {
  twitter: {
    bookmarks: Tweet[];
    likes: Tweet[];
  };
  github: {
    activities: GitHubActivity[];
  };
  fetchedAt: Date;
}

// Analysis types
export interface ContentAnalysis {
  topics: string[];
  problems: string[];
  toolsOfInterest: string[];
  activeProjects: string[];
  potentialImprovements: Array<{
    repo: string;
    suggestion: string;
  }>;
  integrationOpportunities: Array<{
    existingRepo: string;
    newCapability: string;
    rationale: string;
  }>;
  rawInsights: string;
}

// Idea types
export type IdeaComplexity = 'small' | 'medium' | 'large';

export interface ProjectIdea {
  id: string;
  title: string;
  problemStatement: string;
  proposedSolution: string;
  implementationSteps: string[];
  complexity: IdeaComplexity;
  techStack: string[];
  isDerivative: boolean;
  sourceRepo?: string; // If derivative, which repo it's based on
  relevanceScore: number; // 0-100
  sourceData: {
    tweetIds: string[];
    githubRepos: string[];
  };
}

export interface IdeaGenerationResult {
  ideas: ProjectIdea[];
  generatedAt: Date;
  dataUsed: {
    tweetCount: number;
    githubActivityCount: number;
  };
}

// Approval types
export interface PendingIdea {
  id: string;
  idea: ProjectIdea;
  sentAt: Date;
  status: 'pending' | 'approved' | 'skipped';
}
