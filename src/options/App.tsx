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
import { getDomain } from "../shared/utils";
import { createId } from "../shared/ids";

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

const BOOKMARK_SORT_OPTIONS: { value: BookmarkSortMode; label: string }[] = [
  { value: "recent", label: "最新收藏" },
  { value: "oldest", label: "最早收藏" },
  { value: "title", label: "标题 A-Z" }
];

const SEARCH_PROVIDER_OPTIONS: { value: SearchProvider; label: string }[] = [
  { value: "openai", label: "OpenAI Compatible" },
  { value: "openai-response", label: "OpenAI Responses" }
];

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function formatDate(timestamp: number) {
  return DATE_FORMATTER.format(new Date(timestamp));
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
    map.set(bookmark.url, {
      id: existing.id,
      url: existing.url,
      title: source.title,
      excerpt: source.excerpt,
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
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [categoryColor, setCategoryColor] = useState(COLOR_PALETTE[0].className);
  const [ruleDomain, setRuleDomain] = useState("");
  const [ruleCategoryId, setRuleCategoryId] = useState(DEFAULT_CATEGORY_ID);
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
  const statusTimerRef = useRef<number | null>(null);
  const deferredBookmarkQuery = useDeferredValue(bookmarkQuery);

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
        }
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

  const rulesWithCategory = useMemo(() => {
    if (!state) {
      return [] as (Rule & { category?: Category })[];
    }
    return state.rules.map((rule) => ({
      ...rule,
      category: state.categories.find((cat) => cat.id === rule.categoryId)
    }));
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
      return (
        title.toLowerCase().includes(term) ||
        url.toLowerCase().includes(term) ||
        excerpt.toLowerCase().includes(term)
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
        return a.title.localeCompare(b.title, "zh-Hans-CN");
      }
      if (bookmarkSortMode === "oldest") {
        return a.createdAt - b.createdAt;
      }
      return b.createdAt - a.createdAt;
    });
    return items;
  }, [filteredBookmarks, bookmarkSortMode]);

  const totalBookmarks = state?.bookmarks.length ?? 0;
  const pinnedCount = state?.bookmarks.filter((bookmark) => bookmark.pinned).length ?? 0;
  const visibleBookmarks = sortedBookmarks.length;
  const activeTheme = state?.theme ?? DEFAULT_THEME_ID;
  const compactMode = state?.ui.compactMode ?? false;
  const hasStoredAiKey = Boolean(state?.ai.apiKey);
  const hasStoredExaKey = Boolean(state?.exa.apiKey);
  const hasStoredEmbeddingKey = Boolean(state?.search.embedding.apiKey);
  const hasStoredRerankKey = Boolean(state?.search.rerank.apiKey);

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
    setCategoryDialogOpen(true);
  };

  const saveCategory = async () => {
    if (!categoryName.trim()) {
      setTransientStatus("请输入分类名称", "error");
      return;
    }
    const normalizedName = categoryName.trim();
    const hasDuplicate = state?.categories.some((category) => {
      if (editingCategory && category.id === editingCategory.id) {
        return false;
      }
      return category.name.trim().toLowerCase() === normalizedName.toLowerCase();
    });
    if (hasDuplicate) {
      setTransientStatus("分类名称已存在", "error");
      return;
    }
    await update((current) => {
      if (editingCategory) {
        return {
          ...current,
          categories: current.categories.map((category) =>
            category.id === editingCategory.id
              ? { ...category, name: normalizedName, color: categoryColor }
              : category
          )
        };
      }
      return {
        ...current,
        categories: [
          ...current.categories,
          {
            id: createId(),
            name: normalizedName,
            color: categoryColor,
            createdAt: Date.now()
          }
        ]
      };
    });
    setCategoryDialogOpen(false);
    setTransientStatus(editingCategory ? "已更新分类" : "已新增分类");
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
    setTransientStatus("已删除分类");
  };

  const saveRule = async () => {
    const domain = ruleDomain.trim().toLowerCase();
    if (!domain) {
      setTransientStatus("请输入规则域名", "error");
      return;
    }
    const hasDuplicate = state?.rules.some((rule) => rule.domain === domain);
    if (hasDuplicate) {
      setTransientStatus("该域名已存在规则", "error");
      return;
    }
    await update((current) => ({
      ...current,
      rules: [
        ...current.rules,
        {
          id: createId(),
          domain,
          categoryId: ruleCategoryId,
          createdAt: Date.now()
        }
      ]
    }));
    setRuleDomain("");
    setRuleDialogOpen(false);
    setTransientStatus("已新增规则");
  };

  const removeRule = async (ruleId: string) => {
    await update((current) => ({
      ...current,
      rules: current.rules.filter((rule) => rule.id !== ruleId)
    }));
    setTransientStatus("已删除规则");
  };

  const saveAiConfig = async () => {
    const baseUrl = aiDraft.baseUrl.trim();
    const model = aiDraft.model.trim();
    const baseUrlChanged = baseUrl !== (state?.ai.baseUrl ?? "");
    const apiKey = aiDraft.apiKey.trim() || (baseUrlChanged ? "" : state?.ai.apiKey ?? "");
    if (!baseUrl || !model) {
      setTransientStatus("请完整填写 AI 配置", "error");
      return;
    }
    if (!apiKey) {
      setTransientStatus(
        baseUrlChanged ? "Base URL 已修改，请重新填写 API Key" : "请填写 API Key",
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
    setTransientStatus("已保存 AI 配置");
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
      setTransientStatus("已切换主题色");
    },
    [state, update, setTransientStatus]
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
      setTransientStatus(enabled ? "已启用简洁模式" : "已关闭简洁模式");
    },
    [state, update, setTransientStatus]
  );

  const resetAiConfig = useCallback(() => {
    setAiDraft({
      type: DEFAULT_STATE.ai.type,
      baseUrl: DEFAULT_STATE.ai.baseUrl,
      apiKey: "",
      model: DEFAULT_STATE.ai.model
    });
    setTransientStatus("已恢复默认配置");
  }, [setTransientStatus]);

  const saveExaConfig = useCallback(async () => {
    const baseUrl = exaDraft.baseUrl.trim();
    const baseUrlChanged = baseUrl !== (state?.exa.baseUrl ?? "");
    const apiKey = exaDraft.apiKey.trim() || (baseUrlChanged ? "" : state?.exa.apiKey ?? "");
    if (exaDraft.enabled && !baseUrl) {
      setTransientStatus("请填写 Exa Base URL", "error");
      return;
    }
    if (exaDraft.enabled && !apiKey) {
      setTransientStatus(
        baseUrlChanged ? "Base URL 已修改，请重新填写 Exa API Key" : "请填写 Exa API Key",
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
    setTransientStatus("已保存 Exa 配置");
  }, [exaDraft, state, update, setTransientStatus]);

  const resetExaConfig = useCallback(() => {
    setExaDraft({
      enabled: DEFAULT_STATE.exa.enabled,
      baseUrl: DEFAULT_STATE.exa.baseUrl,
      apiKey: ""
    });
    setTransientStatus("已恢复 Exa 默认配置");
  }, [setTransientStatus]);

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
      setTransientStatus("请完整填写 Embedding 配置", "error");
      return;
    }
    if (!embeddingApiKey) {
      setTransientStatus(
        embeddingBaseUrlChanged
          ? "Embedding Base URL 已修改，请重新填写 API Key"
          : "请填写 Embedding API Key",
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
        setTransientStatus("请完整填写 Reranker 配置", "error");
        return;
      }
      if (!rerankApiKey) {
        setTransientStatus(
          rerankBaseUrlChanged
            ? "Reranker Base URL 已修改，请重新填写 API Key"
            : "请填写 Reranker API Key",
          "error"
        );
        return;
      }
    }

    await update((current) => ({
      ...current,
      search: {
        embedding: {
          provider: searchDraft.embedding.provider,
          baseUrl: embeddingBaseUrl,
          apiKey: embeddingApiKey,
          model: embeddingModel
        },
        rerank: {
          enabled: rerankEnabled,
          provider: searchDraft.rerank.provider,
          baseUrl: rerankBaseUrl || current.search.rerank.baseUrl,
          apiKey: rerankEnabled ? rerankApiKey : current.search.rerank.apiKey,
          model: rerankModel || current.search.rerank.model
        }
      }
    }));
    setTransientStatus("已保存搜索配置");
  }, [searchDraft, state, update, setTransientStatus]);

  const resetSearchConfig = useCallback(() => {
    setSearchDraft({
      embedding: {
        ...DEFAULT_STATE.search.embedding,
        apiKey: ""
      },
      rerank: {
        ...DEFAULT_STATE.search.rerank,
        apiKey: ""
      }
    });
    setTransientStatus("已恢复搜索默认配置");
  }, [setTransientStatus]);

  const handleExport = useCallback(() => {
    if (!state) {
      return;
    }
    const payload = JSON.stringify(state, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `autofav-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setTransientStatus("已导出备份");
  }, [state, setTransientStatus]);

  const handleImportFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as Partial<AppState>;
        const incoming = normalizeState(parsed);
        if (importMode === "replace") {
          await update(() => incoming);
        } else {
          await update((current) => mergeState(current, incoming));
        }
        setTransientStatus(importMode === "replace" ? "已覆盖导入" : "已合并导入");
      } catch (error) {
        const message = error instanceof Error ? error.message : "导入失败";
        setTransientStatus(message, "error");
      } finally {
        event.target.value = "";
      }
    },
    [importMode, update, setTransientStatus]
  );

  const openImportDialog = useCallback(() => {
    importInputRef.current?.click();
  }, []);

  const clearBookmarks = useCallback(() => {
    if (!state?.bookmarks.length) {
      setTransientStatus("暂无可清理的收藏", "error");
      return;
    }
    if (!window.confirm("确定要清空所有收藏吗？此操作不可撤销。")) {
      setTransientStatus("已取消清空收藏", "error");
      return;
    }
    void update((current) => ({
      ...current,
      bookmarks: []
    }));
    setTransientStatus("已清空收藏");
  }, [state, update, setTransientStatus]);

  const clearLogs = useCallback(() => {
    if (!state?.logs.length) {
      setTransientStatus("暂无可清理的日志", "error");
      return;
    }
    if (!window.confirm("确定要清空日志吗？")) {
      setTransientStatus("已取消清空日志", "error");
      return;
    }
    void update((current) => ({
      ...current,
      logs: []
    }));
    setTransientStatus("已清空日志");
  }, [state, update, setTransientStatus]);

  const togglePinned = useCallback(
    (id: string) => {
      const isPinned = state?.bookmarks.find((bookmark) => bookmark.id === id)?.pinned ?? false;
      void update((current) => ({
        ...current,
        bookmarks: current.bookmarks.map((bookmark) =>
          bookmark.id === id ? { ...bookmark, pinned: !bookmark.pinned } : bookmark
        )
      }));
      setTransientStatus(isPinned ? "已取消置顶" : "已置顶收藏");
    },
    [state, update, setTransientStatus]
  );

  const updateBookmarkCategory = useCallback(
    (id: string, categoryId: string) => {
      const targetId = categoryMap.has(categoryId) ? categoryId : DEFAULT_CATEGORY_ID;
      const categoryName = categoryMap.get(targetId)?.name ?? "未分类";
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
      setTransientStatus(`已移动到 ${categoryName}`);
    },
    [categoryMap, state, update, setTransientStatus]
  );

  const deleteBookmark = useCallback(
    (id: string) => {
      if (!window.confirm("确定要删除这条收藏吗？")) {
        return;
      }
      void update((current) => ({
        ...current,
        bookmarks: current.bookmarks.filter((bookmark) => bookmark.id !== id)
      }));
      setTransientStatus("已删除收藏");
    },
    [update, setTransientStatus]
  );

  const copyUrl = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        setTransientStatus("链接已复制");
      } catch (error) {
        const message = error instanceof Error ? error.message : "复制失败";
        setTransientStatus(message, "error");
      }
    },
    [setTransientStatus]
  );

  return (
    <div className="page-scroll px-6 py-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <header className="glass-card rounded-[32px] px-6 py-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <span className="chip">Setup</span>
              <h1 className="mt-3 text-2xl font-semibold text-slate-900">AutoFav 设置中心</h1>
              <p className="mt-2 text-sm text-slate-600">
                配置分类、规则和 AI 供应商，让收藏自动完成。
              </p>
            </div>
            <div className="rounded-2xl border border-white/60 bg-white/70 px-4 py-3 text-xs text-slate-600">
              快捷键默认: Ctrl+Shift+Y
            </div>
          </div>
        </header>

        <section className="glass-card rounded-[28px] px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">主题色</h2>
              <p className="mt-1 text-sm text-slate-600">选择一个舒适的主色调。</p>
            </div>
            <div className="flex flex-wrap gap-3">
              {THEMES.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => setTheme(theme.id)}
                  className="flex flex-col items-center gap-1 rounded-2xl px-2 py-1 text-xs text-slate-600 transition hover:text-slate-900"
                  aria-pressed={activeTheme === theme.id}
                  aria-label={`切换主题色：${theme.label}`}
                >
                  <span
                    className={clsx(
                      "theme-swatch",
                      activeTheme === theme.id && "is-active"
                    )}
                    data-theme={theme.id}
                  />
                  <span>{theme.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/60 bg-white/80 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-slate-800">简洁模式</div>
              <div className="mt-1 text-xs text-slate-500">
                弹窗列表仅展示标题，悬浮后显示操作按钮。
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
              启用
            </label>
          </div>
        </section>

        <Tabs.Root defaultValue="categories" className="glass-card rounded-[32px] px-6 py-6">
          <Tabs.List className="flex flex-wrap gap-2">
            {[
              { value: "categories", label: "分类" },
              { value: "rules", label: "规则" },
              { value: "bookmarks", label: "收藏管理" },
              { value: "ai", label: "AI 配置" }
            ].map((tab) => (
              <Tabs.Trigger
                key={tab.value}
                value={tab.value}
                className={clsx(
                  "rounded-full px-4 py-2 text-sm font-semibold transition",
                  "data-[state=active]:gradient-button",
                  "data-[state=inactive]:outline-button"
                )}
              >
                {tab.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <Tabs.Content value="categories" className="mt-6 space-y-4">
            <SectionHeader
              title="分类管理"
              subtitle="先创建几个主题分类，AI 会在这里放置链接。"
            />
            {!state ? (
              <div className="rounded-2xl border border-white/70 bg-white/70 px-4 py-6 text-center text-sm text-slate-500">
                正在加载分类...
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  {sortedCategories.map((category) => (
                    <CategoryBadge key={category.id} category={category} />
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => openCategoryDialog()}
                  className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/80 px-4 py-2 text-sm font-semibold text-slate-700"
                >
                  <PlusIcon /> 新增分类
                </button>
                <div className="grid gap-3 sm:grid-cols-2">
                  {sortedCategories.map((category) => (
                    <div
                      key={category.id}
                      className="rounded-2xl border border-white/60 bg-white/80 px-4 py-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className={clsx("h-2.5 w-2.5 rounded-full", category.color)} />
                          <span className="text-sm font-semibold text-slate-800">
                            {category.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => openCategoryDialog(category)}
                            className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-600"
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => removeCategory(category.id)}
                            disabled={category.id === DEFAULT_CATEGORY_ID}
                            className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-500 disabled:opacity-50"
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

            )}
          </Tabs.Content>

          <Tabs.Content value="rules" className="mt-6 space-y-4">
            <SectionHeader
              title="规则管理"
              subtitle="为常见域名建立固定归属，例如 linux.do 自动归类。"
            />
            {!state ? (
              <div className="rounded-2xl border border-white/70 bg-white/70 px-4 py-6 text-center text-sm text-slate-500">
                正在加载规则...
              </div>
            ) : (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => setRuleDialogOpen(true)}
                  className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/80 px-4 py-2 text-sm font-semibold text-slate-700"
                >
                  <PlusIcon /> 新增规则
                </button>
                <div className="grid gap-3">
                  {rulesWithCategory.length === 0 ? (
                    <div className="rounded-2xl border border-white/60 bg-white/80 px-4 py-4 text-sm text-slate-500">
                      暂无规则，添加后可跳过 AI 自动放入对应分类。
                    </div>
                  ) : (
                    rulesWithCategory.map((rule) => (
                      <div
                        key={rule.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/60 bg-white/80 px-4 py-3"
                      >
                        <div>
                          <div className="text-sm font-semibold text-slate-800">{rule.domain}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {rule.category?.name || "未分类"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeRule(rule.id)}
                          className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-500"
                        >
                          删除
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </Tabs.Content>

          <Tabs.Content value="bookmarks" className="mt-6 space-y-4">
            <SectionHeader
              title="收藏管理"
              subtitle="整理收藏、调整分类，并导出备份。"
            />
            {!state ? (
              <div className="rounded-2xl border border-white/70 bg-white/70 px-4 py-6 text-center text-sm text-slate-500">
                正在加载收藏...
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-2xl border border-white/60 bg-white/80 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
                    <span>总收藏 {totalBookmarks}</span>
                    <span>置顶 {pinnedCount}</span>
                    <span>显示 {visibleBookmarks}</span>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-white/60 bg-white/80 px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-slate-800">数据备份</div>
                        <p className="mt-1 text-xs text-slate-500">
                          导出 JSON 备份或导入恢复收藏数据。
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
                        <DownloadIcon /> 导出备份
                      </button>
                      <button
                        type="button"
                        onClick={openImportDialog}
                        className="outline-button inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
                      >
                        <UploadIcon /> 导入数据
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>导入方式</span>
                      <select
                        className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-600"
                        value={importMode}
                        onChange={(event) => setImportMode(event.target.value as ImportMode)}
                      >
                        <option value="merge">合并现有</option>
                        <option value="replace">覆盖现有</option>
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
                        <div className="text-sm font-semibold text-slate-800">清理操作</div>
                        <p className="mt-1 text-xs text-slate-500">
                          清空所有收藏或请求日志。
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
                        <TrashIcon /> 清空收藏
                      </button>
                      <button
                        type="button"
                        onClick={clearLogs}
                        className="inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/80 px-4 py-2 text-sm font-semibold text-slate-600"
                      >
                        <TrashIcon /> 清空日志
                      </button>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-white/60 bg-white/80 px-4 py-4">
                  <div className="flex flex-col gap-2 md:flex-row md:items-center">
                    <input
                      type="search"
                      className="input-field w-full md:flex-1"
                      placeholder="搜索标题、链接或摘要"
                      value={bookmarkQuery}
                      onChange={(event) => setBookmarkQuery(event.target.value)}
                      aria-label="搜索收藏"
                    />
                    <select
                      className="input-field w-full md:w-56"
                      value={bookmarkCategoryId}
                      onChange={(event) => setBookmarkCategoryId(event.target.value)}
                      aria-label="筛选分类"
                    >
                      <option value={CATEGORY_ALL}>全部分类</option>
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
                      aria-label="排序方式"
                    >
                      {BOOKMARK_SORT_OPTIONS.map((option) => (
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
                      暂无收藏，先在弹窗里添加一些链接。
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
                                {formatDate(bookmark.createdAt)}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className="icon-button"
                                onClick={() => togglePinned(bookmark.id)}
                                aria-label={bookmark.pinned ? "取消置顶" : "置顶"}
                                title={bookmark.pinned ? "取消置顶" : "置顶"}
                              >
                                {bookmark.pinned ? <StarFilledIcon /> : <StarIcon />}
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                onClick={() => void copyUrl(bookmark.url)}
                                aria-label="复制链接"
                                title="复制链接"
                              >
                                <ClipboardCopyIcon />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                onClick={() => deleteBookmark(bookmark.id)}
                                aria-label="删除收藏"
                                title="删除收藏"
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
                                未分类
                              </span>
                            )}
                            <div className="flex items-center gap-2">
                              <span>移动到</span>
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
              title="AI 服务配置"
              subtitle="配置 API 提供商、Base URL、模型以及密钥。"
            />
            {!state ? (
              <div className="rounded-2xl border border-white/70 bg-white/70 px-4 py-6 text-center text-sm text-slate-500">
                正在加载 AI 配置...
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2">
                    <FieldLabel label="API 类型" />
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
                                className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm text-slate-700 data-[highlighted]:bg-slate-100"
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
                    <FieldLabel label="模型" />
                    <input
                      className="input-field w-full"
                      value={aiDraft.model}
                      onChange={(event) => setAiField("model", event.target.value)}
                      placeholder="例如 gpt-4o-mini"
                    />
                  </label>
                </div>

                <label className="space-y-2">
                  <FieldLabel label="Base URL" />
                  <input
                    className="input-field w-full"
                    value={aiDraft.baseUrl}
                    onChange={(event) => setAiField("baseUrl", event.target.value)}
                    placeholder="https://api.openai.com/v1"
                    autoComplete="off"
                  />
                </label>

                <label className="space-y-2">
                  <FieldLabel label="API Key" />
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
                      aria-label={showAiKey ? "隐藏 API Key" : "显示 API Key"}
                    >
                      {showAiKey ? "隐藏" : "显示"}
                    </button>
                  </div>
                  {hasStoredAiKey && !aiDraft.apiKey.trim() ? (
                    <div className="text-xs text-slate-500">
                      留空则使用已保存的 Key（修改 Base URL 时需重新填写）。
                    </div>
                  ) : null}
                </label>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={saveAiConfig}
                    className="gradient-button rounded-full px-5 py-2 text-sm font-semibold"
                  >
                    保存配置
                  </button>
                  <button
                    type="button"
                    onClick={resetAiConfig}
                    className="outline-button rounded-full px-5 py-2 text-sm font-semibold"
                  >
                    恢复默认
                  </button>
                  <div className="text-xs text-slate-500">
                    提示：Anthropic 请填写官方 base URL 与模型名称。
                  </div>
                </div>

                <div className="rounded-2xl border border-white/70 bg-white/80 px-5 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-base font-semibold text-slate-900">
                        Exa 内容解析
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        使用 Exa /contents 直接获取正文，减少 HTML 解析与 token 消耗。
                      </p>
                    </div>
                    <span className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-500">
                      可选
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
                        启用 Exa 内容解析（失败则回退本地解析）
                      </label>
                      <button
                        type="button"
                        onClick={() => setExaExpanded((prev) => !prev)}
                        className="outline-button inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold"
                        aria-expanded={exaExpanded}
                        aria-controls="exa-config-panel"
                      >
                        {exaExpanded ? "收起配置" : "展开配置"}
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
                          <FieldLabel label="Exa Base URL" />
                          <input
                            className="input-field w-full"
                            value={exaDraft.baseUrl}
                            onChange={(event) => setExaField("baseUrl", event.target.value)}
                            placeholder="https://api.exa.ai"
                            autoComplete="off"
                          />
                        </label>
                        <label className="space-y-2">
                          <FieldLabel label="Exa API Key" />
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
                              aria-label={showExaKey ? "隐藏 Exa API Key" : "显示 Exa API Key"}
                            >
                              {showExaKey ? "隐藏" : "显示"}
                            </button>
                          </div>
                          {hasStoredExaKey && !exaDraft.apiKey.trim() ? (
                            <div className="text-xs text-slate-500">
                              留空则使用已保存的 Key（修改 Base URL 时需重新填写）。
                            </div>
                          ) : null}
                        </label>
                        <div className="flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            onClick={saveExaConfig}
                            className="gradient-button rounded-full px-5 py-2 text-sm font-semibold"
                          >
                            保存 Exa 配置
                          </button>
                          <button
                            type="button"
                            onClick={resetExaConfig}
                            className="outline-button rounded-full px-5 py-2 text-sm font-semibold"
                          >
                            恢复默认
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500">
                        配置信息已折叠，点击“展开配置”进行修改。
                      </div>
                    )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/70 bg-white/80 px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold text-slate-900">AI 搜索配置</div>
                    <p className="mt-1 text-xs text-slate-500">
                      Embedding 与 Reranker 可使用不同的供应商与密钥。
                    </p>
                  </div>
                  <span className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-500">
                    搜索页
                  </span>
                </div>

                <div className="mt-4 space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-2">
                      <FieldLabel label="Embedding Provider" />
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
                              {SEARCH_PROVIDER_OPTIONS.map((option) => (
                                <Select.Item
                                  key={option.value}
                                  value={option.value}
                                  className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm text-slate-700 data-[highlighted]:bg-slate-100"
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
                      <FieldLabel label="Embedding 模型" />
                      <input
                        className="input-field w-full"
                        value={searchDraft.embedding.model}
                        onChange={(event) =>
                          setSearchField("embedding", "model", event.target.value)
                        }
                        placeholder="例如 text-embedding-3-small"
                      />
                    </label>
                  </div>

                  <label className="space-y-2">
                    <FieldLabel label="Embedding Base URL" />
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
                    <FieldLabel label="Embedding API Key" />
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
                            ? "隐藏 Embedding API Key"
                            : "显示 Embedding API Key"
                        }
                      >
                        {showEmbeddingKey ? "隐藏" : "显示"}
                      </button>
                    </div>
                    {hasStoredEmbeddingKey && !searchDraft.embedding.apiKey.trim() ? (
                      <div className="text-xs text-slate-500">
                        留空则使用已保存的 Key（修改 Base URL 时需重新填写）。
                      </div>
                    ) : null}
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
                        启用 Reranker
                      </label>
                      <span className="text-xs text-slate-500">启用后用于二次排序</span>
                    </div>
                    <div className="mt-4 space-y-3">
                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="space-y-2">
                          <FieldLabel label="Reranker Provider" />
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
                                  {SEARCH_PROVIDER_OPTIONS.map((option) => (
                                    <Select.Item
                                      key={option.value}
                                      value={option.value}
                                      className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm text-slate-700 data-[highlighted]:bg-slate-100"
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
                          <FieldLabel label="Reranker 模型" />
                          <input
                            className="input-field w-full"
                            value={searchDraft.rerank.model}
                            onChange={(event) =>
                              setSearchField("rerank", "model", event.target.value)
                            }
                            placeholder="例如 rerank-lite"
                          />
                        </label>
                      </div>
                      <label className="space-y-2">
                        <FieldLabel label="Reranker Base URL" />
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
                        <FieldLabel label="Reranker API Key" />
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
                                ? "隐藏 Reranker API Key"
                                : "显示 Reranker API Key"
                            }
                          >
                            {showRerankKey ? "隐藏" : "显示"}
                          </button>
                        </div>
                        {hasStoredRerankKey && !searchDraft.rerank.apiKey.trim() ? (
                          <div className="text-xs text-slate-500">
                            留空则使用已保存的 Key（修改 Base URL 时需重新填写）。
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
                      保存搜索配置
                    </button>
                    <button
                      type="button"
                      onClick={resetSearchConfig}
                      className="outline-button rounded-full px-5 py-2 text-sm font-semibold"
                    >
                      恢复默认
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
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-6">
            <Dialog.Title className="text-lg font-semibold text-slate-900">
              {editingCategory ? "编辑分类" : "新增分类"}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-slate-600">
              命名分类并选择一个醒目的颜色。
            </Dialog.Description>
            <div className="mt-4 space-y-3">
              <label className="space-y-2">
                <FieldLabel label="分类名称" />
                <input
                  className="input-field w-full"
                  value={categoryName}
                  onChange={(event) => setCategoryName(event.target.value)}
                  placeholder="例如 科学技术"
                />
              </label>
              <div className="space-y-2">
                <FieldLabel label="分类颜色" />
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
                      aria-label={`选择颜色 ${color.id}`}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <Dialog.Close className="outline-button rounded-full px-4 py-2 text-sm font-semibold">
                取消
              </Dialog.Close>
              <button
                type="button"
                onClick={saveCategory}
                className="gradient-button rounded-full px-4 py-2 text-sm font-semibold"
              >
                保存
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={ruleDialogOpen} onOpenChange={setRuleDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/30" />
          <Dialog.Content className="fixed left-1/2 top-1/2 w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-6">
            <Dialog.Title className="text-lg font-semibold text-slate-900">新增规则</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-slate-600">
              输入域名并选择目标分类。
            </Dialog.Description>
            <div className="mt-4 space-y-3">
              <label className="space-y-2">
                <FieldLabel label="域名" />
                <input
                  className="input-field w-full"
                  value={ruleDomain}
                  onChange={(event) => setRuleDomain(event.target.value)}
                  placeholder="linux.do"
                />
              </label>
              <label className="space-y-2">
                <FieldLabel label="目标分类" />
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
                            className="flex cursor-pointer items-center justify-between rounded-xl px-3 py-2 text-sm text-slate-700 data-[highlighted]:bg-slate-100"
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
                取消
              </Dialog.Close>
              <button
                type="button"
                onClick={saveRule}
                className="gradient-button rounded-full px-4 py-2 text-sm font-semibold"
              >
                保存规则
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
