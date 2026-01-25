import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import * as Tabs from "@radix-ui/react-tabs";
import {
  CheckIcon,
  ChevronDownIcon,
  ClipboardCopyIcon,
  DownloadIcon,
  PlusIcon,
  StarFilledIcon,
  StarIcon,
  TrashIcon,
  UploadIcon
} from "@radix-ui/react-icons";
import clsx from "clsx";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { COLOR_PALETTE } from "../shared/colors";
import { useAppState } from "../shared/hooks";
import { DEFAULT_CATEGORY_ID, DEFAULT_STATE, normalizeState } from "../shared/state";
import type { ThemeId } from "../shared/theme";
import { DEFAULT_THEME_ID, THEMES } from "../shared/theme";
import type {
  ApiType,
  AppState,
  Bookmark,
  Category,
  LogEntry,
  Rule,
  SearchProvider,
  SearchProviderConfig
} from "../shared/types";
import { buildEmbeddingFingerprint, getDomain } from "../shared/utils";
import { createId } from "../shared/ids";
import { getLanguageTag, useI18n } from "../shared/i18n";

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="text-sm text-slate-600">{subtitle}</p>
    </div>
  );
}

function FieldLabel({ label }: { label: string }) {
  return <div className="text-xs font-semibold text-slate-600">{label}</div>;
}

function CategoryBadge({ category }: { category: Category }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs font-semibold text-slate-700">
      <span className={clsx("h-2 w-2 rounded-full", category.color)} />
      {category.name}
    </span>
  );
}

const CATEGORY_ALL = "all";

type BookmarkSortMode = "recent" | "oldest" | "title";
type ImportMode = "merge" | "replace";
const BOOKMARK_EXPORT_TYPE = "favortex-bookmarks";

function formatDate(dateFormatter: Intl.DateTimeFormat, timestamp: number) {
  return dateFormatter.format(new Date(timestamp));
}

function mergeById<T extends { id: string }>(items: T[]) {
  const map = new Map<string, T>();
  items.forEach((item) => {
    if (!map.has(item.id)) {
      map.set(item.id, item);
    }
  });
  return Array.from(map.values());
}

function mergeBookmarks(current: Bookmark[], incoming: Bookmark[]) {
  const map = new Map<string, Bookmark>();
  current.forEach((bookmark) => map.set(bookmark.url, bookmark));
  incoming.forEach((bookmark) => {
    const existing = map.get(bookmark.url);
    if (!existing) {
      map.set(bookmark.url, bookmark);
      return;
    }
    const isIncomingNewer = bookmark.createdAt > existing.createdAt;
    const source = isIncomingNewer ? bookmark : existing;
    let embedding = existing.embedding;
    let embeddingFingerprint = existing.embeddingFingerprint;
    if (isIncomingNewer && Array.isArray(bookmark.embedding)) {
      embedding = bookmark.embedding;
      embeddingFingerprint = bookmark.embeddingFingerprint || undefined;
    }
    map.set(bookmark.url, {
      id: existing.id,
      url: existing.url,
      title: source.title,
      excerpt: source.excerpt,
      summaryLong: source.summaryLong || source.excerpt,
      embedding,
      embeddingFingerprint,
      favicon: source.favicon ?? existing.favicon,
      categoryId: source.categoryId,
      pinned: existing.pinned || bookmark.pinned,
      createdAt: Math.max(existing.createdAt, bookmark.createdAt)
    });
  });
  return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function mergeLogs(current: LogEntry[], incoming: LogEntry[]) {
  const map = new Map<string, LogEntry>();
  [...current, ...incoming].forEach((log) => {
    if (!map.has(log.id)) {
      map.set(log.id, log);
    }
  });
  return Array.from(map.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30);
}

function mergeState(current: AppState, incoming: AppState): AppState {
  const merged: AppState = {
    ...current,
    categories: mergeById([...current.categories, ...incoming.categories]),
    rules: mergeById([...current.rules, ...incoming.rules]),
    bookmarks: mergeBookmarks(current.bookmarks, incoming.bookmarks),
    logs: mergeLogs(current.logs, incoming.logs),
    ai: current.ai,
    search: current.search
  };
  return normalizeState(merged);
}

export default function App() {
  const { state, update } = useAppState();
  const { t, locale } = useI18n();
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryColor, setCategoryColor] = useState(COLOR_PALETTE[0].className);
  const [ruleType, setRuleType] = useState<Rule["type"]>("domain");
  const [ruleValue, setRuleValue] = useState("");
  const [aiDraft, setAiDraft] = useState(DEFAULT_STATE.ai);
  const [exaDraft, setExaDraft] = useState(DEFAULT_STATE.exa);
  const [searchDraft, setSearchDraft] = useState(DEFAULT_STATE.search);
  const [bookmarkQuery, setBookmarkQuery] = useState("");
  const [bookmarkSortMode, setBookmarkSortMode] = useState<BookmarkSortMode>("recent");
  const [bookmarkCategoryId, setBookmarkCategoryId] = useState(CATEGORY_ALL);
  const [importMode, setImportMode] = useState<ImportMode>("merge");
  const [dataStatus, setDataStatus] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<"success" | "error">("success");
  const [exaExpanded, setExaExpanded] = useState(false);
  const [showAiKey, setShowAiKey] = useState(false);
  const [showExaKey, setShowExaKey] = useState(false);
  const [showEmbeddingKey, setShowEmbeddingKey] = useState(false);
  const [showRerankKey, setShowRerankKey] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const aiImportInputRef = useRef<HTMLInputElement | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const deferredBookmarkQuery = useDeferredValue(bookmarkQuery);

  useEffect(() => {
    document.documentElement.lang = getLanguageTag(locale);
    document.title = t("Favortex 设置中心", "Favortex Settings");
  }, [locale, t]);

  useEffect(() => {
    if (state) {
      setAiDraft({
        type: state.ai.type,
        baseUrl: state.ai.baseUrl,
        apiKey: "",
        model: state.ai.model
      });
      setExaDraft({
        enabled: state.exa.enabled,
        baseUrl: state.exa.baseUrl,
        apiKey: ""
      });
      setExaExpanded(state.exa.enabled);
      setSearchDraft({
        embedding: {
          ...state.search.embedding,
          apiKey: ""
        },
        rerank: {
          ...state.search.rerank,
          apiKey: ""
        },
        minScore: state.search.minScore
      });
    }
  }, [state]);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) {
        window.clearTimeout(statusTimerRef.current);
      }
    };
  }, []);

  const sortedCategories = useMemo(() => {
    if (!state) {
      return [] as Category[];
    }
    return [...state.categories].sort((a, b) => a.createdAt - b.createdAt);
  }, [state]);

  const rulesByCategory = useMemo(() => {
    if (!state) {
      return new Map<string, Rule[]>();
    }
    const map = new Map<string, Rule[]>();
    state.categories.forEach((category) => map.set(category.id, []));
    state.rules.forEach((rule) => {
      const list = map.get(rule.categoryId) ?? [];
      list.push(rule);
      map.set(rule.categoryId, list);
    });
    return map;
  }, [state]);

  const categoryMap = useMemo(() => {
    if (!state) {
      return new Map<string, Category>();
    }
    return new Map(state.categories.map((category) => [category.id, category]));
  }, [state]);

  const filteredBookmarks = useMemo(() => {
    if (!state) {
      return [] as Bookmark[];
    }
    const term = deferredBookmarkQuery.trim().toLowerCase();
    const shouldFilter = term.length > 0;
    return state.bookmarks.filter((bookmark) => {
      const matchesCategory =
        bookmarkCategoryId === CATEGORY_ALL || bookmark.categoryId === bookmarkCategoryId;
      if (!matchesCategory) {
        return false;
      }
      if (!shouldFilter) {
        return true;
      }
      const title = bookmark.title || "";
      const url = bookmark.url || "";
      const excerpt = bookmark.excerpt || "";
      const summaryLong = bookmark.summaryLong || "";
      return (
        title.toLowerCase().includes(term) ||
        url.toLowerCase().includes(term) ||
        excerpt.toLowerCase().includes(term) ||
        summaryLong.toLowerCase().includes(term)
      );
    });
  }, [state, deferredBookmarkQuery, bookmarkCategoryId]);

  const sortedBookmarks = useMemo(() => {
    const items = [...filteredBookmarks];
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      if (bookmarkSortMode === "title") {
        return a.title.localeCompare(b.title, locale === "zh" ? "zh-Hans-CN" : "en");
      }
      if (bookmarkSortMode === "oldest") {
        return a.createdAt - b.createdAt;
      }
      return b.createdAt - a.createdAt;
    });
    return items;
  }, [filteredBookmarks, bookmarkSortMode, locale]);

  const totalBookmarks = state?.bookmarks.length ?? 0;
  const pinnedCount = state?.bookmarks.filter((bookmark) => bookmark.pinned).length ?? 0;
  const visibleBookmarks = sortedBookmarks.length;
  const activeTheme = state?.theme ?? DEFAULT_THEME_ID;
  const compactMode = state?.ui.compactMode ?? false;
  const colorMode = state?.ui.colorMode ?? "system";
  const hasStoredAiKey = Boolean(state?.ai.apiKey);
  const hasStoredExaKey = Boolean(state?.exa.apiKey);
  const hasStoredEmbeddingKey = Boolean(state?.search.embedding.apiKey);
  const hasStoredRerankKey = Boolean(state?.search.rerank.apiKey);
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "zh" ? "zh-Hans-CN" : "en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }),
    [locale]
  );

  const bookmarkSortOptions = useMemo(
    () => [
      { value: "recent" as const, label: t("最新收藏", "Newest") },
      { value: "oldest" as const, label: t("最早收藏", "Oldest") },
      { value: "title" as const, label: t("标题 A-Z", "Title A-Z") }
    ],
    [t]
  );

  const searchProviderOptions = useMemo(
    () => [
      { value: "openai" as const, label: t("OpenAI Compatible", "OpenAI Compatible") },
      { value: "openai-response" as const, label: t("OpenAI Responses", "OpenAI Responses") }
    ],
    [t]
  );

  const colorModeOptions = useMemo(
    () => [
      { value: "system" as const, label: t("跟随系统", "System") },
      { value: "light" as const, label: t("浅色", "Light") },
      { value: "dark" as const, label: t("深色", "Dark") }
    ],
    [t]
  );

  const openCategoryDialog = (category?: Category) => {
    if (category) {
      setEditingCategory(category);
      setCategoryName(category.name);
      setCategoryColor(category.color);
    } else {
      setEditingCategory(null);
      setCategoryName("");
      setCategoryColor(COLOR_PALETTE[0].className);
    }
    setRuleType("domain");
    setRuleValue("");
    setCategoryDialogOpen(true);
  };

  const saveCategory = async () => {
    if (!categoryName.trim()) {
      setTransientStatus(t("请输入分类名称", "Enter a category name."), "error");
      return;
    }
    const normalizedName = categoryName.trim();
    const nextCategoryId = createId();
    const nextCreatedAt = Date.now();
    const nextColor = categoryColor;
    const hasDuplicate = state?.categories.some((category) => {
      if (editingCategory && category.id === editingCategory.id) {
        return false;
      }
      return category.name.trim().toLowerCase() === normalizedName.toLowerCase();
    });
    if (hasDuplicate) {
      setTransientStatus(t("分类名称已存在", "Category name already exists."), "error");
      return;
    }
    await update((current) => {
      if (editingCategory) {
        return {
          ...current,
          categories: current.categories.map((category) =>
            category.id === editingCategory.id
              ? { ...category, name: normalizedName, color: nextColor }
              : category
          )
        };
      }
      const alreadyExists = current.categories.some((category) => {
        if (category.id === nextCategoryId) {
          return true;
        }
        return category.name.trim().toLowerCase() === normalizedName.toLowerCase();
      });
      if (alreadyExists) {
        return current;
      }
      return {
        ...current,
        categories: [
          ...current.categories,
          {
            id: nextCategoryId,
            name: normalizedName,
            color: nextColor,
            createdAt: nextCreatedAt
          }
        ]
      };
    });
    setCategoryDialogOpen(false);
    setTransientStatus(
      editingCategory ? t("已更新分类", "Category updated.") : t("已新增分类", "Category added.")
    );
  };

  const removeCategory = async (categoryId: string) => {
    if (categoryId === DEFAULT_CATEGORY_ID) {
      return;
    }
    await update((current) => {
      return {
        ...current,
        categories: current.categories.filter((category) => category.id !== categoryId),
        rules: current.rules.filter((rule) => rule.categoryId !== categoryId),
        bookmarks: current.bookmarks.map((bookmark) =>
          bookmark.categoryId === categoryId
            ? { ...bookmark, categoryId: DEFAULT_CATEGORY_ID }
            : bookmark
          )
      };
    });
    setTransientStatus(t("已删除分类", "Category deleted."));
  };

  const saveRule = async () => {
    if (!editingCategory) {
      setTransientStatus(
        t("请先保存分类再添加规则", "Save the category before adding rules."),
        "error"
      );
      return;
    }
    const rawValue = ruleValue.trim();
    if (!rawValue) {
      const message =
        ruleType === "natural"
          ? t("请输入自然语言规则", "Enter a natural language rule.")
          : ruleType === "urlPrefix"
            ? t("请输入 URL 前缀", "Enter a URL prefix.")
            : t("请输入规则域名", "Enter a rule domain.");
      setTransientStatus(message, "error");
      return;
    }
    const normalizedValue = ruleType === "domain" ? rawValue.toLowerCase() : rawValue;
    const targetCategoryId = editingCategory.id;
    const nextRuleId = createId();
    const nextCreatedAt = Date.now();
    const hasDuplicate = state?.rules.some((rule) => {
      if (rule.type !== ruleType) {
        return false;
      }
      if (rule.type === "natural" && rule.categoryId !== targetCategoryId) {
        return false;
      }
      const current =
        rule.type === "domain" ? rule.value.toLowerCase() : rule.value.trim().toLowerCase();
      const incoming =
        ruleType === "domain" ? normalizedValue : normalizedValue.trim().toLowerCase();
      return current === incoming;
    });
    if (hasDuplicate) {
      setTransientStatus(
        t("该规则已存在", "Rule already exists."),
        "error"
      );
      return;
    }
    await update((current) => ({
      ...current,
      rules: current.rules.some((rule) => rule.id === nextRuleId)
        ? current.rules
        : [
            ...current.rules,
            {
              id: nextRuleId,
              type: ruleType,
              value: normalizedValue,
              categoryId: categoryMap.has(targetCategoryId)
                ? targetCategoryId
                : DEFAULT_CATEGORY_ID,
              createdAt: nextCreatedAt
            }
          ]
    }));
    setRuleValue("");
    setTransientStatus(t("已新增规则", "Rule added."));
  };

  const removeRule = async (ruleId: string) => {
    await update((current) => ({
      ...current,
      rules: current.rules.filter((rule) => rule.id !== ruleId)
    }));
    setTransientStatus(t("已删除规则", "Rule deleted."));
  };

  const saveAiConfig = async () => {
    const baseUrl = aiDraft.baseUrl.trim();
    const model = aiDraft.model.trim();
    const baseUrlChanged = baseUrl !== (state?.ai.baseUrl ?? "");
    const apiKey = aiDraft.apiKey.trim() || (baseUrlChanged ? "" : state?.ai.apiKey ?? "");
    if (!baseUrl || !model) {
      setTransientStatus(t("请完整填写 AI 配置", "Complete the AI config."), "error");
      return;
    }
    if (!apiKey) {
      setTransientStatus(
        baseUrlChanged
          ? t("Base URL 已修改，请重新填写 API Key", "Base URL changed. Re-enter API key.")
          : t("请填写 API Key", "Enter the API key."),
        "error"
      );
      return;
    }
    await update((current) => ({
      ...current,
      ai: {
        type: aiDraft.type,
        baseUrl,
        apiKey,
        model
      }
    }));
    setTransientStatus(t("已保存 AI 配置", "AI settings saved."));
  };

  const setAiField = <T extends keyof typeof aiDraft>(field: T, value: (typeof aiDraft)[T]) => {
    setAiDraft((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const setExaField = <T extends keyof typeof exaDraft>(
    field: T,
    value: (typeof exaDraft)[T]
  ) => {
    setExaDraft((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const setSearchField = <T extends keyof SearchProviderConfig>(
    section: "embedding" | "rerank",
    field: T,
    value: SearchProviderConfig[T]
  ) => {
    setSearchDraft((prev) => ({
      ...prev,
      [section]: {
        ...prev[section],
        [field]: value
      }
    }));
  };

  const setRerankEnabled = (enabled: boolean) => {
    setSearchDraft((prev) => ({
      ...prev,
      rerank: {
        ...prev.rerank,
        enabled
      }
    }));
  };

  const setSearchMinScore = (value: number) => {
    if (Number.isNaN(value)) {
      return;
    }
    setSearchDraft((prev) => ({
      ...prev,
      minScore: Math.min(Math.max(value, 0), 1)
    }));
  };

  const setTransientStatus = useCallback(
    (message: string, tone: "success" | "error" = "success") => {
      setDataStatus(message);
      setStatusTone(tone);
      if (statusTimerRef.current !== null) {
        window.clearTimeout(statusTimerRef.current);
      }
      statusTimerRef.current = window.setTimeout(() => {
        setDataStatus(null);
        statusTimerRef.current = null;
      }, 2400);
    },
    []
  );

  const setTheme = useCallback(
    (themeId: ThemeId) => {
      if (!state) {
        return;
      }
      if (state.theme === themeId) {
        return;
      }
      void update((current) => ({
        ...current,
        theme: themeId
      }));
      setTransientStatus(t("已切换主题色", "Theme updated."));
    },
    [state, update, setTransientStatus, t]
  );

  const setColorMode = useCallback(
    (mode: AppState["ui"]["colorMode"]) => {
      if (!state) {
        return;
      }
      if (state.ui.colorMode === mode) {
        return;
      }
      void update((current) => ({
        ...current,
        ui: {
          ...current.ui,
          colorMode: mode
        }
      }));
      setTransientStatus(t("已切换显示模式", "Display mode updated."));
    },
    [state, update, setTransientStatus, t]
  );

  const setCompactMode = useCallback(
    (enabled: boolean) => {
      if (!state) {
        return;
      }
      if (state.ui.compactMode === enabled) {
        return;
      }
      void update((current) => ({
        ...current,
        ui: {
          ...current.ui,
          compactMode: enabled
        }
      }));
      setTransientStatus(
        enabled ? t("已启用简洁模式", "Compact mode enabled.") : t("已关闭简洁模式", "Compact mode off.")
      );
    },
    [state, update, setTransientStatus, t]
  );

  const resetAiConfig = useCallback(() => {
    setAiDraft({
      type: DEFAULT_STATE.ai.type,
      baseUrl: DEFAULT_STATE.ai.baseUrl,
      apiKey: "",
      model: DEFAULT_STATE.ai.model
    });
    setTransientStatus(t("已恢复默认配置", "Defaults restored."));
  }, [setTransientStatus, t]);

  const saveExaConfig = useCallback(async () => {
    const baseUrl = exaDraft.baseUrl.trim();
    const baseUrlChanged = baseUrl !== (state?.exa.baseUrl ?? "");
    const apiKey = exaDraft.apiKey.trim() || (baseUrlChanged ? "" : state?.exa.apiKey ?? "");
    if (exaDraft.enabled && !baseUrl) {
      setTransientStatus(t("请填写 Exa Base URL", "Enter the Exa base URL."), "error");
      return;
    }
    if (exaDraft.enabled && !apiKey) {
      setTransientStatus(
        baseUrlChanged
          ? t("Base URL 已修改，请重新填写 Exa API Key", "Base URL changed. Re-enter Exa API key.")
          : t("请填写 Exa API Key", "Enter the Exa API key."),
        "error"
      );
      return;
    }
    await update((current) => ({
      ...current,
      exa: {
        enabled: exaDraft.enabled,
        baseUrl,
        apiKey
      }
    }));
    setTransientStatus(t("已保存 Exa 配置", "Exa settings saved."));
  }, [exaDraft, state, update, setTransientStatus, t]);

  const resetExaConfig = useCallback(() => {
    setExaDraft({
      enabled: DEFAULT_STATE.exa.enabled,
      baseUrl: DEFAULT_STATE.exa.baseUrl,
      apiKey: ""
    });
    setTransientStatus(t("已恢复 Exa 默认配置", "Exa defaults restored."));
  }, [setTransientStatus, t]);

  const saveSearchConfig = useCallback(async () => {
    if (!state) {
      return;
    }
    const embeddingBaseUrl = searchDraft.embedding.baseUrl.trim();
    const embeddingModel = searchDraft.embedding.model.trim();
    const embeddingBaseUrlChanged =
      embeddingBaseUrl !== (state.search.embedding.baseUrl ?? "");
    const embeddingApiKey =
      searchDraft.embedding.apiKey.trim() ||
      (embeddingBaseUrlChanged ? "" : state.search.embedding.apiKey ?? "");

    if (!embeddingBaseUrl || !embeddingModel) {
      setTransientStatus(t("请完整填写 Embedding 配置", "Complete the embedding config."), "error");
      return;
    }
    if (!embeddingApiKey) {
      setTransientStatus(
        embeddingBaseUrlChanged
          ? t(
              "Embedding Base URL 已修改，请重新填写 API Key",
              "Embedding base URL changed. Re-enter API key."
            )
          : t("请填写 Embedding API Key", "Enter the embedding API key."),
        "error"
      );
      return;
    }

    const rerankEnabled = searchDraft.rerank.enabled;
    const rerankBaseUrl = searchDraft.rerank.baseUrl.trim();
    const rerankModel = searchDraft.rerank.model.trim();
    const rerankBaseUrlChanged = rerankBaseUrl !== (state.search.rerank.baseUrl ?? "");
    const rerankApiKey =
      searchDraft.rerank.apiKey.trim() ||
      (rerankBaseUrlChanged ? "" : state.search.rerank.apiKey ?? "");

    if (rerankEnabled) {
      if (!rerankBaseUrl || !rerankModel) {
        setTransientStatus(t("请完整填写 Reranker 配置", "Complete the reranker config."), "error");
        return;
      }
      if (!rerankApiKey) {
        setTransientStatus(
          rerankBaseUrlChanged
            ? t(
                "Reranker Base URL 已修改，请重新填写 API Key",
                "Reranker base URL changed. Re-enter API key."
              )
            : t("请填写 Reranker API Key", "Enter the reranker API key."),
          "error"
        );
        return;
      }
    }

    const nextEmbeddingConfig = {
      provider: searchDraft.embedding.provider,
      baseUrl: embeddingBaseUrl,
      apiKey: embeddingApiKey,
      model: embeddingModel
    };
    const embeddingChanged =
      buildEmbeddingFingerprint(nextEmbeddingConfig) !==
      buildEmbeddingFingerprint(state.search.embedding);

    await update((current) => ({
      ...current,
      bookmarks: embeddingChanged
        ? current.bookmarks.map((bookmark) => ({
            ...bookmark,
            embedding: undefined,
            embeddingFingerprint: undefined
          }))
        : current.bookmarks,
      search: {
        embedding: nextEmbeddingConfig,
        rerank: {
          enabled: rerankEnabled,
          provider: searchDraft.rerank.provider,
          baseUrl: rerankBaseUrl || current.search.rerank.baseUrl,
          apiKey: rerankEnabled ? rerankApiKey : current.search.rerank.apiKey,
          model: rerankModel || current.search.rerank.model
        },
        minScore: searchDraft.minScore
      }
    }));
    setTransientStatus(t("已保存搜索配置", "Search settings saved."));
  }, [searchDraft, state, update, setTransientStatus, t]);

  const resetSearchConfig = useCallback(() => {
    setSearchDraft({
      embedding: {
        ...DEFAULT_STATE.search.embedding,
        apiKey: ""
      },
      rerank: {
        ...DEFAULT_STATE.search.rerank,
        apiKey: ""
      },
      minScore: DEFAULT_STATE.search.minScore
    });
    setTransientStatus(t("已恢复搜索默认配置", "Search defaults restored."));
  }, [setTransientStatus, t]);

  const handleExport = useCallback(() => {
    if (!state) {
      return;
    }
    const payload = JSON.stringify(
      {
        type: BOOKMARK_EXPORT_TYPE,
        exportedAt: new Date().toISOString(),
        categories: state.categories,
        rules: state.rules,
        bookmarks: state.bookmarks
      },
      null,
      2
    );
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `favortex-bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setTransientStatus(t("已导出收藏备份", "Bookmarks exported."));
  }, [state, setTransientStatus, t]);

  const handleExportAiConfig = useCallback(() => {
    if (!state) {
      return;
    }
    const confirmed = window.confirm(
      t(
        "即将导出包含密钥的 AI 配置，请勿分享或上传到公开位置。确定继续？",
        "This export includes API keys. Do NOT share or upload it publicly. Continue?"
      )
    );
    if (!confirmed) {
      setTransientStatus(t("已取消导出", "Export cancelled."), "error");
      return;
    }
    const payload = JSON.stringify(
      {
        type: "favortex-ai-config",
        exportedAt: new Date().toISOString(),
        ai: state.ai,
        exa: state.exa,
        search: state.search
      },
      null,
      2
    );
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `favortex-ai-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setTransientStatus(t("已导出 AI 配置", "AI config exported."));
  }, [state, setTransientStatus, t]);

  const openAiImportDialog = useCallback(() => {
    if (
      !window.confirm(
        t(
          "即将导入包含密钥的 AI 配置，请确保文件来源可信。确定继续？",
          "You are about to import a file with API keys. Make sure it is trusted. Continue?"
        )
      )
    ) {
      setTransientStatus(t("已取消导入", "Import cancelled."), "error");
      return;
    }
    aiImportInputRef.current?.click();
  }, [setTransientStatus, t]);

  const handleImportAiConfig = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as Partial<AppState> & {
          type?: string;
          ai?: AppState["ai"];
          exa?: AppState["exa"];
          search?: AppState["search"];
        };
        const aiPayload = parsed.ai;
        const exaPayload = parsed.exa;
        const searchPayload = parsed.search;
        if (!aiPayload && !exaPayload && !searchPayload) {
          throw new Error(
            t("AI 配置文件内容无效", "Invalid AI config file.")
          );
        }
        await update((current) => {
          const mergedSearch = searchPayload
            ? {
                ...current.search,
                ...searchPayload,
                embedding: {
                  ...current.search.embedding,
                  ...(searchPayload.embedding ?? {})
                },
                rerank: {
                  ...current.search.rerank,
                  ...(searchPayload.rerank ?? {})
                }
              }
            : current.search;
          const merged = normalizeState({
            ...current,
            ai: aiPayload ? { ...current.ai, ...aiPayload } : current.ai,
            exa: exaPayload ? { ...current.exa, ...exaPayload } : current.exa,
            search: mergedSearch
          });
          return merged;
        });
        setTransientStatus(t("已导入 AI 配置", "AI config imported."));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t("导入失败", "Import failed.");
        setTransientStatus(message, "error");
      } finally {
        event.target.value = "";
      }
    },
    [setTransientStatus, t, update]
  );

  const handleImportFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as Partial<AppState> & {
          type?: string;
          data?: Partial<AppState>;
        };
        if (parsed.type && parsed.type !== BOOKMARK_EXPORT_TYPE) {
          if (parsed.type === "favortex-ai-config") {
            throw new Error(
              t("该文件为 AI 配置，请使用 AI 配置导入。", "This is an AI config file.")
            );
          }
          throw new Error(
            t("收藏备份文件类型不正确。", "Invalid bookmarks backup file.")
          );
        }
        const payload = parsed.type === BOOKMARK_EXPORT_TYPE ? parsed : parsed.data ?? parsed;
        const incoming = normalizeState({
          categories: payload.categories ?? [],
          rules: payload.rules ?? [],
          bookmarks: payload.bookmarks ?? [],
          logs: []
        });
        if (importMode === "replace") {
          await update((current) =>
            normalizeState({
              ...current,
              categories: incoming.categories,
              rules: incoming.rules,
              bookmarks: incoming.bookmarks
            })
          );
        } else {
          await update((current) => mergeState(current, incoming));
        }
        setTransientStatus(
          importMode === "replace"
            ? t("已覆盖导入收藏", "Bookmarks replaced.")
            : t("已合并导入收藏", "Bookmarks merged.")
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : t("导入失败", "Import failed.");
        setTransientStatus(message, "error");
      } finally {
        event.target.value = "";
      }
    },
    [importMode, update, setTransientStatus, t]
  );

  const openImportDialog = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const clearBookmarks = useCallback(() => {
    if (!state?.bookmarks.length) {
      setTransientStatus(t("暂无可清理的收藏", "No bookmarks to clear."), "error");
      return;
    }
    if (
      !window.confirm(
        t(
          "确定要清空所有收藏吗？此操作不可撤销。",
          "Clear all bookmarks? This action cannot be undone."
        )
      )
    ) {
      setTransientStatus(t("已取消清空收藏", "Clear cancelled."), "error");
      return;
    }
    void update((current) => ({
      ...current,
      bookmarks: []
    }));
    setTransientStatus(t("已清空收藏", "All bookmarks cleared."));
  }, [state, update, setTransientStatus, t]);

  const clearLogs = useCallback(() => {
    if (!state?.logs.length) {
      setTransientStatus(t("暂无可清理的日志", "No logs to clear."), "error");
      return;
    }
    if (!window.confirm(t("确定要清空日志吗？", "Clear all logs?"))) {
      setTransientStatus(t("已取消清空日志", "Clear cancelled."), "error");
      return;
    }
    void update((current) => ({
      ...current,
      logs: []
    }));
    setTransientStatus(t("已清空日志", "All logs cleared."));
  }, [state, update, setTransientStatus, t]);

  const togglePinned = useCallback(
    (id: string) => {
      const isPinned = state?.bookmarks.find((bookmark) => bookmark.id === id)?.pinned ?? false;
      void update((current) => ({
        ...current,
        bookmarks: current.bookmarks.map((bookmark) =>
          bookmark.id === id ? { ...bookmark, pinned: !bookmark.pinned } : bookmark
        )
      }));
      setTransientStatus(
        isPinned ? t("已取消置顶", "Unpinned.") : t("已置顶收藏", "Pinned.")
      );
    },
    [state, update, setTransientStatus, t]
  );

  const updateBookmarkCategory = useCallback(
    (id: string, categoryId: string) => {
      const targetId = categoryMap.has(categoryId) ? categoryId : DEFAULT_CATEGORY_ID;
      const categoryName = categoryMap.get(targetId)?.name ?? t("未分类", "Inbox");
      const currentCategory = state?.bookmarks.find((bookmark) => bookmark.id === id)?.categoryId;
      if (currentCategory === targetId) {
        return;
      }
      void update((current) => ({
        ...current,
        bookmarks: current.bookmarks.map((bookmark) =>
          bookmark.id === id ? { ...bookmark, categoryId: targetId } : bookmark
        )
      }));
      setTransientStatus(t("已移动到 {name}", "Moved to {name}.", { name: categoryName }));
    },
    [categoryMap, state, update, setTransientStatus, t]
  );

  const deleteBookmark = useCallback(
    (id: string) => {
      if (!window.confirm(t("确定要删除这条收藏吗？", "Delete this bookmark?"))) {
        return;
      }
      void update((current) => ({
        ...current,
        bookmarks: current.bookmarks.filter((bookmark) => bookmark.id !== id)
      }));
      setTransientStatus(t("已删除收藏", "Bookmark deleted."));
    },
    [update, setTransientStatus, t]
  );

  const copyUrl = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        setTransientStatus(t("链接已复制", "Link copied."));
      } catch (error) {
        const message = error instanceof Error ? error.message : t("复制失败", "Copy failed.");
        setTransientStatus(message, "error");
      }
    },
    [setTransientStatus, t]
  );

  const ruleTypeLabels = useMemo(
    () => ({
      domain: t("域名规则", "Domain rule"),
      urlPrefix: t("URL 前缀", "URL prefix"),
      natural: t("自然语言", "Natural language")
    }),
    [t]
  );

  const ruleTypeHints = useMemo(
    () => ({
      domain: t(
        "匹配域名及其子域名，命中后跳过 AI 分类。",
        "Matches domain and subdomains, bypasses AI classification."
      ),
      urlPrefix: t(
        "匹配 URL 前缀（可省略协议），命中后跳过 AI 分类。",
        "Matches URL prefixes (scheme optional), bypasses AI classification."
      ),
      natural: t(
        "用自然语言补充分类描述，仅用于 AI 分类提示。",
        "Describe the category in natural language to guide AI classification."
      )
    }),
    [t]
  );

  return (
    <div className="page-scroll px-6 py-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="glass-card rounded-[32px] px-6 py-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <span className="chip">{t("设置", "Setup")}</span>
              <h1 className="mt-3 text-2xl font-semibold text-slate-900">
                {t("Favortex 设置中心", "Favortex Settings")}
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                {t(
                  "配置分类、规则和 AI 供应商，让收藏自动完成。",
                  "Configure categories, rules, and AI providers to automate your saves."
                )}
              </p>
            </div>
            <div className="rounded-2xl border border-white/60 bg-white/70 px-4 py-3 text-xs text-slate-600">
              {t("快捷键默认: {shortcut}", "Default shortcut: {shortcut}", {
                shortcut: "Ctrl+Shift+Y"
              })}
            </div>
          </div>
        </header>

        <section className="glass-card rounded-[28px] px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                {t("主题色", "Theme")}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {t("选择一个舒适的主色调。", "Pick a comfortable primary tone.")}
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              {THEMES.map((theme) => {
                const themeLabel = locale === "zh" ? theme.label.zh : theme.label.en;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    onClick={() => setTheme(theme.id)}
                    className="flex flex-col items-center gap-1 rounded-2xl px-2 py-1 text-xs text-slate-600 transition hover:text-slate-900"
                    aria-pressed={activeTheme === theme.id}
                    aria-label={t("切换主题色：{name}", "Switch theme: {name}", {
                      name: themeLabel
                    })}
                  >
                    <span
                      className={clsx(
                        "theme-swatch",
                        activeTheme === theme.id && "is-active"
                      )}
                      data-theme={theme.id}
                    />
                    <span>{themeLabel}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/60 bg-white/80 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">
                  {t("简洁模式", "Compact mode")}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {t(
                    "弹窗列表仅展示标题，悬浮后显示操作按钮。",
                    "Only show titles in the popup. Actions appear on hover."
                  )}
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-slate-700"
                  checked={compactMode}
                  onChange={(event) => setCompactMode(event.target.checked)}
                  disabled={!state}
                />
                {t("启用", "Enable")}
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/60 bg-white/80 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">
                  {t("显示模式", "Display mode")}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {t("可跟随系统或手动指定深浅色。", "Follow system or choose light/dark.")}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {colorModeOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setColorMode(option.value)}
                    className={clsx(
                      "rounded-full px-4 py-2 text-xs font-semibold transition",
                      colorMode === option.value ? "gradient-button" : "outline-button"
                    )}
                    aria-pressed={colorMode === option.value}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <Tabs.Root defaultValue="categories" className="glass-card rounded-[32px] px-6 py-6">
          <Tabs.List className="flex flex-wrap gap-2">
            {[
              { value: "categories", label: t("分类", "Categories") },
              { value: "bookmarks", label: t("收藏管理", "Bookmarks") },
              { value: "ai", label: t("AI 配置", "AI Settings") }
            ].map((tab) => (
              <Tabs.Trigger
                key={tab.value}
                value={tab.value}
                className={clsx(
                  "tabs-trigger rounded-full px-4 py-2 text-sm font-semibold transition"
                )}
              >
                {tab.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <Tabs.Content value="categories" className="mt-6 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <SectionHeader
                title={t("分类管理", "Category management")}
                subtitle={t(
                  "先创建几个主题分类，再为分类补充规则或描述。",
                  "Create categories, then add rules or descriptions."
                )}
              />
              <button
                type="button"
                onClick={() => openCategoryDialog()}
                className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/80 px-4 py-2 text-sm font-semibold text-slate-700"
              >
                <PlusIcon /> {t("新增分类", "Add category")}
              </button>
            </div>
            <div className="rounded-2xl border border-white/60 bg-white/80 px-3 py-2 text-xs text-slate-500">
              {t(
                "域名与 URL 前缀规则会跳过 AI 分类；自然语言规则用于提示 AI。",
                "Domain/URL prefix rules bypass AI. Natural rules guide AI classification."
              )}
            </div>
            {!state ? (
              <div className="rounded-2xl border border-white/70 bg-white/70 px-4 py-6 text-center text-sm text-slate-500">
                {t("正在加载分类...", "Loading categories...")}
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {sortedCategories.map((category) => {
                  const rules = rulesByCategory.get(category.id) ?? [];
                  const domainRules = rules.filter((rule) => rule.type === "domain");
                  const prefixRules = rules.filter((rule) => rule.type === "urlPrefix");
                  const naturalRules = rules.filter((rule) => rule.type === "natural");
                  const summaryParts: string[] = [];
                  if (domainRules.length) {
                    summaryParts.push(
                      t("域名 {count}", "Domain {count}", { count: domainRules.length })
                    );
                  }
                  if (prefixRules.length) {
                    summaryParts.push(
                      t("前缀 {count}", "Prefix {count}", { count: prefixRules.length })
                    );
                  }
                  if (naturalRules.length) {
                    summaryParts.push(
                      t("自然 {count}", "Natural {count}", { count: naturalRules.length })
                    );
                  }
                  const summary =
                    summaryParts.length > 0
                      ? summaryParts.join(" · ")
                      : t("暂无规则", "No rules yet");
                  return (
                    <div
                      key={category.id}
                      className="rounded-3xl border border-white/60 bg-white/80 px-4 py-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className={clsx("h-2.5 w-2.5 rounded-full", category.color)} />
                            <span className="truncate text-sm font-semibold text-slate-800">
                              {category.name}
                            </span>
                          </div>
                          <div className="text-xs text-slate-500">{summary}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openCategoryDialog(category)}
                            className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-600"
                          >
                            {t("编辑", "Edit")}
                          </button>
                          <button
                            type="button"
                            onClick={() => removeCategory(category.id)}
                            disabled={category.id === DEFAULT_CATEGORY_ID}
                            className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-500 disabled:opacity-50"
                          >
                            {t("删除", "Delete")}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Tabs.Content>

          <Tabs.Content value="bookmarks" className="mt-6 space-y-4">
            <SectionHeader
              title={t("收藏管理", "Bookmark management")}
              subtitle={t("整理收藏、调整分类，并导出备份。", "Organize, reassign, and export.")}
            />
            {!state ? (
              <div className="rounded-2xl border border-white/70 bg-white/70 px-4 py-6 text-center text-sm text-slate-500">
                {t("正在加载收藏...", "Loading bookmarks...")}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-2xl border border-white/60 bg-white/80 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
                    <span>{t("总收藏 {count}", "Total {count}", { count: totalBookmarks })}</span>
                    <span>{t("置顶 {count}", "Pinned {count}", { count: pinnedCount })}</span>
                    <span>{t("显示 {count}", "Showing {count}", { count: visibleBookmarks })}</span>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-white/60 bg-white/80 px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-800">
                          {t("收藏备份", "Bookmarks backup")}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {t(
                            "导出或导入收藏、分类与规则（不包含 AI 配置）。",
                            "Export/import bookmarks, categories, and rules (no AI config)."
                          )}
                        </p>
                      </div>
                      <DownloadIcon className="text-slate-400" />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={handleExport}
                        className="gradient-button inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
                      >
                        <DownloadIcon /> {t("导出收藏", "Export bookmarks")}
                      </button>
                      <button
                        type="button"
                        onClick={openImportDialog}
                        className="outline-button inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
                      >
                        <UploadIcon /> {t("导入收藏", "Import bookmarks")}
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>{t("导入方式", "Import mode")}</span>
                      <select
                        className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-600"
                        value={importMode}
                        onChange={(event) => setImportMode(event.target.value as ImportMode)}
                      >
                        <option value="merge">{t("合并现有", "Merge")}</option>
                        <option value="replace">{t("覆盖现有", "Replace")}</option>
                      </select>
                    </div>
                    <input
                      ref={importInputRef}
                      type="file"
                      accept="application/json"
                      className="hidden"
                      onChange={handleImportFile}
                    />
                  </div>

                  <div className="rounded-2xl border border-white/60 bg-white/80 px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-800">
                          {t("清理操作", "Cleanup")}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {t("清空所有收藏或请求日志。", "Clear bookmarks or request logs.")}
                        </p>
                      </div>
                      <TrashIcon className="text-slate-400" />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={clearBookmarks}
                        className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-white/80 px-4 py-2 text-sm font-semibold text-red-600"
                      >
                        <TrashIcon /> {t("清空收藏", "Clear bookmarks")}
                      </button>
                      <button
                        type="button"
                        onClick={clearLogs}
                        className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/80 px-4 py-2 text-sm font-semibold text-slate-600"
                      >
                        <TrashIcon /> {t("清空日志", "Clear logs")}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/60 bg-white/80 px-4 py-4">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center">
                    <input
                      type="search"
                      className="input-field w-full md:flex-1"
                      placeholder={t("搜索标题、链接或摘要", "Search title, URL, or summary")}
                      value={bookmarkQuery}
                      onChange={(event) => setBookmarkQuery(event.target.value)}
                      aria-label={t("搜索收藏", "Search bookmarks")}
                    />
                    <select
                      className="input-field w-full md:w-56"
                      value={bookmarkCategoryId}
                      onChange={(event) => setBookmarkCategoryId(event.target.value)}
                      aria-label={t("筛选分类", "Filter category")}
                    >
                      <option value={CATEGORY_ALL}>{t("全部分类", "All categories")}</option>
                      {sortedCategories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                    <select
                      className="input-field w-full md:w-48"
                      value={bookmarkSortMode}
                      onChange={(event) =>
                        setBookmarkSortMode(event.target.value as BookmarkSortMode)
                      }
                      aria-label={t("排序方式", "Sort order")}
                    >
                      {bookmarkSortOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid gap-3">
                  {sortedBookmarks.length === 0 ? (
                    <div className="rounded-2xl border border-white/60 bg-white/80 px-4 py-4 text-sm text-slate-500">
                      {t("暂无收藏，先在弹窗里添加一些链接。", "No bookmarks yet. Add some from the popup.")}
                    </div>
                  ) : (
                    sortedBookmarks.map((bookmark) => {
                      const category = categoryMap.get(bookmark.categoryId);
                      return (
                        <div
                          key={bookmark.id}
                          className="rounded-2xl border border-white/60 bg-white/80 px-4 py-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <a
                                href={bookmark.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm font-semibold text-slate-800 line-clamp-2 hover:text-slate-900"
                              >
                                {bookmark.title || bookmark.url}
                              </a>
                              <div className="mt-1 text-xs text-slate-500">
                                {getDomain(bookmark.url) || bookmark.url} ·{" "}
                                {formatDate(dateFormatter, bookmark.createdAt)}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className="icon-button"
                                onClick={() => togglePinned(bookmark.id)}
                                aria-label={bookmark.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}
                                title={bookmark.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}
                              >
                                {bookmark.pinned ? <StarFilledIcon /> : <StarIcon />}
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                onClick={() => void copyUrl(bookmark.url)}
                                aria-label={t("复制链接", "Copy link")}
                                title={t("复制链接", "Copy link")}
                              >
                                <ClipboardCopyIcon />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                onClick={() => deleteBookmark(bookmark.id)}
                                aria-label={t("删除收藏", "Delete bookmark")}
                                title={t("删除收藏", "Delete bookmark")}
                              >
                                <TrashIcon />
                              </button>
                            </div>
                          </div>
                          {bookmark.excerpt ? (
                            <p className="mt-2 text-xs text-slate-600 line-clamp-2">
                              {bookmark.excerpt}
                            </p>
                          ) : null}
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            {category ? (
                              <CategoryBadge category={category} />
                            ) : (
                              <span className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-600">
                                {t("未分类", "Inbox")}
                              </span>
                            )}
                            <div className="flex items-center gap-2">
                              <span>{t("移动到", "Move to")}</span>
                              <select
                                className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-600"
                                value={bookmark.categoryId}
                                onChange={(event) =>
                                  updateBookmarkCategory(bookmark.id, event.target.value)
                                }
                              >
                                {sortedCategories.map((categoryOption) => (
                                  <option key={categoryOption.id} value={categoryOption.id}>
                                    {categoryOption.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </Tabs.Content>

          <Tabs.Content value="ai" className="mt-6 space-y-4">
            <SectionHeader
              title={t("AI 服务配置", "AI service settings")}
              subtitle={t(
                "配置 API 提供商、Base URL、模型以及密钥。",
                "Configure API type, base URL, model, and key."
              )}
            />
            {!state ? (
              <div className="rounded-2xl border border-white/70 bg-white/70 px-4 py-6 text-center text-sm text-slate-500">
                {t("正在加载 AI 配置...", "Loading AI settings...")}
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2">
                    <FieldLabel label={t("API 类型", "API type")} />
                    <Select.Root
                      value={aiDraft.type}
                      onValueChange={(value) => setAiField("type", value as ApiType)}
                    >
                      <Select.Trigger className="input-field inline-flex w-full items-center justify-between">
                        <Select.Value />
                        <Select.Icon>
                          <ChevronDownIcon />
                        </Select.Icon>
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content className="overflow-hidden rounded-2xl border border-white/70 bg-white">
                          <Select.Viewport className="p-2">
                            {[
                              { value: "openai", label: "OpenAI Chat" },
                              { value: "openai-response", label: "OpenAI Responses" },
                              { value: "anthropic", label: "Anthropic" }
                            ].map((option) => (
                              <Select.Item
                                key={option.value}
                                value={option.value}
                                className="select-item flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm text-slate-700"
                              >
                                <Select.ItemText>{option.label}</Select.ItemText>
                                <Select.ItemIndicator>
                                  <CheckIcon />
                                </Select.ItemIndicator>
                              </Select.Item>
                            ))}
                          </Select.Viewport>
                        </Select.Content>
                      </Select.Portal>
                    </Select.Root>
                  </label>

                  <label className="space-y-2">
                    <FieldLabel label={t("模型", "Model")} />
                    <input
                      className="input-field w-full"
                      value={aiDraft.model}
                      onChange={(event) => setAiField("model", event.target.value)}
                      placeholder={t("例如 gpt-4o-mini", "e.g. gpt-4o-mini")}
                    />
                  </label>
                </div>

                <label className="space-y-2">
                  <FieldLabel label={t("Base URL", "Base URL")} />
                  <input
                    className="input-field w-full"
                    value={aiDraft.baseUrl}
                    onChange={(event) => setAiField("baseUrl", event.target.value)}
                    placeholder="https://api.openai.com/v1"
                    autoComplete="off"
                  />
                </label>

                <label className="space-y-2">
                  <FieldLabel label={t("API Key", "API key")} />
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type={showAiKey ? "text" : "password"}
                      className="input-field w-full flex-1"
                      value={aiDraft.apiKey}
                      onChange={(event) => setAiField("apiKey", event.target.value)}
                      placeholder="sk-..."
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAiKey((prev) => !prev)}
                      className="outline-button rounded-full px-4 py-2 text-xs font-semibold"
                      aria-pressed={showAiKey}
                      aria-label={
                        showAiKey
                          ? t("隐藏 API Key", "Hide API key")
                          : t("显示 API Key", "Show API key")
                      }
                    >
                      {showAiKey ? t("隐藏", "Hide") : t("显示", "Show")}
                    </button>
                  </div>
                  {hasStoredAiKey && !aiDraft.apiKey.trim() ? (
                    <div className="text-xs text-slate-500">
                      {t(
                        "留空则使用已保存的 Key（修改 Base URL 时需重新填写）。",
                        "Leave blank to keep the saved key (re-enter if base URL changes)."
                      )}
                    </div>
                  ) : null}
                </label>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={saveAiConfig}
                    className="gradient-button rounded-full px-5 py-2 text-sm font-semibold"
                  >
                    {t("保存配置", "Save")}
                  </button>
                  <button
                    type="button"
                    onClick={resetAiConfig}
                    className="outline-button rounded-full px-5 py-2 text-sm font-semibold"
                  >
                    {t("恢复默认", "Restore defaults")}
                  </button>
                  <button
                    type="button"
                    onClick={handleExportAiConfig}
                    className="outline-button rounded-full px-5 py-2 text-sm font-semibold"
                  >
                    {t("导出 AI 配置", "Export AI config")}
                  </button>
                  <button
                    type="button"
                    onClick={openAiImportDialog}
                    className="outline-button rounded-full px-5 py-2 text-sm font-semibold"
                  >
                    {t("导入 AI 配置", "Import AI config")}
                  </button>
                </div>
                <div className="text-xs text-slate-500">
                  {t(
                    "导出包含密钥，请勿分享或上传到公开位置。",
                    "Exports include API keys. Do not share or upload publicly."
                  )}
                </div>
                <div className="text-xs text-slate-500">
                  {t(
                    "AI 配置导入导出与收藏备份分开管理。",
                    "AI config import/export is separate from bookmarks backup."
                  )}
                </div>
                <input
                  ref={aiImportInputRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={handleImportAiConfig}
                />
                <div className="text-xs text-slate-500">
                  {t(
                    "提示：Anthropic 请填写官方 base URL 与模型名称。",
                    "Note: Anthropic requires the official base URL and model name."
                  )}
                </div>

                <div className="rounded-2xl border border-white/70 bg-white/80 px-5 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-base font-semibold text-slate-900">
                        {t("Exa 内容解析", "Exa content parsing")}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {t(
                          "使用 Exa /contents 直接获取正文，减少 HTML 解析与 token 消耗。",
                          "Use Exa /contents to fetch clean text and reduce tokens."
                        )}
                      </p>
                    </div>
                    <span className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-500">
                      {t("可选", "Optional")}
                    </span>
                  </div>
                  <div className="mt-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="flex items-center gap-3 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-slate-700"
                          checked={exaDraft.enabled}
                          onChange={(event) => {
                            const nextEnabled = event.target.checked;
                            setExaField("enabled", nextEnabled);
                            setExaExpanded(nextEnabled);
                          }}
                        />
                        {t(
                          "启用 Exa 内容解析（失败则回退本地解析）",
                          "Enable Exa parsing (fallback to local on failure)."
                        )}
                      </label>
                      <button
                        type="button"
                        onClick={() => setExaExpanded((prev) => !prev)}
                        className="outline-button inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold"
                        aria-expanded={exaExpanded}
                        aria-controls="exa-config-panel"
                      >
                        {exaExpanded ? t("收起配置", "Collapse") : t("展开配置", "Expand")}
                        <ChevronDownIcon
                          className={clsx(
                            "transition",
                            exaExpanded ? "rotate-180" : "rotate-0"
                          )}
                        />
                      </button>
                    </div>
                    {exaExpanded ? (
                      <div className="space-y-3">
                        <label className="space-y-2">
                          <FieldLabel label={t("Exa Base URL", "Exa base URL")} />
                          <input
                            className="input-field w-full"
                            value={exaDraft.baseUrl}
                            onChange={(event) => setExaField("baseUrl", event.target.value)}
                            placeholder="https://api.exa.ai"
                            autoComplete="off"
                          />
                        </label>
                        <label className="space-y-2">
                          <FieldLabel label={t("Exa API Key", "Exa API key")} />
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              type={showExaKey ? "text" : "password"}
                              className="input-field w-full flex-1"
                              value={exaDraft.apiKey}
                              onChange={(event) => setExaField("apiKey", event.target.value)}
                              placeholder="exa-..."
                              autoComplete="new-password"
                            />
                            <button
                              type="button"
                              onClick={() => setShowExaKey((prev) => !prev)}
                              className="outline-button rounded-full px-4 py-2 text-xs font-semibold"
                              aria-pressed={showExaKey}
                              aria-label={
                                showExaKey
                                  ? t("隐藏 Exa API Key", "Hide Exa API key")
                                  : t("显示 Exa API Key", "Show Exa API key")
                              }
                            >
                              {showExaKey ? t("隐藏", "Hide") : t("显示", "Show")}
                            </button>
                          </div>
                          {hasStoredExaKey && !exaDraft.apiKey.trim() ? (
                            <div className="text-xs text-slate-500">
                              {t(
                                "留空则使用已保存的 Key（修改 Base URL 时需重新填写）。",
                                "Leave blank to keep the saved key (re-enter if base URL changes)."
                              )}
                            </div>
                          ) : null}
                        </label>
                        <div className="flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            onClick={saveExaConfig}
                            className="gradient-button rounded-full px-5 py-2 text-sm font-semibold"
                          >
                            {t("保存 Exa 配置", "Save Exa")}
                          </button>
                          <button
                            type="button"
                            onClick={resetExaConfig}
                            className="outline-button rounded-full px-5 py-2 text-sm font-semibold"
                          >
                            {t("恢复默认", "Restore defaults")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500">
                        {t(
                          "配置信息已折叠，点击“展开配置”进行修改。",
                          "Settings are collapsed. Click expand to edit."
                        )}
                      </div>
                    )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/70 bg-white/80 px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold text-slate-900">
                      {t("AI 搜索配置", "AI search settings")}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {t(
                        "Embedding 与 Reranker 可使用不同的供应商与密钥。",
                        "Embedding and reranker can use different providers/keys."
                      )}
                    </p>
                  </div>
                  <span className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-500">
                    {t("搜索页", "Search")}
                  </span>
                </div>

                <div className="mt-4 space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-2">
                      <FieldLabel label={t("Embedding Provider", "Embedding provider")} />
                      <Select.Root
                        value={searchDraft.embedding.provider}
                        onValueChange={(value) =>
                          setSearchField("embedding", "provider", value as SearchProvider)
                        }
                      >
                        <Select.Trigger className="input-field inline-flex w-full items-center justify-between">
                          <Select.Value />
                          <Select.Icon>
                            <ChevronDownIcon />
                          </Select.Icon>
                        </Select.Trigger>
                        <Select.Portal>
                          <Select.Content className="overflow-hidden rounded-2xl border border-white/70 bg-white">
                            <Select.Viewport className="p-2">
                              {searchProviderOptions.map((option) => (
                                <Select.Item
                                  key={option.value}
                                  value={option.value}
                                  className="select-item flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm text-slate-700"
                                >
                                  <Select.ItemText>{option.label}</Select.ItemText>
                                  <Select.ItemIndicator>
                                    <CheckIcon />
                                  </Select.ItemIndicator>
                                </Select.Item>
                              ))}
                            </Select.Viewport>
                          </Select.Content>
                        </Select.Portal>
                      </Select.Root>
                    </label>
                    <label className="space-y-2">
                      <FieldLabel label={t("Embedding 模型", "Embedding model")} />
                      <input
                        className="input-field w-full"
                        value={searchDraft.embedding.model}
                        onChange={(event) =>
                          setSearchField("embedding", "model", event.target.value)
                        }
                        placeholder={t("例如 text-embedding-3-small", "e.g. text-embedding-3-small")}
                      />
                    </label>
                  </div>

                  <label className="space-y-2">
                    <FieldLabel label={t("Embedding Base URL", "Embedding base URL")} />
                    <input
                      className="input-field w-full"
                      value={searchDraft.embedding.baseUrl}
                      onChange={(event) =>
                        setSearchField("embedding", "baseUrl", event.target.value)
                      }
                      placeholder="https://api.openai.com/v1"
                      autoComplete="off"
                    />
                  </label>

                  <label className="space-y-2">
                    <FieldLabel label={t("Embedding API Key", "Embedding API key")} />
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type={showEmbeddingKey ? "text" : "password"}
                        className="input-field w-full flex-1"
                        value={searchDraft.embedding.apiKey}
                        onChange={(event) =>
                          setSearchField("embedding", "apiKey", event.target.value)
                        }
                        placeholder="sk-..."
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        onClick={() => setShowEmbeddingKey((prev) => !prev)}
                        className="outline-button rounded-full px-4 py-2 text-xs font-semibold"
                        aria-pressed={showEmbeddingKey}
                        aria-label={
                          showEmbeddingKey
                            ? t("隐藏 Embedding API Key", "Hide embedding API key")
                            : t("显示 Embedding API Key", "Show embedding API key")
                        }
                      >
                        {showEmbeddingKey ? t("隐藏", "Hide") : t("显示", "Show")}
                      </button>
                    </div>
                    {hasStoredEmbeddingKey && !searchDraft.embedding.apiKey.trim() ? (
                      <div className="text-xs text-slate-500">
                        {t(
                          "留空则使用已保存的 Key（修改 Base URL 时需重新填写）。",
                          "Leave blank to keep the saved key (re-enter if base URL changes)."
                        )}
                      </div>
                    ) : null}
                  </label>

                  <label className="space-y-2">
                    <FieldLabel label={t("AI 匹配下限", "AI match threshold")} />
                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={searchDraft.minScore}
                        onChange={(event) =>
                          setSearchMinScore(Number(event.target.value))
                        }
                        className="h-2 flex-1 cursor-pointer accent-slate-700"
                      />
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        className="input-field w-24"
                        value={searchDraft.minScore}
                        onChange={(event) =>
                          setSearchMinScore(Number(event.target.value))
                        }
                      />
                    </div>
                    <div className="text-xs text-slate-500">
                      {t(
                        "低于该相似度的结果会被过滤。",
                        "Results below this similarity are filtered out."
                      )}
                    </div>
                  </label>

                  <div className="rounded-2xl border border-white/70 bg-white/70 px-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-slate-700"
                          checked={searchDraft.rerank.enabled}
                          onChange={(event) => setRerankEnabled(event.target.checked)}
                        />
                        {t("启用 Reranker", "Enable reranker")}
                      </label>
                      <span className="text-xs text-slate-500">
                        {t("启用后用于二次排序", "Use for second-pass sorting")}
                      </span>
                    </div>
                    <div className="mt-4 space-y-3">
                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="space-y-2">
                          <FieldLabel label={t("Reranker Provider", "Reranker provider")} />
                          <Select.Root
                            value={searchDraft.rerank.provider}
                            onValueChange={(value) =>
                              setSearchField("rerank", "provider", value as SearchProvider)
                            }
                          >
                            <Select.Trigger className="input-field inline-flex w-full items-center justify-between">
                              <Select.Value />
                              <Select.Icon>
                                <ChevronDownIcon />
                              </Select.Icon>
                            </Select.Trigger>
                            <Select.Portal>
                              <Select.Content className="overflow-hidden rounded-2xl border border-white/70 bg-white">
                                <Select.Viewport className="p-2">
                                  {searchProviderOptions.map((option) => (
                                    <Select.Item
                                      key={option.value}
                                      value={option.value}
                                      className="select-item flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm text-slate-700"
                                    >
                                      <Select.ItemText>{option.label}</Select.ItemText>
                                      <Select.ItemIndicator>
                                        <CheckIcon />
                                      </Select.ItemIndicator>
                                    </Select.Item>
                                  ))}
                                </Select.Viewport>
                              </Select.Content>
                            </Select.Portal>
                          </Select.Root>
                        </label>
                        <label className="space-y-2">
                          <FieldLabel label={t("Reranker 模型", "Reranker model")} />
                          <input
                            className="input-field w-full"
                            value={searchDraft.rerank.model}
                            onChange={(event) =>
                              setSearchField("rerank", "model", event.target.value)
                            }
                            placeholder={t("例如 rerank-lite", "e.g. rerank-lite")}
                          />
                        </label>
                      </div>
                      <label className="space-y-2">
                        <FieldLabel label={t("Reranker Base URL", "Reranker base URL")} />
                        <input
                          className="input-field w-full"
                          value={searchDraft.rerank.baseUrl}
                          onChange={(event) =>
                            setSearchField("rerank", "baseUrl", event.target.value)
                          }
                          placeholder="https://api.your-reranker.com"
                          autoComplete="off"
                        />
                      </label>
                      <label className="space-y-2">
                        <FieldLabel label={t("Reranker API Key", "Reranker API key")} />
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type={showRerankKey ? "text" : "password"}
                            className="input-field w-full flex-1"
                            value={searchDraft.rerank.apiKey}
                            onChange={(event) =>
                              setSearchField("rerank", "apiKey", event.target.value)
                            }
                            placeholder="key-..."
                            autoComplete="new-password"
                          />
                          <button
                            type="button"
                            onClick={() => setShowRerankKey((prev) => !prev)}
                            className="outline-button rounded-full px-4 py-2 text-xs font-semibold"
                            aria-pressed={showRerankKey}
                            aria-label={
                              showRerankKey
                                ? t("隐藏 Reranker API Key", "Hide reranker API key")
                                : t("显示 Reranker API Key", "Show reranker API key")
                            }
                          >
                            {showRerankKey ? t("隐藏", "Hide") : t("显示", "Show")}
                          </button>
                        </div>
                        {hasStoredRerankKey && !searchDraft.rerank.apiKey.trim() ? (
                          <div className="text-xs text-slate-500">
                            {t(
                              "留空则使用已保存的 Key（修改 Base URL 时需重新填写）。",
                              "Leave blank to keep the saved key (re-enter if base URL changes)."
                            )}
                          </div>
                        ) : null}
                      </label>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={saveSearchConfig}
                      className="gradient-button rounded-full px-5 py-2 text-sm font-semibold"
                    >
                      {t("保存搜索配置", "Save search settings")}
                    </button>
                    <button
                      type="button"
                      onClick={resetSearchConfig}
                      className="outline-button rounded-full px-5 py-2 text-sm font-semibold"
                    >
                      {t("恢复默认", "Restore defaults")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </Tabs.Content>
        </Tabs.Root>
      </div>

      <Dialog.Root open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/30" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[90vw] max-w-md translate-center rounded-3xl bg-white p-6">
            <Dialog.Title className="text-lg font-semibold text-slate-900">
              {editingCategory ? t("编辑分类", "Edit category") : t("新增分类", "Add category")}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-slate-600">
              {t("命名分类并选择一个醒目的颜色。", "Name the category and pick a color.")}
            </Dialog.Description>
            <div className="mt-4 space-y-3">
              <label className="space-y-2">
                <FieldLabel label={t("分类名称", "Category name")} />
                <input
                  className="input-field w-full"
                  value={categoryName}
                  onChange={(event) => setCategoryName(event.target.value)}
                  placeholder={t("例如 科学技术", "e.g. Technology")}
                />
              </label>
              <div className="space-y-2">
                <FieldLabel label={t("分类颜色", "Category color")} />
                <div className="flex flex-wrap gap-2">
                  {COLOR_PALETTE.map((color) => (
                    <button
                      key={color.id}
                      type="button"
                      onClick={() => setCategoryColor(color.className)}
                      className={clsx(
                        "h-8 w-8 rounded-full border-2",
                        color.className,
                        categoryColor === color.className ? "border-slate-900" : "border-transparent"
                      )}
                      aria-label={t("选择颜色 {id}", "Select color {id}", { id: color.id })}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Dialog.Close className="outline-button rounded-full px-4 py-2 text-sm font-semibold">
                {t("取消", "Cancel")}
              </Dialog.Close>
              <button
                type="button"
                onClick={saveCategory}
                className="gradient-button rounded-full px-4 py-2 text-sm font-semibold"
              >
                {t("保存", "Save")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={ruleDialogOpen} onOpenChange={setRuleDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/30" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[90vw] max-w-md translate-center rounded-3xl bg-white p-6">
            <Dialog.Title className="text-lg font-semibold text-slate-900">
              {t("新增规则", "Add rule")}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-slate-600">
              {t(
                "为分类添加域名、URL 前缀或自然语言规则。",
                "Add a domain, URL prefix, or natural language rule."
              )}
            </Dialog.Description>
            <div className="mt-4 space-y-3">
              <label className="space-y-2">
                <FieldLabel label={t("规则类型", "Rule type")} />
                <Select.Root value={ruleType} onValueChange={(value) => setRuleType(value as Rule["type"])}>
                  <Select.Trigger className="input-field inline-flex w-full items-center justify-between">
                    <Select.Value />
                    <Select.Icon>
                      <ChevronDownIcon />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content className="overflow-hidden rounded-2xl border border-white/70 bg-white">
                      <Select.Viewport className="p-2">
                        {(["domain", "urlPrefix", "natural"] as const).map((value) => (
                          <Select.Item
                            key={value}
                            value={value}
                            className="select-item flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm text-slate-700"
                          >
                            <Select.ItemText>{ruleTypeLabels[value]}</Select.ItemText>
                            <Select.ItemIndicator>
                              <CheckIcon />
                            </Select.ItemIndicator>
                          </Select.Item>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </label>
              <label className="space-y-2">
                <FieldLabel
                  label={
                    ruleType === "natural"
                      ? t("自然语言描述", "Natural language")
                      : ruleType === "urlPrefix"
                        ? t("URL 前缀", "URL prefix")
                        : t("域名", "Domain")
                  }
                />
                {ruleType === "natural" ? (
                  <textarea
                    className="input-field w-full min-h-[96px]"
                    value={ruleValue}
                    onChange={(event) => setRuleValue(event.target.value)}
                    placeholder={t("例如：面向开发者的开源工具", "e.g. Open-source tools for developers")}
                  />
                ) : (
                  <input
                    className="input-field w-full"
                    value={ruleValue}
                    onChange={(event) => setRuleValue(event.target.value)}
                    placeholder={
                      ruleType === "urlPrefix"
                        ? "github.com/awesome"
                        : "linux.do"
                    }
                  />
                )}
                <p className="text-xs text-slate-500">{ruleTypeHints[ruleType]}</p>
              </label>
              <label className="space-y-2">
                <FieldLabel label={t("目标分类", "Target category")} />
                <Select.Root value={ruleCategoryId} onValueChange={setRuleCategoryId}>
                  <Select.Trigger className="input-field inline-flex w-full items-center justify-between">
                    <Select.Value />
                    <Select.Icon>
                      <ChevronDownIcon />
                    </Select.Icon>
                  </Select.Trigger>
                  <Select.Portal>
                    <Select.Content className="overflow-hidden rounded-2xl border border-white/70 bg-white">
                      <Select.Viewport className="p-2">
                        {sortedCategories.map((category) => (
                          <Select.Item
                            key={category.id}
                            value={category.id}
                            className="select-item flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm text-slate-700"
                          >
                            <Select.ItemText>{category.name}</Select.ItemText>
                            <Select.ItemIndicator>
                              <CheckIcon />
                            </Select.ItemIndicator>
                          </Select.Item>
                        ))}
                      </Select.Viewport>
                    </Select.Content>
                  </Select.Portal>
                </Select.Root>
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Dialog.Close className="outline-button rounded-full px-4 py-2 text-sm font-semibold">
                {t("取消", "Cancel")}
              </Dialog.Close>
              <button
                type="button"
                onClick={saveRule}
                className="gradient-button rounded-full px-4 py-2 text-sm font-semibold"
              >
                {t("保存规则", "Save rule")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {dataStatus ? (
        <div
          className={clsx(
            "toast",
            statusTone === "success" ? "toast-success" : "toast-error",
            "is-visible"
          )}
          role={statusTone === "success" ? "status" : "alert"}
          aria-live={statusTone === "success" ? "polite" : "assertive"}
          aria-atomic="true"
        >
          {dataStatus}
        </div>
      ) : null}
    </div>
  );
}
