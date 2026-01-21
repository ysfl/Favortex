export type ThemeId = "ocean" | "sage" | "sunset" | "slate" | "rose";

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: "ocean", label: "海雾蓝" },
  { id: "sage", label: "鼠尾草" },
  { id: "sunset", label: "暖日橙" },
  { id: "slate", label: "雾灰蓝" },
  { id: "rose", label: "柔粉调" }
];

export const DEFAULT_THEME_ID: ThemeId = "ocean";

const THEME_ID_SET = new Set(THEMES.map((theme) => theme.id));

export function isThemeId(value: string): value is ThemeId {
  return THEME_ID_SET.has(value as ThemeId);
}
