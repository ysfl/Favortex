import DOMPurify from "dompurify";
import { marked } from "marked";

const ALLOWED_TAGS = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul"
];

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

marked.setOptions({
  gfm: true,
  breaks: true
});

function escapeHtml(source: string) {
  return source
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMarkdown(source: string): string {
  if (!source) {
    return "";
  }
  try {
    // Always neutralize raw HTML before markdown parse to prevent remote script/style injection.
    const safeSource = escapeHtml(source);
    const html = marked.parse(safeSource, { async: false }) as string;
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ALLOWED_TAGS,
      ALLOWED_ATTR: ["href", "target", "rel"],
      FORBID_TAGS: ["script", "style", "link", "iframe", "object", "embed", "meta", "base"],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#)/i
    });
  } catch {
    return "";
  }
}
