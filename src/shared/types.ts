import type { ThemeId } from "./theme";

export type ApiType = "openai" | "openai-response" | "anthropic";

export type AiConfig = {
  type: ApiType;
  baseUrl: string;
  apiKey: string;
  model: string;
  embeddingModel?: string;
  rerankModel?: string;
};

export type ExaConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
};

export type SearchProvider = "openai" | "openai-response";

export type SearchProviderConfig = {
  provider: SearchProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type SearchConfig = {
  embedding: SearchProviderConfig;
  rerank: SearchProviderConfig & { enabled: boolean };
};

export type Category = {
  id: string;
  name: string;
  color: string;
  createdAt: number;
};

export type Rule = {
  id: string;
  domain: string;
  categoryId: string;
  createdAt: number;
};

export type Bookmark = {
  id: string;
  url: string;
  title: string;
  excerpt: string;
  categoryId: string;
  pinned: boolean;
  createdAt: number;
};

export type LogEntry = {
  id: string;
  level: "info" | "error";
  message: string;
  context?: string;
  createdAt: number;
};

export type UiPreferences = {
  compactMode: boolean;
};

export type AppState = {
  categories: Category[];
  rules: Rule[];
  bookmarks: Bookmark[];
  logs: LogEntry[];
  ai: AiConfig;
  theme: ThemeId;
  exa: ExaConfig;
  ui: UiPreferences;
  search: SearchConfig;
};
