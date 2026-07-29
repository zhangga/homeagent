import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import fullMarkSource from "../../../assets/brand/homeagent-mark.svg" with {
  type: "text",
};
import glyphSource from "../../../assets/brand/homeagent-glyph.svg" with {
  type: "text",
};

export type BrandMarkVariant = "full" | "dark" | "mono";

export interface BrandMarkOptions {
  variant?: BrandMarkVariant;
  size?: number;
  label?: string;
  decorative?: boolean;
}

const VARIANTS = new Set<BrandMarkVariant>(["full", "dark", "mono"]);

function asInlineArtwork(svg: string): string {
  return svg.replace(' xmlns="http://www.w3.org/2000/svg"', "").replace(
    "<svg ",
    '<svg class="homeagent-brand-artwork" width="100%" height="100%" '
      + 'aria-hidden="true" focusable="false" ',
  );
}

function compactFullMark(): string {
  return fullMarkSource
    .replace(/\s*<defs>[\s\S]*?<\/defs>/u, "")
    .replace(/\s*<circle id="brand-halo"[^>]*\/>/u, "")
    .replace(/\s*<circle id="brand-detail-spark"[^>]*\/>/u, "")
    .replace('fill="url(#brand-terracotta)"', 'fill="#C45F43"')
    .replace('fill="url(#brand-hearth)"', 'fill="#F4C965"');
}

function artworkFor(variant: BrandMarkVariant, size: number): {
  responsive: "full" | "compact" | "micro";
  style: string;
  svg: string;
} {
  if (size < 24) {
    return {
      responsive: "micro",
      style: variant === "dark" ? "color:#FFF3E5;" : "",
      svg: glyphSource,
    };
  }
  if (variant === "dark") {
    return {
      responsive: "compact",
      style: "--homeagent-roof:#FFF3E5;--homeagent-spark:#F4C965;color:#FFF3E5;",
      svg: glyphSource,
    };
  }
  if (variant === "mono") {
    return { responsive: "compact", style: "", svg: glyphSource };
  }
  if (size < 128) {
    return { responsive: "compact", style: "", svg: compactFullMark() };
  }
  return { responsive: "full", style: "", svg: fullMarkSource };
}

export function brandMark(
  options: BrandMarkOptions = {},
): HtmlEscapedString | Promise<HtmlEscapedString> {
  const variant = options.variant ?? "full";
  const size = options.size ?? 32;
  if (!VARIANTS.has(variant)) {
    throw new TypeError(`Unsupported HomeAgent brand variant: ${variant}`);
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new TypeError("HomeAgent brand size must be a positive finite number");
  }

  const artwork = artworkFor(variant, size);
  const style = `display:inline-block;line-height:0;vertical-align:middle;`
    + `width:${size}px;height:${size}px;${artwork.style}`;
  const svg = raw(asInlineArtwork(artwork.svg));

  if (options.decorative) {
    return html`<span class="homeagent-brand-mark"
      data-homeagent-brand="${variant}"
      data-responsive="${artwork.responsive}"
      style="${style}"
      aria-hidden="true">${svg}</span>`;
  }
  return html`<span class="homeagent-brand-mark"
    data-homeagent-brand="${variant}"
    data-responsive="${artwork.responsive}"
    style="${style}"
    role="img"
    aria-label="${options.label ?? "HomeAgent"}">${svg}</span>`;
}
