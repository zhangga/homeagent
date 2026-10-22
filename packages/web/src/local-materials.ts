import { createHash } from "node:crypto";
import { extname } from "node:path";
import { extractMaterialText, isExtractableMaterial, readZipDirectory, splitMaterialText, type MaterialTextExtractor } from "@homeagent/shared";
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
  textPart?: { index: number; total: number };
  archive?: { name: string; path: string; part: number; parts: number };
}

/** Validate every upload before returning any material, preventing partial input batches. */
export async function prepareLocalMaterials(input: unknown, extractText: MaterialTextExtractor = extractMaterialText): Promise<PreparedLocalMaterial[]> {
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
  // Reuse the existing per-request upload budget for expanded ZIP members.
  let remainingExpandedBytes = MAX_BYTES * MAX_FILES;
  for (const upload of uploads) {
    const name = safeUploadName(upload.name);
    const extension = extname(name).toLowerCase();
    if (upload.size > MAX_BYTES) throw new Error("单个文件不能超过 20 MiB");

    const bytes = new Uint8Array(await upload.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new Error("单个文件不能超过 20 MiB");
    const prepared = await prepareMaterial(name, bytes, extractText);
    const material = prepared[0]!;
    materials.push(...prepared);
    if (extension !== ".zip") continue;

    const notes: string[] = [];
    let noteCharacters = 0;
    const note = (message: string) => {
      if (noteCharacters >= MAX_CHARACTERS / 2) return;
      const bounded = message.slice(0, MAX_CHARACTERS / 2 - noteCharacters);
      notes.push(bounded);
      noteCharacters += bounded.length;
    };
    let extractedFiles = 0;
    let skippedFiles = 0;
    let rawParts = 0;
    try {
      const entries = readZipDirectory(bytes, MAX_BYTES);
      for (const entry of entries) {
        if (!isExtractableMaterial(entry.path) && !/\.(?:pdf|png|jpe?g|webp|gif|tiff?|bmp)$/iu.test(entry.path)) {
          skippedFiles += 1;
          note(`- ${safeArchivePath(entry.path)}：未识别文本格式，原内容保留在 ZIP 中。`);
          continue;
        }
        try {
          if (entry.size > remainingExpandedBytes) {
            throw new Error("本次解压已达到导入总字节预算 400 MiB，原内容保留在 ZIP 中");
          }
          const expanded = entry.read();
          remainingExpandedBytes -= expanded.length;
          const member = await prepareMaterial(safeUploadName(entry.path), expanded, extractText);
          if (!member[0]?.content) {
            skippedFiles += 1;
            note(`- ${safeArchivePath(entry.path)}：正文为空或不是 UTF-8 文本，或当前环境无法解析此格式。`);
            continue;
          }
          for (const [index, part] of member.entries()) {
            materials.push({
              ...part,
              archive: { name, path: safeArchivePath(entry.path), part: index + 1, parts: member.length },
            });
          }
          extractedFiles += 1;
          rawParts += member.length;
        } catch (error) {
          skippedFiles += 1;
          note(`- ${safeArchivePath(entry.path)}：${error instanceof Error ? error.message : "ZIP 条目读取失败"}`);
        }
      }
      material.content = [
        `ZIP 已展开：${extractedFiles} 个文本文件，登记为 ${rawParts} 段 Raw 正文；${skippedFiles} 个文件未提取正文。`,
        "内部正文分别登记在本 Space 的原始条目中，保留压缩包名称和内部路径。原 ZIP 已完整保存。",
        ...notes,
      ].join("\n");
    } catch {
      material.content = "ZIP 目录损坏或格式不受支持，未提取内部正文；原 ZIP 已完整保存，可下载检查。";
    }
  }
  return materials;
}

export function localMaterialRawContent(material: PreparedLocalMaterial): string {
  return [
    `# 本地资料：${material.name}`,
    "",
    `SHA-256：${material.digest}`,
    "",
    ...(material.archive ? [
      `来源压缩包：${material.archive.name}`,
      `包内路径：${material.archive.path}`,
      `正文分段：${material.archive.part}/${material.archive.parts}`,
      "",
    ] : []),
    ...(!material.archive && material.textPart ? [`正文分段：${material.textPart.index}/${material.textPart.total}`, ""] : []),
    ...(material.truncated
      ? ["正文超过限制，仅保留前 200000 个字符。", ""]
      : []),
    material.content ?? "没有可供提炼的文本；原文件已完整保存，可从原始记录详情下载。",
  ].join("\n");
}

async function prepareMaterial(name: string, bytes: Uint8Array, extractText: MaterialTextExtractor): Promise<PreparedLocalMaterial[]> {
  let decoded: string | null = null;
  try { decoded = (await extractText(name, bytes))?.trim() || null; } catch { /* Preserve unsupported or damaged originals. */ }
  const chunks = decoded ? splitMaterialText(decoded) : [null];
  const digest = createHash("sha256").update(bytes).digest("hex");
  return chunks.map((content, index) => ({
    name, digest, bytes, content, truncated: false,
    ...(chunks.length > 1 ? { textPart: { index: index + 1, total: chunks.length } } : {}),
  }));
}

function safeArchivePath(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f]/gu, " ");
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
