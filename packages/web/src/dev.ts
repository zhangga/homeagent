/**
 * Local dev server for the management backend. Starts just the web app (no
 * feishu) over a KnowledgeEngine, seeding a demo space + CLI agents so the
 * Agents/Integrations/Settings pages have something to show. Use it to click
 * through the backend during development:
 *
 *   bun run packages/web/src/dev.ts
 *   # then open http://localhost:3000
 *
 * All LLM work runs through a local CLI provider. Two dev modes:
 *   - default (offline): a fake CLI runner returns canned text + empty
 *     structured results, so the 问答测试 box and pages work WITHOUT spawning a
 *     real CLI (fast; answers won't reflect a real model).
 *   - HOMEAGENT_DEV_REAL_CLI=1: no fake — the engine spawns the real detected
 *     CLI (claude/trae-cli). Slower, but you SEE the real agent answer.
 *
 * Writes to ./data by default (honors HOMEAGENT_DATA_DIR).
 */
import { assertSafeWebBinding, brandedEnv, config, type SpaceId } from "@homeagent/shared";
import { KnowledgeEngine } from "@homeagent/core";
import { detectProviders, type ProviderId } from "@homeagent/llm";
import { resolve } from "node:path";
import { createWebApp } from "./app.ts";

const realCli = brandedEnv(process.env, "DEV_REAL_CLI") === "1";

// config() requires these; provide harmless placeholders (the CLIs manage their
// own auth, so homeagent itself doesn't use the network gateway).
process.env.ANTHROPIC_BASE_URL ??= "https://api.gameaigc.cn";
process.env.ANTHROPIC_AUTH_TOKEN ??= "dev-placeholder";

const cfg = config();
assertSafeWebBinding(cfg.webHost, cfg.webAdminToken);

// Offline: a fake CLI runner so no real process is spawned. It answers text
// prompts with a canned line and structured (JSON-schema) prompts with empty
// results, matching what ask()/dream() expect.
const fakeRunner = async (
  _id: ProviderId,
  input: { prompt: string; system?: string; model?: string },
): Promise<string> => {
  const p = input.prompt;
  if (/JSON Schema/.test(p) && /relevant/.test(p)) return JSON.stringify({ slugs: [], relevant: false });
  if (/JSON Schema/.test(p) && /grounded/.test(p)) return JSON.stringify({ answer: "", grounded: false, usedSlugs: [], gaps: ["dev fake"] });
  if (/JSON Schema/.test(p) && /operations/.test(p)) return JSON.stringify({ operations: [], skippedRawIds: [] });
  if (/JSON Schema/.test(p) && /intent/.test(p)) return JSON.stringify({ intent: "chitchat" });
  return "（离线假回答：dev 模式未接真实 CLI。设 HOMEAGENT_DEV_REAL_CLI=1 可用真实本机 CLI。）";
};

const engine = new KnowledgeEngine(realCli ? {} : { runProvider: fakeRunner });

// Seed a demo team space + CLI agents so the pages aren't empty on first run.
const demo: SpaceId = "team/oc_demo";
if (!engine.registry.has(demo)) {
  engine.ensureSpace(demo, { chatId: "oc_demo" });
  engine.registry.updateMeta(demo, { name: "演示群" });
  await engine.remember({ space: demo, source: "message", content: "这是一条示例消息，用于演示后台。" });
}
if (engine.agents.list().length === 0) {
  // One agent per local CLI actually detected on this machine (like mew's
  // device-bound agents). Providers are CLIs only — no gateway.
  const detected = await detectProviders();
  for (const p of detected) {
    if (!p.available) continue;
    engine.agents.create({ name: `${p.name} Agent`, instruction: "", model: "", provider: p.id, visibility: "Team" });
  }
  const usable = detected.filter((p) => p.available).map((p) => `${p.name}(${p.id})`);
  // eslint-disable-next-line no-console
  console.log(`检测到本地可用 provider: ${usable.length ? usable.join(", ") : "无（未装 CLI）"}`);
}

const app = createWebApp({
  engine,
  adminToken: cfg.webAdminToken,
  brandAvatarPath: resolve(
    import.meta.dir,
    "../../../assets/brand/homeagent-feishu-avatar-512.png",
  ),
});
// Real local CLI calls may take well over Bun's 10-second default timeout.
const server = Bun.serve({ hostname: cfg.webHost, port: cfg.webPort, fetch: app.fetch, idleTimeout: 120 });
// eslint-disable-next-line no-console
console.log(
  `homeagent 管理后台（dev，LLM=${realCli ? "真实本机 CLI" : "离线假回答"}）: http://${cfg.webHost}:${server.port}`,
);

const shutdown = () => {
  server.stop(true);
  engine.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
