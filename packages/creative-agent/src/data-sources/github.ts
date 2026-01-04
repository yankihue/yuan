import type { GitHubActivity } from '../types.js';
import type { GitHubDataSourceResult } from './types.js';

interface GitHubEvent {
  id: string;
  type: string;
  repo: {
    id: number;
    name: string;
    url: string;
  };
  payload: Record<string, unknown>;
  created_at: string;
}

interface GitHubStarredRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  starred_at?: string;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  pushed_at: string;
}

export class GitHubDataSource {
  private token: string;
  private username: string;
  private ignoreRepos: Set<string>;
  private baseUrl = 'https://api.github.com';

  constructor(token: string, username: string, ignoreRepos: string[]) {
    this.token = token;
    this.username = username;
    this.ignoreRepos = new Set(ignoreRepos.map((r) => r.toLowerCase()));
  }

  private async request<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'yuan-creative-agent',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  private shouldIgnore(repoName: string): boolean {
    const name = repoName.toLowerCase();
    // Check if any ignore pattern matches
    for (const ignore of this.ignoreRepos) {
      if (name.includes(ignore) || name.endsWith(ignore)) {
        return true;
      }
    }
    return false;
  }

  private parseEvent(event: GitHubEvent): GitHubActivity | null {
    const repoName = event.repo.name.split('/').pop() || event.repo.name;

    if (this.shouldIgnore(repoName)) {
      return null;
    }

    const base = {
      repoName,
      repoFullName: event.repo.name,
      url: `https://github.com/${event.repo.name}`,
      createdAt: new Date(event.created_at),
    };

    switch (event.type) {
      case 'PushEvent': {
        const commits = (event.payload.commits as Array<{ message: string }>) || [];
        const messages = commits.map((c) => c.message).join('; ');
        return {
          ...base,
          type: 'push',
          description: `Pushed ${commits.length} commit(s)`,
          details: messages,
        };
      }
      case 'WatchEvent': // Star event
        return {
          ...base,
          type: 'star',
          description: `Starred repository`,
        };
      case 'IssuesEvent': {
        const action = event.payload.action as string;
        const issue = event.payload.issue as { title: string; number: number };
        return {
          ...base,
          type: 'issue',
          description: `${action} issue #${issue?.number}`,
          details: issue?.title,
        };
      }
      case 'PullRequestEvent': {
        const action = event.payload.action as string;
        const pr = event.payload.pull_request as { title: string; number: number };
        return {
          ...base,
          type: 'pr',
          description: `${action} PR #${pr?.number}`,
          details: pr?.title,
        };
      }
      default:
        return null;
    }
  }

  async fetchEvents(since: Date): Promise<GitHubActivity[]> {
    try {
      const events = await this.request<GitHubEvent[]>(`/users/${this.username}/events?per_page=100`);

      const activities: GitHubActivity[] = [];
      for (const event of events) {
        const createdAt = new Date(event.created_at);
        if (createdAt < since) {
          continue; // Events are ordered by date, so we can break early
        }

        const activity = this.parseEvent(event);
        if (activity) {
          activities.push(activity);
        }
      }

      return activities;
    } catch (error) {
      console.error('Error fetching GitHub events:', error);
      return [];
    }
  }

  async fetchStarred(since: Date): Promise<GitHubActivity[]> {
    try {
      // GitHub doesn't provide starred_at in the standard endpoint,
      // we use the starred endpoint with headers to get timestamps
      const response = await fetch(`${this.baseUrl}/user/starred?per_page=30&sort=created&direction=desc`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github.star+json', // Special header for timestamps
          'User-Agent': 'yuan-creative-agent',
        },
      });

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const starred = await response.json() as Array<{ starred_at: string; repo: GitHubStarredRepo }>;

      const activities: GitHubActivity[] = [];
      for (const item of starred) {
        const starredAt = new Date(item.starred_at);
        if (starredAt < since) {
          break; // Sorted by date, so we can stop
        }

        const repoName = item.repo.name;
        if (this.shouldIgnore(repoName)) {
          continue;
        }

        activities.push({
          type: 'star',
          repoName,
          repoFullName: item.repo.full_name,
          description: item.repo.description || 'No description',
          url: item.repo.html_url,
          createdAt: starredAt,
        });
      }

      return activities;
    } catch (error) {
      console.error('Error fetching GitHub starred repos:', error);
      return [];
    }
  }

  async fetchRecentlyPushed(since: Date): Promise<GitHubActivity[]> {
    try {
      const repos = await this.request<GitHubRepo[]>(`/user/repos?sort=pushed&direction=desc&per_page=20`);

      const activities: GitHubActivity[] = [];
      for (const repo of repos) {
        const pushedAt = new Date(repo.pushed_at);
        if (pushedAt < since) {
          continue;
        }

        if (this.shouldIgnore(repo.name)) {
          continue;
        }

        activities.push({
          type: 'push',
          repoName: repo.name,
          repoFullName: repo.full_name,
          description: repo.description || 'No description',
          url: repo.html_url,
          createdAt: pushedAt,
        });
      }

      return activities;
    } catch (error) {
      console.error('Error fetching recently pushed repos:', error);
      return [];
    }
  }

  async fetch(since: Date): Promise<GitHubDataSourceResult> {
    const [events, starred, recentlyPushed] = await Promise.all([
      this.fetchEvents(since),
      this.fetchStarred(since),
      this.fetchRecentlyPushed(since),
    ]);

    // Combine and deduplicate by repo + type + time (within same hour)
    const seen = new Set<string>();
    const activities: GitHubActivity[] = [];

    for (const activity of [...events, ...starred, ...recentlyPushed]) {
      const key = `${activity.repoFullName}-${activity.type}-${Math.floor(activity.createdAt.getTime() / 3600000)}`;
      if (!seen.has(key)) {
        seen.add(key);
        activities.push(activity);
      }
    }

    // Sort by date descending
    activities.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    console.log(`GitHub: Fetched ${activities.length} activities since ${since.toISOString()}`);

    return { activities };
  }
}
