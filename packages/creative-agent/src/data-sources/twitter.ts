import { TwitterApi } from 'twitter-api-v2';
import type { Tweet } from '../types.js';
import type { TwitterDataSourceResult } from './types.js';

export class TwitterDataSource {
  private client: TwitterApi;
  private userId: string | null = null;

  constructor(accessToken: string) {
    // Use OAuth 2.0 User Context token (not App-Only bearer token)
    this.client = new TwitterApi(accessToken);
  }

  private async getUserId(): Promise<string> {
    if (this.userId) {
      return this.userId;
    }

    const me = await this.client.v2.me();
    this.userId = me.data.id;
    return this.userId;
  }

  private parseTweet(tweet: {
    id: string;
    text: string;
    author_id?: string;
    created_at?: string;
    entities?: {
      urls?: Array<{ expanded_url: string }>;
    };
  }, users: Map<string, string>): Tweet {
    const authorId = tweet.author_id || '';
    const authorUsername = users.get(authorId) || 'unknown';

    return {
      id: tweet.id,
      text: tweet.text,
      authorUsername,
      createdAt: tweet.created_at ? new Date(tweet.created_at) : new Date(),
      urls: tweet.entities?.urls?.map((u) => u.expanded_url) || [],
    };
  }

  async fetchBookmarks(since: Date): Promise<Tweet[]> {
    try {
      const userId = await this.getUserId();
      const bookmarks = await this.client.v2.bookmarks({
        expansions: ['author_id', 'referenced_tweets.id'],
        'tweet.fields': ['created_at', 'entities', 'text'],
        'user.fields': ['username'],
        max_results: 100,
      });

      // Build user map
      const users = new Map<string, string>();
      if (bookmarks.includes?.users) {
        for (const user of bookmarks.includes.users) {
          users.set(user.id, user.username);
        }
      }

      // Filter by date and parse
      const tweets: Tweet[] = [];
      for (const tweet of bookmarks.data?.data || []) {
        const parsed = this.parseTweet(tweet, users);
        if (parsed.createdAt >= since) {
          tweets.push(parsed);
        }
      }

      return tweets;
    } catch (error) {
      console.error('Error fetching Twitter bookmarks:', error);
      return [];
    }
  }

  async fetchLikes(since: Date): Promise<Tweet[]> {
    try {
      const userId = await this.getUserId();
      const likes = await this.client.v2.userLikedTweets(userId, {
        expansions: ['author_id'],
        'tweet.fields': ['created_at', 'entities', 'text'],
        'user.fields': ['username'],
        max_results: 100,
      });

      // Build user map
      const users = new Map<string, string>();
      if (likes.includes?.users) {
        for (const user of likes.includes.users) {
          users.set(user.id, user.username);
        }
      }

      // Filter by date and parse
      const tweets: Tweet[] = [];
      for (const tweet of likes.data?.data || []) {
        const parsed = this.parseTweet(tweet, users);
        if (parsed.createdAt >= since) {
          tweets.push(parsed);
        }
      }

      return tweets;
    } catch (error) {
      console.error('Error fetching Twitter likes:', error);
      return [];
    }
  }

  async fetch(since: Date): Promise<TwitterDataSourceResult> {
    const [bookmarks, likes] = await Promise.all([
      this.fetchBookmarks(since),
      this.fetchLikes(since),
    ]);

    console.log(`Twitter: Fetched ${bookmarks.length} bookmarks, ${likes.length} likes since ${since.toISOString()}`);

    return { bookmarks, likes };
  }
}
