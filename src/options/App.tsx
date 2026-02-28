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
import { classifyWithAi, suggestSubCategoryWithAi } from "../shared/ai";
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
import {
  buildEmbeddingFingerprint,
  domainMatches,
  getDomain,
  urlPrefixMatches
} from "../shared/utils";
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
const SMART_AI_LIMIT = 60;
const SUBCATEGORY_AI_LIMIT = 40;
const HEALTH_CHECK_CONCURRENCY = 8;
const HEALTH_CHECK_TIMEOUT_MS = 4500;

const ROOT_FOLDER_PATTERNS = [
  /bookmarks bar/i,
  /bookmarks toolbar/i,
  /bookmarks menu/i,
  /other bookmarks/i,
  /other favorites/i,
  /mobile bookmarks/i,
  /favorites bar/i,
  /收藏夹栏/,
  /收藏栏/,
  /书签栏/,
  /书签工具栏/,
  /书签菜单/,
  /其他收藏/,
  /移动设备收藏/
];

type SuggestionConfidence = "high" | "medium" | "low";

type SmartSuggestion = {
  bookmarkId: string;
  targetCategoryId?: string;
  suggestedCategoryName?: string;
  suggestedSubCategory?: string;
  reason: string;
  confidence: SuggestionConfidence;
  selected: boolean;
};

type FlattenedBrowserBookmark = {
  url: string;
  title: string;
  folderPath?: string;
  subCategory?: string;
  createdAt: number;
};

type SuggestionTreeLeaf = {
  subCategory: string;
  items: SmartSuggestion[];
};

type SuggestionTreeGroup = {
  categoryLabel: string;
  categoryKey: string;
  defaultTargetCategoryId?: string;
  isExistingCategory: boolean;
  leaves: SuggestionTreeLeaf[];
  total: number;
};

type SuggestionPreviewItem = {
  bookmarkId: string;
  title: string;
  url: string;
  fromCategoryName: string;
  toCategoryName: string;
  subCategory?: string;
};

type DeadLinkIssue = {
  bookmarkId: string;
  url: string;
  title: string;
  category: "dead" | "restricted" | "temporary" | "unknown";
  statusCode?: number;
  reason: string;
  selected: boolean;
};

type UrlHealthResult =
  | { ok: true; statusCode: number }
  | {
      ok: false;
      category: DeadLinkIssue["category"];
      statusCode?: number;
      reason:
        | "invalid-url"
        | "unsupported-protocol"
        | "timeout"
        | "network"
        | "http-error";
    };

function isBrowserRootFolder(name: string) {
  const normalized = normalizeFolderName(name);
  if (!normalized) {
    return false;
  }
  return ROOT_FOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function classifyStatusCategory(statusCode: number): DeadLinkIssue["category"] {
  if (statusCode === 404 || statusCode === 410 || statusCode === 451) {
    return "dead";
  }
  if (statusCode === 401 || statusCode === 403) {
    return "restricted";
  }
  if (statusCode === 408 || statusCode === 425 || statusCode === 429) {
    return "temporary";
  }
  if (statusCode >= 500) {
    return "temporary";
  }
  if (statusCode >= 400) {
    return "unknown";
  }
  return "unknown";
}

async function probeUrlHealth(url: string): Promise<UrlHealthResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid-url", category: "unknown" as const };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "unsupported-protocol",
      category: "unknown" as const
    };
  }

  const requestOnce = async (method: "HEAD" | "GET"): Promise<UrlHealthResult> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method,
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal
      });
      if (response.status >= 400) {
        return {
          ok: false as const,
          reason: "http-error" as const,
          statusCode: response.status,
          category: classifyStatusCategory(response.status)
        };
      }
      return { ok: true as const, statusCode: response.status };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          ok: false as const,
          reason: "timeout" as const,
          category: "temporary" as const
        };
      }
      return {
        ok: false as const,
        reason: "network" as const,
        category: "unknown" as const
      };
    } finally {
      window.clearTimeout(timer);
    }
  };

  const headResult = await requestOnce("HEAD");
  if (headResult.ok) {
    return headResult;
  }
  if (
    headResult.reason === "http-error" &&
    (headResult.statusCode === 405 || headResult.statusCode === 501)
  ) {
    return requestOnce("GET");
  }
  return headResult;
}

function getRuleSpecificity(rule: Rule) {
  const value = rule.value.trim().toLowerCase();
  if (rule.type === "urlPrefix") {
    return value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").length;
  }
  return value.length;
}

function normalizeFolderName(name: string) {
  return name
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitFolderPath(folderPath?: string) {
  if (!folderPath) {
    return [];
  }
  return folderPath
    .split("/")
    .map((segment) => normalizeFolderName(segment))
    .filter(Boolean)
    .filter((segment) => !isBrowserRootFolder(segment));
}

function flattenBrowserTree(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  parents: string[] = []
): FlattenedBrowserBookmark[] {
  const output: FlattenedBrowserBookmark[] = [];
  nodes.forEach((node) => {
    if (node.url) {
      const segments = parents
        .map((segment) => normalizeFolderName(segment))
        .filter(Boolean)
        .filter((segment) => !isBrowserRootFolder(segment));
      const folderPath = segments.length ? segments.join(" / ") : undefined;
      output.push({
        url: node.url,
        title: node.title || node.url,
        folderPath,
        subCategory: segments.length > 1 ? segments.slice(1).join(" / ") : undefined,
        createdAt:
          typeof node.dateAdded === "number" && Number.isFinite(node.dateAdded)
            ? node.dateAdded
            : Date.now()
      });
      return;
    }
    if (Array.isArray(node.children) && node.children.length) {
      const nextParents = node.title ? [...parents, node.title] : parents;
      output.push(...flattenBrowserTree(node.children, nextParents));
    }
  });
  return output;
}

function pickCategoryColor(name: string) {
  const palette = COLOR_PALETTE.map((item) => item.className);
  const seed = Array.from(name).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return palette[seed % palette.length] ?? COLOR_PALETTE[0].className;
}

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
    const incomingHasFolderHint =
      bookmark.source === "browser-import" &&
      Boolean(bookmark.folderPath || bookmark.subCategory || bookmark.categoryId !== DEFAULT_CATEGORY_ID);
    const source = isIncomingNewer || incomingHasFolderHint ? bookmark : existing;
    let embedding = existing.embedding;
    let embeddingFingerprint = existing.embeddingFingerprint;
    if (isIncomingNewer && Array.isArray(bookmark.embedding)) {
      embedding = bookmark.embedding;
      embeddingFingerprint = bookmark.embeddingFingerprint || undefined;
    }
    const categoryId =
      incomingHasFolderHint && bookmark.categoryId
        ? bookmark.categoryId
        : source.categoryId || existing.categoryId;
    map.set(bookmark.url, {
      ...existing,
      ...source,
      id: existing.id,
      url: existing.url,
      title: source.title || existing.title,
      excerpt: source.excerpt || existing.excerpt,
      summaryLong: source.summaryLong || source.excerpt || existing.summaryLong || existing.excerpt,
      embedding,
      embeddingFingerprint,
      favicon: source.favicon ?? existing.favicon,
      categoryId,
      source: source.source ?? existing.source,
      folderPath: source.folderPath ?? existing.folderPath,
      subCategory: source.subCategory ?? existing.subCategory,
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

function buildAutoNaturalRuleValue(categoryName: string, subCategoryHints: string[] = []) {
  const normalizedName = normalizeFolderName(categoryName) || categoryName.trim();
  if (!normalizedName) {
    return "";
  }
  const hints = Array.from(
    new Set(
      subCategoryHints
        .map((hint) => normalizeFolderName(hint))
        .filter(Boolean)
        .slice(0, 3)
    )
  );
  const suffix = hints.length > 0 ? ` 典型子主题：${hints.join(" / ")}。` : "";
  return `与“${normalizedName}”相关的网页内容优先归入该分类。${suffix}`.trim();
}

function buildAutoNaturalRule(categoryId: string, categoryName: string, subCategoryHints: string[] = []): Rule {
  return {
    id: createId(),
    type: "natural",
    value: buildAutoNaturalRuleValue(categoryName, subCategoryHints),
    categoryId,
    createdAt: Date.now()
  };
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
  const [smartSuggestions, setSmartSuggestions] = useState<SmartSuggestion[]>([]);
  const [smartBusy, setSmartBusy] = useState(false);
  const [smartProgress, setSmartProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [collapsedLeaves, setCollapsedLeaves] = useState<Record<string, boolean>>({});
  const [groupTargetDrafts, setGroupTargetDrafts] = useState<Record<string, string>>({});
  const [groupNewNameDrafts, setGroupNewNameDrafts] = useState<Record<string, string>>({});
  const [itemTargetDrafts, setItemTargetDrafts] = useState<Record<string, string>>({});
  const [itemNewNameDrafts, setItemNewNameDrafts] = useState<Record<string, string>>({});
  const [showHighConfidenceOnly, setShowHighConfidenceOnly] = useState(false);
  const [showMissingSubCategoryOnly, setShowMissingSubCategoryOnly] = useState(false);
  const [applyPreviewOpen, setApplyPreviewOpen] = useState(false);
  const [deadLinkIssues, setDeadLinkIssues] = useState<DeadLinkIssue[]>([]);
  const [deadLinkCheckBusy, setDeadLinkCheckBusy] = useState(false);
  const [deadLinkCheckProgress, setDeadLinkCheckProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0
  });
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

  useEffect(() => {
    const isSameOriginResource = (href: string) => {
      try {
        const parsed = new URL(href, window.location.href);
        return parsed.origin === window.location.origin;
      } catch {
        return false;
      }
    };

    const purgeExternalResourceTags = (nodes: Iterable<Element>) => {
      for (const node of nodes) {
        if (node instanceof HTMLLinkElement) {
          const rel = node.rel.toLowerCase();
          if (!rel.includes("stylesheet")) {
            continue;
          }
          const href = node.href || node.getAttribute("href") || "";
          if (!href || isSameOriginResource(href)) {
            continue;
          }
          node.remove();
          continue;
        }

        if (!(node instanceof HTMLScriptElement)) {
          continue;
        }
        const src = node.src || node.getAttribute("src") || "";
        if (!src || isSameOriginResource(src)) {
          continue;
        }
        node.remove();
      }
    };

    purgeExternalResourceTags(
      document.head.querySelectorAll('link[rel*="stylesheet" i], script[src]')
    );

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (
          mutation.type === "attributes" &&
          (mutation.target instanceof HTMLLinkElement || mutation.target instanceof HTMLScriptElement)
        ) {
          purgeExternalResourceTags([mutation.target]);
          continue;
        }
        if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
          const addedResources: (HTMLLinkElement | HTMLScriptElement)[] = [];
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLLinkElement) {
              addedResources.push(node);
            } else if (node instanceof HTMLScriptElement) {
              addedResources.push(node);
            } else if (node instanceof HTMLElement) {
              node
                .querySelectorAll<HTMLLinkElement | HTMLScriptElement>(
                  'link[rel*="stylesheet" i], script[src]'
                )
                .forEach((resource) => addedResources.push(resource));
            }
          });
          if (addedResources.length > 0) {
            purgeExternalResourceTags(addedResources);
          }
        }
      }
    });

    observer.observe(document.head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "rel", "src"]
    });

    return () => observer.disconnect();
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

  const runSmartSuggestions = useCallback(
    async (scopedUrls?: Set<string>) => {
      if (!state) {
        return;
      }
      const targets = state.bookmarks.filter((bookmark) =>
        scopedUrls ? scopedUrls.has(bookmark.url) : true
      );
      if (!targets.length) {
        setTransientStatus(t("没有可分析的收藏。", "No bookmarks to analyze."), "error");
        return;
      }

      setSmartBusy(true);
      setSmartProgress({ done: 0, total: targets.length });
      const suggestions = new Map<string, SmartSuggestion>();
      const categoriesByName = new Map(
        state.categories.map((category) => [category.name.trim().toLowerCase(), category])
      );
      const categoryNameById = new Map(state.categories.map((category) => [category.id, category.name]));
      const knownSubCategoriesByCategory = new Map<string, Set<string>>();
      state.bookmarks.forEach((bookmark) => {
        const subCategory = (bookmark.subCategory || "").trim();
        if (!subCategory || bookmark.categoryId === DEFAULT_CATEGORY_ID) {
          return;
        }
        const known = knownSubCategoriesByCategory.get(bookmark.categoryId) ?? new Set<string>();
        known.add(subCategory);
        knownSubCategoriesByCategory.set(bookmark.categoryId, known);
      });
      const domainVotes = new Map<string, Map<string, number>>();
      state.bookmarks.forEach((bookmark) => {
        const domain = getDomain(bookmark.url);
        if (!domain || bookmark.categoryId === DEFAULT_CATEGORY_ID) {
          return;
        }
        const byCategory = domainVotes.get(domain) ?? new Map<string, number>();
        byCategory.set(bookmark.categoryId, (byCategory.get(bookmark.categoryId) ?? 0) + 1);
        domainVotes.set(domain, byCategory);
      });

      const aiCandidates: Bookmark[] = [];

      targets.forEach((bookmark) => {
        const domain = getDomain(bookmark.url);
        const matchedRule = state.rules
          .filter((rule) => {
            if (rule.type === "domain") {
              return domainMatches(rule.value, domain);
            }
            if (rule.type === "urlPrefix") {
              return urlPrefixMatches(rule.value, bookmark.url);
            }
            return false;
          })
          .sort((a, b) => getRuleSpecificity(b) - getRuleSpecificity(a))[0];
        if (matchedRule && matchedRule.categoryId !== bookmark.categoryId) {
          suggestions.set(bookmark.id, {
            bookmarkId: bookmark.id,
            targetCategoryId: matchedRule.categoryId,
            suggestedSubCategory: bookmark.subCategory,
            reason: t("命中规则：{value}", "Rule matched: {value}", { value: matchedRule.value }),
            confidence: "high",
            selected: true
          });
          return;
        }

        const folderSegments = (bookmark.folderPath || "")
          .split("/")
          .map((segment) => segment.trim())
          .filter(Boolean);
        const topFolder = folderSegments[0] || "";
        const subFolder = folderSegments.length > 1 ? folderSegments.slice(1).join(" / ") : "";
        if (topFolder) {
          const existing = categoriesByName.get(topFolder.toLowerCase());
          if (existing && existing.id !== bookmark.categoryId) {
            suggestions.set(bookmark.id, {
              bookmarkId: bookmark.id,
              targetCategoryId: existing.id,
              suggestedSubCategory: subFolder || bookmark.subCategory,
              reason: t("来自导入目录：{name}", "Imported folder hint: {name}", { name: topFolder }),
              confidence: "high",
              selected: true
            });
            return;
          }
          if (!existing && bookmark.categoryId === DEFAULT_CATEGORY_ID) {
            suggestions.set(bookmark.id, {
              bookmarkId: bookmark.id,
              suggestedCategoryName: topFolder,
              suggestedSubCategory: subFolder || bookmark.subCategory,
              reason: t("建议按导入目录创建分组", "Suggest creating a category from folder path."),
              confidence: "medium",
              selected: true
            });
            return;
          }
        }

        const votes = domainVotes.get(domain);
        if (votes && votes.size > 0) {
          let winnerId = "";
          let winnerScore = 0;
          votes.forEach((score, categoryId) => {
            if (score > winnerScore) {
              winnerId = categoryId;
              winnerScore = score;
            }
          });
          if (winnerId && winnerId !== bookmark.categoryId && winnerScore >= 2) {
            suggestions.set(bookmark.id, {
              bookmarkId: bookmark.id,
              targetCategoryId: winnerId,
              suggestedSubCategory: bookmark.subCategory,
              reason: t("同域名历史归类一致性建议", "Suggested by same-domain history."),
              confidence: "medium",
              selected: true
            });
            return;
          }
        }

        if (bookmark.categoryId === DEFAULT_CATEGORY_ID) {
          aiCandidates.push(bookmark);
        }
      });

      const canUseAi = state.ai.apiKey && state.ai.baseUrl && state.ai.model;
      const aiQueue = canUseAi ? aiCandidates.slice(0, SMART_AI_LIMIT) : [];
      let done = targets.length - aiQueue.length;
      setSmartProgress({ done, total: targets.length });

      for (const bookmark of aiQueue) {
        try {
          const result = await classifyWithAi(
            state.ai,
            state.categories,
            state.rules,
            bookmark.title || bookmark.url,
            bookmark.url,
            [bookmark.title, bookmark.summaryLong || bookmark.excerpt, bookmark.folderPath || ""]
              .filter(Boolean)
              .join("\n")
          );
          if (
            result.categoryId !== DEFAULT_CATEGORY_ID &&
            result.categoryId !== bookmark.categoryId &&
            state.categories.some((category) => category.id === result.categoryId)
          ) {
            suggestions.set(bookmark.id, {
              bookmarkId: bookmark.id,
              targetCategoryId: result.categoryId,
              suggestedSubCategory: bookmark.subCategory,
              reason: t("AI 内容识别建议", "AI content-based suggestion."),
              confidence: "medium",
              selected: true
            });
          }
        } catch {
          // Ignore single-item AI failures to keep bulk suggestion flow running.
        } finally {
          done += 1;
          setSmartProgress({ done, total: targets.length });
        }
      }

      const subCategoryCandidates = targets
        .map((bookmark) => {
          const existingSuggestion = suggestions.get(bookmark.id);
          const resolvedSubCategory = (
            existingSuggestion?.suggestedSubCategory ||
            bookmark.subCategory ||
            ""
          ).trim();
          if (resolvedSubCategory) {
            return null;
          }
          if (existingSuggestion?.targetCategoryId) {
            const targetName = categoryNameById.get(existingSuggestion.targetCategoryId) || "";
            if (!targetName) {
              return null;
            }
            return {
              bookmark,
              targetCategoryId: existingSuggestion.targetCategoryId,
              targetCategoryName: targetName,
              suggestedCategoryName: undefined as string | undefined
            };
          }
          if ((existingSuggestion?.suggestedCategoryName || "").trim()) {
            const targetName = (existingSuggestion?.suggestedCategoryName || "").trim();
            return {
              bookmark,
              targetCategoryId: undefined as string | undefined,
              targetCategoryName: targetName,
              suggestedCategoryName: targetName
            };
          }
          if (bookmark.categoryId !== DEFAULT_CATEGORY_ID) {
            const targetName = categoryNameById.get(bookmark.categoryId) || "";
            if (!targetName) {
              return null;
            }
            return {
              bookmark,
              targetCategoryId: bookmark.categoryId,
              targetCategoryName: targetName,
              suggestedCategoryName: undefined as string | undefined
            };
          }
          return null;
        })
        .filter(Boolean) as {
        bookmark: Bookmark;
        targetCategoryId?: string;
        targetCategoryName: string;
        suggestedCategoryName?: string;
      }[];

      const subCategoryAiQueue = canUseAi ? subCategoryCandidates.slice(0, SUBCATEGORY_AI_LIMIT) : [];
      if (subCategoryAiQueue.length > 0) {
        setSmartProgress({ done, total: targets.length + subCategoryAiQueue.length });
      }
      for (const candidate of subCategoryAiQueue) {
        try {
          const existingSubCategories = candidate.targetCategoryId
            ? Array.from(knownSubCategoriesByCategory.get(candidate.targetCategoryId) ?? [])
            : [];
          const result = await suggestSubCategoryWithAi(
            state.ai,
            candidate.bookmark.title || candidate.bookmark.url,
            candidate.bookmark.url,
            [
              candidate.bookmark.title,
              candidate.bookmark.summaryLong || candidate.bookmark.excerpt,
              candidate.bookmark.folderPath || ""
            ]
              .filter(Boolean)
              .join("\n"),
            candidate.targetCategoryName,
            existingSubCategories
          );
          if (result.subCategory) {
            const existingSuggestion = suggestions.get(candidate.bookmark.id);
            if (existingSuggestion) {
              suggestions.set(candidate.bookmark.id, {
                ...existingSuggestion,
                suggestedSubCategory: result.subCategory,
                reason: result.reason
                  ? t("补全子分类：{reason}", "Subcategory hint: {reason}", { reason: result.reason })
                  : existingSuggestion.reason
              });
            } else {
              suggestions.set(candidate.bookmark.id, {
                bookmarkId: candidate.bookmark.id,
                targetCategoryId: candidate.targetCategoryId,
                suggestedCategoryName: candidate.suggestedCategoryName,
                suggestedSubCategory: result.subCategory,
                reason: result.reason
                  ? t("补全子分类：{reason}", "Subcategory hint: {reason}", { reason: result.reason })
                  : t("AI 补全未分配子分类", "AI suggested a subcategory."),
                confidence: result.confidence,
                selected: true
              });
            }
          }
        } catch {
          // Ignore single-item AI failures to keep bulk suggestion flow running.
        } finally {
          done += 1;
          setSmartProgress({ done, total: targets.length + subCategoryAiQueue.length });
        }
      }

      const next = Array.from(suggestions.values()).sort((a, b) => {
        const rank: Record<SuggestionConfidence, number> = { high: 0, medium: 1, low: 2 };
        return rank[a.confidence] - rank[b.confidence];
      });
      setSmartSuggestions(next);
      setSmartBusy(false);
      setTransientStatus(
        t("已生成 {count} 条整理建议", "Generated {count} suggestions.", { count: next.length })
      );
    },
    [state, t, setTransientStatus]
  );

  const importBrowserBookmarks = useCallback(async () => {
    if (!chrome.bookmarks?.getTree) {
      setTransientStatus(
        t("当前环境不支持浏览器收藏读取。", "Browser bookmark API is unavailable."),
        "error"
      );
      return;
    }
    try {
      const tree = await new Promise<chrome.bookmarks.BookmarkTreeNode[]>((resolve, reject) => {
        chrome.bookmarks.getTree((nodes) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve(nodes);
        });
      });
      const flattened = flattenBrowserTree(tree);
      if (!flattened.length) {
        setTransientStatus(t("未检测到可导入收藏。", "No importable bookmarks found."), "error");
        return;
      }
      const importedRaw: Bookmark[] = flattened.map((item) => ({
        id: createId(),
        url: item.url,
        title: item.title,
        excerpt: "",
        summaryLong: "",
        categoryId: DEFAULT_CATEGORY_ID,
        source: "browser-import",
        folderPath: item.folderPath,
        subCategory: item.subCategory,
        pinned: false,
        createdAt: item.createdAt
      }));
      const nextState = await update((current) => {
        const categoriesByName = new Map(
          current.categories.map((category) => [category.name.trim().toLowerCase(), category.id])
        );
        const createdCategories: Category[] = [];
        const subCategoryHintsByCategory = new Map<string, Set<string>>();
        const imported = importedRaw.map((bookmark) => {
          const segments = splitFolderPath(bookmark.folderPath);
          const topCategoryName = segments[0] || "";
          const subCategory = segments.length > 1 ? segments.slice(1).join(" / ") : undefined;
          if (!topCategoryName) {
            return {
              ...bookmark,
              categoryId: DEFAULT_CATEGORY_ID,
              subCategory
            };
          }
          const key = topCategoryName.toLowerCase();
          let categoryId = categoriesByName.get(key);
          if (!categoryId) {
            categoryId = createId();
            categoriesByName.set(key, categoryId);
            createdCategories.push({
              id: categoryId,
              name: topCategoryName,
              color: pickCategoryColor(topCategoryName),
              createdAt: Date.now()
            });
          }
          if (subCategory) {
            const hints = subCategoryHintsByCategory.get(categoryId) ?? new Set<string>();
            hints.add(subCategory);
            subCategoryHintsByCategory.set(categoryId, hints);
          }
          return {
            ...bookmark,
            categoryId,
            subCategory
          };
        });
        const createdRules = createdCategories
          .map((category) => {
            const hints = Array.from(subCategoryHintsByCategory.get(category.id) ?? []);
            const rule = buildAutoNaturalRule(category.id, category.name, hints);
            return rule.value ? rule : null;
          })
          .filter(Boolean) as Rule[];
        const nextBookmarks =
          importMode === "replace"
            ? imported
            : mergeBookmarks(current.bookmarks, imported);
        return normalizeState({
          ...current,
          categories: [...current.categories, ...createdCategories],
          rules: [...current.rules, ...createdRules],
          bookmarks: nextBookmarks
        });
      });
      const importedUrlSet = new Set(importedRaw.map((bookmark) => bookmark.url));
      const importedFromState = nextState.bookmarks.filter((bookmark) =>
        importedUrlSet.has(bookmark.url)
      );
      const unresolvedUrls = new Set(
        importedFromState
          .filter((bookmark) => bookmark.categoryId === DEFAULT_CATEGORY_ID)
          .map((bookmark) => bookmark.url)
      );
      if (unresolvedUrls.size > 0) {
        void runSmartSuggestions(unresolvedUrls);
      } else {
        setSmartSuggestions([]);
      }
      void (async () => {
        if (!importedFromState.length) {
          setDeadLinkIssues([]);
          return;
        }
        setDeadLinkCheckBusy(true);
        setDeadLinkCheckProgress({ done: 0, total: importedFromState.length });
        const issues: DeadLinkIssue[] = [];
        let cursor = 0;
        let done = 0;

        const workers = Array.from(
          { length: Math.min(HEALTH_CHECK_CONCURRENCY, importedFromState.length) },
          async () => {
            while (true) {
              const index = cursor;
              cursor += 1;
              if (index >= importedFromState.length) {
                return;
              }
              const bookmark = importedFromState[index];
              const health = await probeUrlHealth(bookmark.url);
              if (!health.ok) {
                const reason =
                  health.reason === "http-error" && typeof health.statusCode === "number"
                    ? health.statusCode === 404 || health.statusCode === 410 || health.statusCode === 451
                      ? t(
                          "页面不存在或已下线（{status}）",
                          "Page not found or gone ({status})",
                          { status: health.statusCode }
                        )
                      : health.statusCode === 401 || health.statusCode === 403
                        ? t(
                            "访问受限（{status}），可能需要登录/权限/风控验证",
                            "Access restricted ({status}), may require login/permissions/challenge",
                            { status: health.statusCode }
                          )
                        : health.statusCode === 429 || health.statusCode >= 500
                          ? t(
                              "服务暂时不可用（{status}），建议稍后重试",
                              "Service temporary unavailable ({status}), retry later",
                              { status: health.statusCode }
                            )
                          : t("HTTP 状态 {status}，请人工确认", "HTTP {status}, manual review needed", {
                              status: health.statusCode
                            })
                    : health.reason === "timeout"
                      ? t("连接超时，可能临时不可达", "Request timeout, possibly temporary")
                      : health.reason === "unsupported-protocol"
                        ? t("不支持的链接协议", "Unsupported URL protocol")
                        : health.reason === "invalid-url"
                          ? t("链接格式无效", "Invalid URL")
                          : t("网络访问失败，可能被 CORS/风控拦截", "Network check failed, maybe blocked");
                issues.push({
                  bookmarkId: bookmark.id,
                  url: bookmark.url,
                  title: bookmark.title || bookmark.url,
                  category: health.category,
                  statusCode: health.statusCode,
                  reason,
                  selected: health.category === "dead" || health.reason === "invalid-url"
                });
              }
              done += 1;
              setDeadLinkCheckProgress({ done, total: importedFromState.length });
            }
          }
        );
        await Promise.all(workers);
        setDeadLinkCheckBusy(false);
        setDeadLinkIssues(issues);
        if (issues.length > 0) {
          const deadCount = issues.filter((item) => item.category === "dead").length;
          setTransientStatus(
            t(
              "验活完成：疑似失效 {dead} 条，需人工确认 {other} 条。",
              "Health check finished: likely dead {dead}, needs review {other}.",
              { dead: deadCount, other: issues.length - deadCount }
            ),
            deadCount > 0 ? "error" : "success"
          );
        } else {
          setTransientStatus(t("导入验活完成，未发现失效链接。", "Health check finished: no dead links."));
        }
      })();
      setTransientStatus(
        importMode === "replace"
          ? t("已覆盖导入浏览器收藏 {count} 条", "Replaced with {count} browser bookmarks.", {
              count: importedRaw.length
            })
          : t("已合并导入浏览器收藏 {count} 条", "Merged {count} browser bookmarks.", {
              count: importedRaw.length
            })
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("导入浏览器收藏失败", "Browser import failed.");
      setTransientStatus(message, "error");
    }
  }, [importMode, runSmartSuggestions, setTransientStatus, t, update]);

  const toggleDeadLinkSelected = useCallback((bookmarkId: string, selected: boolean) => {
    setDeadLinkIssues((current) =>
      current.map((item) => (item.bookmarkId === bookmarkId ? { ...item, selected } : item))
    );
  }, []);

  const selectAllDeadLinkIssues = useCallback((selected: boolean) => {
    setDeadLinkIssues((current) => current.map((item) => ({ ...item, selected })));
  }, []);

  const removeSelectedDeadLinks = useCallback(async () => {
    const selected = deadLinkIssues.filter((item) => item.selected);
    if (!selected.length) {
      setTransientStatus(
        t("请先选择要删除的失效链接。", "Select dead links to remove."),
        "error"
      );
      return;
    }
    const idSet = new Set(selected.map((item) => item.bookmarkId));
    await update((current) => ({
      ...current,
      bookmarks: current.bookmarks.filter((bookmark) => !idSet.has(bookmark.id))
    }));
    setDeadLinkIssues((current) => current.filter((item) => !idSet.has(item.bookmarkId)));
    setTransientStatus(
      t("已删除 {count} 条失效链接。", "Removed {count} dead links.", { count: selected.length })
    );
  }, [deadLinkIssues, setTransientStatus, t, update]);

  const clearDeadLinkIssues = useCallback(() => {
    setDeadLinkIssues([]);
  }, []);

  const toggleSuggestionSelected = useCallback((bookmarkId: string, selected: boolean) => {
    setSmartSuggestions((current) =>
      current.map((item) => (item.bookmarkId === bookmarkId ? { ...item, selected } : item))
    );
  }, []);

  const setAllSuggestionSelection = useCallback(
    (selected: boolean) => {
      const visibleIds = new Set(
        smartSuggestions
          .filter((item) => {
            if (showHighConfidenceOnly && item.confidence !== "high") {
              return false;
            }
            if (showMissingSubCategoryOnly && (item.suggestedSubCategory || "").trim()) {
              return false;
            }
            return true;
          })
          .map((item) => item.bookmarkId)
      );
      setSmartSuggestions((current) =>
        current.map((item) =>
          visibleIds.has(item.bookmarkId) ? { ...item, selected } : item
        )
      );
    },
    [showHighConfidenceOnly, showMissingSubCategoryOnly, smartSuggestions]
  );

  const setSuggestionSelectionByIds = useCallback((bookmarkIds: string[], selected: boolean) => {
    const selectedSet = new Set(bookmarkIds);
    setSmartSuggestions((current) =>
      current.map((item) =>
        selectedSet.has(item.bookmarkId) ? { ...item, selected } : item
      )
    );
  }, []);

  const toggleGroupCollapsed = useCallback((groupKey: string) => {
    setCollapsedGroups((current) => ({
      ...current,
      [groupKey]: !current[groupKey]
    }));
  }, []);

  const toggleLeafCollapsed = useCallback((leafKey: string) => {
    setCollapsedLeaves((current) => ({
      ...current,
      [leafKey]: !current[leafKey]
    }));
  }, []);

  const setAllSuggestionCollapsed = useCallback(
    (groupKeys: string[], leafKeys: string[], collapsed: boolean) => {
      const groupMap: Record<string, boolean> = {};
      groupKeys.forEach((key) => {
        groupMap[key] = collapsed;
      });
      const leafMap: Record<string, boolean> = {};
      leafKeys.forEach((key) => {
        leafMap[key] = collapsed;
      });
      setCollapsedGroups(groupMap);
      setCollapsedLeaves(leafMap);
    },
    []
  );

  const updateGroupTargetDraft = useCallback((groupKey: string, value: string) => {
    setGroupTargetDrafts((current) => ({
      ...current,
      [groupKey]: value
    }));
  }, []);

  const updateGroupNewNameDraft = useCallback((groupKey: string, value: string) => {
    setGroupNewNameDrafts((current) => ({
      ...current,
      [groupKey]: value
    }));
  }, []);

  const setSuggestionTargetByIds = useCallback(
    (bookmarkIds: string[], targetCategoryId?: string, categoryName?: string) => {
      const idSet = new Set(bookmarkIds);
      if (targetCategoryId) {
        setItemTargetDrafts((current) => {
          const next = { ...current };
          bookmarkIds.forEach((bookmarkId) => {
            next[bookmarkId] = targetCategoryId;
          });
          return next;
        });
      } else {
        setItemTargetDrafts((current) => {
          const next = { ...current };
          bookmarkIds.forEach((bookmarkId) => {
            next[bookmarkId] = "__new__";
          });
          return next;
        });
        if (categoryName !== undefined) {
          setItemNewNameDrafts((current) => {
            const next = { ...current };
            bookmarkIds.forEach((bookmarkId) => {
              next[bookmarkId] = categoryName;
            });
            return next;
          });
        }
      }
      setSmartSuggestions((current) =>
        current.map((item) => {
          if (!idSet.has(item.bookmarkId)) {
            return item;
          }
          if (targetCategoryId) {
            return {
              ...item,
              targetCategoryId,
              suggestedCategoryName: undefined
            };
          }
          return {
            ...item,
            targetCategoryId: undefined,
            suggestedCategoryName: categoryName ?? item.suggestedCategoryName
          };
        })
      );
    },
    []
  );

  const updateItemTargetDraft = useCallback((bookmarkId: string, value: string) => {
    setItemTargetDrafts((current) => ({
      ...current,
      [bookmarkId]: value
    }));
  }, []);

  const updateItemNewNameDraft = useCallback((bookmarkId: string, value: string) => {
    setItemNewNameDrafts((current) => ({
      ...current,
      [bookmarkId]: value
    }));
  }, []);

  const updateSuggestionCategory = useCallback((bookmarkId: string, categoryId: string) => {
    setSmartSuggestions((current) =>
      current.map((item) =>
        item.bookmarkId === bookmarkId
          ? {
              ...item,
              targetCategoryId: categoryId || undefined,
              suggestedCategoryName: categoryId ? undefined : item.suggestedCategoryName
            }
          : item
      )
    );
  }, []);

  const updateSuggestionCategoryName = useCallback((bookmarkId: string, categoryName: string) => {
    setSmartSuggestions((current) =>
      current.map((item) =>
        item.bookmarkId === bookmarkId
          ? {
              ...item,
              targetCategoryId: undefined,
              suggestedCategoryName: categoryName
            }
          : item
      )
    );
  }, []);

  const saveSuggestionItemDraft = useCallback(
    (bookmarkId: string) => {
      const targetValue = itemTargetDrafts[bookmarkId] ?? "__new__";
      if (targetValue === "__new__") {
        const categoryName = (itemNewNameDrafts[bookmarkId] || "").trim();
        if (!categoryName) {
          setTransientStatus(
            t("请先填写该条建议的新分组名称。", "Please enter a new category name for this item."),
            "error"
          );
          return;
        }
        updateSuggestionCategory(bookmarkId, "");
        updateSuggestionCategoryName(bookmarkId, categoryName);
        setTransientStatus(t("已保存此条设置。", "Item setting saved."));
        return;
      }
      updateSuggestionCategory(bookmarkId, targetValue);
      setTransientStatus(t("已保存此条设置。", "Item setting saved."));
    },
    [
      itemTargetDrafts,
      itemNewNameDrafts,
      setTransientStatus,
      t,
      updateSuggestionCategory,
      updateSuggestionCategoryName
    ]
  );

  const dismissSelectedSuggestions = useCallback(() => {
    setSmartSuggestions((current) => current.filter((item) => !item.selected));
  }, []);

  const collectSelectedSuggestions = useCallback(() => {
    const selected = smartSuggestions.filter((item) => item.selected);
    if (!selected.length) {
      setTransientStatus(t("请先选择要应用的建议。", "Select suggestions to apply."), "error");
      return null;
    }
    const missingTarget = selected.filter(
      (item) => !item.targetCategoryId && !(item.suggestedCategoryName || "").trim()
    );
    if (missingTarget.length > 0) {
      setTransientStatus(
        t(
          "有 {count} 条建议缺少目标分组，请先补全后再应用。",
          "{count} selected suggestions are missing a target category.",
          { count: missingTarget.length }
        ),
        "error"
      );
      return null;
    }
    return selected;
  }, [smartSuggestions, t, setTransientStatus]);

  const applySelectedSuggestions = useCallback(async () => {
    const selected = collectSelectedSuggestions();
    if (!selected) {
      return false;
    }

    await update((current) => {
      const categoriesByName = new Map(
        current.categories.map((category) => [category.name.trim().toLowerCase(), category.id])
      );
      const createdCategories: Category[] = [];
      const subCategoryHintsByCategory = new Map<string, Set<string>>();
      const resolvedTargets = new Map<string, { categoryId: string; subCategory?: string }>();

      selected.forEach((item) => {
        if (item.targetCategoryId) {
          resolvedTargets.set(item.bookmarkId, {
            categoryId: item.targetCategoryId,
            subCategory: item.suggestedSubCategory
          });
          if (item.suggestedSubCategory) {
            const hints = subCategoryHintsByCategory.get(item.targetCategoryId) ?? new Set<string>();
            hints.add(item.suggestedSubCategory);
            subCategoryHintsByCategory.set(item.targetCategoryId, hints);
          }
          return;
        }
        const name = (item.suggestedCategoryName || "").trim();
        if (!name) {
          return;
        }
        const existingId = categoriesByName.get(name.toLowerCase());
        if (existingId) {
          resolvedTargets.set(item.bookmarkId, {
            categoryId: existingId,
            subCategory: item.suggestedSubCategory
          });
          if (item.suggestedSubCategory) {
            const hints = subCategoryHintsByCategory.get(existingId) ?? new Set<string>();
            hints.add(item.suggestedSubCategory);
            subCategoryHintsByCategory.set(existingId, hints);
          }
          return;
        }
        const categoryId = createId();
        categoriesByName.set(name.toLowerCase(), categoryId);
        resolvedTargets.set(item.bookmarkId, {
          categoryId,
          subCategory: item.suggestedSubCategory
        });
        if (item.suggestedSubCategory) {
          const hints = subCategoryHintsByCategory.get(categoryId) ?? new Set<string>();
          hints.add(item.suggestedSubCategory);
          subCategoryHintsByCategory.set(categoryId, hints);
        }
        createdCategories.push({
          id: categoryId,
          name,
          color: pickCategoryColor(name),
          createdAt: Date.now()
        });
      });

      const createdRules = createdCategories
        .map((category) => {
          const hints = Array.from(subCategoryHintsByCategory.get(category.id) ?? []);
          const rule = buildAutoNaturalRule(category.id, category.name, hints);
          return rule.value ? rule : null;
        })
        .filter(Boolean) as Rule[];

      return {
        ...current,
        categories: [...current.categories, ...createdCategories],
        rules: [...current.rules, ...createdRules],
        bookmarks: current.bookmarks.map((bookmark) => {
          const target = resolvedTargets.get(bookmark.id);
          if (!target) {
            return bookmark;
          }
          return {
            ...bookmark,
            categoryId: target.categoryId,
            subCategory: target.subCategory || bookmark.subCategory
          };
        })
      };
    });

    setSmartSuggestions((current) => current.filter((item) => !item.selected));
    setTransientStatus(
      t("已应用 {count} 条建议", "Applied {count} suggestions.", {
        count: selected.length
      })
    );
    return true;
  }, [collectSelectedSuggestions, t, setTransientStatus, update]);

  const openApplyPreview = useCallback(() => {
    const selected = collectSelectedSuggestions();
    if (!selected) {
      return;
    }
    setApplyPreviewOpen(true);
  }, [collectSelectedSuggestions]);

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
    setSmartSuggestions([]);
    setDeadLinkIssues([]);
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

  const openExternalUrl = useCallback((url: string) => {
    const normalized = url.trim();
    if (!normalized) {
      return;
    }
    try {
      if (chrome.tabs?.create) {
        chrome.tabs.create({ url: normalized });
        return;
      }
    } catch {
      // Fall through to background message fallback.
    }
    try {
      chrome.runtime.sendMessage(
        {
          type: "OPEN_EXTERNAL_TAB",
          payload: { url: normalized }
        },
        (response?: { ok: boolean; error?: string }) => {
          if (chrome.runtime.lastError) {
            setTransientStatus(
              chrome.runtime.lastError.message ||
                t("打开链接失败。", "Failed to open link."),
              "error"
            );
            return;
          }
          if (response && !response.ok) {
            setTransientStatus(response.error || t("打开链接失败。", "Failed to open link."), "error");
          }
        }
      );
    } catch {
      setTransientStatus(t("打开链接失败。", "Failed to open link."), "error");
    }
  }, [setTransientStatus, t]);

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

  const selectedSuggestions = useMemo(
    () => smartSuggestions.filter((item) => item.selected),
    [smartSuggestions]
  );
  const filteredSuggestions = useMemo(
    () => {
      return smartSuggestions.filter((item) => {
        if (showHighConfidenceOnly && item.confidence !== "high") {
          return false;
        }
        if (showMissingSubCategoryOnly && (item.suggestedSubCategory || "").trim()) {
          return false;
        }
        return true;
      });
    },
    [showHighConfidenceOnly, showMissingSubCategoryOnly, smartSuggestions]
  );
  const smartSelectedCount = selectedSuggestions.length;
  const highConfidenceCount = useMemo(
    () => smartSuggestions.filter((item) => item.confidence === "high").length,
    [smartSuggestions]
  );
  const missingSubCategoryCount = useMemo(
    () => smartSuggestions.filter((item) => !(item.suggestedSubCategory || "").trim()).length,
    [smartSuggestions]
  );
  const selectedMissingSubCategoryCount = useMemo(
    () => selectedSuggestions.filter((item) => !(item.suggestedSubCategory || "").trim()).length,
    [selectedSuggestions]
  );
  const visibleSelectedCount = useMemo(
    () => filteredSuggestions.filter((item) => item.selected).length,
    [filteredSuggestions]
  );
  const bookmarkMapById = useMemo(() => {
    if (!state) {
      return new Map<string, Bookmark>();
    }
    return new Map(state.bookmarks.map((bookmark) => [bookmark.id, bookmark]));
  }, [state]);
  const suggestionTree = useMemo(() => {
    const categoryNameById = new Map(sortedCategories.map((category) => [category.id, category.name]));
    const grouped = new Map<string, { label: string; leaves: Map<string, SmartSuggestion[]> }>();

    filteredSuggestions.forEach((item) => {
      const categoryLabel = item.targetCategoryId
        ? categoryNameById.get(item.targetCategoryId) || t("未知分组", "Unknown category")
        : (item.suggestedCategoryName || "").trim() ||
          t("待确认新分组", "Pending new category");
      const categoryKey = item.targetCategoryId
        ? `existing:${item.targetCategoryId}`
        : `new:${categoryLabel.toLowerCase()}`;
      const subLabel =
        (item.suggestedSubCategory || "").trim() || t("未指定子分类", "No subcategory");

      const categoryGroup = grouped.get(categoryKey) ?? {
        label: categoryLabel,
        leaves: new Map<string, SmartSuggestion[]>()
      };
      const leafItems = categoryGroup.leaves.get(subLabel) ?? [];
      leafItems.push(item);
      categoryGroup.leaves.set(subLabel, leafItems);
      grouped.set(categoryKey, categoryGroup);
    });

    return Array.from(grouped.entries())
      .map(([categoryKey, group]) => {
        const isExistingCategory = categoryKey.startsWith("existing:");
        const defaultTargetCategoryId = isExistingCategory
          ? categoryKey.replace(/^existing:/, "")
          : undefined;
        const leaves: SuggestionTreeLeaf[] = Array.from(group.leaves.entries())
          .map(([subCategory, items]) => ({
            subCategory,
            items: [...items].sort((a, b) => {
              const rank: Record<SuggestionConfidence, number> = { high: 0, medium: 1, low: 2 };
              return rank[a.confidence] - rank[b.confidence];
            })
          }))
          .sort((a, b) => b.items.length - a.items.length);
        const total = leaves.reduce((sum, leaf) => sum + leaf.items.length, 0);
        return {
          categoryLabel: group.label,
          categoryKey,
          defaultTargetCategoryId,
          isExistingCategory,
          leaves,
          total
        };
      })
      .sort((a, b) => b.total - a.total) as SuggestionTreeGroup[];
  }, [filteredSuggestions, sortedCategories, t]);

  const applyPreviewItems = useMemo(() => {
    return selectedSuggestions
      .map((item) => {
        const bookmark = bookmarkMapById.get(item.bookmarkId);
        if (!bookmark) {
          return null;
        }
        const fromCategoryName =
          categoryMap.get(bookmark.categoryId)?.name ?? t("未分类", "Inbox");
        const toCategoryName = item.targetCategoryId
          ? categoryMap.get(item.targetCategoryId)?.name ?? t("未知分组", "Unknown category")
          : (item.suggestedCategoryName || "").trim() || t("待确认新分组", "Pending new category");
        return {
          bookmarkId: item.bookmarkId,
          title: bookmark.title || bookmark.url,
          url: bookmark.url,
          fromCategoryName,
          toCategoryName,
          subCategory: item.suggestedSubCategory
        };
      })
      .filter(Boolean) as SuggestionPreviewItem[];
  }, [selectedSuggestions, bookmarkMapById, categoryMap, t]);

  useEffect(() => {
    setItemTargetDrafts((current) => {
      const next: Record<string, string> = {};
      smartSuggestions.forEach((item) => {
        const existing = current[item.bookmarkId];
        next[item.bookmarkId] = existing ?? item.targetCategoryId ?? "__new__";
      });
      return next;
    });
    setItemNewNameDrafts((current) => {
      const next: Record<string, string> = {};
      smartSuggestions.forEach((item) => {
        const existing = current[item.bookmarkId];
        next[item.bookmarkId] = existing ?? item.suggestedCategoryName ?? "";
      });
      return next;
    });
  }, [smartSuggestions]);

  useEffect(() => {
    const groupKeySet = new Set(suggestionTree.map((group) => group.categoryKey));
    setGroupTargetDrafts((current) => {
      const next: Record<string, string> = {};
      suggestionTree.forEach((group) => {
        const fallback = group.defaultTargetCategoryId || "__new__";
        next[group.categoryKey] = current[group.categoryKey] ?? fallback;
      });
      return next;
    });
    setGroupNewNameDrafts((current) => {
      const next: Record<string, string> = {};
      suggestionTree.forEach((group) => {
        const fallback = group.isExistingCategory ? "" : group.categoryLabel;
        next[group.categoryKey] = current[group.categoryKey] ?? fallback;
      });
      return next;
    });
    setCollapsedGroups((current) => {
      const next: Record<string, boolean> = {};
      Object.keys(current).forEach((key) => {
        if (groupKeySet.has(key)) {
          next[key] = current[key];
        }
      });
      return next;
    });
    setCollapsedLeaves((current) => {
      const next: Record<string, boolean> = {};
      Object.keys(current).forEach((key) => {
        const groupKey = key.split("::")[0];
        if (groupKeySet.has(groupKey)) {
          next[key] = current[key];
        }
      });
      return next;
    });
  }, [suggestionTree]);

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
            {editingCategory ? (
              <div className="mt-4 space-y-3">
                <div className="text-sm font-semibold text-slate-700">
                  {t("分类规则", "Category rules")}
                </div>
                {(() => {
                  const rules = rulesByCategory.get(editingCategory.id) ?? [];
                  const orderedRules = [...rules].sort((a, b) => {
                    const rank = { domain: 0, urlPrefix: 1, natural: 2 } as const;
                    if (rank[a.type] !== rank[b.type]) {
                      return rank[a.type] - rank[b.type];
                    }
                    return b.createdAt - a.createdAt;
                  });
                  return orderedRules.length === 0 ? (
                    <div className="rounded-2xl border border-white/60 bg-white/80 px-4 py-3 text-sm text-slate-500">
                      {t("暂无规则，添加后可帮助自动归类。", "No rules yet. Add some to guide classification.")}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {orderedRules.map((rule) => (
                        <div
                          key={rule.id}
                          className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-white/60 bg-white/80 px-4 py-3"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                              <span className="rounded-full border border-white/70 bg-white/80 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                                {ruleTypeLabels[rule.type]}
                              </span>
                              <span>
                                {rule.type === "domain"
                                  ? t("匹配域名及子域名", "Matches domain + subdomains")
                                  : rule.type === "urlPrefix"
                                    ? t("匹配 URL 前缀", "Matches URL prefix")
                                    : t("AI 分类提示", "AI classification hint")}
                              </span>
                            </div>
                            <div className="break-all text-sm font-semibold text-slate-800">
                              {rule.value}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeRule(rule.id)}
                            className="rounded-full border border-white/70 bg-white/80 px-3 py-1 text-xs text-slate-500"
                          >
                            {t("删除", "Delete")}
                          </button>
                        </div>
                      ))}
                    </div>
                  );
                })()}
                <div className="rounded-2xl border border-white/70 bg-white/80 px-4 py-4">
                  <div className="space-y-3">
                    <label className="space-y-2">
                      <FieldLabel label={t("规则类型", "Rule type")} />
                      <Select.Root
                        value={ruleType}
                        onValueChange={(value) => setRuleType(value as Rule["type"])}
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
                          placeholder={t(
                            "例如：面向开发者的开源工具",
                            "e.g. Open-source tools for developers"
                          )}
                        />
                      ) : (
                        <input
                          className="input-field w-full"
                          value={ruleValue}
                          onChange={(event) => setRuleValue(event.target.value)}
                          placeholder={ruleType === "urlPrefix" ? "github.com/awesome" : "linux.do"}
                        />
                      )}
                      <p className="text-xs text-slate-500">{ruleTypeHints[ruleType]}</p>
                    </label>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={saveRule}
                        className="outline-button rounded-full px-4 py-2 text-sm font-semibold"
                      >
                        {t("添加规则", "Add rule")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 text-xs text-slate-500">
                {t("保存分类后可添加规则。", "Save the category before adding rules.")}
              </div>
            )}
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
