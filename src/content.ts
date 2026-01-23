import type { ContentMessage } from "./shared/messages";

const INJECT_FLAG = "__favortexContentInjected";
const MAX_PAGE_TEXT_CHARS = 12000;
const ICON_SELECTOR =
  'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]';

function getPageText() {
  const bodyText = document.body?.innerText || document.documentElement?.innerText || "";
  if (bodyText.length <= MAX_PAGE_TEXT_CHARS) {
    return bodyText;
  }
  return bodyText.slice(0, MAX_PAGE_TEXT_CHARS);
}

function parseIconSize(value: string | null) {
  if (!value) {
    return 0;
  }
  if (value.toLowerCase() === "any") {
    return 512;
  }
  const tokens = value.split(/\s+/);
  let max = 0;
  tokens.forEach((token) => {
    const [w, h] = token.split("x").map((part) => Number(part));
    if (!Number.isNaN(w) && !Number.isNaN(h)) {
      max = Math.max(max, Math.min(w, h));
    }
  });
  return max;
}

function getFaviconCandidates() {
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>(ICON_SELECTOR));
  const scored = links
    .map((link) => {
      const href = link.getAttribute("href");
      if (!href) {
        return null;
      }
      let url = "";
      try {
        url = new URL(href, document.baseURI).toString();
      } catch {
        return null;
      }
      const size = parseIconSize(link.getAttribute("sizes"));
      return { url, size };
    })
    .filter((item): item is { url: string; size: number } => Boolean(item && item.url));

  scored.sort((a, b) => b.size - a.size);

  const unique = new Set<string>();
  const results: string[] = [];
  scored.forEach((item) => {
    if (!unique.has(item.url)) {
      unique.add(item.url);
      results.push(item.url);
    }
  });
  return results;
}

const globalScope = globalThis as typeof globalThis & { [INJECT_FLAG]?: boolean };

if (!globalScope[INJECT_FLAG]) {
  globalScope[INJECT_FLAG] = true;
  chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
    if (message?.type === "GET_PAGE_TEXT") {
      sendResponse({
        title: document.title || "",
        url: window.location.href,
        text: getPageText(),
        icons: getFaviconCandidates()
      });
    }
    if (message?.type === "GET_PAGE_META") {
      sendResponse({
        url: window.location.href,
        icons: getFaviconCandidates()
      });
    }
  });
}
