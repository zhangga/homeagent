import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { validateBrandSvg, verifyBrandAssets } from "./verify-brand-assets.ts";

describe("brand asset verification", () => {
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

    expect(report).toEqual({
      files: [
        "assets/brand/homeagent-mark.svg",
        "assets/brand/homeagent-glyph.svg",
      ],
      issues: [],
    });
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
