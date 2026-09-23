import { crc32, inflateRawSync } from "node:zlib";
import { TextDecoder } from "node:util";

export interface ZipMaterialEntry {
  path: string;
  size: number;
  read(): Uint8Array;
}

const INVALID_ZIP = "ZIP 目录损坏或格式不受支持";

/** Read ZIP members in memory; archive paths are never used as filesystem paths. */
export function readZipDirectory(input: Uint8Array, maxEntryBytes: number): ZipMaterialEntry[] {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let end = bytes.length - 22;
  const minimum = Math.max(0, end - 0xffff);
  for (; end >= minimum; end -= 1) {
    if (bytes.readUInt32LE(end) === 0x06054b50
      && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  if (end < minimum) throw new Error(INVALID_ZIP);
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
    || bytes.readUInt16LE(end + 8) !== count || count === 0xffff
    || directoryStart + directorySize !== end) throw new Error(INVALID_ZIP);

  const entries: ZipMaterialEntry[] = [];
  let cursor = directoryStart;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(INVALID_ZIP);
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const disk = bytes.readUInt16LE(cursor + 34);
    const attributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || disk !== 0) throw new Error(INVALID_ZIP);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const path = decodePath(nameBytes, flags).replace(/\\/gu, "/");
    cursor = next;
    if (path.endsWith("/")) continue;
    entries.push({
      path,
      size,
      read() {
        if (!path || path.startsWith("/") || /^[a-z]:/iu.test(path)
          || path.split("/").includes("..") || /[\u0000-\u001f\u007f]/u.test(path)
          || ((attributes >>> 16) & 0xf000) === 0xa000) {
          throw new Error("ZIP 条目路径无效或为符号链接");
        }
        if (flags & 1) throw new Error("ZIP 条目已加密，无法读取正文");
        if (size > maxEntryBytes) throw new Error("ZIP 内单个文件超过 20 MiB，原内容保留在压缩包中");
        if (method !== 0 && method !== 8) throw new Error("ZIP 条目压缩方式不受支持");
        if (localOffset + 30 > directoryStart || bytes.readUInt32LE(localOffset) !== 0x04034b50
          || bytes.readUInt16LE(localOffset + 6) !== flags
          || bytes.readUInt16LE(localOffset + 8) !== method) throw new Error("ZIP 条目损坏");
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const dataStart = localOffset + 30 + localNameLength + bytes.readUInt16LE(localOffset + 28);
        if (dataStart + compressedSize > directoryStart
          || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) {
          throw new Error("ZIP 条目损坏");
        }
        const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
        let content: Uint8Array;
        try {
          content = method === 0 ? compressed : inflateRawSync(compressed, {
            maxOutputLength: Math.max(1, size),
          });
        } catch {
          throw new Error("ZIP 条目解压失败");
        }
        if (content.length !== size || crc32(content) !== checksum) throw new Error("ZIP 条目校验失败");
        return content;
      },
    });
  }
  if (cursor !== end) throw new Error(INVALID_ZIP);
  return entries;
}

function decodePath(bytes: Uint8Array, flags: number): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    if (flags & 0x800) throw new Error(INVALID_ZIP);
    // Chinese desktop ZIP tools commonly omit the UTF-8 flag and use GBK names.
    return new TextDecoder("gb18030").decode(bytes);
  }
}
