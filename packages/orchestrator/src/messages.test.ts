import { expect, test } from "bun:test";
import {
  NO_TOOLS_MODE_NOTICE,
  UNSUPPORTED_IMAGE_NOTICE,
  providerNotice,
} from "./messages.ts";

test("provider notices explain fail-closed no-tools and visual boundaries", () => {
  expect(providerNotice(
    new Error("provider codex cannot provide a no-tools execution mode"),
  )).toBe(NO_TOOLS_MODE_NOTICE);
  expect(NO_TOOLS_MODE_NOTICE).toContain("Codex / TRAE 当前只用于显式任务执行");
  expect(UNSUPPORTED_IMAGE_NOTICE).not.toContain("切换到 Codex");
});
