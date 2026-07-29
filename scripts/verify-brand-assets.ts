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

export function verifyBrandAssets(repoRoot = resolve(import.meta.dir, "..")): BrandAssetVerificationReport {
  const files = SVG_CONTRACTS.map((contract) => contract.file);
  const issues = SVG_CONTRACTS.flatMap((contract) => {
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
  return { files, issues };
}

if (import.meta.main) {
  const report = verifyBrandAssets();
  if (report.issues.length > 0) {
    for (const issue of report.issues) console.error(issue);
    process.exitCode = 1;
  } else {
    console.log(`Verified ${report.files.length} canonical HomeAgent brand assets.`);
  }
}
