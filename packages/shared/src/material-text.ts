import { extname, posix } from "node:path";
import { SaxesParser, type SaxesTagPlain } from "saxes";
import { readZipDirectory } from "./material-zip.ts";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".jsonl", ".ndjson", ".log"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
export const MAX_MATERIAL_BYTES = 20 * 1024 * 1024;
export const MAX_MATERIAL_EXPANDED_BYTES = MAX_MATERIAL_BYTES * 20;
export const MATERIAL_PART_CHARACTERS = 200_000;
export type MaterialTextExtractor = (name: string, bytes: Uint8Array) => string | null | Promise<string | null>;

export function isExtractableMaterial(name: string): boolean {
  const extension = extname(name).toLowerCase();
  return TEXT_EXTENSIONS.has(extension) || OFFICE_EXTENSIONS.has(extension);
}

/** Decode full source text; per-model input limits belong to the Dream cycle. */
export function extractMaterialText(name: string, bytes: Uint8Array): string | null {
  if (bytes.length > MAX_MATERIAL_BYTES) throw new Error("单个文件不能超过 20 MiB");
  const extension = extname(name).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim() || null;
  if (!OFFICE_EXTENSIONS.has(extension)) return null;
  const entries = new Map(readZipDirectory(bytes, MAX_MATERIAL_EXPANDED_BYTES).map(entry => [entry.path, entry]));
  let remaining = MAX_MATERIAL_EXPANDED_BYTES;
  const read = (path: string): string => {
    const entry = entries.get(path);
    if (!entry) throw new Error("Office 正文结构不完整");
    if (entry.size > remaining) throw new Error("Office 解压内容超过 400 MiB，未截断提炼");
    remaining -= entry.size;
    return new TextDecoder("utf-8", { fatal: true }).decode(entry.read());
  };
  if (extension === ".docx") {
    const paths = ["word/document.xml", ...[...entries.keys()]
      .filter(path => /^word\/(?:header\d+|footer\d+|footnotes|endnotes)\.xml$/u.test(path))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))];
    return paths.map(path => officeParagraphs(read(path))).filter(Boolean).join("\n\n").trim() || null;
  }
  const folder = extension === ".xlsx" ? "xl" : "ppt";
  const main = extension === ".xlsx" ? "workbook" : "presentation";
  const relations = new Map<string, string>();
  scanXml(read(`${folder}/_rels/${main}.xml.rels`), {
    open(tag) {
      if (localName(tag.name) === "Relationship" && tag.attributes.TargetMode !== "External") {
        const { Id, Target } = tag.attributes;
        if (Id && Target) relations.set(Id, Target.startsWith("/") ? Target.slice(1) : posix.normalize(`${folder}/${Target}`));
      }
    },
  });
  const sections: Array<{ name: string; path: string }> = [];
  scanXml(read(`${folder}/${main}.xml`), {
    open(tag) {
      const kind = localName(tag.name);
      if (kind !== (extension === ".xlsx" ? "sheet" : "sldId")) return;
      const path = relations.get(tag.attributes["r:id"] ?? "");
      if (!path) throw new Error("Office 页面关联缺失");
      sections.push({ name: tag.attributes.name ?? `幻灯片 ${sections.length + 1}`, path });
    },
  });
  if (extension === ".pptx") {
    return sections.map(section => `## ${section.name}\n${officeParagraphs(read(section.path))}`).join("\n\n").trim() || null;
  }
  const strings: string[] = [];
  if (entries.has("xl/sharedStrings.xml")) {
    let current = "";
    let inText = false;
    let phonetic = false;
    scanXml(read("xl/sharedStrings.xml"), {
      open(tag) {
        const name = localName(tag.name);
        if (name === "si") current = "";
        if (name === "rPh") phonetic = true;
        if (name === "t") inText = !phonetic;
      },
      text(value) { if (inText) current += value; },
      close(name) {
        if (name === "t") inText = false;
        if (name === "rPh") phonetic = false;
        if (name === "si") strings.push(current);
      },
    });
  }
  let remainingText = MAX_MATERIAL_EXPANDED_BYTES;
  return sections.map(section => `## 工作表：${section.name}\n${spreadsheetText(read(section.path), strings, value => {
    remainingText -= Buffer.byteLength(value);
    if (remainingText < 0) throw new Error("Office 正文超过 400 MiB，未截断提炼");
  })}`).join("\n\n").trim() || null;
}

interface XmlVisitor {
  open?(tag: SaxesTagPlain): void;
  text?(value: string): void;
  close?(name: string): void;
}

function localName(name: string): string { return name.split(":").at(-1)!; }

function scanXml(xml: string, visitor: XmlVisitor): void {
  const parser = new SaxesParser({ xmlns: false });
  parser.on("opentag", tag => visitor.open?.(tag));
  parser.on("text", text => visitor.text?.(text));
  parser.on("cdata", text => visitor.text?.(text));
  parser.on("closetag", tag => visitor.close?.(localName(tag.name)));
  parser.write(xml).close();
}

function officeParagraphs(xml: string): string {
  const output: string[] = [];
  let inText = false;
  scanXml(xml, {
    open(tag) {
      const name = localName(tag.name);
      if (name === "t") inText = true;
      if (name === "tab") output.push("\t");
      if (name === "br" || name === "cr") output.push("\n");
    },
    text(value) { if (inText) output.push(value); },
    close(name) {
      if (name === "t") inText = false;
      if (name === "p" || name === "tr") output.push("\n");
      if (name === "tc") output.push("\t");
    },
  });
  return output.join("").trim();
}

function spreadsheetText(xml: string, strings: string[], consume: (value: string) => void): string {
  const output: string[] = [];
  let cell: { ref: string; type: string; value: string; formula: string } | undefined;
  let field = "";
  scanXml(xml, {
    open(tag) {
      const name = localName(tag.name);
      if (name === "c") cell = { ref: tag.attributes.r ?? "", type: tag.attributes.t ?? "", value: "", formula: "" };
      if (cell && ["v", "t", "f"].includes(name)) field = name;
    },
    text(value) {
      if (!cell) return;
      if (field === "f") cell.formula += value;
      else if (field) cell.value += value;
    },
    close(name) {
      if (name === field) field = "";
      if (name !== "c" || !cell) return;
      let value = cell.value;
      if (cell.type === "s") {
        const index = Number(value);
        if (!/^\d+$/u.test(value) || !Number.isSafeInteger(index) || strings[index] === undefined) throw new Error("Office 共享文本引用无效");
        value = strings[index]!;
      }
      if (cell.type === "b") value = value === "1" ? "true" : "false";
      if (cell.formula) value += ` [公式：=${cell.formula}${value ? "；值为文件保存时的缓存" : "；未计算"}]`;
      const line = `${cell.ref}\t${value}`;
      consume(line);
      output.push(line);
      cell = undefined;
    },
  });
  return output.join("\n");
}

/** Lossless slices with readable boundaries and intact Unicode surrogate pairs. */
export function splitMaterialText(text: string): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + MATERIAL_PART_CHARACTERS, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline > start + MATERIAL_PART_CHARACTERS / 2) end = newline + 1;
      else if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
