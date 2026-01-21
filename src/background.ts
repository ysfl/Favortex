import { classifyWithAi, summarizeWithAi } from "./shared/ai";
import { DEFAULT_CATEGORY_ID } from "./shared/state";
import { loadState, updateState } from "./shared/storage";
import type { Bookmark } from "./shared/types";
import { domainMatches, getDomain, makeExcerpt, sanitizeText, truncateText } from "./shared/utils";
import type { BackgroundMessage, PageTextResponse } from "./shared/messages";
import { fetchExaContent } from "./shared/exa";
import { createId } from "./shared/ids";

const COMMAND_CLASSIFY = "classify-page";
const MAX_LOG_CHARS = 240;

const RESTRICTED_PROTOCOLS = [
  "chrome:",
  "edge:",
  "about:",
  "chrome-extension:",
  "edge-extension:"
];

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
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

function isNoReceiverError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("Receiving end does not exist");
}

async function ensureContentScript(tabId: number) {
  if (!chrome.scripting?.executeScript) {
    return false;
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
  return true;
}

async function requestPageText(tabId: number): Promise<PageTextResponse> {
  try {
    return await sendPageTextMessage(tabId);
  } catch (error) {
    if (!isNoReceiverError(error)) {
      throw error;
    }
    const injected = await ensureContentScript(tabId);
    if (!injected) {
      throw error;
    }
    return await sendPageTextMessage(tabId);
  }
}

async function setBadge(tabId: number, text: string, color: string) {
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  if (text) {
    setTimeout(() => {
      void chrome.action.setBadgeText({ tabId, text: "" });
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
  source: "exa" | "page";
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

  if (canUseExa && state.exa.enabled && state.exa.apiKey && state.exa.baseUrl) {
    try {
      const exaContent = await fetchExaContent(state.exa, url);
      if (exaContent?.text) {
        return {
          title: title || exaContent.title || url,
          url,
          text: exaContent.text,
          source: "exa"
        };
      }
      await appendLog("info", "Exa 返回空内容，已回退本地解析。", url);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Exa 请求失败";
      await appendLog("error", `Exa 解析失败：${message}`, url);
    }
  }

  const payload = await requestPageText(tabId);
  return {
    ...payload,
    source: "page"
  };
}

async function classifyActiveTab(): Promise<{ ok: boolean; error?: string }> {
  const tab = await getActiveTab();
  const tabId = tab?.id ?? null;
  if (!tabId) {
    return { ok: false, error: "未找到当前标签页。" };
  }
  if (isRestrictedUrl(tab.url)) {
    await setBadge(tabId, "NA", "#64748b");
    await appendLog("error", "该页面不允许读取内容，请在普通网页使用。", tab.url);
    return { ok: false, error: "该页面不允许读取内容，请在普通网页使用。" };
  }

  try {
    const state = await loadState();
    await setBadge(tabId, "EX", "#0f766e");
    const payload = await resolvePageText(tab, state);
    const title = payload.title || payload.url;
    const text = sanitizeText(payload.text);
    let summary = "";
    if (payload.source === "exa" && state.ai.apiKey && state.ai.baseUrl && state.ai.model) {
      try {
        summary = await summarizeWithAi(state.ai, payload.text, getPreferredLanguage());
      } catch (error) {
        const message = error instanceof Error ? error.message : "AI 概括失败";
        await appendLog("error", `AI 概括失败：${message}`, payload.url);
      }
    }

    const domain = getDomain(payload.url);
    const matchedRule = state.rules
      .filter((rule) => domainMatches(rule.domain, domain))
      .sort((a, b) => b.domain.length - a.domain.length)[0];

    let categoryId = matchedRule?.categoryId ?? DEFAULT_CATEGORY_ID;

    if (!matchedRule) {
      await setBadge(tabId, "UN", "#0f766e");
      const result = await classifyWithAi(state.ai, state.categories, title, payload.url, text);
      categoryId = result.categoryId;
    }

    const resolvedCategoryId = state.categories.some((category) => category.id === categoryId)
      ? categoryId
      : DEFAULT_CATEGORY_ID;

    await updateState((current) => {
      const existing = current.bookmarks.find((item) => item.url === payload.url);
      const excerpt = summary || makeExcerpt(text);

      if (existing) {
        const updated: Bookmark = {
          ...existing,
          title,
          excerpt,
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
    await setBadge(tabId, "ERR", "#b42318");
    const message = error instanceof Error ? error.message : "未知错误";
    await appendLog("error", message, tab?.url);
    return { ok: false, error: message };
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === COMMAND_CLASSIFY) {
    void classifyActiveTab();
  }
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  if (message?.type === "CLASSIFY_CURRENT_TAB") {
    classifyActiveTab().then((result) => sendResponse(result));
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
