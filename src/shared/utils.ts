import type { SearchProviderConfig } from "./types";

export function sanitizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function stripHtmlTags(text: string): string {
  if (!text) {
    return "";
  }
  return text.replace(/<[^>]*>/g, " ");
}

export function makeExcerpt(text: string, maxLength = 240): string {
  const cleaned = sanitizeText(text);
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLength).trim()}...`;
}

export function makeLongSummary(text: string, maxLength = 600): string {
  const cleaned = sanitizeText(text);
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxLength).trim()}...`;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trim()}...`;
}

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function getFaviconUrl(url: string): string {
  if (!url) {
    return "";
  }
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    const base = chrome.runtime.getURL("_favicon/");
    return `${base}?pageUrl=${encodeURIComponent(url)}&size=32`;
  }
  return `chrome://favicon2/?size=32&scale=1&url=${encodeURIComponent(url)}`;
}

export function domainMatches(ruleDomain: string, urlDomain: string): boolean {
  const rule = ruleDomain.toLowerCase();
  if (!rule || !urlDomain) {
    return false;
  }
  return urlDomain === rule || urlDomain.endsWith(`.${rule}`);
}

export function urlPrefixMatches(rulePrefix: string, url: string): boolean {
  const prefix = rulePrefix.trim();
  if (!prefix || !url) {
    return false;
  }
  const normalizedPrefix = prefix.toLowerCase();
  const normalizedUrl = url.toLowerCase();
  if (normalizedUrl.startsWith(normalizedPrefix)) {
    return true;
  }
  const withoutScheme = normalizedUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  return withoutScheme.startsWith(normalizedPrefix);
}

export function buildEmbeddingFingerprint(config: SearchProviderConfig) {
  const baseUrl = config.baseUrl.trim().toLowerCase();
  const model = config.model.trim();
  return `${config.provider}|${baseUrl}|${model}`;
}
