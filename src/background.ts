import {
  classifyAndSummarizeWithAi,
  classifyWithAi,
  embedTexts,
  summarizeWithAi
} from "./shared/ai";
import { DEFAULT_CATEGORY_ID } from "./shared/state";
import { loadState, updateState } from "./shared/storage";
import type { Bookmark } from "./shared/types";
import {
  buildEmbeddingFingerprint,
  domainMatches,
  getDomain,
  makeExcerpt,
  makeLongSummary,
  sanitizeText,
  truncateText,
  urlPrefixMatches
} from "./shared/utils";
import type { BackgroundMessage, PageMetaResponse, PageTextResponse } from "./shared/messages";
import { fetchExaContent } from "./shared/exa";
import { createId } from "./shared/ids";
import { translate } from "./shared/i18n";

const COMMAND_CLASSIFY = "classify-page";
const MAX_LOG_CHARS = 240;
const MAX_FAVICON_BYTES = 48 * 1024;
const FAVICON_BACKFILL_LIMIT = 6;

const RESTRICTED_PROTOCOLS = [
  "chrome:",
  "edge:",
  "about:",
  "chrome-extension:",
  "edge-extension:"
];

const actionApi = chrome.action ?? chrome.browserAction;

async function queryTabs(queryInfo: chrome.tabs.QueryInfo) {
  if (!chrome.tabs?.query) {
    return [];
  }
  return new Promise<chrome.tabs.Tab[]>((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs);
    });
  });
}

async function getActiveTab() {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

function isRestrictedUrl(url?: string) {
  if (!url) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return RESTRICTED_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return true;
  }
}

function getRuleSpecificity(rule: { type: string; value: string }) {
  const value = rule.value.trim().toLowerCase();
  if (rule.type === "urlPrefix") {
    return value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").length;
  }
  return value.length;
}

function sendPageTextMessage(tabId: number): Promise<PageTextResponse> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_TEXT" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error("No response from content script"));
        return;
      }
      resolve(response as PageTextResponse);
    });
  });
}

function sendPageMetaMessage(tabId: number): Promise<PageMetaResponse> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_META" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error("No response from content script"));
        return;
      }
      resolve(response as PageMetaResponse);
    });
  });
}

function isNoReceiverError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Receiving end does not exist");
}

function isMissingTabError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("No tab with id");
}

async function ensureContentScript(tabId: number) {
  if (chrome.scripting?.executeScript) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return true;
  }
  if (chrome.tabs?.executeScript) {
    await new Promise<void>((resolve, reject) => {
      chrome.tabs.executeScript(tabId, { file: "content.js" }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
    return true;
  }
  return false;
}

async function requestPageText(tabId: number): Promise<PageTextResponse> {
  try {
    return await sendPageTextMessage(tabId);
  } catch (error) {
    if (isMissingTabError(error) || !isNoReceiverError(error)) {
      throw error;
    }
    const injected = await ensureContentScript(tabId);
    if (!injected) {
      throw error;
    }
    return await sendPageTextMessage(tabId);
  }
}

async function requestPageMeta(tabId: number): Promise<PageMetaResponse> {
  try {
    return await sendPageMetaMessage(tabId);
  } catch (error) {
    if (isMissingTabError(error) || !isNoReceiverError(error)) {
      throw error;
    }
    const injected = await ensureContentScript(tabId);
    if (!injected) {
      throw error;
    }
    return await sendPageMetaMessage(tabId);
  }
}

async function setBadge(tabId: number, text: string, color: string) {
  if (!actionApi?.setBadgeText || !actionApi?.setBadgeBackgroundColor) {
    return;
  }
  await new Promise<void>((resolve) => {
    actionApi.setBadgeText({ tabId, text }, () => resolve());
  });
  await new Promise<void>((resolve) => {
    actionApi.setBadgeBackgroundColor({ tabId, color }, () => resolve());
  });
  if (text) {
    setTimeout(() => {
      actionApi.setBadgeText({ tabId, text: "" }, () => undefined);
    }, 2200);
  }
}

async function appendLog(level: "info" | "error", message: string, context?: string) {
  const safeMessage = truncateText(message, MAX_LOG_CHARS);
  await updateState((current) => {
    const next = [
      {
        id: createId(),
        level,
        message: safeMessage,
        context,
        createdAt: Date.now()
      },
      ...current.logs
    ].slice(0, 30);
    return {
      ...current,
      logs: next
    };
  });
}

type ResolvedPage = {
  title: string;
  url: string;
  text: string;
  icons: string[];
  source: "exa" | "page";
  exaFallback: boolean;
};

function getPreferredLanguage() {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return "en";
  }
}

async function resolvePageText(
  tab: chrome.tabs.Tab,
  state: Awaited<ReturnType<typeof loadState>>
): Promise<ResolvedPage> {
  const tabId = tab.id ?? null;
  if (!tabId) {
    throw new Error("Missing tab id");
  }
  const url = tab.url ?? "";
  const title = tab.title ?? "";
  const canUseExa = url.startsWith("http://") || url.startsWith("https://");
  const canAttemptExa =
    canUseExa && state.exa.enabled && Boolean(state.exa.apiKey && state.exa.baseUrl);

  if (canAttemptExa) {
    try {
      const exaContent = await fetchExaContent(state.exa, url);
      if (exaContent?.text) {
        let icons: string[] = [];
        try {
          const meta = await requestPageMeta(tabId);
          icons = meta.icons ?? [];
        } catch {
          icons = [];
        }
        return {
          title: title || exaContent.title || url,
          url,
          text: exaContent.text,
          icons,
          source: "exa",
          exaFallback: false
        };
      }
      await appendLog(
        "info",
        translate(
          "Exa 返回空内容，已回退本地解析。",
          "Exa returned empty content, falling back to local parsing."
        ),
        url
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : translate("Exa 请求失败", "Exa request failed.");
      await appendLog(
        "error",
        translate("Exa 解析失败：{message}", "Exa parsing failed: {message}", { message }),
        url
      );
    }
  }

  const payload = await requestPageText(tabId);
  return {
    ...payload,
    icons: payload.icons ?? [],
    source: "page",
    exaFallback: canAttemptExa
  };
}

function stripHtmlTags(text: string) {
  return text.replace(/<[^>]*>/g, " ");
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function buildFaviconCandidates(url: string, icons: string[]) {
  const unique = new Set<string>();
  const candidates: string[] = [];
  icons.forEach((icon) => {
    if (icon && !unique.has(icon)) {
      unique.add(icon);
      candidates.push(icon);
    }
  });
  try {
    const fallback = new URL("/favicon.ico", url).toString();
    if (!unique.has(fallback)) {
      unique.add(fallback);
      candidates.push(fallback);
    }
  } catch {
    return candidates;
  }
  return candidates;
}

async function fetchFaviconData(url: string, icons: string[]) {
  const candidates = buildFaviconCandidates(url, icons);
  for (const iconUrl of candidates) {
    if (iconUrl.startsWith("data:")) {
      return iconUrl;
    }
    try {
      const response = await fetch(iconUrl);
      if (!response.ok) {
        continue;
      }
      const contentType = response.headers.get("content-type") || "image/png";
      if (!contentType.startsWith("image/")) {
        continue;
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_FAVICON_BYTES) {
        continue;
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_FAVICON_BYTES) {
        continue;
      }
      const base64 = arrayBufferToBase64(buffer);
      return `data:${contentType};base64,${base64}`;
    } catch {
      continue;
    }
  }
  return "";
}

async function backfillFavicons() {
  const state = await loadState();
  const missing = state.bookmarks.filter((bookmark) => !bookmark.favicon);
  if (!missing.length) {
    return;
  }
  const updates: Record<string, string> = {};
  for (const bookmark of missing.slice(0, FAVICON_BACKFILL_LIMIT)) {
    const favicon = await fetchFaviconData(bookmark.url, []);
    if (favicon) {
      updates[bookmark.id] = favicon;
    }
  }
  if (!Object.keys(updates).length) {
    return;
  }
  await updateState((current) => ({
    ...current,
    bookmarks: current.bookmarks.map((bookmark) =>
      updates[bookmark.id]
        ? { ...bookmark, favicon: updates[bookmark.id] }
        : bookmark
    )
  }));
}

async function classifyActiveTab(): Promise<{ ok: boolean; error?: string }> {
  let tabId: number | null = null;
  let tabUrl: string | undefined;
  try {
    const tab = await getActiveTab();
    tabId = tab?.id ?? null;
    tabUrl = tab?.url;
    if (!tabId) {
      return {
        ok: false,
        error: translate("未找到当前标签页。", "Could not find the active tab.")
      };
    }
    if (isRestrictedUrl(tab.url)) {
      await setBadge(tabId, "NA", "#64748b");
      await appendLog(
        "error",
        translate(
          "该页面不允许读取内容，请在普通网页使用。",
          "This page cannot be read. Use a regular webpage."
        ),
        tab.url
      );
      return {
        ok: false,
        error: translate(
          "该页面不允许读取内容，请在普通网页使用。",
          "This page cannot be read. Use a regular webpage."
        )
      };
    }
    const state = await loadState();
    await setBadge(tabId, "EX", "#0f766e");
    const payload = await resolvePageText(tab, state);
    const title = payload.title || payload.url;
    const text = sanitizeText(payload.text);
    const textForAi = payload.exaFallback ? sanitizeText(stripHtmlTags(payload.text)) : text;

    const domain = getDomain(payload.url);
    const matchedRule = state.rules
      .filter((rule) => {
        if (rule.type === "domain") {
          return domainMatches(rule.value, domain);
        }
        if (rule.type === "urlPrefix") {
          return urlPrefixMatches(rule.value, payload.url);
        }
        return false;
      })
      .sort((a, b) => getRuleSpecificity(b) - getRuleSpecificity(a))[0];

    let categoryId = matchedRule?.categoryId ?? DEFAULT_CATEGORY_ID;
    let summaryShort = "";
    let summaryLong = "";
    const canUseAi = state.ai.apiKey && state.ai.baseUrl && state.ai.model;
    const shouldSummarize = (payload.source === "exa" || payload.exaFallback) && canUseAi;
    let classified = Boolean(matchedRule);

    if (!matchedRule && shouldSummarize) {
      await setBadge(tabId, "UN", "#0f766e");
      try {
        const combined = await classifyAndSummarizeWithAi(
          state.ai,
          state.categories,
          state.rules,
          title,
          payload.url,
          textForAi,
          getPreferredLanguage()
        );
        categoryId = combined.categoryId;
        summaryShort = combined.summaryShort;
        summaryLong = combined.summaryLong;
        classified = true;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : translate("AI 分类与概括失败", "AI classification and summary failed.");
        await appendLog(
          "error",
          translate("AI 分类与概括失败：{message}", "AI classification/summary failed: {message}", {
            message
          }),
          payload.url
        );
      }
    }

    if (shouldSummarize && !summaryShort) {
      try {
        const summary = await summarizeWithAi(state.ai, textForAi, getPreferredLanguage());
        summaryShort = summary.summaryShort;
        summaryLong = summary.summaryLong;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : translate("AI 概括失败", "AI summary failed.");
        await appendLog(
          "error",
          translate("AI 概括失败：{message}", "AI summary failed: {message}", { message }),
          payload.url
        );
      }
    }

    if (!matchedRule && !classified) {
      await setBadge(tabId, "UN", "#0f766e");
      const result = await classifyWithAi(
        state.ai,
        state.categories,
        state.rules,
        title,
        payload.url,
        textForAi
      );
      categoryId = result.categoryId;
    }

    const resolvedCategoryId = state.categories.some((category) => category.id === categoryId)
      ? categoryId
      : DEFAULT_CATEGORY_ID;

    const existingBookmark = state.bookmarks.find((item) => item.url === payload.url);
    const resolvedFavicon =
      existingBookmark?.favicon || (await fetchFaviconData(payload.url, payload.icons));
    const resolvedSummaryShort = summaryShort || makeExcerpt(text);
    const resolvedSummaryLong = summaryLong || summaryShort || makeLongSummary(text);

    let embedding: number[] | undefined;
    const embeddingConfig = state.search.embedding;
    const canEmbed =
      embeddingConfig.baseUrl && embeddingConfig.apiKey && embeddingConfig.model;
    const embeddingFingerprint = canEmbed
      ? buildEmbeddingFingerprint(embeddingConfig)
      : "";
    if (canEmbed) {
      const embeddingText = sanitizeText(
        [title, resolvedSummaryLong, payload.url].filter(Boolean).join(" · ")
      );
      try {
        const vectors = await embedTexts(embeddingConfig, [embeddingText]);
        embedding = vectors[0];
      } catch (error) {
        const message =
          error instanceof Error ? error.message : translate("Embedding 失败", "Embedding failed.");
        await appendLog(
          "error",
          translate("Embedding 失败：{message}", "Embedding failed: {message}", { message }),
          payload.url
        );
      }
    }

    await updateState((current) => {
      const existing = current.bookmarks.find((item) => item.url === payload.url);
      const excerpt = resolvedSummaryShort;

      if (existing) {
        const updated: Bookmark = {
          ...existing,
          title,
          excerpt,
          summaryLong: resolvedSummaryLong,
          embedding: embedding ?? existing.embedding,
          embeddingFingerprint: embedding ? embeddingFingerprint : existing.embeddingFingerprint,
          favicon: existing.favicon || resolvedFavicon,
          categoryId: resolvedCategoryId,
          createdAt: Date.now()
        };
        return {
          ...current,
          bookmarks: [updated, ...current.bookmarks.filter((item) => item.id !== existing.id)]
        };
      }

      const bookmark: Bookmark = {
        id: createId(),
        url: payload.url,
        title,
        excerpt,
        summaryLong: resolvedSummaryLong,
        embedding,
        embeddingFingerprint: embedding ? embeddingFingerprint : undefined,
        favicon: resolvedFavicon || undefined,
        categoryId: resolvedCategoryId,
        pinned: false,
        createdAt: Date.now()
      };

      return {
        ...current,
        bookmarks: [bookmark, ...current.bookmarks]
      };
    });

    await setBadge(tabId, "OK", "#0f766e");
    return { ok: true };
  } catch (error) {
    if (tabId) {
      await setBadge(tabId, "ERR", "#b42318");
    }
    const isMissing = isMissingTabError(error);
    const message = isMissing
      ? translate("标签页已关闭或不存在。", "The tab was closed or no longer exists.")
      : error instanceof Error
        ? error.message
        : translate("未知错误", "Unknown error.");
    if (!isMissing) {
      await appendLog("error", message, tabUrl);
    }
    return { ok: false, error: message };
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === COMMAND_CLASSIFY) {
    void classifyActiveTab().catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  if (message?.type === "CLASSIFY_CURRENT_TAB") {
    classifyActiveTab()
      .then((result) => sendResponse(result))
      .catch((error) => {
        const message = isMissingTabError(error)
          ? translate("标签页已关闭或不存在。", "The tab was closed or no longer exists.")
          : error instanceof Error
            ? error.message
            : translate("未知错误", "Unknown error.");
        sendResponse({ ok: false, error: message });
      });
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    const url = chrome.runtime.getURL("onboarding/index.html");
    void chrome.tabs.create({ url });
  }
});

chrome.runtime.onStartup.addListener(() => {
  void backfillFavicons();
});

void backfillFavicons();
