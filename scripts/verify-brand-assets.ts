import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BrandSvgValidationInput {
  file: string;
  svg: string;
  expectedViewBox: string;
  requiredIds: string[];
}

export interface BrandAssetVerificationReport {
  files: string[];
  issues: string[];
}

export interface BrandPngValidationInput {
  file: string;
  bytes: Uint8Array;
  expectedWidth: number;
  expectedHeight: number;
}

export const APPROVED_BRAND_COLORS = new Set([
  "#DA7B51",
  "#C45F43",
  "#A94733",
  "#F4C965",
  "#FFF3E5",
  "#342A25",
]);

function isApprovedPaint(value: string): boolean {
  return value === "none"
    || value === "currentColor"
    || /^#[0-9a-f]{3,8}$/iu.test(value)
    || /^url\(#brand-[a-z0-9-]+\)$/iu.test(value)
    || /^var\(--homeagent-(?:roof|spark),\s*currentColor\)$/u.test(value);
}

export function validateBrandPng(input: BrandPngValidationInput): string[] {
  if (input.bytes.byteLength < 33) {
    return [`${input.file}: truncated PNG header`];
  }
  const issues: string[] = [];
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => input.bytes[index] === value)) {
    issues.push(`${input.file}: invalid PNG signature`);
  }
  const ihdr = [73, 72, 68, 82];
  if (!ihdr.every((value, index) => input.bytes[index + 12] === value)) {
    issues.push(`${input.file}: missing IHDR chunk`);
  }
  const view = new DataView(
    input.bytes.buffer,
    input.bytes.byteOffset,
    input.bytes.byteLength,
  );
  if (view.getUint32(8) !== 13) {
    issues.push(`${input.file}: IHDR chunk length must be 13`);
  }
  if (input.bytes[24] !== 8) {
    issues.push(`${input.file}: unsupported bit depth ${input.bytes[24]}`);
  }
  if (input.bytes[25] !== 2 && input.bytes[25] !== 6) {
    issues.push(`${input.file}: unsupported color type ${input.bytes[25]}`);
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width !== input.expectedWidth || height !== input.expectedHeight) {
    issues.push(
      `${input.file}: expected ${input.expectedWidth}x${input.expectedHeight}, `
      + `received ${width}x${height}`,
    );
  }
  return issues;
}

export function validateBrandSvg(input: BrandSvgValidationInput): string[] {
  const issues: string[] = [];
  if (!/<svg(?:\s|>)/iu.test(input.svg)) {
    issues.push(`${input.file}: missing svg root element`);
  }
  if (/<!DOCTYPE\b/iu.test(input.svg)) {
    issues.push(`${input.file}: forbidden document type declaration`);
  }
  if (/<!ENTITY\b/iu.test(input.svg)) {
    issues.push(`${input.file}: forbidden entity declaration`);
  }
  if (/<script\b/iu.test(input.svg)) {
    issues.push(`${input.file}: forbidden script element`);
  }
  if (/<(?:animate(?:Motion|Transform)?|set)\b/iu.test(input.svg)) {
    issues.push(`${input.file}: forbidden animation element`);
  }
  if (/<style\b/iu.test(input.svg)) {
    issues.push(`${input.file}: forbidden style element`);
  }
  if (/<foreignObject\b/iu.test(input.svg)) {
    issues.push(`${input.file}: forbidden foreignObject element`);
  }
  if (/<image\b/iu.test(input.svg)) {
    issues.push(`${input.file}: forbidden image element`);
  }
  if (/\son[a-z]+\s*=/iu.test(input.svg)) {
    issues.push(`${input.file}: forbidden event-handler attribute`);
  }
  if (/\sstyle\s*=/iu.test(input.svg)) {
    issues.push(`${input.file}: forbidden style attribute`);
  }
  if (
    /\b(?:href|xlink:href|src)\s*=\s*["']\s*(?!#)/iu.test(input.svg)
    || /url\(\s*(?!#)/iu.test(input.svg)
  ) {
    issues.push(`${input.file}: forbidden external or embedded reference`);
  }
  if (/@font-face\b|font-family\s*(?::|=)/iu.test(input.svg)) {
    issues.push(`${input.file}: forbidden font declaration`);
  }
  for (const color of new Set(input.svg.match(/#[0-9a-f]{3,8}\b/giu) ?? [])) {
    if (!APPROVED_BRAND_COLORS.has(color.toUpperCase())) {
      issues.push(`${input.file}: unapproved color ${color}`);
    }
  }
  for (const match of input.svg.matchAll(
    /\b(fill|stroke|stop-color|color)\s*=\s*["']([^"']+)["']/giu,
  )) {
    const attribute = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (!isApprovedPaint(value)) {
      issues.push(`${input.file}: unapproved ${attribute} value ${value}`);
    }
  }
  if (!input.svg.includes(`viewBox="${input.expectedViewBox}"`)) {
    issues.push(`${input.file}: expected viewBox ${input.expectedViewBox}`);
  }
  for (const id of input.requiredIds) {
    if (!input.svg.includes(`id="${id}"`)) {
      issues.push(`${input.file}: missing required id ${id}`);
    }
  }
  return issues;
}

const SVG_CONTRACTS = [
  {
    file: "assets/brand/homeagent-mark.svg",
    expectedViewBox: "0 0 180 180",
    requiredIds: [
      "brand-background",
      "brand-roof",
      "brand-home",
      "brand-halo",
      "brand-spark",
      "brand-detail-spark",
    ],
  },
  {
    file: "assets/brand/homeagent-glyph.svg",
    expectedViewBox: "0 0 64 64",
    requiredIds: ["brand-roof", "brand-home", "brand-spark"],
  },
] as const;

const PNG_CONTRACTS = [
  {
    file: "assets/brand/homeagent-feishu-avatar-512.png",
    expectedWidth: 512,
    expectedHeight: 512,
  },
  {
    file: "assets/macos/AppIcon.iconset/icon_16x16.png",
    expectedWidth: 16,
    expectedHeight: 16,
  },
  {
    file: "assets/macos/AppIcon.iconset/icon_16x16@2x.png",
    expectedWidth: 32,
    expectedHeight: 32,
  },
  {
    file: "assets/macos/AppIcon.iconset/icon_32x32.png",
    expectedWidth: 32,
    expectedHeight: 32,
  },
  {
    file: "assets/macos/AppIcon.iconset/icon_32x32@2x.png",
    expectedWidth: 64,
    expectedHeight: 64,
  },
  {
    file: "assets/macos/AppIcon.iconset/icon_128x128.png",
    expectedWidth: 128,
    expectedHeight: 128,
  },
  {
    file: "assets/macos/AppIcon.iconset/icon_128x128@2x.png",
    expectedWidth: 256,
    expectedHeight: 256,
  },
  {
    file: "assets/macos/AppIcon.iconset/icon_256x256.png",
    expectedWidth: 256,
    expectedHeight: 256,
  },
  {
    file: "assets/macos/AppIcon.iconset/icon_256x256@2x.png",
    expectedWidth: 512,
    expectedHeight: 512,
  },
  {
    file: "assets/macos/AppIcon.iconset/icon_512x512.png",
    expectedWidth: 512,
    expectedHeight: 512,
  },
  {
    file: "assets/macos/AppIcon.iconset/icon_512x512@2x.png",
    expectedWidth: 1024,
    expectedHeight: 1024,
  },
] as const;

export function verifyBrandAssets(repoRoot = resolve(import.meta.dir, "..")): BrandAssetVerificationReport {
  const files = [
    ...SVG_CONTRACTS.map((contract) => contract.file),
    ...PNG_CONTRACTS.map((contract) => contract.file),
  ];
  const svgIssues = SVG_CONTRACTS.flatMap((contract) => {
    try {
      return validateBrandSvg({
        ...contract,
        requiredIds: [...contract.requiredIds],
        svg: readFileSync(join(repoRoot, contract.file), "utf8"),
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "read_error";
      return [`${contract.file}: unable to read asset (${code})`];
    }
  });
  const pngIssues = PNG_CONTRACTS.flatMap((contract) => {
    try {
      return validateBrandPng({
        ...contract,
        bytes: readFileSync(join(repoRoot, contract.file)),
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "read_error";
      return [`${contract.file}: unable to read asset (${code})`];
    }
  });
  const issues = [...svgIssues, ...pngIssues];
  return { files, issues };
}

if (import.meta.main) {
  const report = verifyBrandAssets();
  if (report.issues.length > 0) {
    for (const issue of report.issues) console.error(issue);
    process.exitCode = 1;
  } else {
    console.log(`Verified ${report.files.length} HomeAgent brand assets.`);
  }
}
