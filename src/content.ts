import type { ContentMessage } from "./shared/messages";

const INJECT_FLAG = "__autoFavContentInjected";
const MAX_PAGE_TEXT_CHARS = 12000;

function getPageText() {
  const bodyText = document.body?.innerText || document.documentElement?.innerText || "";
  if (bodyText.length <= MAX_PAGE_TEXT_CHARS) {
    return bodyText;
  }
  return bodyText.slice(0, MAX_PAGE_TEXT_CHARS);
}

const globalScope = globalThis as typeof globalThis & { [INJECT_FLAG]?: boolean };

if (!globalScope[INJECT_FLAG]) {
  globalScope[INJECT_FLAG] = true;
  chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
    if (message?.type === "GET_PAGE_TEXT") {
      sendResponse({
        title: document.title || "",
        url: window.location.href,
        text: getPageText()
      });
    }
  });
}
