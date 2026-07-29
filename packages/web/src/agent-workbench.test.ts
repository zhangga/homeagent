import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, SpaceMeta, TaskRun } from "@homeagent/core";
import type { DetectedProvider } from "@homeagent/llm";
import {
  buildAgentWorkbench,
  generatedAgentName,
  validateAgentEditor,
  type AgentEditorValues,
} from "./agent-workbench.ts";

const agent: Agent = {
  id: "agent_research",
  name: "研究助手",
  instruction: "先核对事实，再给出结论。",
  provider: "codex",
  model: "",
  reasoningEffort: "high",
  visibility: "Team",
  permission: "read-only",
  skills: ["web-search"],
  createdAt: 100,
  updatedAt: 200,
};

const providers: DetectedProvider[] = [
  {
    id: "codex",
    name: "Codex",
    bin: "codex",
    available: true,
    detail: "0.42.0",
  },
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    available: false,
    detail: "未找到命令",
  },
];

const bindings: SpaceMeta[] = [
  {
    id: "team/oc_product",
    name: "产品讨论群",
    chatId: "oc_product",
    agentId: agent.id,
    createdAt: 10,
  },
];

const runs: TaskRun[] = [
  {
    id: "run_latest",
    taskId: "task_weekly",
    taskName: "行业周报",
    space: "team/oc_product",
    topic: "AI 行业动态",
    trigger: "manual",
    agentId: agent.id,
    provider: "codex",
    model: "gpt-5.6-sol",
    distill: true,
    status: "running",
    startedAt: 300,
  },
];

describe("Agent create defaults", () => {
  test("generates a provider-specific Agent name", () => {
    expect(generatedAgentName("codex", [])).toBe("Codex Agent");
  });

  test("uses the lowest available suffix without matching similar names", () => {
    expect(generatedAgentName("codex", [
      { name: "Codex Agent" },
      { name: "Codex Agent (2)" },
      { name: "Codex Agent (4)" },
      { name: "Codex Agent draft" },
    ])).toBe("Codex Agent (3)");
  });

  test("builds a fresh create state with generated candidates", () => {
    const view = buildAgentWorkbench({
      agents: [{ ...agent, name: "Codex Agent" }],
      mode: "create",
      selected: null,
      providers,
      models: { codex: ["gpt-5.6-sol"] },
      defaults: { provider: "codex", model: "gpt-5.6-sol" },
      bindings: [],
      runs: [],
    });

    expect(view.editor.name).toBe("Codex Agent (2)");
    expect(view.generatedNames).toEqual({
      claude: "Claude Code Agent",
      codex: "Codex Agent (2)",
      "trae-cli": "Trae CLI Agent",
    });
    expect(view.automaticName).toBe(true);
  });

  test("preserves a submitted create name as manual", () => {
    const submitted: AgentEditorValues = {
      name: "我的研究助手",
      instruction: "",
      provider: "codex",
      model: "",
      reasoningEffort: "",
      visibility: "Team",
      permission: "read-only",
      workdir: "",
      skills: "",
    };
    const view = buildAgentWorkbench({
      agents: [],
      mode: "create",
      selected: null,
      providers,
      models: {},
      defaults: { provider: "codex", model: "" },
      bindings: [],
      runs: [],
      values: submitted,
    });

    expect(view.editor.name).toBe("我的研究助手");
    expect(view.automaticName).toBe(false);
  });
});

describe("Agent workbench presenter", () => {
  test("derives honest readiness, effective model, bindings, and run snapshots", () => {
    const view = buildAgentWorkbench({
      agents: [agent],
      mode: "edit",
      selected: agent,
      providers,
      models: { codex: ["gpt-5.6-sol"] },
      defaults: { provider: "codex", model: "gpt-5.6-sol" },
      bindings,
      runs,
    });

    expect(view.list).toEqual([
      expect.objectContaining({
        id: agent.id,
        selected: true,
        providerName: "Codex",
        modelLabel: "gpt-5.6-sol",
        readiness: "ready",
        running: true,
      }),
    ]);
    expect(view.inspector?.provider).toEqual(
      expect.objectContaining({
        available: true,
        detail: "0.42.0",
      }),
    );
    expect(view.inspector?.bindings).toEqual([
      expect.objectContaining({
        label: "产品讨论群",
        detail: "team/oc_product",
      }),
    ]);
    expect(view.inspector?.runs).toEqual([
      expect.objectContaining({
        id: "run_latest",
        provider: "codex",
        model: "gpt-5.6-sol",
        status: "running",
      }),
    ]);
  });

  test("marks a stored provider unavailable without inventing device state", () => {
    const unavailableAgent = { ...agent, provider: "claude" as const, model: "opus" };
    const view = buildAgentWorkbench({
      agents: [unavailableAgent],
      mode: "edit",
      selected: unavailableAgent,
      providers,
      models: {},
      defaults: { provider: "codex", model: "gpt-5.6-sol" },
      bindings: [],
      runs: [],
    });

    expect(view.list[0]).toEqual(
      expect.objectContaining({
        readiness: "unavailable",
        readinessLabel: "CLI 不可用",
        running: false,
      }),
    );
    expect(view.inspector?.provider.detail).toBe("未找到命令");
  });
});

describe("Agent editor validation", () => {
  test("returns field-level errors for unsafe or incompatible values", () => {
    const values: AgentEditorValues = {
      name: "",
      instruction: "x".repeat(20_001),
      provider: "codex",
      model: "gpt-5.5",
      reasoningEffort: "max",
      visibility: "Elsewhere",
      permission: "write",
      workdir: "",
      skills: "",
    };

    const result = validateAgentEditor(values, {
      providers,
      models: { codex: ["gpt-5.5", "gpt-5.6-sol"] },
      defaults: { provider: "codex", model: "gpt-5.6-sol" },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        instruction: expect.any(String),
        reasoningEffort: expect.any(String),
        visibility: expect.any(String),
        workdir: expect.any(String),
      }),
    );
  });

  test("allows an existing custom model unchanged but rejects carrying it to another provider", () => {
    const current = { ...agent, model: "codex-custom" };
    const values: AgentEditorValues = {
      name: current.name,
      instruction: current.instruction,
      provider: "codex",
      model: "codex-custom",
      reasoningEffort: "",
      visibility: "Team",
      permission: "read-only",
      workdir: "",
      skills: "web-search",
    };
    const context = {
      providers,
      models: { codex: ["gpt-5.6-sol"], claude: ["opus"] },
      defaults: { provider: "codex", model: "gpt-5.6-sol" },
      current,
    };

    expect(validateAgentEditor(values, context)).toEqual({ ok: true, errors: {} });
    const changed = validateAgentEditor(
      { ...values, provider: "claude", model: "codex-custom" },
      context,
    );
    expect(changed.ok).toBe(false);
    expect(changed.errors.model).toContain("不属于");
  });

  test("validates Workdir existence and bounded skill identifiers", () => {
    const realDir = mkdtempSync(join(tmpdir(), "ha-agent-workdir-"));
    try {
      const base: AgentEditorValues = {
        name: "执行助手",
        instruction: "",
        provider: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "",
        visibility: "Team",
        permission: "write",
        workdir: realDir,
        skills: "code-review, bad skill",
      };
      const context = {
        providers,
        models: { codex: ["gpt-5.6-sol"] },
        defaults: { provider: "codex", model: "gpt-5.6-sol" },
      };

      const invalidSkill = validateAgentEditor(base, context);
      expect(invalidSkill.errors.workdir).toBeUndefined();
      expect(invalidSkill.errors.skills).toContain("Skill");

      const invalidDir = validateAgentEditor(
        { ...base, workdir: join(realDir, "missing"), skills: "code-review" },
        context,
      );
      expect(invalidDir.errors.workdir).toContain("不存在");
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});
