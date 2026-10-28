import type { Attachment } from "@homeagent/shared";

export interface DocumentImage {
  attachment: Attachment;
  token?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decode(value: string): string {
  return value.replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">").replace(/&amp;/gu, "&");
}

/** Keep the original body and its resource aliases; never treat comments as images. */
export function documentImages(content: string, referenceMap: unknown): DocumentImage[] {
  const images = new Map<string, DocumentImage>();
  const groups = record(referenceMap);
  const add = (attrs: Record<string, unknown>, alias?: string) => {
    const source = text(attrs.token) ?? text(attrs.file_token) ?? text(attrs.src);
    const ref = alias ?? source ?? text(attrs.url) ?? text(attrs.href) ?? `unresolved-image-${images.size + 1}`;
    if (!alias && source && [...images.values()].some(image => image.token === source)) return;
    // Resource tokens are opaque identifiers, not URLs or local paths.
    const token = source && /^[a-zA-Z0-9_-]+$/u.test(source) ? source : undefined;
    const name = (text(attrs.name) ?? text(attrs.caption) ?? text(attrs.alt))?.slice(0, 500);
    images.set(ref, { attachment: { kind: "image", ref, ...(name ? { name } : {}) }, ...(token ? { token } : {}) });
  };
  for (const group of ["image", "img"]) {
    for (const [ref, attrs] of Object.entries(record(groups[group]))) add(record(attrs), ref);
  }
  const body = content.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/gu, "\n")
    .replace(/<(?:pre|code)\b[^>]*>[\s\S]*?<\/(?:pre|code)>/giu, "")
    .replace(/`+[^`\n]*`+/gu, "");
  for (const match of body.matchAll(/(?<!\\)<img\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?\s*>/giu)) {
    const attrs: Record<string, string> = {};
    for (const attr of match[1]!.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
      attrs[attr[1]!] = decode(attr[2] ?? attr[3] ?? "");
    }
    const alias = attrs.ref;
    if (alias && images.has(alias)) continue;
    add(attrs, alias);
  }
  const definitions = new Map<string, string>();
  for (const match of body.matchAll(/^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/gmu)) definitions.set(match[1]!.toLowerCase(), match[2]!);
  for (const match of body.matchAll(/(?<!\\)!\[([^\]]*)\](?:\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)|\[([^\]]*)\])/gu)) {
    const ref = match[2] ?? match[3] ?? definitions.get((match[4] || match[1]!).toLowerCase()) ?? match[4];
    if (!ref || images.has(ref)) continue;
    add({ src: decode(ref), alt: match[1] });
  }
  return [...images.values()];
}

export function imageFileName(name: string | undefined, header: Uint8Array, ordinal: number): string {
  const bytes = Buffer.from(header);
  const hex = bytes.subarray(0, 4).toString("hex");
  const extension = hex === "89504e47" ? "png" : hex.startsWith("ffd8ff") ? "jpg"
    : bytes.subarray(0, 3).toString() === "GIF" ? "gif"
    : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "webp"
    : bytes.subarray(0, 2).toString() === "BM" ? "bmp" : undefined;
  const base = name?.replace(/[\\/\u0000-\u001f]/gu, "_").slice(0, 480) || `配图-${ordinal}`;
  return extension ? (base.toLowerCase().endsWith(`.${extension}`) ? base : `${base}.${extension}`)
    : /\.[a-zA-Z0-9]{1,8}$/u.test(base) ? base : `${base}.bin`;
}

export function documentBody(value: unknown): { content: string; referenceMap: unknown } | null {
  const parsed = record(value);
  if (parsed.ok === false || (typeof parsed.code === "number" && parsed.code !== 0)) return null;
  const data = record(parsed.data);
  const document = record(data.document);
  for (const content of [document.content, parsed.markdown, parsed.content, data.markdown, data.content]) {
    if (typeof content === "string" && content.trim()) {
      return { content, referenceMap: document.reference_map ?? data.reference_map ?? parsed.reference_map };
    }
  }
  return null;
}
