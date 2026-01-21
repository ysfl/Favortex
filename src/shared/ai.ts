import type { AiConfig, Category, SearchProviderConfig } from "./types";
import { DEFAULT_CATEGORY_ID } from "./state";
import { buildUrl } from "./api";
import { sanitizeText, truncateText } from "./utils";

const MAX_CHARS = 6000;
const MAX_SUMMARY_CHARS = 4000;

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
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
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
    `You summarize web pages into one concise sentence in ${language}. ` +
    "Return only the sentence, no quotes or markdown.";
  const user = `Page content:\n${trimmed}`;
  return { system, user };
}

function normalizeSummary(text: string) {
  const cleaned = sanitizeText(text).replace(/^["“]+|["”]+$/g, "");
  return truncateText(cleaned, 200);
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
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI error: ${response.status}`);
    }
    const data = await response.json();
    responseText = data?.choices?.[0]?.message?.content ?? "";
  } else if (config.type === "openai-response") {
    const apiUrl = buildUrl(config.baseUrl, "/v1/responses");
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        input: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI Response API error: ${response.status}`);
    }
    const data = await response.json();
    responseText =
      data?.output_text ??
      data?.output?.flatMap((item: { content?: { text?: string }[] }) => item.content ?? [])
        ?.map((item: { text?: string }) => item.text ?? "")
        ?.join("\n") ??
      "";
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

export async function summarizeWithAi(
  config: AiConfig,
  text: string,
  language: string
): Promise<string> {
  if (!config.apiKey || !config.baseUrl || !config.model) {
    throw new Error("AI settings are incomplete");
  }

  const { system, user } = buildSummaryPrompt(text, language);
  let responseText = "";

  if (config.type === "openai") {
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
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI error: ${response.status}`);
    }
    const data = await response.json();
    responseText = data?.choices?.[0]?.message?.content ?? "";
  } else if (config.type === "openai-response") {
    const apiUrl = buildUrl(config.baseUrl, "/v1/responses");
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        input: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI Response API error: ${response.status}`);
    }
    const data = await response.json();
    responseText =
      data?.output_text ??
      data?.output?.flatMap((item: { content?: { text?: string }[] }) => item.content ?? [])
        ?.map((item: { text?: string }) => item.text ?? "")
        ?.join("\n") ??
      "";
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

  return normalizeSummary(responseText);
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
