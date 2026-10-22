import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { deflateSync } from "node:zlib";
import type { DownloadedAttachment } from "@homeagent/connectors";
import {
  createNativeExtractor,
  extractAttachmentText,
  extractUploadedMaterialText,
  runBoundedProcess,
  type DeadlineFactory,
  type NativeExtractor,
  type NativeProcessRunner,
} from "./attachment-extractor.ts";

test("runBoundedProcess cancels its deadline after a fast successful command", async () => {
  let cancellations = 0;
  const deadlineFactory: DeadlineFactory = () => ({
    elapsed: new Promise<void>(() => {}),
    cancel: () => {
      cancellations += 1;
    },
  });

  expect(
    await runBoundedProcess([process.execPath, "-e", "void 0"], 200, 100, deadlineFactory),
  ).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(cancellations).toBe(1);
});

test.skipIf(process.platform === "win32")("runBoundedProcess escalates from SIGTERM and returns within a fixed bound", async () => {
  const startedAt = Date.now();
  const result = await runBoundedProcess(
    ["/bin/sh", "-c", "trap '' TERM; exec /bin/sleep 30"],
    500,
    100,
  );

  expect(result.code).toBeNull();
  expect(result.stderr).toContain("timed out");
  expect(Date.now() - startedAt).toBeLessThan(1_000);
});

test("bundled native extraction executes the precompiled Resources helper directly", async () => {
  const calls: Array<{ command: string[]; timeoutMs: number }> = [];
  const runProcess: NativeProcessRunner = async (command, timeoutMs) => {
    calls.push({ command, timeoutMs });
    return { code: 0, stdout: "bundled text", stderr: "" };
  };
  const extractor = createNativeExtractor({
    platform: "darwin",
    execPath: "/Applications/HomeAgent.app/Contents/MacOS/homeagent",
    runProcess,
  });

  expect(await extractor("image", "/tmp/scan.png")).toEqual({
    code: 0,
    stdout: "bundled text",
    stderr: "",
  });
  expect(calls).toEqual([
    {
      command: [
        resolve("/Applications/HomeAgent.app/Contents/Resources/bin/attachment-extract"),
        "image",
        "/tmp/scan.png",
      ],
      timeoutMs: 60_000,
    },
  ]);
});

test("bundled native extraction recognizes the separately embedded Bun runtime", async () => {
  const commands: string[][] = [];
  const extractor = createNativeExtractor({
    platform: "darwin",
    execPath: "/Applications/HomeAgent.app/Contents/Resources/bin/bun",
    runProcess: async (command) => {
      commands.push(command);
      return { code: 0, stdout: "bundled text", stderr: "" };
    },
  });

  await extractor("pdf", "/tmp/brief.pdf");
  expect(commands[0]?.[0]).toBe(
    resolve("/Applications/HomeAgent.app/Contents/Resources/bin/attachment-extract"),
  );
  expect(commands.some((command) => command.includes("swiftc"))).toBeFalse();
});

test("bundled native extraction rejects a helper outside Resources/bin", async () => {
  let invoked = false;
  const extractor = createNativeExtractor({
    platform: "darwin",
    execPath: "/Applications/HomeAgent.app/Contents/MacOS/homeagent",
    attachmentHelper: "/Applications/HomeAgent.app/Contents/Resources/bin-evil/attachment-extract",
    runProcess: async () => {
      invoked = true;
      return { code: 0, stdout: "unsafe", stderr: "" };
    },
  });

  await expect(extractor("pdf", "/tmp/brief.pdf")).rejects.toThrow(
    "outside the application Resources/bin directory",
  );
  expect(invoked).toBeFalse();
});

test("source native extraction retains temporary Swift compilation", async () => {
  const commands: string[][] = [];
  const runProcess: NativeProcessRunner = async (command) => {
    commands.push(command);
    return {
      code: 0,
      stdout: command[0] === "/usr/bin/xcrun" ? "" : "source text",
      stderr: "",
    };
  };
  const extractor = createNativeExtractor({
    platform: "darwin",
    execPath: "/opt/homebrew/bin/bun",
    runProcess,
  });

  expect(await extractor("pdf", "/tmp/brief.pdf")).toEqual({
    code: 0,
    stdout: "source text",
    stderr: "",
  });
  expect(commands[0]?.slice(0, 3)).toEqual([
    "/usr/bin/xcrun",
    "swiftc",
    join(import.meta.dir, "attachment-extract.swift"),
  ]);
  expect(commands[0]?.slice(3, 5)).toEqual([
    "-module-cache-path",
    expect.stringContaining("homeagent-native-extract-"),
  ]);
  expect(commands[1]?.[0]?.endsWith(`${sep}attachment-extract`)).toBeTrue();
  expect(commands[1]?.slice(1)).toEqual(["pdf", "/tmp/brief.pdf"]);
});

const macOSOnly = process.platform === "darwin" ? describe : describe.skip;

macOSOnly("Swift attachment helper limits", () => {
  let helperDirectory: string;
  let helperBinary: string;

  beforeAll(
    async () => {
      helperDirectory = mkdtempSync(join(tmpdir(), "hb-swift-helper-"));
      helperBinary = join(helperDirectory, "attachment-extract");
      const compilation = await runBoundedProcess(
        [
          "/usr/bin/xcrun",
          "swiftc",
          join(import.meta.dir, "attachment-extract.swift"),
          "-module-cache-path",
          join(helperDirectory, "module-cache"),
          "-o",
          helperBinary,
        ],
        60_000,
      );
      if (compilation.code !== 0) {
        throw new Error(`Swift helper failed to compile: ${compilation.stderr}`);
      }
    },
    60_000,
  );

  afterAll(() => {
    rmSync(helperDirectory, { recursive: true, force: true });
  });

  test("rejects an image whose declared dimensions exceed 40 million pixels", async () => {
    const imagePath = join(helperDirectory, "oversized.png");
    writeFileSync(imagePath, minimalPng(10_000, 5_000));

    const result = await runBoundedProcess([helperBinary, "image", imagePath], 5_000);

    expect(result.code).toBe(5);
    expect(result.stderr).toContain("40 million pixel limit");
  });

  test("extracts PDF text past 200,000 characters inside the helper", async () => {
    const pdfPath = join(helperDirectory, "large-text.pdf");
    writeFileSync(pdfPath, minimalPdf("A".repeat(210_000)));

    const result = await runBoundedProcess([helperBinary, "pdf", pdfPath], 5_000);

    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("AAAA")).toBe(true);
    expect(result.stdout.replace(/\s/gu, "").length).toBe(210_000);
  });

  test("extracts PDF text beyond page 50", async () => {
    const pdfPath = join(helperDirectory, "many-pages.pdf");
    writeFileSync(pdfPath, minimalPdf("PAGE_MARKER", 55));
    const result = await runBoundedProcess([helperBinary, "pdf", pdfPath], 5_000);
    expect(result.code).toBe(0);
    expect(result.stdout.match(/PAGE_MARKER/gu)).toHaveLength(55);
  });
});

describe("extractAttachmentText", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-extract-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function attachment(
    name: string,
    kind: DownloadedAttachment["attachment"]["kind"] = "file",
  ): DownloadedAttachment {
    return {
      attachment: { kind, ref: `ref-${name}`, name },
      localPath: join(dir, "resource.bin"),
      sizeBytes: 0,
      cleanup: () => {},
    };
  }

  test("reads UTF-8 text-like attachments", async () => {
    const input = attachment("notes.md");
    writeFileSync(input.localPath, "项目代号是北极星", "utf8");

    expect(await extractAttachmentText(input)).toBe("项目代号是北极星");
  });

  test("returns null for empty or invalid UTF-8 text", async () => {
    const empty = attachment("empty.txt");
    writeFileSync(empty.localPath, " \n\t", "utf8");
    expect(await extractAttachmentText(empty)).toBeNull();

    const invalid = attachment("invalid.json");
    writeFileSync(invalid.localPath, Uint8Array.from([0xc3, 0x28]));
    expect(await extractAttachmentText(invalid)).toBeNull();
  });

  test("uses the native extractor for image and PDF content", async () => {
    const native: NativeExtractor = async (mode) => ({
      code: 0,
      stdout: mode === "image" ? "识别出的图片文字\n" : "PDF 文本层\n",
      stderr: "",
    });

    expect(await extractAttachmentText(attachment("scan.png", "image"), native)).toBe(
      "识别出的图片文字",
    );
    expect(await extractAttachmentText(attachment("brief.pdf", "pdf"), native)).toBe(
      "PDF 文本层",
    );
  });

  test("keeps an injected native extractor usable on non-macOS hosts", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    const native: NativeExtractor = async () => ({
      code: 0,
      stdout: "portable injected result",
      stderr: "",
    });
    try {
      expect(await extractAttachmentText(attachment("scan.png", "image"), native)).toBe(
        "portable injected result",
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test("returns null when native extraction exits unsuccessfully", async () => {
    const failed: NativeExtractor = async () => ({
      code: 4,
      stdout: "partial output must be ignored",
      stderr: "bad document",
    });

    expect(await extractAttachmentText(attachment("broken.pdf", "pdf"), failed)).toBeNull();
  });

  test("keeps native output past 200,000 characters", async () => {
    const native: NativeExtractor = async () => ({
      code: 0,
      stdout: `${"识".repeat(200_001)}\n`,
      stderr: "",
    });

    const text = await extractAttachmentText(attachment("large.png", "image"), native);
    expect(text).toBe("识".repeat(200_001));
  });

  test("keeps text attachments past 200,000 characters", async () => {
    const input = attachment("messages.jsonl");
    const content = `${"甲".repeat(200_001)}TAIL_MARKER`;
    writeFileSync(input.localPath, content);
    expect(await extractAttachmentText(input)).toBe(content);
  });

  test("uploaded PDFs and images use native extraction and clean up temporary files", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const paths: string[] = [];
    const native: NativeExtractor = async (mode, path) => {
      paths.push(path);
      expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
      return { code: 0, stdout: `${mode}正文${"甲".repeat(200_001)}TAIL_MARKER`, stderr: "" };
    };
    for (const name of ["../../report.pdf", "scan.png"]) {
      expect(await extractUploadedMaterialText(name, bytes, native)).toContain("TAIL_MARKER");
    }
    expect(paths.every(path => !existsSync(path))).toBeTrue();
    const failed: NativeExtractor = async (_mode, path) => { paths.push(path); throw new Error("failure"); };
    expect(await extractUploadedMaterialText("bad.pdf", bytes, failed)).toBeNull();
    expect(paths.every(path => !existsSync(path))).toBeTrue();
  });

  test("returns null for unsupported audio", async () => {
    const native: NativeExtractor = async () => ({
      code: 0,
      stdout: "audio should not use the native extractor",
      stderr: "",
    });

    expect(await extractAttachmentText(attachment("voice.opus", "audio"), native)).toBeNull();
  });

  test("contains read and native boundary failures", async () => {
    const missing = attachment("missing.log");
    expect(await extractAttachmentText(missing)).toBeNull();

    const throws: NativeExtractor = async () => {
      throw new Error("spawn failed");
    };
    expect(await extractAttachmentText(attachment("scan.png", "image"), throws)).toBeNull();
  });
});

function minimalPng(width: number, height: number): Uint8Array {
  const header = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([1, 0, 0, 0, 0], 8);
  const scanlines = new Uint8Array((Math.ceil(width / 8) + 1) * height);
  return concatenateBytes([
    header,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = concatenateBytes([typeBytes, data]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatenateBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function minimalPdf(text: string, pageCount = 1): string {
  const textRuns = text.match(/.{1,1000}/g) ?? [];
  const content = [
    "BT",
    "/F1 12 Tf",
    "72 9900 Td",
    ...textRuns.flatMap((run) => [`(${run}) Tj`, "0 -12 Td"]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [3 0 R ${Array.from({ length: pageCount - 1 }, (_, index) => `${index + 6} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20000 10000] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 1; i < pageCount; i += 1) objects.push(objects[2]!);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}
