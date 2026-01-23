import * as Accordion from "@radix-ui/react-accordion";
import {
  ChevronDownIcon,
  ClipboardCopyIcon,
  GearIcon,
  MagnifyingGlassIcon,
  StarFilledIcon,
  StarIcon,
  TrashIcon
} from "@radix-ui/react-icons";
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../shared/hooks";
import { DEFAULT_CATEGORY_ID } from "../shared/state";
import { getDomain, truncateText } from "../shared/utils";
import { createId } from "../shared/ids";

const SHORTCUT_HINT = "Ctrl+Shift+Y";
const CATEGORY_ALL = "all";
const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

type SortMode = "recent" | "oldest" | "title";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "recent", label: "最新收藏" },
  { value: "oldest", label: "最早收藏" },
  { value: "title", label: "标题 A-Z" }
];

function formatDate(timestamp: number) {
  return DATE_FORMATTER.format(new Date(timestamp));
}

export default function App() {
  const { state, update } = useAppState();
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [categoryFilter, setCategoryFilter] = useState(CATEGORY_ALL);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<"success" | "error">("success");
  const statusTimerRef = useRef<number | null>(null);
  const fallbackIcon = useMemo(() => chrome.runtime.getURL("icons/icon-16.png"), []);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) {
        window.clearTimeout(statusTimerRef.current);
      }
    };
  }, []);

  const filtered = useMemo(() => {
    if (!state) {
      return [];
    }
    return state.bookmarks.filter(
      (item) => categoryFilter === CATEGORY_ALL || item.categoryId === categoryFilter
    );
  }, [state, categoryFilter]);

  const sorted = useMemo(() => {
    if (!filtered.length) {
      return [];
    }
    const items = [...filtered];
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      if (sortMode === "title") {
        return a.title.localeCompare(b.title, "zh-Hans-CN");
      }
      if (sortMode === "oldest") {
        return a.createdAt - b.createdAt;
      }
      return b.createdAt - a.createdAt;
    });
    return items;
  }, [filtered, sortMode]);

  const grouped = useMemo(() => {
    if (!state) {
      return [] as { id: string; name: string; color: string; items: typeof sorted }[];
    }
    const map = new Map<string, typeof sorted>();
    state.categories.forEach((category) => map.set(category.id, []));
    sorted.forEach((item) => {
      const list = map.get(item.categoryId);
      if (list) {
        list.push(item);
      } else {
        map.set(item.categoryId, [item]);
      }
    });
    const visibleCategories =
      categoryFilter === CATEGORY_ALL
        ? state.categories
        : state.categories.filter((category) => category.id === categoryFilter);
    return visibleCategories.map((category) => ({
      ...category,
      items: map.get(category.id) ?? []
    }));
  }, [state, sorted, categoryFilter]);

  const totalCount = state?.bookmarks.length ?? 0;
  const defaultCategoryName =
    state?.categories.find((category) => category.id === DEFAULT_CATEGORY_ID)?.name ??
    DEFAULT_CATEGORY_ID;
  const categories = state?.categories ?? [];
  const visibleCount = sorted.length;
  const compactMode = state?.ui.compactMode ?? false;

  const handleClassify = () => {
    setBusy(true);
    setStatus(null);
    chrome.runtime.sendMessage({ type: "CLASSIFY_CURRENT_TAB" }, (response) => {
      if (chrome.runtime.lastError) {
        const message = chrome.runtime.lastError.message || "无法连接到当前页面。";
        setTransientStatus("无法连接到当前页面。请刷新后重试。", "error");
        appendClientLog(message);
      } else if (!response?.ok) {
        const message = response?.error || "AI 分类失败，请检查配置。";
        setTransientStatus(message, "error");
        appendClientLog(message);
      } else {
        setTransientStatus("已加入智能收藏夹。", "success");
      }
      setBusy(false);
    });
  };

  const openOptions = () => {
    chrome.runtime.openOptionsPage();
  };

  const openSearchPage = () => {
    const url = chrome.runtime.getURL("search/index.html");
    chrome.tabs.create({ url });
  };

  const appendClientLog = useCallback(
    (message: string) => {
      const safeMessage = truncateText(message, 240);
      void update((current) => ({
        ...current,
        logs: [
          {
            id: createId(),
            level: "error" as const,
            message: safeMessage,
            context: "popup",
            createdAt: Date.now()
          },
          ...current.logs
        ].slice(0, 30)
      }));
    },
    [update]
  );

  const setTransientStatus = useCallback((message: string, tone: "success" | "error") => {
    setStatus(message);
    setStatusTone(tone);
    if (statusTimerRef.current !== null) {
      window.clearTimeout(statusTimerRef.current);
    }
    statusTimerRef.current = window.setTimeout(() => {
      setStatus(null);
      statusTimerRef.current = null;
    }, 2400);
  }, []);

  const togglePinned = useCallback(
    (id: string) => {
      const wasPinned = state?.bookmarks.find((bookmark) => bookmark.id === id)?.pinned ?? false;
      void update((current) => ({
        ...current,
        bookmarks: current.bookmarks.map((bookmark) =>
          bookmark.id === id ? { ...bookmark, pinned: !bookmark.pinned } : bookmark
        )
      }));
      setTransientStatus(wasPinned ? "已取消置顶" : "已置顶收藏", "success");
    },
    [state, update, setTransientStatus]
  );

  const deleteBookmark = useCallback(
    (id: string) => {
      void update((current) => ({
        ...current,
        bookmarks: current.bookmarks.filter((bookmark) => bookmark.id !== id)
      }));
      setTransientStatus("已移除收藏", "success");
    },
    [update, setTransientStatus]
  );

  const toggleCompactMode = useCallback(() => {
    if (!state) {
      return;
    }
    const nextMode = !state.ui.compactMode;
    void update((current) => ({
      ...current,
      ui: {
        ...current.ui,
        compactMode: nextMode
      }
    }));
    setTransientStatus(nextMode ? "已开启简洁模式" : "已关闭简洁模式", "success");
  }, [state, update, setTransientStatus]);

  const copyUrl = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        setTransientStatus("链接已复制", "success");
      } catch (error) {
        appendClientLog(error instanceof Error ? error.message : "复制失败");
        setTransientStatus("复制失败", "error");
      }
    },
    [appendClientLog, setTransientStatus]
  );

  return (
    <div className="popup-scroll px-4 pt-4 pb-8">
      <div className="glass-card animate-float rounded-3xl p-4">
        <header className="flex items-start justify-between gap-4">
          <div>
            <span className="chip">Smart Favorites</span>
            <h1 className="mt-2 text-xl font-semibold">Favortex</h1>
            <p className="mt-1 text-xs text-slate-600">
              快捷键 {SHORTCUT_HINT} 一键收藏
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openSearchPage}
              className="icon-button rounded-full p-2"
              aria-label="打开搜索"
              title="搜索收藏"
            >
              <MagnifyingGlassIcon />
            </button>
            <button
              type="button"
              onClick={openOptions}
              className="icon-button rounded-full p-2"
              aria-label="打开设置"
              title="设置"
            >
              <GearIcon />
            </button>
          </div>
        </header>

        <button
          type="button"
          onClick={handleClassify}
          disabled={busy}
          className={clsx(
            "gradient-button mt-4 w-full rounded-2xl px-4 py-3 text-sm font-semibold tracking-wide transition",
            busy ? "opacity-70" : "hover:-translate-y-0.5"
          )}
        >
          {busy ? "AI 正在分析..." : "智能收藏当前页面"}
        </button>

        <div className="mt-4 space-y-3">
          <div className="flex flex-col gap-2">
            <select
              className="input-field w-full"
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
              disabled={!state}
              aria-label="筛选分类"
            >
              <option value={CATEGORY_ALL}>全部分类</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <select
              className="input-field w-full"
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
              disabled={!state}
              aria-label="排序方式"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              显示 {visibleCount} / {totalCount}
            </span>
            <span>默认分类: {defaultCategoryName}</span>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              <input
                type="checkbox"
                className="h-4 w-4 accent-slate-700"
                checked={compactMode}
                onChange={toggleCompactMode}
                disabled={!state}
              />
              简洁模式
            </label>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {!state ? (
            <div className="rounded-2xl border border-white/70 bg-white/70 px-4 py-6 text-center text-sm text-slate-500">
              正在加载收藏夹...
            </div>
          ) : (
            <Accordion.Root type="multiple" className="space-y-2">
              {grouped.map((category) => (
                <Accordion.Item
                  key={category.id}
                  value={category.id}
                  className="overflow-hidden rounded-2xl border border-white/60 bg-white/70"
                >
                  <Accordion.Header>
                    <Accordion.Trigger
                      className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold"
                    >
                      <span className="flex items-center gap-2">
                        <span className={clsx("h-2.5 w-2.5 rounded-full", category.color)} />
                        {category.name}
                        <span className="text-xs font-normal text-slate-500">
                          {category.items.length}
                        </span>
                      </span>
                      <ChevronDownIcon className="text-slate-500 transition" />
                    </Accordion.Trigger>
                  </Accordion.Header>
                  <Accordion.Content className="space-y-3 px-4 pb-4 text-xs text-slate-600">
                    {category.items.length === 0 ? (
                      <div className="rounded-xl bg-white/80 px-3 py-2 text-center text-slate-500">
                        还没有收藏内容
                      </div>
                    ) : (
                      category.items.slice(0, 6).map((item) => {
                        const favicon = item.favicon || fallbackIcon;
                        if (compactMode) {
                          return (
                            <div
                              key={item.id}
                              className="bookmark-row rounded-xl border border-white/70 bg-white/80 px-3 py-2 transition hover:-translate-y-0.5"
                            >
                              <img
                                src={favicon}
                                alt=""
                                aria-hidden="true"
                                loading="lazy"
                                className="favicon"
                                onError={(event) => {
                                  if (event.currentTarget.src !== fallbackIcon) {
                                    event.currentTarget.src = fallbackIcon;
                                  }
                                }}
                              />
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800 hover:text-slate-900"
                                title={item.title || item.url}
                              >
                                {item.title || item.url}
                              </a>
                              <div className="bookmark-actions ml-auto flex items-center gap-2">
                                <button
                                  type="button"
                                  className="icon-button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    togglePinned(item.id);
                                  }}
                                  aria-label={item.pinned ? "取消置顶" : "置顶"}
                                  title={item.pinned ? "取消置顶" : "置顶"}
                                >
                                  {item.pinned ? <StarFilledIcon /> : <StarIcon />}
                                </button>
                                <button
                                  type="button"
                                  className="icon-button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    void copyUrl(item.url);
                                  }}
                                  aria-label="复制链接"
                                  title="复制链接"
                                >
                                  <ClipboardCopyIcon />
                                </button>
                                <button
                                  type="button"
                                  className="icon-button"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    deleteBookmark(item.id);
                                  }}
                                  aria-label="删除收藏"
                                  title="删除收藏"
                                >
                                  <TrashIcon />
                                </button>
                              </div>
                            </div>
                          );
                        }
                        return (
                          <div
                            key={item.id}
                            className="rounded-xl border border-white/70 bg-white/80 px-3 py-2 transition hover:-translate-y-0.5"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex min-w-0 items-start gap-2">
                                <img
                                  src={favicon}
                                  alt=""
                                  aria-hidden="true"
                                  loading="lazy"
                                  className="favicon mt-0.5"
                                  onError={(event) => {
                                    if (event.currentTarget.src !== fallbackIcon) {
                                      event.currentTarget.src = fallbackIcon;
                                    }
                                  }}
                                />
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sm font-semibold text-slate-800 line-clamp-2 hover:text-slate-900"
                                >
                                  {item.title || item.url}
                                </a>
                              </div>
                              <button
                                type="button"
                                className="icon-button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  togglePinned(item.id);
                                }}
                                aria-label={item.pinned ? "取消置顶" : "置顶"}
                                title={item.pinned ? "取消置顶" : "置顶"}
                              >
                                {item.pinned ? <StarFilledIcon /> : <StarIcon />}
                              </button>
                            </div>
                            <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                              <span>{getDomain(item.url) || item.url}</span>
                              <span>{formatDate(item.createdAt)}</span>
                            </div>
                            <div className="mt-2 flex items-center justify-end gap-2">
                              <button
                                type="button"
                                className="icon-button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  void copyUrl(item.url);
                                }}
                                aria-label="复制链接"
                                title="复制链接"
                              >
                                <ClipboardCopyIcon />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  deleteBookmark(item.id);
                                }}
                                aria-label="删除收藏"
                                title="删除收藏"
                              >
                                <TrashIcon />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </Accordion.Content>
                </Accordion.Item>
              ))}
            </Accordion.Root>
          )}
        </div>

      </div>
      {status ? (
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
          {status}
        </div>
      ) : null}
    </div>
  );
}
