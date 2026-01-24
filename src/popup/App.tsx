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
import { getLanguageTag, useI18n } from "../shared/i18n";

const SHORTCUT_HINT = "Ctrl+Shift+Y";
type SortMode = "recent";

function formatDate(dateFormatter: Intl.DateTimeFormat, timestamp: number) {
  return dateFormatter.format(new Date(timestamp));
}

export default function App() {
  const { state, update } = useAppState();
  const { t, locale } = useI18n();
  const sortMode: SortMode = "recent";
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<"success" | "error">("success");
  const statusTimerRef = useRef<number | null>(null);
  const fallbackIcon = useMemo(() => chrome.runtime.getURL("icons/icon-16.png"), []);
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }),
    [locale]
  );

  useEffect(() => {
    document.documentElement.lang = getLanguageTag(locale);
    document.title = t("Favortex 智能收藏夹", "Favortex Smart Favorites");
  }, [locale, t]);
  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) {
        window.clearTimeout(statusTimerRef.current);
      }
    };
  }, []);

  const filtered = useMemo(() => (state ? state.bookmarks : []), [state]);

  const sorted = useMemo(() => {
    if (!filtered.length) {
      return [];
    }
    const items = [...filtered];
    items.sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
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
    return state.categories.map((category) => ({
      ...category,
      items: map.get(category.id) ?? []
    }));
  }, [state, sorted]);

  const totalCount = state?.bookmarks.length ?? 0;
  const defaultCategoryName =
    state?.categories.find((category) => category.id === DEFAULT_CATEGORY_ID)?.name ??
    DEFAULT_CATEGORY_ID;
  const visibleCount = sorted.length;
  const compactMode = state?.ui.compactMode ?? false;

  const handleClassify = () => {
    setBusy(true);
    setStatus(null);
    chrome.runtime.sendMessage({ type: "CLASSIFY_CURRENT_TAB" }, (response) => {
      if (chrome.runtime.lastError) {
        const message =
          chrome.runtime.lastError.message ||
          t("无法连接到当前页面。", "Unable to reach the page.");
        setTransientStatus(
          t("无法连接到当前页面。请刷新后重试。", "Unable to reach the page. Refresh and retry."),
          "error"
        );
        appendClientLog(message);
      } else if (!response?.ok) {
        const message = response?.error || t("AI 分类失败，请检查配置。", "AI classify failed.");
        setTransientStatus(message, "error");
        appendClientLog(message);
      } else {
        setTransientStatus(t("已加入智能收藏夹。", "Saved to Favortex."), "success");
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
      setTransientStatus(
        wasPinned ? t("已取消置顶", "Unpinned") : t("已置顶收藏", "Pinned"),
        "success"
      );
    },
    [state, update, setTransientStatus, t]
  );

  const deleteBookmark = useCallback(
    (id: string) => {
      void update((current) => ({
        ...current,
        bookmarks: current.bookmarks.filter((bookmark) => bookmark.id !== id)
      }));
      setTransientStatus(t("已移除收藏", "Removed"), "success");
    },
    [update, setTransientStatus, t]
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
    setTransientStatus(
      nextMode
        ? t("已开启简洁模式", "Compact mode enabled")
        : t("已关闭简洁模式", "Compact mode off"),
      "success"
    );
  }, [state, update, setTransientStatus, t]);

  const copyUrl = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        setTransientStatus(t("链接已复制", "Link copied"), "success");
      } catch (error) {
        appendClientLog(error instanceof Error ? error.message : t("复制失败", "Copy failed"));
        setTransientStatus(t("复制失败", "Copy failed"), "error");
      }
    },
    [appendClientLog, setTransientStatus, t]
  );

  return (
    <div className="popup-scroll px-4 pt-4 pb-8">
      <div className="glass-card animate-float rounded-3xl p-4">
        <header className="flex items-start justify-between gap-4">
          <div>
            <span className="chip">{t("智能收藏", "Smart Favorites")}</span>
            <h1 className="mt-2 text-xl font-semibold">Favortex</h1>
            <p className="mt-1 text-xs text-slate-600">
              {t("快捷键 {shortcut} 一键收藏", "Shortcut {shortcut} to save", {
                shortcut: SHORTCUT_HINT
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openSearchPage}
              className="icon-button rounded-full p-2"
              aria-label={t("打开搜索", "Open search")}
              title={t("搜索收藏", "Search bookmarks")}
            >
              <MagnifyingGlassIcon />
            </button>
            <button
              type="button"
              onClick={openOptions}
              className="icon-button rounded-full p-2"
              aria-label={t("打开设置", "Open settings")}
              title={t("设置", "Settings")}
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
            busy ? "opacity-70" : "lift-on-hover"
          )}
        >
          {busy ? t("AI 正在分析...", "AI analyzing...") : t("智能收藏当前页面", "Save current page")}
        </button>

        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              {t("显示 {visible} / {total}", "Showing {visible} / {total}", {
                visible: visibleCount,
                total: totalCount
              })}
            </span>
            <span>
              {t("默认分类: {name}", "Default: {name}", { name: defaultCategoryName })}
            </span>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              <input
                type="checkbox"
                className="h-4 w-4 accent-slate-700"
                checked={compactMode}
                onChange={toggleCompactMode}
                disabled={!state}
              />
              {t("简洁模式", "Compact mode")}
            </label>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {!state ? (
            <div className="rounded-2xl border border-white/70 bg-white/70 px-4 py-6 text-center text-sm text-slate-500">
              {t("正在加载收藏夹...", "Loading bookmarks...")}
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
                        {t("还没有收藏内容", "No bookmarks yet")}
                      </div>
                    ) : (
                      category.items.slice(0, 6).map((item) => {
                        const favicon = item.favicon || fallbackIcon;
                        if (compactMode) {
                          return (
                            <div
                              key={item.id}
                              className="bookmark-row rounded-xl border border-white/70 bg-white/80 px-3 py-2 transition lift-on-hover"
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
                                  aria-label={
                                    item.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")
                                  }
                                  title={item.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}
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
                                  aria-label={t("复制链接", "Copy link")}
                                  title={t("复制链接", "Copy link")}
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
                                  aria-label={t("删除收藏", "Delete")}
                                  title={t("删除收藏", "Delete")}
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
                            className="rounded-xl border border-white/70 bg-white/80 px-3 py-2 transition lift-on-hover"
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
                                aria-label={
                                  item.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")
                                }
                                title={item.pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}
                              >
                                {item.pinned ? <StarFilledIcon /> : <StarIcon />}
                              </button>
                            </div>
                            <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                              <span>{getDomain(item.url) || item.url}</span>
                              <span>{formatDate(dateFormatter, item.createdAt)}</span>
                            </div>
                            <div className="mt-2 flex items-center justify-end gap-2">
                              <button
                                type="button"
                                className="icon-button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  void copyUrl(item.url);
                                }}
                                aria-label={t("复制链接", "Copy link")}
                                title={t("复制链接", "Copy link")}
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
                                aria-label={t("删除收藏", "Delete")}
                                title={t("删除收藏", "Delete")}
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
