import { TwitterApi } from 'twitter-api-v2';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { Tweet } from '../types.js';
import type { TwitterDataSourceResult } from './types.js';

interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp
}

const TOKEN_FILE = join(process.cwd(), '.twitter-tokens.json');
const TOKEN_EXPIRY_BUFFER = 5 * 60 * 1000; // Refresh 5 minutes before expiry

export class TwitterDataSource {
  private client: TwitterApi;
  private userId: string | null = null;
  private clientId: string;
  private clientSecret: string;
  private tokenData: TokenData;

  constructor(
    accessToken: string,
    refreshToken: string,
    clientId: string,
    clientSecret: string
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;

    // Try to load cached tokens first
    const cached = this.loadCachedTokens();
    if (cached && cached.expiresAt > Date.now()) {
      this.tokenData = cached;
      console.log('Twitter: Using cached tokens (valid until', new Date(cached.expiresAt).toISOString(), ')');
    } else {
      // Use provided tokens, assume 2 hour expiry from now
      this.tokenData = {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + 2 * 60 * 60 * 1000,
      };
    }

    this.client = new TwitterApi(this.tokenData.accessToken);
  }

  private loadCachedTokens(): TokenData | null {
    try {
      if (existsSync(TOKEN_FILE)) {
        const data = readFileSync(TOKEN_FILE, 'utf-8');
        return JSON.parse(data) as TokenData;
      }
    } catch (error) {
      console.warn('Twitter: Failed to load cached tokens:', error);
    }
    return null;
  }

  private saveCachedTokens(): void {
    try {
      writeFileSync(TOKEN_FILE, JSON.stringify(this.tokenData, null, 2));
      console.log('Twitter: Saved refreshed tokens to cache');
    } catch (error) {
      console.error('Twitter: Failed to save tokens:', error);
    }
  }

  private async refreshTokenIfNeeded(): Promise<void> {
    const now = Date.now();
    const timeUntilExpiry = this.tokenData.expiresAt - now;

    if (timeUntilExpiry > TOKEN_EXPIRY_BUFFER) {
      // Token is still valid
      return;
    }

    console.log('Twitter: Access token expired or expiring soon, refreshing...');

    try {
      const refreshClient = new TwitterApi({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      });

      const { accessToken, refreshToken, expiresIn } = await refreshClient.refreshOAuth2Token(
        this.tokenData.refreshToken
      );

      // Update token data
      this.tokenData = {
        accessToken,
        refreshToken: refreshToken || this.tokenData.refreshToken,
        expiresAt: Date.now() + (expiresIn || 7200) * 1000,
      };

      // Update client
      this.client = new TwitterApi(accessToken);

      // Persist tokens
      this.saveCachedTokens();

      console.log('Twitter: Token refreshed successfully, valid until', new Date(this.tokenData.expiresAt).toISOString());
    } catch (error) {
      console.error('Twitter: Failed to refresh token:', error);
      throw new Error('Twitter token refresh failed. Please re-authenticate.');
    }
  }

  private async getUserId(): Promise<string> {
    if (this.userId) {
      return this.userId;
    }

    await this.refreshTokenIfNeeded();
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
      await this.refreshTokenIfNeeded();

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
    } catch (error: any) {
      // Check if it's a rate limit error
      if (error?.code === 429) {
        console.warn('Twitter: Rate limited on bookmarks, will retry next cycle');
        return [];
      }
      console.error('Error fetching Twitter bookmarks:', error);
      return [];
    }
  }

  async fetchLikes(since: Date): Promise<Tweet[]> {
    try {
      await this.refreshTokenIfNeeded();

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
    } catch (error: any) {
      // Check if it's a rate limit error
      if (error?.code === 429) {
        console.warn('Twitter: Rate limited on likes, will retry next cycle');
        return [];
      }
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

  // Get current token data (for persistence or debugging)
  getTokenData(): TokenData {
    return { ...this.tokenData };
  }
}
