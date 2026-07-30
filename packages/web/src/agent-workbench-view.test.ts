import { describe, expect, test } from "bun:test";
import type { Agent } from "@homeagent/core";
import { buildAgentWorkbench } from "./agent-workbench.ts";
import { agentWorkbenchView } from "./agent-workbench-view.ts";

const selected: Agent = {
  id: "agent_ops",
  name: "运营研究员",
  instruction: "只报告经过核验的事实。",
  provider: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  visibility: "Team",
  permission: "read-only",
  skills: [],
  createdAt: 100,
  updatedAt: 200,
};

describe("Agent workbench view", () => {
  test("renders a focused create workbench without an empty inspector", async () => {
    const view = buildAgentWorkbench({
      agents: [{ ...selected, name: "Codex Agent" }],
      mode: "create",
      selected: null,
      providers: [{
        id: "codex",
        name: "Codex",
        bin: "codex",
        available: true,
        detail: "0.42.0",
      }],
      models: { codex: ["gpt-5.6-sol"] },
      defaults: { provider: "codex", model: "gpt-5.6-sol" },
      bindings: [],
      runs: [],
    });

    const body = String(await agentWorkbenchView(view));
    expect(body).toContain('class="agent-workbench has-editor is-create"');
    expect(body).toContain('id="agent-name"');
    expect(body).toContain('form="agent-editor-form"');
    expect(body).toContain('value="Codex Agent (2)"');
    expect(body).toContain('data-name-mode="automatic"');
    expect(body).toContain('class="agent-create-core-grid"');
    expect(body).toContain('<details class="agent-task-execution"');
    expect(body).toContain("Codex · CLI 就绪");
    expect(body).not.toContain('data-pane="agent-inspector"');
    expect(body).not.toContain('<button class="agent-inspector-overlay"');
    expect(body).not.toContain("Device");
    expect(body).not.toContain("Repositories");
    expect(body).not.toContain("Environment");
  });

  test("renders the approved three-pane workbench without Mew device fields", async () => {
    const view = buildAgentWorkbench({
      agents: [selected],
      mode: "edit",
      selected,
      providers: [{
        id: "codex",
        name: "Codex",
        bin: "codex",
        available: true,
        detail: "0.42.0",
      }],
      models: { codex: ["gpt-5.6-sol"] },
      defaults: { provider: "codex", model: "gpt-5.6-sol" },
      bindings: [{
        id: "team/oc_ops",
        name: "运营群",
        agentId: selected.id,
        createdAt: 10,
      }],
      runs: [{
        id: "run_1",
        taskId: "task_1",
        taskName: "竞品周报",
        space: "team/oc_ops",
        topic: "竞品动态",
        trigger: "manual",
        agentId: selected.id,
        provider: "codex",
        model: "gpt-5.6-sol",
        distill: true,
        status: "failed",
        error: "Provider process exited before producing a result",
        startedAt: 1_785_283_200_000,
        finishedAt: 1_785_283_260_000,
      }],
      runTotal: 25,
      runLimit: 20,
    });

    const body = String(await agentWorkbenchView(view));
    expect(body).toContain('class="agent-workbench has-editor"');
    expect(body).toContain('data-pane="agent-list"');
    expect(body).toContain('data-pane="agent-editor"');
    expect(body).toContain('data-pane="agent-inspector"');
    expect(body).toContain('class="agent-edit-name"');
    const editorBody = body.slice(
      body.indexOf('data-pane="agent-editor"'),
      body.indexOf('data-pane="agent-inspector"'),
    );
    expect(editorBody).toContain("Recent runs");
    expect(editorBody).toContain("Provider process exited before producing a result");
    expect(body).toContain("运营研究员");
    expect(body).toContain("CLI 就绪");
    expect(body).toContain("运营群");
    expect(body).toContain("/tasks/runs/run_1");
    expect(body).toContain("/tasks/runs/run_1/retry");
    expect(body).toContain("runs=40");
    expect(body).toContain('role="separator"');
    expect(body).toContain('data-agent-name="运营研究员"');
    expect(body).toContain('data-binding-count="1"');
    expect(body).toContain("保存更改");
    const inspectorBody = body.slice(body.indexOf('data-pane="agent-inspector"'));
    expect(inspectorBody).toContain(">Agent 设置<");
    expect(inspectorBody).not.toContain("Recent task runs");
    for (const id of [
      "agent-provider",
      "agent-model",
      "agent-reasoning-effort",
      "agent-permission",
      "agent-visibility",
      "agent-workdir",
      "agent-skills",
    ]) {
      const control = inspectorBody.slice(inspectorBody.indexOf(`id="${id}"`));
      expect(control.slice(0, control.indexOf(">"))).toContain('form="agent-editor-form"');
    }
    expect(body).not.toContain("Device");
    expect(body).not.toContain("Repositories");
  });

  test("renders field errors beside preserved create values", async () => {
    const view = buildAgentWorkbench({
      agents: [],
      mode: "create",
      selected: null,
      providers: [{
        id: "claude",
        name: "Claude Code",
        bin: "claude",
        available: true,
        detail: "2.1",
      }],
      models: { claude: ["sonnet"] },
      defaults: { provider: "claude", model: "sonnet" },
      bindings: [],
      runs: [],
      values: {
        name: "",
        instruction: "保留这段内容",
        provider: "claude",
        model: "",
        reasoningEffort: "",
        visibility: "Team",
        permission: "write",
        workdir: "C:\\missing\\project",
        skills: "",
      },
      errors: {
        name: "请输入 Agent 名称",
        workdir: "Workdir 不存在",
      },
    });

    const body = String(await agentWorkbenchView(view));
    expect(body).toContain("创建 Agent");
    expect(body).toContain("保留这段内容");
    expect(body).toContain("请输入 Agent 名称");
    expect(body).toContain('value="C:\\missing\\project"');
    expect(body).toContain("Workdir 不存在");
    expect(body).toContain('<details class="agent-task-execution" open>');
    expect(body).toContain('aria-invalid="true"');
  });
});
