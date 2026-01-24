import type { AppState, Category, ExaConfig, SearchConfig, SearchProvider } from "./types";
import { DEFAULT_THEME_ID, isThemeId } from "./theme";
import { translate } from "./i18n";

export const DEFAULT_CATEGORY_ID = "inbox";

const DEFAULT_CATEGORY: Category = {
  id: DEFAULT_CATEGORY_ID,
  name: translate("未分类", "Inbox"),
  color: "bg-teal-600",
  createdAt: Date.now()
};

export const DEFAULT_STATE: AppState = {
  categories: [DEFAULT_CATEGORY],
  rules: [],
  bookmarks: [],
  logs: [],
  theme: DEFAULT_THEME_ID,
  exa: {
    enabled: false,
    baseUrl: "https://api.exa.ai",
    apiKey: ""
  },
  ai: {
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini"
  },
  ui: {
    compactMode: false,
    colorMode: "system"
  },
  search: {
    embedding: {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: ""
    },
    rerank: {
      enabled: false,
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: ""
    },
    minScore: 0.2
  }
};

function uniqueById<T extends { id: string }>(items: T[]) {
  const map = new Map<string, T>();
  items.forEach((item) => {
    if (!map.has(item.id)) {
      map.set(item.id, item);
    }
  });
  return Array.from(map.values());
}

export function normalizeState(value?: Partial<AppState>): AppState {
  const categories = Array.isArray(value?.categories) ? value?.categories : [];
  const rules = Array.isArray(value?.rules) ? value?.rules : [];
  const bookmarks = Array.isArray(value?.bookmarks) ? value?.bookmarks : [];
  const logs = Array.isArray(value?.logs) ? value?.logs : [];
  const ai = {
    ...DEFAULT_STATE.ai,
    ...(value?.ai ?? {})
  };
  const rawExa: Partial<ExaConfig> =
    typeof value?.exa === "object" && value?.exa ? value.exa : {};
  const exa = {
    enabled:
      typeof rawExa.enabled === "boolean" ? rawExa.enabled : DEFAULT_STATE.exa.enabled,
    baseUrl:
      typeof rawExa.baseUrl === "string" ? rawExa.baseUrl : DEFAULT_STATE.exa.baseUrl,
    apiKey: typeof rawExa.apiKey === "string" ? rawExa.apiKey : DEFAULT_STATE.exa.apiKey
  };
  const rawTheme = typeof value?.theme === "string" ? value?.theme : DEFAULT_THEME_ID;
  const theme = isThemeId(rawTheme) ? rawTheme : DEFAULT_THEME_ID;
  const rawUi: Partial<AppState["ui"]> =
    typeof value?.ui === "object" && value?.ui ? value.ui : {};
  const ui = {
    compactMode:
      typeof rawUi.compactMode === "boolean"
        ? rawUi.compactMode
        : DEFAULT_STATE.ui.compactMode,
    colorMode:
      rawUi.colorMode === "light" || rawUi.colorMode === "dark" || rawUi.colorMode === "system"
        ? rawUi.colorMode
        : DEFAULT_STATE.ui.colorMode
  };
  const rawSearch: Partial<SearchConfig> =
    typeof value?.search === "object" && value?.search ? value.search : {};
  const rawEmbedding: Partial<SearchConfig["embedding"]> =
    typeof rawSearch.embedding === "object" && rawSearch.embedding
      ? rawSearch.embedding
      : {};
  const rawRerank: Partial<SearchConfig["rerank"]> =
    typeof rawSearch.rerank === "object" && rawSearch.rerank ? rawSearch.rerank : {};
  const rawMinScore = typeof rawSearch.minScore === "number" ? rawSearch.minScore : undefined;

  const embedding: SearchConfig["embedding"] = {
    provider: isSearchProvider(rawEmbedding.provider)
      ? rawEmbedding.provider
      : DEFAULT_STATE.search.embedding.provider,
    baseUrl:
      typeof rawEmbedding.baseUrl === "string"
        ? rawEmbedding.baseUrl
        : DEFAULT_STATE.search.embedding.baseUrl,
    apiKey:
      typeof rawEmbedding.apiKey === "string"
        ? rawEmbedding.apiKey
        : DEFAULT_STATE.search.embedding.apiKey,
    model:
      typeof rawEmbedding.model === "string"
        ? rawEmbedding.model
        : DEFAULT_STATE.search.embedding.model
  };

  const rerank: SearchConfig["rerank"] = {
    enabled:
      typeof rawRerank.enabled === "boolean"
        ? rawRerank.enabled
        : DEFAULT_STATE.search.rerank.enabled,
    provider: isSearchProvider(rawRerank.provider)
      ? rawRerank.provider
      : DEFAULT_STATE.search.rerank.provider,
    baseUrl:
      typeof rawRerank.baseUrl === "string"
        ? rawRerank.baseUrl
        : DEFAULT_STATE.search.rerank.baseUrl,
    apiKey:
      typeof rawRerank.apiKey === "string"
        ? rawRerank.apiKey
        : DEFAULT_STATE.search.rerank.apiKey,
    model:
      typeof rawRerank.model === "string"
        ? rawRerank.model
        : DEFAULT_STATE.search.rerank.model
  };

  const legacyEmbedding = typeof value?.ai?.embeddingModel === "string"
    ? value?.ai?.embeddingModel
    : "";
  const legacyRerank = typeof value?.ai?.rerankModel === "string"
    ? value?.ai?.rerankModel
    : "";

  if (!embedding.model && legacyEmbedding) {
    embedding.model = legacyEmbedding;
  }
  if (!rerank.model && legacyRerank) {
    rerank.model = legacyRerank;
  }

  const hasDefault = categories.some((category) => category.id === DEFAULT_CATEGORY_ID);
  const mergedCategories = uniqueById(
    hasDefault ? categories : [DEFAULT_CATEGORY, ...categories]
  );
  const categoryIds = new Set(mergedCategories.map((category) => category.id));
  const normalizedRules = rules.map((rule) => ({
    ...rule,
    categoryId: categoryIds.has(rule.categoryId) ? rule.categoryId : DEFAULT_CATEGORY_ID
  }));
  const normalizedBookmarks = bookmarks.map((bookmark) => {
    const excerpt = typeof bookmark.excerpt === "string" ? bookmark.excerpt : "";
    const summaryLongRaw = (bookmark as { summaryLong?: unknown }).summaryLong;
    const summaryLong = typeof summaryLongRaw === "string" ? summaryLongRaw : excerpt;
    const rawEmbedding = (bookmark as { embedding?: unknown }).embedding;
    const embedding =
      Array.isArray(rawEmbedding) && rawEmbedding.every((value) => typeof value === "number")
        ? rawEmbedding
        : undefined;
    const rawFingerprint = (bookmark as { embeddingFingerprint?: unknown }).embeddingFingerprint;
    const embeddingFingerprint =
      typeof rawFingerprint === "string" && rawFingerprint.trim()
        ? rawFingerprint
        : undefined;
    return {
      ...bookmark,
      excerpt,
      summaryLong,
      embedding,
      embeddingFingerprint,
      pinned: bookmark.pinned ?? false,
      categoryId: categoryIds.has(bookmark.categoryId) ? bookmark.categoryId : DEFAULT_CATEGORY_ID
    };
  });

  return {
    categories: mergedCategories,
    rules: normalizedRules,
    bookmarks: normalizedBookmarks,
    logs,
    ai,
    exa,
    theme,
    ui,
    search: {
      embedding,
      rerank,
      minScore:
        typeof rawMinScore === "number" && Number.isFinite(rawMinScore)
          ? Math.min(Math.max(rawMinScore, 0), 1)
          : DEFAULT_STATE.search.minScore
    }
  };
}

function isSearchProvider(value: unknown): value is SearchProvider {
  return value === "openai" || value === "openai-response";
}
