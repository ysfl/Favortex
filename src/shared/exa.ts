import type { ExaConfig } from "./types";
import { buildUrl } from "./api";
import { sanitizeText } from "./utils";

const MAX_EXA_CHARS = 12000;

type ExaContent = {
  text: string;
  title?: string;
  url?: string;
};

function normalizeText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").join("\n");
  }
  return "";
}

function pickContentItem(data: unknown): ExaContent | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const candidates = [
    (data as { contents?: unknown[] }).contents?.[0],
    (data as { results?: unknown[] }).results?.[0],
    (data as { data?: unknown[] }).data?.[0],
    (data as { content?: unknown[] }).content?.[0],
    data
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const entry = candidate as {
      text?: unknown;
      title?: string;
      url?: string;
      content?: unknown;
      document?: unknown;
      metadata?: { title?: string; url?: string };
    };
    const text = normalizeText(entry.text ?? entry.content ?? entry.document);
    if (text) {
      return {
        text,
        title: entry.title ?? entry.metadata?.title,
        url: entry.url ?? entry.metadata?.url
      };
    }
  }

  return null;
}

async function postContents(config: ExaConfig, body: Record<string, unknown>) {
  const apiUrl = buildUrl(config.baseUrl, "/contents");
  return fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(body)
  });
}

export async function fetchExaContent(
  config: ExaConfig,
  url: string
): Promise<ExaContent | null> {
  if (!config.enabled || !config.apiKey || !config.baseUrl) {
    return null;
  }

  const basePayload = {
    text: true,
    highlights: false,
    summary: false
  };

  let response = await postContents(config, { ...basePayload, url });
  if (!response.ok) {
    response = await postContents(config, { ...basePayload, urls: [url] });
  }

  if (!response.ok) {
    throw new Error(`Exa error: ${response.status}`);
  }

  let data: unknown;
  try {
    data = (await response.json()) as unknown;
  } catch {
    throw new Error("Exa response parsing failed");
  }
  const content = pickContentItem(data);
  if (!content?.text) {
    return null;
  }

  const cleaned = sanitizeText(content.text).slice(0, MAX_EXA_CHARS);
  if (!cleaned) {
    return null;
  }

  return {
    text: cleaned,
    title: content.title,
    url: content.url
  };
}
