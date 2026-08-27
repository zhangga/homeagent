import { describe, expect, test } from "bun:test";
import {
  AI_GENERATION_MAX_TOKENS,
  AI_MAX_CONFIGURABLE_TIMEOUT_MINUTES,
  AI_OPERATION_TIMEOUT_MINUTES,
  AI_OPERATION_TIMEOUT_MS,
  AI_QUEUE_TIMEOUT_MS,
  AI_ROUTING_MAX_TOKENS,
} from "./ai-limits.ts";

describe("stability-first AI limits", () => {
  test("keep production AI work far above short interactive deadlines", () => {
    expect(AI_OPERATION_TIMEOUT_MINUTES).toBe(360);
    expect(AI_OPERATION_TIMEOUT_MS).toBe(6 * 60 * 60_000);
    expect(AI_MAX_CONFIGURABLE_TIMEOUT_MINUTES).toBe(1_440);
    expect(AI_QUEUE_TIMEOUT_MS).toBe(24 * 60 * 60_000);
  });

  test("leave ample output headroom for routing and full generation", () => {
    expect(AI_ROUTING_MAX_TOKENS).toBe(8_192);
    expect(AI_GENERATION_MAX_TOKENS).toBe(65_536);
  });
});
