import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceId } from "@homeagent/shared";
import { SpaceRegistry } from "./registry.ts";

let dir: string;
let registry: SpaceRegistry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ha-registry-"));
  registry = new SpaceRegistry(dir);
});

afterEach(() => {
  registry.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

describe("SpaceRegistry Agent bindings", () => {
  test("lists only spaces bound to the exact Agent", () => {
    const boundTeam: SpaceId = "team/oc_bound";
    const boundPersonal: SpaceId = "personal/ou_bound";
    const other: SpaceId = "team/oc_other";
    registry.ensure(boundTeam);
    registry.ensure(boundPersonal);
    registry.ensure(other);
    registry.updateMeta(boundTeam, { agentId: "agent_target" });
    registry.updateMeta(boundPersonal, { agentId: "agent_target" });
    registry.updateMeta(other, { agentId: "agent_other" });

    expect(registry.listByAgent("agent_target").map((space) => space.id).sort()).toEqual([
      boundPersonal,
      boundTeam,
    ]);
  });

  test("clears every exact Agent binding without changing other bindings", () => {
    const first: SpaceId = "team/oc_first";
    const second: SpaceId = "personal/ou_second";
    const untouched: SpaceId = "team/oc_untouched";
    registry.ensure(first);
    registry.ensure(second);
    registry.ensure(untouched);
    registry.updateMeta(first, { name: "First", agentId: "agent_target" });
    registry.updateMeta(second, { name: "Second", agentId: "agent_target" });
    registry.updateMeta(untouched, { name: "Other", agentId: "agent_other" });

    expect(registry.clearAgentBindings("agent_target").map((space) => space.id).sort()).toEqual([
      second,
      first,
    ]);
    expect(registry.get(first)).toEqual(expect.objectContaining({ name: "First", agentId: undefined }));
    expect(registry.get(second)).toEqual(expect.objectContaining({ name: "Second", agentId: undefined }));
    expect(registry.get(untouched)).toEqual(expect.objectContaining({ agentId: "agent_other" }));
    expect(registry.clearAgentBindings("agent_target")).toEqual([]);
  });

  test("keeps in-memory bindings unchanged when the replacement cannot persist", () => {
    const space: SpaceId = "team/oc_atomic";
    registry.ensure(space);
    registry.updateMeta(space, { agentId: "agent_target" });
    const originalPersist = (registry as unknown as {
      persist: (meta?: unknown) => void;
    }).persist.bind(registry);
    Object.defineProperty(registry, "persist", {
      configurable: true,
      value: () => {
        throw new Error("disk unavailable");
      },
    });

    expect(() => registry.clearAgentBindings("agent_target")).toThrow("disk unavailable");
    expect(registry.get(space)?.agentId).toBe("agent_target");

    Object.defineProperty(registry, "persist", {
      configurable: true,
      value: originalPersist,
    });
  });
});
