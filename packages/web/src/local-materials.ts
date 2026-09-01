import { createHash } from "node:crypto";
import { extname } from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".log",
]);
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_CHARACTERS = 200_000;
const MAX_FILES = 20;

interface LocalMaterialUpload {
  name?: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface PreparedLocalMaterial {
  name: string;
  digest: string;
  bytes: Uint8Array;
  content: string | null;
  truncated: boolean;
}

/** Validate every upload before returning any material, preventing partial input batches. */
export async function prepareLocalMaterials(input: unknown): Promise<PreparedLocalMaterial[]> {
  const candidates = Array.isArray(input) ? input : [input];
  if (
    candidates.length === 0
    || candidates.some((candidate) => !isLocalMaterialUpload(candidate))
  ) {
    throw new Error("请选择资料文件");
  }
  const uploads = candidates as LocalMaterialUpload[];
  if (uploads.length > MAX_FILES) throw new Error("一次最多选择 20 份资料");

  const materials: PreparedLocalMaterial[] = [];
  for (const upload of uploads) {
    const name = safeUploadName(upload.name);
    const extension = extname(name).toLowerCase();
    if (upload.size > MAX_BYTES) throw new Error("单个文件不能超过 20 MiB");

    const bytes = new Uint8Array(await upload.arrayBuffer());
    let decoded: string | null = null;
    if (TEXT_EXTENSIONS.has(extension)) {
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim() || null;
      } catch {
        decoded = null;
      }
    }

    materials.push({
      name,
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes,
      content: decoded?.slice(0, MAX_CHARACTERS) ?? null,
      truncated: decoded !== null && decoded.length > MAX_CHARACTERS,
    });
  }
  return materials;
}

export function localMaterialRawContent(material: PreparedLocalMaterial): string {
  return [
    `# 本地资料：${material.name}`,
    "",
    `SHA-256：${material.digest}`,
    "",
    ...(material.truncated
      ? ["正文超过限制，仅保留前 200000 个字符。", ""]
      : []),
    material.content ?? "没有可供提炼的文本；原文件已完整保存，可从原始记录详情下载。",
  ].join("\n");
}

function isLocalMaterialUpload(value: unknown): value is LocalMaterialUpload {
  return typeof value === "object"
    && value !== null
    && (
      (value as Partial<LocalMaterialUpload>).name === undefined
      || typeof (value as Partial<LocalMaterialUpload>).name === "string"
    )
    && typeof (value as Partial<LocalMaterialUpload>).size === "number"
    && typeof (value as Partial<LocalMaterialUpload>).arrayBuffer === "function";
}

function safeUploadName(input: string | undefined): string {
  const leaf = input?.split(/[\\/]/u).at(-1) ?? "";
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 255);
  return cleaned || "未命名资料";
}
