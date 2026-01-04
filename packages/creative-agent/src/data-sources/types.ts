import type { Tweet, GitHubActivity } from '../types.js';

export interface DataSource<T> {
  name: string;
  fetch(since: Date): Promise<T[]>;
}

export type TwitterDataSourceResult = {
  bookmarks: Tweet[];
  likes: Tweet[];
};

export type GitHubDataSourceResult = {
  activities: GitHubActivity[];
};
