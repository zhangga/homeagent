import type { KnowledgeEngine } from "@homeagent/core";
import { isCliProvider } from "@homeagent/llm";
import { logger } from "@homeagent/shared";

const log = logger.child("skill-warmup");

/** Start disk-only preparation before transport setup; never launch a Provider. */
export async function prepareStartupSkills(engine: KnowledgeEngine, defaultProvider: string): Promise<void> {
  const providers = new Set([defaultProvider]);
  for (const space of engine.registry.list()) providers.add(engine.agentForSpace(space.id)?.provider || defaultProvider);
  await Promise.all([...providers].filter(isCliProvider).map(async provider => {
    const started = performance.now();
    try {
      await engine.skillCatalog.withResolution({ provider }, () => {});
      log.info("startup Skill preparation completed", { provider, durationMs: Math.round(performance.now() - started) });
    } catch {
      // A warmup is not admission. Each real Run still resolves and verifies its
      // own frozen catalog, and can retry a preparation changed during startup.
      log.warn("startup Skill preparation failed; Run preparation will verify again", { provider });
    }
  }));
}
