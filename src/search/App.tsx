import {
  ClipboardCopyIcon,
  MagnifyingGlassIcon
} from "@radix-ui/react-icons";
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { answerWithAi, embedTexts, rerankTexts } from "../shared/ai";
import { useAppState } from "../shared/hooks";
import type { Bookmark } from "../shared/types";
import { buildEmbeddingFingerprint, getDomain, sanitizeText, truncateText } from "../shared/utils";

const AI_SEARCH_TOP_K = 40;
const AI_DOC_MAX_CHARS = 800;
const CHAT_CONTEXT_MAX = 8;
const CHAT_SUMMARY_MAX_CHARS = 520;
const EMBEDDING_BATCH_SIZE = 20;

type SearchMode = "classic" | "ai";
type ChatMessage = { role: "user" | "assistant"; content: string };

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (!normA || !normB) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildSearchText(bookmark: Bookmark) {
  const raw = [
    bookmark.title,
    bookmark.summaryLong || bookmark.excerpt,
    bookmark.url
  ]
    .filter(Boolean)
    .join(" · ");
  return truncateText(sanitizeText(raw), AI_DOC_MAX_CHARS);
}

export default function App() {
  const { state, update } = useAppState();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("classic");
  const [results, setResults] = useState<Bookmark[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastQuery, setLastQuery] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<"success" | "error">("success");
  const statusTimerRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fallbackIcon = useMemo(() => chrome.runtime.getURL("icons/icon-16.png"), []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (hasSearched) {
      setChatMessages([]);
      setChatInput("");
    }
  }, [hasSearched, lastQuery, mode]);

  useEffect(() => {
    return () => {
      if (statusTimerRef.current !== null) {
        window.clearTimeout(statusTimerRef.current);
      }
    };
  }, []);

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

  const getPreferredLanguage = useCallback(() => {
    try {
      return chrome.i18n.getUILanguage();
    } catch {
      return navigator.language || "en";
    }
  }, []);

  const ensureEmbeddings = useCallback(
    async (bookmarks: Bookmark[]) => {
      if (!state) {
        return bookmarks;
      }
      const { embedding } = state.search;
      if (!embedding.baseUrl || !embedding.apiKey || !embedding.model) {
        return bookmarks;
      }
      const fingerprint = buildEmbeddingFingerprint(embedding);
      const missing = bookmarks.filter(
        (bookmark) =>
          !Array.isArray(bookmark.embedding) ||
          bookmark.embedding.length === 0 ||
          bookmark.embeddingFingerprint !== fingerprint
      );
      if (!missing.length) {
        return bookmarks;
      }
      const updates: Record<string, number[]> = {};
      for (let i = 0; i < missing.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = missing.slice(i, i + EMBEDDING_BATCH_SIZE);
        const inputs = batch.map(buildSearchText);
        const vectors = await embedTexts(embedding, inputs);
        vectors.forEach((vector, index) => {
          if (Array.isArray(vector)) {
            updates[batch[index].id] = vector;
          }
        });
      }
      if (Object.keys(updates).length) {
        await update((current) => ({
          ...current,
          bookmarks: current.bookmarks.map((bookmark) =>
            updates[bookmark.id]
              ? {
                  ...bookmark,
                  embedding: updates[bookmark.id],
                  embeddingFingerprint: fingerprint
                }
              : bookmark
          )
        }));
      }
      return bookmarks.map((bookmark) =>
        updates[bookmark.id]
          ? { ...bookmark, embedding: updates[bookmark.id], embeddingFingerprint: fingerprint }
          : bookmark
      );
    },
    [state, update]
  );

  const runClassicSearch = useCallback(
    (term: string) => {
      if (!state) {
        return [];
      }
      const lower = term.toLowerCase();
      return state.bookmarks.filter((bookmark) => {
        const title = bookmark.title || "";
        const url = bookmark.url || "";
        const excerpt = bookmark.excerpt || "";
        const summaryLong = bookmark.summaryLong || "";
        return (
          title.toLowerCase().includes(lower) ||
          url.toLowerCase().includes(lower) ||
          excerpt.toLowerCase().includes(lower) ||
          summaryLong.toLowerCase().includes(lower)
        );
      });
    },
    [state]
  );

  const runAiSearch = useCallback(
    async (term: string) => {
      if (!state) {
        return [];
      }
      const { embedding, rerank, minScore } = state.search;
      if (!embedding.baseUrl || !embedding.apiKey || !embedding.model) {
        throw new Error("请先配置 Embedding 模型与 Key");
      }
      const fingerprint = buildEmbeddingFingerprint(embedding);
      const bookmarks = await ensureEmbeddings(state.bookmarks);
      if (!bookmarks.length) {
        return [];
      }
      const vectors = bookmarks
        .map((bookmark, index) => ({
          bookmark,
          index,
          vector: bookmark.embedding
        }))
        .filter(
          (item) =>
            Array.isArray(item.vector) &&
            item.vector.length > 0 &&
            item.bookmark.embeddingFingerprint === fingerprint
        );
      if (!vectors.length) {
        return [];
      }
      const [queryVector] = await embedTexts(embedding, [term]);
      const scored = vectors
        .map((item) => ({
          index: item.index,
          score: cosineSimilarity(queryVector, item.vector as number[])
        }))
        .filter((item) => item.score >= minScore)
        .sort((a, b) => b.score - a.score);
      if (!scored.length) {
        return [];
      }
      const top = scored.slice(0, Math.min(AI_SEARCH_TOP_K, scored.length));
      let orderedIndices = top.map((item) => item.index);

      if (rerank.enabled) {
        if (!rerank.baseUrl || !rerank.apiKey || !rerank.model) {
          throw new Error("请先配置 Reranker 模型与 Key");
        }
        const rerankDocs = orderedIndices.map((index) => buildSearchText(bookmarks[index]));
        const reranked = await rerankTexts(rerank, term, rerankDocs);
        if (reranked.length) {
          orderedIndices = reranked.map((item) => orderedIndices[item.index] ?? item.index);
        }
      }

      return orderedIndices.map((index) => bookmarks[index]);
    },
    [ensureEmbeddings, state]
  );

  const performSearch = useCallback(
    async (overrideQuery?: string, overrideMode?: SearchMode) => {
      const term = (overrideQuery ?? query).trim();
      if (!term) {
        setTransientStatus("请输入搜索内容", "error");
        return;
      }
      if (!state) {
        setTransientStatus("正在加载收藏数据，请稍后重试。", "error");
        return;
      }
      const activeMode = overrideMode ?? mode;
      setBusy(true);
      setHasSearched(true);
      setLastQuery(term);
      try {
        if (activeMode === "classic") {
          const next = runClassicSearch(term);
          setResults(next);
          if (!next.length) {
            setTransientStatus("没有找到匹配结果", "error");
          }
        } else {
          const next = await runAiSearch(term);
          setResults(next);
          if (!next.length) {
            setTransientStatus("AI 未找到匹配结果", "error");
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "搜索失败";
        setResults([]);
        setTransientStatus(message, "error");
      } finally {
        setBusy(false);
      }
    },
    [mode, query, runAiSearch, runClassicSearch, setTransientStatus, state]
  );

  const handleModeChange = useCallback(
    (next: SearchMode) => {
      setMode(next);
      if (hasSearched && lastQuery) {
        void performSearch(lastQuery, next);
      }
    },
    [hasSearched, lastQuery, performSearch]
  );

  const buildChatContext = useCallback((items: Bookmark[]) => {
    return items.slice(0, CHAT_CONTEXT_MAX).map((bookmark, index) => {
      const summary = truncateText(
        sanitizeText(bookmark.summaryLong || bookmark.excerpt || ""),
        CHAT_SUMMARY_MAX_CHARS
      );
      return [
        `[#${index + 1}] ${bookmark.title || bookmark.url}`,
        `URL: ${bookmark.url}`,
        summary ? `Summary: ${summary}` : ""
      ]
        .filter(Boolean)
        .join("\n");
    }).join("\n\n");
  }, []);

  const handleChatSubmit = useCallback(async () => {
    if (chatBusy) {
      return;
    }
    const question = chatInput.trim();
    if (!question) {
      return;
    }
    if (!state) {
      setTransientStatus("正在加载收藏数据，请稍后重试。", "error");
      return;
    }
    if (!results.length) {
      setTransientStatus("请先搜索获取结果", "error");
      return;
    }
    if (!state.ai.apiKey || !state.ai.baseUrl || !state.ai.model) {
      setTransientStatus("请先配置 AI 服务", "error");
      return;
    }
    setChatInput("");
    setChatBusy(true);
    setChatMessages((prev) => [...prev, { role: "user", content: question }]);
    try {
      const language = getPreferredLanguage();
      const system =
        "You answer questions using ONLY the provided bookmarks context. " +
        "If the answer is not in the context, say you cannot find it. " +
        `Reply in ${language}.`;
      const context = buildChatContext(results);
      const history = chatMessages
        .slice(-6)
        .map((message) =>
          `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`
        )
        .join("\n");
      const userPrompt = [
        "Bookmarks context:",
        context || "No results.",
        history ? `Conversation so far:\n${history}` : "",
        `User question: ${question}`
      ]
        .filter(Boolean)
        .join("\n\n");
      const reply = await answerWithAi(state.ai, system, userPrompt);
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: reply || "抱歉，我没有找到相关信息。" }
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 回答失败";
      setTransientStatus(message, "error");
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: "抱歉，回答失败，请稍后再试。" }
      ]);
    } finally {
      setChatBusy(false);
    }
  }, [
    buildChatContext,
    chatBusy,
    chatInput,
    chatMessages,
    getPreferredLanguage,
    results,
    setTransientStatus,
    state
  ]);

  const copyUrl = useCallback(
    async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        setTransientStatus("链接已复制", "success");
      } catch {
        setTransientStatus("复制失败", "error");
      }
    },
    [setTransientStatus]
  );

  const hasResults = hasSearched && results.length > 0;
  const containerClass = clsx("mx-auto flex flex-col gap-6", hasResults ? "max-w-5xl" : "max-w-2xl");

  return (
    <div className="page-scroll px-6 py-10">
      <div className={containerClass}>
        <header className={clsx("space-y-3", hasResults ? "text-left" : "text-center")}>
          <div className={clsx("space-y-1", hasResults ? "" : "items-center")}>
            <span className="chip inline-flex">Search</span>
            <h1 className="text-3xl font-semibold text-slate-900">Favortex 搜索</h1>
            <p className="text-sm text-slate-600">
              传统检索或 AI 搜索，快速找回收藏。
            </p>
          </div>
        </header>

        <div className={clsx("glass-card rounded-[32px] p-6", hasResults ? "" : "mt-4")}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  { value: "classic", label: "传统检索" },
                  { value: "ai", label: "AI 检索" }
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleModeChange(option.value)}
                  className={clsx(
                    "rounded-full px-4 py-2 text-sm font-semibold transition",
                    mode === option.value ? "gradient-button" : "outline-button"
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <div className="flex w-full flex-1 items-center gap-2 rounded-2xl border border-white/70 bg-white/80 px-4 py-3">
                <MagnifyingGlassIcon className="text-slate-400" />
                <input
                  ref={inputRef}
                  type="search"
                  className="w-full bg-transparent text-base text-slate-900 outline-none"
                  placeholder="输入关键词、网址或摘要"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void performSearch();
                    }
                  }}
                />
              </div>
              <button
                type="button"
                onClick={() => void performSearch()}
                disabled={busy || !state}
                className={clsx(
                  "gradient-button inline-flex items-center justify-center rounded-2xl px-5 py-3 text-sm font-semibold transition",
                  busy || !state ? "opacity-70" : "hover:-translate-y-0.5"
                )}
              >
                {busy ? "搜索中..." : "开始搜索"}
              </button>
            </div>
          </div>
        </div>

        {hasResults ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
            <div className="space-y-4">
              {results.map((bookmark) => {
                const favicon = bookmark.favicon || fallbackIcon;
                return (
                  <div
                    key={bookmark.id}
                    className="rounded-2xl border border-white/70 bg-white/80 px-5 py-4"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 space-y-2">
                        <div className="flex items-center gap-2 text-xs text-slate-500">
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
                          <span>{getDomain(bookmark.url) || bookmark.url}</span>
                        </div>
                        <a
                          href={bookmark.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-lg font-semibold text-slate-900 hover:text-slate-800"
                        >
                          {bookmark.title || bookmark.url}
                        </a>
                        {bookmark.excerpt ? (
                          <p className="text-sm text-slate-600 line-clamp-2">
                            {bookmark.excerpt}
                          </p>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => void copyUrl(bookmark.url)}
                        className="icon-button"
                        aria-label="复制链接"
                        title="复制链接"
                      >
                        <ClipboardCopyIcon />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex h-full flex-col rounded-3xl border border-white/70 bg-white/80 p-5">
              <div className="text-sm font-semibold text-slate-800">AI 问答</div>
              <div className="mt-4 flex-1 space-y-3 overflow-y-auto pr-1">
                {chatMessages.length ? (
                  chatMessages.map((message, index) => (
                    <div
                      key={`${message.role}-${index}`}
                      className={clsx(
                        "rounded-2xl px-4 py-3 text-sm",
                        message.role === "user"
                          ? "bg-slate-900 text-white"
                          : "bg-white text-slate-700"
                      )}
                    >
                      {message.content}
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-slate-500">
                    基于当前搜索结果进行提问。
                  </div>
                )}
                {chatBusy ? (
                  <div className="rounded-2xl bg-white px-4 py-3 text-sm text-slate-500">
                    AI 正在整理答案...
                  </div>
                ) : null}
              </div>
              <div className="mt-4 space-y-2">
                <input
                  type="text"
                  className="input-field w-full"
                  placeholder="基于搜索结果继续提问"
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  disabled={chatBusy}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleChatSubmit();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => void handleChatSubmit()}
                  disabled={chatBusy}
                  className={clsx(
                    "outline-button w-full rounded-full px-4 py-2 text-sm font-semibold",
                    chatBusy ? "opacity-70" : ""
                  )}
                >
                  {chatBusy ? "处理中..." : "发送"}
                </button>
              </div>
            </div>
          </div>
        ) : hasSearched ? (
          <div className="rounded-2xl border border-white/70 bg-white/80 px-6 py-8 text-center text-sm text-slate-500">
            暂无匹配结果，尝试更换关键词或切换搜索模式。
          </div>
        ) : null}
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
