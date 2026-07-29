import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  validateBrandPng,
  validateBrandSvg,
  verifyBrandAssets,
} from "./verify-brand-assets.ts";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

describe("brand asset verification", () => {
  test("accepts a PNG whose IHDR dimensions match its public contract", () => {
    const issues = validateBrandPng({
      file: "avatar.png",
      bytes: pngHeader(512, 512),
      expectedWidth: 512,
      expectedHeight: 512,
    });

    expect(issues).toEqual([]);
  });

  test("rejects bytes without the PNG signature and IHDR marker", () => {
    const bytes = pngHeader(512, 512);
    bytes[0] = 0;
    bytes[12] = 0;

    const issues = validateBrandPng({
      file: "not-png.png",
      bytes,
      expectedWidth: 512,
      expectedHeight: 512,
    });

    expect(issues).toEqual([
      "not-png.png: invalid PNG signature",
      "not-png.png: missing IHDR chunk",
    ]);
  });

  test("rejects a PNG whose complete IHDR chunk is truncated", () => {
    const issues = validateBrandPng({
      file: "truncated.png",
      bytes: pngHeader(512, 512).slice(0, 28),
      expectedWidth: 512,
      expectedHeight: 512,
    });

    expect(issues).toEqual(["truncated.png: truncated PNG header"]);
  });

  test("rejects unsupported PNG header metadata", () => {
    const bytes = pngHeader(512, 512);
    new DataView(bytes.buffer).setUint32(8, 12);
    bytes[24] = 16;
    bytes[25] = 3;

    const issues = validateBrandPng({
      file: "unsupported.png",
      bytes,
      expectedWidth: 512,
      expectedHeight: 512,
    });

    expect(issues).toEqual([
      "unsupported.png: IHDR chunk length must be 13",
      "unsupported.png: unsupported bit depth 16",
      "unsupported.png: unsupported color type 3",
    ]);
  });

  test("rejects a valid PNG assigned to the wrong responsive slot", () => {
    const issues = validateBrandPng({
      file: "icon_512x512.png",
      bytes: pngHeader(256, 256),
      expectedWidth: 512,
      expectedHeight: 512,
    });

    expect(issues).toEqual([
      "icon_512x512.png: expected 512x512, received 256x256",
    ]);
  });

  test("accepts a static SVG that matches its public contract", () => {
    const issues = validateBrandSvg({
      file: "homeagent-mark.svg",
      expectedViewBox: "0 0 180 180",
      requiredIds: ["brand-roof", "brand-spark"],
      svg: `
        <svg viewBox="0 0 180 180" xmlns="http://www.w3.org/2000/svg">
          <path id="brand-roof" d="M35 88 90 43l55 45" stroke="#FFF3E5" />
          <path id="brand-spark" d="m90 80 5 18 18 5-18 5-5 18-5-18-18-5 18-5Z" fill="#F4C965" />
        </svg>
      `,
    });

    expect(issues).toEqual([]);
  });

  test("rejects executable SVG content", () => {
    const issues = validateBrandSvg({
      file: "unsafe.svg",
      expectedViewBox: "0 0 180 180",
      requiredIds: [],
      svg: `<svg viewBox="0 0 180 180"><script>alert("x")</script></svg>`,
    });

    expect(issues).toEqual(["unsafe.svg: forbidden script element"]);
  });

  test("rejects external, embedded, and event-driven SVG content", () => {
    const issues = validateBrandSvg({
      file: "unsafe.svg",
      expectedViewBox: "0 0 180 180",
      requiredIds: [],
      svg: `
        <svg viewBox="0 0 180 180">
          <foreignObject><div>html</div></foreignObject>
          <image href="data:image/png;base64,AAAA" />
          <path onclick="run()" d="M0 0" />
          <style>@font-face { font-family: remote; src: url(https://example.com/font.woff2); }</style>
        </svg>
      `,
    });

    expect(issues).toContain("unsafe.svg: forbidden foreignObject element");
    expect(issues).toContain("unsafe.svg: forbidden image element");
    expect(issues).toContain("unsafe.svg: forbidden event-handler attribute");
    expect(issues).toContain("unsafe.svg: forbidden external or embedded reference");
    expect(issues).toContain("unsafe.svg: forbidden font declaration");
  });

  test("rejects colors outside the approved HomeAgent palette", () => {
    const issues = validateBrandSvg({
      file: "off-brand.svg",
      expectedViewBox: "0 0 180 180",
      requiredIds: [],
      svg: `
        <svg viewBox="0 0 180 180">
          <path fill="#C45F43" stroke="#123456" d="M0 0" />
        </svg>
      `,
    });

    expect(issues).toEqual(["off-brand.svg: unapproved color #123456"]);
  });

  test("verifies the repository's canonical brand sources together", () => {
    const report = verifyBrandAssets(resolve(import.meta.dir, ".."));

    expect(report.files.slice(0, 2)).toEqual([
      "assets/brand/homeagent-mark.svg",
      "assets/brand/homeagent-glyph.svg",
    ]);
    expect(report.issues).toEqual([]);
  });

  test("verifies the 512px Feishu avatar as a required repository asset", () => {
    const report = verifyBrandAssets(resolve(import.meta.dir, ".."));

    expect(report.files).toContain(
      "assets/brand/homeagent-feishu-avatar-512.png",
    );
    expect(report.issues).toEqual([]);
  });

  test("verifies every required macOS iconset slot and pixel size", () => {
    const report = verifyBrandAssets(resolve(import.meta.dir, ".."));

    expect(report.files.filter((file) => file.includes("AppIcon.iconset"))).toEqual([
      "assets/macos/AppIcon.iconset/icon_16x16.png",
      "assets/macos/AppIcon.iconset/icon_16x16@2x.png",
      "assets/macos/AppIcon.iconset/icon_32x32.png",
      "assets/macos/AppIcon.iconset/icon_32x32@2x.png",
      "assets/macos/AppIcon.iconset/icon_128x128.png",
      "assets/macos/AppIcon.iconset/icon_128x128@2x.png",
      "assets/macos/AppIcon.iconset/icon_256x256.png",
      "assets/macos/AppIcon.iconset/icon_256x256@2x.png",
      "assets/macos/AppIcon.iconset/icon_512x512.png",
      "assets/macos/AppIcon.iconset/icon_512x512@2x.png",
    ]);
    expect(report.issues).toEqual([]);
  });

  test("rejects text that is not an SVG document", () => {
    const issues = validateBrandSvg({
      file: "not-svg.svg",
      expectedViewBox: "0 0 180 180",
      requiredIds: [],
      svg: `<div data-viewBox="0 0 180 180">not an svg</div>`,
    });

    expect(issues).toContain("not-svg.svg: missing svg root element");
  });

  test("rejects declarative animation in canonical brand SVGs", () => {
    const issues = validateBrandSvg({
      file: "animated.svg",
      expectedViewBox: "0 0 180 180",
      requiredIds: [],
      svg: `
        <svg viewBox="0 0 180 180">
          <circle cx="90" cy="90" r="20">
            <animate attributeName="r" values="20;24;20" dur="1s" />
          </circle>
        </svg>
      `,
    });

    expect(issues).toContain("animated.svg: forbidden animation element");
  });

  test("rejects font-dependent brand geometry", () => {
    const issues = validateBrandSvg({
      file: "font.svg",
      expectedViewBox: "0 0 180 180",
      requiredIds: [],
      svg: `
        <svg viewBox="0 0 180 180">
          <text font-family="Avenir Next">homeagent</text>
        </svg>
      `,
    });

    expect(issues).toContain("font.svg: forbidden font declaration");
  });

  test("rejects CSS that could bypass static palette validation", () => {
    const issues = validateBrandSvg({
      file: "styled.svg",
      expectedViewBox: "0 0 180 180",
      requiredIds: [],
      svg: `
        <svg viewBox="0 0 180 180">
          <style>path { fill: rebeccapurple; }</style>
          <path style="stroke: rgb(1 2 3)" d="M0 0" />
        </svg>
      `,
    });

    expect(issues).toContain("styled.svg: forbidden style element");
    expect(issues).toContain("styled.svg: forbidden style attribute");
  });

  test("rejects non-palette color syntax in presentation attributes", () => {
    const issues = validateBrandSvg({
      file: "named-color.svg",
      expectedViewBox: "0 0 180 180",
      requiredIds: [],
      svg: `
        <svg viewBox="0 0 180 180">
          <path fill="rebeccapurple" d="M0 0" />
        </svg>
      `,
    });

    expect(issues).toContain(
      "named-color.svg: unapproved fill value rebeccapurple",
    );
  });

  test("rejects document type and entity declarations", () => {
    const issues = validateBrandSvg({
      file: "entity.svg",
      expectedViewBox: "0 0 180 180",
      requiredIds: [],
      svg: `
        <!DOCTYPE svg [
          <!ENTITY payload SYSTEM "file:///private/data">
        ]>
        <svg viewBox="0 0 180 180"><text>&payload;</text></svg>
      `,
    });

    expect(issues).toContain("entity.svg: forbidden document type declaration");
    expect(issues).toContain("entity.svg: forbidden entity declaration");
  });
});
