export function buildUrl(baseUrl: string, path: string) {
  try {
    return new URL(path, baseUrl).toString();
  } catch {
    throw new Error("Invalid base URL");
  }
}
