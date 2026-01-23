import type { AiConfig, Category, SearchProviderConfig } from "./types";
import { DEFAULT_CATEGORY_ID } from "./state";
import { buildUrl } from "./api";
import { sanitizeText, truncateText } from "./utils";

const MAX_CHARS = 6000;
const MAX_SUMMARY_CHARS = 4000;
const SHORT_SUMMARY_LIMIT = 180;
const LONG_SUMMARY_LIMIT = 600;

function buildPrompt(categories: Category[], title: string, url: string, text: string) {
  const trimmed = sanitizeText(text).slice(0, MAX_CHARS);
  const list = categories
    .map((category) => `- ${category.id}: ${category.name}`)
    .join("\n");

  const system =
    "You are a precise bookmark classifier. Choose the single best category id from the list. Respond with ONLY JSON: {\"categoryId\": \"...\"}. If unsure, use \"inbox\".";

  const user = `Categories:\n${list}\n\nPage title: ${title}\nPage url: ${url}\n\nPage content (plain text excerpt):\n${trimmed}`;

  return { system, user };
}

function extractJson(text: string) {
  if (!text) {
    return null;
  }
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function pickCategoryId(raw: string, categories: Category[]) {
  const parsed = extractJson(raw);
  if (parsed && typeof parsed.categoryId === "string") {
    return parsed.categoryId;
  }
  const lower = raw.toLowerCase();
  const byId = categories.find((category) => lower.includes(category.id.toLowerCase()));
  if (byId) {
    return byId.id;
  }
  const byName = categories.find((category) => raw.includes(category.name));
  return byName ? byName.id : null;
}

function buildSummaryPrompt(text: string, language: string) {
  const trimmed = sanitizeText(text).slice(0, MAX_SUMMARY_CHARS);
  const system =
    `You summarize web pages into two sentences in ${language}. ` +
    `Return ONLY JSON: {"summaryShort":"...","summaryLong":"..."}. ` +
    "summaryShort must be a single concise sentence. " +
    "summaryLong should be a fuller one-sentence recap. " +
    "Do not use markdown or quotes.";
  const user = `Page content:\n${trimmed}`;
  return { system, user };
}

function buildCombinedPrompt(
  categories: Category[],
  title: string,
  url: string,
  text: string,
  language: string
) {
  const trimmed = sanitizeText(text).slice(0, MAX_SUMMARY_CHARS);
  const list = categories
    .map((category) => `- ${category.id}: ${category.name}`)
    .join("\n");

  const system =
    `You are a precise bookmark classifier and summarizer. ` +
    `Respond with ONLY JSON: {"categoryId":"...","summaryShort":"...","summaryLong":"..."}. ` +
    `Both summaries must be one sentence in ${language}. ` +
    `summaryShort is brief, summaryLong is more detailed. ` +
    `If unsure, use "inbox" for categoryId. Do not use markdown or quotes.`;
  const user =
    `Categories:\n${list}\n\n` +
    `Page title: ${title}\nPage url: ${url}\n\n` +
    `Page content:\n${trimmed}`;
  return { system, user };
}

function normalizeSummary(text: string, maxLength: number) {
  const cleaned = sanitizeText(text).replace(/^["“]+|["”]+$/g, "");
  return truncateText(cleaned, maxLength);
}

function extractChatOutputText(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const data = payload as {
    choices?: {
      delta?: { content?: string };
      message?: { content?: string };
    }[];
  };
  const first = data.choices?.[0];
  if (first?.delta?.content) {
    return first.delta.content;
  }
  if (first?.message?.content) {
    return first.message.content;
  }
  return "";
}

function extractResponseOutputText(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const data = payload as {
    type?: string;
    delta?: string;
    text?: string;
    output_text?: string;
    response?: { output_text?: string; output?: { content?: { text?: string }[] }[] };
    output?: { content?: { text?: string }[] }[];
  };
  if (data.type === "response.output_text.delta" && typeof data.delta === "string") {
    return data.delta;
  }
  if (typeof data.delta === "string") {
    return data.delta;
  }
  if (typeof data.text === "string") {
    return data.text;
  }
  if (typeof data.output_text === "string") {
    return data.output_text;
  }
  if (data.response?.output_text) {
    return data.response.output_text;
  }
  const buckets = [data.output, data.response?.output].filter(Boolean);
  for (const bucket of buckets) {
    for (const item of bucket ?? []) {
      for (const part of item.content ?? []) {
        if (typeof part.text === "string") {
          return part.text;
        }
      }
    }
  }
  return "";
}

async function readSseResponse(
  response: Response,
  extractText: (payload: unknown) => string
): Promise<string> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    try {
      const data = await response.json();
      return extractText(data);
    } catch {
      return "";
    }
  }
  if (!response.body) {
    const data = await response.json();
    return extractText(data);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let hadDelta = false;

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data:")) {
      return;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return;
    }
    try {
      const parsed = JSON.parse(payload);
      const text = extractText(parsed);
      if (!text) {
        return;
      }
      if (parsed?.type === "response.output_text.delta" || parsed?.choices) {
        output += text;
        hadDelta = true;
      } else if (!hadDelta) {
        output = text;
      }
    } catch {
      return;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      processLine(line);
    }
  }

  const leftover = buffer.trim();
  if (leftover) {
    if (leftover.startsWith("data:")) {
      processLine(leftover);
    } else {
      try {
        output = extractText(JSON.parse(leftover)) || output;
      } catch {
        return output;
      }
    }
  }

  return output;
}

async function fetchChatCompletionText(config: AiConfig, system: string, user: string) {
  const apiUrl = buildUrl(config.baseUrl, "/v1/chat/completions");
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI error: ${response.status}`);
  }
  return readSseResponse(response, extractChatOutputText);
}

async function fetchResponsesText(config: AiConfig, system: string, user: string) {
  const apiUrl = buildUrl(config.baseUrl, "/v1/responses");
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      instructions: system,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: user }]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI Response API error: ${response.status}`);
  }
  return readSseResponse(response, extractResponseOutputText);
}

export async function classifyWithAi(
  config: AiConfig,
  categories: Category[],
  title: string,
  url: string,
  text: string
): Promise<{ categoryId: string; raw: string }> {
  if (!config.apiKey || !config.baseUrl || !config.model) {
    throw new Error("AI settings are incomplete");
  }

  const { system, user } = buildPrompt(categories, title, url, text);
  let responseText = "";

  if (config.type === "openai") {
    responseText = await fetchChatCompletionText(config, system, user);
  } else if (config.type === "openai-response") {
    responseText = await fetchResponsesText(config, system, user);
  } else {
    const apiUrl = buildUrl(config.baseUrl, "/v1/messages");
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 300,
        system,
        messages: [{ role: "user", content: user }]
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic error: ${response.status}`);
    }
    const data = await response.json();
    responseText = data?.content?.[0]?.text ?? "";
  }

  const categoryId = pickCategoryId(responseText, categories) ?? DEFAULT_CATEGORY_ID;

  return { categoryId, raw: responseText };
}

export async function classifyAndSummarizeWithAi(
  config: AiConfig,
  categories: Category[],
  title: string,
  url: string,
  text: string,
  language: string
): Promise<{ categoryId: string; summaryShort: string; summaryLong: string; raw: string }> {
  if (!config.apiKey || !config.baseUrl || !config.model) {
    throw new Error("AI settings are incomplete");
  }

  const { system, user } = buildCombinedPrompt(categories, title, url, text, language);
  let responseText = "";

  if (config.type === "openai") {
    responseText = await fetchChatCompletionText(config, system, user);
  } else if (config.type === "openai-response") {
    responseText = await fetchResponsesText(config, system, user);
  } else {
    const apiUrl = buildUrl(config.baseUrl, "/v1/messages");
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 260,
        system,
        messages: [{ role: "user", content: user }]
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic error: ${response.status}`);
    }
    const data = await response.json();
    responseText = data?.content?.[0]?.text ?? "";
  }

  const parsed = extractJson(responseText) as {
    categoryId?: unknown;
    summary?: unknown;
    summaryShort?: unknown;
    summaryLong?: unknown;
  } | null;
  const categoryId =
    parsed && typeof parsed.categoryId === "string"
      ? parsed.categoryId
      : pickCategoryId(responseText, categories) ?? DEFAULT_CATEGORY_ID;
  const summaryShort =
    parsed && typeof parsed.summaryShort === "string"
      ? normalizeSummary(parsed.summaryShort, SHORT_SUMMARY_LIMIT)
      : parsed && typeof parsed.summary === "string"
        ? normalizeSummary(parsed.summary, SHORT_SUMMARY_LIMIT)
        : "";
  const summaryLong =
    parsed && typeof parsed.summaryLong === "string"
      ? normalizeSummary(parsed.summaryLong, LONG_SUMMARY_LIMIT)
      : summaryShort;

  return { categoryId, summaryShort, summaryLong, raw: responseText };
}

export async function summarizeWithAi(
  config: AiConfig,
  text: string,
  language: string
): Promise<{ summaryShort: string; summaryLong: string }> {
  if (!config.apiKey || !config.baseUrl || !config.model) {
    throw new Error("AI settings are incomplete");
  }

  const { system, user } = buildSummaryPrompt(text, language);
  let responseText = "";

  if (config.type === "openai") {
    responseText = await fetchChatCompletionText(config, system, user);
  } else if (config.type === "openai-response") {
    responseText = await fetchResponsesText(config, system, user);
  } else {
    const apiUrl = buildUrl(config.baseUrl, "/v1/messages");
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 120,
        system,
        messages: [{ role: "user", content: user }]
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic error: ${response.status}`);
    }
    const data = await response.json();
    responseText = data?.content?.[0]?.text ?? "";
  }

  const parsed = extractJson(responseText) as {
    summary?: unknown;
    summaryShort?: unknown;
    summaryLong?: unknown;
  } | null;
  const summaryShort =
    parsed && typeof parsed.summaryShort === "string"
      ? normalizeSummary(parsed.summaryShort, SHORT_SUMMARY_LIMIT)
      : parsed && typeof parsed.summary === "string"
        ? normalizeSummary(parsed.summary, SHORT_SUMMARY_LIMIT)
        : normalizeSummary(responseText, SHORT_SUMMARY_LIMIT);
  const summaryLong =
    parsed && typeof parsed.summaryLong === "string"
      ? normalizeSummary(parsed.summaryLong, LONG_SUMMARY_LIMIT)
      : normalizeSummary(responseText, LONG_SUMMARY_LIMIT);

  return { summaryShort, summaryLong };
}

export async function embedTexts(
  config: SearchProviderConfig,
  inputs: string[]
): Promise<number[][]> {
  if (!config.apiKey || !config.baseUrl || !config.model) {
    throw new Error("Embedding settings are incomplete");
  }

  const apiUrl = buildUrl(config.baseUrl, "/v1/embeddings");
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      input: inputs
    })
  });

  if (!response.ok) {
    throw new Error(`Embedding error: ${response.status}`);
  }
  const data = await response.json();
  const embeddings = Array.isArray(data?.data)
    ? data.data.map((item: { embedding?: number[] }) => item.embedding)
    : null;
  if (!embeddings || embeddings.some((vec: unknown) => !Array.isArray(vec))) {
    throw new Error("Embedding response parsing failed");
  }

  return embeddings as number[][];
}

export async function answerWithAi(
  config: AiConfig,
  system: string,
  user: string
): Promise<string> {
  if (!config.apiKey || !config.baseUrl || !config.model) {
    throw new Error("AI settings are incomplete");
  }

  if (config.type === "openai") {
    return fetchChatCompletionText(config, system, user);
  }
  if (config.type === "openai-response") {
    return fetchResponsesText(config, system, user);
  }

  const apiUrl = buildUrl(config.baseUrl, "/v1/messages");
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 600,
      system,
      messages: [{ role: "user", content: user }]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic error: ${response.status}`);
  }
  const data = await response.json();
  return data?.content?.[0]?.text ?? "";
}

type RerankResult = {
  index: number;
  score: number;
};

export async function rerankTexts(
  config: SearchProviderConfig,
  query: string,
  documents: string[]
): Promise<RerankResult[]> {
  if (!config.apiKey || !config.baseUrl || !config.model) {
    throw new Error("Rerank settings are incomplete");
  }

  const apiUrl = buildUrl(config.baseUrl, "/v1/rerank");
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      query,
      documents
    })
  });

  if (!response.ok) {
    throw new Error(`Rerank error: ${response.status}`);
  }
  const data = await response.json();
  const results = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.data)
      ? data.data
      : [];
  if (!Array.isArray(results)) {
    throw new Error("Rerank response parsing failed");
  }

  return results
    .map((item: { index?: number; document?: { index?: number }; score?: number; relevance_score?: number }) => ({
      index: typeof item.index === "number" ? item.index : item.document?.index ?? -1,
      score:
        typeof item.relevance_score === "number"
          ? item.relevance_score
          : typeof item.score === "number"
            ? item.score
            : 0
    }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => b.score - a.score);
}
