/** Return a query-free canonical URL only for the supported GET-only surface. */
export function normalizeByteTechArticleUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:"
      || url.hostname !== "bytetech.info"
      || url.port !== ""
      || url.username !== ""
      || url.password !== ""
      || !/^\/articles\/[A-Za-z0-9][A-Za-z0-9._~-]{0,199}\/?$/u.test(url.pathname)
    ) {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function isByteTechArticleUrl(value: string): boolean {
  return normalizeByteTechArticleUrl(value) !== undefined;
}
