export function buildUrl(baseUrl: string, path: string) {
  try {
    const base = new URL(baseUrl);
    const baseSegments = base.pathname.split("/").filter(Boolean);
    const pathSegments = path.split("/").filter(Boolean);

    if (
      baseSegments.length &&
      pathSegments.length &&
      baseSegments[baseSegments.length - 1] === pathSegments[0]
    ) {
      pathSegments.shift();
    }

    base.pathname = `/${[...baseSegments, ...pathSegments].join("/")}`;
    return base.toString();
  } catch {
    throw new Error("Invalid base URL");
  }
}
