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

export function renderMarkdown(source: string): string {
  if (!source) {
    return "";
  }
  try {
    const html = marked.parse(source, { async: false }) as string;
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ALLOWED_TAGS,
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#)/i
    });
  } catch {
    return "";
  }
}
