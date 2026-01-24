import DOMPurify from "dompurify";
import { marked } from "marked";

const purifier = DOMPurify;

purifier.addHook("afterSanitizeAttributes", (node) => {
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
  const html = marked.parse(source, { async: false }) as string;
  return purifier.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|#)/i
  });
}
