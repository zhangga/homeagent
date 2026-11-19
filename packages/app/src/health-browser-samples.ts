import type { SystemHealthSources } from "./health.ts";

/** Controlled local inputs for the real system health reporter. No OS service is queried or restarted. */
export function healthBrowserSamples() {
  let scenario: "healthy" | "degraded" | "unready" = "healthy";
  let restarts = 0;
  const startedAt = Date.now() - 3_600_000;
  const sources = {
    requiredProviderIds: () => ["claude"], ordinaryProviderIds: () => ["claude"],
    providerProbeTtlMs: 0,
    detectProviders: async () => [{ id: "claude", name: "Claude", bin: "offline-claude", available: scenario !== "unready", detail: "离线测试替身" }],
    connectorHealth: () => ({ name: "offline-feishu", ready: scenario !== "unready", consumers: [
      { key: "im.message.receive_v1", state: scenario === "unready" ? "failed" : "ready", attempts: scenario === "unready" ? 3 : 1 },
      { key: "im.chat.member.bot.added_v1", state: "ready", attempts: 1 },
      { key: "card.action.trigger", state: "ready", attempts: 1 },
    ] }),
    dreamSchedulerHealth: () => ({ started: true, running: false, lastStatus: "ok",
      lastSuccessAt: startedAt, lastProcessedRaw: 20, lastBatchesRun: 2,
      lastPendingRaw: scenario === "degraded" ? 8 : 0, lastBacklogLimited: scenario === "degraded" }),
    serviceHealth: () => ({ managed: scenario !== "unready", pid: 4208, startedAt }),
  } satisfies Partial<SystemHealthSources>;
  return {
    sources, onServiceRestart: () => { restarts++; },
    audit: () => ({ scenario, restarts }),
    select(value: string) {
      if (value !== "healthy" && value !== "degraded" && value !== "unready") return false;
      scenario = value;
      return true;
    },
  };
}
