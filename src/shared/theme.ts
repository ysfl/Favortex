export type ThemeId = "ocean" | "sage" | "sunset" | "slate" | "rose";

export const THEMES: { id: ThemeId; label: { zh: string; en: string } }[] = [
  { id: "ocean", label: { zh: "海雾蓝", en: "Ocean Mist" } },
  { id: "sage", label: { zh: "鼠尾草", en: "Sage" } },
  { id: "sunset", label: { zh: "暖日橙", en: "Sunset" } },
  { id: "slate", label: { zh: "雾灰蓝", en: "Slate" } },
  { id: "rose", label: { zh: "柔粉调", en: "Rose" } }
];

export const DEFAULT_THEME_ID: ThemeId = "ocean";

const THEME_ID_SET = new Set(THEMES.map((theme) => theme.id));

export function isThemeId(value: string): value is ThemeId {
  return THEME_ID_SET.has(value as ThemeId);
}
