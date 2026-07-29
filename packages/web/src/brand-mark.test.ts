import { describe, expect, test } from "bun:test";
import { brandMark } from "./brand-mark.ts";

async function render(
  options: Parameters<typeof brandMark>[0] = {},
): Promise<string> {
  return String(await brandMark(options));
}

describe("brandMark", () => {
  test("renders the full-color mark with an accessible HomeAgent name", async () => {
    const output = await render({ variant: "full", size: 180 });

    expect(output).toContain('role="img"');
    expect(output).toContain('aria-label="HomeAgent"');
    expect(output).toContain('data-homeagent-brand="full"');
    expect(output).toContain('id="brand-background"');
    expect(output).toContain('id="brand-halo"');
    expect(output).toContain('id="brand-detail-spark"');
  });

  test("renders the dark glyph with cream roof and honey spark variables", async () => {
    const output = await render({ variant: "dark", size: 32 });

    expect(output).toContain('data-homeagent-brand="dark"');
    expect(output).toContain("--homeagent-roof:#FFF3E5");
    expect(output).toContain("--homeagent-spark:#F4C965");
    expect(output).toContain('viewBox="0 0 64 64"');
    expect(output).not.toContain('id="brand-background"');
  });

  test("renders a single-color glyph for mono usage", async () => {
    const output = await render({ variant: "mono", size: 32 });

    expect(output).toContain('data-homeagent-brand="mono"');
    expect(output).toContain('viewBox="0 0 64 64"');
    expect(output).not.toContain("--homeagent-roof:");
    expect(output).not.toContain("--homeagent-spark:");
    expect(output).not.toContain('id="brand-background"');
  });

  test("makes decorative usage silent to assistive technology", async () => {
    const output = await render({
      variant: "full",
      size: 180,
      decorative: true,
      label: "Duplicate HomeAgent",
    });

    expect(output).toContain('aria-hidden="true"');
    expect(output).not.toContain('role="img"');
    expect(output).not.toContain("aria-label");
    expect(output).not.toContain("Duplicate HomeAgent");
  });

  test("removes large-only detail and flattens color below 128px", async () => {
    const output = await render({ variant: "full", size: 64 });

    expect(output).not.toContain('id="brand-halo"');
    expect(output).not.toContain('id="brand-detail-spark"');
    expect(output).not.toContain('url(#brand-terracotta)');
    expect(output).not.toContain('url(#brand-hearth)');
    expect(output).toContain('fill="#C45F43"');
    expect(output).toContain('fill="#F4C965"');
  });

  test("uses the no-background monochrome glyph below 24px", async () => {
    const output = await render({ variant: "full", size: 16 });

    expect(output).toContain('data-responsive="micro"');
    expect(output).toContain('viewBox="0 0 64 64"');
    expect(output).not.toContain('id="brand-background"');
    expect(output).not.toContain("--homeagent-spark:#F4C965");
  });

  test("escapes a caller-provided accessible label", async () => {
    const output = await render({
      label: `HomeAgent"><script>alert(1)</script>`,
    });

    expect(output).toContain(
      "aria-label=\"HomeAgent&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;\"",
    );
    expect(output).not.toContain("<script>");
  });

  test("contains no external references, fonts, emoji, scripts, or handlers", async () => {
    const variants = await Promise.all([
      render({ variant: "full", size: 180 }),
      render({ variant: "dark", size: 32 }),
      render({ variant: "mono", size: 16 }),
    ]);
    const output = variants.join("\n");

    expect(output).not.toMatch(/https?:|data:|@font-face|font-family/iu);
    expect(output).not.toMatch(/<script\b|\son[a-z]+\s*=/iu);
    expect(output).not.toContain("🧠");
    expect(output).not.toContain("⌁");
  });

  test("rejects invalid variants and nonpositive sizes at runtime", () => {
    expect(() => brandMark({ variant: "invalid" as "full" })).toThrow(
      "Unsupported HomeAgent brand variant",
    );
    expect(() => brandMark({ size: 0 })).toThrow(
      "HomeAgent brand size must be a positive finite number",
    );
    expect(() => brandMark({ size: Number.NaN })).toThrow(
      "HomeAgent brand size must be a positive finite number",
    );
  });
});
