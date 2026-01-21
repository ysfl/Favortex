export function sanitizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function makeExcerpt(text: string, maxLength = 240): string {
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
  const domain = getDomain(url);
  if (!domain) {
    return "";
  }
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(
    domain
  )}&sz=32`;
}

export function domainMatches(ruleDomain: string, urlDomain: string): boolean {
  const rule = ruleDomain.toLowerCase();
  if (!rule || !urlDomain) {
    return false;
  }
  return urlDomain === rule || urlDomain.endsWith(`.${rule}`);
}
