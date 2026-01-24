import { useCallback, useState } from "react";

export type LocaleCode = "zh" | "en";

const i18nApi =
  (globalThis as { chrome?: typeof chrome }).chrome?.i18n ??
  (globalThis as { browser?: typeof chrome }).browser?.i18n;

function normalizeLocale(raw: string | undefined): LocaleCode {
  if (!raw) {
    return "en";
  }
  return raw.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function getLocale(): LocaleCode {
  const raw =
    i18nApi?.getUILanguage?.() ??
    (typeof navigator !== "undefined" ? navigator.language : "en");
  return normalizeLocale(raw);
}

function formatMessage(
  message: string,
  vars?: Record<string, string | number>
): string {
  if (!vars) {
    return message;
  }
  return message.replace(/\{(\w+)\}/g, (match, key) => {
    const value = vars[key];
    return value === undefined ? match : String(value);
  });
}

export function translate(
  zh: string,
  en: string,
  vars?: Record<string, string | number>
): string {
  const locale = getLocale();
  return formatMessage(locale === "zh" ? zh : en, vars);
}

export function useI18n() {
  const [locale] = useState(getLocale());
  const t = useCallback(
    (zh: string, en: string, vars?: Record<string, string | number>) =>
      formatMessage(locale === "zh" ? zh : en, vars),
    [locale]
  );

  return { locale, t };
}
